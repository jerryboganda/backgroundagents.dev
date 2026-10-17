import { pathToFileURL } from "node:url";
import { createDockerRuntime, type SandboxLimits } from "./docker.ts";
import { createExecutorServer, reconcileContainers } from "./server.ts";
import { openStateStore } from "./state.ts";
import { isWorkspaceRoot, WORKSPACE_SLOT_COUNT } from "./workspace.ts";

const MIN_TOKEN_LENGTH = 32;
const MIN_ADMISSION_SECRET_LENGTH = 32;
/** How often docker is reconciled with the state when no create arrives to do it. */
const RECONCILE_INTERVAL_MS = 30_000;

export interface ExecutorConfig {
  token: string;
  admissionSecret: string;
  host: string;
  port: number;
  stateFile: string;
  image: string;
  limits: SandboxLimits;
  /** Directory holding the workspace slots. */
  workspaceRoot: string;
  /** Slots this executor binds. At most the slots host setup provisions. */
  workspaceSlots: number;
  /** The control-plane origin sandboxes call back to. Creates must name exactly this. */
  controlPlaneUrl: string;
}

/**
 * Reads config from the environment. Throws on a missing or weak token or admission secret, or a
 * missing image, so the service never starts half-configured. Error messages never echo a value.
 */
export function readConfig(env: NodeJS.ProcessEnv): ExecutorConfig {
  const token = (env.VPS_EXECUTOR_TOKEN ?? "").trim();
  if (token.length < MIN_TOKEN_LENGTH)
    throw new Error(`VPS_EXECUTOR_TOKEN must be set to at least ${MIN_TOKEN_LENGTH} characters`);
  const image = env.VPS_EXECUTOR_IMAGE ?? "";
  if (!image) throw new Error("VPS_EXECUTOR_IMAGE must be set");
  const admissionSecret = (env.VPS_EXECUTOR_ADMISSION_SECRET ?? "").trim();
  if (admissionSecret.length < MIN_ADMISSION_SECRET_LENGTH)
    throw new Error(
      `VPS_EXECUTOR_ADMISSION_SECRET must be set to at least ${MIN_ADMISSION_SECRET_LENGTH} characters`
    );
  const controlPlaneUrl = (env.VPS_EXECUTOR_CONTROL_PLANE_URL ?? "").trim().replace(/\/+$/, "");
  if (!isHttpsUrl(controlPlaneUrl))
    throw new Error("VPS_EXECUTOR_CONTROL_PLANE_URL must be an absolute https URL");
  const port = Number(env.VPS_EXECUTOR_PORT ?? "8787");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("VPS_EXECUTOR_PORT must be a valid TCP port");
  const workspaceRoot = env.VPS_EXECUTOR_WORKSPACE_ROOT ?? "/srv/vps-ws/slots";
  if (!isWorkspaceRoot(workspaceRoot))
    throw new Error("VPS_EXECUTOR_WORKSPACE_ROOT must be an absolute, normalized path");
  const workspaceSlots = Number(env.VPS_EXECUTOR_WORKSPACE_SLOTS ?? WORKSPACE_SLOT_COUNT);
  if (
    !Number.isInteger(workspaceSlots) ||
    workspaceSlots < 1 ||
    workspaceSlots > WORKSPACE_SLOT_COUNT
  )
    throw new Error(
      `VPS_EXECUTOR_WORKSPACE_SLOTS must be an integer from 1 to ${WORKSPACE_SLOT_COUNT}`
    );
  return {
    token,
    admissionSecret,
    host: env.VPS_EXECUTOR_HOST ?? "127.0.0.1",
    port,
    // SQLite. The first build's JSON state (executor-state.json) is never this default, and is refused if configured.
    stateFile: env.VPS_EXECUTOR_STATE_FILE ?? "executor-state.db",
    image,
    limits: {
      cpus: env.VPS_EXECUTOR_SANDBOX_CPUS ?? "2",
      memory: env.VPS_EXECUTOR_SANDBOX_MEMORY ?? "4g",
      pidsLimit: 512,
    },
    workspaceRoot,
    workspaceSlots,
    controlPlaneUrl,
  };
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Starts the HTTP service. Isolation is checked on each create and by GET /v1/health, not at boot.
 * A create reconciles before it judges the cap, so nothing is allocated against a state that docker
 * has not been checked against.
 */
export async function main(env: NodeJS.ProcessEnv): Promise<void> {
  const config = readConfig(env);
  const runtime = createDockerRuntime({ image: config.image, limits: config.limits });
  const store = await openStateStore(config.stateFile, { workspaceSlots: config.workspaceSlots });
  // Shared by the server and the timer below, so a settling pass leaves the creates this process is running alone.
  const inFlight = new Set<string>();
  const server = createExecutorServer({
    token: config.token,
    admissionSecret: config.admissionSecret,
    runtime,
    store,
    workspaceRoot: config.workspaceRoot,
    controlPlaneUrl: config.controlPlaneUrl,
    inFlight,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });
  console.log(`vps-executor listening on ${config.host}:${config.port}`);

  // Reconciles at startup and then on a timer, so a container that appears late or disappears is
  // accounted for even with no creates. A pass that is still running is not overlapped.
  let reconciling = false;
  const reconcile = (): void => {
    if (reconciling) return;
    reconciling = true;
    reconcileContainers(store, runtime, Date.now, inFlight)
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : "unknown error";
        console.error(`vps-executor: reconciliation failed: ${reason}`);
      })
      .finally(() => {
        reconciling = false;
      });
  };
  reconcile();
  setInterval(reconcile, RECONCILE_INTERVAL_MS).unref();
}

// Start only when run directly, so tests can import readConfig without binding a port.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.env).catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : "unknown error";
    console.error(`vps-executor failed to start: ${reason}`);
    process.exitCode = 1;
  });
}
