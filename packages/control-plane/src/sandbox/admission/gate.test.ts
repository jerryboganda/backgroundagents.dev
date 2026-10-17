import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../../node/migrate";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../../node/sqlite-database";
import {
  SANDBOX_ADMISSION_LEASE_TTL_MS,
  SandboxAdmissionGate,
  SandboxCapacityExhaustedError,
  admissionIdentity,
} from "./gate";
import { SandboxAdmissionStore } from "./reservations";

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../terraform/d1/migrations"
);
const NOW = 1_000;

const attempt = (n: number) =>
  admissionIdentity({ id: `session-${n}` }, { sandboxId: `sandbox-${n}`, createdAt: NOW });

describe("sandbox admission gate", () => {
  let sqlite: DatabaseSync;
  let db: NodeSqlDatabase;
  let store: SandboxAdmissionStore;
  let gate: SandboxAdmissionGate;

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
    gate = new SandboxAdmissionGate(store);
  });
  afterEach(() => db.close());

  it("refuses a claim when every slot is held, as a transient error the breaker does not count", async () => {
    await gate.claim(attempt(1), "op-1", NOW);
    await gate.claim(attempt(2), "op-2", NOW);
    const refused = gate.claim(attempt(3), "op-3", NOW);
    await expect(refused).rejects.toBeInstanceOf(SandboxCapacityExhaustedError);
    await expect(refused).rejects.toMatchObject({
      code: "provider_capacity_exhausted",
      errorType: "transient",
    });
    expect(await store.list()).toHaveLength(2);
  });

  it("gives a retried claim for the same attempt its held slot, and tokens are scoped per session", async () => {
    await gate.claim(attempt(1), "op-1", NOW);
    await gate.claim(attempt(1), "op-1", NOW + 10_000);
    await gate.claim(attempt(2), "op-2", NOW);
    expect(await store.list()).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        leaseExpiresAt: NOW + SANDBOX_ADMISSION_LEASE_TTL_MS,
      }),
      expect.objectContaining({ sessionId: "session-2" }),
    ]);
    // The same sandbox id under another session is a different lease, not a collision.
    expect(
      admissionIdentity({ id: "session-a" }, { sandboxId: "shared", createdAt: NOW }).leaseToken
    ).not.toBe(
      admissionIdentity({ id: "session-b" }, { sandboxId: "shared", createdAt: NOW }).leaseToken
    );
  });

  it("hands a retried claim the proof its first claim recorded, however late the retry runs", async () => {
    const proof = await gate.claim(attempt(1), "op-1", NOW);
    expect(proof).toEqual({
      leaseToken: attempt(1).leaseToken,
      expiresAtMs: NOW + SANDBOX_ADMISSION_LEASE_TTL_MS,
    });
    expect(await gate.claim(attempt(1), "op-1", NOW + 10_000)).toEqual(proof);
    expect(await gate.leaseOf("op-1")).toEqual(proof);
  });

  it("gives a reference no proof once its lease is freed, so a stop settles without a close", async () => {
    await gate.claim(attempt(1), "op-1", NOW);
    expect(await gate.release(attempt(1))).toBe("released");
    expect(await gate.leaseOf("op-1")).toBeNull();
  });

  it("authorizes one provider call per lease and records an object only after its call began", async () => {
    await gate.claim(attempt(1), "op-1", NOW);
    expect(await gate.settle(attempt(1), "obj-1", NOW)).toBe("refused");
    await gate.begin(attempt(1), NOW);
    await expect(gate.begin(attempt(1), NOW)).rejects.toThrow(/does not authorize/);
    expect(await gate.settle(attempt(1), "obj-1", NOW)).toBe("applied");
  });

  it("moves a lapsed allocating lease to unknown before claiming, and unknown keeps its slot with time alone", async () => {
    await gate.claim(attempt(1), "op-1", NOW);
    await gate.claim(attempt(2), "op-2", NOW);
    await gate.begin(attempt(1), NOW);
    await gate.begin(attempt(2), NOW);
    const later = NOW + SANDBOX_ADMISSION_LEASE_TTL_MS;
    await expect(gate.claim(attempt(3), "op-3", later)).rejects.toBeInstanceOf(
      SandboxCapacityExhaustedError
    );
    expect((await store.list()).map((row) => row.state)).toEqual(["unknown", "unknown"]);
  });

  it("releases a lapsed reserved lease before claiming, since no provider call was authorized under it", async () => {
    await gate.claim(attempt(1), "op-1", NOW);
    await gate.claim(attempt(2), "op-2", NOW);
    const later = NOW + SANDBOX_ADMISSION_LEASE_TTL_MS;
    await gate.claim(attempt(3), "op-3", later);
    expect(await store.list()).toEqual([
      expect.objectContaining({ sessionId: "session-3", state: "reserved" }),
    ]);
  });

  it("settles unknown leases by lookup: a found object is recorded, and a lookup that proves gone releases its slot", async () => {
    await gate.claim(attempt(1), "op-1", NOW);
    await gate.claim(attempt(2), "op-2", NOW);
    await gate.begin(attempt(1), NOW);
    await gate.begin(attempt(2), NOW);
    const later = NOW + SANDBOX_ADMISSION_LEASE_TTL_MS;
    await store.expireLeases(later);

    const counts = await gate.reconcileUnknown(
      async (row) =>
        row.sessionId === "session-1"
          ? { kind: "found", modalObjectId: "obj-1" }
          : { kind: "gone" },
      later
    );

    expect(counts).toEqual({ recorded: 1, released: 1, undecided: 0 });
    expect(await store.list()).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        state: "allocated",
        modalObjectId: "obj-1",
      }),
    ]);
    await gate.claim(attempt(3), "op-3", later);
  });

  it("leaves a row occupied when its lookup is undecided or throws", async () => {
    await gate.claim(attempt(1), "op-1", NOW);
    await gate.claim(attempt(2), "op-2", NOW);
    await gate.begin(attempt(1), NOW);
    await gate.begin(attempt(2), NOW);
    const later = NOW + SANDBOX_ADMISSION_LEASE_TTL_MS;
    await store.expireLeases(later);

    const counts = await gate.reconcileUnknown(async (row) => {
      if (row.sessionId === "session-1") throw new Error("provider lookup timed out");
      return { kind: "undecided" };
    }, later);

    expect(counts).toEqual({ recorded: 0, released: 0, undecided: 2 });
    await expect(gate.claim(attempt(3), "op-3", later)).rejects.toBeInstanceOf(
      SandboxCapacityExhaustedError
    );
  });

  it("frees a refused create's allocating lease for the attempt that claimed it only", async () => {
    await gate.claim(attempt(1), "op-1", NOW);
    await gate.begin(attempt(1), NOW);

    expect(await gate.releaseRefused({ ...attempt(1), generation: NOW + 1 })).toBe("refused");
    expect(await gate.releaseRefused(attempt(1))).toBe("released");
    expect(await store.list()).toEqual([]);
  });

  it("frees only the slot of the session that recorded the object, once its stop is confirmed", async () => {
    await gate.claim(attempt(1), "op-1", NOW);
    await gate.begin(attempt(1), NOW);
    await gate.settle(attempt(1), "obj-1", NOW);

    expect(await gate.releaseStopped("session-2", "obj-1", NOW)).toBe("absent");
    expect(await store.list()).toHaveLength(1);

    expect(await gate.releaseStopped("session-1", "obj-1", NOW)).toBe("released");
    expect(await store.list()).toEqual([]);
    await gate.claim(attempt(2), "op-2", NOW);
    await gate.claim(attempt(3), "op-3", NOW);
  });

  it("frees an allocating lease when its pending reference's stop is confirmed, without waiting for it to lapse", async () => {
    await gate.claim(attempt(1), "pending-ref", NOW);
    await gate.begin(attempt(1), NOW);

    expect(await gate.releaseStopped("session-1", "pending-ref", NOW + 1)).toBe("absent");
    expect(await gate.releaseStopped("session-1", "pending-ref", NOW)).toBe("released");
    expect(await store.list()).toEqual([]);
  });

  it("frees the slot of a lapsed pending allocation once its stop is confirmed, and not before", async () => {
    await gate.claim(attempt(1), "pending-ref", NOW);
    await gate.begin(attempt(1), NOW);
    const later = NOW + SANDBOX_ADMISSION_LEASE_TTL_MS;
    await store.expireLeases(later);

    expect(await gate.releaseStopped("session-2", "pending-ref", NOW)).toBe("absent");
    expect(await store.list()).toHaveLength(1);

    expect(await gate.releaseStopped("session-1", "pending-ref", NOW)).toBe("released");
    expect(await store.list()).toEqual([]);
  });

  it("frees a recorded object's lease on its confirmed stop, whichever generation of the session issued the stop", async () => {
    await gate.claim(attempt(1), "op-1", NOW);
    await gate.begin(attempt(1), NOW);
    await gate.settle(attempt(1), "obj-1", NOW);

    expect(await gate.releaseStopped("session-1", "obj-1", NOW + 1)).toBe("released");
    expect(await store.list()).toEqual([]);
  });

  it("never frees a lease for a stop of an object the session does not hold", async () => {
    await gate.claim(attempt(1), "op-1", NOW);
    await gate.begin(attempt(1), NOW);
    await gate.settle(attempt(1), "obj-1", NOW);

    expect(await gate.releaseStopped("session-1", "obj-2", NOW)).toBe("absent");
    expect(await store.list()).toEqual([expect.objectContaining({ state: "allocated" })]);
  });

  it("lists an allocated lease only once a newer generation of its session holds a lease, and frees nothing by listing", async () => {
    const older = admissionIdentity(
      { id: "session-1" },
      { sandboxId: "sandbox-1", createdAt: NOW }
    );
    await gate.claim(older, "op-1", NOW);
    await gate.begin(older, NOW);
    await gate.settle(older, "obj-1", NOW);
    expect(await gate.orphanedAllocated()).toEqual([]);

    const newer = admissionIdentity(
      { id: "session-1" },
      { sandboxId: "sandbox-2", createdAt: NOW + 1 }
    );
    await gate.claim(newer, "op-2", NOW + 1);
    expect(await gate.orphanedAllocated()).toEqual([
      expect.objectContaining({ modalObjectId: "obj-1", generation: NOW }),
    ]);
    expect(await store.list()).toHaveLength(2);
  });

  it("lists an allocated lease its owner relinquished, with no newer lease, and frees nothing by listing", async () => {
    await gate.claim(attempt(1), "op-1", NOW);
    await gate.begin(attempt(1), NOW);
    await gate.settle(attempt(1), "obj-1", NOW);

    expect(await gate.relinquish("session-2", "obj-1", NOW + 1)).toBe("refused");
    expect(await gate.orphanedAllocated()).toEqual([]);

    expect(await gate.relinquish("session-1", "obj-1", NOW + 1)).toBe("applied");
    expect(await gate.orphanedAllocated()).toEqual([
      expect.objectContaining({ modalObjectId: "obj-1", state: "allocated" }),
    ]);
    expect(await store.list()).toHaveLength(1);
  });

  it("settles a lease a restart left allocating once it has lapsed, without a lapse having been recorded", async () => {
    await gate.claim(attempt(1), "op-1", NOW);
    await gate.begin(attempt(1), NOW);
    const later = NOW + SANDBOX_ADMISSION_LEASE_TTL_MS;

    const counts = await gate.reconcileUnknown(
      async () => ({ kind: "found", modalObjectId: "obj-1" }),
      later
    );

    expect(counts).toEqual({ recorded: 1, released: 0, undecided: 0 });
    expect(await store.list()).toEqual([
      expect.objectContaining({ state: "allocated", modalObjectId: "obj-1" }),
    ]);
  });
});
