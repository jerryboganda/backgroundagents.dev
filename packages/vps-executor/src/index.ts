import { pathToFileURL } from "node:url";
import { createDockerRuntime, type SandboxLimits } from "./docker.ts";
import { createExecutorServer, openStateStore } from "./server.ts";

const MIN_TOKEN_LENGTH = 32;
const MIN_ADMISSION_SECRET_LENGTH = 32;

export interface ExecutorConfig {
  token: string;
  admissionSecret: string;
  host: string;
  port: number;
  stateFile: string;
  image: string;
  limits: SandboxLimits;
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
  const port = Number(env.VPS_EXECUTOR_PORT ?? "8787");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("VPS_EXECUTOR_PORT must be a valid TCP port");
  return {
    token,
    admissionSecret,
    host: env.VPS_EXECUTOR_HOST ?? "127.0.0.1",
    port,
    stateFile: env.VPS_EXECUTOR_STATE_FILE ?? "executor-state.json",
    image,
    limits: {
      cpus: env.VPS_EXECUTOR_SANDBOX_CPUS ?? "2",
      memory: env.VPS_EXECUTOR_SANDBOX_MEMORY ?? "4g",
      pidsLimit: 512,
    },
  };
}

/** Starts the HTTP service. Isolation is checked on each create and by GET /v1/health, not at boot. */
export async function main(env: NodeJS.ProcessEnv): Promise<void> {
  const config = readConfig(env);
  const runtime = createDockerRuntime({ image: config.image, limits: config.limits });
  const store = await openStateStore(config.stateFile);
  const server = createExecutorServer({
    token: config.token,
    admissionSecret: config.admissionSecret,
    runtime,
    store,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });
  console.log(`vps-executor listening on ${config.host}:${config.port}`);
}

// Start only when run directly, so tests can import readConfig without binding a port.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.env).catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : "unknown error";
    console.error(`vps-executor failed to start: ${reason}`);
    process.exitCode = 1;
  });
}
