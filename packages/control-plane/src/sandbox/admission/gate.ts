import { SandboxProviderError, type SandboxAdmissionProof } from "../provider";
import { PENDING_VM_REFERENCE_LAUNCH_WINDOW_MS } from "../lifecycle/decisions";
import type {
  SandboxAdmissionStore,
  SandboxAdmissionIdentity,
  SandboxAdmissionRecord,
  SandboxAdmissionRelease,
  SandboxAdmissionUpdate,
} from "./reservations";

/**
 * A lease outlives the launch window. A lapse only moves it to unknown, which still
 * holds its slot, so this value bounds how long a live call stays "allocating", not safety.
 */
export const SANDBOX_ADMISSION_LEASE_TTL_MS = PENDING_VM_REFERENCE_LAUNCH_WINDOW_MS;

/** Refused before any provider call: every admission slot is held. Transient, so the breaker does not count it. */
export class SandboxCapacityExhaustedError extends SandboxProviderError {
  readonly code = "provider_capacity_exhausted";

  constructor() {
    super("Sandbox capacity is full; retry after a running sandbox stops", "transient");
  }
}

/**
 * A lookup's answer for one unknown lease. "found" records the object it names. "gone" frees the
 * slot, and only a proof that no provider object is or can become live under the lease may give it.
 * "undecided" keeps the slot occupied.
 */
export type AdmissionLookup =
  { kind: "found"; modalObjectId: string } | { kind: "gone" } | { kind: "undecided" };

/** The lease identity of one attempt: its session row and its sandbox generation. */
export function admissionIdentity(
  session: { id: string },
  generation: { sandboxId: string; createdAt: number }
): SandboxAdmissionIdentity {
  // Sandbox ids can repeat across sessions on one repo, so the token is scoped to the session.
  return {
    sessionId: session.id,
    generation: generation.createdAt,
    leaseToken: `${session.id}:${generation.sandboxId}`,
  };
}

/**
 * The proof a claimed lease gives its provider: its token, and the expiry its create was signed with. The expiry
 * derives from created_at, which only the first claim writes, so every retried claim and every close reproduces it.
 */
export function admissionProofOf(
  record: Pick<SandboxAdmissionRecord, "leaseToken" | "createdAt">
): SandboxAdmissionProof {
  return {
    leaseToken: record.leaseToken,
    expiresAtMs: record.createdAt + SANDBOX_ADMISSION_LEASE_TTL_MS,
  };
}

/**
 * The admission protocol around every provider allocation: claim a slot before any
 * call, authorize the call, record the object once it is known, and release the slot
 * only on proof: a refused create, a confirmed stop, or a lookup that proves the object
 * gone. The store checks the identity and state of each write; this class sequences them
 * and maps the outcomes.
 */
export class SandboxAdmissionGate {
  constructor(private readonly store: SandboxAdmissionStore) {}

  /**
   * Claims a slot before any provider call, and returns the proof its create must carry. Throws
   * SandboxCapacityExhaustedError when none is free.
   */
  async claim(
    identity: SandboxAdmissionIdentity,
    operationRef: string,
    nowMs: number
  ): Promise<SandboxAdmissionProof> {
    // Lapsed leases settle first: a reserved one is released, an allocating one becomes unknown and keeps its slot.
    await this.store.expireLeases(nowMs);
    const claim = await this.store.claim(identity, {
      operationRef,
      nowMs,
      leaseTtlMs: SANDBOX_ADMISSION_LEASE_TTL_MS,
    });
    if (claim.kind === "full") throw new SandboxCapacityExhaustedError();
    if (claim.kind === "conflict")
      throw new Error("Sandbox admission lease belongs to another attempt");
    // A retried claim holds the row its first claim wrote, so the proof carries that expiry, not this call's clock.
    const record = (await this.store.list()).find((row) => row.leaseToken === identity.leaseToken);
    if (!record) throw new Error("Sandbox admission lease was released before its provider call");
    return admissionProofOf(record);
  }

  /** The only authority to call the provider. A refused begin must not call it. */
  async begin(identity: SandboxAdmissionIdentity, nowMs: number): Promise<void> {
    const update = await this.store.beginAllocation(identity, {
      nowMs,
      leaseTtlMs: SANDBOX_ADMISSION_LEASE_TTL_MS,
    });
    if (update !== "applied")
      throw new Error("Sandbox admission lease does not authorize a provider call");
  }

  /** Records the provider object. "refused" means the object is untracked; the caller reports it. */
  settle(
    identity: SandboxAdmissionIdentity,
    modalObjectId: string,
    nowMs: number
  ): Promise<SandboxAdmissionUpdate> {
    return this.store.recordAllocated(identity, { modalObjectId, nowMs });
  }

  /** Frees the slot of a lease whose provider call was never authorized. */
  release(identity: SandboxAdmissionIdentity): Promise<SandboxAdmissionRelease> {
    return this.store.release(identity, "unauthorized");
  }

  /** Frees the slot of a provider call the provider refused before any object existed. */
  releaseRefused(identity: SandboxAdmissionIdentity): Promise<SandboxAdmissionRelease> {
    return this.store.release(identity, "refused");
  }

  /**
   * The proof of the lease a pending reference was claimed under, for a close. A reference names one attempt, so
   * no generation fence is needed here; the fence stays on releaseStopped. Null when no lease holds the reference,
   * which only a proof can cause, so no object can appear under it then.
   */
  async leaseOf(operationRef: string): Promise<SandboxAdmissionProof | null> {
    const record = (await this.store.list()).find((row) => row.operationRef === operationRef);
    return record ? admissionProofOf(record) : null;
  }

  /**
   * The owner's mark that its object is about to stop being its own: its generation moves on next. Call before that
   * generation is written, and abort the move if the mark throws. A mark whose move then fails names an object the move
   * was about to stop anyway, so the reconcile hook may stop it first. `handle` is the object or the pending reference
   * the owner holds. "refused": no allocated lease holds it for this session.
   */
  relinquish(sessionId: string, handle: string, nowMs: number): Promise<SandboxAdmissionUpdate> {
    return this.store.markRelinquished(sessionId, handle, nowMs);
  }

  /**
   * Allocated leases whose object no longer belongs to its owner: a newer generation of the same session holds a
   * lease, or the owner relinquished the object. Both marks are the owner's own durable writes, so neither is an age
   * test. Listing one frees nothing: its slot frees only on a confirmed stop of the object (see releaseStopped).
   */
  async orphanedAllocated(): Promise<SandboxAdmissionRecord[]> {
    const rows = await this.store.list();
    return rows.filter(
      (row) =>
        row.state === "allocated" &&
        (row.relinquishedAt !== null ||
          rows.some(
            (other) => other.sessionId === row.sessionId && other.generation > row.generation
          ))
    );
  }

  /**
   * Frees the slot that holds `objectRef` for `sessionId`: the object it recorded, or the pending
   * reference it was claimed under. Call only once the provider has confirmed that object gone, so the
   * confirmed stop is the proof and the slot frees from any state, allocating included. A recorded object is
   * matched by identity alone: a provider object id names one object, so its confirmed stop proves the lease
   * gone whichever generation issued the stop. A pending reference is fenced to the generation it was claimed
   * under, when one is given. "absent": no lease holds it. "refused": the slot is still held, so the caller
   * must not treat the object as released.
   */
  async releaseStopped(
    sessionId: string,
    objectRef: string,
    generationCreatedAt?: number
  ): Promise<SandboxAdmissionRelease> {
    const record = (await this.store.list()).find(
      (row) =>
        row.sessionId === sessionId &&
        (row.modalObjectId === objectRef ||
          (row.operationRef === objectRef &&
            (generationCreatedAt === undefined || row.generation === generationCreatedAt)))
    );
    return record ? this.store.release(record, "gone") : "absent";
  }

  /**
   * Settles each unknown lease its lookup decides: "found" records the object, and "gone" releases the
   * slot. A lookup that throws or is undecided leaves the row occupied. Lapsed leases become unknown
   * first, so a row a restart left allocating is looked up too. Each write is compare-and-swap on the
   * lease identity, so a repeated run settles a row once and never writes to a row that has moved on.
   */
  async reconcileUnknown(
    lookup: (record: SandboxAdmissionRecord) => Promise<AdmissionLookup>,
    nowMs: number
  ): Promise<{ recorded: number; released: number; undecided: number }> {
    await this.store.expireLeases(nowMs);
    const counts = { recorded: 0, released: 0, undecided: 0 };
    for (const record of await this.store.list()) {
      if (record.state !== "unknown") continue;
      let outcome: AdmissionLookup;
      try {
        outcome = await lookup(record);
      } catch {
        outcome = { kind: "undecided" };
      }
      if (outcome.kind === "found") {
        const update = await this.store.recordAllocated(record, {
          modalObjectId: outcome.modalObjectId,
          nowMs,
        });
        if (update === "applied") counts.recorded++;
        else counts.undecided++;
      } else if (outcome.kind === "gone") {
        if ((await this.store.release(record, "gone")) === "released") counts.released++;
        else counts.undecided++;
      } else {
        counts.undecided++;
      }
    }
    return counts;
  }
}
