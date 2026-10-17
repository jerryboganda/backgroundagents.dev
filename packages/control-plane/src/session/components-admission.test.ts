import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigrations } from "../node/migrate";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import { createLogger } from "../logger";
import type { BackgroundTasks } from "../platform-ports";
import { SandboxAdmissionStore } from "../sandbox/admission/reservations";
import { SandboxAccess } from "../sandbox/lifecycle/sandbox-access";
import {
  createMockAlarmScheduler,
  createMockBroadcaster,
  createMockProvider,
  createMockSandbox,
  createMockSession,
  createMockStorage,
  createMockWebSocketManager,
  createUnmanagedShutdown,
  noLifetime,
} from "../sandbox/lifecycle/test-helpers";
import { createSandboxProviderFromEnv } from "../sandbox/provider-factory";
import { providerResumesAfterStop, type SandboxProvider } from "../sandbox/provider";
import { createTestEnv } from "../router.test-support";
import type { RehydratableAlarmScheduler } from "./alarm/scheduler";
import { createLifecycleManager } from "./components";
import type { SessionMessenger } from "./messenger";
import type { LifecycleSocketAdapter } from "./sandbox-lifecycle-adapters";

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../terraform/d1/migrations"
);
const EXECUTOR_URL = "https://executor.test";
const ADMISSION_SECRET = "wiring-admission-secret-0123456789abcdef";
/** The executor's domain tag for the signed admission payload. */
const SIGNATURE_DOMAIN = "open-inspect.vps-admission.v1";

const vpsEnv = (overrides: Parameters<typeof createTestEnv>[0] = {}) =>
  createTestEnv({
    SANDBOX_PROVIDER: "vps",
    VPS_EXECUTOR_URL: EXECUTOR_URL,
    VPS_EXECUTOR_TOKEN: "executor-token",
    VPS_EXECUTOR_ADMISSION_SECRET: ADMISSION_SECRET,
    ...overrides,
  });

/** Builds the lifecycle manager through the production composition, with only the sandbox side mocked. */
function buildLifecycle(
  provider: SandboxProvider,
  storage: ReturnType<typeof createMockStorage>,
  db: NodeSqlDatabase,
  env: ReturnType<typeof createTestEnv>
) {
  const broadcaster = createMockBroadcaster();
  const sockets = createMockWebSocketManager(false);
  const backgroundTasks: BackgroundTasks = {
    submit: (task) => {
      void task();
    },
  };
  return createLifecycleManager({
    recordWarning: vi.fn(),
    resumeQueuedWork: vi.fn(async () => {}),
    shutdown: createUnmanagedShutdown(),
    access: new SandboxAccess({
      storage,
      broadcaster,
      sockets,
      canResumeAfterStop: () => providerResumesAfterStop(provider),
      getLogger: () => createLogger("lifecycle-manager"),
    }),
    provider,
    env,
    db,
    getSessionId: () => "session-123",
    storage,
    sessionContext: storage,
    repoSecretsEncryptionKey: "test-repo-secrets-key",
    messenger: broadcaster as unknown as SessionMessenger,
    lifecycleSockets: sockets as unknown as LifecycleSocketAdapter,
    alarmScheduler: createMockAlarmScheduler() as unknown as RehydratableAlarmScheduler,
    backgroundTasks,
  });
}

describe("production lifecycle wiring for VPS admission", () => {
  let sqlite: DatabaseSync;
  let db: NodeSqlDatabase;
  let store: SandboxAdmissionStore;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON");
    applyMigrations(sqlite, MIGRATIONS_DIR);
    sqlite.exec("INSERT INTO sessions (id, created_at, updated_at) VALUES ('session-123', 1, 1)");
    db = createNodeSqlDatabase(sqlite);
    store = new SandboxAdmissionStore(db);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
  });

  it("creates a VPS sandbox under a lease the executor can verify, and records the object it returns", async () => {
    const fetchSpy = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ providerObjectId: "vm-prod" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchSpy);
    const env = vpsEnv();
    const provider = createSandboxProviderFromEnv(env, "vps");
    const storage = createMockStorage(
      createMockSession(),
      createMockSandbox({ status: "pending", snapshot_image_id: null, modal_object_id: null })
    );

    await buildLifecycle(provider, storage, db, env).spawnSandbox();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(url).toBe(`${EXECUTOR_URL}/v1/sandboxes`);
    expect(body.admissionLease.leaseToken).toBe(`session-123:${body.sandboxId}`);
    // The executor recomputes this HMAC over the same canonical payload before it admits the create.
    const expected = createHmac("sha256", ADMISSION_SECRET)
      .update(
        JSON.stringify([
          SIGNATURE_DOMAIN,
          body.sessionId,
          body.sandboxId,
          body.admissionLease.leaseToken,
          body.admissionLease.expiresAtMs,
        ])
      )
      .digest("hex");
    expect(body.admissionLease.signature).toBe(expected);
    expect(await store.list()).toEqual([
      expect.objectContaining({
        sessionId: "session-123",
        state: "allocated",
        modalObjectId: "vm-prod",
      }),
    ]);
  });

  it("leaves other providers on their pre-admission path, with no lease and no slot", async () => {
    const createSandbox = vi.fn(async (config: { sandboxId: string }) => ({
      sandboxId: config.sandboxId,
      providerObjectId: "obj-other",
      createdAt: Date.now(),
      lifetime: noLifetime(),
    }));
    const provider = createMockProvider({ createSandbox });
    const storage = createMockStorage(
      createMockSession(),
      createMockSandbox({ status: "pending", snapshot_image_id: null, modal_object_id: null })
    );

    await buildLifecycle(provider, storage, db, createTestEnv()).spawnSandbox();

    expect(createSandbox).toHaveBeenCalledTimes(1);
    expect(createSandbox.mock.calls[0][0]).not.toHaveProperty("admissionLease");
    expect(await store.list()).toEqual([]);
  });
});
