import { execFile } from "node:child_process";

/*
 * Docker CLI boundary. Only this executor talks to docker. Values are validated before they
 * become argv, argv goes to execFile (no shell), and every sandbox runs under gVisor (runsc).
 * There is no runc fallback.
 */

const DOCKER_TIMEOUT_MS = 120_000;
const DOCKER_MAX_OUTPUT_BYTES = 1024 * 1024;
export const SANDBOX_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const IMAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/;
const CPUS_PATTERN = /^\d+(\.\d+)?$/;
const MEMORY_PATTERN = /^[1-9]\d*[bkmg]?$/i;
const CONTAINER_ID_PATTERN = /^[0-9a-f]{12,64}$/;

/** Per-sandbox ceilings, passed to docker run as explicit flags. */
export interface SandboxLimits {
  /** CPUs, e.g. "2" or "0.5". */
  cpus: string;
  /** Docker memory size, e.g. "4g". Swap is capped to the same value, so no swap. */
  memory: string;
  pidsLimit: number;
}

/** Runs one docker CLI call. Rejects with an Error whose `stderr` holds docker's output. */
export type DockerExec = (args: readonly string[]) => Promise<{ stdout: string }>;

export class IsolationUnavailableError extends Error {
  constructor() {
    super("gVisor runtime (runsc) is not available");
    this.name = "IsolationUnavailableError";
  }
}

export class ContainerNotFoundError extends Error {
  constructor() {
    super("container not found");
    this.name = "ContainerNotFoundError";
  }
}

export interface DockerRuntime {
  /** Throws IsolationUnavailableError unless docker has a runsc runtime registered. */
  checkIsolation(): Promise<void>;
  /** Starts a sandbox container and returns its container id. */
  runSandbox(sandboxId: string): Promise<string>;
  /** Force-removes a container. Throws ContainerNotFoundError when docker no longer has it. */
  removeSandbox(containerId: string): Promise<void>;
}

export interface DockerRuntimeOptions {
  image: string;
  limits: SandboxLimits;
  /** Defaults to the docker CLI. Tests inject a fake, so no process is spawned. */
  exec?: DockerExec;
}

export function buildRunArgs(sandboxId: string, image: string, limits: SandboxLimits): string[] {
  assertSandboxId(sandboxId);
  assertImage(image);
  assertLimits(limits);
  return [
    "run",
    "-d",
    "--name",
    `oi-${sandboxId}`,
    "--runtime",
    "runsc",
    "--cpus",
    limits.cpus,
    "--memory",
    limits.memory,
    "--memory-swap",
    limits.memory,
    "--pids-limit",
    String(limits.pidsLimit),
    "--security-opt",
    "no-new-privileges",
    "--label",
    "open-inspect.managed=vps-executor",
    "--label",
    `open-inspect.sandbox-id=${sandboxId}`,
    image,
  ];
}

export function createDockerRuntime(options: DockerRuntimeOptions): DockerRuntime {
  const exec = options.exec ?? execDocker;
  // Validate eagerly so a bad image or limit stops startup instead of the first create.
  assertImage(options.image);
  assertLimits(options.limits);

  return {
    async checkIsolation() {
      let runtimes: unknown;
      try {
        const { stdout } = await exec(["info", "--format", "{{json .Runtimes}}"]);
        runtimes = JSON.parse(stdout);
      } catch {
        throw new IsolationUnavailableError();
      }
      if (runtimes === null || typeof runtimes !== "object" || !("runsc" in runtimes))
        throw new IsolationUnavailableError();
    },

    async runSandbox(sandboxId) {
      const { stdout } = await exec(buildRunArgs(sandboxId, options.image, options.limits));
      const containerId = stdout.trim();
      if (!CONTAINER_ID_PATTERN.test(containerId))
        throw new Error("docker run returned no valid container id");
      return containerId;
    },

    async removeSandbox(containerId) {
      if (!CONTAINER_ID_PATTERN.test(containerId)) throw new Error("invalid container id");
      try {
        await exec(["rm", "-f", containerId]);
      } catch (error) {
        if (isNoSuchContainer(error)) throw new ContainerNotFoundError();
        throw error;
      }
    },
  };
}

/** Real docker CLI call: argv only, no shell, bounded time and output. */
function execDocker(args: readonly string[]): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "docker",
      args,
      { timeout: DOCKER_TIMEOUT_MS, maxBuffer: DOCKER_MAX_OUTPUT_BYTES, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(new Error(`docker ${args[0]} failed`), { stderr: String(stderr) }));
          return;
        }
        resolve({ stdout: String(stdout) });
      }
    );
  });
}

function isNoSuchContainer(error: unknown): boolean {
  return (
    error instanceof Error && "stderr" in error && String(error.stderr).includes("No such container")
  );
}

function assertSandboxId(sandboxId: string): void {
  if (!SANDBOX_ID_PATTERN.test(sandboxId)) throw new Error("invalid sandbox id");
}

function assertImage(image: string): void {
  if (!IMAGE_PATTERN.test(image)) throw new Error("invalid sandbox image reference");
}

function assertLimits(limits: SandboxLimits): void {
  if (!CPUS_PATTERN.test(limits.cpus) || Number(limits.cpus) <= 0)
    throw new Error("invalid sandbox cpu limit");
  if (!MEMORY_PATTERN.test(limits.memory)) throw new Error("invalid sandbox memory limit");
  if (!Number.isSafeInteger(limits.pidsLimit) || limits.pidsLimit <= 0)
    throw new Error("invalid sandbox pids limit");
}
