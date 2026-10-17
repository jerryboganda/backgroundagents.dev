import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../../node/migrate";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../../node/sqlite-database";
import { SandboxAdmissionStore, type SandboxAdmissionIdentity } from "./reservations";

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../terraform/d1/migrations"
);
const CLAIMED_AT_MS = 1_000;
const LEASE_TTL_MS = 60_000;

const identity = (n: number, generation = 1): SandboxAdmissionIdentity => ({
  sessionId: `session-${n}`,
  generation,
  leaseToken: `lease-${n}`,
});

describe("sandbox admission store", () => {
  let sqlite: DatabaseSync;
  let db: NodeSqlDatabase;
  let store: SandboxAdmissionStore;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    // Foreign keys are enforced before migrating, as openNodeSqlDatabase does.
    sqlite.exec("PRAGMA foreign_keys = ON");
    applyMigrations(sqlite, MIGRATIONS_DIR);
    sqlite.exec(
      "INSERT INTO sessions (id, created_at, updated_at) VALUES ('session-1', 1, 1), ('session-2', 1, 1), ('session-3', 1, 1)"
    );
    db = createNodeSqlDatabase(sqlite);
    store = new SandboxAdmissionStore(db);
  });
  afterEach(() => db.close());

  const claim = (n: number, nowMs = CLAIMED_AT_MS) =>
    store.claim(identity(n), { operationRef: `op-${n}`, nowMs, leaseTtlMs: LEASE_TTL_MS });
  const begin = (n: number, nowMs = CLAIMED_AT_MS) =>
    store.beginAllocation(identity(n), { nowMs, leaseTtlMs: LEASE_TTL_MS });
  const allocate = (n: number, nowMs = CLAIMED_AT_MS) =>
    store.recordAllocated(identity(n), { modalObjectId: `obj-${n}`, nowMs });

  it("hands out slots in order and reports full once both are held", async () => {
    expect(await claim(1)).toEqual({ kind: "claimed", slot: 0 });
    expect(await claim(2)).toEqual({ kind: "claimed", slot: 1 });
    expect(await claim(3)).toEqual({ kind: "full" });
  });

  it("returns the held slot on a retried claim without taking another or extending the lease", async () => {
    expect(await claim(1)).toEqual({ kind: "claimed", slot: 0 });
    expect(await claim(1, CLAIMED_AT_MS + 10_000)).toEqual({ kind: "claimed", slot: 0 });
    expect(await claim(2)).toEqual({ kind: "claimed", slot: 1 });
    expect(await store.list()).toEqual([
      expect.objectContaining({ slot: 0, leaseExpiresAt: CLAIMED_AT_MS + LEASE_TTL_MS }),
      expect.objectContaining({ slot: 1, leaseExpiresAt: CLAIMED_AT_MS + LEASE_TTL_MS }),
    ]);
  });

  it("treats a lease token presented under another generation as a conflict", async () => {
    await claim(1);
    expect(
      await store.claim(
        { ...identity(1), generation: 2 },
        { operationRef: "op-1", nowMs: CLAIMED_AT_MS, leaseTtlMs: LEASE_TTL_MS }
      )
    ).toEqual({ kind: "conflict" });
    expect(await store.list()).toHaveLength(1);
  });

  it("authorizes a provider call only from reserved, and records the object once allocated", async () => {
    await claim(1);
    expect(await begin(1)).toBe("applied");
    // A retry must not authorize a second provider call.
    expect(await begin(1)).toBe("refused");
    expect(await allocate(1, CLAIMED_AT_MS + 5_000)).toBe("applied");
    expect(await store.list()).toEqual([
      expect.objectContaining({
        slot: 0,
        state: "allocated",
        modalObjectId: "obj-1",
        leaseExpiresAt: null,
      }),
    ]);
  });

  it("re-records the object an allocated lease already holds, and refuses a different object", async () => {
    await claim(1);
    await begin(1);
    expect(await allocate(1)).toBe("applied");
    // A bridge and a sweep may both settle one object; the second write changes nothing.
    expect(await allocate(1, CLAIMED_AT_MS + 5_000)).toBe("applied");
    expect(
      await store.recordAllocated(identity(1), { modalObjectId: "obj-other", nowMs: CLAIMED_AT_MS })
    ).toBe("refused");
    expect(await store.list()).toEqual([
      expect.objectContaining({ state: "allocated", modalObjectId: "obj-1" }),
    ]);
  });

  it("refuses to record an allocation whose call never began", async () => {
    await claim(1);
    expect(await allocate(1)).toBe("refused");
    expect(await store.list()).toEqual([expect.objectContaining({ state: "reserved" })]);
  });

  it("moves a lapsed allocating lease to unknown, which keeps its slot and cannot start a call", async () => {
    await claim(1);
    await begin(1);
    expect(await store.expireLeases(CLAIMED_AT_MS + LEASE_TTL_MS - 1)).toEqual({
      released: 0,
      unknown: 0,
    });
    expect(await store.expireLeases(CLAIMED_AT_MS + LEASE_TTL_MS)).toEqual({
      released: 0,
      unknown: 1,
    });
    expect(await claim(2, CLAIMED_AT_MS + LEASE_TTL_MS)).toEqual({ kind: "claimed", slot: 1 });
    expect(await claim(3, CLAIMED_AT_MS + LEASE_TTL_MS)).toEqual({ kind: "full" });
    expect(await begin(1)).toBe("refused");
    expect((await store.list()).map((row) => row.state)).toEqual(["unknown", "reserved"]);
  });

  it("releases a lapsed reserved lease, since no provider call was ever authorized under it", async () => {
    await claim(1);
    expect(await store.expireLeases(CLAIMED_AT_MS + LEASE_TTL_MS)).toEqual({
      released: 1,
      unknown: 0,
    });
    expect(await store.list()).toEqual([]);
    expect(await claim(2, CLAIMED_AT_MS + LEASE_TTL_MS)).toEqual({ kind: "claimed", slot: 0 });
  });

  it("refuses to begin a reserved lease that has already lapsed, before any sweep runs", async () => {
    await claim(1);
    expect(await begin(1, CLAIMED_AT_MS + LEASE_TTL_MS)).toBe("refused");
    expect(await store.list()).toEqual([expect.objectContaining({ state: "reserved" })]);
  });

  it("settles an unknown lease by provider lookup: record the object, or release the slot", async () => {
    await claim(1);
    await claim(2);
    await begin(1);
    await begin(2);
    await store.expireLeases(CLAIMED_AT_MS + LEASE_TTL_MS);
    // Lookup found slot 0's object, so the lease becomes allocated.
    expect(await allocate(1, CLAIMED_AT_MS + LEASE_TTL_MS)).toBe("applied");
    // Lookup found nothing for slot 1, and that proves it gone, so release frees it.
    expect(await store.release(identity(2), "gone")).toBe("released");
    expect(await claim(3)).toEqual({ kind: "claimed", slot: 1 });
  });

  it("releases only for the claiming identity and only with a proof its state accepts", async () => {
    await claim(1);
    await begin(1);
    // An unauthorized proof covers only a reserved lease; an allocating one may have a call in flight.
    expect(await store.release(identity(1), "unauthorized")).toBe("refused");
    expect(await store.release(identity(1), "refused")).toBe("released");
    expect(await claim(1)).toEqual({ kind: "claimed", slot: 0 });
    await begin(1);
    await allocate(1);
    expect(await store.release(identity(1), "unauthorized")).toBe("refused");
    expect(await store.release(identity(1, 2), "gone")).toBe("refused");
    expect(await store.release(identity(1), "gone")).toBe("released");
    // A retried release is safe: the lease is already gone.
    expect(await store.release(identity(1), "gone")).toBe("absent");
    expect(await claim(2)).toEqual({ kind: "claimed", slot: 0 });
    expect(await store.release(identity(2), "unauthorized")).toBe("released");
  });

  it("frees an allocating lease only with a refusal or a proof of gone, never as unauthorized", async () => {
    await claim(1);
    await begin(1);

    expect(await store.release(identity(1), "unauthorized")).toBe("refused");
    expect(await store.release(identity(1, 2), "refused")).toBe("refused");
    expect(await store.release(identity(1), "refused")).toBe("released");
    expect(await store.list()).toEqual([]);
  });

  it("frees an unknown lease only on proof, so a lapse alone never releases it", async () => {
    await claim(1);
    await begin(1);
    await store.expireLeases(CLAIMED_AT_MS + LEASE_TTL_MS);

    expect(await store.release(identity(1), "unauthorized")).toBe("refused");
    expect(await store.release(identity(1), "refused")).toBe("released");
  });

  it("marks only the allocated lease holding the handle for its session, by object or pending reference, and keeps the first mark's time", async () => {
    await claim(1);
    await begin(1);
    await allocate(1);
    await claim(2);
    await begin(2);

    expect(await store.markRelinquished("session-2", "obj-1", 5_000)).toBe("refused");
    expect(await store.markRelinquished("session-1", "obj-2", 5_000)).toBe("refused");
    expect(await store.markRelinquished("session-1", "op-1", 5_000)).toBe("applied");
    expect(await store.markRelinquished("session-1", "obj-1", 6_000)).toBe("applied");
    expect(await store.list()).toEqual([
      expect.objectContaining({ slot: 0, state: "allocated", relinquishedAt: 5_000 }),
      expect.objectContaining({ slot: 1, state: "allocating", relinquishedAt: null }),
    ]);
  });

  it("refuses to delete a session that holds a slot rather than cascading the slot away", async () => {
    await claim(1);
    expect(() => sqlite.exec("DELETE FROM sessions WHERE id = 'session-1'")).toThrow(/FOREIGN KEY/);
    expect(await store.list()).toHaveLength(1);
    await store.release(identity(1), "unauthorized");
    expect(() => sqlite.exec("DELETE FROM sessions WHERE id = 'session-1'")).not.toThrow();
  });

  it("rejects rows the schema does not allow: a slot beyond the limit, or an impossible lifecycle", () => {
    const insert = (values: string) =>
      sqlite.exec(
        `INSERT INTO sandbox_admission_reservations
           (scope, slot, lease_token, session_id, generation, operation_ref, state,
            modal_object_id, lease_expires_at, created_at, updated_at)
         VALUES ${values}`
      );
    const rejected = [
      "('global', 2, 'l', 'session-1', 1, 'op', 'reserved', NULL, 5, 1, 1)",
      "('global', 0, 'l', 'session-1', 1, 'op', 'allocated', NULL, NULL, 1, 1)",
      "('global', 0, 'l', 'session-1', 1, 'op', 'reserved', NULL, NULL, 1, 1)",
    ];
    for (const values of rejected) {
      expect(() => insert(values)).toThrow(/CHECK/);
    }
  });
});
