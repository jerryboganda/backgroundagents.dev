/*
 * The session environment a create carries to the runtime. The executor checks it against the scope its signed
 * lease proves and against its own trusted control-plane URL, then turns it into the one JSON line the runtime
 * reads on stdin. The line lives in the request's memory and the launch's stdin. It is never stored, logged, or
 * put in argv.
 */

export const SESSION_CONTEXT_VERSION = 1;
const MAX_ENV_ENTRIES = 256;
const MAX_ENV_VALUE_BYTES = 64 * 1024;
// Keys and values together. Keeps the line under the runtime's stdin bound.
const MAX_ENV_TOTAL_BYTES = 192 * 1024;
const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const REQUIRED_ENV_KEYS = [
  "SANDBOX_ID",
  "CONTROL_PLANE_URL",
  "SANDBOX_AUTH_TOKEN",
  "SESSION_CONFIG",
];
/**
 * Keys the executor owns. They pick the boot mode, switch on nested Docker or tunnels, hold the container
 * dormant, or move the image's own paths, so a create may not set them. The control plane already strips the
 * boot-mode keys from repository secrets. This is the executor's own check.
 */
const RESERVED_ENV_KEYS: ReadonlySet<string> = new Set([
  "OI_DEFERRED_START",
  "IMAGE_BUILD_MODE",
  "RESTORED_FROM_SNAPSHOT",
  "FROM_REPO_IMAGE",
  "REPO_IMAGE_SHA",
  "OPENINSPECT_BOOT_MODE",
  "OPENINSPECT_DOCKER_ENABLED",
  "EXPECTED_TUNNEL_PORTS",
  "HOME",
  "PATH",
  "PYTHONPATH",
]);

/** What the signed lease proves, and the control-plane origin this executor trusts (no trailing slash). */
export interface SessionScope {
  sandboxId: string;
  sessionId: string;
  controlPlaneUrl: string;
}

/** A refused context: the HTTP status and the fixed code the create answers with. */
export class SessionContextError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "SessionContextError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Validates a create's runtime context against its scope and returns the JSON line the runtime reads on stdin.
 * Throws SessionContextError: 400 for a malformed context, 413 for one past its bounds, and 403 when it names
 * another sandbox, session or control plane than the lease proves.
 */
export function sessionContextLine(value: unknown, scope: SessionScope): string {
  const env = validEnv(value);
  for (const key of REQUIRED_ENV_KEYS) if (!env[key]) throw invalid();
  if (env.SANDBOX_ID !== scope.sandboxId) throw mismatch();
  if (env.CONTROL_PLANE_URL.replace(/\/+$/, "") !== scope.controlPlaneUrl) throw mismatch();
  if (sessionIdOf(env.SESSION_CONFIG) !== scope.sessionId) throw mismatch();
  return JSON.stringify({
    version: SESSION_CONTEXT_VERSION,
    sandbox_id: scope.sandboxId,
    session_id: scope.sessionId,
    env,
  });
}

function validEnv(value: unknown): Record<string, string> {
  if (!isRecord(value) || !isRecord(value.env)) throw invalid();
  const entries = Object.entries(value.env);
  if (entries.length > MAX_ENV_ENTRIES) throw tooLarge();
  const env: Record<string, string> = {};
  let total = 0;
  for (const [key, item] of entries) {
    if (!ENV_KEY_PATTERN.test(key)) throw invalid();
    if (RESERVED_ENV_KEYS.has(key)) throw new SessionContextError(400, "reserved_env_key");
    if (typeof item !== "string") throw invalid();
    const bytes = Buffer.byteLength(item, "utf8");
    total += Buffer.byteLength(key, "utf8") + bytes;
    if (bytes > MAX_ENV_VALUE_BYTES || total > MAX_ENV_TOTAL_BYTES) throw tooLarge();
    env[key] = item;
  }
  return env;
}

/** The session id a SESSION_CONFIG names. Anything but a JSON object with a string session_id is invalid. */
function sessionIdOf(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalid();
  }
  if (!isRecord(parsed) || typeof parsed.session_id !== "string") throw invalid();
  return parsed.session_id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(): SessionContextError {
  return new SessionContextError(400, "invalid_runtime_context");
}

function mismatch(): SessionContextError {
  return new SessionContextError(403, "runtime_context_mismatch");
}

function tooLarge(): SessionContextError {
  return new SessionContextError(413, "runtime_context_too_large");
}
