import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WORKSPACE_SLOT_COUNT } from "./workspace.ts";

/** Sandboxes that may hold a container at once. This executor's only admission bound. */
export const MAX_ALLOCATED_SANDBOXES = 2;

const STATE_BUSY_TIMEOUT_MS = 5_000;
// Enough bytes to tell the first build's JSON state file from a SQLite database.
const LEGACY_PROBE_BYTES = 64;

export type SandboxStatus = "creating" | "unresolved" | "running" | "terminated";

/** One sandbox allocation, keyed by the admission lease it spent. */
export interface SandboxRecord {
  leaseToken: string;
  sessionId: string;
  sandboxId: string;
  status: SandboxStatus;
  /** Container id docker reported. Null until a run succeeds. */
  providerObjectId: string | null;
  createdAtMs: number;
}

/**
 * What admit decided. Only "reserved" recorded anything. "settled" and "expired" are judged in the same
 * transaction as the reservation: a closed lease or sandbox id, or a lease past its expiry, admits nothing.
 */
export type Admission =
  | { kind: "reserved"; workspaceSlot: number; reattached: boolean }
  | { kind: "known"; record: SandboxRecord }
  | { kind: "settled" }
  | { kind: "expired" }
  | { kind: "sandbox_held" }
  | { kind: "workspace_busy" }
  | { kind: "full" }
  | { kind: "workspace_full" };

/** The nonce and scope a settlement proof names: the lease token, and the session and sandbox it was signed for. */
export interface SettlementScope {
  leaseToken: string;
  sessionId: string;
  sandboxId: string;
}

/**
 * What a settlement found. "free": no record, tombstone, live holder or unplaced container names the lease or
 * its sandbox id. "settled": a tombstone closed the lease or its sandbox id, so no create admits either. "held":
 * a live record holds the sandbox id under another lease. "unplaced": an unplaced container holds the id.
 */
export type Settlement =
  | { kind: "record"; record: SandboxRecord }
  | { kind: "settled"; tombstone: SettlementScope }
  | { kind: "held"; record: SandboxRecord }
  | { kind: "unplaced" }
  | { kind: "free" };

/** An owned container this executor cannot place in a workspace. It holds a cap slot until docker drops it. */
export interface UnplacedContainer {
  containerId: string;
  sandboxId: string;
}

/** What abandon decided. Only "abandoned" recorded anything. */
export type AbandonResult =
  | { kind: "abandoned" }
  | { kind: "not_found" }
  | { kind: "creating" }
  | { kind: "container_known" };

/** True when a record or tombstone was signed for the same session and sandbox as the scope. */
export function sameScope(
  bound: { sessionId: string; sandboxId: string },
  scope: SettlementScope
): boolean {
  return bound.sessionId === scope.sessionId && bound.sandboxId === scope.sandboxId;
}

/** What beginRelease decided. A started release leaves its slot resetting until finishRelease. */
export type ReleaseStart =
  | { kind: "started"; workspaceSlot: number }
  | { kind: "not_found" }
  | { kind: "refused" }
  | { kind: "active" };

export interface OpenStateOptions {
  /** Slots this process may bind. Defaults to WORKSPACE_SLOT_COUNT. */
  workspaceSlots?: number;
}

export interface StateStore {
  /** The record a lease spent, in any status. */
  byLease(leaseToken: string): SandboxRecord | undefined;
  /** The live record holding a slot for a sandbox id, whichever lease spent it. */
  holding(sandboxId: string): SandboxRecord | undefined;
  /** The record that holds a container id while the container is accounted: running, or unresolved with its container. */
  byContainer(providerObjectId: string): SandboxRecord | undefined;
  /** Every record that holds a slot. */
  slotHolders(): SandboxRecord[];
  /**
   * Reserves a container slot and a workspace slot for a lease in one write transaction. The lease is judged
   * there too: a settled lease or sandbox id is refused, and so is one `isFresh` rejects (its expiry, read inside
   * the transaction). Throws, and records nothing, when the write fails.
   */
  admit(record: SandboxRecord, maxAllocated: number, isFresh?: () => boolean): Admission;
  /** Records the container id docker answered a create with. Throws when the write fails. */
  markRunning(leaseToken: string, providerObjectId: string): void;
  /**
   * Holds the slot of a create without a verified outcome. A container id the executor already holds is kept with it,
   * so the container stays accounted and is stopped by id, never run again.
   */
  markUnresolved(leaseToken: string, providerObjectId?: string): boolean;
  /**
   * Gives an unresolved create the container docker shows under its sandbox id, when the container names its workspace
   * slot. The runtime never acknowledged that container here, so the record stays unresolved: it is not running.
   */
  attach(leaseToken: string, providerObjectId: string, workspaceSlot: number): boolean;
  /**
   * Frees the container slot of a record (running, or unresolved with its container) whose container is verified gone.
   * Its workspace is retained, not freed.
   */
  terminate(leaseToken: string, providerObjectId: string): boolean;
  /**
   * Drops a create that holds no container, and gives its workspace back as it was. With `fencedAtMs`, its lease and
   * sandbox id are tombstoned first, in the same transaction, so no later create can admit either. Use it whenever
   * docker may have been asked to create the container, and only when no container it made may still hold the slot.
   */
  forget(leaseToken: string, fencedAtMs?: number): boolean;
  /**
   * Drops a create whose container docker has removed, and gives its workspace back as it was. The container id is retired
   * in the same transaction, so a listing taken before the removal cannot adopt it. The caller clears a fresh claim before
   * this, so the slot a fresh claim frees is empty. A reattached claim stays retained for its owner. The lease is not
   * tombstoned, and no record of it remains, so the same lease may create again.
   */
  forgetRemoved(leaseToken: string, containerId: string): boolean;
  /** True when a container id is retired, or a record names it. A listing that shows such an id predates its removal. */
  retiredContainer(containerId: string): boolean;
  /** True when docker has removed this container id: it is retired, or a terminated record names it. */
  removedContainer(containerId: string): boolean;
  /**
   * Converts each `creating` record whose lease is not in `inFlight` to `unresolved`. Such a record lost its settle write,
   * and no request of this process runs it. Returns how many changed.
   */
  unresolveOrphans(inFlight: ReadonlySet<string>): number;
  /**
   * Records an owned container that no live record accounts for, in the workspace slot it names. Returns false when the
   * container cannot take that slot (held, owned by a session, or a closed sandbox id), and the caller counts it as unplaced.
   */
  adopt(record: SandboxRecord, workspaceSlot: number): boolean;
  /** Starts a release of a retained workspace, for its owning session and the lease that retained it. */
  beginRelease(sandboxId: string, sessionId: string, leaseToken: string): ReleaseStart;
  /** Starts a release of a retained workspace that no session owns, such as one adopted from a container. */
  beginOperatorRelease(sandboxId: string): ReleaseStart;
  /** Frees a workspace whose reset is complete. */
  finishRelease(workspaceSlot: number): boolean;
  /** True when a settlement closed this lease, or closed its sandbox id. No create admits either. */
  settledFor(leaseToken: string, sandboxId: string): boolean;
  /** What a settlement would find for a scope, read in one transaction. `settle` judges it again before it writes. */
  settlementOf(scope: SettlementScope): Settlement;
  /** Closes a free scope, or a terminated record of the same scope, and returns what the write found. */
  settle(scope: SettlementScope, settledAtMs: number): Settlement;
  /**
   * Closes an unresolved create that has no container: its lease and sandbox id are tombstoned, and its workspace stays
   * retained for its owner under that lease until a release clears it. Judged in one transaction.
   */
  abandon(sandboxId: string, settledAtMs: number): AbandonResult;
  /** The container ids of the unplaced containers. */
  unplacedIds(): string[];
  /** True when an unplaced container holds this container id. */
  isUnplaced(containerId: string): boolean;
  /** True when an unplaced container holds this sandbox id. */
  unplacedHolds(sandboxId: string): boolean;
  /** Drops the unplaced row of a container id. */
  dropUnplaced(containerId: string): boolean;
  /** Drops the unplaced rows of `removed` ids, and records each of `containers`, in one transaction. */
  syncUnplaced(removed: readonly string[], containers: readonly UnplacedContainer[]): void;
  /** Cap slots in use: live records, plus unplaced containers. */
  occupancy(): number;
  close(): void;
}

/*
 * One SQLite database, one row per admission lease. One process owns it: openStateStore takes the owner lock, and a
 * second owner is refused, so no other process can hold a create in flight.
 * Statuses:
 * - creating: reserved before docker runs. Holds a container slot and a workspace slot. A creating record that no request
 *   of this process runs (its settle write failed) becomes unresolved at the next reconciliation or abandon.
 * - unresolved: no verified outcome for the create. It holds both slots until its container is accounted or the
 *   create is abandoned. Without a container id, reconciliation attaches the owned container under its sandbox id,
 *   and an attached container is not running: the runtime never acknowledged it here. With a container id (a launch
 *   that failed, or an attach), the record names its container, and only a stop removes it. Nothing frees it by
 *   name. The one timer that frees it is the stale sweep (reaper.ts), which removes the container first.
 * - running: the runtime accepted the session context, and docker reported the container id. Holds both slots until
 *   the container is verified gone.
 * - terminated: the container is verified gone. Holds no container slot, and stays as a tombstone so the lease stays spent.
 *
 * Workspace slots are one row per slot, with one state:
 * - free: nothing bound, nothing kept.
 * - held: a live record binds it.
 * - retained: its sandbox stopped or was abandoned, and its data is kept for the owning session. Never freed by a
 *   timer or by eviction. Only an authenticated owner release frees it. A retained slot no session owns (session '')
 *   is one adopted from a container: an explicit operator release frees it once no owned container uses it.
 * - resetting: a release started. Nothing binds it until the release finishes.
 *
 * Settlement: a tombstone (settlements) closes a lease that never spent its slot, and its sandbox id with it, so a
 * create that follows is refused. A terminated record is already spent, so settling it closes the id too. An abandon
 * closes its lease and sandbox id the same way, in the same transaction that removes its container slot. So does a
 * create docker refused outright, when its slot is freed (forget with a fence).
 * An unplaced container (unplaced_containers) is owned but cannot be placed: it names no valid workspace slot, its
 * sandbox id is closed, or its slot is held for another owner. It counts toward the cap, and its sandbox id stays closed,
 * until docker no longer shows it or an authorized stop removes it. Tombstones and unplaced rows are durable, so both
 * survive a restart.
 * A container a create removed (forgetRemoved) leaves a retired id (retired_containers), durable for the same reason: a
 * listing taken before the removal must not adopt it. A create's removed container never leaves a free slot that holds
 * its data: the slot is cleared first, or it is retained for its owner.
 * ponytail: tombstones and retired ids are never garbage-collected. Removing one while a late create can still land would
 * let that create run, so the GC needs proof no late create can land. Ceiling: one row per create, forever.
 *
 * Every admission and status change is one write transaction, begun with BEGIN IMMEDIATE, so it is
 * atomic against any other connection to the file. The WAL is synced at each commit (synchronous FULL):
 * a committed change survives a crash, and an uncommitted one leaves nothing behind.
 */
export async function openStateStore(
  path: string,
  options: OpenStateOptions = {}
): Promise<StateStore> {
  const workspaceSlots = options.workspaceSlots ?? WORKSPACE_SLOT_COUNT;
  if (
    !Number.isSafeInteger(workspaceSlots) ||
    workspaceSlots < 1 ||
    workspaceSlots > WORKSPACE_SLOT_COUNT
  )
    throw new Error("invalid workspace slot count");
  await mkdir(dirname(path), { recursive: true });
  await refuseLegacyJson(path);
  // Claimed before the file is touched, so a second owner is refused before it changes any row.
  const owner = claimOwnership(path);
  const db = new DatabaseSync(path, { timeout: STATE_BUSY_TIMEOUT_MS });
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = FULL");
    inWriteTransaction(db, () => {
      db.exec(SCHEMA);
      refuseOlderSchema(db);
      seedWorkspaces(db, workspaceSlots);
      // Only the owner converts. No other process can own the file, so a create marked in flight belongs to a
      // process that stopped. It keeps its slots, and reconciliation treats it as unresolved.
      db.exec("UPDATE sandboxes SET status = 'unresolved' WHERE status = 'creating'");
    });
  } catch (error) {
    db.close();
    owner.close();
    throw error;
  }
  return createStore(db, owner);
}

/** The sibling database whose exclusive lock marks the state file's owner. */
const OWNER_SUFFIX = ".owner";

/**
 * Takes the state file's owner lock: an exclusive lock on a sibling database, held until the store closes or this process
 * exits. The OS drops a lock when its process dies, so a crashed owner never blocks a restart, and a live owner is never
 * taken over. Throws when another live process holds it.
 */
function claimOwnership(path: string): DatabaseSync {
  const owner = new DatabaseSync(`${path}${OWNER_SUFFIX}`, { timeout: STATE_BUSY_TIMEOUT_MS });
  try {
    // An exclusive transaction that is never committed holds the lock until the connection closes. EXCLUSIVE locking
    // mode is not used: there a refused attempt keeps the shared lock it read, so two contenders block each other's
    // upgrade until their timeouts expire, and no process owns the file.
    owner.exec("BEGIN EXCLUSIVE");
    return owner;
  } catch (error) {
    owner.close();
    throw new Error("executor state file is owned by another running process", { cause: error });
  }
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sandboxes (
    lease_token TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    sandbox_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('creating', 'unresolved', 'running', 'terminated')),
    provider_object_id TEXT,
    created_at_ms INTEGER NOT NULL,
    workspace_slot INTEGER
  );
  CREATE INDEX IF NOT EXISTS sandboxes_by_sandbox ON sandboxes (sandbox_id);
  CREATE INDEX IF NOT EXISTS sandboxes_by_container ON sandboxes (provider_object_id);
  CREATE TABLE IF NOT EXISTS workspaces (
    slot INTEGER PRIMARY KEY CHECK (slot >= 0),
    state TEXT NOT NULL CHECK (state IN ('free', 'held', 'retained', 'resetting')),
    session_id TEXT,
    sandbox_id TEXT,
    retained_lease TEXT
  );
  CREATE INDEX IF NOT EXISTS workspaces_by_sandbox ON workspaces (sandbox_id);
  CREATE TABLE IF NOT EXISTS settlements (
    lease_token TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    sandbox_id TEXT NOT NULL,
    settled_at_ms INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS settlements_by_sandbox ON settlements (sandbox_id);
  CREATE TABLE IF NOT EXISTS unplaced_containers (
    container_id TEXT PRIMARY KEY,
    sandbox_id TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS unplaced_by_sandbox ON unplaced_containers (sandbox_id);
  CREATE TABLE IF NOT EXISTS retired_containers (
    container_id TEXT PRIMARY KEY
  );
`;

/** A record that holds no container the executor has been told of, so it can be forgotten once its create is settled. */
const FORGETTABLE =
  "(status = 'creating' OR (status = 'unresolved' AND provider_object_id IS NULL))";

type WorkspaceState = "free" | "held" | "retained" | "resetting";

interface WorkspaceRow {
  slot: number;
  state: WorkspaceState;
  sessionId: string | null;
  sandboxId: string | null;
  /** The lease that retained the workspace: the fence a release must name. Null for a fresh claim. */
  retainedLease: string | null;
}

function createStore(db: DatabaseSync, owner: DatabaseSync): StateStore {
  const columns = "lease_token, session_id, sandbox_id, status, provider_object_id, created_at_ms";
  const workspaceColumns = "slot, state, session_id, sandbox_id, retained_lease";
  const byLeaseStmt = db.prepare(`SELECT ${columns} FROM sandboxes WHERE lease_token = ?`);
  const holdingStmt = db.prepare(
    `SELECT ${columns} FROM sandboxes WHERE sandbox_id = ? AND status != 'terminated' LIMIT 1`
  );
  const byContainerStmt = db.prepare(
    `SELECT ${columns} FROM sandboxes WHERE provider_object_id = ? AND status IN ('running', 'unresolved') LIMIT 1`
  );
  const slotHoldersStmt = db.prepare(
    `SELECT ${columns} FROM sandboxes WHERE status != 'terminated'`
  );
  const occupancyStmt = db.prepare(
    `SELECT (SELECT COUNT(*) FROM sandboxes WHERE status != 'terminated')
          + (SELECT COUNT(*) FROM unplaced_containers) AS count`
  );
  const settledByLeaseStmt = db.prepare(
    "SELECT lease_token, session_id, sandbox_id FROM settlements WHERE lease_token = ?"
  );
  const settledBySandboxStmt = db.prepare(
    "SELECT lease_token, session_id, sandbox_id FROM settlements WHERE sandbox_id = ? LIMIT 1"
  );
  const settleStmt = db.prepare(
    "INSERT OR IGNORE INTO settlements (lease_token, session_id, sandbox_id, settled_at_ms) VALUES (?, ?, ?, ?)"
  );
  const unplacedHoldsStmt = db.prepare(
    "SELECT container_id FROM unplaced_containers WHERE sandbox_id = ? LIMIT 1"
  );
  const unplacedIdStmt = db.prepare("SELECT 1 FROM unplaced_containers WHERE container_id = ?");
  const unplacedIdsStmt = db.prepare("SELECT container_id FROM unplaced_containers");
  const unplacedDropStmt = db.prepare("DELETE FROM unplaced_containers WHERE container_id = ?");
  const unplacedPutStmt = db.prepare(
    "INSERT OR REPLACE INTO unplaced_containers (container_id, sandbox_id) VALUES (?, ?)"
  );
  const insertStmt = db.prepare(
    `INSERT INTO sandboxes (${columns}, workspace_slot) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const setRunningStmt = db.prepare(
    "UPDATE sandboxes SET status = 'running', provider_object_id = ? WHERE lease_token = ?"
  );
  const unresolvedStmt = db.prepare(
    "UPDATE sandboxes SET status = 'unresolved', provider_object_id = COALESCE(?, provider_object_id) WHERE lease_token = ? AND status = 'creating'"
  );
  const attachStmt = db.prepare(
    "UPDATE sandboxes SET provider_object_id = ? WHERE lease_token = ? AND status = 'unresolved' AND workspace_slot = ? AND (provider_object_id IS NULL OR provider_object_id = ?)"
  );
  const terminateStmt = db.prepare(
    "UPDATE sandboxes SET status = 'terminated' WHERE lease_token = ? AND status IN ('running', 'unresolved') AND provider_object_id = ?"
  );
  const deleteAbandonedStmt = db.prepare(
    "DELETE FROM sandboxes WHERE lease_token = ? AND status = 'unresolved' AND provider_object_id IS NULL"
  );
  const pendingStmt = db.prepare(
    `SELECT workspace_slot, session_id, sandbox_id FROM sandboxes WHERE lease_token = ? AND ${FORGETTABLE}`
  );
  const forgetStmt = db.prepare(`DELETE FROM sandboxes WHERE lease_token = ? AND ${FORGETTABLE}`);
  const retireContainerStmt = db.prepare(
    "INSERT OR IGNORE INTO retired_containers (container_id) VALUES (?)"
  );
  const retiredRowStmt = db.prepare("SELECT 1 FROM retired_containers WHERE container_id = ?");
  const namedByRecordStmt = db.prepare(
    "SELECT 1 FROM sandboxes WHERE provider_object_id = ? LIMIT 1"
  );
  const terminatedByContainerStmt = db.prepare(
    "SELECT 1 FROM sandboxes WHERE provider_object_id = ? AND status = 'terminated' LIMIT 1"
  );
  const creatingStmt = db.prepare("SELECT lease_token FROM sandboxes WHERE status = 'creating'");
  const orphanStmt = db.prepare(
    "UPDATE sandboxes SET status = 'unresolved' WHERE lease_token = ? AND status = 'creating'"
  );

  const workspaceStmt = db.prepare(`SELECT ${workspaceColumns} FROM workspaces WHERE slot = ?`);
  const workspaceByNameStmt = db.prepare(
    `SELECT ${workspaceColumns} FROM workspaces WHERE sandbox_id = ?`
  );
  const freeSlotStmt = db.prepare(
    "SELECT slot FROM workspaces WHERE state = 'free' ORDER BY slot LIMIT 1"
  );
  const claimStmt = db.prepare(
    "UPDATE workspaces SET state = 'held', session_id = ?, sandbox_id = ?, retained_lease = NULL WHERE slot = ? AND state = 'free'"
  );
  const reattachStmt = db.prepare(
    "UPDATE workspaces SET state = 'held' WHERE slot = ? AND state = 'retained'"
  );
  const retainStmt = db.prepare(
    "UPDATE workspaces SET state = 'retained', retained_lease = ? WHERE slot = (SELECT workspace_slot FROM sandboxes WHERE lease_token = ?) AND state = 'held'"
  );
  // A slot held for an operator cleanup: no session owns it, and it is never bound again until that cleanup.
  const holdOwnerlessStmt = db.prepare(
    "UPDATE workspaces SET state = 'retained', session_id = '', sandbox_id = ?, retained_lease = ? WHERE slot = ? AND state = 'free'"
  );
  // A fresh claim goes back to free. A reattached one goes back to retained, under the lease that retained it.
  const restoreStmt = db.prepare(`UPDATE workspaces SET
      state = CASE WHEN retained_lease IS NULL THEN 'free' ELSE 'retained' END,
      session_id = CASE WHEN retained_lease IS NULL THEN NULL ELSE session_id END,
      sandbox_id = CASE WHEN retained_lease IS NULL THEN NULL ELSE sandbox_id END
    WHERE slot = ? AND state = 'held'`);
  const beginResetStmt = db.prepare(
    "UPDATE workspaces SET state = 'resetting' WHERE slot = ? AND state = 'retained'"
  );
  const finishResetStmt = db.prepare(
    "UPDATE workspaces SET state = 'free', session_id = NULL, sandbox_id = NULL, retained_lease = NULL WHERE slot = ? AND state = 'resetting'"
  );

  return {
    byLease: (leaseToken) => optionalRecord(byLeaseStmt.get(leaseToken)),
    holding: (sandboxId) => optionalRecord(holdingStmt.get(sandboxId)),
    byContainer: (providerObjectId) => optionalRecord(byContainerStmt.get(providerObjectId)),
    slotHolders: () => slotHoldersStmt.all().map(toRecord),
    admit(record, maxAllocated, isFresh = () => true) {
      return inWriteTransaction(db, (): Admission => {
        const known = byLeaseStmt.get(record.leaseToken);
        if (known) return { kind: "known", record: toRecord(known) };
        // Judged here, in the same transaction as the reservation, so a settlement that lands first wins.
        if (settledBy(record.leaseToken, record.sandboxId)) return { kind: "settled" };
        if (!isFresh()) return { kind: "expired" };
        if (holdingStmt.get(record.sandboxId)) return { kind: "sandbox_held" };
        // An unplaced container holds its sandbox id, since docker names one container per id.
        if (unplacedHoldsStmt.get(record.sandboxId)) return { kind: "sandbox_held" };
        // A stopped sandbox keeps its workspace for its own session. Another session is refused, and a
        // release in progress blocks every create for that sandbox id.
        const named = workspaceByName(record.sandboxId);
        if (named?.state === "held") return { kind: "sandbox_held" };
        if (named?.state === "resetting") return { kind: "workspace_busy" };
        if (named?.state === "retained" && named.sessionId !== record.sessionId)
          return { kind: "sandbox_held" };
        if (Number(occupancyStmt.get()?.count) >= maxAllocated) return { kind: "full" };
        if (named?.state === "retained") {
          reattachStmt.run(named.slot);
          insertStmt.run(...recordValues(record), named.slot);
          return { kind: "reserved", workspaceSlot: named.slot, reattached: true };
        }
        const free = freeSlotStmt.get();
        if (free === undefined) return { kind: "workspace_full" };
        const workspaceSlot = Number(free.slot);
        claimStmt.run(record.sessionId, record.sandboxId, workspaceSlot);
        insertStmt.run(...recordValues(record), workspaceSlot);
        return { kind: "reserved", workspaceSlot, reattached: false };
      });
    },
    markRunning(leaseToken, providerObjectId) {
      if (!changed(setRunningStmt.run(providerObjectId, leaseToken)))
        throw new Error("no state record for lease");
    },
    markUnresolved: (leaseToken, providerObjectId) =>
      changed(unresolvedStmt.run(providerObjectId ?? null, leaseToken)),
    attach: (leaseToken, providerObjectId, workspaceSlot) =>
      changed(attachStmt.run(providerObjectId, leaseToken, workspaceSlot, providerObjectId)),
    terminate: (leaseToken, providerObjectId) =>
      inWriteTransaction(db, () => {
        if (!changed(terminateStmt.run(leaseToken, providerObjectId))) return false;
        // The workspace is retained, not freed. Its fence is this lease, which a release must name.
        if (!changed(retainStmt.run(leaseToken, leaseToken)))
          throw new Error("workspace slot is not held");
        return true;
      }),
    forget(leaseToken, fencedAtMs) {
      return inWriteTransaction(db, () => {
        const pending = pendingStmt.get(leaseToken);
        if (pending === undefined) return false;
        // The fence is written before the record goes, in the same transaction, so no create can admit in between.
        if (fencedAtMs !== undefined)
          settleStmt.run(
            leaseToken,
            String(pending.session_id),
            String(pending.sandbox_id),
            fencedAtMs
          );
        return dropPending(leaseToken, pending);
      });
    },
    forgetRemoved(leaseToken, containerId) {
      return inWriteTransaction(db, () => {
        const pending = pendingStmt.get(leaseToken);
        if (pending === undefined) return false;
        // The id is retired before the record goes, in the same transaction, so no listing can adopt it in between.
        retireContainerStmt.run(containerId);
        return dropPending(leaseToken, pending);
      });
    },
    retiredContainer: (containerId) =>
      retiredRowStmt.get(containerId) !== undefined ||
      namedByRecordStmt.get(containerId) !== undefined,
    removedContainer: (containerId) =>
      retiredRowStmt.get(containerId) !== undefined ||
      terminatedByContainerStmt.get(containerId) !== undefined,
    unresolveOrphans(inFlight) {
      return inWriteTransaction(db, () => {
        let converted = 0;
        for (const row of creatingStmt.all()) {
          const leaseToken = String(row.lease_token);
          if (!inFlight.has(leaseToken) && changed(orphanStmt.run(leaseToken))) converted += 1;
        }
        return converted;
      });
    },
    adopt(record, workspaceSlot) {
      return inWriteTransaction(db, () => {
        if (holdingStmt.get(record.sandboxId)) return false;
        const workspace = workspaceBySlot(workspaceSlot);
        if (workspace === undefined) return false;
        // Adoptable into a free slot, or into one no session owns for this sandbox id. Any other slot has an owner.
        const ownerless =
          workspace.state === "free" ||
          (workspace.state === "retained" &&
            workspace.sessionId === "" &&
            workspace.sandboxId === record.sandboxId);
        if (!ownerless) return false;
        // A closed sandbox id is never adopted as running. Its slot is held for an operator cleanup, so no run reuses it.
        if (settledBy(record.leaseToken, record.sandboxId)) {
          holdOwnerlessStmt.run(record.sandboxId, record.leaseToken, workspaceSlot);
          return false;
        }
        if (workspace.state === "free") claimStmt.run("", record.sandboxId, workspaceSlot);
        else reattachStmt.run(workspaceSlot);
        // A lease that already exists is a bug, so the insert throws and the whole adoption rolls back.
        insertStmt.run(...recordValues(record), workspaceSlot);
        return true;
      });
    },
    beginRelease(sandboxId, sessionId, leaseToken) {
      return inWriteTransaction(db, (): ReleaseStart => {
        const workspace = workspaceByName(sandboxId);
        if (workspace === undefined) return { kind: "not_found" };
        if (workspace.state === "held") return { kind: "active" };
        // A workspace no session owns is released by an operator only, never by a lease.
        if (workspace.sessionId === "" || workspace.sessionId !== sessionId)
          return { kind: "refused" };
        if (workspace.retainedLease !== leaseToken) return { kind: "refused" };
        // A resetting slot is resumed, not restarted: the same owner and lease reach this point again.
        beginResetStmt.run(workspace.slot);
        return { kind: "started", workspaceSlot: workspace.slot };
      });
    },
    beginOperatorRelease(sandboxId) {
      return inWriteTransaction(db, (): ReleaseStart => {
        const workspace = workspaceByName(sandboxId);
        if (workspace === undefined) return { kind: "not_found" };
        if (workspace.state === "held") return { kind: "active" };
        // Only a workspace no session owns can be released by an operator. An owned one needs its owner's release.
        if (workspace.sessionId !== "") return { kind: "refused" };
        beginResetStmt.run(workspace.slot);
        return { kind: "started", workspaceSlot: workspace.slot };
      });
    },
    finishRelease: (workspaceSlot) => changed(finishResetStmt.run(workspaceSlot)),
    settledFor: (leaseToken, sandboxId) => settledBy(leaseToken, sandboxId) !== undefined,
    settlementOf: (scope) => inWriteTransaction(db, (): Settlement => lookup(scope)),
    settle(scope, settledAtMs) {
      return inWriteTransaction(db, (): Settlement => {
        const found = lookup(scope);
        const closable =
          found.kind === "free" ||
          (found.kind === "record" &&
            found.record.status === "terminated" &&
            sameScope(found.record, scope));
        if (!closable) return found;
        settleStmt.run(scope.leaseToken, scope.sessionId, scope.sandboxId, settledAtMs);
        return { kind: "settled", tombstone: { ...scope } };
      });
    },
    abandon(sandboxId, settledAtMs) {
      return inWriteTransaction(db, (): AbandonResult => {
        const holder = optionalRecord(holdingStmt.get(sandboxId));
        if (holder === undefined) return { kind: "not_found" };
        if (holder.status === "creating") return { kind: "creating" };
        if (holder.providerObjectId !== null) return { kind: "container_known" };
        // The fence comes first: the lease and its sandbox id are closed. The slot stays with its owner, under
        // this lease, so nothing reuses it until a release clears it.
        settleStmt.run(holder.leaseToken, holder.sessionId, holder.sandboxId, settledAtMs);
        if (!changed(retainStmt.run(holder.leaseToken, holder.leaseToken)))
          throw new Error("workspace slot is not held");
        if (!changed(deleteAbandonedStmt.run(holder.leaseToken)))
          throw new Error("unresolved create changed during abandon");
        return { kind: "abandoned" };
      });
    },
    unplacedIds: () => unplacedIdsStmt.all().map((row) => String(row.container_id)),
    isUnplaced: (containerId) => unplacedIdStmt.get(containerId) !== undefined,
    unplacedHolds: (sandboxId) => unplacedHoldsStmt.get(sandboxId) !== undefined,
    dropUnplaced: (containerId) => changed(unplacedDropStmt.run(containerId)),
    syncUnplaced(removed, containers) {
      inWriteTransaction(db, () => {
        for (const containerId of removed) unplacedDropStmt.run(containerId);
        for (const { containerId, sandboxId } of containers)
          unplacedPutStmt.run(containerId, sandboxId);
      });
    },
    occupancy: () => Number(occupancyStmt.get()?.count),
    close: () => {
      db.close();
      owner.close();
    },
  };

  function workspaceByName(sandboxId: string): WorkspaceRow | undefined {
    const row = workspaceByNameStmt.get(sandboxId);
    return row === undefined ? undefined : toWorkspace(row);
  }

  function workspaceBySlot(workspaceSlot: number): WorkspaceRow | undefined {
    const row = workspaceStmt.get(workspaceSlot);
    return row === undefined ? undefined : toWorkspace(row);
  }

  /** Gives a pending create's workspace back as it was, then deletes its record. Runs inside the caller's transaction. */
  function dropPending(leaseToken: string, pending: Record<string, unknown>): boolean {
    restoreStmt.run(pending.workspace_slot === null ? null : Number(pending.workspace_slot));
    return changed(forgetStmt.run(leaseToken));
  }

  /** The tombstone that closed this lease, or the one that closed its sandbox id. */
  function settledBy(leaseToken: string, sandboxId: string): SettlementScope | undefined {
    return (
      optionalScope(settledByLeaseStmt.get(leaseToken)) ??
      optionalScope(settledBySandboxStmt.get(sandboxId))
    );
  }

  /** What a scope holds in state, in the order a settlement judges it. */
  function lookup(scope: SettlementScope): Settlement {
    const record = optionalRecord(byLeaseStmt.get(scope.leaseToken));
    if (record) return { kind: "record", record };
    const tombstone = settledBy(scope.leaseToken, scope.sandboxId);
    if (tombstone) return { kind: "settled", tombstone };
    const holder = optionalRecord(holdingStmt.get(scope.sandboxId));
    if (holder) return { kind: "held", record: holder };
    if (unplacedHoldsStmt.get(scope.sandboxId)) return { kind: "unplaced" };
    return { kind: "free" };
  }
}

/** Runs `work` in one write transaction. The write lock is taken first, so no other process can change rows between a check and the write it guards. */
function inWriteTransaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

/** One row per configured slot. A row past the configured count is refused: its workspace may hold data this process must not hand out. */
function seedWorkspaces(db: DatabaseSync, slots: number): void {
  const beyond = Number(
    db.prepare("SELECT COUNT(*) AS count FROM workspaces WHERE slot >= ?").get(slots)?.count
  );
  if (beyond > 0) throw new Error("executor state file holds more workspace slots than configured");
  const seed = db.prepare("INSERT OR IGNORE INTO workspaces (slot, state) VALUES (?, 'free')");
  for (let slot = 0; slot < slots; slot += 1) seed.run(slot);
}

/** A state file from before workspace slots has no slot column. It is refused rather than misread. */
function refuseOlderSchema(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(sandboxes)").all();
  if (!columns.some((column) => column.name === "workspace_slot"))
    throw new Error("executor state file has an unsupported format");
}

/** The JSON state of the first executor build. It is not migrated, so it is refused rather than misread. */
async function refuseLegacyJson(path: string): Promise<void> {
  const head = await readHead(path);
  if (head.trimStart().startsWith("{"))
    throw new Error("executor state file has an unsupported format");
}

async function readHead(path: string): Promise<string> {
  const handle = await open(path, "r").catch((error: unknown) => {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  });
  if (handle === undefined) return "";
  try {
    const buffer = Buffer.alloc(LEGACY_PROBE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, LEGACY_PROBE_BYTES, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}

function recordValues(
  record: SandboxRecord
): [string, string, string, string, string | null, number] {
  return [
    record.leaseToken,
    record.sessionId,
    record.sandboxId,
    record.status,
    record.providerObjectId,
    record.createdAtMs,
  ];
}

function optionalRecord(row: Record<string, unknown> | undefined): SandboxRecord | undefined {
  return row === undefined ? undefined : toRecord(row);
}

function optionalScope(row: Record<string, unknown> | undefined): SettlementScope | undefined {
  if (row === undefined) return undefined;
  return {
    leaseToken: String(row.lease_token),
    sessionId: String(row.session_id),
    sandboxId: String(row.sandbox_id),
  };
}

function toRecord(row: Record<string, unknown>): SandboxRecord {
  return {
    leaseToken: String(row.lease_token),
    sessionId: String(row.session_id),
    sandboxId: String(row.sandbox_id),
    status: String(row.status) as SandboxStatus,
    providerObjectId: row.provider_object_id === null ? null : String(row.provider_object_id),
    createdAtMs: Number(row.created_at_ms),
  };
}

function toWorkspace(row: Record<string, unknown>): WorkspaceRow {
  return {
    slot: Number(row.slot),
    state: String(row.state) as WorkspaceState,
    sessionId: row.session_id === null ? null : String(row.session_id),
    sandboxId: row.sandbox_id === null ? null : String(row.sandbox_id),
    retainedLease: row.retained_lease === null ? null : String(row.retained_lease),
  };
}

function changed(result: { changes: number | bigint }): boolean {
  return Number(result.changes) > 0;
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
