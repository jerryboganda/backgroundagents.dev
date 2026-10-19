/**
 * VPS executor sandbox provider.
 *
 * Drives sandboxes through a separate executor service on a VPS over
 * authenticated HTTPS. The control plane never reaches a Docker socket on that
 * host; the executor owns placement and checks the admission lease forwarded on
 * create.
 *
 * Create, resolve, stop, and a health probe, plus a snapshot and restore that are the executor's retained workspace
 * (see takeSnapshot). Resume is not implemented and not advertised. An ambiguous create is recovered through
 * the lifecycle's pending reference: resolve by sandbox id, then stop the object
 * it names.
 *
 * Executor wire contract (the executor service in packages/vps-executor implements it):
 *   POST /v1/sandboxes
 *     body { sandboxId, sessionId, admissionLease?, runtimeContext: { env } } -> { providerObjectId }
 *     admissionLease = { leaseToken, expiresAtMs, signature }, signed with the shared admission secret
 *     runtimeContext.env = the session environment buildSandboxEnvVars assembles. The executor checks it against
 *     the lease and starts the runtime from it on stdin, so no value reaches docker config, argv, or its state.
 *     refusal -> { error: <code> }; REFUSED_BEFORE_ALLOCATION lists the codes that allocate nothing
 *   GET  /v1/sandboxes/{sandboxId}             -> { sandboxId, providerObjectId }; 503 create_unresolved while
 *     a create for the id runs or has not settled; 404 only when the executor holds no record for the id
 *   POST /v1/sandboxes/{providerObjectId}/stop
 *     body { reason } -> 2xx, or 404 { error: "sandbox_not_found" } when the object is already gone
 *   POST /v1/sandboxes/{sandboxId}/admission/close
 *     body { sessionId, admissionLease } -> { outcome: "present", providerObjectId } | { outcome: "absent" }
 *     409 create_in_progress while a create for the id runs; any other answer is undecided
 *   GET  /v1/health                            -> 2xx
 *
 * Executor guarantees this provider relies on (the typed stop 404 below is an open integration gate):
 *   - admission/close answers "absent" only after it tombstones the lease and its sandbox id, so a create that
 *     follows for that id is refused. A stop tombstones the id too, because a valid lease replays until it expires.
 *   - A create whose docker run ends unverified holds its slots as unresolved until reconciliation finds the container.
 *   - A stopped sandbox's workspace is retained for its owning session. A restore (create with restoreWorkspace: true)
 *     reattaches it under the new sandbox id, and answers `reattached` in its 201. The executor releases a retained
 *     workspace on its own once its last sandbox is older than VPS_EXECUTOR_RETAINED_WORKSPACE_TTL_SECONDS (three
 *     days by default), through the same owner release the authenticated release route performs. This provider never
 *     calls that route.
 *   - The close proof's expiry is not checked: a lapsed proof settles and never creates.
 *
 * Typed 404s: a 404 proves gone only with the { error: "sandbox_not_found" } body, which only the executor's stop route
 * answers. The router's generic { error: "not_found" } answers any unmatched route, so it, like any other 404, is a
 * failed stop: a base-path mismatch that reaches the executor cannot read as a gone object.
 * Integration gate: the executor's stop route must answer the typed body for an object it already terminated. Until it
 * does, such a stop stays unconfirmed and its slot stays held. The control plane side is in place.
 */

import { bytesToHex } from "@open-inspect/shared/auth";
import { z } from "zod";
import { createLogger } from "../../logger";
import { DEFAULT_SCM_PROVIDER, type SourceControlProviderName } from "../../source-control";
import { withRequestDeadline } from "../request-deadline";
import { buildSandboxEnvVars, partitionUserEnvVars, scmCloneIdentity } from "../sandbox-env";
import {
  DEFAULT_SANDBOX_TIMEOUT_SECONDS,
  SandboxProviderError,
  signalUntilDeadline,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type PendingSandboxAllocation,
  type ResolveSandboxConfig,
  type ResolveSandboxResult,
  type RestoreConfig,
  type RestoreResult,
  type SandboxAdmissionProof,
  type SandboxLifetime,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type SnapshotConfig,
  type SnapshotResult,
  type StopConfig,
  type StopResult,
} from "../provider";
import { formatVpsPendingVmReference, parseVpsPendingVmReference } from "./pending-vm-reference";

const PROVIDER_NAME = "vps";
const log = createLogger("vps-provider");
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
/** The stop route's typed proof that its object is gone. Keep in step with the executor's stop route. */
const STOP_NOT_FOUND_CODE = "sandbox_not_found";
/** Domain tag of the signed admission payload. The executor verifies the same bytes. */
const ADMISSION_SIGNATURE_DOMAIN = "open-inspect.vps-admission.v1";
/**
 * Executor codes for a create refused before any container was reserved or run, so its lease is
 * unspent and no object exists. Any other failure may have allocated one. Keep in step with the
 * executor's create route. admission_replayed and sandbox_id_conflict are not listed: the executor answers
 * them for a create it already admitted under this lease or sandbox id, so an object may exist. create_failed is not listed: docker run can start a container before it
 * fails. state_unavailable is not listed either: the executor answers it after a container started,
 * when the state write that follows could not be recorded. workspace_unavailable and runtime_start_failed
 * are not listed: each follows a reservation or a container start, and the executor's cleanup of that is
 * best-effort, so the answer does not confirm it. workspace_busy and workspace_capacity_exhausted are
 * refused inside the executor's admit transaction, before it records anything.
 */
const REFUSED_BEFORE_ALLOCATION = new Set([
  "unauthorized",
  "invalid_sandbox_id",
  "invalid_session_id",
  "admission_missing",
  "admission_invalid",
  "admission_expired",
  "capacity_exhausted",
  "workspace_busy",
  "workspace_not_retained",
  "workspace_capacity_exhausted",
  "isolation_unavailable",
  "body_too_large",
  "invalid_runtime_context",
  "runtime_context_mismatch",
  "runtime_context_too_large",
  "reserved_env_key",
]);

/** Finds the lease a pending reference was claimed under. Its close is signed with that lease, so none is sent without one. */
export interface VpsAdmissionLeases {
  leaseOf(operationRef: string): Promise<SandboxAdmissionProof | null>;
}

export interface VpsExecutorConfig {
  /** Executor base URL. Must be https. */
  executorUrl?: string;
  /** Bearer token for the executor API. Never logged or put in error messages. */
  executorToken?: string;
  /** Required. Shared with the executor; signs each admission lease. Never logged or put in error messages. */
  admissionSecret?: string;
  /** Per-request deadline in ms. */
  requestTimeoutMs?: number;
  /** Source of the admission lease a pending stop closes under. Without it a pending stop stays pending. */
  leases?: VpsAdmissionLeases;
  /** Names the git host the session's clone identity targets. Defaults to the default SCM provider. */
  scmProvider?: SourceControlProviderName;
}

const createResponseSchema = z.object({
  providerObjectId: z.string().min(1),
  // Whether the sandbox runs on the session's retained workspace. An executor that predates the field omits it.
  reattached: z.boolean().optional(),
});
const resolveResponseSchema = z.object({
  sandboxId: z.string().min(1),
  providerObjectId: z.string().min(1),
});
const closeResponseSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("absent") }),
  z.object({ outcome: z.literal("present"), providerObjectId: z.string().min(1) }),
]);

/**
 * The executor's answer to a close. Only "absent" and "present" are proof. Anything else is undecided,
 * including a 404 from a route the executor lacks, so a missing route never frees a slot.
 */
export type VpsAdmissionClose =
  { kind: "absent" } | { kind: "present"; providerObjectId: string } | { kind: "undecided" };

/** The snapshot id of a session's retained workspace. It names no file: the executor keys the workspace by session. */
function workspaceSnapshotId(sessionId: string): string {
  return `vps-workspace:${sessionId}`;
}

/** The executor refused a create before allocating anything, so the lease it carried is unspent. */
class VpsCreateRefusedError extends SandboxProviderError {}

export class VpsSandboxProvider implements SandboxProvider {
  readonly name = PROVIDER_NAME;

  readonly capabilities: SandboxProviderCapabilities = {
    supportsSandboxTimeout: false,
    // The workspace the executor retains on a stop is the snapshot. See takeSnapshot.
    supportsSnapshots: true,
    supportsRestore: true,
    supportsPersistentResume: false,
    supportsExplicitStop: true,
    // Saving ends the sandbox, so a turn never saves: inactivity, lifetime expiry and failures do.
    snapshotRequiresShutdown: true,
  };

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly requestTimeoutMs: number,
    private readonly admissionSecret: string,
    private readonly leases: VpsAdmissionLeases | undefined,
    private readonly scmProvider: SourceControlProviderName
  ) {}

  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    const { created } = await this.create(config, false);
    return created;
  }

  /** The create both entry points share. `restoreWorkspace` asks the executor to reattach the session's retained workspace. */
  private async create(
    config: CreateSandboxConfig,
    restoreWorkspace: boolean
  ): Promise<{ created: CreateSandboxResult; reattached: boolean }> {
    const lease = config.admissionLease;
    // Only the user layer is filtered: the system env overlays it, so the trusted keys are never dropped here.
    const { accepted, refused } = partitionUserEnvVars(config.userEnvVars ?? {});
    if (refused.length > 0)
      log.warn("Dropped session env keys the runtime refuses", {
        event: "sandbox.user_env_refused",
        session_id: config.sessionId,
        sandbox_id: config.sandboxId,
        keys: refused,
      });
    const { status, body, code } = await this.exchange("create sandbox", "POST", "/v1/sandboxes", {
      sandboxId: config.sandboxId,
      sessionId: config.sessionId,
      ...(restoreWorkspace ? { restoreWorkspace: true } : {}),
      ...(lease ? { admissionLease: await this.signLease(lease, config) } : {}),
      runtimeContext: {
        env: buildSandboxEnvVars(config, {
          scmIdentity: scmCloneIdentity(this.scmProvider),
          baseEnvVars: accepted,
        }),
      },
    });
    if (code === "workspace_not_retained")
      throw new VpsCreateRefusedError(
        "The saved workspace is no longer held by the executor, and no fresh sandbox was substituted",
        "permanent"
      );
    if (status < 200 || status >= 300) throw createFailure(status, code);
    const parsed = parseBody("create sandbox", createResponseSchema, body);
    return {
      created: {
        sandboxId: config.sandboxId,
        providerObjectId: parsed.providerObjectId,
        createdAt: Date.now(),
        lifetime: unknownLifetime(),
      },
      reattached: parsed.reattached === true,
    };
  }

  /** Signs a lease the control plane has already claimed, bound to this create's session and sandbox. */
  private async signLease(
    lease: SandboxAdmissionProof,
    config: Pick<CreateSandboxConfig, "sessionId" | "sandboxId">
  ): Promise<SandboxAdmissionProof & { signature: string }> {
    const signature = await admissionSignature(this.admissionSecret, {
      sessionId: config.sessionId,
      sandboxId: config.sandboxId,
      leaseToken: lease.leaseToken,
      expiresAtMs: lease.expiresAtMs,
    });
    return { leaseToken: lease.leaseToken, expiresAtMs: lease.expiresAtMs, signature };
  }

  /**
   * The reference a create persists before its call, so an ambiguous create resolves by sandbox id.
   * The executor enforces one lifetime for every sandbox (VPS_EXECUTOR_SANDBOX_MAX_LIFETIME_SECONDS, default 2h5m) and the
   * create carries no per-session timeout, so the lifetime is the conservative start bound. A session that asks for a
   * longer timeout than that setting is removed at the setting.
   */
  pendingSandboxAllocation(
    config: Pick<
      CreateSandboxConfig,
      "sessionId" | "sandboxId" | "generationCreatedAtMs" | "timeoutSeconds"
    >
  ): PendingSandboxAllocation {
    const observedAtMs = config.generationCreatedAtMs;
    if (observedAtMs === undefined)
      throw new SandboxProviderError("Missing VPS generation reservation time", "permanent");
    return {
      reference: formatVpsPendingVmReference(config.sessionId, config.sandboxId),
      lifetime: {
        kind: "finite",
        expiresAtMs:
          observedAtMs + (config.timeoutSeconds ?? DEFAULT_SANDBOX_TIMEOUT_SECONDS) * 1000,
        observedAtMs,
        source: "conservative_start_bound",
      },
    };
  }

  /** Only a refusal the executor named before allocating proves no object exists. Anything else may have one. */
  isUnknownStartupError(error: unknown): boolean {
    return !(error instanceof VpsCreateRefusedError);
  }

  async resolveSandbox(config: ResolveSandboxConfig): Promise<ResolveSandboxResult> {
    const { status, body } = await this.exchange(
      "resolve sandbox",
      "GET",
      `/v1/sandboxes/${encodeURIComponent(config.sandboxId)}`
    );
    assertOk("resolve sandbox", status);
    const resolved = parseBody("resolve sandbox", resolveResponseSchema, body);
    if (resolved.sandboxId !== config.sandboxId)
      throw new SandboxProviderError("VPS executor resolved a different sandbox", "permanent");
    return {
      sandboxId: resolved.sandboxId,
      providerObjectId: resolved.providerObjectId,
      lifetime: unknownLifetime(),
    };
  }

  /**
   * A VPS "snapshot" copies nothing. The executor retains a stopped sandbox's workspace for its session, so the
   * recovery point already exists and the only step left is the stop. That stop is the shutdown flow's own retirement of
   * the source, which also frees the admission slot, so the source is reported as still running here (sourceStopped
   * false) and this call stops nothing. Without a snapshot to take, a sandbox that went idle ended its shutdown
   * unconfirmed and held its slot until an operator removed it.
   */
  async takeSnapshot(config: SnapshotConfig): Promise<SnapshotResult> {
    return { success: true, imageId: workspaceSnapshotId(config.sessionId), sourceStopped: false };
  }

  /**
   * Starts a sandbox for a session whose workspace was retained: the create asks the executor to reattach it. When the
   * executor no longer holds it (released after its retention, or an older executor that cannot reattach), the sandbox
   * that started is stopped and the restore fails, so no empty sandbox stands in for a saved one. Only this session's
   * own snapshot id is accepted, so a stale or foreign id never starts a sandbox.
   */
  async restoreFromSnapshot(config: RestoreConfig): Promise<RestoreResult> {
    if (config.snapshotImageId !== workspaceSnapshotId(config.sessionId))
      return { success: false, error: "Not a VPS workspace snapshot of this session" };
    const { created, reattached } = await this.create(config, true);
    if (!reattached) {
      // The empty sandbox is not a restore. Stopped, it holds neither the slot nor the cap, and the failure holds the session.
      if (created.providerObjectId)
        await this.stopSandbox({
          providerObjectId: created.providerObjectId,
          sessionId: config.sessionId,
          reason: "restore_without_workspace",
          intent: "destroy",
          generationCreatedAtMs: config.generationCreatedAtMs,
        }).catch(() => undefined);
      return {
        success: false,
        error:
          "The saved workspace is no longer held by the executor, and no fresh sandbox was substituted",
      };
    }
    return {
      success: true,
      sandboxId: created.sandboxId,
      providerObjectId: created.providerObjectId,
      lifetime: created.lifetime,
    };
  }

  async releaseSessionWorkspaces(
    sessionId: string,
    signal?: AbortSignal
  ): Promise<{ remaining: number }> {
    const { status, body } = await this.exchange(
      "release session workspaces",
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/release-workspaces`,
      { reason: "session_deleted" },
      signal
    );
    assertOk("release session workspaces", status);
    const remaining = (body as { remaining?: unknown } | undefined)?.remaining;
    if (typeof remaining !== "number" || !Number.isInteger(remaining) || remaining < 0)
      throw SandboxProviderError.fromFetchError(
        "Failed to release session workspaces: executor returned an unreadable answer",
        undefined,
        status
      );
    return { remaining };
  }

  async stopSandbox(config: StopConfig): Promise<StopResult> {
    // No resume support, so state cannot be kept. Refuse rather than destroy silently.
    if (config.intent === "preserve")
      return { success: false, error: "VPS executor cannot preserve sandbox state" };
    const signal = signalUntilDeadline(config.deadlineAtMs, config.signal);
    const providerObjectId = await this.stopTarget(config.providerObjectId, signal);
    // Absent: there was nothing to stop. A close proved none can appear, or a proof already freed the lease.
    if (providerObjectId === null) return { success: true };
    const { status, code } = await this.exchange(
      "stop sandbox",
      "POST",
      `/v1/sandboxes/${encodeURIComponent(providerObjectId)}/stop`,
      { reason: config.reason },
      signal
    );
    // Only the typed sandbox_not_found proves the object gone. Any other 404 is a failed stop, so its slot stays held.
    if (status === 404 && code === STOP_NOT_FOUND_CODE) return { success: true };
    assertOk("stop sandbox", status);
    return { success: true };
  }

  /**
   * The object a stop targets. A pending reference is resolved by closing admission for its sandbox id:
   * "present" names the object, and "absent" proves there is none (null). A reference no lease holds was freed
   * by proof, so it settles (null) without a close. Otherwise the stop stays pending. A 404 never resolves it,
   * since the create may not have reached the executor yet.
   */
  private async stopTarget(
    providerObjectId: string,
    signal: AbortSignal | undefined
  ): Promise<string | null> {
    const pending = parseVpsPendingVmReference(providerObjectId);
    if (!pending) return providerObjectId;
    // Without a lease source no close can be signed, so the stop stays pending.
    if (!this.leases)
      throw new SandboxProviderError(
        "VPS executor admission lease source is not configured; stop cannot be confirmed",
        "transient"
      );
    // Only the lease the create was granted can sign its close.
    const admissionLease = await this.leases.leaseOf(providerObjectId);
    if (!admissionLease) return null;
    const closed = await this.closeAdmission({ ...pending, admissionLease }, signal);
    if (closed.kind === "present") return closed.providerObjectId;
    if (closed.kind === "absent") return null;
    throw new SandboxProviderError(
      "VPS executor cannot confirm the pending sandbox is absent; stop cannot be confirmed",
      "transient"
    );
  }

  /**
   * Closes admission for a sandbox id, so the id can never allocate again once "absent" is returned. The
   * executor refuses a create for a closed id, and answers 409 while a create for it still runs.
   */
  async closeAdmission(
    config: { sessionId: string; sandboxId: string; admissionLease: SandboxAdmissionProof },
    signal?: AbortSignal
  ): Promise<VpsAdmissionClose> {
    const admissionLease = await this.signLease(config.admissionLease, config);
    const { status, body } = await this.exchange(
      "close sandbox admission",
      "POST",
      `/v1/sandboxes/${encodeURIComponent(config.sandboxId)}/admission/close`,
      { sessionId: config.sessionId, admissionLease },
      signal
    );
    if (status < 200 || status >= 300) return { kind: "undecided" };
    const closed = closeResponseSchema.safeParse(body);
    if (!closed.success) return { kind: "undecided" };
    return closed.data.outcome === "absent"
      ? { kind: "absent" }
      : { kind: "present", providerObjectId: closed.data.providerObjectId };
  }

  /** Probe the executor. Throws a SandboxProviderError when it is not healthy. */
  async healthCheck(): Promise<void> {
    const { status } = await this.exchange("check executor health", "GET", "/v1/health");
    assertOk("check executor health", status);
  }

  /** One authenticated request, deadline included. Error bodies are not surfaced; only a refusal's code is read. */
  private async exchange(
    operation: string,
    method: "GET" | "POST",
    path: string,
    payload?: unknown,
    signal?: AbortSignal
  ): Promise<{ status: number; body: unknown; code?: string }> {
    try {
      return await withRequestDeadline(
        PROVIDER_NAME,
        `${method} ${path}`,
        this.requestTimeoutMs,
        signal,
        async (requestSignal) => {
          const response = await fetch(`${this.baseUrl}${path}`, {
            method,
            headers: {
              Authorization: `Bearer ${this.token}`,
              Accept: "application/json",
              ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
            },
            body: payload === undefined ? undefined : JSON.stringify(payload),
            signal: requestSignal,
          });
          const text = await response.text();
          return {
            status: response.status,
            body: response.ok && text ? JSON.parse(text) : undefined,
            code: response.ok ? undefined : refusalCode(text),
          };
        }
      );
    } catch (error) {
      throw SandboxProviderError.fromFetchError(`Failed to ${operation}`, error);
    }
  }
}

/** Validates executor config and builds the provider. Fails before any request is sent. */
export function createVpsProvider(config: VpsExecutorConfig): VpsSandboxProvider {
  const executorUrl = config.executorUrl?.trim();
  const executorToken = config.executorToken?.trim();
  if (!executorUrl || !executorToken)
    throw new SandboxProviderError("VPS executor URL and token are required", "permanent");

  let url: URL;
  try {
    url = new URL(executorUrl);
  } catch {
    throw new SandboxProviderError("VPS executor URL is not a valid URL", "permanent");
  }
  if (url.protocol !== "https:")
    throw new SandboxProviderError("VPS executor URL must use https", "permanent");

  // Every create carries a lease signed with this secret, so a deployment without one cannot allocate.
  const admissionSecret = config.admissionSecret?.trim();
  if (!admissionSecret)
    throw new SandboxProviderError("VPS executor admission secret is required", "permanent");

  return new VpsSandboxProvider(
    url.toString().replace(/\/+$/, ""),
    executorToken,
    config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    admissionSecret,
    config.leases,
    config.scmProvider ?? DEFAULT_SCM_PROVIDER
  );
}

/**
 * HMAC-SHA256 hex over the canonical admission payload. The executor's admission.ts verifies the
 * same bytes, so keep the two in step.
 */
async function admissionSignature(
  secret: string,
  fields: { sessionId: string; sandboxId: string; leaseToken: string; expiresAtMs: number }
): Promise<string> {
  const payload = JSON.stringify([
    ADMISSION_SIGNATURE_DOMAIN,
    fields.sessionId,
    fields.sandboxId,
    fields.leaseToken,
    fields.expiresAtMs,
  ]);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return bytesToHex(new Uint8Array(mac));
}

/** A refused create is definitive only when the executor names a code that allocates nothing. */
function createFailure(status: number, code: string | undefined): SandboxProviderError {
  const message = `Failed to create sandbox: executor returned HTTP ${status}`;
  if (code !== undefined && REFUSED_BEFORE_ALLOCATION.has(code))
    return new VpsCreateRefusedError(
      message,
      SandboxProviderError.isTransientStatus(status) ? "transient" : "permanent"
    );
  return SandboxProviderError.fromFetchError(message, undefined, status);
}

/** The `error` code of an executor refusal, read only to classify it. The body is never surfaced. */
function refusalCode(text: string): string | undefined {
  try {
    const { error } = JSON.parse(text) as { error?: unknown };
    return typeof error === "string" ? error : undefined;
  } catch {
    return undefined;
  }
}

function assertOk(operation: string, status: number): void {
  if (status < 200 || status >= 300)
    throw SandboxProviderError.fromFetchError(
      `Failed to ${operation}: executor returned HTTP ${status}`,
      undefined,
      status
    );
}

function parseBody<T>(operation: string, schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new SandboxProviderError(
      `Failed to ${operation}: unexpected executor response`,
      "permanent"
    );
  return parsed.data;
}

function unknownLifetime(): SandboxLifetime {
  return {
    kind: "unknown",
    observedAtMs: Date.now(),
    reason: "VPS executor does not report sandbox lifetime",
  };
}
