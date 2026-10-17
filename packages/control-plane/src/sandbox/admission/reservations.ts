import type { SqlDatabase } from "../../db/sql-database";

/**
 * Durable global admission gate for sandbox allocation (migration 0089).
 *
 * Before any provider call a session claims a slot, moves its lease
 * reserved → allocating, and only then calls the provider. It records the
 * provider object once allocated and releases the slot after shutdown is
 * confirmed. Every write is a compare-and-swap on the claiming identity
 * (session, generation, lease token) and the state it expects, so a stale
 * caller cannot move another lease.
 *
 * Exact semantics:
 * - Scope is global. Slots are SANDBOX_ADMISSION_SLOTS, and their count is the
 *   deployment limit. A slot holds at most one lease; a lease holds at most one slot.
 * - claim is idempotent for the same identity: it returns the slot already held
 *   and does not extend the lease. The same lease token under another identity is a conflict.
 * - beginAllocation is the only authority to call the provider, and only from
 *   reserved. A retry, or a lease that has lapsed to unknown, is refused.
 * - A lapsed reserved lease is released: no provider call was ever authorized under it.
 *   A lapsed allocating lease becomes unknown (expireLeases). Unknown keeps its slot;
 *   time alone never frees one.
 * - begin refuses a reserved lease that has lapsed, so an expired lease authorizes nothing.
 * - release frees the slot only for the identity that claimed it, and only with the proof
 *   its state needs (SandboxAdmissionReleaseProof). A retried release reports absent. The
 *   caller asserts the proof; this store checks identity, state and proof kind.
 * - On an ambiguous error the caller does nothing. The row keeps its slot until
 *   its lease lapses and provider lookup settles it.
 *
 * Unknown rows are settled by the VPS reconcile hook (vps-reconcile.ts), which frees one only
 *   on executor proof of absence. A 404 alone never frees a slot. Allocated rows a newer generation
 *   of their session superseded, or relinquished by its owner, are stopped by the same hook, and freed only on a
 *   confirmed stop.
 * ponytail: fixed slots and a single global scope. Widen the migration's slot CHECK
 *   and SANDBOX_ADMISSION_SLOTS together, in a new migration.
 * ponytail: no proof is stored in the row, so release trusts the caller's asserted proof.
 *   Add a column when Phase B needs that proof stored with the row.
 */

/** The only scope in use. Slot occupancy is counted within it. */
export const SANDBOX_ADMISSION_SCOPE = "global";

/** Slot numbers the migration admits. Their count is the deployment limit. */
export const SANDBOX_ADMISSION_SLOTS = [0, 1] as const;

export type SandboxAdmissionState = "reserved" | "allocating" | "allocated" | "unknown";

/** Who holds a slot. Every transition and release presents all three. */
export interface SandboxAdmissionIdentity {
  sessionId: string;
  generation: number;
  leaseToken: string;
}

export interface SandboxAdmissionRecord extends SandboxAdmissionIdentity {
  slot: number;
  operationRef: string;
  state: SandboxAdmissionState;
  modalObjectId: string | null;
  leaseExpiresAt: number | null;
  /** When the claim was taken. A launch's own lookups end a fixed bound after it. */
  createdAt: number;
  /** When the owner marked the allocated object as no longer its own, ahead of its generation moving on. Null until it does. */
  relinquishedAt: number | null;
}

export type SandboxAdmissionClaim =
  { kind: "claimed"; slot: number } | { kind: "full" } | { kind: "conflict" };

/** "refused": the identity or the expected state did not match, so nothing changed. */
export type SandboxAdmissionUpdate = "applied" | "refused";

/** "absent": no row holds the lease token, so an earlier release already freed it. */
export type SandboxAdmissionRelease = "released" | "absent" | "refused";

/**
 * What proves a slot may be freed. "unauthorized": no provider call was authorized under the lease.
 * "refused": the provider refused the call before any object existed. "gone": no provider object is, or
 * can become, live under the lease (a confirmed stop, or an executor close that found none).
 */
export type SandboxAdmissionReleaseProof = "unauthorized" | "refused" | "gone";

/** The lease states each proof may free. A lease that has moved on is never freed by a stale proof. */
const RELEASABLE_STATES: Record<SandboxAdmissionReleaseProof, readonly SandboxAdmissionState[]> = {
  unauthorized: ["reserved"],
  refused: ["allocating", "unknown"],
  gone: ["reserved", "allocating", "allocated", "unknown"],
};

interface ReservationRow {
  slot: number;
  session_id: string;
  generation: number;
  lease_token: string;
  operation_ref: string;
  state: SandboxAdmissionState;
  modal_object_id: string | null;
  lease_expires_at: number | null;
  created_at: number;
  relinquished_at: number | null;
}

const COLUMNS =
  "slot, session_id, generation, lease_token, operation_ref, state, modal_object_id, lease_expires_at, created_at, relinquished_at";
const WHERE_IDENTITY = "lease_token = ? AND session_id = ? AND generation = ?";

export class SandboxAdmissionStore {
  constructor(private readonly db: SqlDatabase) {}

  /** Take the first free slot for `identity`. Retries are idempotent; see the class comment. */
  async claim(
    identity: SandboxAdmissionIdentity,
    input: { operationRef: string; nowMs: number; leaseTtlMs: number }
  ): Promise<SandboxAdmissionClaim> {
    const held = await this.find(identity.leaseToken);
    if (held) {
      return held.sessionId === identity.sessionId && held.generation === identity.generation
        ? { kind: "claimed", slot: held.slot }
        : { kind: "conflict" };
    }
    for (const slot of SANDBOX_ADMISSION_SLOTS) {
      // The conflict target is named so a duplicate lease token (a UNIQUE
      // violation) throws instead of reading as a full pool.
      const result = await this.db
        .prepare(
          `INSERT INTO sandbox_admission_reservations
             (scope, slot, lease_token, session_id, generation, operation_ref, state,
              lease_expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?)
           ON CONFLICT (scope, slot) DO NOTHING`
        )
        .bind(
          SANDBOX_ADMISSION_SCOPE,
          slot,
          identity.leaseToken,
          identity.sessionId,
          identity.generation,
          input.operationRef,
          input.nowMs + input.leaseTtlMs,
          input.nowMs,
          input.nowMs
        )
        .run();
      if (result.meta.changes === 1) return { kind: "claimed", slot };
    }
    return { kind: "full" };
  }

  /** Record a provider call about to be made. Only a reserved lease that has not lapsed may begin one. */
  async beginAllocation(
    identity: SandboxAdmissionIdentity,
    input: { nowMs: number; leaseTtlMs: number }
  ): Promise<SandboxAdmissionUpdate> {
    const result = await this.db
      .prepare(
        `UPDATE sandbox_admission_reservations
         SET state = 'allocating', lease_expires_at = ?, updated_at = ?
         WHERE ${WHERE_IDENTITY} AND state = 'reserved' AND lease_expires_at > ?`
      )
      .bind(input.nowMs + input.leaseTtlMs, input.nowMs, ...identityParams(identity), input.nowMs)
      .run();
    return result.meta.changes === 1 ? "applied" : "refused";
  }

  /**
   * Record the provider object for an allocating lease, or an unknown one a lookup found. Re-recording
   * the object an allocated lease already holds applies again, so a bridge and a sweep can both settle it.
   */
  async recordAllocated(
    identity: SandboxAdmissionIdentity,
    input: { modalObjectId: string; nowMs: number }
  ): Promise<SandboxAdmissionUpdate> {
    const result = await this.db
      .prepare(
        `UPDATE sandbox_admission_reservations
         SET state = 'allocated', modal_object_id = ?, lease_expires_at = NULL, updated_at = ?
         WHERE ${WHERE_IDENTITY}
           AND (state IN ('allocating', 'unknown') OR (state = 'allocated' AND modal_object_id = ?))`
      )
      .bind(input.modalObjectId, input.nowMs, ...identityParams(identity), input.modalObjectId)
      .run();
    return result.meta.changes === 1 ? "applied" : "refused";
  }

  /**
   * The owner's mark on an allocated lease whose object it no longer uses. Only the allocated row for `sessionId`
   * that holds `handle` takes it, by its object or by the pending reference it was claimed under, since an owner
   * may still hold either. Each names one lease, so no generation is needed. A repeated mark keeps the first time.
   */
  async markRelinquished(
    sessionId: string,
    handle: string,
    nowMs: number
  ): Promise<SandboxAdmissionUpdate> {
    const result = await this.db
      .prepare(
        `UPDATE sandbox_admission_reservations
         SET relinquished_at = COALESCE(relinquished_at, ?), updated_at = ?
         WHERE scope = ? AND session_id = ? AND (modal_object_id = ? OR operation_ref = ?) AND state = 'allocated'`
      )
      .bind(nowMs, nowMs, SANDBOX_ADMISSION_SCOPE, sessionId, handle, handle)
      .run();
    return result.meta.changes === 1 ? "applied" : "refused";
  }

  /**
   * Settle lapsed leases. A reserved lease that lapsed is deleted: no call was ever authorized under it.
   * An allocating lease that lapsed becomes unknown, which keeps its slot until a lookup settles it.
   */
  async expireLeases(nowMs: number): Promise<{ released: number; unknown: number }> {
    const released = await this.db
      .prepare(
        `DELETE FROM sandbox_admission_reservations
         WHERE state = 'reserved' AND lease_expires_at <= ?`
      )
      .bind(nowMs)
      .run();
    const unknown = await this.db
      .prepare(
        `UPDATE sandbox_admission_reservations
         SET state = 'unknown', lease_expires_at = NULL, updated_at = ?
         WHERE state = 'allocating' AND lease_expires_at <= ?`
      )
      .bind(nowMs, nowMs)
      .run();
    return { released: released.meta.changes, unknown: unknown.meta.changes };
  }

  /**
   * Free the slot for the identity that claimed it, when `proof` covers the lease's state (see
   * RELEASABLE_STATES). Any other state, or a proof the caller does not hold, leaves the row in place.
   */
  async release(
    identity: SandboxAdmissionIdentity,
    proof: SandboxAdmissionReleaseProof
  ): Promise<SandboxAdmissionRelease> {
    const states = RELEASABLE_STATES[proof];
    const result = await this.db
      .prepare(
        `DELETE FROM sandbox_admission_reservations
         WHERE ${WHERE_IDENTITY} AND state IN (${states.map(() => "?").join(", ")})`
      )
      .bind(...identityParams(identity), ...states)
      .run();
    if (result.meta.changes === 1) return "released";
    return (await this.find(identity.leaseToken)) ? "refused" : "absent";
  }

  /** Every occupied slot, lowest first. */
  async list(): Promise<SandboxAdmissionRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${COLUMNS} FROM sandbox_admission_reservations WHERE scope = ? ORDER BY slot`
      )
      .bind(SANDBOX_ADMISSION_SCOPE)
      .all<ReservationRow>();
    return results.map(toRecord);
  }

  private async find(leaseToken: string): Promise<SandboxAdmissionRecord | null> {
    const row = await this.db
      .prepare(`SELECT ${COLUMNS} FROM sandbox_admission_reservations WHERE lease_token = ?`)
      .bind(leaseToken)
      .first<ReservationRow>();
    return row ? toRecord(row) : null;
  }
}

function identityParams({
  leaseToken,
  sessionId,
  generation,
}: SandboxAdmissionIdentity): unknown[] {
  return [leaseToken, sessionId, generation];
}

function toRecord(row: ReservationRow): SandboxAdmissionRecord {
  return {
    slot: row.slot,
    sessionId: row.session_id,
    generation: row.generation,
    leaseToken: row.lease_token,
    operationRef: row.operation_ref,
    state: row.state,
    modalObjectId: row.modal_object_id,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    relinquishedAt: row.relinquished_at,
  };
}
