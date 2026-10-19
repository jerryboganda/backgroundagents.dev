import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  AdmissionError,
  parseAdmissionLease,
  verifySignedLease,
  type AdmissionLease,
} from "./admission.ts";
import {
  ContainerNotFoundError,
  IsolationUnavailableError,
  NameHeldError,
  RunNotStartedError,
  RunRejectedByDaemonError,
  SANDBOX_ID_PATTERN,
  type DockerInventory,
  type DockerRuntime,
  type OwnedContainer,
} from "./docker.ts";
import { SessionContextError, sessionContextLine } from "./session-context.ts";
import {
  MAX_ALLOCATED_SANDBOXES,
  sameScope,
  type Admission,
  type AbandonResult,
  type ReleaseStart,
  type SandboxRecord,
  type Settlement,
  type SettlementScope,
  type StateStore,
} from "./state.ts";
import {
  checkSlot,
  prepareHome,
  repairHomeMode,
  repairSlotRoot,
  resetSlot,
  workspaceMount,
  type WorkspaceMount,
} from "./workspace.ts";

const MAX_BODY_BYTES = 16 * 1024;
// A create carries the session environment, so it has a larger bound. The environment's own bounds are in session-context.ts.
const MAX_CREATE_BODY_BYTES = 256 * 1024;
const MAX_TEXT_LENGTH = 256;
// The listing carries full container ids, so only a full id can be proven absent from it.
const FULL_CONTAINER_ID = /^[0-9a-f]{64}$/;

export interface ExecutorServerOptions {
  token: string;
  /** Shared with the control plane; verifies the signature on each admission lease. */
  admissionSecret: string;
  runtime: DockerRuntime;
  store: StateStore;
  /** Directory holding the workspace slots: slot k is `<workspaceRoot>/<k>`. */
  workspaceRoot: string;
  /** The control-plane origin sandboxes call back to, with no trailing slash. A create must name exactly this. */
  controlPlaneUrl: string;
  /** Proves a slot before a sandbox binds it or a release clears it. Defaults to checkSlot. */
  checkWorkspace?: (hostPath: string) => Promise<void>;
  /** Restores a slot root's mode once its identity is proven, before checkWorkspace judges it. Defaults to repairSlotRoot. */
  repairWorkspace?: (hostPath: string) => Promise<void>;
  /** Restores a reattached home's mode once its identity is proven, before prepareHome judges it. Defaults to repairHomeMode. */
  repairHome?: (slotPath: string) => Promise<void>;
  /** Creates and proves a slot's home subdirectory before a sandbox binds it. Defaults to prepareHome. */
  prepareHome?: (slotPath: string) => Promise<void>;
  /** Empties a slot this process holds, once it is proven. Defaults to resetSlot. */
  resetWorkspace?: (hostPath: string) => Promise<void>;
  /** Leases whose create this process is running. Shared with the reconciliation pass, which leaves them alone. */
  inFlight?: Set<string>;
  /**
   * When set, a create refused for want of a workspace slot starts a reclaim at once, so the control plane's retry
   * finds one. The background pass runs the same reclaim on a timer.
   */
  slotReclaim?: SlotReclaimPolicy;
  now?: () => number;
}

/** A refusal the create answers with: the HTTP status and the error code. */
interface Failure {
  status: number;
  error: string;
}

/** The outcome of emptying a slot this process holds. */
type SlotClear = "cleared" | "active" | "unavailable" | "failed";

/** When the janitor frees workspaces nobody is using, so a host never sits full of sessions that did not come back. */
export interface SlotReclaimPolicy {
  /** Keep at least this many slots free by releasing the oldest idle retained workspaces. */
  minFreeSlots: number;
  /** A retained workspace is released early only when its retaining sandbox was created at least this long ago. */
  minAgeMs: number;
}

export interface WorkspaceSweepResult {
  /** Retained workspaces emptied and freed. */
  released: number;
  /** Workspaces that could not be freed this pass. A release that began stays resetting, and the next pass resumes it. */
  failed: number;
}

/** The HTTP server, and the one background operation that needs this server's own workspace-clearing state. */
export type ExecutorServer = Server & {
  /**
   * Releases the workspaces of sessions whose last sandbox was created more than `maxAgeMs` ago, so a session that never
   * comes back does not hold one of the host's six slots for good. Each goes through the same owner release as the
   * release route, with the identity the state holds for it, so nothing frees a workspace a running sandbox uses.
   */
  releaseExpiredWorkspaces(maxAgeMs: number): Promise<WorkspaceSweepResult>;
  /**
   * Frees what no one can use: workspaces no session owns, and resets that stopped half done. Then, while fewer than
   * `policy.minFreeSlots` slots are free, releases the oldest idle retained workspace past `policy.minAgeMs`. A
   * workspace a running container names is never touched.
   */
  reclaimSlots(policy: SlotReclaimPolicy): Promise<WorkspaceSweepResult>;
};

/**
 * HTTP API. Every endpoint except GET /v1/health requires the bearer token. The operator endpoints (abandon,
 * operator-release) act on one sandbox id each, and only when docker shows no container the state cannot account for.
 */
export function createExecutorServer(options: ExecutorServerOptions): ExecutorServer {
  const { token, admissionSecret, runtime, store, workspaceRoot, controlPlaneUrl } = options;
  const checkWorkspace = options.checkWorkspace ?? ((hostPath: string) => checkSlot(hostPath));
  const repairWorkspace =
    options.repairWorkspace ?? ((hostPath: string) => repairSlotRoot(hostPath));
  const repairHome = options.repairHome ?? repairHomeMode;
  const prepare = options.prepareHome ?? prepareHome;
  const resetWorkspace = options.resetWorkspace ?? resetSlot;
  const now = options.now ?? Date.now;
  // Slots this process is clearing. Each is claimed in the state first, so this only stops a second clear in the same process.
  const clearing = new Set<number>();
  // Leases whose create this process is running. A create marked creating outside this set lost its settle write.
  const inFlight = options.inFlight ?? new Set<string>();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";

    if (method === "GET" && pathname === "/v1/health") {
      const ok = await runtime.checkIsolation().then(
        () => true,
        () => false
      );
      sendJson(res, ok ? 200 : 503, { ok });
      return;
    }
    if (!isAuthorized(req, token)) {
      res.setHeader("WWW-Authenticate", "Bearer");
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    if (method === "POST" && pathname === "/v1/sandboxes") return createSandbox(req, res);
    const resolveMatch = /^\/v1\/sandboxes\/([^/]+)$/.exec(pathname);
    if (method === "GET" && resolveMatch) return resolveSandbox(res, resolveMatch[1]);
    const stopMatch = /^\/v1\/sandboxes\/([^/]+)\/stop$/.exec(pathname);
    if (method === "POST" && stopMatch) return stopSandbox(req, res, stopMatch[1]);
    const releaseMatch = /^\/v1\/sandboxes\/([^/]+)\/release$/.exec(pathname);
    if (method === "POST" && releaseMatch) return releaseSandbox(req, res, releaseMatch[1]);
    const sessionReleaseMatch = /^\/v1\/sessions\/([^/]+)\/release-workspaces$/.exec(pathname);
    if (method === "POST" && sessionReleaseMatch)
      return releaseSessionWorkspaces(req, res, decodeURIComponent(sessionReleaseMatch[1]));
    const closeMatch = /^\/v1\/sandboxes\/([^/]+)\/admission\/close$/.exec(pathname);
    if (method === "POST" && closeMatch) return closeAdmission(req, res, closeMatch[1]);
    const abandonMatch = /^\/v1\/sandboxes\/([^/]+)\/abandon$/.exec(pathname);
    if (method === "POST" && abandonMatch) return abandonSandbox(req, res, abandonMatch[1]);
    const operatorMatch = /^\/v1\/sandboxes\/([^/]+)\/operator-release$/.exec(pathname);
    if (method === "POST" && operatorMatch)
      return operatorReleaseSandbox(req, res, operatorMatch[1]);
    sendJson(res, 404, { error: "not_found" });
  }

  /**
   * Create answers. Each code says what the executor proved, so the control plane can tell them apart:
   * - Refused before anything is reserved, so nothing is spent: 403 admission_*, 409 sandbox_id_conflict |
   *   workspace_busy, 503 capacity_exhausted | workspace_capacity_exhausted | isolation_unavailable | state_unavailable.
   * - Reserved, but nothing ran, so the lease is released and may retry: 503 workspace_unavailable (the slot was
   *   refused before it was bound), or 409 workspace_busy (a reattached slot an owned container names). Either is
   *   answered only once the release is recorded; otherwise the create is 503 create_unresolved.
   * - Never started: 502 create_failed when the docker CLI was never spawned. The lease is released, so it may retry,
   *   once that release is recorded; otherwise 503 create_unresolved.
   * - Refused by docker, and no owned container carries the sandbox id: 502 create_failed. The lease and sandbox id are
   *   fenced, so no create under either may run.
   * - Ran, and docker removed the container: 502 runtime_start_failed, when the launch failed. The record is dropped,
   *   not tombstoned, so the same lease may retry. A fresh slot is cleared first, and a reattached one stays with its
   *   owner. 503 state_unavailable, when the start could not be recorded, is released the same way.
   * - Ran, and the removal or its release could not be completed: 503 workspace_unavailable (the slot could not be
   *   cleared) or 503 state_unavailable (the release could not be recorded). The record keeps the removed container's
   *   id, so the lease stays spent until reconciliation settles it, and the slot stays held for its owner.
   * - Undecided, and the lease stays spent: 409 create_in_progress, 503 create_unresolved. Settle these with
   *   admission/close, or an operator abandons one docker shows no container for.
   * - 201 { providerObjectId }: the runtime accepted its session context.
   */
  async function createSandbox(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonObject(req, MAX_CREATE_BODY_BYTES);
    const { sandboxId, sessionId } = body;
    if (typeof sandboxId !== "string" || !SANDBOX_ID_PATTERN.test(sandboxId))
      return sendJson(res, 400, { error: "invalid_sandbox_id" });
    if (
      typeof sessionId !== "string" ||
      sessionId.length === 0 ||
      sessionId.length > MAX_TEXT_LENGTH
    )
      return sendJson(res, 400, { error: "invalid_session_id" });
    let lease: AdmissionLease;
    try {
      lease = parseAdmissionLease(body.admissionLease, {
        secret: admissionSecret,
        sessionId,
        sandboxId,
        nowMs: now(),
      });
    } catch (error) {
      if (error instanceof AdmissionError)
        return sendJson(res, 403, { error: `admission_${error.failure}` });
      throw error;
    }
    const { leaseToken } = lease;
    // Judged before anything is reserved, so a context the runtime cannot take spends no lease and starts nothing.
    let sessionContext: string;
    try {
      sessionContext = sessionContextLine(body.runtimeContext, {
        sandboxId,
        sessionId,
        controlPlaneUrl,
      });
    } catch (error) {
      if (error instanceof SessionContextError)
        return sendJson(res, error.status, { error: error.code });
      throw error;
    }

    const known = store.byLease(leaseToken);
    if (known) return answerKnown(res, known, sessionId, sandboxId);
    // A settled lease or sandbox id is refused before anything runs. The admit transaction refuses it too.
    if (store.settledFor(leaseToken, sandboxId))
      return sendJson(res, 403, { error: "admission_expired" });
    // Checked before anything is reserved, so a create the runtime cannot run does not spend its lease.
    if (!(await isolationReady(res))) return;
    // Every judgement of the cap follows a fresh pass, so a container docker holds that the state does not show is counted.
    // A failed pass refuses the create even after an earlier pass succeeded: the cap is never judged on stale state.
    try {
      await reconcileNow();
    } catch (error) {
      reportError("reconciliation failed", error);
      return sendJson(res, 503, { error: "state_unavailable" });
    }

    const record: SandboxRecord = {
      leaseToken,
      sessionId,
      sandboxId,
      status: "creating",
      providerObjectId: null,
      createdAtMs: now(),
    };
    let admission: Admission;
    try {
      // One write transaction, shared with every other process: the lease, the sandbox id and the cap are judged, and the reservation is durable, before docker runs.
      admission = store.admit(
        record,
        MAX_ALLOCATED_SANDBOXES,
        () => now() < lease.expiresAtMs,
        body.restoreWorkspace === true
      );
    } catch (error) {
      reportError("could not record a reservation", error);
      return sendJson(res, 503, { error: "state_unavailable" });
    }
    switch (admission.kind) {
      case "reserved":
        // Marked in flight in the same synchronous step as the reservation, so no settling pass runs between the two.
        inFlight.add(record.leaseToken);
        try {
          return await runAllocation(
            res,
            record,
            admission.workspaceSlot,
            sessionContext,
            admission.reattached
          );
        } finally {
          inFlight.delete(record.leaseToken);
        }
      case "known":
        return answerKnown(res, admission.record, sessionId, sandboxId);
      case "settled":
      case "expired":
        return sendJson(res, 403, { error: "admission_expired" });
      case "sandbox_held":
        return sendJson(res, 409, { error: "sandbox_id_conflict" });
      case "workspace_busy":
        return sendJson(res, 409, { error: "workspace_busy" });
      case "workspace_not_retained":
        return sendJson(res, 409, { error: "workspace_not_retained" });
      case "full":
        return sendJson(res, 503, { error: "capacity_exhausted" });
      case "workspace_full":
        // Reclaim in the background so the control plane's retry of this create finds a free slot.
        if (options.slotReclaim)
          reclaimSlots(options.slotReclaim).catch((error: unknown) =>
            reportError("slot reclaim failed", error)
          );
        return sendJson(res, 503, { error: "workspace_capacity_exhausted" });
    }
  }

  /** A lease the executor already spent answers from its record. Only its own session and sandbox may retry it. */
  async function answerKnown(
    res: ServerResponse,
    record: SandboxRecord,
    sessionId: string,
    sandboxId: string
  ): Promise<void> {
    // A stopped allocation spends its lease for good, and any other binding of the token is a replay.
    if (
      record.sessionId !== sessionId ||
      record.sandboxId !== sandboxId ||
      record.status === "terminated"
    )
      return sendJson(res, 403, { error: "admission_replayed" });
    if (record.status === "running")
      return sendJson(res, 200, { providerObjectId: record.providerObjectId });
    // A create this process still runs is undecided. A creating record it no longer runs lost its settle write, so the pass below settles it.
    if (record.status === "creating" && inFlight.has(record.leaseToken))
      return sendJson(res, 409, { error: "create_in_progress" });

    // Unresolved: this lease never runs docker again. A container attached to it is not running, since its runtime
    // was never acknowledged here, so the retry is answered as undecided until the container is stopped or abandoned.
    await reconcileNow().catch((error: unknown) => reportError("reconciliation failed", error));
    const current = store.byLease(record.leaseToken);
    if (current?.status === "running")
      return sendJson(res, 200, { providerObjectId: current.providerObjectId });
    return sendJson(res, 503, { error: "create_unresolved" });
  }

  /**
   * Proves the record's workspace slot and its home, then starts a holding container, launches the runtime in it, and
   * records the id docker answered with once the runtime has accepted its session context.
   */
  async function runAllocation(
    res: ServerResponse,
    record: SandboxRecord,
    workspaceSlot: number,
    sessionContext: string,
    reattached: boolean
  ): Promise<void> {
    const mount = workspaceMount(workspaceRoot, workspaceSlot);
    const refusal = await proveSlot(record.sandboxId, mount, reattached);
    if (refusal) {
      // Nothing ran, so the lease and the workspace go back to how they were. The refusal is answered only once that
      // release is recorded. Otherwise the create stays held and is answered as undecided.
      if (freeRefused(record.leaseToken))
        return sendJson(res, refusal.status, { error: refusal.error });
      settle(() => store.markUnresolved(record.leaseToken));
      return sendJson(res, 503, { error: "create_unresolved" });
    }
    const providerObjectId = await startContainer(res, record, mount);
    if (providerObjectId === undefined) return;
    try {
      // The runtime is launched in the holding container. A failed launch, refused or unknown, settles the container
      // before anything is released: until docker proves it gone, the container slot and the workspace stay held.
      await runtime.launchRuntime(providerObjectId, sessionContext);
    } catch (error) {
      reportError("runtime launch failed", error);
      const failure = await unwindStarted(record, mount, providerObjectId, reattached, {
        status: 502,
        error: "runtime_start_failed",
      });
      return sendJson(res, failure.status, { error: failure.error });
    }
    try {
      // The answer waits on the durable record, so a container the state does not show is never reported.
      store.markRunning(record.leaseToken, providerObjectId);
    } catch (error) {
      reportError("could not record a started container", error);
      const failure = await unwindStarted(record, mount, providerObjectId, reattached, {
        status: 503,
        error: "state_unavailable",
      });
      return sendJson(res, failure.status, { error: failure.error });
    }
    // Whether the sandbox runs on the session's retained workspace. A restore that did not reattach starts empty.
    sendJson(res, 201, { providerObjectId, reattached });
  }

  /**
   * Proves the slot and its home before a bind. A reattached slot's modes are repaired first, and only once no owned
   * container names it, so a sandbox that changed a mode keeps its retained data. Returns the refusal, or undefined once proven.
   */
  async function proveSlot(
    sandboxId: string,
    mount: WorkspaceMount,
    reattached: boolean
  ): Promise<Failure | undefined> {
    try {
      if (reattached) {
        if (await namedByOwned(sandboxId, mount.slot))
          return { status: 409, error: "workspace_busy" };
        await repairWorkspace(mount.hostPath);
        await repairHome(mount.hostPath);
      }
      await checkWorkspace(mount.hostPath);
      await prepare(mount.hostPath);
      return undefined;
    } catch (error) {
      reportError("workspace slot refused", error);
      return { status: 503, error: "workspace_unavailable" };
    }
  }

  /** True when a fresh owned inventory names the slot or the sandbox id. Throws when docker cannot list. */
  async function namedByOwned(sandboxId: string, workspaceSlot: number): Promise<boolean> {
    const inventory = await runtime.inventory();
    return inventory.owned.some(
      (container) => container.workspaceSlot === workspaceSlot || container.sandboxId === sandboxId
    );
  }

  /**
   * Empties a slot this process holds. Nothing is emptied while an owned container names the slot or its sandbox id. The
   * root is repaired and proven before the walk, so a sandbox that changed its mode does not refuse the clear. Throws when
   * docker cannot list.
   */
  async function emptyHeldSlot(sandboxId: string, workspaceSlot: number): Promise<SlotClear> {
    if (await namedByOwned(sandboxId, workspaceSlot)) return "active";
    const mount = workspaceMount(workspaceRoot, workspaceSlot);
    try {
      await repairWorkspace(mount.hostPath);
      await checkWorkspace(mount.hostPath);
    } catch (error) {
      reportError("workspace slot refused", error);
      return "unavailable";
    }
    try {
      await resetWorkspace(mount.hostPath);
    } catch (error) {
      reportError("workspace reset failed", error);
      return "failed";
    }
    return "cleared";
  }

  /**
   * Settles a create whose container ran, once its runtime failed or its record could not be written. The container is
   * removed first, and only a removal docker proves releases the create. A container that is not removed keeps its id in the
   * record, so its slot stays held and only a stop removes it. Returns the failure the create answers with.
   */
  async function unwindStarted(
    record: SandboxRecord,
    mount: WorkspaceMount,
    containerId: string,
    reattached: boolean,
    failure: Failure
  ): Promise<Failure> {
    if (!(await removedOrAbsent(() => runtime.removeSandbox(containerId)))) {
      // The container keeps its id in the record, so it is accounted for, and only a stop removes it.
      settle(() => store.markUnresolved(record.leaseToken, containerId));
      return { status: 503, error: "create_unresolved" };
    }
    return (await releaseRemoved(record, mount, containerId, reattached)) ?? failure;
  }

  /**
   * Releases a create whose container docker has removed. A fresh claim is cleared before it is freed, so the next tenant
   * never binds data a container wrote. A reattached claim stays retained for its owner, as it was. When the slot cannot be
   * cleared, or the release cannot be recorded, the record keeps the removed container's id, so reconciliation retains the
   * slot for its owner. Returns the failure when the create was not released, or undefined once it was.
   */
  async function releaseRemoved(
    record: SandboxRecord,
    mount: WorkspaceMount,
    containerId: string,
    reattached: boolean
  ): Promise<Failure | undefined> {
    if (!reattached) {
      let cleared = false;
      try {
        cleared = (await emptyHeldSlot(record.sandboxId, mount.slot)) === "cleared";
      } catch (error) {
        reportError("could not list containers", error);
      }
      if (!cleared) {
        settle(() => store.markUnresolved(record.leaseToken, containerId));
        return { status: 503, error: "workspace_unavailable" };
      }
    }
    try {
      if (store.forgetRemoved(record.leaseToken, containerId)) return undefined;
    } catch (error) {
      reportError("could not release a removed create", error);
    }
    settle(() => store.markUnresolved(record.leaseToken, containerId));
    return { status: 503, error: "state_unavailable" };
  }

  /** Runs the container. On failure, settles the record and answers, and returns undefined. */
  async function startContainer(
    res: ServerResponse,
    record: SandboxRecord,
    mount: WorkspaceMount
  ): Promise<string | undefined> {
    try {
      return await runtime.runSandbox(record.sandboxId, mount);
    } catch (error) {
      // The CLI was never spawned, so nothing was sent. The lease is released only once that is recorded. Otherwise the
      // create falls through to the undecided answer below.
      if (error instanceof RunNotStartedError && freeRefused(record.leaseToken)) {
        sendJson(res, 502, { error: "create_failed" });
        return undefined;
      }
      // docker refused the create with its own error, so nothing was created by that run. A container under the sandbox's
      // name may still exist, though, so the owned inventory decides: absent frees the slot, fenced, so no later create
      // can run under this lease or sandbox id. Anything else holds the slot.
      if (
        error instanceof RunRejectedByDaemonError &&
        (await ownedAbsent(record.sandboxId)) &&
        freeRefused(record.leaseToken, now())
      ) {
        sendJson(res, 502, { error: "create_failed" });
        return undefined;
      }
      // Any other failure may have reached the daemon, so a container may exist now or appear later. The slot stays
      // held, and only reconciliation or an abandon settles it. Nothing is removed or released by name: an absent
      // name proves nothing about a create still on its way.
      settle(() => store.markUnresolved(record.leaseToken));
      sendJson(res, 503, { error: "create_unresolved" });
      return undefined;
    }
  }

  /** True when a fresh owned inventory shows no container under the sandbox id. An inventory that cannot be read proves nothing. */
  async function ownedAbsent(sandboxId: string): Promise<boolean> {
    try {
      const inventory = await runtime.inventory();
      return !inventory.owned.some((container) => container.sandboxId === sandboxId);
    } catch (error) {
      reportError("could not list containers", error);
      return false;
    }
  }

  /**
   * Frees a create that holds no container. With `fencedAtMs`, its lease and sandbox id are closed in the same write that
   * frees the slot. Returns false when that write fails or frees nothing, so the create stays held and is answered as
   * undecided.
   */
  function freeRefused(leaseToken: string, fencedAtMs?: number): boolean {
    try {
      return store.forget(leaseToken, fencedAtMs);
    } catch (error) {
      reportError("could not free a refused create", error);
      return false;
    }
  }

  /** A state write the response does not wait on. A failed write is reported, and reconciliation repairs what it leaves behind. */
  function settle(write: () => unknown): void {
    try {
      write();
    } catch (error) {
      reportError("state write failed", error);
    }
  }

  /** Sends the refusal and returns false when docker has no gVisor runtime. */
  async function isolationReady(res: ServerResponse): Promise<boolean> {
    try {
      await runtime.checkIsolation();
      return true;
    } catch (error) {
      if (!(error instanceof IsolationUnavailableError)) throw error;
      sendJson(res, 503, { error: "isolation_unavailable" });
      return false;
    }
  }

  /** One fresh reconciliation pass. Throws when docker cannot be listed. */
  async function reconcileNow(): Promise<void> {
    await reconcileContainers(store, runtime, now, inFlight);
  }

  /** The container a sandbox is running in. Only a running record is an answer, and an unplaced sandbox is undecided, not absent. */
  function resolveSandbox(res: ServerResponse, sandboxId: string): void {
    const record = store.holding(sandboxId);
    if (!record) {
      if (store.unplacedHolds(sandboxId))
        return sendJson(res, 503, { error: "container_unaccounted" });
      return sendJson(res, 404, { error: "not_found" });
    }
    // Only a running record is an answer. A create that has not settled may still have a container,
    // so it must not read as absent.
    if (record.status !== "running") return sendJson(res, 503, { error: "create_unresolved" });
    sendJson(res, 200, { sandboxId: record.sandboxId, providerObjectId: record.providerObjectId });
  }

  /**
   * Stops a container by id. A container the state accounts for (running, or unresolved with its id) is removed and
   * then terminated. An unplaced one is removed and its row dropped. Any other id is judged by judgeUnknownStop, and
   * nothing is removed for it. A container docker reports gone at the removal is also 404 sandbox_not_found. The
   * router's own 404 is not_found, which proves nothing, so the control plane must not read it as stopped.
   */
  async function stopSandbox(
    req: IncomingMessage,
    res: ServerResponse,
    providerObjectId: string
  ): Promise<void> {
    const body = await readJsonObject(req);
    if (typeof body.reason !== "string" || body.reason.length > MAX_TEXT_LENGTH)
      return sendJson(res, 400, { error: "invalid_reason" });
    const record = store.byContainer(providerObjectId);
    const unplaced = record === undefined && store.isUnplaced(providerObjectId);
    if (!record && !unplaced) return judgeUnknownStop(res, providerObjectId);
    let alreadyGone = false;
    try {
      await runtime.removeSandbox(providerObjectId);
    } catch (error) {
      if (!(error instanceof ContainerNotFoundError))
        return sendJson(res, 502, { error: "stop_failed" });
      alreadyGone = true;
    }
    // Absence is verified, so the slot is free. The tombstone keeps the lease spent. If this write
    // fails, reconciliation sees the id gone and frees the slot then.
    if (record) settle(() => store.terminate(record.leaseToken, providerObjectId));
    else settle(() => store.dropUnplaced(providerObjectId));
    // Docker has no such container, so it is verified absent. Answered as a missing target, not as a route.
    if (alreadyGone) return sendJson(res, 404, { error: "sandbox_not_found" });
    sendJson(res, 200, { stopped: true });
  }

  /**
   * Judges a stop of an id the state does not hold, and removes nothing. An id the state removed (retired, or named by a
   * terminated record) is gone: 404 sandbox_not_found, without asking docker. A partial id or a name cannot be proven
   * absent, so it is 409 container_unaccounted. Any other id is judged by a fresh listing: one the listing lacks is absent,
   * 404 sandbox_not_found; one it shows is not this executor's to remove here, 409 container_unaccounted. A listing that
   * cannot be read is 503 runtime_unavailable.
   */
  async function judgeUnknownStop(res: ServerResponse, containerId: string): Promise<void> {
    if (store.removedContainer(containerId))
      return sendJson(res, 404, { error: "sandbox_not_found" });
    if (!FULL_CONTAINER_ID.test(containerId))
      return sendJson(res, 409, { error: "container_unaccounted" });
    let inventory: DockerInventory;
    try {
      inventory = await runtime.inventory();
    } catch (error) {
      reportError("could not list containers", error);
      return sendJson(res, 503, { error: "runtime_unavailable" });
    }
    if (inventory.containerIds.has(containerId))
      return sendJson(res, 409, { error: "container_unaccounted" });
    return sendJson(res, 404, { error: "sandbox_not_found" });
  }

  /**
   * Clears a stopped sandbox's workspace so another sandbox can bind its slot. Only the session that owns
   * the workspace, naming the lease that retained it, may release it, and only while no container uses the
   * slot. Once a release starts, nothing binds the slot, and a failed release is retried by repeating it.
   */
  async function releaseSandbox(
    req: IncomingMessage,
    res: ServerResponse,
    sandboxId: string
  ): Promise<void> {
    if (!SANDBOX_ID_PATTERN.test(sandboxId))
      return sendJson(res, 400, { error: "invalid_sandbox_id" });
    const body = await readJsonObject(req);
    const { sessionId, leaseToken } = body;
    if (
      typeof sessionId !== "string" ||
      sessionId.length === 0 ||
      sessionId.length > MAX_TEXT_LENGTH
    )
      return sendJson(res, 400, { error: "invalid_session_id" });
    if (
      typeof leaseToken !== "string" ||
      leaseToken.length === 0 ||
      leaseToken.length > MAX_TEXT_LENGTH
    )
      return sendJson(res, 400, { error: "invalid_lease_token" });

    let start: ReleaseStart;
    try {
      start = store.beginRelease(sandboxId, sessionId, leaseToken);
    } catch (error) {
      reportError("could not start a release", error);
      return sendJson(res, 503, { error: "state_unavailable" });
    }
    if (start.kind === "not_found") return sendJson(res, 404, { error: "not_found" });
    if (start.kind === "refused") return sendJson(res, 409, { error: "release_refused" });
    if (start.kind === "active") return sendJson(res, 409, { error: "workspace_active" });
    return clearWorkspace(res, sandboxId, start.workspaceSlot);
  }

  /**
   * Clears a workspace no session owns: one adopted from a container, once that container is gone. An explicit
   * operator request, bounded to the one sandbox id it names. Owned workspaces are released only by their owner.
   */
  async function operatorReleaseSandbox(
    req: IncomingMessage,
    res: ServerResponse,
    sandboxId: string
  ): Promise<void> {
    if (!SANDBOX_ID_PATTERN.test(sandboxId))
      return sendJson(res, 400, { error: "invalid_sandbox_id" });
    const body = await readJsonObject(req);
    if (typeof body.reason !== "string" || body.reason.length > MAX_TEXT_LENGTH)
      return sendJson(res, 400, { error: "invalid_reason" });
    let start: ReleaseStart;
    try {
      start = store.beginOperatorRelease(sandboxId);
    } catch (error) {
      reportError("could not start a release", error);
      return sendJson(res, 503, { error: "state_unavailable" });
    }
    if (start.kind === "not_found") return sendJson(res, 404, { error: "not_found" });
    if (start.kind === "refused") return sendJson(res, 409, { error: "release_refused" });
    if (start.kind === "active") return sendJson(res, 409, { error: "workspace_active" });
    return clearWorkspace(res, sandboxId, start.workspaceSlot);
  }

  /**
   * Releases every workspace a deleted session still has retained, so its data is gone and its slots are free. A
   * workspace a running container still names is left (the caller stops the sandbox first) and counted in
   * `remaining`, as is one whose clear failed; repeating the call finishes it. Answers 200 with the counts.
   */
  async function releaseSessionWorkspaces(
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string
  ): Promise<void> {
    if (sessionId.length === 0 || sessionId.length > MAX_TEXT_LENGTH)
      return sendJson(res, 400, { error: "invalid_session_id" });
    const body = await readJsonObject(req);
    if (typeof body.reason !== "string" || body.reason.length > MAX_TEXT_LENGTH)
      return sendJson(res, 400, { error: "invalid_reason" });
    const result: WorkspaceSweepResult = { released: 0, failed: 0 };
    let held: ReturnType<StateStore["evictableWorkspaces"]>;
    try {
      held = store.evictableWorkspaces(Number.MAX_SAFE_INTEGER).filter((w) => w.sessionId === sessionId);
    } catch (error) {
      reportError("could not list a session's workspaces", error);
      return sendJson(res, 503, { error: "state_unavailable" });
    }
    for (const workspace of held)
      await releaseWorkspace(workspace, workspace, result, "its session was deleted");
    const remaining = held.length - result.released;
    return sendJson(res, 200, { released: result.released, remaining });
  }

  /**
   * Clears a slot already claimed for reset. The slot frees only after docker shows no owned container that names it or
   * its sandbox id, the identity is proven, the root mode is repaired, and the contents are removed. A failure leaves the
   * slot resetting, and repeating the release resumes it. A repeat that arrives while this process is still clearing the
   * slot answers 409 release_in_progress, and runs nothing beside the clear.
   */
  async function clearWorkspace(
    res: ServerResponse,
    sandboxId: string,
    workspaceSlot: number
  ): Promise<void> {
    // One clear of a slot runs at a time in this process. A repeat that arrives meanwhile is answered, not run beside it.
    if (clearing.has(workspaceSlot)) return sendJson(res, 409, { error: "release_in_progress" });
    clearing.add(workspaceSlot);
    try {
      return await clearClaimedSlot(res, sandboxId, workspaceSlot);
    } finally {
      clearing.delete(workspaceSlot);
    }
  }

  /** The clear itself, once this process holds the slot. */
  async function clearClaimedSlot(
    res: ServerResponse,
    sandboxId: string,
    workspaceSlot: number
  ): Promise<void> {
    let outcome: SlotClear;
    try {
      outcome = await emptyHeldSlot(sandboxId, workspaceSlot);
    } catch (error) {
      reportError("could not list containers", error);
      return sendJson(res, 503, { error: "state_unavailable" });
    }
    // A container that names this slot or this sandbox may still use the data, so nothing is cleared.
    if (outcome === "active") return sendJson(res, 409, { error: "workspace_active" });
    if (outcome === "unavailable") return sendJson(res, 503, { error: "workspace_unavailable" });
    if (outcome === "failed") return sendJson(res, 500, { error: "reset_failed" });
    try {
      store.finishRelease(workspaceSlot);
    } catch (error) {
      reportError("could not finish a release", error);
      return sendJson(res, 503, { error: "state_unavailable" });
    }
    sendJson(res, 200, { released: true });
  }

  /**
   * Closes an unresolved create that docker shows no container for. An operator request, which changes nothing while
   * a container exists under the sandbox id. The sandbox's name is fenced first: a never-started container holds it, so
   * a create docker still has in flight is refused rather than run. Only then are the lease and sandbox id tombstoned and
   * the container slot freed. The workspace stays retained for its owner until a release clears it. A fence that
   * conflicts or has no verified outcome holds the create, so nothing is freed.
   */
  async function abandonSandbox(
    req: IncomingMessage,
    res: ServerResponse,
    sandboxId: string
  ): Promise<void> {
    if (!SANDBOX_ID_PATTERN.test(sandboxId))
      return sendJson(res, 400, { error: "invalid_sandbox_id" });
    const body = await readJsonObject(req);
    if (typeof body.reason !== "string" || body.reason.length > MAX_TEXT_LENGTH)
      return sendJson(res, 400, { error: "invalid_reason" });
    let inventory: DockerInventory;
    try {
      inventory = await runtime.inventory();
    } catch (error) {
      reportError("could not list containers", error);
      return sendJson(res, 503, { error: "runtime_unavailable" });
    }
    if (inventory.owned.some((container) => container.sandboxId === sandboxId))
      return sendJson(res, 409, { error: "container_present" });
    // Judged before the fence, so an abandon that will be refused places nothing.
    let held: SandboxRecord | undefined;
    try {
      // A create this process no longer runs is settled first, so an abandon can close it.
      store.unresolveOrphans(inFlight);
      held = store.holding(sandboxId);
    } catch (error) {
      reportError("could not read a create", error);
      return sendJson(res, 503, { error: "state_unavailable" });
    }
    if (held === undefined) return sendJson(res, 404, { error: "not_found" });
    if (held.status === "creating") return sendJson(res, 409, { error: "create_in_progress" });
    if (held.providerObjectId !== null) return sendJson(res, 409, { error: "container_present" });
    // The name is fenced before the tombstone, so a create docker still holds cannot run once the slot is freed.
    if (!(await fenceName(res, sandboxId))) return;
    let outcome: AbandonResult;
    try {
      outcome = store.abandon(sandboxId, now());
    } catch (error) {
      reportError("could not abandon a create", error);
      return sendJson(res, 503, { error: "state_unavailable" });
    }
    switch (outcome.kind) {
      case "abandoned":
        return sendJson(res, 200, { abandoned: true });
      case "not_found":
        return sendJson(res, 404, { error: "not_found" });
      case "creating":
        return sendJson(res, 409, { error: "create_in_progress" });
      case "container_known":
        return sendJson(res, 409, { error: "container_present" });
    }
  }

  /**
   * Places the sandbox's fence, and answers when it cannot. Returns true once the name is fenced. A name another container
   * holds stays held: a late create that landed is owned, and its own answer is container_present. Any other fence whose
   * outcome is unproven is undecided, so the create stays held.
   */
  async function fenceName(res: ServerResponse, sandboxId: string): Promise<boolean> {
    try {
      await runtime.fenceSandbox(sandboxId);
      return true;
    } catch (error) {
      if (!(error instanceof NameHeldError)) {
        reportError("could not fence a sandbox name", error);
        sendJson(res, 503, { error: "runtime_unavailable" });
        return false;
      }
      let inventory: DockerInventory;
      try {
        inventory = await runtime.inventory();
      } catch (listError) {
        reportError("could not list containers", listError);
        sendJson(res, 503, { error: "runtime_unavailable" });
        return false;
      }
      if (inventory.owned.some((container) => container.sandboxId === sandboxId))
        sendJson(res, 409, { error: "container_present" });
      else sendJson(res, 503, { error: "container_unaccounted" });
      return false;
    }
  }

  /**
   * Settles a lease from the signed proof the control plane holds for it. Wire contract, which the control plane's
   * closeAdmission must send:
   *   POST /v1/sandboxes/{sandboxId}/admission/close
   *   body { sessionId, admissionLease: { leaseToken, expiresAtMs, signature } }, the lease a create carried
   *   The signature is HMAC-SHA256 over the create's canonical payload. Expiry is not checked: a lapsed proof
   *   settles and never creates.
   *   200 { outcome: "absent" }: final. The lease and its sandbox id are tombstoned before this is sent.
   *   200 { outcome: "present", providerObjectId }: the lease's own container, to be stopped. It may be unacknowledged.
   *   Anything else is undecided: 403 admission_missing | admission_invalid | admission_replayed, 409
   *   create_in_progress | sandbox_held, 503 create_unresolved | container_unaccounted | runtime_unavailable |
   *   state_unavailable.
   */
  async function closeAdmission(
    req: IncomingMessage,
    res: ServerResponse,
    sandboxId: string
  ): Promise<void> {
    if (!SANDBOX_ID_PATTERN.test(sandboxId))
      return sendJson(res, 400, { error: "invalid_sandbox_id" });
    const body = await readJsonObject(req);
    const { sessionId } = body;
    if (
      typeof sessionId !== "string" ||
      sessionId.length === 0 ||
      sessionId.length > MAX_TEXT_LENGTH
    )
      return sendJson(res, 400, { error: "invalid_session_id" });
    let leaseToken: string;
    try {
      ({ leaseToken } = verifySignedLease(body.admissionLease, {
        secret: admissionSecret,
        sessionId,
        sandboxId,
      }));
    } catch (error) {
      if (error instanceof AdmissionError)
        return sendJson(res, 403, { error: `admission_${error.failure}` });
      throw error;
    }
    let answer: Answer;
    try {
      answer = await judgeSettlement({ leaseToken, sessionId, sandboxId });
    } catch (error) {
      reportError("could not settle a lease", error);
      return sendJson(res, 503, { error: "state_unavailable" });
    }
    sendJson(res, answer.status, answer.body);
  }

  /**
   * Judges a settlement. Only "absent" is final, and it is written as a tombstone before it is answered. Absence is
   * judged by docker as well as the state: a create without its container is settled only by an owned inventory that
   * shows no container under its sandbox id.
   */
  async function judgeSettlement(scope: SettlementScope): Promise<Answer> {
    let found = store.settlementOf(scope);
    if (
      found.kind === "record" &&
      (found.record.status === "creating" ||
        (found.record.status === "unresolved" && found.record.providerObjectId === null))
    ) {
      await reconcileNow().catch((error: unknown) => reportError("reconciliation failed", error));
      found = store.settlementOf(scope);
    }
    const absentByState =
      found.kind === "free" ||
      found.kind === "settled" ||
      (found.kind === "record" && found.record.status === "terminated");
    if (absentByState) {
      let inventory: DockerInventory;
      try {
        inventory = await runtime.inventory();
      } catch (error) {
        reportError("could not list containers", error);
        return errorAnswer(503, "runtime_unavailable");
      }
      if (inventory.owned.some((container) => container.sandboxId === scope.sandboxId))
        return errorAnswer(503, "container_unaccounted");
    }
    if (found.kind === "free" || (found.kind === "record" && found.record.status === "terminated"))
      found = store.settle(scope, now());
    return settlementAnswer(found, scope);
  }

  /**
   * Releases one retained workspace through the same fenced start as the release route. `owner` is the identity of a
   * session-owned workspace; without it the workspace has no owner and the operator release starts it.
   */
  async function releaseWorkspace(
    held: { workspaceSlot: number; sandboxId: string },
    owner: { sessionId: string; leaseToken: string } | undefined,
    result: WorkspaceSweepResult,
    why: string
  ): Promise<boolean> {
    const { workspaceSlot, sandboxId } = held;
    // One clear of a slot runs at a time in this process, and a release route call may be clearing this one.
    if (clearing.has(workspaceSlot)) return false;
    clearing.add(workspaceSlot);
    try {
      // A container that still names the slot means the session came back, so the workspace is not stale.
      if (await namedByOwned(sandboxId, workspaceSlot)) return false;
      // The owner's own identity fences the release, as in the route. Anything but a start is not ours to clear.
      const start =
        owner === undefined
          ? store.beginOperatorRelease(sandboxId)
          : store.beginRelease(sandboxId, owner.sessionId, owner.leaseToken);
      if (start.kind !== "started") return false;
      const outcome = await emptyHeldSlot(sandboxId, workspaceSlot);
      if (outcome === "cleared" && store.finishRelease(workspaceSlot)) {
        result.released += 1;
        console.log(
          `vps-executor: released the workspace of sandbox ${sandboxId} from slot ${workspaceSlot}; ${why}`
        );
        return true;
      }
      if (outcome !== "active") result.failed += 1;
      return false;
    } catch (error) {
      result.failed += 1;
      reportError("could not release a workspace", error);
      return false;
    } finally {
      clearing.delete(workspaceSlot);
    }
  }

  async function releaseExpiredWorkspaces(maxAgeMs: number): Promise<WorkspaceSweepResult> {
    const result: WorkspaceSweepResult = { released: 0, failed: 0 };
    for (const held of store.expiredRetained(now() - maxAgeMs))
      await releaseWorkspace(held, held, result, "its session did not return");
    return result;
  }

  let reclaiming: Promise<WorkspaceSweepResult> | undefined;

  /** One reclaim at a time: a second caller shares the pass already running. */
  function reclaimSlots(policy: SlotReclaimPolicy): Promise<WorkspaceSweepResult> {
    reclaiming ??= runReclaim(policy).finally(() => {
      reclaiming = undefined;
    });
    return reclaiming;
  }

  async function runReclaim(policy: SlotReclaimPolicy): Promise<WorkspaceSweepResult> {
    const result: WorkspaceSweepResult = { released: 0, failed: 0 };
    // No session can restore these and no lease can release them, so they only ever leave through here.
    for (const orphan of store.unownedWorkspaces())
      await releaseWorkspace(orphan, undefined, result, "no session owns it");
    // Under pressure the oldest idle workspace goes first. A reset that began and stopped is finished first.
    if (store.freeSlots() >= policy.minFreeSlots) return result;
    for (const held of store.evictableWorkspaces(now() - policy.minAgeMs)) {
      if (store.freeSlots() >= policy.minFreeSlots) break;
      await releaseWorkspace(held, held, result, "the host needed the slot for a new session");
    }
    return result;
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (error instanceof RequestError) return sendJson(res, error.status, { error: error.code });
      reportError("request failed", error);
      if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
    });
  });
  return Object.assign(server, { releaseExpiredWorkspaces, reclaimSlots });
}

export interface ReconcileResult {
  /** Records whose container docker no longer has. Their container slots are free. */
  freed: number;
  /** Unresolved creates that took the container docker shows under their sandbox id. The container is not running. */
  attached: number;
  /** Owned containers that no live record accounted for, adopted as unacknowledged records in the slot they name. */
  adopted: number;
  /** Unresolved creates still waiting on a container, or on an abandon. */
  unresolved: number;
}

/**
 * Brings the state in line with docker. Nothing is removed here.
 * - A record with a container ends only when docker no longer has that container id. A name that is absent
 *   proves nothing, so the id is the test.
 * - An unresolved create without a container takes the owned container that carries its sandbox id, in the slot the
 *   create reserved. The runtime never acknowledged that container here, so the record stays unresolved, and only a
 *   stop or an abandon settles it. A late create is never run a second time.
 * - An owned container that no live record accounts for is adopted into a free slot, or one no session owns. It is
 *   adopted unacknowledged too: nothing here shows its runtime started.
 * - Every other owned container counts toward the cap as unplaced, and its sandbox id stays closed to creates, until
 *   docker removes it or an authorized stop does. That covers a container with no valid slot label, a closed sandbox
 *   id, and a slot another owner holds.
 * - A container id the state retires, or any record names, is never adopted or attached: the listing predates its
 *   removal. It counts toward the cap as unplaced until a later listing lacks it.
 * - A fence is never owned, so it is never adopted or counted. It only holds its sandbox id's name.
 * - With `inFlight`, each creating record outside that set is first made unresolved: its settle write failed, and no
 *   request runs it.
 * Containers without this executor's labels are never read as owned or touched. Throws, with no change made, when
 * docker cannot be listed.
 */
export async function reconcileContainers(
  store: StateStore,
  runtime: DockerRuntime,
  now: () => number = Date.now,
  inFlight?: ReadonlySet<string>
): Promise<ReconcileResult> {
  // A create no request of this process runs lost its settle write. It becomes unresolved before the records are read.
  if (inFlight !== undefined) store.unresolveOrphans(inFlight);
  // Records are read before docker is asked. A container a record names was created before that read, so the later
  // listing lacks it only if docker removed it. Unplaced rows follow the same rule.
  const snapshot = store.slotHolders();
  const unplacedSnapshot = store.unplacedIds();
  const inventory = await runtime.inventory();
  const result: ReconcileResult = { freed: 0, attached: 0, adopted: 0, unresolved: 0 };
  const wasUnplaced = new Set(unplacedSnapshot);
  // Counts an owned container toward the cap, and logs why it is not placed.
  const unplace = (container: OwnedContainer, reason: string): void => {
    store.syncUnplaced(
      [],
      [{ containerId: container.containerId, sandboxId: container.sandboxId }]
    );
    console.error(
      `vps-executor: owned container for sandbox ${container.sandboxId} ${reason}; it counts toward the cap until docker removes it`
    );
  };
  // Drops the unplaced row of a container that is now accounted for.
  const release = (containerId: string): void => {
    if (wasUnplaced.has(containerId)) store.syncUnplaced([containerId], []);
  };
  store.syncUnplaced(
    unplacedSnapshot.filter((containerId) => !inventory.containerIds.has(containerId)),
    []
  );

  for (const record of snapshot) {
    // A create still in flight has no container the state holds yet. Its own request settles what docker made.
    if (record.providerObjectId === null || record.status === "creating") continue;
    if (inventory.containerIds.has(record.providerObjectId)) continue;
    if (store.terminate(record.leaseToken, record.providerObjectId)) {
      result.freed += 1;
      console.log(`vps-executor: container for sandbox ${record.sandboxId} is gone; slot freed`);
    }
  }

  for (const container of inventory.owned) {
    const { containerId, sandboxId, workspaceSlot } = container;
    if (workspaceSlot === null) {
      unplace(container, "names no workspace slot");
      continue;
    }
    const holder = store.holding(sandboxId);
    // A listing taken before a removal can still show the container, so a retired id is never adopted or attached.
    if (holder?.providerObjectId !== containerId && store.retiredContainer(containerId)) {
      unplace(container, "was removed while this listing was taken");
      continue;
    }
    if (holder === undefined) {
      if (store.adopt(adoptedRecord(container, now), workspaceSlot)) {
        result.adopted += 1;
        console.log(
          `vps-executor: adopted owned container for sandbox ${sandboxId}; it is not running`
        );
        release(containerId);
      } else {
        unplace(container, `could not take workspace slot ${workspaceSlot}`);
      }
      continue;
    }
    if (holder.providerObjectId === containerId) {
      release(containerId);
      continue;
    }
    // A create in flight owns the container it is about to name, so its request settles it.
    if (holder.status === "creating" && holder.providerObjectId === null) continue;
    if (holder.status === "unresolved" && holder.providerObjectId === null) {
      if (store.attach(holder.leaseToken, containerId, workspaceSlot)) {
        result.attached += 1;
        console.log(
          `vps-executor: unresolved create for sandbox ${sandboxId} has its container; it is not running`
        );
        release(containerId);
      } else {
        unplace(container, `does not hold the workspace slot its create reserved`);
      }
      continue;
    }
    unplace(container, "is not the container its sandbox id holds");
  }

  result.unresolved = store.slotHolders().filter((record) => record.status === "unresolved").length;
  if (result.unresolved > 0)
    console.error(
      `vps-executor: ${result.unresolved} unresolved create(s) hold slots until docker shows their container or an operator abandons them`
    );
  return result;
}

/** The record an owned container is adopted under: unresolved, holding its id, under a lease no session ever spent. */
function adoptedRecord(container: OwnedContainer, now: () => number): SandboxRecord {
  return {
    leaseToken: `reconciled:${container.containerId}`,
    sessionId: "",
    sandboxId: container.sandboxId,
    status: "unresolved",
    providerObjectId: container.containerId,
    createdAtMs: now(),
  };
}

/** A settlement answer: the HTTP status and body. */
interface Answer {
  status: number;
  body: Record<string, unknown>;
}

const ABSENT: Answer = { status: 200, body: { outcome: "absent" } };

/** An answer that proves nothing either way. The control plane reads anything but absent or present as undecided. */
function errorAnswer(status: number, error: string): Answer {
  return { status, body: { error } };
}

/** The answer for what a settlement found. A tombstone under this lease but another scope is a replay. */
function settlementAnswer(found: Settlement, scope: SettlementScope): Answer {
  switch (found.kind) {
    case "settled":
      if (found.tombstone.leaseToken === scope.leaseToken && !sameScope(found.tombstone, scope))
        return errorAnswer(403, "admission_replayed");
      return ABSENT;
    case "record": {
      const { record } = found;
      if (!sameScope(record, scope)) return errorAnswer(403, "admission_replayed");
      if (record.status === "terminated") return ABSENT;
      if (record.status === "creating") return errorAnswer(409, "create_in_progress");
      // A running record, or an unresolved one that names its container, holds this lease's container, to be stopped.
      if (record.providerObjectId !== null)
        return {
          status: 200,
          body: { outcome: "present", providerObjectId: record.providerObjectId },
        };
      return errorAnswer(503, "create_unresolved");
    }
    case "held":
      // Another lease holds this sandbox id, so its object is not this lease's to name. Nothing is absent.
      if (found.record.status === "creating") return errorAnswer(409, "create_in_progress");
      if (found.record.status === "unresolved") return errorAnswer(503, "create_unresolved");
      return errorAnswer(409, "sandbox_held");
    case "unplaced":
      return errorAnswer(503, "container_unaccounted");
    case "free":
      // settle closes a free scope, so no answer is left for it.
      return errorAnswer(503, "state_unavailable");
  }
}

/** True when `remove` succeeds, or docker has nothing left to remove. */
async function removedOrAbsent(remove: () => Promise<void>): Promise<boolean> {
  try {
    await remove();
    return true;
  } catch (error) {
    if (error instanceof ContainerNotFoundError) return true;
    reportError("container removal failed", error);
    return false;
  }
}

function reportError(message: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : "unknown error";
  console.error(`vps-executor: ${message}: ${reason}`);
}

class RequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "RequestError";
    this.status = status;
    this.code = code;
  }
}

async function readJsonObject(
  req: IncomingMessage,
  limit = MAX_BODY_BYTES
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new RequestError(413, "body_too_large");
    chunks.push(chunk);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestError(400, "invalid_json");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new RequestError(400, "invalid_json");
  return parsed as Record<string, unknown>;
}

function isAuthorized(req: IncomingMessage, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(req.headers.authorization ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}
