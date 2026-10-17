import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigrations } from "../../node/migrate";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../../node/sqlite-database";
import type { Logger } from "../../logger";
import type { Env } from "../../types";
import { PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS } from "../lifecycle/decisions";
import { formatVpsPendingVmReference } from "../providers/pending-vm-reference";
import {
  SandboxAdmissionGate,
  SandboxCapacityExhaustedError,
  admissionIdentity,
  SANDBOX_ADMISSION_LEASE_TTL_MS,
} from "./gate";
import { SandboxAdmissionStore } from "./reservations";
import {
  RECONCILE_REQUEST_TIMEOUT_MS,
  isVpsSandboxBackend,
  reconcileVpsAdmission,
} from "./vps-reconcile";

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../terraform/d1/migrations"
);
const EXECUTOR_URL = "https://executor.test";
const NOW = 1_000;
const LAPSED = NOW + SANDBOX_ADMISSION_LEASE_TTL_MS;
/** Past the launch's own lookups, so a lapsed lease is eligible for reconciliation. */
const PAST_BOUND = NOW + PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS;

const vpsEnv = {
  SANDBOX_PROVIDER: "vps",
  VPS_EXECUTOR_URL: EXECUTOR_URL,
  VPS_EXECUTOR_TOKEN: "executor-token",
  VPS_EXECUTOR_ADMISSION_SECRET: "reconcile-admission-secret-0123456789abcdef",
} as unknown as Env;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The lease a VPS create claims for one session's sandbox, under the reference the provider writes. */
function leaseFor(sessionId: string, sandboxId: string) {
  return {
    identity: admissionIdentity({ id: sessionId }, { sandboxId, createdAt: NOW }),
    operationRef: formatVpsPendingVmReference(sessionId, sandboxId),
  };
}

describe("VPS admission reconciliation hook", () => {
  let sqlite: DatabaseSync;
  let db: NodeSqlDatabase;
  let store: SandboxAdmissionStore;
  let gate: SandboxAdmissionGate;
  let fetchSpy: ReturnType<typeof vi.fn>;
  let log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON");
    applyMigrations(sqlite, MIGRATIONS_DIR);
    sqlite.exec(
      "INSERT INTO sessions (id, created_at, updated_at) VALUES ('session-1', 1, 1), ('session-2', 1, 1), ('session-3', 1, 1)"
    );
    db = createNodeSqlDatabase(sqlite);
    store = new SandboxAdmissionStore(db);
    gate = new SandboxAdmissionGate(store);
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    log = { info: vi.fn(), warn: vi.fn() };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    db.close();
  });

  const reconcile = (nowMs: number) =>
    reconcileVpsAdmission(vpsEnv, db, nowMs, log as Pick<Logger, "info" | "warn">);

  /** Claims and begins a lease, so the lapse at LAPSED leaves it unknown. */
  async function lapsedLease(sessionId: string, sandboxId: string): Promise<void> {
    const { identity, operationRef } = leaseFor(sessionId, sandboxId);
    await gate.claim(identity, operationRef, NOW);
    await gate.begin(identity, NOW);
  }

  it("recognises only a deployment whose sandbox backend is the VPS executor", () => {
    expect(isVpsSandboxBackend({ SANDBOX_PROVIDER: "vps" })).toBe(true);
    expect(isVpsSandboxBackend({ SANDBOX_PROVIDER: " VPS " })).toBe(true);
    expect(isVpsSandboxBackend({ SANDBOX_PROVIDER: "modal" })).toBe(false);
    expect(isVpsSandboxBackend({})).toBe(false);
  });

  it("does not look up a lapsed lease while its launch's own lookups may still settle it", async () => {
    await lapsedLease("session-1", "sandbox-1");

    await reconcile(LAPSED);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await store.list()).toEqual([expect.objectContaining({ state: "unknown" })]);
  });

  it("frees a lapsed lease only when the executor proves its object absent", async () => {
    await lapsedLease("session-1", "sandbox-1");
    fetchSpy.mockResolvedValueOnce(jsonResponse({ outcome: "absent" }));

    await reconcile(PAST_BOUND);

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${EXECUTOR_URL}/v1/sandboxes/sandbox-1/admission/close`);
    expect(init.method).toBe("POST");
    // The close carries the lease the gate holds, signed over the same tuple the create signed.
    const signature = createHmac("sha256", "reconcile-admission-secret-0123456789abcdef")
      .update(
        JSON.stringify([
          "open-inspect.vps-admission.v1",
          "session-1",
          "sandbox-1",
          "session-1:sandbox-1",
          LAPSED,
        ])
      )
      .digest("hex");
    expect(JSON.parse(init.body)).toEqual({
      sessionId: "session-1",
      admissionLease: { leaseToken: "session-1:sandbox-1", expiresAtMs: LAPSED, signature },
    });
    expect(await store.list()).toEqual([]);
    expect(log.info).toHaveBeenCalledWith(
      "VPS admission leases settled",
      expect.objectContaining({ released: 1 })
    );
  });

  it("stops an object the executor shows under a lapsed lease, then frees its slot", async () => {
    await lapsedLease("session-1", "sandbox-1");
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ outcome: "present", providerObjectId: "vm-late" })
    );
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await reconcile(PAST_BOUND);

    expect(fetchSpy.mock.calls[1][0]).toBe(`${EXECUTOR_URL}/v1/sandboxes/vm-late/stop`);
    expect(await store.list()).toEqual([]);
  });

  it("keeps the slot when the close answer is not proof: a missing route, a create in flight, or a failed request", async () => {
    await lapsedLease("session-1", "sandbox-1");
    await lapsedLease("session-2", "sandbox-2");
    // A 404 can come from a route the executor lacks, so it proves nothing. A 409 says a create still runs.
    fetchSpy.mockResolvedValueOnce(jsonResponse({ error: "not_found" }, 404));
    fetchSpy.mockResolvedValueOnce(jsonResponse({ error: "create_in_progress" }, 409));

    await reconcile(PAST_BOUND);

    expect(await store.list()).toEqual([
      expect.objectContaining({ sessionId: "session-1", state: "unknown", modalObjectId: null }),
      expect.objectContaining({ sessionId: "session-2", state: "unknown", modalObjectId: null }),
    ]);
    await expect(
      gate.claim(leaseFor("session-3", "sandbox-3").identity, "op-3", PAST_BOUND)
    ).rejects.toBeInstanceOf(SandboxCapacityExhaustedError);
  });

  it("keeps the slot when the executor cannot account for the sandbox, since a 503 is undecided", async () => {
    await lapsedLease("session-1", "sandbox-1");
    fetchSpy.mockResolvedValueOnce(jsonResponse({ error: "container_unaccounted" }, 503));

    await reconcile(PAST_BOUND);

    expect(await store.list()).toEqual([
      expect.objectContaining({ sessionId: "session-1", state: "unknown", modalObjectId: null }),
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps the slot when stopping a found object fails, so the next run retries it", async () => {
    await lapsedLease("session-1", "sandbox-1");
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ outcome: "present", providerObjectId: "vm-late" })
    );
    fetchSpy.mockResolvedValueOnce(jsonResponse({ error: "stop_failed" }, 502));

    await reconcile(PAST_BOUND);

    expect(await store.list()).toEqual([
      expect.objectContaining({ state: "unknown", modalObjectId: null }),
    ]);
  });

  /** An object an older generation of the session allocated, under a newer generation's claim that supersedes it. */
  async function supersededObject(objectId: string): Promise<void> {
    const older = admissionIdentity(
      { id: "session-1" },
      { sandboxId: "sandbox-old", createdAt: NOW }
    );
    await gate.claim(older, "op-old", NOW);
    await gate.begin(older, NOW);
    await gate.settle(older, objectId, NOW);
    const newer = admissionIdentity(
      { id: "session-1" },
      { sandboxId: "sandbox-new", createdAt: NOW + 1 }
    );
    await gate.claim(newer, "op-new", NOW + 1);
  }

  /** An allocated object its owner relinquished once its generation moved on, with no newer lease to supersede it. */
  async function relinquishedObject(sessionId: string, objectId: string): Promise<void> {
    const identity = admissionIdentity(
      { id: sessionId },
      { sandboxId: `sandbox-${objectId}`, createdAt: NOW }
    );
    await gate.claim(identity, `op-${objectId}`, NOW);
    await gate.begin(identity, NOW);
    await gate.settle(identity, objectId, NOW);
    await gate.relinquish(sessionId, objectId, NOW + 1);
  }

  it("stops a superseded allocated object on the executor's confirmation, then frees its slot", async () => {
    await supersededObject("obj-old");
    fetchSpy.mockResolvedValueOnce(jsonResponse({ stopped: true }));

    await reconcile(NOW + 2);

    expect(fetchSpy).toHaveBeenCalledWith(
      `${EXECUTOR_URL}/v1/sandboxes/obj-old/stop`,
      expect.anything()
    );
    expect(await store.list()).toEqual([expect.objectContaining({ operationRef: "op-new" })]);
  });

  it("keeps a superseded slot when its stop is not confirmed, including a 404 without the typed not_found", async () => {
    await supersededObject("obj-old");
    fetchSpy.mockResolvedValueOnce(new Response("", { status: 404 }));

    await reconcile(NOW + 2);

    expect(await store.list()).toHaveLength(2);
    expect(log.info).not.toHaveBeenCalled();
  });

  it("frees a superseded slot once the executor answers the typed sandbox_not_found for its object", async () => {
    await supersededObject("obj-old");
    fetchSpy.mockResolvedValueOnce(jsonResponse({ error: "sandbox_not_found" }, 404));

    await reconcile(NOW + 2);

    expect(await store.list()).toEqual([expect.objectContaining({ operationRef: "op-new" })]);
  });

  it("stops an allocated object its owner relinquished, with no newer lease, and frees its slot", async () => {
    await relinquishedObject("session-1", "obj-old");
    fetchSpy.mockResolvedValueOnce(jsonResponse({ stopped: true }));

    await reconcile(NOW + 2);

    expect(fetchSpy).toHaveBeenCalledWith(
      `${EXECUTOR_URL}/v1/sandboxes/obj-old/stop`,
      expect.anything()
    );
    expect(await store.list()).toEqual([]);
  });

  it("frees both slots when both are held by relinquished objects, so a new claim succeeds without a new allocation first", async () => {
    await relinquishedObject("session-1", "obj-a");
    await relinquishedObject("session-2", "obj-b");
    const next = admissionIdentity({ id: "session-3" }, { sandboxId: "sandbox-3", createdAt: NOW });
    await expect(gate.claim(next, "op-3", NOW + 1)).rejects.toBeInstanceOf(
      SandboxCapacityExhaustedError
    );
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ stopped: true }))
      .mockResolvedValueOnce(jsonResponse({ stopped: true }));

    await reconcile(NOW + 2);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(await store.list()).toEqual([]);
    await expect(gate.claim(next, "op-3", NOW + 2)).resolves.toEqual(
      expect.objectContaining({ leaseToken: "session-3:sandbox-3" })
    );
  });

  it("never stops an allocated object its owner has not relinquished, since the owner may still use it", async () => {
    const identity = admissionIdentity(
      { id: "session-1" },
      { sandboxId: "sandbox-live", createdAt: NOW }
    );
    await gate.claim(identity, "op-live", NOW);
    await gate.begin(identity, NOW);
    await gate.settle(identity, "obj-live", NOW);

    await reconcile(NOW + 2);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await store.list()).toEqual([
      expect.objectContaining({ modalObjectId: "obj-live", state: "allocated" }),
    ]);
  });

  it("keeps a relinquished slot on the generic not_found that a missing route also returns", async () => {
    await relinquishedObject("session-1", "obj-old");
    fetchSpy.mockResolvedValueOnce(jsonResponse({ error: "not_found" }, 404));

    await reconcile(NOW + 2);

    expect(await store.list()).toEqual([
      expect.objectContaining({ modalObjectId: "obj-old", state: "allocated" }),
    ]);
    expect(log.info).not.toHaveBeenCalled();
  });

  it("is idempotent: a freed lease is not looked up again, and a repeated run changes nothing", async () => {
    await lapsedLease("session-1", "sandbox-1");
    fetchSpy.mockResolvedValueOnce(jsonResponse({ outcome: "absent" }));

    await reconcile(PAST_BOUND);
    await reconcile(PAST_BOUND);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await store.list()).toEqual([]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("does not start a second run while one is in flight", async () => {
    await lapsedLease("session-1", "sandbox-1");
    let answer: (response: Response) => void = () => undefined;
    fetchSpy.mockReturnValueOnce(new Promise<Response>((resolve) => (answer = resolve)));

    const first = reconcile(PAST_BOUND);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    await reconcile(PAST_BOUND);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    answer(jsonResponse({ outcome: "absent" }));
    await first;
    expect(await store.list()).toEqual([]);
  });

  it("bounds each executor call by the reconcile deadline, so a silent executor holds the lease without stalling a tick", async () => {
    vi.useFakeTimers();
    await lapsedLease("session-1", "sandbox-1");
    fetchSpy.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        })
    );

    const run = reconcile(PAST_BOUND);
    // The deadline arms once the close is signed and sent, so wait for the request before advancing the clock.
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(RECONCILE_REQUEST_TIMEOUT_MS);
    await run;

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await store.list()).toEqual([expect.objectContaining({ state: "unknown" })]);
  });

  it("logs a misconfigured executor and leaves the slots held, without throwing into the tick", async () => {
    const { identity, operationRef } = leaseFor("session-1", "sandbox-1");
    await gate.claim(identity, operationRef, NOW);
    await gate.begin(identity, NOW);

    await expect(
      reconcileVpsAdmission(
        { SANDBOX_PROVIDER: "vps" } as unknown as Env,
        db,
        LAPSED,
        log as Pick<Logger, "info" | "warn">
      )
    ).resolves.toBeUndefined();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      "VPS admission reconciliation failed",
      expect.objectContaining({ event: "sandbox.admission_reconcile_failed" })
    );
    // Nothing ran, so the lease is not even lapsed: it still holds its slot.
    expect(await store.list()).toEqual([expect.objectContaining({ state: "allocating" })]);
  });
});
