import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { basename, join } from "node:path";
import {
  HOME_DIRECTORY,
  WORKSPACE_GID,
  WORKSPACE_SLOT_COUNT,
  WORKSPACE_UID,
  type WorkspaceMount,
} from "./workspace.ts";

/*
 * Docker CLI boundary. Only this executor talks to docker. Values are validated before they
 * become argv, argv goes to execFile (no shell), and every sandbox runs under gVisor (runsc).
 * There is no runc fallback. Every sandbox container carries the owner labels below, and only
 * containers that carry them are read as owned. A fence, which reserves a sandbox's name, carries
 * the fence label instead, so it is never read as owned.
 */

const DOCKER_TIMEOUT_MS = 120_000;
const DOCKER_MAX_OUTPUT_BYTES = 1024 * 1024;
const OWNER_LABEL = "open-inspect.managed";
const OWNER_VALUE = "vps-executor";
const SANDBOX_LABEL = "open-inspect.sandbox-id";
const SLOT_LABEL = "open-inspect.workspace-slot";
const UNEXPECTED_LISTING = "docker ps returned an unexpected listing";
// Bounded and no setuid or device nodes. exec is explicit: docker mounts a tmpfs noexec by default, and build and test tools run binaries from /tmp.
const TMP_TMPFS = "/tmp:exec,nosuid,nodev,size=256m";
// The image wrapper's desktop keeps its X socket here. Mode 1777 is the sticky world-writable mode X expects.
// The socket is all this mount holds, so it is bounded to 1m.
const X11_SOCKET_TMPFS = "/tmp/.X11-unix:nosuid,nodev,mode=1777,size=1m";
// Written by deploy/polytronx/sandbox-network.sh (a test keeps the two paths equal). runsc cannot reach Docker's embedded
// resolver, so each sandbox gets this file over /etc/resolv.conf; --dns would only feed that resolver (EAI_AGAIN, verified live).
const RESOLV_CONF_SOURCE = "/etc/polytronx/sandbox-resolv.conf";
// Every sandbox joins this network. Host setup provisions it; this executor only names it, and proves the two network
// properties isolation depends on before any create.
const SANDBOX_NETWORK = "oi-sandbox";
const ICC_OPTION = "com.docker.network.bridge.enable_icc";
// A sandbox's container and its fence share one name, since docker keeps names unique.
const CONTAINER_NAME_PREFIX = "oi-";
// A fence is a never-started container under a sandbox's name. It carries this label, and never the owner labels.
const FENCE_LABEL = "open-inspect.fence";
const FENCE_VALUE = "name-reservation";
// docker's answer when a name is taken. The daemon refused the create, so it created nothing under that name.
const NAME_CONFLICT = /Conflict\. The container name "\/[^"]+" is already in use/;
const WORKSPACE_TARGET = "/workspace";
// The runtime image's baked home. The slot's home subdirectory is bound here, so HOME matches the image.
const HOME_TARGET = "/home/sandbox";
export const SANDBOX_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const IMAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/;
const CPUS_PATTERN = /^\d+(\.\d+)?$/;
const MEMORY_PATTERN = /^[1-9]\d*[bkmg]?$/i;
const CONTAINER_ID_PATTERN = /^[0-9a-f]{12,64}$/;
const SLOT_VALUE_PATTERN = /^(0|[1-9]\d*)$/;
const LAUNCH_TIMEOUT_MS = 30_000;
// The runtime image's interpreter and session entry, run inside the holding container.
const RUNTIME_PYTHON = "/opt/openinspect/python/bin/python";
const SESSION_CONTEXT_ARGUMENT = "--session-context-stdin-v1";
/** The line the runtime writes to stdout once it has accepted the session context. */
export const SESSION_CONTEXT_ACCEPTED_LINE = "open-inspect:session-context:accepted";
// No line this long can be the acceptance line, so a longer one is dropped rather than buffered.
const MAX_STDOUT_LINE_CHARS = 4096;

/** Per-sandbox ceilings, passed to docker run as explicit flags. */
export interface SandboxLimits {
  /** CPUs, e.g. "2" or "0.5". */
  cpus: string;
  /** Docker memory size, e.g. "4g". Swap is capped to the same value, so no swap. */
  memory: string;
  pidsLimit: number;
}

/**
 * Runs one docker CLI call. Rejects with an Error whose `stderr` holds docker's output. `killed` is
 * set when the executor stopped docker, `signal` when a signal ended it, and `code` is docker's
 * exit code or the spawn error code.
 */
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

/**
 * The executor ended docker before it answered, a signal did, or the failure was not docker's own refusal (a dropped
 * connection, unreadable output). A container may still be on its way to existing, so the run's outcome is unknown.
 */
export class RunOutcomeUnknownError extends Error {
  constructor() {
    super("docker run did not report an outcome");
    this.name = "RunOutcomeUnknownError";
  }
}

/** The docker CLI is not installed, so nothing was spawned and the run was never sent. */
export class RunNotStartedError extends Error {
  constructor() {
    super("docker CLI is not installed; the run was never sent");
    this.name = "RunNotStartedError";
  }
}

/**
 * The CLI exited on its own and printed the daemon's structured refusal, so the daemon answered the create with an
 * error. That run created nothing, but a container under the name can still exist (a create that failed after docker
 * made it). The caller proves absence from the owned inventory before it frees anything.
 */
export class RunRejectedByDaemonError extends Error {
  constructor() {
    super("docker run was refused by the daemon");
    this.name = "RunRejectedByDaemonError";
  }
}

/**
 * The runtime did not accept the session context and exited first, so no supervisor started. A container
 * may still hold the workspace, so it is removed before anything is released.
 */
export class RuntimeRefusedError extends Error {
  constructor() {
    super("runtime did not accept the session context");
    this.name = "RuntimeRefusedError";
  }
}

/**
 * The launch ended without a verified answer: it timed out, a signal ended it, or its process failed. The
 * runtime may have started, so the container must be stopped before anything is released.
 */
export class RuntimeLaunchUnknownError extends Error {
  constructor() {
    super("runtime launch did not report an outcome");
    this.name = "RuntimeLaunchUnknownError";
  }
}

/**
 * The fence create ended without a verified answer, so the name may or may not be reserved. The caller holds the sandbox
 * and frees nothing.
 */
export class FenceUnknownError extends Error {
  constructor() {
    super("sandbox name fence did not report an outcome");
    this.name = "FenceUnknownError";
  }
}

/** Another container holds the sandbox's name, and it is not this sandbox's fence. The caller holds the sandbox. */
export class NameHeldError extends Error {
  constructor() {
    super("sandbox container name is held by another container");
    this.name = "NameHeldError";
  }
}

/**
 * A container this executor owns: labelled by it, and named for its sandbox id. `workspaceSlot` is
 * the slot its label names, or null when the label is missing or invalid.
 */
export interface OwnedContainer {
  containerId: string;
  sandboxId: string;
  workspaceSlot: number | null;
}

/** A fence this executor placed under a sandbox id's name. It runs nothing, mounts nothing, and is never owned. */
export interface FenceContainer {
  containerId: string;
  sandboxId: string;
}

export interface DockerInventory {
  /** Every container id on the daemon, owned or not. Used only to test whether a known id is still there. */
  containerIds: ReadonlySet<string>;
  owned: OwnedContainer[];
  /** The fences under sandbox id names. They hold a name, never a slot, and are never adopted or counted. */
  fences: FenceContainer[];
}

export interface DockerRuntime {
  /** Throws IsolationUnavailableError unless docker has a runsc runtime registered. */
  checkIsolation(): Promise<void>;
  /** Starts a sandbox container bound to its workspace slot and returns its container id. Throws one of the Run*Error classes. */
  runSandbox(sandboxId: string, workspace: WorkspaceMount): Promise<string>;
  /** Force-removes a container by id. Throws ContainerNotFoundError when docker no longer has it. */
  removeSandbox(containerId: string): Promise<void>;
  /**
   * Reserves a sandbox's container name with a fence, so a create docker still holds for that name is refused. Resolves
   * once the fence is placed, or when this sandbox's fence already holds the name. Throws NameHeldError when another
   * container holds the name, and FenceUnknownError when the outcome cannot be proven.
   */
  fenceSandbox(sandboxId: string): Promise<void>;
  // ponytail: fences are never removed, so each abandoned sandbox id keeps one never-started container. Removing one while a
  // late create can still land would let that create run. Add a GC once a late create is provably impossible.
  /** Lists every container on the daemon, and which of them are owned. Throws when docker cannot list. */
  inventory(): Promise<DockerInventory>;
  /**
   * Starts the runtime in a container runSandbox created, and resolves once the runtime accepts the session
   * context. The context is one JSON line, written to the runtime's stdin only. Throws RuntimeRefusedError or
   * RuntimeLaunchUnknownError.
   */
  launchRuntime(containerId: string, sessionContext: string): Promise<void>;
}

/** Spawns the docker CLI with stdin piped. Tests inject a fake child, so no process is started. */
export type SpawnDocker = (args: readonly string[]) => ChildProcessWithoutNullStreams;

export interface DockerRuntimeOptions {
  image: string;
  limits: SandboxLimits;
  /** Defaults to the docker CLI. Tests inject a fake, so no process is spawned. */
  exec?: DockerExec;
  /** Defaults to the docker CLI with stdin piped, for launchRuntime. */
  spawnDocker?: SpawnDocker;
  /** Bounds one launch. Defaults to LAUNCH_TIMEOUT_MS. */
  launchTimeoutMs?: number;
}

/** The name a sandbox's container is created under. docker keeps names unique, so one name is at most one container. */
export function containerName(sandboxId: string): string {
  return `${CONTAINER_NAME_PREFIX}${sandboxId}`;
}

export function buildRunArgs(
  sandboxId: string,
  image: string,
  limits: SandboxLimits,
  workspace: WorkspaceMount
): string[] {
  assertSandboxId(sandboxId);
  assertImage(image);
  assertLimits(limits);
  assertWorkspace(workspace);
  return [
    "run",
    "-d",
    "--name",
    containerName(sandboxId),
    // A missing image is a refusal, never a pull, and the sandbox joins its own network rather than the host's.
    "--pull",
    "never",
    "--network",
    SANDBOX_NETWORK,
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
    "--user",
    `${WORKSPACE_UID}:${WORKSPACE_GID}`,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--tmpfs",
    TMP_TMPFS,
    "--tmpfs",
    X11_SOCKET_TMPFS,
    "--mount",
    `type=bind,source=${workspace.hostPath},target=${WORKSPACE_TARGET}`,
    // The slot's own home subdirectory: it persists with the workspace, and a release clears both.
    "--mount",
    `type=bind,source=${join(workspace.hostPath, HOME_DIRECTORY)},target=${HOME_TARGET}`,
    "--mount",
    `type=bind,source=${RESOLV_CONF_SOURCE},target=/etc/resolv.conf,readonly`,
    "--workdir",
    WORKSPACE_TARGET,
    "-e",
    `HOME=${HOME_TARGET}`,
    // Holds the container open with no session. The runtime starts only when launchRuntime execs it.
    "-e",
    "OI_DEFERRED_START=true",
    "--label",
    `${OWNER_LABEL}=${OWNER_VALUE}`,
    "--label",
    `${SANDBOX_LABEL}=${sandboxId}`,
    "--label",
    `${SLOT_LABEL}=${workspace.slot}`,
    image,
  ];
}

/**
 * The argv that places a sandbox's fence: a container under the sandbox's name, created and never started, with no mount
 * and no network. docker refuses every later create under that name while the fence exists.
 */
export function buildFenceArgs(sandboxId: string, image: string): string[] {
  assertSandboxId(sandboxId);
  assertImage(image);
  return [
    "create",
    "--name",
    containerName(sandboxId),
    "--pull",
    "never",
    "--network",
    "none",
    "--label",
    `${FENCE_LABEL}=${FENCE_VALUE}`,
    image,
    "true",
  ];
}

export function createDockerRuntime(options: DockerRuntimeOptions): DockerRuntime {
  const exec = options.exec ?? execDocker;
  const spawnDocker = options.spawnDocker ?? spawnDockerCli;
  const launchTimeoutMs = options.launchTimeoutMs ?? LAUNCH_TIMEOUT_MS;
  // Validate eagerly so a bad image or limit stops startup instead of the first create.
  assertImage(options.image);
  assertLimits(options.limits);

  // rm -f by id. ContainerNotFoundError means docker has nothing under that id.
  async function forceRemove(containerId: string): Promise<void> {
    try {
      await exec(["rm", "-f", containerId]);
    } catch (error) {
      if (isNoSuchContainer(error)) throw new ContainerNotFoundError();
      throw error;
    }
  }

  // ponytail: one full listing per pass, since absence checks need every id. Add a label filter if hosts carry many containers.
  async function listAll(): Promise<DockerInventory> {
    const { stdout } = await exec(["ps", "--all", "--no-trunc", "--format", "{{json .}}"]);
    const containerIds = new Set<string>();
    const owned: OwnedContainer[] = [];
    const fences: FenceContainer[] = [];
    for (const line of stdout.split("\n")) {
      if (line.trim() === "") continue;
      const listed = parseListing(line);
      containerIds.add(listed.id);
      const container = ownedContainerOf(listed);
      if (container !== undefined) owned.push(container);
      const fence = fenceOf(listed);
      if (fence !== undefined) fences.push(fence);
    }
    return { containerIds, owned, fences };
  }

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
      await checkSandboxNetwork(exec);
    },

    async runSandbox(sandboxId, workspace) {
      const args = buildRunArgs(sandboxId, options.image, options.limits, workspace);
      let stdout: string;
      try {
        ({ stdout } = await exec(args));
      } catch (error) {
        throw runFailure(error);
      }
      const containerId = stdout.trim();
      if (!CONTAINER_ID_PATTERN.test(containerId)) throw new RunOutcomeUnknownError();
      return containerId;
    },

    async removeSandbox(containerId) {
      if (!CONTAINER_ID_PATTERN.test(containerId)) throw new Error("invalid container id");
      await forceRemove(containerId);
    },

    async fenceSandbox(sandboxId) {
      try {
        await exec(buildFenceArgs(sandboxId, options.image));
        return;
      } catch (error) {
        if (!isNameConflict(error)) throw new FenceUnknownError();
      }
      // The name is taken. It is this sandbox's fence if the listing shows one, and otherwise another container holds it.
      let inventory: DockerInventory;
      try {
        inventory = await listAll();
      } catch {
        throw new FenceUnknownError();
      }
      if (inventory.fences.some((fence) => fence.sandboxId === sandboxId)) return;
      throw new NameHeldError();
    },

    inventory: listAll,

    async launchRuntime(containerId, sessionContext) {
      if (!CONTAINER_ID_PATTERN.test(containerId)) throw new Error("invalid container id");
      await launchSession(spawnDocker, launchTimeoutMs, containerId, `${sessionContext}\n`);
    },
  };
}

/**
 * Sorts a failed `docker run`. Only a run whose CLI was never spawned is provably unsent, and only docker's structured
 * refusal is a definitive answer. Anything else may have reached the daemon, so its container may exist now or appear later.
 */
function runFailure(error: unknown): Error {
  // Ended by the executor or a signal: docker may still be creating the container.
  if (isKilled(error)) return new RunOutcomeUnknownError();
  if (isNotInstalled(error)) return new RunNotStartedError();
  if (isDaemonRefusal(error)) return new RunRejectedByDaemonError();
  return new RunOutcomeUnknownError();
}

interface ListedContainer {
  id: string;
  name: string;
  labels: Map<string, string>;
}

function parseListing(line: string): ListedContainer {
  const entry: unknown = JSON.parse(line);
  if (entry === null || typeof entry !== "object") throw new Error(UNEXPECTED_LISTING);
  const { ID, Names, Labels } = entry as Record<string, unknown>;
  if (typeof ID !== "string" || typeof Names !== "string") throw new Error(UNEXPECTED_LISTING);
  return { id: ID, name: Names, labels: parseLabels(typeof Labels === "string" ? Labels : "") };
}

/** Parses docker's "key=value,key=value" label text. */
function parseLabels(text: string): Map<string, string> {
  const labels = new Map<string, string>();
  for (const pair of text.split(",")) {
    const at = pair.indexOf("=");
    if (at > 0) labels.set(pair.slice(0, at), pair.slice(at + 1));
  }
  return labels;
}

/**
 * The container this executor owns, or undefined. Owned means labelled by this executor, with a valid
 * sandbox id, under the name that id gives. Its workspace slot is the one its label names, if valid.
 */
function ownedContainerOf(listed: ListedContainer): OwnedContainer | undefined {
  if (!CONTAINER_ID_PATTERN.test(listed.id)) return undefined;
  if (listed.labels.get(OWNER_LABEL) !== OWNER_VALUE) return undefined;
  const sandboxId = listed.labels.get(SANDBOX_LABEL);
  if (sandboxId === undefined || !SANDBOX_ID_PATTERN.test(sandboxId)) return undefined;
  if (listed.name !== containerName(sandboxId)) return undefined;
  const slot = listed.labels.get(SLOT_LABEL);
  const workspaceSlot =
    slot !== undefined && SLOT_VALUE_PATTERN.test(slot) && Number(slot) < WORKSPACE_SLOT_COUNT
      ? Number(slot)
      : null;
  return { containerId: listed.id, sandboxId, workspaceSlot };
}

/**
 * The fence this executor placed under a sandbox id's name: labelled as a fence, and named for its sandbox id. Owner
 * labels are never on a fence, so it is not owned, and nothing adopts or counts it.
 */
function fenceOf(listed: ListedContainer): FenceContainer | undefined {
  if (!CONTAINER_ID_PATTERN.test(listed.id)) return undefined;
  if (listed.labels.get(FENCE_LABEL) !== FENCE_VALUE) return undefined;
  const sandboxId = listed.name.startsWith(CONTAINER_NAME_PREFIX)
    ? listed.name.slice(CONTAINER_NAME_PREFIX.length)
    : "";
  if (!SANDBOX_ID_PATTERN.test(sandboxId)) return undefined;
  return { containerId: listed.id, sandboxId };
}

/**
 * Proves the sandbox network keeps sandboxes apart: a bridge with inter-container communication explicitly off and no
 * IPv6. A network that is missing or differs is refused before any create, so nothing runs on it.
 */
async function checkSandboxNetwork(exec: DockerExec): Promise<void> {
  let network: unknown;
  try {
    const { stdout } = await exec([
      "network",
      "inspect",
      SANDBOX_NETWORK,
      "--format",
      "{{json .}}",
    ]);
    network = JSON.parse(stdout);
  } catch {
    throw new IsolationUnavailableError();
  }
  if (!isolatedNetwork(network)) throw new IsolationUnavailableError();
}

/** True for the sandbox network as the host contract provisions it: a bridge, ICC off, and IPv6 off. */
function isolatedNetwork(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const { Driver, EnableIPv6, Options } = value as Record<string, unknown>;
  if (Driver !== "bridge" || EnableIPv6 !== false) return false;
  if (Options === null || typeof Options !== "object") return false;
  return (Options as Record<string, unknown>)[ICC_OPTION] === "false";
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
          reject(
            Object.assign(new Error(`docker ${args[0]} failed`), {
              stderr: String(stderr),
              killed: error.killed === true,
              signal: error.signal ?? null,
              code: error.code,
            })
          );
          return;
        }
        resolve({ stdout: String(stdout) });
      }
    );
  });
}

/** Real docker CLI spawn for a launch: argv only, no shell, stdin piped. */
function spawnDockerCli(args: readonly string[]): ChildProcessWithoutNullStreams {
  return spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
}

/**
 * Execs the runtime's session entry in a holding container and writes the context to its stdin. Resolves on the
 * acceptance line, the only proof a supervisor started. The rest of the process's output is drained and never
 * kept. The context reaches the process through stdin alone: it is not in argv, and no error here carries it.
 */
function launchSession(
  spawnDocker: SpawnDocker,
  timeoutMs: number,
  containerId: string,
  line: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnDocker([
      "exec",
      "-i",
      containerId,
      RUNTIME_PYTHON,
      "-m",
      "sandbox_runtime.entrypoint",
      SESSION_CONTEXT_ARGUMENT,
    ]);
    let accepted = false;
    let settled = false;
    let pending = "";
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new RuntimeLaunchUnknownError());
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (text: string) => {
      if (accepted) return;
      const lines = (pending + text).split("\n");
      pending = lines.pop() ?? "";
      if (lines.some((candidate) => candidate.trim() === SESSION_CONTEXT_ACCEPTED_LINE)) {
        accepted = true;
        finish();
      } else if (pending.length > MAX_STDOUT_LINE_CHARS) {
        pending = "";
      }
    });
    // Drained, never read: the runtime keeps logging to these streams for the whole session.
    child.stderr.resume();
    // A runtime that exits before reading stdin is judged by its exit, not by this write.
    child.stdin.on("error", () => {});
    child.stdin.end(line);
    child.on("error", () => finish(new RuntimeLaunchUnknownError()));
    // Close, not exit: stdout is read to its end first, so an acceptance line in the last chunk still counts.
    child.on("close", (_code, signal) =>
      finish(signal === null ? new RuntimeRefusedError() : new RuntimeLaunchUnknownError())
    );
  });
}

/** execFile stopped docker itself (a timeout, or output over the buffer limit), or a signal did. */
function isKilled(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    ("killed" in error && error.killed === true) || ("signal" in error && error.signal != null)
  );
}

/** The CLI binary was not found, so nothing was spawned and the run was never sent. */
function isNotInstalled(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

// docker's own error line. A dropped connection or a spawn error never prints it.
const DAEMON_REFUSAL = /^(?:docker: )?Error response from daemon: \S/m;
// Output that shows the request may not have been answered. Such output is never a refusal, even beside a daemon line.
const TRANSPORT_FAILURE =
  /error during connect|cannot connect to the docker daemon|unexpected EOF|connection (?:reset|refused|closed)|broken pipe|context (?:canceled|deadline exceeded)|i\/o timeout/i;

/** The CLI exited with its own status, and its stderr is the daemon's structured refusal with no transport failure. */
function isDaemonRefusal(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "number")
    return false;
  if (!("stderr" in error)) return false;
  const stderr = String(error.stderr);
  return DAEMON_REFUSAL.test(stderr) && !TRANSPORT_FAILURE.test(stderr);
}

/** docker's own refusal, and the refusal is that the name is taken. The daemon created nothing under the name. */
function isNameConflict(error: unknown): boolean {
  return (
    isDaemonRefusal(error) &&
    error instanceof Error &&
    "stderr" in error &&
    NAME_CONFLICT.test(String(error.stderr))
  );
}

function isNoSuchContainer(error: unknown): boolean {
  return (
    error instanceof Error &&
    "stderr" in error &&
    String(error.stderr).includes("No such container")
  );
}

function assertSandboxId(sandboxId: string): void {
  if (!SANDBOX_ID_PATTERN.test(sandboxId)) throw new Error("invalid sandbox id");
}

function assertImage(image: string): void {
  if (!IMAGE_PATTERN.test(image)) throw new Error("invalid sandbox image reference");
}

function assertWorkspace(workspace: WorkspaceMount): void {
  const { slot, hostPath } = workspace;
  if (
    !Number.isSafeInteger(slot) ||
    slot < 0 ||
    slot >= WORKSPACE_SLOT_COUNT ||
    basename(hostPath) !== String(slot) ||
    !isMountSource(hostPath)
  )
    throw new Error("invalid workspace mount");
}

/**
 * A bind source is one CSV field for --mount, so it may not hold a comma, a quote, or a control
 * character. argv goes to execFile without a shell, so spaces are safe.
 */
function isMountSource(hostPath: string): boolean {
  if (hostPath.length === 0 || hostPath.includes(",") || hostPath.includes('"')) return false;
  return ![...hostPath].some((character) => character.charCodeAt(0) < 0x20);
}

function assertLimits(limits: SandboxLimits): void {
  if (!CPUS_PATTERN.test(limits.cpus) || Number(limits.cpus) <= 0)
    throw new Error("invalid sandbox cpu limit");
  if (!MEMORY_PATTERN.test(limits.memory)) throw new Error("invalid sandbox memory limit");
  if (!Number.isSafeInteger(limits.pidsLimit) || limits.pidsLimit <= 0)
    throw new Error("invalid sandbox pids limit");
}
