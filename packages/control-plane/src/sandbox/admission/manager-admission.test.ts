import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigrations } from "../../node/migrate";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../../node/sqlite-database";
import { createLogger } from "../../logger";
import { COMPATIBLE_RUNTIME_VERSION } from "../../image-builds/test-helpers";
import { SandboxLifecycleManager } from "../lifecycle/manager";
import { SandboxAccess } from "../lifecycle/sandbox-access";
import {
  createMockAlarmScheduler,
  createMockBroadcaster,
  createMockIdGenerator,
  createMockProvider,
  createMockSandbox,
  createMockSession,
  createMockStorage,
  createMockWebSocketManager,
  createTestConfig,
  createUnmanagedShutdown,
  noLifetime,
} from "../lifecycle/test-helpers";
import {
  providerResumesAfterStop,
  SandboxLaunchRejectedError,
  SandboxProviderError,
  type ResolveSandboxConfig,
  type ResolveSandboxResult,
} from "../provider";
import { PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS } from "../lifecycle/decisions";
import {
  formatPendingVmReference,
  formatVpsPendingVmReference,
} from "../providers/pending-vm-reference";
import {
  SANDBOX_ADMISSION_LEASE_TTL_MS,
  SandboxAdmissionGate,
  SandboxCapacityExhaustedError,
  admissionIdentity,
} from "./gate";
import { SandboxAdmissionStore, type SandboxAdmissionRecord } from "./reservations";

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../terraform/d1/migrations"
);

describe("sandbox admission in the lifecycle manager", () => {
  let sqlite: DatabaseSync;
  let db: NodeSqlDatabase;
  let store: SandboxAdmissionStore;
  let gate: SandboxAdmissionGate;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON");
    applyMigrations(sqlite, MIGRATIONS_DIR);
    // session-123 is the mock session the manager runs; the others hold the slots.
    sqlite.exec(
      "INSERT INTO sessions (id, created_at, updated_at) VALUES ('session-123', 1, 1), ('other-a', 1, 1), ('other-b', 1, 1)"
    );
    db = createNodeSqlDatabase(sqlite);
    store = new SandboxAdmissionStore(db);
    gate = new SandboxAdmissionGate(store);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  /** Fills both slots with leases this manager does not own. */
  async function holdEverySlot(): Promise<void> {
    const generation = { sandboxId: "sandbox-held", createdAt: 1 };
    await gate.claim(admissionIdentity({ id: "other-a" }, generation), "op-a", Date.now());
    await gate.claim(admissionIdentity({ id: "other-b" }, generation), "op-b", Date.now());
  }

  function buildManager(
    provider: ReturnType<typeof createMockProvider>,
    storage: ReturnType<typeof createMockStorage>,
    admission?: SandboxAdmissionGate
  ): SandboxLifecycleManager {
    const broadcaster = createMockBroadcaster();
    const wsManager = createMockWebSocketManager(false);
    const config = createTestConfig();
    const access = new SandboxAccess({
      storage,
      broadcaster,
      sockets: wsManager,
      canResumeAfterStop: () => providerResumesAfterStop(provider),
      getLogger: () => createLogger("lifecycle-manager"),
    });
    return new SandboxLifecycleManager(
      provider,
      storage,
      storage,
      broadcaster,
      wsManager,
      createMockAlarmScheduler(),
      createMockIdGenerator(),
      createUnmanagedShutdown(),
      access,
      config,
      undefined,
      undefined,
      admission
    );
  }

  const freshSpawn = () =>
    createMockSandbox({ status: "pending", snapshot_image_id: null, modal_object_id: null });
  const savedRestore = () =>
    createMockSandbox({
      status: "stopped",
      snapshot_image_id: "saved-image",
      snapshot_runtime_version: COMPATIBLE_RUNTIME_VERSION,
      modal_object_id: null,
    });

  it("refuses a spawn before any provider call when every slot is held", async () => {
    await holdEverySlot();
    const sandbox = freshSpawn();
    const storage = createMockStorage(createMockSession(), sandbox);
    const createSandbox = vi.fn();
    const provider = createMockProvider({ createSandbox });

    await buildManager(provider, storage, gate).spawnSandbox();

    expect(createSandbox).not.toHaveBeenCalled();
    expect(storage.calls).toContain("transitionSandboxStatus:spawning->failed");
    expect(await store.list()).toHaveLength(2);
  });

  it("records a successful spawn's object under its lease while the call is in flight and after it returns", async () => {
    const sandbox = freshSpawn();
    const storage = createMockStorage(createMockSession(), sandbox);
    let duringCall: SandboxAdmissionRecord[] = [];
    const provider = createMockProvider({
      createSandbox: vi.fn(async (config) => {
        duringCall = await store.list();
        return {
          sandboxId: config.sandboxId,
          providerObjectId: "obj-created",
          createdAt: Date.now(),
          lifetime: noLifetime(),
        };
      }),
    });

    await buildManager(provider, storage, gate).spawnSandbox();

    expect(duringCall).toEqual([expect.objectContaining({ state: "allocating" })]);
    expect(await store.list()).toEqual([
      expect.objectContaining({
        sessionId: "session-123",
        state: "allocated",
        modalObjectId: "obj-created",
      }),
    ]);
  });

  it("keeps a rejected launch's lease until its object's stop is confirmed, then frees the slot", async () => {
    const sandbox = freshSpawn();
    const storage = createMockStorage(createMockSession(), sandbox);
    let duringCall: SandboxAdmissionRecord[] = [];
    const stopSandbox = vi.fn(async () => ({ success: true as const }));
    const provider = createMockProvider({
      createSandbox: vi.fn(async () => {
        duringCall = await store.list();
        throw new SandboxLaunchRejectedError("incompatible", "obj-rejected");
      }),
      capabilities: { supportsExplicitStop: true },
      stopSandbox,
    });

    await buildManager(provider, storage, gate).spawnSandbox();

    expect(duringCall).toEqual([expect.objectContaining({ state: "allocating" })]);
    expect(stopSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ providerObjectId: "obj-rejected" })
    );
    expect(await store.list()).toEqual([]);
  });

  it("claims a restore's slot before the provider restore call and records the object it restores", async () => {
    const sandbox = savedRestore();
    const storage = createMockStorage(createMockSession(), sandbox);
    let duringRestore: SandboxAdmissionRecord[] = [];
    const restoreFromSnapshot = vi.fn(async (config) => {
      duringRestore = await store.list();
      return {
        success: true as const,
        sandboxId: config.sandboxId,
        providerObjectId: "obj-restored",
        lifetime: noLifetime(),
      };
    });
    const provider = createMockProvider({ restoreFromSnapshot });

    await buildManager(provider, storage, gate).spawnSandbox();

    expect(restoreFromSnapshot).toHaveBeenCalledTimes(1);
    expect(duringRestore).toEqual([expect.objectContaining({ state: "allocating" })]);
    const [restored] = await store.list();
    expect(restored).toEqual(
      expect.objectContaining({ state: "allocated", modalObjectId: "obj-restored" })
    );
    expect(restoreFromSnapshot.mock.calls[0][0].admissionLease).toEqual({
      leaseToken: restored.leaseToken,
      expiresAtMs: expect.any(Number),
    });
  });

  it("refuses a restore before the provider restore call when every slot is held", async () => {
    await holdEverySlot();
    const storage = createMockStorage(createMockSession(), savedRestore());
    const restoreFromSnapshot = vi.fn();
    const provider = createMockProvider({ restoreFromSnapshot });

    await buildManager(provider, storage, gate).spawnSandbox();

    expect(restoreFromSnapshot).not.toHaveBeenCalled();
    expect(storage.calls).toContain("transitionSandboxStatus:spawning->failed");
    expect(await store.list()).toHaveLength(2);
  });

  it("sends the claimed lease's proof with the provider create call", async () => {
    const storage = createMockStorage(createMockSession(), freshSpawn());
    const createSandbox = vi.fn(async (config) => ({
      sandboxId: config.sandboxId,
      providerObjectId: "obj-proof",
      createdAt: Date.now(),
      lifetime: noLifetime(),
    }));
    const before = Date.now();

    await buildManager(createMockProvider({ createSandbox }), storage, gate).spawnSandbox();

    const [lease] = await store.list();
    const proof = createSandbox.mock.calls[0][0].admissionLease;
    expect(proof).toEqual({ leaseToken: lease.leaseToken, expiresAtMs: expect.any(Number) });
    expect(proof.expiresAtMs).toBeGreaterThanOrEqual(before + SANDBOX_ADMISSION_LEASE_TTL_MS);
    // The create carries the expiry its persisted row was claimed with, which is what the close later signs.
    expect(proof.expiresAtMs).toBe(lease.createdAt + SANDBOX_ADMISSION_LEASE_TTL_MS);
  });

  it("claims nothing when no admission gate is configured", async () => {
    const storage = createMockStorage(createMockSession(), freshSpawn());
    const createSandbox = vi.fn(async (config) => ({
      sandboxId: config.sandboxId,
      providerObjectId: "obj-unmanaged",
      createdAt: Date.now(),
      lifetime: noLifetime(),
    }));

    await buildManager(createMockProvider({ createSandbox }), storage).spawnSandbox();

    expect(createSandbox).toHaveBeenCalledTimes(1);
    expect(createSandbox.mock.calls[0][0]).not.toHaveProperty("admissionLease");
    expect(await store.list()).toEqual([]);
  });

  /** The pending reference a VPS-shaped provider persists before its create. */
  const pendingFor = (config: { sessionId: string; sandboxId: string }) => ({
    reference: formatPendingVmReference(config.sessionId, config.sandboxId),
    lifetime: {
      kind: "finite" as const,
      expiresAtMs: Date.now() + 3_600_000,
      observedAtMs: Date.now(),
      source: "conservative_start_bound" as const,
    },
  });

  it("frees the slot when the provider refuses the create before allocating anything", async () => {
    const storage = createMockStorage(createMockSession(), freshSpawn());
    const createSandbox = vi.fn(async () => {
      throw new SandboxProviderError("executor refused", "permanent");
    });
    const provider = {
      ...createMockProvider({ createSandbox }),
      isUnknownStartupError: () => false,
    };

    await buildManager(provider, storage, gate).spawnSandbox();

    expect(createSandbox).toHaveBeenCalledTimes(1);
    expect(storage.calls).toContain("transitionSandboxStatus:spawning->failed");
    await holdEverySlot();
    expect(await store.list()).toHaveLength(2);
  });

  it("clears the pending reference a refused create left, so a respawn creates again", async () => {
    const storage = createMockStorage(createMockSession(), freshSpawn());
    let refuse = true;
    const createSandbox = vi.fn(async (config: { sandboxId: string }) => {
      if (refuse) throw new SandboxProviderError("executor refused", "permanent");
      return {
        sandboxId: config.sandboxId,
        providerObjectId: "obj-respawned",
        createdAt: Date.now(),
        lifetime: noLifetime(),
      };
    });
    const provider = {
      ...createMockProvider({ createSandbox }),
      isUnknownStartupError: () => false,
      pendingSandboxAllocation: pendingFor,
    };
    const manager = buildManager(provider, storage, gate);

    await manager.spawnSandbox();
    // The refused create named no object, so its reference must not stay on the row for a respawn to stop.
    expect(storage.getSandbox()?.modal_object_id).toBeNull();
    expect(await store.list()).toEqual([]);

    refuse = false;
    await manager.spawnSandbox();

    expect(createSandbox).toHaveBeenCalledTimes(2);
    expect(await store.list()).toEqual([
      expect.objectContaining({
        sessionId: "session-123",
        state: "allocated",
        modalObjectId: "obj-respawned",
      }),
    ]);
  });

  it("keeps an ambiguous create's slot and settles it to the object the executor resolves", async () => {
    const storage = createMockStorage(createMockSession(), freshSpawn());
    const createSandbox = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const resolveSandbox = vi.fn(async (config: ResolveSandboxConfig) => ({
      sandboxId: config.sandboxId,
      providerObjectId: "obj-recovered",
      lifetime: noLifetime(),
    }));
    const provider = {
      ...createMockProvider({ createSandbox }),
      isUnknownStartupError: () => true,
      pendingSandboxAllocation: pendingFor,
      resolveSandbox,
    };

    await buildManager(provider, storage, gate).spawnSandbox();

    expect(resolveSandbox).toHaveBeenCalledTimes(1);
    expect(await store.list()).toEqual([
      expect.objectContaining({
        sessionId: "session-123",
        state: "allocated",
        modalObjectId: "obj-recovered",
      }),
    ]);
  });

  it("keeps an ambiguous create's slot while the executor cannot resolve it", async () => {
    const storage = createMockStorage(createMockSession(), freshSpawn());
    const createSandbox = vi.fn(async () => {
      // Past the materialize bound, so recovery stops at its first failed lookup.
      vi.spyOn(Date, "now").mockReturnValue(
        Date.now() + PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS + 60_000
      );
      throw new TypeError("fetch failed");
    });
    const resolveSandbox = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const provider = {
      ...createMockProvider({ createSandbox }),
      isUnknownStartupError: () => true,
      pendingSandboxAllocation: pendingFor,
      resolveSandbox,
    };

    await buildManager(provider, storage, gate).spawnSandbox();
    vi.restoreAllMocks();

    expect(resolveSandbox).toHaveBeenCalledTimes(1);
    expect(await store.list()).toEqual([
      expect.objectContaining({ sessionId: "session-123", state: "allocating" }),
    ]);
    // Once the lease lapses the row turns unknown, and it still holds its slot.
    const later = Date.now() + 120_000;
    await gate.claim(
      admissionIdentity({ id: "other-a" }, { sandboxId: "sandbox-held", createdAt: 1 }),
      "op-a",
      later
    );
    expect(await store.list()).toEqual([
      expect.objectContaining({ sessionId: "session-123", state: "unknown" }),
      expect.objectContaining({ sessionId: "other-a" }),
    ]);
    await expect(
      gate.claim(
        admissionIdentity({ id: "other-b" }, { sandboxId: "sandbox-held", createdAt: 1 }),
        "op-b",
        later
      )
    ).rejects.toBeInstanceOf(SandboxCapacityExhaustedError);
  });

  it("refuses a spawn after a restart while a lease from before it still holds a slot", async () => {
    await holdEverySlot();
    // The restarted instance builds its own store and gate over the same database.
    const restarted = new SandboxAdmissionGate(new SandboxAdmissionStore(db));
    const createSandbox = vi.fn();

    await buildManager(
      createMockProvider({ createSandbox }),
      createMockStorage(createMockSession(), freshSpawn()),
      restarted
    ).spawnSandbox();

    expect(createSandbox).not.toHaveBeenCalled();
    expect(await store.list()).toHaveLength(2);
  });

  it("settles a retained create only from the bridge of its own attempt", async () => {
    const sandbox = freshSpawn();
    const storage = createMockStorage(createMockSession(), sandbox);
    const started = Date.now();
    const createSandbox = vi.fn(async () => {
      vi.spyOn(Date, "now").mockReturnValue(
        started + PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS + 60_000
      );
      throw new TypeError("fetch failed");
    });
    const resolveSandbox = vi.fn<(config: ResolveSandboxConfig) => Promise<ResolveSandboxResult>>(
      async () => {
        throw new TypeError("fetch failed");
      }
    );
    const provider = {
      ...createMockProvider({ createSandbox }),
      isUnknownStartupError: () => true,
      pendingSandboxAllocation: pendingFor,
      resolveSandbox,
    };
    const manager = buildManager(provider, storage, gate);
    await manager.spawnSandbox();
    vi.restoreAllMocks();

    // The sandbox boots. A bridge for another sandbox settles nothing, and a settle naming another session is refused.
    sandbox.status = "connecting";
    manager.onSandboxSocketAttached({ sandboxId: "sandbox-other", createdAt: sandbox.created_at });
    expect(
      await gate.settle(
        admissionIdentity(
          { id: "other-a" },
          { sandboxId: sandbox.modal_sandbox_id ?? "", createdAt: sandbox.created_at }
        ),
        "obj-wrong",
        Date.now()
      )
    ).toBe("refused");
    expect(await store.list()).toEqual([
      expect.objectContaining({
        sessionId: "session-123",
        state: "allocating",
        modalObjectId: null,
      }),
    ]);

    // The bridge of the attempt that holds the slot settles it to the object the executor resolves.
    resolveSandbox.mockImplementation(async (config: ResolveSandboxConfig) => ({
      sandboxId: config.sandboxId,
      providerObjectId: "obj-bridged",
      lifetime: noLifetime(),
    }));
    manager.onSandboxSocketAttached({
      sandboxId: sandbox.modal_sandbox_id ?? "",
      createdAt: sandbox.created_at,
    });
    await vi.waitFor(async () => {
      expect(await store.list()).toEqual([
        expect.objectContaining({ state: "allocated", modalObjectId: "obj-bridged" }),
      ]);
    });
  });

  it("keeps a VPS pending reference whose stop cannot be confirmed, so a respawn creates nothing new", async () => {
    const pendingRef = formatVpsPendingVmReference("session-123", "sandbox-old");
    const stopSandbox = vi.fn(async () => {
      throw new SandboxProviderError(
        "VPS executor has no record of the pending sandbox; stop cannot be confirmed",
        "transient"
      );
    });
    const createSandbox = vi.fn(async (config: { sandboxId: string }) => ({
      sandboxId: config.sandboxId,
      providerObjectId: "obj-new",
      createdAt: Date.now(),
      lifetime: noLifetime(),
    }));
    const provider = createMockProvider({
      stopSandbox,
      createSandbox,
      capabilities: { supportsExplicitStop: true },
    });
    const storage = createMockStorage(
      createMockSession(),
      createMockSandbox({ status: "failed", snapshot_image_id: null, modal_object_id: pendingRef })
    );

    await buildManager(provider, storage, gate).spawnSandbox();

    expect(stopSandbox).toHaveBeenCalledTimes(1);
    expect(createSandbox).not.toHaveBeenCalled();
    expect(storage.getSandbox()?.modal_object_id).toBe(pendingRef);
    expect(await store.list()).toEqual([]);
  });

  /** Claims, begins and records one object under the prior generation a respawn replaces. */
  async function allocatedPriorObject(objectId: string): Promise<void> {
    const identity = admissionIdentity(
      { id: "session-123" },
      { sandboxId: "sandbox-old", createdAt: 1_000 }
    );
    await gate.claim(identity, "op-old", 1_000);
    await gate.begin(identity, 1_000);
    await gate.settle(identity, objectId, 1_000);
  }

  const priorSandbox = (status: "failed" | "ready") =>
    createMockSandbox({
      status,
      snapshot_image_id: null,
      modal_sandbox_id: "sandbox-old",
      created_at: 1_000,
      modal_object_id: "obj-old",
    });

  it("frees the exact lease of the prior object a respawn stops, though the respawn rewrites the generation", async () => {
    const storage = createMockStorage(createMockSession(), priorSandbox("failed"));
    await allocatedPriorObject("obj-old");
    const stopSandbox = vi.fn(async () => ({ success: true as const }));
    const provider = createMockProvider({
      stopSandbox,
      createSandbox: vi.fn(async (config) => ({
        sandboxId: config.sandboxId,
        providerObjectId: "obj-new",
        createdAt: Date.now(),
        lifetime: noLifetime(),
      })),
      capabilities: { supportsExplicitStop: true },
    });

    await buildManager(provider, storage, gate).spawnSandbox();

    expect(stopSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ providerObjectId: "obj-old", generationCreatedAtMs: 1_000 })
    );
    expect(await store.list()).toEqual([
      expect.objectContaining({ modalObjectId: "obj-new", state: "allocated" }),
    ]);
  });

  it("keeps an admitted object's handle when its stop fails, so nothing is created while it may run", async () => {
    const storage = createMockStorage(createMockSession(), priorSandbox("failed"));
    await allocatedPriorObject("obj-old");
    const createSandbox = vi.fn();
    const provider = createMockProvider({
      stopSandbox: vi.fn(async () => {
        throw new SandboxProviderError("executor unreachable", "transient");
      }),
      createSandbox,
      capabilities: { supportsExplicitStop: true },
    });

    await buildManager(provider, storage, gate).spawnSandbox();

    expect(createSandbox).not.toHaveBeenCalled();
    expect(storage.getSandbox()?.modal_object_id).toBe("obj-old");
    expect(await store.list()).toEqual([
      expect.objectContaining({ modalObjectId: "obj-old", state: "allocated" }),
    ]);
  });

  it("marks the object a failed respawn left behind as relinquished, so the reconcile hook frees it with no newer lease", async () => {
    const storage = createMockStorage(createMockSession(), priorSandbox("failed"));
    await allocatedPriorObject("obj-old");
    const provider = createMockProvider({
      stopSandbox: vi.fn(async () => {
        throw new SandboxProviderError("executor unreachable", "transient");
      }),
      createSandbox: vi.fn(),
      capabilities: { supportsExplicitStop: true },
    });

    await buildManager(provider, storage, gate).spawnSandbox();

    expect(await gate.orphanedAllocated()).toEqual([
      expect.objectContaining({ modalObjectId: "obj-old", generation: 1_000 }),
    ]);
  });

  it("fails a respawn before its generation write when the relinquish mark fails, and an ordinary stop then frees its slot with both slots held", async () => {
    const storage = createMockStorage(createMockSession(), priorSandbox("failed"));
    await allocatedPriorObject("obj-old");
    await gate.claim(
      admissionIdentity({ id: "other-a" }, { sandboxId: "sandbox-held", createdAt: 1 }),
      "op-a",
      Date.now()
    );
    const markRelinquished = vi
      .spyOn(store, "markRelinquished")
      .mockRejectedValueOnce(new Error("D1 unavailable"));
    const stopSandbox = vi.fn(async () => ({ success: true as const }));
    const createSandbox = vi.fn();
    const provider = createMockProvider({
      stopSandbox,
      createSandbox,
      capabilities: { supportsExplicitStop: true },
    });
    const manager = buildManager(provider, storage, gate);

    await manager.spawnSandbox();

    expect(markRelinquished).toHaveBeenCalledWith("session-123", "obj-old", expect.any(Number));
    expect(storage.updateSandboxForSpawn).not.toHaveBeenCalled();
    expect(createSandbox).not.toHaveBeenCalled();
    expect(storage.getSandbox()).toEqual(
      expect.objectContaining({ created_at: 1_000, modal_object_id: "obj-old" })
    );
    expect(await store.list()).toHaveLength(2);

    // The live row a sandbox holds, so the ordinary stop runs under the generation the lease was claimed under.
    storage.updateSandboxStatus("ready");
    await manager.terminateUnresponsiveSandbox("stop_confirmation_timeout");

    expect(stopSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ providerObjectId: "obj-old", generationCreatedAtMs: 1_000 })
    );
    expect(await store.list()).toEqual([expect.objectContaining({ sessionId: "other-a" })]);
    await gate.claim(
      admissionIdentity({ id: "other-b" }, { sandboxId: "sandbox-b", createdAt: 2 }),
      "op-b",
      Date.now()
    );
    expect(await store.list()).toHaveLength(2);
  });

  it("fails a restore before its generation write when the relinquish mark fails", async () => {
    const storage = createMockStorage(createMockSession(), {
      ...savedRestore(),
      modal_sandbox_id: "sandbox-old",
      created_at: 1_000,
      modal_object_id: "obj-old",
    });
    await allocatedPriorObject("obj-old");
    const markRelinquished = vi
      .spyOn(store, "markRelinquished")
      .mockRejectedValueOnce(new Error("D1 unavailable"));
    const restoreFromSnapshot = vi.fn();
    const provider = createMockProvider({ restoreFromSnapshot });

    await buildManager(provider, storage, gate).spawnSandbox();

    expect(markRelinquished).toHaveBeenCalledWith("session-123", "obj-old", expect.any(Number));
    expect(restoreFromSnapshot).not.toHaveBeenCalled();
    expect(storage.updateSandboxForSpawn).not.toHaveBeenCalled();
    expect(storage.getSandbox()).toEqual(
      expect.objectContaining({ created_at: 1_000, modal_object_id: "obj-old" })
    );
  });

  it("logs a confirmed stop that holds no admission lease, so a stale handle stays visible", async () => {
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const storage = createMockStorage(
      createMockSession(),
      createMockSandbox({
        status: "ready",
        snapshot_image_id: null,
        modal_sandbox_id: "sandbox-old",
        created_at: 1_000,
        modal_object_id: "obj-old",
        last_heartbeat: Date.now(),
      })
    );
    const provider = createMockProvider({
      stopSandbox: vi.fn(async () => ({ success: true as const })),
      capabilities: { supportsExplicitStop: true },
    });

    await buildManager(provider, storage, gate).terminateUnresponsiveSandbox(
      "stop_confirmation_timeout"
    );

    expect(info.mock.calls.flat().map(String).join("\n")).toContain(
      "sandbox.admission_release_absent"
    );
    info.mockRestore();
  });

  it("awaits the reconnect of a live VPS generation whose bridge dropped, so neither stop nor create runs", async () => {
    const pendingRef = formatVpsPendingVmReference("session-123", "sandbox-live");
    const stopSandbox = vi.fn(async () => ({ success: true }));
    const createSandbox = vi.fn();
    const provider = createMockProvider({
      stopSandbox,
      createSandbox,
      capabilities: { supportsExplicitStop: true },
    });
    const storage = createMockStorage(
      createMockSession(),
      createMockSandbox({
        status: "ready",
        snapshot_image_id: null,
        modal_object_id: pendingRef,
        last_heartbeat: Date.now(),
      })
    );

    await buildManager(provider, storage, gate).spawnSandbox();

    expect(stopSandbox).not.toHaveBeenCalled();
    expect(createSandbox).not.toHaveBeenCalled();
    expect(storage.getSandbox()?.modal_object_id).toBe(pendingRef);
  });
});
