import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { admissionSignature } from "../src/admission.ts";
import {
  containerName,
  createDockerRuntime,
  SESSION_CONTEXT_ACCEPTED_LINE,
  type DockerExec,
  type DockerInventory,
  type DockerRuntime,
  type SpawnDocker,
} from "../src/docker.ts";
import { createExecutorServer, reconcileContainers } from "../src/server.ts";
import { MAX_ALLOCATED_SANDBOXES, openStateStore, type StateStore } from "../src/state.ts";
import { resetSlot, WORKSPACE_SLOT_COUNT } from "../src/workspace.ts";
import { FakeExecChild } from "./fake-exec-child.ts";

const TOKEN = "test-executor-token-0123456789abcdef";
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const IMAGE = "open-inspect/sandbox:test";
const LIMITS = { cpus: "2", memory: "4g", pidsLimit: 512 };
const NOW = 1_700_000_000_000;
const ADMISSION_SECRET = "test-admission-secret-0123456789abcdef";
const LEASE_MS = 30_000;
const HOUR_MS = 3_600_000;
const CONTROL_PLANE_URL = "https://cp.example.test";
/** Stands in for a sandbox's auth token. Never a real credential. */
const SYNTHETIC_TOKEN = "synthetic-sandbox-token-7f3a9c2e1b0d4e5f";
// A runtime that never answers its launch fails at this deadline, so the tests that need it stay fast.
const LAUNCH_TIMEOUT_MS = 50;

/** A lease signed the way the control plane signs it, for one session and sandbox. */
function signedLease(
  sandboxId: string,
  sessionId: string,
  leaseToken: string,
  expiresAtMs: number
) {
  const signature = admissionSignature(ADMISSION_SECRET, {
    sessionId,
    sandboxId,
    leaseToken,
    expiresAtMs,
  });
  return { leaseToken, expiresAtMs, signature };
}

/** The runtime context the control plane sends for one sandbox and session, with `extra` added. */
function runtimeContext(
  sandboxId: string,
  sessionId: string,
  extra: Record<string, unknown> = {}
): { env: Record<string, unknown> } {
  return {
    env: {
      PYTHONUNBUFFERED: "1",
      SANDBOX_ID: sandboxId,
      CONTROL_PLANE_URL: CONTROL_PLANE_URL,
      SANDBOX_AUTH_TOKEN: SYNTHETIC_TOKEN,
      SANDBOX_TIMEOUT_SECONDS: "3600",
      REPO_OWNER: "acme",
      REPO_NAME: "widgets",
      SESSION_CONFIG: JSON.stringify({ session_id: sessionId, branch: "main" }),
      ...extra,
    },
  };
}

/** A create body whose lease was claimed at nowMs, and whose runtime context names the same sandbox and session. */
function createBody(sandboxId: string, sessionId: string, leaseToken: string, nowMs = NOW) {
  return {
    sandboxId,
    sessionId,
    admissionLease: signedLease(sandboxId, sessionId, leaseToken, nowMs + LEASE_MS),
    runtimeContext: runtimeContext(sandboxId, sessionId),
  };
}

const CREATE = createBody("sandbox-1", "session-1", "lease-1");

/** The labels this executor gives a container it creates for a sandbox id and workspace slot. */
function ownedLabels(sandboxId: string, workspaceSlot: number): Record<string, string> {
  return {
    "open-inspect.managed": "vps-executor",
    "open-inspect.sandbox-id": sandboxId,
    "open-inspect.workspace-slot": String(workspaceSlot),
  };
}

/**
 * How one `docker run` ends. The killed kinds mirror execFile's error for a timed-out child. killed-late is killed like
 * killed, but the daemon still completes its create, when the test calls landLate.
 */
type RunFate =
  | "ok"
  | "missing"
  | "dropped"
  | "killed"
  | "killed-after-create"
  | "killed-late"
  | "rejected"
  | "rejected-after-create";

/** A failed docker CLI call. A daemon refusal exits 125, as the CLI does; a dropped connection has no exit status. */
function dockerError(stderr: string, code?: number): Error {
  return Object.assign(new Error("docker failed"), { stderr, code });
}

/** The `--label key=value` pairs of a docker run argv. */
function labelsOf(args: readonly string[]): Record<string, string> {
  const labels: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== "--label") continue;
    const [key, ...value] = args[i + 1].split("=");
    labels[key] = value.join("=");
  }
  return labels;
}

/** The `--mount` values of a docker run argv, each one `type=bind,source=<path>,target=<path>`. */
function mountsOf(args: readonly string[]): string[] {
  const mounts: string[] = [];
  for (let i = 0; i < args.length; i += 1) if (args[i] === "--mount") mounts.push(args[i + 1]);
  return mounts;
}

/**
 * How one runtime launch ends: accepted (its acceptance line), refused (it exits first), signalled (a signal ends
 * it), or silent (it never answers, so the launch deadline ends it).
 */
type LaunchFate = "accepted" | "refused" | "signalled" | "silent";

/** A fake docker daemon: named containers with unique names, and scripted run and launch outcomes. */
class FakeDocker {
  /** Every argv the executor sent, in order. */
  readonly calls: string[][] = [];
  /** Containers by name, with the mounts each was created with. Kept across an executor restart, as a daemon keeps them. */
  readonly containers = new Map<
    string,
    { id: string; labels: Record<string, string>; mounts: string[] }
  >();
  /** Every runtime launch: its argv, and the child that received the context on stdin. */
  readonly launches: { args: string[]; child: FakeExecChild }[] = [];
  gvisor = true;
  /** Fates of the next `docker run` calls, in order. Later runs succeed. */
  runFates: RunFate[] = [];
  /** Fates of the next runtime launches, in order. Later launches are accepted. */
  launchFates: LaunchFate[] = [];
  /** When set, `docker rm` fails as if the daemon were unreachable. */
  removeFails = false;
  /** When set, `docker ps` fails as if the daemon were unreachable. */
  listFails = false;
  /** The sandbox network's properties, as `docker network inspect` reports them. Unset ICC is a network with no ICC option. */
  icc: string | undefined = "false";
  ipv6 = false;
  /** Fates of the next fence creates, in order. Later fences succeed. */
  fenceFates: ("ok" | "dropped" | "rejected")[] = [];
  /** Creates docker still owes: their CLI was killed, and landLate lets the daemon finish them. */
  private readonly lateCreates: {
    name: string;
    labels: Record<string, string>;
    mounts: string[];
  }[] = [];
  /** Called with each run's argv before it answers. */
  onRun: (args: readonly string[]) => Promise<void> | void = () => {};
  private nextId = 1;

  readonly exec: DockerExec = async (args) => {
    this.calls.push([...args]);
    if (args[0] === "info")
      return { stdout: JSON.stringify(this.gvisor ? { runc: {}, runsc: {} } : { runc: {} }) };
    if (args[0] === "run") return this.run(args);
    if (args[0] === "rm") return this.remove(args[2]);
    if (args[0] === "ps") return this.list();
    if (args[0] === "network") return this.network();
    if (args[0] === "create") return this.fence(args);
    throw new Error(`unexpected docker call: ${args[0]}`);
  };

  readonly spawnDocker: SpawnDocker = (args) => {
    const fate = this.launchFates.shift() ?? "accepted";
    const child = new FakeExecChild((exec) => {
      if (fate === "accepted") exec.stdout.write(`booting\n${SESSION_CONTEXT_ACCEPTED_LINE}\n`);
      if (fate === "refused") exec.finish(1, null);
      if (fate === "signalled") exec.finish(null, "SIGKILL");
    });
    this.launches.push({ args: [...args], child });
    return child.asChildProcess();
  };

  runs(): string[][] {
    return this.calls.filter((args) => args[0] === "run");
  }

  /** Creates a container the way a daemon would, and returns its id. Tests use it to place a container directly. */
  land(name: string, labels: Record<string, string>, mounts: string[] = []): string {
    const id = (this.nextId++).toString(16).padStart(64, "0");
    this.containers.set(name, { id, labels, mounts });
    return id;
  }

  /**
   * Lets docker finish a create whose CLI was killed. A name a fence or another container holds refuses it, as docker
   * does, so the create lands nothing under that name.
   */
  landLate(): "landed" | "refused" {
    const late = this.lateCreates.shift();
    if (late === undefined) throw new Error("no late create is pending");
    if (this.containers.has(late.name)) return "refused";
    this.land(late.name, late.labels, late.mounts);
    return "landed";
  }

  private async run(args: readonly string[]): Promise<{ stdout: string }> {
    await this.onRun(args);
    const name = args[args.indexOf("--name") + 1];
    const fate = this.runFates.shift() ?? "ok";
    if (fate === "killed-late") {
      this.lateCreates.push({ name, labels: labelsOf(args), mounts: mountsOf(args) });
      throw Object.assign(new Error("docker run timed out"), { killed: true, signal: "SIGTERM" });
    }
    if (fate === "missing")
      throw Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" });
    // The connection dropped before docker answered. Nothing is created here: a test lands it later.
    if (fate === "dropped")
      throw dockerError('error during connect: Post "http://docker/v1.47/containers/create": EOF');
    if (this.containers.has(name))
      throw dockerError(
        `docker: Error response from daemon: Conflict. The container name "/${name}" is already in use`,
        125
      );
    const created = fate === "ok" || fate.endsWith("after-create");
    const id = created ? this.land(name, labelsOf(args), mountsOf(args)) : "";
    if (fate === "ok") return { stdout: `${id}\n` };
    if (fate.startsWith("killed"))
      throw Object.assign(new Error("docker run timed out"), { killed: true, signal: "SIGTERM" });
    // The daemon's own refusal, after a normal exit. A create that made a container first fails the same way.
    throw dockerError("docker: Error response from daemon: failed to start", 125);
  }

  /** `docker create` under a sandbox's name, the fence. A name another container holds is refused, as docker refuses it. */
  private fence(args: readonly string[]): { stdout: string } {
    const name = args[args.indexOf("--name") + 1];
    const fate = this.fenceFates.shift() ?? "ok";
    if (fate === "dropped")
      throw dockerError('error during connect: Post "http://docker/v1.47/containers/create": EOF');
    if (fate === "rejected")
      throw dockerError("docker: Error response from daemon: No such image", 125);
    if (this.containers.has(name))
      throw dockerError(
        `docker: Error response from daemon: Conflict. The container name "/${name}" is already in use`,
        125
      );
    return { stdout: `${this.land(name, labelsOf(args))}\n` };
  }

  /** `docker network inspect oi-sandbox`, in the format the executor asks for. */
  private network(): { stdout: string } {
    const options =
      this.icc === undefined ? {} : { "com.docker.network.bridge.enable_icc": this.icc };
    return {
      stdout: `${JSON.stringify({ Name: "oi-sandbox", Driver: "bridge", EnableIPv6: this.ipv6, Options: options })}\n`,
    };
  }

  private remove(reference: string): { stdout: string } {
    if (this.removeFails) throw dockerError("Cannot connect to the Docker daemon");
    const name = [...this.containers].find(
      ([containerName, container]) => containerName === reference || container.id === reference
    )?.[0];
    if (name === undefined)
      throw dockerError(`Error response from daemon: No such container: ${reference}`);
    this.containers.delete(name);
    return { stdout: "" };
  }

  private list(): { stdout: string } {
    if (this.listFails) throw dockerError("Cannot connect to the Docker daemon");
    const lines = [...this.containers].map(([name, container]) =>
      JSON.stringify({
        ID: container.id,
        Names: name,
        Labels: Object.entries(container.labels)
          .map(([key, value]) => `${key}=${value}`)
          .join(","),
      })
    );
    return { stdout: lines.map((line) => `${line}\n`).join("") };
  }
}

interface Executor {
  baseUrl: string;
  docker: FakeDocker;
  clock: { nowMs: number };
  stateFile: string;
  store: StateStore;
  runtime: DockerRuntime;
  close(): Promise<void>;
}

/** The host path of a workspace slot, in the state directory that holds `stateFile`. */
function slotPathOf(stateFile: string, slot: number): string {
  return join(dirname(stateFile), "slots", String(slot));
}

/**
 * Runs the real server against a fake docker daemon and the given state file. Its slots are the state
 * directory's. The host check passes unless a test overrides it.
 */
async function startExecutor(
  stateFile: string,
  docker = new FakeDocker(),
  clock = { nowMs: NOW },
  options: {
    checkWorkspace?: (hostPath: string) => Promise<void>;
    repairWorkspace?: (hostPath: string) => Promise<void>;
    repairHome?: (slotPath: string) => Promise<void>;
    prepareHome?: (slotPath: string) => Promise<void>;
    resetWorkspace?: (hostPath: string) => Promise<void>;
  } = {}
): Promise<Executor> {
  const runtime = createDockerRuntime({
    exec: docker.exec,
    spawnDocker: docker.spawnDocker,
    launchTimeoutMs: LAUNCH_TIMEOUT_MS,
    image: IMAGE,
    limits: LIMITS,
  });
  const store = await openStateStore(stateFile);
  const server = createExecutorServer({
    token: TOKEN,
    admissionSecret: ADMISSION_SECRET,
    runtime,
    store,
    workspaceRoot: join(dirname(stateFile), "slots"),
    controlPlaneUrl: CONTROL_PLANE_URL,
    checkWorkspace: options.checkWorkspace ?? (async () => {}),
    repairWorkspace: options.repairWorkspace ?? (async () => {}),
    repairHome: options.repairHome ?? (async () => {}),
    prepareHome: options.prepareHome ?? (async () => {}),
    resetWorkspace: options.resetWorkspace,
    now: () => clock.nowMs,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    docker,
    clock,
    stateFile,
    store,
    runtime,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      });
      store.close();
    },
  };
}

/** A state directory for one test, with every workspace slot directory. Tests that restart the executor reuse it. */
async function withStateDir(run: (stateFile: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "vps-executor-"));
  try {
    for (let slot = 0; slot < WORKSPACE_SLOT_COUNT; slot += 1)
      await mkdir(join(dir, "slots", String(slot)), { recursive: true });
    await run(join(dir, "state.db"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withExecutor(run: (executor: Executor) => Promise<void>): Promise<void> {
  await withStateDir(async (stateFile) => {
    const executor = await startExecutor(stateFile);
    try {
      await run(executor);
    } finally {
      await executor.close();
    }
  });
}

/** Opens the state file directly, as another process would. Used to inject write failures and to inspect rows. */
function withRawDb<T>(stateFile: string, run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(stateFile);
  try {
    return run(db);
  } finally {
    db.close();
  }
}

function request(
  executor: Executor,
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {}
): Promise<Response> {
  const { body, headers = AUTH } = options;
  return fetch(`${executor.baseUrl}${path}`, {
    method,
    headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createSandbox(executor: Executor, body: unknown = CREATE): Promise<string> {
  const res = await request(executor, "POST", "/v1/sandboxes", { body });
  assert.equal(res.status, 201);
  return ((await res.json()) as { providerObjectId: string }).providerObjectId;
}

function hasFlag(args: string[], flag: string, value: string): boolean {
  const index = args.indexOf(flag);
  return index !== -1 && args[index + 1] === value;
}

describe("runtime context and launch", () => {
  it("creates a deferred holding container, then launches the runtime with the context on stdin only", async () => {
    await withExecutor(async (executor) => {
      const providerObjectId = await createSandbox(executor);
      const [run] = executor.docker.runs();
      assert.ok(run.some((arg, i) => arg === "-e" && run[i + 1] === "OI_DEFERRED_START=true"));
      assert.equal(executor.docker.launches.length, 1);
      const [launch] = executor.docker.launches;
      assert.deepEqual(launch.args, [
        "exec",
        "-i",
        providerObjectId,
        "/opt/openinspect/python/bin/python",
        "-m",
        "sandbox_runtime.entrypoint",
        "--session-context-stdin-v1",
      ]);
      const frame = JSON.parse(launch.child.input.join(""));
      assert.equal(frame.version, 1);
      assert.equal(frame.sandbox_id, "sandbox-1");
      assert.equal(frame.session_id, "session-1");
      assert.equal(frame.env.SANDBOX_AUTH_TOKEN, SYNTHETIC_TOKEN);
      assert.equal(launch.child.input.join("").endsWith("\n"), true);
      const argv = [...executor.docker.calls, ...executor.docker.launches.map((item) => item.args)];
      assert.equal(JSON.stringify(argv).includes(SYNTHETIC_TOKEN), false);
    });
  });

  it("refuses a context that is malformed or names another sandbox, session or control plane, before reserving anything", async () => {
    await withExecutor(async (executor) => {
      const withEnv = (env: Record<string, unknown>) => ({
        ...CREATE,
        runtimeContext: runtimeContext("sandbox-1", "session-1", env),
      });
      const cases: [string, unknown, number, string][] = [
        ["no context", { ...CREATE, runtimeContext: undefined }, 400, "invalid_runtime_context"],
        [
          "an env that is not an object",
          { ...CREATE, runtimeContext: { env: [] } },
          400,
          "invalid_runtime_context",
        ],
        ["a lowercase key", withEnv({ lower: "x" }), 400, "invalid_runtime_context"],
        ["a non-string value", withEnv({ NUMERIC: 1 }), 400, "invalid_runtime_context"],
        ["an executor-owned key", withEnv({ OI_DEFERRED_START: "false" }), 400, "reserved_env_key"],
        ["nested Docker", withEnv({ OPENINSPECT_DOCKER_ENABLED: "true" }), 400, "reserved_env_key"],
        ["an empty token", withEnv({ SANDBOX_AUTH_TOKEN: "" }), 400, "invalid_runtime_context"],
        [
          "another sandbox",
          { ...CREATE, runtimeContext: runtimeContext("sandbox-2", "session-1") },
          403,
          "runtime_context_mismatch",
        ],
        [
          "another session",
          { ...CREATE, runtimeContext: runtimeContext("sandbox-1", "session-2") },
          403,
          "runtime_context_mismatch",
        ],
        [
          "another control plane",
          withEnv({ CONTROL_PLANE_URL: "https://evil.example.test" }),
          403,
          "runtime_context_mismatch",
        ],
      ];
      for (const [name, body, status, code] of cases) {
        const res = await request(executor, "POST", "/v1/sandboxes", { body });
        assert.equal(res.status, status, name);
        assert.deepEqual(await res.json(), { error: code }, name);
      }
      // Nothing was reserved or started, so the same lease still creates.
      assert.equal(executor.docker.runs().length, 0);
      assert.equal(executor.docker.launches.length, 0);
      await createSandbox(executor);
    });
  });

  it("bounds each value and the whole context, and refuses past either bound", async () => {
    await withExecutor(async (executor) => {
      const oversizedValue = runtimeContext("sandbox-1", "session-1", {
        BIG: "x".repeat(65 * 1024),
      });
      const oversizedTotal = runtimeContext(
        "sandbox-1",
        "session-1",
        Object.fromEntries(Array.from({ length: 4 }, (_, n) => [`BIG_${n}`, "x".repeat(60 * 1024)]))
      );
      const tooManyKeys = runtimeContext(
        "sandbox-1",
        "session-1",
        Object.fromEntries(Array.from({ length: 257 }, (_, n) => [`KEY_${n}`, "v"]))
      );
      for (const runtimeContextBody of [oversizedValue, oversizedTotal, tooManyKeys]) {
        const res = await request(executor, "POST", "/v1/sandboxes", {
          body: { ...CREATE, runtimeContext: runtimeContextBody },
        });
        assert.equal(res.status, 413);
        assert.deepEqual(await res.json(), { error: "runtime_context_too_large" });
      }
      assert.equal(executor.docker.runs().length, 0);
    });
  });

  it("stops a runtime that refuses its context, releases its slot and workspace, and lets the create be retried", async () => {
    await withExecutor(async (executor) => {
      executor.docker.launchFates = ["refused"];
      const failed = await request(executor, "POST", "/v1/sandboxes", { body: CREATE });
      assert.equal(failed.status, 502);
      assert.deepEqual(await failed.json(), { error: "runtime_start_failed" });
      assert.equal(executor.docker.containers.size, 0);
      assert.equal(executor.store.byLease("lease-1"), undefined);
      assert.equal(executor.store.occupancy(), 0);
      await createSandbox(executor);
    });
  });

  it("holds the slot and workspace of a launch that ends unknown until docker proves the container gone", async () => {
    await withExecutor(async (executor) => {
      executor.docker.launchFates = ["silent"];
      const timedOut = await request(executor, "POST", "/v1/sandboxes", { body: CREATE });
      assert.equal(timedOut.status, 502);
      assert.equal(executor.docker.containers.size, 0);
      assert.equal(executor.store.byLease("lease-1"), undefined);

      executor.docker.launchFates = ["signalled"];
      executor.docker.removeFails = true;
      const held = await request(executor, "POST", "/v1/sandboxes", { body: CREATE });
      assert.equal(held.status, 503);
      assert.deepEqual(await held.json(), { error: "create_unresolved" });
      assert.equal(executor.store.byLease("lease-1")?.status, "unresolved");
      assert.equal(executor.store.occupancy(), 1);
    });
  });

  it("keeps the session token out of logs, docker argv, the state file and every error body", async () => {
    await withStateDir(async (stateFile) => {
      const executor = await startExecutor(stateFile);
      const logged: string[] = [];
      const bodies: string[] = [];
      const { log, error } = console;
      const capture = (...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      };
      console.log = capture;
      console.error = capture;
      try {
        executor.docker.launchFates = ["refused", "signalled"];
        executor.docker.removeFails = true;
        const refused = await request(executor, "POST", "/v1/sandboxes", { body: CREATE });
        bodies.push(await refused.text());
        const unresolved = await request(executor, "POST", "/v1/sandboxes", { body: CREATE });
        bodies.push(await unresolved.text());
        const invalid = await request(executor, "POST", "/v1/sandboxes", {
          body: {
            ...CREATE,
            sandboxId: "sandbox-9",
            runtimeContext: runtimeContext("sandbox-9", "session-9", {
              OI_DEFERRED_START: SYNTHETIC_TOKEN,
            }),
          },
        });
        bodies.push(await invalid.text());
      } finally {
        console.log = log;
        console.error = error;
        await executor.close();
      }
      // The token did reach the runtime, on stdin.
      assert.ok(executor.docker.launches[0].child.input.join("").includes(SYNTHETIC_TOKEN));
      const sqlite = [stateFile, `${stateFile}-wal`];
      const onDisk = await Promise.all(
        sqlite.map((path) => readFile(path).catch(() => Buffer.alloc(0)))
      );
      const surfaces = [
        JSON.stringify(executor.docker.calls),
        JSON.stringify(executor.docker.launches.map((launch) => launch.args)),
        logged.join("\n"),
        bodies.join("\n"),
        ...onDisk.map((buffer) => buffer.toString("latin1")),
      ];
      for (const surface of surfaces) assert.equal(surface.includes(SYNTHETIC_TOKEN), false);
    });
  });
});

describe("executor HTTP API", () => {
  it("reports health from the runsc check, without auth", async () => {
    await withExecutor(async (executor) => {
      const res = await request(executor, "GET", "/v1/health", { headers: {} });
      assert.equal(res.status, 200);
      executor.docker.gvisor = false;
      const down = await request(executor, "GET", "/v1/health", { headers: {} });
      assert.equal(down.status, 503);
    });
  });

  it("requires the bearer token on every sandbox endpoint", async () => {
    await withExecutor(async (executor) => {
      const wrong = { Authorization: "Bearer not-the-token" };
      const create = await request(executor, "POST", "/v1/sandboxes", {
        body: CREATE,
        headers: {},
      });
      assert.equal(create.status, 401);
      assert.equal(create.headers.get("www-authenticate"), "Bearer");
      const wrongCreate = await request(executor, "POST", "/v1/sandboxes", {
        body: CREATE,
        headers: wrong,
      });
      assert.equal(wrongCreate.status, 401);
      const resolve = await request(executor, "GET", "/v1/sandboxes/sandbox-1", { headers: {} });
      assert.equal(resolve.status, 401);
      const stop = await request(executor, "POST", "/v1/sandboxes/abc/stop", {
        body: { reason: "test" },
        headers: {},
      });
      assert.equal(stop.status, 401);
      assert.deepEqual(executor.docker.calls, []);
    });
  });

  it("refuses create without a future admission lease before touching docker", async () => {
    await withExecutor(async (executor) => {
      const missing = await request(executor, "POST", "/v1/sandboxes", {
        body: { ...CREATE, admissionLease: undefined },
      });
      assert.equal(missing.status, 403);
      assert.deepEqual(await missing.json(), { error: "admission_missing" });

      const expired = {
        ...CREATE,
        admissionLease: signedLease("sandbox-1", "session-1", "lease-1", NOW),
      };
      const res = await request(executor, "POST", "/v1/sandboxes", { body: expired });
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), { error: "admission_expired" });
      assert.deepEqual(executor.docker.calls, []);
    });
  });

  it("refuses a lease that is forged or signed for another sandbox before touching docker", async () => {
    await withExecutor(async (executor) => {
      const forged = {
        ...CREATE,
        admissionLease: { ...CREATE.admissionLease, signature: "0".repeat(64) },
      };
      const otherSandbox = { ...CREATE, sandboxId: "sandbox-2" };
      for (const body of [forged, otherSandbox]) {
        const res = await request(executor, "POST", "/v1/sandboxes", { body });
        assert.equal(res.status, 403);
        assert.deepEqual(await res.json(), { error: "admission_invalid" });
      }
      assert.deepEqual(executor.docker.calls, []);
    });
  });

  it("fails closed when docker has no runsc runtime, and does not spend the lease", async () => {
    await withExecutor(async (executor) => {
      executor.docker.gvisor = false;
      const res = await request(executor, "POST", "/v1/sandboxes", { body: CREATE });
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { error: "isolation_unavailable" });
      assert.deepEqual(
        executor.docker.calls.map((args) => args[0]),
        ["info"]
      );
      executor.docker.gvisor = true;
      await createSandbox(executor);
    });
  });

  it("creates under runsc with explicit limits, then resolves and stops", async () => {
    await withExecutor(async (executor) => {
      const providerObjectId = await createSandbox(executor);
      assert.match(providerObjectId, /^[0-9a-f]{64}$/);

      const runArgs = executor.docker.runs()[0];
      assert.ok(hasFlag(runArgs, "--runtime", "runsc"));
      assert.ok(hasFlag(runArgs, "--cpus", "2"));
      assert.ok(hasFlag(runArgs, "--memory", "4g"));
      assert.ok(hasFlag(runArgs, "--pids-limit", "512"));
      assert.ok(hasFlag(runArgs, "--user", "1000:1000"));
      assert.ok(
        hasFlag(
          runArgs,
          "--mount",
          `type=bind,source=${slotPathOf(executor.stateFile, 0)},target=/workspace`
        )
      );

      const resolved = await request(executor, "GET", "/v1/sandboxes/sandbox-1");
      assert.deepEqual(await resolved.json(), { sandboxId: "sandbox-1", providerObjectId });

      const stopped = await request(executor, "POST", `/v1/sandboxes/${providerObjectId}/stop`, {
        body: { reason: "test" },
      });
      assert.equal(stopped.status, 200);
      assert.deepEqual(executor.docker.calls.at(-1), ["rm", "-f", providerObjectId]);

      assert.equal((await request(executor, "GET", "/v1/sandboxes/sandbox-1")).status, 404);
      const callsBefore = executor.docker.calls.length;
      const again = await request(executor, "POST", `/v1/sandboxes/${providerObjectId}/stop`, {
        body: { reason: "again" },
      });
      assert.equal(again.status, 404);
      assert.deepEqual(await again.json(), { error: "sandbox_not_found" });
      // A terminated container is known gone, so the answer asks docker nothing.
      assert.equal(executor.docker.calls.length, callsBefore);
    });
  });

  it("answers an identical retry from the same allocation, without a second container", async () => {
    await withExecutor(async (executor) => {
      const providerObjectId = await createSandbox(executor);
      const again = await request(executor, "POST", "/v1/sandboxes", { body: CREATE });
      assert.equal(again.status, 200);
      assert.deepEqual(await again.json(), { providerObjectId });
      assert.equal(executor.docker.runs().length, 1);
    });
  });

  it("lets only one of two concurrent identical creates start a container", async () => {
    await withExecutor(async (executor) => {
      const responses = await Promise.all([
        request(executor, "POST", "/v1/sandboxes", { body: CREATE }),
        request(executor, "POST", "/v1/sandboxes", { body: CREATE }),
      ]);
      const outcomes = await Promise.all(
        responses.map(async (res) => ({ status: res.status, body: (await res.json()) as object }))
      );
      assert.ok(outcomes.every(({ status }) => [200, 201, 409].includes(status)));
      const ids = new Set(
        outcomes
          .filter(({ status }) => status === 200 || status === 201)
          .map(({ body }) => (body as { providerObjectId: string }).providerObjectId)
      );
      assert.equal(ids.size, 1);
      assert.equal(executor.docker.runs().length, 1);
    });
  });

  it("admits two concurrent creates and refuses a third before docker runs", async () => {
    await withExecutor(async (executor) => {
      const bodies = [1, 2, 3].map((n) => createBody(`sandbox-${n}`, `session-${n}`, `lease-${n}`));
      const responses = await Promise.all(
        bodies.map((body) => request(executor, "POST", "/v1/sandboxes", { body }))
      );
      const statuses = await Promise.all(
        responses.map(async (res) => ({ status: res.status, body: (await res.json()) as object }))
      );
      assert.deepEqual(statuses.map(({ status }) => status).sort(), [201, 201, 503]);
      const refused = statuses.find(({ status }) => status === 503);
      assert.deepEqual(refused?.body, { error: "capacity_exhausted" });
      assert.equal(executor.docker.runs().length, 2);
    });
  });

  it("refuses another session that reuses a live sandbox id, without a second container", async () => {
    await withExecutor(async (executor) => {
      await createSandbox(executor);
      const other = createBody("sandbox-1", "session-2", "lease-2");
      const res = await request(executor, "POST", "/v1/sandboxes", { body: other });
      assert.equal(res.status, 409);
      assert.deepEqual(await res.json(), { error: "sandbox_id_conflict" });
      assert.equal(executor.docker.runs().length, 1);
    });
  });

  it("refuses a spent lease after its sandbox stops, also across a restart and across sessions", async () => {
    await withStateDir(async (stateFile) => {
      const docker = new FakeDocker();
      const first = await startExecutor(stateFile, docker);
      const providerObjectId = await createSandbox(first);
      const stopped = await request(first, "POST", `/v1/sandboxes/${providerObjectId}/stop`, {
        body: { reason: "done" },
      });
      assert.equal(stopped.status, 200);
      await first.close();

      const second = await startExecutor(stateFile, docker);
      try {
        const replay = await request(second, "POST", "/v1/sandboxes", { body: CREATE });
        assert.equal(replay.status, 403);
        assert.deepEqual(await replay.json(), { error: "admission_replayed" });

        const otherOwner = createBody("sandbox-1", "session-2", "lease-1");
        const crossOwner = await request(second, "POST", "/v1/sandboxes", { body: otherOwner });
        assert.equal(crossOwner.status, 403);
        assert.deepEqual(await crossOwner.json(), { error: "admission_replayed" });
        assert.equal(docker.runs().length, 1);
      } finally {
        await second.close();
      }
    });
  });

  it("keeps an ambiguous create's slot, and accounts its container once docker shows it", async () => {
    await withExecutor(async (executor) => {
      const { docker, clock } = executor;
      docker.runFates = ["killed-after-create"];
      const ambiguous = await request(executor, "POST", "/v1/sandboxes", { body: CREATE });
      assert.equal(ambiguous.status, 503);
      assert.deepEqual(await ambiguous.json(), { error: "create_unresolved" });
      // A container may exist, so the control plane must not read the sandbox as absent.
      assert.equal((await request(executor, "GET", "/v1/sandboxes/sandbox-1")).status, 503);

      await createSandbox(executor, createBody("sandbox-2", "session-2", "lease-2"));

      // The cap is full. Reconciliation attaches the container docker shows under sandbox-1, and that
      // container holds its slot, so the new create is refused.
      const refused = await request(executor, "POST", "/v1/sandboxes", {
        body: createBody("sandbox-3", "session-3", "lease-3", clock.nowMs),
      });
      assert.equal(refused.status, 503);
      assert.deepEqual(await refused.json(), { error: "capacity_exhausted" });

      // Time alone frees nothing.
      clock.nowMs += HOUR_MS;
      const stillRefused = await request(executor, "POST", "/v1/sandboxes", {
        body: createBody("sandbox-3", "session-3", "lease-3", clock.nowMs),
      });
      assert.equal(stillRefused.status, 503);

      // The late container is accounted but never acknowledged, so it does not read as running. The control
      // plane settles the lease to learn the container, and stops it by id.
      assert.equal((await request(executor, "GET", "/v1/sandboxes/sandbox-1")).status, 503);
      const providerObjectId = await settledPresent(
        executor,
        "sandbox-1",
        "session-1",
        "lease-1",
        clock.nowMs
      );

      docker.removeFails = true;
      const failedStop = await request(executor, "POST", `/v1/sandboxes/${providerObjectId}/stop`, {
        body: { reason: "idle" },
      });
      assert.equal(failedStop.status, 502);
      docker.removeFails = false;
      const stopped = await request(executor, "POST", `/v1/sandboxes/${providerObjectId}/stop`, {
        body: { reason: "idle" },
      });
      assert.equal(stopped.status, 200);

      await createSandbox(executor, createBody("sandbox-3", "session-3", "lease-3", clock.nowMs));
      assert.equal(docker.containers.has("oi-sandbox-1"), false);
      assert.equal(docker.runs().length, 3);
    });
  });

  it("does not run an ambiguous create again when its container lands late, and accounts the container", async () => {
    await withExecutor(async (executor) => {
      const { docker } = executor;
      docker.runFates = ["killed"];
      assert.equal(
        (await request(executor, "POST", "/v1/sandboxes", { body: CREATE })).status,
        503
      );

      // Neither a retry under the lease nor a check by name removes or re-runs anything.
      const retry = await request(executor, "POST", "/v1/sandboxes", { body: CREATE });
      assert.equal(retry.status, 503);
      assert.deepEqual(await retry.json(), { error: "create_unresolved" });
      assert.equal(docker.runs().length, 1);
      assert.equal(
        docker.calls.some(([command]) => command === "rm"),
        false
      );

      // The daemon finishes the create after that check.
      const late = docker.land("oi-sandbox-1", ownedLabels("sandbox-1", 0));
      // Accounted, but not running: a retry is still undecided, and settling the lease names the container.
      const accounted = await request(executor, "POST", "/v1/sandboxes", { body: CREATE });
      assert.equal(accounted.status, 503);
      assert.deepEqual(await accounted.json(), { error: "create_unresolved" });
      assert.equal(await settledPresent(executor, "sandbox-1", "session-1", "lease-1"), late);
      assert.equal(docker.runs().length, 1);

      // The late container holds one slot, so the cap still holds.
      await createSandbox(executor, createBody("sandbox-2", "session-2", "lease-2"));
      const refused = await request(executor, "POST", "/v1/sandboxes", {
        body: createBody("sandbox-3", "session-3", "lease-3"),
      });
      assert.equal(refused.status, 503);
    });
  });

  it("keeps a dropped create's slot when nothing is visible and docker completes it late", async () => {
    await withExecutor(async (executor) => {
      const { docker, clock } = executor;
      // The connection drops before docker answers, so a removal by name would find nothing.
      docker.runFates = ["dropped"];
      const dropped = await request(executor, "POST", "/v1/sandboxes", { body: CREATE });
      assert.equal(dropped.status, 503);
      assert.deepEqual(await dropped.json(), { error: "create_unresolved" });
      assert.equal((await request(executor, "GET", "/v1/sandboxes/sandbox-1")).status, 503);

      await createSandbox(executor, createBody("sandbox-2", "session-2", "lease-2"));
      const refusedThird = async (): Promise<void> => {
        const res = await request(executor, "POST", "/v1/sandboxes", {
          body: createBody("sandbox-3", "session-3", "lease-3", clock.nowMs),
        });
        assert.equal(res.status, 503);
        assert.deepEqual(await res.json(), { error: "capacity_exhausted" });
      };
      await refusedThird();

      // docker completes the dropped create after the executor gave up on it.
      const late = docker.land("oi-sandbox-1", ownedLabels("sandbox-1", 0));
      await refusedThird();
      assert.equal(docker.containers.size, 2);

      // The late container is accounted under the dropped lease, and is never run again.
      assert.equal((await request(executor, "GET", "/v1/sandboxes/sandbox-1")).status, 503);
      assert.equal(
        await settledPresent(executor, "sandbox-1", "session-1", "lease-1", clock.nowMs),
        late
      );
      assert.equal(docker.runs().length, 2);
      assert.equal(
        docker.calls.some(([command]) => command === "rm"),
        false
      );

      // Time alone frees nothing.
      clock.nowMs += HOUR_MS;
      await refusedThird();
    });
  });

  it("keeps a slot held by an ambiguous create across a restart, and never re-runs it", async () => {
    await withStateDir(async (stateFile) => {
      const docker = new FakeDocker();
      let markStarted = (): void => {};
      const runStarted = new Promise<void>((resolve) => {
        markStarted = () => resolve();
      });
      // The first run never answers, as if the executor died inside docker run.
      docker.onRun = () => {
        markStarted();
        return new Promise<void>(() => {});
      };
      const crashed = await startExecutor(stateFile, docker);
      const interrupted = request(crashed, "POST", "/v1/sandboxes", { body: CREATE }).catch(
        () => undefined
      );
      await runStarted;
      await crashed.close();
      await interrupted;

      docker.onRun = () => {};
      const restarted = await startExecutor(stateFile, docker);
      try {
        assert.equal((await request(restarted, "GET", "/v1/sandboxes/sandbox-1")).status, 503);
        const retry = await request(restarted, "POST", "/v1/sandboxes", { body: CREATE });
        assert.equal(retry.status, 503);
        assert.deepEqual(await retry.json(), { error: "create_unresolved" });
        assert.equal(docker.runs().length, 1);
        assert.equal(
          docker.calls.some(([command, , target]) => command === "rm" && target === "oi-sandbox-1"),
          false
        );

        await createSandbox(restarted, createBody("sandbox-2", "session-2", "lease-2"));
        const refused = await request(restarted, "POST", "/v1/sandboxes", {
          body: createBody("sandbox-3", "session-3", "lease-3"),
        });
        assert.equal(refused.status, 503);
      } finally {
        await restarted.close();
      }
    });
  });

  it("frees a slot only once docker verifies the container is removed", async () => {
    await withExecutor(async (executor) => {
      const { docker } = executor;
      const first = await createSandbox(executor);
      await createSandbox(executor, createBody("sandbox-2", "session-2", "lease-2"));
      const third = createBody("sandbox-3", "session-3", "lease-3");

      docker.removeFails = true;
      const failedStop = await request(executor, "POST", `/v1/sandboxes/${first}/stop`, {
        body: { reason: "idle" },
      });
      assert.equal(failedStop.status, 502);
      assert.equal((await request(executor, "POST", "/v1/sandboxes", { body: third })).status, 503);

      docker.removeFails = false;
      const stopped = await request(executor, "POST", `/v1/sandboxes/${first}/stop`, {
        body: { reason: "idle" },
      });
      assert.equal(stopped.status, 200);
      await createSandbox(executor, third);
      assert.equal(docker.runs().length, 3);
    });
  });

  it("keeps running allocations and their slots across a restart", async () => {
    await withStateDir(async (stateFile) => {
      const docker = new FakeDocker();
      const first = await startExecutor(stateFile, docker);
      const providerObjectId = await createSandbox(first);
      await createSandbox(first, createBody("sandbox-2", "session-2", "lease-2"));
      await first.close();

      const second = await startExecutor(stateFile, docker);
      try {
        const full = await request(second, "POST", "/v1/sandboxes", {
          body: createBody("sandbox-3", "session-3", "lease-3"),
        });
        assert.equal(full.status, 503);
        const retry = await request(second, "POST", "/v1/sandboxes", { body: CREATE });
        assert.equal(retry.status, 200);
        assert.deepEqual(await retry.json(), { providerObjectId });
        assert.equal(docker.runs().length, 2);
      } finally {
        await second.close();
      }
    });
  });

  it("frees the slot of a running record whose container docker no longer has, at restart", async () => {
    await withStateDir(async (stateFile) => {
      const docker = new FakeDocker();
      const first = await startExecutor(stateFile, docker);
      await createSandbox(first);
      await createSandbox(first, createBody("sandbox-2", "session-2", "lease-2"));
      await first.close();

      docker.containers.delete("oi-sandbox-1");
      const second = await startExecutor(stateFile, docker);
      try {
        // The first create after the restart reconciles before it judges the cap.
        await createSandbox(second, createBody("sandbox-3", "session-3", "lease-3"));
        assert.equal(docker.runs().length, 3);
      } finally {
        await second.close();
      }
    });
  });

  it("reconciles owned containers only: frees what is gone, adopts owned orphans, and touches nothing else", async () => {
    await withExecutor(async (executor) => {
      const { docker, store, runtime } = executor;
      await createSandbox(executor);
      await createSandbox(executor, createBody("sandbox-2", "session-2", "lease-2"));
      docker.containers.delete("oi-sandbox-1");
      // Owned by label and name, but no record accounts for it.
      docker.land("oi-sandbox-7", ownedLabels("sandbox-7", 2));
      // Not owned: no labels at all, and a sandbox label that does not match the name.
      docker.land("oi-plain", {});
      docker.land("oi-mismatch", ownedLabels("sandbox-8", 3));

      const result = await reconcileContainers(store, runtime, () => NOW);
      // The orphan is adopted unacknowledged, so it counts as an unresolved record that holds its id.
      assert.deepEqual(result, { freed: 1, attached: 0, adopted: 1, unresolved: 1 });
      assert.equal(
        docker.calls.some(([command]) => command === "rm"),
        false
      );
      assert.ok(docker.containers.has("oi-plain"));
      assert.ok(docker.containers.has("oi-mismatch"));

      // The adopted container holds a slot, with sandbox-2, so the cap refuses a third sandbox.
      const refused = await request(executor, "POST", "/v1/sandboxes", {
        body: createBody("sandbox-3", "session-3", "lease-3"),
      });
      assert.equal(refused.status, 503);
      assert.equal((await request(executor, "GET", "/v1/sandboxes/sandbox-7")).status, 503);
      assert.equal((await request(executor, "GET", "/v1/sandboxes/sandbox-1")).status, 404);
    });
  });

  it("a create whose admission cannot be recorded runs nothing and spends no lease", async () => {
    await withExecutor(async (executor) => {
      failWrites(executor.stateFile, "fail_admit", "INSERT ON sandboxes");
      const failed = await request(executor, "POST", "/v1/sandboxes", { body: CREATE });
      assert.equal(failed.status, 503);
      assert.deepEqual(await failed.json(), { error: "state_unavailable" });
      assert.equal(executor.docker.runs().length, 0);

      clearWrites(executor.stateFile, "fail_admit");
      await createSandbox(executor);
    });
  });

  it("a container whose running record cannot be written is removed, and its lease is released", async () => {
    await withExecutor(async (executor) => {
      failWrites(
        executor.stateFile,
        "fail_running",
        "UPDATE ON sandboxes WHEN NEW.status = 'running'"
      );
      const failed = await request(executor, "POST", "/v1/sandboxes", { body: CREATE });
      assert.equal(failed.status, 503);
      assert.deepEqual(await failed.json(), { error: "state_unavailable" });
      assert.equal(executor.docker.containers.size, 0);

      clearWrites(executor.stateFile, "fail_running");
      await createSandbox(executor);
      assert.equal(executor.docker.runs().length, 2);
    });
  });

  it("a run whose docker CLI is missing releases its lease without a removal", async () => {
    await withExecutor(async (executor) => {
      executor.docker.runFates = ["missing"];
      const failed = await request(executor, "POST", "/v1/sandboxes", { body: CREATE });
      assert.equal(failed.status, 502);
      assert.deepEqual(await failed.json(), { error: "create_failed" });
      assert.equal(
        executor.docker.calls.some(([command]) => command === "rm"),
        false
      );
      await createSandbox(executor);
    });
  });

  it("refuses a second executor on a state file another executor owns, and the owner keeps the cap", async () => {
    await withStateDir(async (stateFile) => {
      const docker = new FakeDocker();
      const owner = await startExecutor(stateFile, docker);
      try {
        await assert.rejects(startExecutor(stateFile, docker), /owned by another running process/);
        const statuses: number[] = [];
        for (let n = 1; n <= 3; n += 1) {
          const body = createBody(`sandbox-${n}`, `session-${n}`, `lease-${n}`);
          statuses.push((await request(owner, "POST", "/v1/sandboxes", { body })).status);
        }
        assert.deepEqual(statuses, [201, 201, 503]);
        assert.equal(docker.runs().length, 2);
        assert.equal(owner.store.slotHolders().length, 2);
      } finally {
        await owner.close();
      }
    });
  });

  it("resolves a create that is still settling as unavailable, not absent", async () => {
    await withExecutor(async (executor) => {
      executor.docker.runFates = ["killed"];
      await request(executor, "POST", "/v1/sandboxes", { body: CREATE });
      assert.equal((await request(executor, "GET", "/v1/sandboxes/sandbox-1")).status, 503);
    });
  });

  it("frees the slot of a create docker refused outright, and settles its lease as absent", async () => {
    await withExecutor(async (executor) => {
      const { docker, clock } = executor;
      // A missing image or a bind source that does not exist is refused before any container is made.
      docker.runFates = ["rejected"];
      const refused = await request(executor, "POST", "/v1/sandboxes", { body: CREATE });
      assert.equal(refused.status, 502);
      assert.deepEqual(await refused.json(), { error: "create_failed" });
      assert.equal(docker.containers.size, 0);

      // Settling the lease finds nothing docker holds, so it is absent, and its sandbox id is closed.
      const settled = await closeAdmission(
        executor,
        "sandbox-1",
        "session-1",
        signedLease("sandbox-1", "session-1", "lease-1", NOW + LEASE_MS)
      );
      assert.equal(settled.status, 200);
      assert.deepEqual(await settled.json(), { outcome: "absent" });
      const reused = await request(executor, "POST", "/v1/sandboxes", { body: CREATE });
      assert.equal(reused.status, 403);
      assert.deepEqual(await reused.json(), { error: "admission_expired" });

      // Nothing was held, so two more sandboxes fill the cap, and a fourth is refused.
      await createSandbox(executor, createBody("sandbox-2", "session-2", "lease-2"));
      await createSandbox(executor, createBody("sandbox-3", "session-3", "lease-3", clock.nowMs));
      const full = await request(executor, "POST", "/v1/sandboxes", {
        body: createBody("sandbox-4", "session-4", "lease-4", clock.nowMs),
      });
      assert.equal(full.status, 503);
      assert.deepEqual(await full.json(), { error: "capacity_exhausted" });
      assert.equal(docker.runs().length, 3);
    });
  });

  it("keeps a partial container a rejected run left under its name, unacknowledged, and never removes it", async () => {
    await withExecutor(async (executor) => {
      const { docker, store, runtime } = executor;
      docker.runFates = ["rejected-after-create"];
      const rejected = await request(executor, "POST", "/v1/sandboxes", { body: CREATE });
      assert.equal(rejected.status, 503);
      assert.deepEqual(await rejected.json(), { error: "create_unresolved" });
      assert.equal(docker.containers.size, 1);
      assert.equal(
        docker.calls.some(([command]) => command === "rm"),
        false
      );

      // Attached, but not running: its runtime never ran here, so the retry stays undecided.
      const result = await reconcileContainers(store, runtime, () => NOW);
      assert.deepEqual(result, { freed: 0, attached: 1, adopted: 0, unresolved: 1 });
      assert.equal((await request(executor, "GET", "/v1/sandboxes/sandbox-1")).status, 503);
      const containerId = docker.containers.get("oi-sandbox-1")?.id;
      assert.equal(
        await settledPresent(executor, "sandbox-1", "session-1", "lease-1"),
        containerId
      );
    });
  });

  it("fences a create docker refused outright, so its lease cannot run again before anything settles it", async () => {
    await withExecutor(async (executor) => {
      executor.docker.runFates = ["rejected"];
      const refused = await request(executor, "POST", "/v1/sandboxes", { body: CREATE });
      assert.equal(refused.status, 502);
      // The same lease is refused at once, with no docker run.
      const retried = await request(executor, "POST", "/v1/sandboxes", { body: CREATE });
      assert.equal(retried.status, 403);
      assert.deepEqual(await retried.json(), { error: "admission_expired" });
      // So is a new lease for the sandbox id the fence closed.
      const other = createBody("sandbox-1", "session-1", "lease-2");
      const otherRes = await request(executor, "POST", "/v1/sandboxes", { body: other });
      assert.equal(otherRes.status, 403);
      assert.equal(executor.docker.runs().length, 1);
    });
  });

  it("counts a container that lands after a fenced refusal, never reports it running, and frees it once stopped", async () => {
    await withExecutor(async (executor) => {
      const { docker, store, runtime } = executor;
      docker.runFates = ["rejected"];
      const refused = await request(executor, "POST", "/v1/sandboxes", { body: CREATE });
      assert.equal(refused.status, 502);
      // A container under the name lands after the refusal. It carries this executor's labels, so docker shows it as owned.
      const landed = docker.land("oi-sandbox-1", ownedLabels("sandbox-1", 0));
      await reconcileContainers(store, runtime, () => NOW);
      // Counted and closed, not running: a resolve is undecided, and a create cannot take its sandbox id.
      assert.equal(store.occupancy(), 1);
      assert.equal((await request(executor, "GET", "/v1/sandboxes/sandbox-1")).status, 503);
      const retried = await request(executor, "POST", "/v1/sandboxes", { body: CREATE });
      assert.equal(retried.status, 403);

      const stopped = await request(executor, "POST", `/v1/sandboxes/${landed}/stop`, {
        body: { reason: "late container" },
      });
      assert.equal(stopped.status, 200);
      assert.equal(store.occupancy(), 0);
      assert.equal(docker.containers.size, 0);
      // Its workspace is no session's, so only an operator release clears it.
      const cleared = await request(executor, "POST", "/v1/sandboxes/sandbox-1/operator-release", {
        body: { reason: "late container stopped" },
      });
      assert.equal(cleared.status, 200);
    });
  });

  it("refuses a fenced lease after a restart, so the create runs once", async () => {
    await withStateDir(async (stateFile) => {
      const docker = new FakeDocker();
      const first = await startExecutor(stateFile, docker);
      docker.runFates = ["rejected"];
      assert.equal((await request(first, "POST", "/v1/sandboxes", { body: CREATE })).status, 502);
      await first.close();

      const second = await startExecutor(stateFile, docker);
      try {
        const retried = await request(second, "POST", "/v1/sandboxes", { body: CREATE });
        assert.equal(retried.status, 403);
        assert.deepEqual(await retried.json(), { error: "admission_expired" });
        assert.equal(docker.runs().length, 1);
      } finally {
        await second.close();
      }
    });
  });

  it("answers a repeat release that arrives while the slot is still clearing, and clears it once", async () => {
    await withStateDir(async (stateFile) => {
      let enter = (): void => {};
      const entered = new Promise<void>((resolve) => {
        enter = () => resolve();
      });
      let open = (): void => {};
      const gate = new Promise<void>((resolve) => {
        open = () => resolve();
      });
      const executor = await startExecutor(stateFile, new FakeDocker(), undefined, {
        repairWorkspace: async () => {
          enter();
          await gate;
        },
      });
      try {
        const providerObjectId = await createSandbox(executor);
        const stopped = await request(executor, "POST", `/v1/sandboxes/${providerObjectId}/stop`, {
          body: { reason: "done" },
        });
        assert.equal(stopped.status, 200);
        const release = () =>
          request(executor, "POST", "/v1/sandboxes/sandbox-1/release", {
            body: { sessionId: "session-1", leaseToken: "lease-1" },
          });
        const first = release();
        await entered;
        // The first clear is still at the host repair, so a repeat is answered rather than run beside it.
        const repeat = await release();
        assert.equal(repeat.status, 409);
        assert.deepEqual(await repeat.json(), { error: "release_in_progress" });
        open();
        const done = await first;
        assert.equal(done.status, 200);
        assert.deepEqual(await done.json(), { released: true });
      } finally {
        open();
        await executor.close();
      }
    });
  });

  it("treats an already-removed container as gone on stop", async () => {
    await withExecutor(async (executor) => {
      const providerObjectId = await createSandbox(executor);
      executor.docker.containers.clear();
      const stopped = await request(executor, "POST", `/v1/sandboxes/${providerObjectId}/stop`, {
        body: { reason: "test" },
      });
      assert.equal(stopped.status, 404);
      assert.deepEqual(await stopped.json(), { error: "sandbox_not_found" });
      assert.equal((await request(executor, "GET", "/v1/sandboxes/sandbox-1")).status, 404);
    });
  });

  it("answers a stop of a non-container id as undecided, a route it lacks with not_found, and removes nothing", async () => {
    await withExecutor(async (executor) => {
      const providerObjectId = await createSandbox(executor);
      const callsBefore = executor.docker.calls.length;

      // A sandbox id is not a container id. A listing proves absence only for a full container id, so this is undecided.
      const wrongBase = await request(executor, "POST", "/v1/sandboxes/sandbox-1/stop", {
        body: { reason: "wrong base" },
      });
      assert.equal(wrongBase.status, 409);
      assert.deepEqual(await wrongBase.json(), { error: "container_unaccounted" });

      // A route the executor lacks is the router's 404, which is not the typed answer.
      const route = await request(executor, "POST", `/v1/sandboxes/${providerObjectId}/stopp`, {
        body: { reason: "typo" },
      });
      assert.equal(route.status, 404);
      assert.deepEqual(await route.json(), { error: "not_found" });

      assert.equal(executor.docker.calls.length, callsBefore);
      assert.equal((await request(executor, "GET", "/v1/sandboxes/sandbox-1")).status, 200);
    });
  });

  it("answers a stop of a full id the listing lacks with sandbox_not_found, once docker shows it absent", async () => {
    await withExecutor(async (executor) => {
      await createSandbox(executor);
      const callsBefore = executor.docker.calls.length;
      const unknown = await request(executor, "POST", `/v1/sandboxes/${"b".repeat(64)}/stop`, {
        body: { reason: "unknown" },
      });
      assert.equal(unknown.status, 404);
      assert.deepEqual(await unknown.json(), { error: "sandbox_not_found" });
      assert.deepEqual(
        executor.docker.calls.slice(callsBefore).map((args) => args[0]),
        ["ps"]
      );
      assert.equal((await request(executor, "GET", "/v1/sandboxes/sandbox-1")).status, 200);
    });
  });

  it("answers a stop of an id docker still lists, which the state does not hold, with container_unaccounted, and removes neither", async () => {
    await withExecutor(async (executor) => {
      await createSandbox(executor);
      // A container the state never recorded: owned for a sandbox it does not know, and a foreign one.
      const stray = executor.docker.land(containerName("sandbox-9"), ownedLabels("sandbox-9", 1));
      const foreign = executor.docker.land("foreign-app", {});
      for (const id of [stray, foreign]) {
        const stopped = await request(executor, "POST", `/v1/sandboxes/${id}/stop`, {
          body: { reason: "unrecorded" },
        });
        assert.equal(stopped.status, 409);
        assert.deepEqual(await stopped.json(), { error: "container_unaccounted" });
      }
      assert.equal(executor.docker.containers.has(containerName("sandbox-9")), true);
      assert.equal(executor.docker.containers.has("foreign-app"), true);
      assert.equal(executor.docker.calls.filter((args) => args[0] === "rm").length, 0);
      // The recorded sandbox keeps its running claim.
      assert.equal((await request(executor, "GET", "/v1/sandboxes/sandbox-1")).status, 200);
    });
  });

  it("answers a stop of an id docker cannot list with runtime_unavailable, and removes nothing", async () => {
    await withExecutor(async (executor) => {
      await createSandbox(executor);
      executor.docker.listFails = true;
      const stopped = await request(executor, "POST", `/v1/sandboxes/${"b".repeat(64)}/stop`, {
        body: { reason: "unlisted" },
      });
      assert.equal(stopped.status, 503);
      assert.deepEqual(await stopped.json(), { error: "runtime_unavailable" });
      assert.equal(executor.docker.calls.filter((args) => args[0] === "rm").length, 0);
      assert.equal((await request(executor, "GET", "/v1/sandboxes/sandbox-1")).status, 200);
    });
  });

  it("answers a stop of a container a failed launch removed with sandbox_not_found, without asking docker", async () => {
    await withExecutor(async (executor) => {
      executor.docker.launchFates = ["refused"];
      const failed = await request(executor, "POST", "/v1/sandboxes", { body: CREATE });
      assert.equal(failed.status, 502);
      const removed = executor.docker.launches[0].args[2];
      const callsBefore = executor.docker.calls.length;
      const stopped = await request(executor, "POST", `/v1/sandboxes/${removed}/stop`, {
        body: { reason: "removed" },
      });
      assert.equal(stopped.status, 404);
      assert.deepEqual(await stopped.json(), { error: "sandbox_not_found" });
      assert.equal(executor.docker.calls.length, callsBefore);
    });
  });

  it("keeps the record when docker fails to remove the container", async () => {
    await withExecutor(async (executor) => {
      const providerObjectId = await createSandbox(executor);
      executor.docker.removeFails = true;
      const stopped = await request(executor, "POST", `/v1/sandboxes/${providerObjectId}/stop`, {
        body: { reason: "test" },
      });
      assert.equal(stopped.status, 502);
      assert.equal((await request(executor, "GET", "/v1/sandboxes/sandbox-1")).status, 200);
    });
  });

  it("refuses allocation while docker cannot be listed, and does not spend the lease", async () => {
    await withExecutor(async (executor) => {
      executor.docker.listFails = true;
      const refused = await request(executor, "POST", "/v1/sandboxes", { body: CREATE });
      assert.equal(refused.status, 503);
      assert.deepEqual(await refused.json(), { error: "state_unavailable" });
      assert.equal(executor.docker.runs().length, 0);

      executor.docker.listFails = false;
      await createSandbox(executor);
    });
  });

  it("refuses a create once docker cannot be listed, even after an earlier listing succeeded, and runs nothing", async () => {
    await withExecutor(async (executor) => {
      await createSandbox(executor);
      executor.docker.listFails = true;
      const refused = await request(executor, "POST", "/v1/sandboxes", {
        body: createBody("sandbox-2", "session-2", "lease-2"),
      });
      assert.equal(refused.status, 503);
      assert.deepEqual(await refused.json(), { error: "state_unavailable" });
      assert.equal(executor.docker.runs().length, 1);
      assert.equal(executor.store.byLease("lease-2"), undefined);
      assert.equal(executor.store.slotHolders().length, 1);
    });
  });

  it("rejects malformed ids and bodies before docker runs", async () => {
    await withExecutor(async (executor) => {
      const badId = await request(executor, "POST", "/v1/sandboxes", {
        body: { ...CREATE, sandboxId: "--privileged" },
      });
      assert.equal(badId.status, 400);
      const badReason = await request(executor, "POST", "/v1/sandboxes/abc/stop", {
        body: { reason: 42 },
      });
      assert.equal(badReason.status, 400);
      assert.deepEqual(executor.docker.calls, []);
    });
  });

  it("keeps records across a restart and refuses a corrupt state file", async () => {
    await withStateDir(async (stateFile) => {
      const docker = new FakeDocker();
      const first = await startExecutor(stateFile, docker);
      try {
        await createSandbox(first);
      } finally {
        await first.close();
      }

      const second = await startExecutor(stateFile, docker);
      try {
        assert.equal((await request(second, "GET", "/v1/sandboxes/sandbox-1")).status, 200);
      } finally {
        await second.close();
      }

      await writeFile(stateFile, "{not json");
      await assert.rejects(openStateStore(stateFile));
    });
  });

  it("persists the reservation before docker runs", async () => {
    await withStateDir(async (stateFile) => {
      const docker = new FakeDocker();
      const seenAtRun: Array<Record<string, unknown>[]> = [];
      docker.onRun = () => {
        seenAtRun.push(
          withRawDb(stateFile, (db) =>
            db
              .prepare("SELECT lease_token, status FROM sandboxes")
              .all()
              .map((row) => ({ ...row }))
          )
        );
      };
      const executor = await startExecutor(stateFile, docker);
      try {
        await createSandbox(executor);
      } finally {
        await executor.close();
      }
      assert.equal(seenAtRun.length, 1);
      assert.deepEqual(seenAtRun[0], [{ lease_token: "lease-1", status: "creating" }]);
    });
  });

  it("binds a sandbox's own slot, reuses it across a stop and a restart, and refuses another session that names it", async () => {
    await withStateDir(async (stateFile) => {
      const docker = new FakeDocker();
      const mountOf = (args: string[]) => args[args.indexOf("--mount") + 1];
      const first = await startExecutor(stateFile, docker);
      const firstId = await createSandbox(first);
      const stopped = await request(first, "POST", `/v1/sandboxes/${firstId}/stop`, {
        body: { reason: "done" },
      });
      assert.equal(stopped.status, 200);
      await first.close();

      const second = await startExecutor(stateFile, docker);
      try {
        const again = await request(second, "POST", "/v1/sandboxes", {
          body: createBody("sandbox-1", "session-1", "lease-2"),
        });
        assert.equal(again.status, 201);
        const againId = ((await again.json()) as { providerObjectId: string }).providerObjectId;
        const slot = slotPathOf(stateFile, 0);
        assert.deepEqual(docker.runs().map(mountOf), [
          `type=bind,source=${slot},target=/workspace`,
          `type=bind,source=${slot},target=/workspace`,
        ]);

        const restopped = await request(second, "POST", `/v1/sandboxes/${againId}/stop`, {
          body: { reason: "done" },
        });
        assert.equal(restopped.status, 200);
        const other = await request(second, "POST", "/v1/sandboxes", {
          body: createBody("sandbox-1", "session-2", "lease-3"),
        });
        assert.equal(other.status, 409);
        assert.deepEqual(await other.json(), { error: "sandbox_id_conflict" });
        assert.equal(docker.runs().length, 2);
      } finally {
        await second.close();
      }
    });
  });

  it("answers workspace_capacity_exhausted, not capacity_exhausted, once every slot is held or retained", async () => {
    await withExecutor(async (executor) => {
      for (let n = 1; n <= WORKSPACE_SLOT_COUNT; n += 1) {
        const providerObjectId = await createSandbox(
          executor,
          createBody(`sandbox-${n}`, `session-${n}`, `lease-${n}`)
        );
        const stopped = await request(executor, "POST", `/v1/sandboxes/${providerObjectId}/stop`, {
          body: { reason: "idle" },
        });
        assert.equal(stopped.status, 200);
      }
      const refused = await request(executor, "POST", "/v1/sandboxes", {
        body: createBody("sandbox-7", "session-7", "lease-7"),
      });
      assert.equal(refused.status, 503);
      assert.deepEqual(await refused.json(), { error: "workspace_capacity_exhausted" });
      assert.equal(executor.docker.runs().length, WORKSPACE_SLOT_COUNT);
    });
  });

  it("refuses a create whose slot the host has not proven before docker runs, and spends no lease", async () => {
    await withStateDir(async (stateFile) => {
      const docker = new FakeDocker();
      let proven = false;
      const executor = await startExecutor(stateFile, docker, undefined, {
        checkWorkspace: async () => {
          if (!proven) throw new Error("workspace slot unavailable: not a separate mount");
        },
      });
      try {
        const refused = await request(executor, "POST", "/v1/sandboxes", { body: CREATE });
        assert.equal(refused.status, 503);
        assert.deepEqual(await refused.json(), { error: "workspace_unavailable" });
        assert.equal(docker.runs().length, 0);
        assert.equal(executor.store.slotHolders().length, 0);

        proven = true;
        await createSandbox(executor);
      } finally {
        await executor.close();
      }
    });
  });

  it("does not attach a late container that names another slot than the one its create reserved", async () => {
    await withExecutor(async (executor) => {
      const { docker, store, runtime } = executor;
      docker.runFates = ["killed"];
      const ambiguous = await request(executor, "POST", "/v1/sandboxes", { body: CREATE });
      assert.equal(ambiguous.status, 503);
      docker.land("oi-sandbox-1", ownedLabels("sandbox-1", 1));

      const result = await reconcileContainers(store, runtime, () => NOW);
      assert.deepEqual(result, { freed: 0, attached: 0, adopted: 0, unresolved: 1 });
      assert.equal((await request(executor, "GET", "/v1/sandboxes/sandbox-1")).status, 503);
    });
  });

  it("releases a stopped workspace only for its owning session and lease, clears it, and reuses the slot", async () => {
    await withExecutor(async (executor) => {
      const slot = slotPathOf(executor.stateFile, 0);
      const providerObjectId = await createSandbox(executor);
      const stopped = await request(executor, "POST", `/v1/sandboxes/${providerObjectId}/stop`, {
        body: { reason: "done" },
      });
      assert.equal(stopped.status, 200);
      // Data the sandbox left behind, and a link to a host directory that a release must not touch.
      const outside = join(dirname(executor.stateFile), "outside");
      await mkdir(outside);
      await writeFile(join(outside, "canary.txt"), "keep");
      await writeFile(join(slot, "work.txt"), "data");
      await symlink(outside, join(slot, "escape"), "junction");

      const release = (sandboxId: string, body: unknown) =>
        request(executor, "POST", `/v1/sandboxes/${sandboxId}/release`, { body });
      const notOwner = await release("sandbox-1", {
        sessionId: "session-2",
        leaseToken: "lease-1",
      });
      assert.equal(notOwner.status, 409);
      assert.deepEqual(await notOwner.json(), { error: "release_refused" });
      const staleFence = await release("sandbox-1", {
        sessionId: "session-1",
        leaseToken: "lease-9",
      });
      assert.equal(staleFence.status, 409);
      assert.deepEqual(await staleFence.json(), { error: "release_refused" });
      const unknown = await release("sandbox-9", { sessionId: "session-1", leaseToken: "lease-1" });
      assert.equal(unknown.status, 404);
      assert.deepEqual(await unknown.json(), { error: "not_found" });
      assert.equal((await release("sandbox-1", {})).status, 400);

      const released = await release("sandbox-1", {
        sessionId: "session-1",
        leaseToken: "lease-1",
      });
      assert.equal(released.status, 200);
      assert.deepEqual(await released.json(), { released: true });
      assert.deepEqual(await readdir(slot), []);
      assert.equal(await readFile(join(outside, "canary.txt"), "utf8"), "keep");

      // The slot is free, so the next sandbox binds it.
      await createSandbox(executor, createBody("sandbox-2", "session-2", "lease-2"));
      assert.ok(
        hasFlag(executor.docker.runs()[1], "--mount", `type=bind,source=${slot},target=/workspace`)
      );
    });
  });

  it("refuses a release while the workspace is held or a container still names its slot, and keeps the slot until a release completes", async () => {
    await withExecutor(async (executor) => {
      const { docker } = executor;
      const providerObjectId = await createSandbox(executor);
      const release = () =>
        request(executor, "POST", "/v1/sandboxes/sandbox-1/release", {
          body: { sessionId: "session-1", leaseToken: "lease-1" },
        });
      const held = await release();
      assert.equal(held.status, 409);
      assert.deepEqual(await held.json(), { error: "workspace_active" });

      const stopped = await request(executor, "POST", `/v1/sandboxes/${providerObjectId}/stop`, {
        body: { reason: "done" },
      });
      assert.equal(stopped.status, 200);
      // A container still names the slot, as a late create would leave it.
      docker.land("oi-sandbox-1", ownedLabels("sandbox-1", 0));
      const active = await release();
      assert.equal(active.status, 409);
      assert.deepEqual(await active.json(), { error: "workspace_active" });

      // The release started, so nothing binds the slot until a release completes. The container that names the
      // slot also holds its sandbox id, so the create is refused as a conflict.
      const busy = await request(executor, "POST", "/v1/sandboxes", {
        body: createBody("sandbox-1", "session-1", "lease-2"),
      });
      assert.equal(busy.status, 409);
      assert.deepEqual(await busy.json(), { error: "sandbox_id_conflict" });

      docker.containers.delete("oi-sandbox-1");
      const resumed = await release();
      assert.equal(resumed.status, 200);
      await createSandbox(executor, createBody("sandbox-1", "session-1", "lease-2"));
    });
  });

  it("does not clear a workspace the host check refuses, and resumes the same release once it passes", async () => {
    await withStateDir(async (stateFile) => {
      let proven = true;
      const executor = await startExecutor(stateFile, new FakeDocker(), undefined, {
        checkWorkspace: async () => {
          if (!proven) throw new Error("workspace slot unavailable: not a separate mount");
        },
      });
      try {
        const slot = slotPathOf(stateFile, 0);
        const providerObjectId = await createSandbox(executor);
        const stopped = await request(executor, "POST", `/v1/sandboxes/${providerObjectId}/stop`, {
          body: { reason: "done" },
        });
        assert.equal(stopped.status, 200);
        await writeFile(join(slot, "work.txt"), "data");

        const release = () =>
          request(executor, "POST", "/v1/sandboxes/sandbox-1/release", {
            body: { sessionId: "session-1", leaseToken: "lease-1" },
          });
        proven = false;
        const refused = await release();
        assert.equal(refused.status, 503);
        assert.deepEqual(await refused.json(), { error: "workspace_unavailable" });
        assert.deepEqual(await readdir(slot), ["work.txt"]);

        proven = true;
        const resumed = await release();
        assert.equal(resumed.status, 200);
        assert.deepEqual(await readdir(slot), []);
      } finally {
        await executor.close();
      }
    });
  });
});

/** The settlement request the control plane sends for a lease, with the signed proof it holds for that lease. */
function closeAdmission(
  executor: Executor,
  sandboxId: string,
  sessionId: string,
  admissionLease: unknown
): Promise<Response> {
  return request(executor, "POST", `/v1/sandboxes/${sandboxId}/admission/close`, {
    body: { sessionId, admissionLease },
  });
}

/** Settles a lease the way the control plane does, and returns the container the answer names. */
async function settledPresent(
  executor: Executor,
  sandboxId: string,
  sessionId: string,
  leaseToken: string,
  nowMs = NOW
): Promise<string | undefined> {
  const res = await closeAdmission(
    executor,
    sandboxId,
    sessionId,
    signedLease(sandboxId, sessionId, leaseToken, nowMs + LEASE_MS)
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { outcome: string; providerObjectId?: string };
  assert.equal(body.outcome, "present");
  return body.providerObjectId;
}

/** Waits until a condition holds, so a test can catch a request partway through, such as a create inside docker. */
async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !condition(); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition(), "the awaited state was never reached");
}

describe("admission settlement", () => {
  const PROOF_1 = signedLease("sandbox-1", "session-1", "lease-1", NOW + LEASE_MS);

  it("settles an unspent lease as absent, then refuses its delayed create and any other lease for its sandbox id", async () => {
    await withExecutor(async (executor) => {
      const anonymous = await request(executor, "POST", "/v1/sandboxes/sandbox-1/admission/close", {
        body: { sessionId: "session-1", admissionLease: PROOF_1 },
        headers: {},
      });
      assert.equal(anonymous.status, 401);

      const settled = await closeAdmission(executor, "sandbox-1", "session-1", PROOF_1);
      assert.equal(settled.status, 200);
      assert.deepEqual(await settled.json(), { outcome: "absent" });

      const delayed = await request(executor, "POST", "/v1/sandboxes", { body: CREATE });
      assert.equal(delayed.status, 403);
      assert.deepEqual(await delayed.json(), { error: "admission_expired" });
      const other = await request(executor, "POST", "/v1/sandboxes", {
        body: createBody("sandbox-1", "session-1", "lease-2"),
      });
      assert.equal(other.status, 403);
      assert.deepEqual(await other.json(), { error: "admission_expired" });
      assert.equal(executor.docker.runs().length, 0);
    });
  });

  it("answers a create held inside docker as undecided, keeps its slot, and names its container once it lands", async () => {
    await withExecutor(async (executor) => {
      let release = (): void => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      executor.docker.onRun = () => held;
      const creating = request(executor, "POST", "/v1/sandboxes", { body: CREATE });
      await until(() => executor.docker.runs().length === 1);

      const midway = await closeAdmission(executor, "sandbox-1", "session-1", PROOF_1);
      assert.equal(midway.status, 409);
      assert.deepEqual(await midway.json(), { error: "create_in_progress" });
      assert.equal(executor.store.slotHolders().length, 1);

      release();
      const created = await creating;
      assert.equal(created.status, 201);
      const { providerObjectId } = (await created.json()) as { providerObjectId: string };
      const found = await closeAdmission(executor, "sandbox-1", "session-1", PROOF_1);
      assert.deepEqual(await found.json(), { outcome: "present", providerObjectId });
    });
  });

  it("refuses a proof that is forged, moved to another scope, unsigned, or missing, and settles nothing", async () => {
    await withExecutor(async (executor) => {
      const forgedSignature = admissionSignature("another-admission-secret-0123456789", {
        sessionId: "session-1",
        sandboxId: "sandbox-1",
        leaseToken: "lease-1",
        expiresAtMs: NOW + LEASE_MS,
      });
      const refused = [
        await closeAdmission(executor, "sandbox-2", "session-1", PROOF_1),
        await closeAdmission(executor, "sandbox-1", "session-9", PROOF_1),
        await closeAdmission(executor, "sandbox-1", "session-1", {
          ...PROOF_1,
          signature: forgedSignature,
        }),
        await closeAdmission(executor, "sandbox-1", "session-1", {
          leaseToken: "lease-1",
          expiresAtMs: NOW + LEASE_MS,
        }),
        await closeAdmission(executor, "sandbox-1", "session-1", undefined),
      ];
      assert.deepEqual(
        refused.map((res) => res.status),
        [403, 403, 403, 403, 403]
      );
      const codes = await Promise.all(
        refused.map(async (res) => ((await res.json()) as { error: string }).error)
      );
      assert.deepEqual(codes, [
        "admission_invalid",
        "admission_invalid",
        "admission_invalid",
        "admission_invalid",
        "admission_missing",
      ]);

      // None of them closed the lease, so the genuine create still admits.
      const genuine = await request(executor, "POST", "/v1/sandboxes", { body: CREATE });
      assert.equal(genuine.status, 201);
    });
  });

  it("refuses a proof for another session once the lease has a record, and still reads the container for its owner", async () => {
    await withExecutor(async (executor) => {
      const providerObjectId = await createSandbox(executor);
      const replay = await closeAdmission(
        executor,
        "sandbox-1",
        "session-2",
        signedLease("sandbox-1", "session-2", "lease-1", NOW + LEASE_MS)
      );
      assert.equal(replay.status, 403);
      assert.deepEqual(await replay.json(), { error: "admission_replayed" });

      const owner = await closeAdmission(executor, "sandbox-1", "session-1", PROOF_1);
      assert.deepEqual(await owner.json(), { outcome: "present", providerObjectId });
    });
  });

  it("settles a lapsed lease from its expired proof, and never creates under it", async () => {
    await withExecutor(async (executor) => {
      executor.clock.nowMs = NOW + LEASE_MS + 1;
      const late = await request(executor, "POST", "/v1/sandboxes", { body: CREATE });
      assert.equal(late.status, 403);
      assert.deepEqual(await late.json(), { error: "admission_expired" });

      const settled = await closeAdmission(executor, "sandbox-1", "session-1", PROOF_1);
      assert.equal(settled.status, 200);
      assert.deepEqual(await settled.json(), { outcome: "absent" });
      assert.equal(executor.docker.runs().length, 0);
    });
  });

  it("keeps a final absence across a restart, for the lease and for its sandbox id", async () => {
    await withStateDir(async (stateFile) => {
      const docker = new FakeDocker();
      const first = await startExecutor(stateFile, docker);
      const settled = await closeAdmission(first, "sandbox-1", "session-1", PROOF_1);
      assert.deepEqual(await settled.json(), { outcome: "absent" });
      await first.close();

      const second = await startExecutor(stateFile, docker);
      try {
        const delayed = await request(second, "POST", "/v1/sandboxes", { body: CREATE });
        assert.equal(delayed.status, 403);
        assert.deepEqual(await delayed.json(), { error: "admission_expired" });
        const other = await request(second, "POST", "/v1/sandboxes", {
          body: createBody("sandbox-1", "session-1", "lease-2"),
        });
        assert.equal(other.status, 403);
        assert.equal(docker.runs().length, 0);
      } finally {
        await second.close();
      }
    });
  });

  it("never lets a create follow a final absence, when both race on the one owner", async () => {
    await withStateDir(async (stateFile) => {
      const docker = new FakeDocker();
      // One owner serves both requests. Their transactions interleave at each await, which is the race under test.
      const settler = await startExecutor(stateFile, docker);
      const creator = settler;
      try {
        for (let round = 0; round < 4; round += 1) {
          const sandboxId = `race-${round}`;
          const body = createBody(sandboxId, "session-race", `race-lease-${round}`);
          const [closed, created] = await Promise.all([
            closeAdmission(settler, sandboxId, "session-race", body.admissionLease),
            request(creator, "POST", "/v1/sandboxes", { body }),
          ]);
          const answer = (await closed.json()) as { outcome?: string; error?: string };
          const runs = docker
            .runs()
            .filter((args) => args[args.indexOf("--name") + 1] === `oi-${sandboxId}`).length;
          if (answer.outcome === "absent") {
            // Absent is final: the create is refused, and docker never ran the lease.
            assert.equal(created.status, 403, `round ${round}`);
            assert.equal(runs, 0, `round ${round}`);
          } else {
            // Not absent: the create was admitted first, so the settlement names it or sees it in flight.
            assert.ok(
              answer.outcome === "present" || answer.error === "create_in_progress",
              `round ${round}: ${JSON.stringify(answer)}`
            );
            assert.equal(created.status, 201, `round ${round}`);
            assert.equal(runs, 1, `round ${round}`);
            const { providerObjectId } = (await created.json()) as { providerObjectId: string };
            const stopped = await request(
              creator,
              "POST",
              `/v1/sandboxes/${providerObjectId}/stop`,
              { body: { reason: "round done" } }
            );
            assert.equal(stopped.status, 200);
          }
        }
      } finally {
        await settler.close();
      }
    });
  });

  it("holds an unresolved create as undecided until docker shows its container, then names that container", async () => {
    await withExecutor(async (executor) => {
      executor.docker.runFates = ["dropped"];
      const failed = await request(executor, "POST", "/v1/sandboxes", { body: CREATE });
      assert.equal(failed.status, 503);
      assert.deepEqual(await failed.json(), { error: "create_unresolved" });

      const midway = await closeAdmission(executor, "sandbox-1", "session-1", PROOF_1);
      assert.equal(midway.status, 503);
      assert.deepEqual(await midway.json(), { error: "create_unresolved" });

      const landed = executor.docker.land("oi-sandbox-1", ownedLabels("sandbox-1", 0));
      const found = await closeAdmission(executor, "sandbox-1", "session-1", PROOF_1);
      assert.deepEqual(await found.json(), { outcome: "present", providerObjectId: landed });
    });
  });

  it("counts an owned container with no slot label against the cap, closes its sandbox id, and frees the slot once docker drops it", async () => {
    await withExecutor(async (executor) => {
      const { docker } = executor;
      docker.land("oi-orphan", {
        "open-inspect.managed": "vps-executor",
        "open-inspect.sandbox-id": "orphan",
      });
      await createSandbox(executor);

      const second = await request(executor, "POST", "/v1/sandboxes", {
        body: createBody("sandbox-2", "session-2", "lease-2"),
      });
      assert.equal(second.status, 503);
      assert.deepEqual(await second.json(), { error: "capacity_exhausted" });

      const sameId = await request(executor, "POST", "/v1/sandboxes", {
        body: createBody("orphan", "session-3", "lease-3"),
      });
      assert.equal(sameId.status, 409);
      assert.deepEqual(await sameId.json(), { error: "sandbox_id_conflict" });

      const settled = await closeAdmission(
        executor,
        "orphan",
        "session-3",
        signedLease("orphan", "session-3", "lease-4", NOW + LEASE_MS)
      );
      assert.equal(settled.status, 503);
      assert.deepEqual(await settled.json(), { error: "container_unaccounted" });

      // Once docker no longer shows the container, its cap slot is free, and lease-2 was never spent.
      docker.containers.delete("oi-orphan");
      await createSandbox(executor, createBody("sandbox-2", "session-2", "lease-2"));
    });
  });

  it("refuses a create whose home the host check refuses, before docker runs, and spends no lease", async () => {
    let homeProven = false;
    await withStateDir(async (stateFile) => {
      const executor = await startExecutor(stateFile, new FakeDocker(), undefined, {
        prepareHome: async () => {
          if (!homeProven) throw new Error("home is not a real directory");
        },
      });
      try {
        const refused = await request(executor, "POST", "/v1/sandboxes", { body: CREATE });
        assert.equal(refused.status, 503);
        assert.deepEqual(await refused.json(), { error: "workspace_unavailable" });
        assert.equal(executor.docker.runs().length, 0);

        homeProven = true;
        await createSandbox(executor);
      } finally {
        await executor.close();
      }
    });
  });

  it("settles a stopped lease as absent, and closes its sandbox id", async () => {
    await withExecutor(async (executor) => {
      const providerObjectId = await createSandbox(executor);
      const stopped = await request(executor, "POST", `/v1/sandboxes/${providerObjectId}/stop`, {
        body: { reason: "done" },
      });
      assert.equal(stopped.status, 200);

      const settled = await closeAdmission(executor, "sandbox-1", "session-1", PROOF_1);
      assert.deepEqual(await settled.json(), { outcome: "absent" });
      const again = await request(executor, "POST", "/v1/sandboxes", {
        body: createBody("sandbox-1", "session-1", "lease-2"),
      });
      assert.equal(again.status, 403);
      assert.deepEqual(await again.json(), { error: "admission_expired" });
    });
  });

  it("judges a lease's expiry inside the admit transaction, and records nothing once it has lapsed", async () => {
    await withExecutor(async (executor) => {
      const record = {
        leaseToken: "lease-1",
        sessionId: "session-1",
        sandboxId: "sandbox-1",
        status: "creating" as const,
        providerObjectId: null,
        createdAtMs: NOW,
      };
      const outcome = executor.store.admit(record, MAX_ALLOCATED_SANDBOXES, () => false);
      assert.deepEqual(outcome, { kind: "expired" });
      assert.equal(executor.store.byLease("lease-1"), undefined);
      assert.equal(executor.store.occupancy(), 0);
    });
  });
});

/** Makes the matching writes fail in the state file, as a full disk would. */
function failWrites(stateFile: string, name: string, when: string): void {
  withRawDb(stateFile, (db) =>
    db.exec(
      `CREATE TRIGGER ${name} BEFORE ${when} BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END`
    )
  );
}

function clearWrites(stateFile: string, name: string): void {
  withRawDb(stateFile, (db) => db.exec(`DROP TRIGGER ${name}`));
}

describe("recovery of unknown outcomes and orphaned containers", () => {
  it("abandons an unresolved create docker shows no container for, closing its lease and sandbox id at once", async () => {
    await withExecutor(async (executor) => {
      const { docker, clock } = executor;
      docker.runFates = ["dropped"];
      assert.equal(
        (await request(executor, "POST", "/v1/sandboxes", { body: CREATE })).status,
        503
      );

      const unreasoned = await request(executor, "POST", "/v1/sandboxes/sandbox-1/abandon", {
        body: {},
      });
      assert.equal(unreasoned.status, 400);
      const abandoned = await request(executor, "POST", "/v1/sandboxes/sandbox-1/abandon", {
        body: { reason: "dropped connection" },
      });
      assert.equal(abandoned.status, 200);
      assert.deepEqual(await abandoned.json(), { abandoned: true });

      // The container slot is free at once, so two sandboxes fill the cap, and the abandoned lease stays closed.
      await createSandbox(executor, createBody("sandbox-2", "session-2", "lease-2"));
      await createSandbox(executor, createBody("sandbox-3", "session-3", "lease-3", clock.nowMs));
      const reused = await request(executor, "POST", "/v1/sandboxes", { body: CREATE });
      assert.equal(reused.status, 403);
      const again = await request(executor, "POST", "/v1/sandboxes/sandbox-1/abandon", {
        body: { reason: "again" },
      });
      assert.equal(again.status, 404);
      assert.equal(docker.runs().length, 3);
    });
  });

  it("refuses to abandon while docker shows a container under the sandbox id, which is then settled as present", async () => {
    await withExecutor(async (executor) => {
      const { docker } = executor;
      docker.runFates = ["dropped"];
      assert.equal(
        (await request(executor, "POST", "/v1/sandboxes", { body: CREATE })).status,
        503
      );
      docker.land("oi-sandbox-1", ownedLabels("sandbox-1", 0));

      const refused = await request(executor, "POST", "/v1/sandboxes/sandbox-1/abandon", {
        body: { reason: "late" },
      });
      assert.equal(refused.status, 409);
      assert.deepEqual(await refused.json(), { error: "container_present" });
      const containerId = docker.containers.get("oi-sandbox-1")?.id;
      assert.equal(
        await settledPresent(executor, "sandbox-1", "session-1", "lease-1"),
        containerId
      );
    });
  });

  it("refuses a killed create docker completes after its abandon, so it binds no slot through a release or a new tenant", async () => {
    await withExecutor(async (executor) => {
      const { docker, clock, stateFile } = executor;
      docker.runFates = ["killed-late"];
      assert.equal(
        (await request(executor, "POST", "/v1/sandboxes", { body: CREATE })).status,
        503
      );
      const abandoned = await request(executor, "POST", "/v1/sandboxes/sandbox-1/abandon", {
        body: { reason: "killed" },
      });
      assert.equal(abandoned.status, 200);

      // docker completes the killed create after the abandon. The fence holds the name, so the daemon refuses it.
      assert.equal(docker.landLate(), "refused");
      const released = await request(executor, "POST", "/v1/sandboxes/sandbox-1/release", {
        body: { sessionId: "session-1", leaseToken: "lease-1" },
      });
      assert.equal(released.status, 200);
      // A new tenant binds the freed slot, and its own container is the only one that binds it.
      await createSandbox(executor, createBody("sandbox-2", "session-2", "lease-2", clock.nowMs));
      const bound = [...docker.containers.values()]
        .filter((container) =>
          container.mounts.some((mount) => mount.includes(`source=${slotPathOf(stateFile, 0)},`))
        )
        .map((container) => container.labels["open-inspect.sandbox-id"]);
      assert.deepEqual(bound, ["sandbox-2"]);
      assert.equal(
        docker.containers.get("oi-sandbox-1")?.labels["open-inspect.fence"],
        "name-reservation"
      );
    });
  });

  it("holds an abandon whose name another container holds, and frees nothing", async () => {
    await withExecutor(async (executor) => {
      const { docker } = executor;
      docker.runFates = ["killed-late"];
      assert.equal(
        (await request(executor, "POST", "/v1/sandboxes", { body: CREATE })).status,
        503
      );
      docker.land("oi-sandbox-1", { "com.example.owner": "someone-else" });

      const held = await request(executor, "POST", "/v1/sandboxes/sandbox-1/abandon", {
        body: { reason: "late" },
      });
      assert.equal(held.status, 503);
      assert.deepEqual(await held.json(), { error: "container_unaccounted" });
      // The create stays unresolved and keeps its slot: a second sandbox fills the cap, and a third is refused.
      assert.equal(executor.store.byLease("lease-1")?.status, "unresolved");
      await createSandbox(executor, createBody("sandbox-2", "session-2", "lease-2"));
      const full = await request(executor, "POST", "/v1/sandboxes", {
        body: createBody("sandbox-3", "session-3", "lease-3"),
      });
      assert.deepEqual(await full.json(), { error: "capacity_exhausted" });
    });
  });

  it("holds an abandon whose fence has no verified outcome, and places the fence on a retry", async () => {
    await withExecutor(async (executor) => {
      const { docker } = executor;
      docker.runFates = ["killed-late"];
      assert.equal(
        (await request(executor, "POST", "/v1/sandboxes", { body: CREATE })).status,
        503
      );
      docker.fenceFates = ["dropped"];

      const unknown = await request(executor, "POST", "/v1/sandboxes/sandbox-1/abandon", {
        body: { reason: "dropped" },
      });
      assert.equal(unknown.status, 503);
      assert.deepEqual(await unknown.json(), { error: "runtime_unavailable" });
      assert.equal(executor.store.byLease("lease-1")?.status, "unresolved");

      const retried = await request(executor, "POST", "/v1/sandboxes/sandbox-1/abandon", {
        body: { reason: "retry" },
      });
      assert.equal(retried.status, 200);
      assert.equal(docker.landLate(), "refused");
    });
  });

  it("recognises its own fence on a retry after the tombstone failed to write", async () => {
    await withExecutor(async (executor) => {
      const { docker, stateFile } = executor;
      docker.runFates = ["killed-late"];
      assert.equal(
        (await request(executor, "POST", "/v1/sandboxes", { body: CREATE })).status,
        503
      );
      failWrites(stateFile, "fail_settle", "INSERT ON settlements");
      const failed = await request(executor, "POST", "/v1/sandboxes/sandbox-1/abandon", {
        body: { reason: "write" },
      });
      assert.equal(failed.status, 503);
      assert.deepEqual(await failed.json(), { error: "state_unavailable" });
      assert.equal(executor.store.byLease("lease-1")?.status, "unresolved");
      clearWrites(stateFile, "fail_settle");

      const retried = await request(executor, "POST", "/v1/sandboxes/sandbox-1/abandon", {
        body: { reason: "retry" },
      });
      assert.equal(retried.status, 200);
      assert.equal(docker.landLate(), "refused");
    });
  });

  it("keeps a closed create closed across a restart, and never adopts its fence", async () => {
    await withStateDir(async (stateFile) => {
      const docker = new FakeDocker();
      const first = await startExecutor(stateFile, docker);
      docker.runFates = ["killed-late"];
      assert.equal((await request(first, "POST", "/v1/sandboxes", { body: CREATE })).status, 503);
      const abandoned = await request(first, "POST", "/v1/sandboxes/sandbox-1/abandon", {
        body: { reason: "killed" },
      });
      assert.equal(abandoned.status, 200);
      await first.close();

      const second = await startExecutor(stateFile, docker);
      try {
        assert.equal(
          (await request(second, "POST", "/v1/sandboxes", { body: CREATE })).status,
          403
        );
        await reconcileContainers(second.store, second.runtime);
        assert.equal(second.store.occupancy(), 0);
        assert.deepEqual(second.store.unplacedIds(), []);
        assert.equal(docker.landLate(), "refused");
      } finally {
        await second.close();
      }
    });
  });

  it("refuses every create and the health check while the sandbox network is not isolated, before anything is recorded", async () => {
    await withExecutor(async (executor) => {
      const { docker } = executor;
      docker.icc = undefined;
      const noIcc = await request(executor, "POST", "/v1/sandboxes", { body: CREATE });
      assert.equal(noIcc.status, 503);
      assert.deepEqual(await noIcc.json(), { error: "isolation_unavailable" });
      assert.equal((await request(executor, "GET", "/v1/health")).status, 503);

      docker.icc = "false";
      docker.ipv6 = true;
      const ipv6 = await request(executor, "POST", "/v1/sandboxes", { body: CREATE });
      assert.deepEqual(await ipv6.json(), { error: "isolation_unavailable" });
      assert.deepEqual(docker.runs(), []);
      assert.equal(executor.store.byLease("lease-1"), undefined);
    });
  });

  it("counts a create that lands once its fence is gone as unplaced: its slot is not reused, and its id stays closed until it is stopped", async () => {
    await withExecutor(async (executor) => {
      const { docker, clock } = executor;
      docker.runFates = ["dropped"];
      assert.equal(
        (await request(executor, "POST", "/v1/sandboxes", { body: CREATE })).status,
        503
      );
      const abandoned = await request(executor, "POST", "/v1/sandboxes/sandbox-1/abandon", {
        body: { reason: "dropped connection" },
      });
      assert.equal(abandoned.status, 200);

      // The fence holds the name while it exists, so only a fence that is gone lets a create land. Its id is closed,
      // so the container is counted as unplaced and never adopted into the slot.
      docker.containers.delete("oi-sandbox-1");
      const late = docker.land("oi-sandbox-1", ownedLabels("sandbox-1", 0));
      await createSandbox(executor, createBody("sandbox-2", "session-2", "lease-2"));
      const full = await request(executor, "POST", "/v1/sandboxes", {
        body: createBody("sandbox-3", "session-3", "lease-3", clock.nowMs),
      });
      assert.equal(full.status, 503);
      assert.deepEqual(await full.json(), { error: "capacity_exhausted" });
      // Its id reads as undecided, not absent, and its owner cannot clear the slot while the container lives.
      assert.equal((await request(executor, "GET", "/v1/sandboxes/sandbox-1")).status, 503);
      const busy = await request(executor, "POST", "/v1/sandboxes/sandbox-1/release", {
        body: { sessionId: "session-1", leaseToken: "lease-1" },
      });
      assert.equal(busy.status, 409);
      assert.deepEqual(await busy.json(), { error: "workspace_active" });

      // Stopped by id, the container leaves the cap, and the owner's release clears the slot.
      const stopped = await request(executor, "POST", `/v1/sandboxes/${late}/stop`, {
        body: { reason: "late create" },
      });
      assert.equal(stopped.status, 200);
      const released = await request(executor, "POST", "/v1/sandboxes/sandbox-1/release", {
        body: { sessionId: "session-1", leaseToken: "lease-1" },
      });
      assert.equal(released.status, 200);
      await createSandbox(executor, createBody("sandbox-3", "session-3", "lease-3", clock.nowMs));
    });
  });

  it("counts an owned container it cannot adopt against the cap, and holds its sandbox id", async () => {
    await withExecutor(async (executor) => {
      const { docker, store, runtime } = executor;
      await createSandbox(executor);
      // sandbox-7's container names slot 0, which sandbox-1 holds, so reconciliation cannot adopt it.
      docker.land("oi-sandbox-7", ownedLabels("sandbox-7", 0));
      assert.deepEqual(await reconcileContainers(store, runtime, () => NOW), {
        freed: 0,
        attached: 0,
        adopted: 0,
        unresolved: 0,
      });
      assert.equal(store.occupancy(), 2);

      const full = await request(executor, "POST", "/v1/sandboxes", {
        body: createBody("sandbox-2", "session-2", "lease-2"),
      });
      assert.equal(full.status, 503);
      assert.deepEqual(await full.json(), { error: "capacity_exhausted" });
      const held = await request(executor, "POST", "/v1/sandboxes", {
        body: createBody("sandbox-7", "session-7", "lease-7"),
      });
      assert.equal(held.status, 409);
      assert.deepEqual(await held.json(), { error: "sandbox_id_conflict" });
      assert.equal((await request(executor, "GET", "/v1/sandboxes/sandbox-7")).status, 503);
    });
  });

  it("adopts an orphan unacknowledged, stops it by id, and clears its workspace only by an operator release", async () => {
    await withExecutor(async (executor) => {
      const { docker, store, runtime, clock } = executor;
      const slot = slotPathOf(executor.stateFile, 0);
      docker.land("oi-sandbox-7", ownedLabels("sandbox-7", 0));
      assert.deepEqual(await reconcileContainers(store, runtime, () => NOW), {
        freed: 0,
        attached: 0,
        adopted: 1,
        unresolved: 1,
      });
      await writeFile(join(slot, "orphan.txt"), "left behind");
      // Adopted, but its runtime was never acknowledged here, so it does not read as running.
      assert.equal((await request(executor, "GET", "/v1/sandboxes/sandbox-7")).status, 503);
      const containerId = docker.containers.get("oi-sandbox-7")?.id as string;

      const stopped = await request(executor, "POST", `/v1/sandboxes/${containerId}/stop`, {
        body: { reason: "orphan" },
      });
      assert.equal(stopped.status, 200);
      // No session owns the workspace, so no owner's release clears it.
      const owner = await request(executor, "POST", "/v1/sandboxes/sandbox-7/release", {
        body: { sessionId: "session-7", leaseToken: `reconciled:${containerId}` },
      });
      assert.equal(owner.status, 409);
      const operator = await request(executor, "POST", "/v1/sandboxes/sandbox-7/operator-release", {
        body: { reason: "orphan cleanup" },
      });
      assert.equal(operator.status, 200);
      assert.deepEqual(await readdir(slot), []);

      await createSandbox(executor, createBody("sandbox-2", "session-2", "lease-2", clock.nowMs));
      assert.ok(hasFlag(docker.runs()[0], "--mount", `type=bind,source=${slot},target=/workspace`));
    });
  });

  it("refuses an operator release for a workspace an owner retains", async () => {
    await withExecutor(async (executor) => {
      const providerObjectId = await createSandbox(executor);
      const stopped = await request(executor, "POST", `/v1/sandboxes/${providerObjectId}/stop`, {
        body: { reason: "done" },
      });
      assert.equal(stopped.status, 200);
      const operator = await request(executor, "POST", "/v1/sandboxes/sandbox-1/operator-release", {
        body: { reason: "not an orphan" },
      });
      assert.equal(operator.status, 409);
      assert.deepEqual(await operator.json(), { error: "release_refused" });
      const unreasoned = await request(
        executor,
        "POST",
        "/v1/sandboxes/sandbox-1/operator-release",
        {
          body: {},
        }
      );
      assert.equal(unreasoned.status, 400);
    });
  });

  it("keeps an unacknowledged launch's container by id when it cannot be removed, and never reads it as running", async () => {
    await withExecutor(async (executor) => {
      const { docker, clock } = executor;
      // The runtime never answers, and docker cannot prove the container gone.
      docker.launchFates = ["silent"];
      docker.removeFails = true;
      const launch = await request(executor, "POST", "/v1/sandboxes", { body: CREATE });
      assert.equal(launch.status, 503);
      assert.deepEqual(await launch.json(), { error: "create_unresolved" });
      assert.equal((await request(executor, "GET", "/v1/sandboxes/sandbox-1")).status, 503);
      assert.equal(
        (await request(executor, "POST", "/v1/sandboxes", { body: CREATE })).status,
        503
      );

      const providerObjectId = await settledPresent(
        executor,
        "sandbox-1",
        "session-1",
        "lease-1",
        clock.nowMs
      );
      docker.removeFails = false;
      const stopped = await request(executor, "POST", `/v1/sandboxes/${providerObjectId}/stop`, {
        body: { reason: "launch failed" },
      });
      assert.equal(stopped.status, 200);
      assert.equal(docker.runs().length, 1);
    });
  });
});

/** The slot a create's run binds, as the --mount argument names it. */
function boundTo(docker: FakeDocker, run: number, slotPath: string): boolean {
  return hasFlag(docker.runs()[run], "--mount", `type=bind,source=${slotPath},target=/workspace`);
}

describe("workspace reuse after a failed create", () => {
  it("a launch the runtime refuses, after the sandbox wrote to its slot, leaves the slot clean for the next tenant", async () => {
    await withExecutor(async (executor) => {
      const slot = slotPathOf(executor.stateFile, 0);
      executor.docker.onRun = () => writeFile(join(slot, "tenant-1.txt"), "session-1 data");
      executor.docker.launchFates = ["refused"];
      const failed = await request(executor, "POST", "/v1/sandboxes", { body: CREATE });
      assert.equal(failed.status, 502);
      assert.deepEqual(await readdir(slot), []);

      executor.docker.onRun = () => {};
      await createSandbox(executor, createBody("sandbox-2", "session-2", "lease-2"));
      assert.ok(boundTo(executor.docker, 1, slot));
      assert.deepEqual(await readdir(slot), []);
    });
  });

  it("a markRunning failure, after the sandbox wrote to its slot, leaves the slot clean for the next tenant", async () => {
    await withExecutor(async (executor) => {
      const slot = slotPathOf(executor.stateFile, 0);
      executor.docker.onRun = () => writeFile(join(slot, "tenant-1.txt"), "session-1 data");
      failWrites(
        executor.stateFile,
        "fail_running",
        "UPDATE ON sandboxes WHEN NEW.status = 'running'"
      );
      const failed = await request(executor, "POST", "/v1/sandboxes", { body: CREATE });
      assert.equal(failed.status, 503);
      assert.deepEqual(await failed.json(), { error: "state_unavailable" });
      assert.equal(executor.docker.containers.size, 0);
      assert.deepEqual(await readdir(slot), []);

      clearWrites(executor.stateFile, "fail_running");
      executor.docker.onRun = () => {};
      await createSandbox(executor, createBody("sandbox-2", "session-2", "lease-2"));
      assert.ok(boundTo(executor.docker, 1, slot));
      assert.deepEqual(await readdir(slot), []);
    });
  });

  it("a slot that cannot be cleared after a removed launch is retained for its owner, not freed to the next tenant", async () => {
    await withStateDir(async (stateFile) => {
      let failReset = true;
      const executor = await startExecutor(stateFile, new FakeDocker(), undefined, {
        resetWorkspace: async (hostPath) => {
          if (failReset) throw new Error("simulated reset failure");
          await resetSlot(hostPath);
        },
      });
      try {
        const slot = slotPathOf(stateFile, 0);
        executor.docker.onRun = () => writeFile(join(slot, "tenant-1.txt"), "session-1 data");
        executor.docker.launchFates = ["refused"];
        const failed = await request(executor, "POST", "/v1/sandboxes", { body: CREATE });
        assert.equal(failed.status, 503);
        assert.deepEqual(await failed.json(), { error: "workspace_unavailable" });
        assert.equal(executor.docker.containers.size, 0);
        // Undecided, not freed: the record keeps the removed container's id, and the slot stays held.
        assert.equal(executor.store.byLease("lease-1")?.status, "unresolved");
        const slotRow = withRawDb(stateFile, (db) =>
          db.prepare("SELECT state FROM workspaces WHERE slot = 0").get()
        );
        assert.equal(slotRow?.state, "held");
        // Another session cannot bind the held sandbox while the reset still fails.
        const other = await request(executor, "POST", "/v1/sandboxes", {
          body: createBody("sandbox-1", "session-2", "lease-3"),
        });
        assert.equal(other.status, 409);
        assert.deepEqual(await other.json(), { error: "sandbox_id_conflict" });

        failReset = false;
        executor.docker.onRun = () => {};
        // The next create's pass retains the uncleared slot for its owner, so the next tenant binds slot 1.
        await createSandbox(executor, createBody("sandbox-2", "session-2", "lease-2"));
        assert.ok(boundTo(executor.docker, 1, slotPathOf(stateFile, 1)));
        assert.deepEqual(await readdir(slot), ["tenant-1.txt"]);

        const released = await request(executor, "POST", "/v1/sandboxes/sandbox-1/release", {
          body: { sessionId: "session-1", leaseToken: "lease-1" },
        });
        assert.equal(released.status, 200);
        assert.deepEqual(await readdir(slot), []);
      } finally {
        await executor.close();
      }
    });
  });

  it("a reattached launch the runtime refuses keeps the owner's retained data, and the slot is not freed", async () => {
    await withExecutor(async (executor) => {
      const slot = slotPathOf(executor.stateFile, 0);
      const providerObjectId = await createSandbox(executor);
      const stopped = await request(executor, "POST", `/v1/sandboxes/${providerObjectId}/stop`, {
        body: { reason: "done" },
      });
      assert.equal(stopped.status, 200);
      await writeFile(join(slot, "owner.txt"), "session-1 data");

      executor.docker.onRun = () =>
        writeFile(join(slot, "relaunch.txt"), "written by the relaunch");
      executor.docker.launchFates = ["refused"];
      const failed = await request(executor, "POST", "/v1/sandboxes", {
        body: createBody("sandbox-1", "session-1", "lease-2"),
      });
      assert.equal(failed.status, 502);
      assert.deepEqual(await failed.json(), { error: "runtime_start_failed" });
      assert.equal(await readFile(join(slot, "owner.txt"), "utf8"), "session-1 data");

      executor.docker.onRun = () => {};
      await createSandbox(executor, createBody("sandbox-2", "session-2", "lease-3"));
      assert.ok(boundTo(executor.docker, 2, slotPathOf(executor.stateFile, 1)));

      // The owner still releases the slot with the lease that retained it, and the release clears it.
      const released = await request(executor, "POST", "/v1/sandboxes/sandbox-1/release", {
        body: { sessionId: "session-1", leaseToken: "lease-1" },
      });
      assert.equal(released.status, 200);
      assert.deepEqual(await readdir(slot), []);
    });
  });
});

describe("reconciliation of a removed container and a reattached slot", () => {
  it("does not adopt a container a stop removed, when a listing taken before the stop is processed after the release", async () => {
    await withExecutor(async (executor) => {
      const { docker, store } = executor;
      const providerObjectId = await createSandbox(executor);
      // A listing taken while the container still ran.
      const stale = await executor.runtime.inventory();
      const stopped = await request(executor, "POST", `/v1/sandboxes/${providerObjectId}/stop`, {
        body: { reason: "done" },
      });
      assert.equal(stopped.status, 200);
      const released = await request(executor, "POST", "/v1/sandboxes/sandbox-1/release", {
        body: { sessionId: "session-1", leaseToken: "lease-1" },
      });
      assert.equal(released.status, 200);

      const late = { ...executor.runtime, inventory: async () => stale };
      assert.deepEqual(await reconcileContainers(store, late, () => NOW), {
        freed: 0,
        attached: 0,
        adopted: 0,
        unresolved: 0,
      });
      // The stale container counts toward the cap until a listing that lacks it is read.
      assert.equal(store.occupancy(), 1);
      await reconcileContainers(store, executor.runtime, () => NOW);
      assert.equal(store.occupancy(), 0);

      await createSandbox(executor, createBody("sandbox-2", "session-2", "lease-2"));
      assert.ok(boundTo(docker, 1, slotPathOf(executor.stateFile, 0)));
    });
  });

  it("does not adopt a container a failed launch removed, when a listing taken before the removal is processed after the forget", async () => {
    await withExecutor(async (executor) => {
      const { docker, store } = executor;
      docker.launchFates = ["refused"];
      const failed = await request(executor, "POST", "/v1/sandboxes", { body: CREATE });
      assert.equal(failed.status, 502);
      const removed = docker.calls.find(([command]) => command === "rm")?.[2] as string;
      // The listing a pass took while the container still ran, as the removal and the forget finished after it.
      const stale: DockerInventory = {
        containerIds: new Set([removed]),
        owned: [{ containerId: removed, sandboxId: "sandbox-1", workspaceSlot: 0 }],
        fences: [],
      };
      const late = { ...executor.runtime, inventory: async () => stale };
      assert.deepEqual(await reconcileContainers(store, late, () => NOW), {
        freed: 0,
        attached: 0,
        adopted: 0,
        unresolved: 0,
      });
      assert.equal(store.byLease("lease-1"), undefined);
      assert.equal(store.occupancy(), 1);
      await reconcileContainers(store, executor.runtime, () => NOW);
      assert.equal(store.occupancy(), 0);

      await createSandbox(executor, createBody("sandbox-2", "session-2", "lease-2"));
      assert.ok(boundTo(docker, 1, slotPathOf(executor.stateFile, 0)));
    });
  });

  it("settles a create whose settle write failed without a restart, so its sandbox id can be abandoned", async () => {
    await withExecutor(async (executor) => {
      // docker kills the create before it answers, and the state refuses the unresolved mark that would record it.
      executor.docker.runFates = ["killed"];
      failWrites(
        executor.stateFile,
        "fail_unresolved",
        "UPDATE ON sandboxes WHEN NEW.status = 'unresolved'"
      );
      const failed = await request(executor, "POST", "/v1/sandboxes", { body: CREATE });
      assert.equal(failed.status, 503);
      assert.deepEqual(await failed.json(), { error: "create_unresolved" });
      assert.equal(executor.store.byLease("lease-1")?.status, "creating");

      clearWrites(executor.stateFile, "fail_unresolved");
      // The timer's pass runs with no create in flight, so it settles the orphan the failed write left behind.
      await reconcileContainers(executor.store, executor.runtime, () => NOW, new Set());
      assert.equal(executor.store.byLease("lease-1")?.status, "unresolved");
      const abandoned = await request(executor, "POST", "/v1/sandboxes/sandbox-1/abandon", {
        body: { reason: "stuck" },
      });
      assert.equal(abandoned.status, 200);
      assert.deepEqual(await abandoned.json(), { abandoned: true });
      assert.equal(executor.store.settledFor("lease-1", "sandbox-1"), true);
      await createSandbox(executor, createBody("sandbox-2", "session-2", "lease-2"));
    });
  });

  it("repairs a reattached slot's root and home before the host check, and only once no owned container names it", async () => {
    await withStateDir(async (stateFile) => {
      const events: string[] = [];
      let widened = false;
      const executor = await startExecutor(stateFile, new FakeDocker(), undefined, {
        checkWorkspace: async () => {
          events.push("checkWorkspace");
          if (widened) throw new Error("workspace slot unavailable: mode lacks owner rwx");
        },
        repairWorkspace: async () => {
          events.push("repairWorkspace");
          widened = false;
        },
        repairHome: async () => {
          events.push("repairHome");
        },
        prepareHome: async () => {
          events.push("prepareHome");
        },
      });
      try {
        const providerObjectId = await createSandbox(executor);
        const stopped = await request(executor, "POST", `/v1/sandboxes/${providerObjectId}/stop`, {
          body: { reason: "done" },
        });
        assert.equal(stopped.status, 200);
        // The sandbox widened its root while it ran, so the bind must repair it before the check.
        widened = true;
        events.length = 0;

        // A container that names the slot, though not the sandbox, still runs: nothing is repaired.
        executor.docker.land("oi-sandbox-7", ownedLabels("sandbox-7", 0));
        const busy = await request(executor, "POST", "/v1/sandboxes", {
          body: createBody("sandbox-1", "session-1", "lease-2"),
        });
        assert.equal(busy.status, 409);
        assert.deepEqual(await busy.json(), { error: "workspace_busy" });
        assert.deepEqual(events, []);
        assert.equal(executor.store.byLease("lease-2"), undefined);

        executor.docker.containers.delete("oi-sandbox-7");
        const again = await request(executor, "POST", "/v1/sandboxes", {
          body: createBody("sandbox-1", "session-1", "lease-3"),
        });
        assert.equal(again.status, 201);
        assert.deepEqual(events, [
          "repairWorkspace",
          "repairHome",
          "checkWorkspace",
          "prepareHome",
        ]);
      } finally {
        await executor.close();
      }
    });
  });

  // The two ways a release fails: the state write frees nothing, or it throws.
  const RELEASE_FAILURES = [
    () => false,
    () => {
      throw new Error("state write failed");
    },
  ];

  it("answers a busy reattach as undecided, not busy, when its release is not recorded", async () => {
    for (const releaseFails of RELEASE_FAILURES) {
      await withStateDir(async (stateFile) => {
        const executor = await startExecutor(stateFile);
        try {
          const providerObjectId = await createSandbox(executor);
          const stopped = await request(
            executor,
            "POST",
            `/v1/sandboxes/${providerObjectId}/stop`,
            {
              body: { reason: "done" },
            }
          );
          assert.equal(stopped.status, 200);
          // An owned container names the slot, so the reattach is refused after its admission.
          executor.docker.land("oi-sandbox-7", ownedLabels("sandbox-7", 0));
          executor.store.forget = releaseFails;
          const undecided = await request(executor, "POST", "/v1/sandboxes", {
            body: createBody("sandbox-1", "session-1", "lease-2"),
          });
          assert.equal(undecided.status, 503);
          assert.deepEqual(await undecided.json(), { error: "create_unresolved" });
          assert.equal(executor.store.byLease("lease-2")?.status, "unresolved");
          assert.equal(executor.docker.runs().length, 1);
        } finally {
          await executor.close();
        }
      });
    }
  });

  it("answers a refused slot as undecided, not unavailable, when its release is not recorded", async () => {
    for (const releaseFails of RELEASE_FAILURES) {
      await withStateDir(async (stateFile) => {
        const executor = await startExecutor(stateFile, new FakeDocker(), undefined, {
          checkWorkspace: async () => {
            throw new Error("workspace slot unavailable: not a separate mount");
          },
        });
        try {
          executor.store.forget = releaseFails;
          const refused = await request(executor, "POST", "/v1/sandboxes", { body: CREATE });
          assert.equal(refused.status, 503);
          assert.deepEqual(await refused.json(), { error: "create_unresolved" });
          assert.equal(executor.docker.runs().length, 0);
          assert.equal(executor.store.byLease("lease-1")?.status, "unresolved");
        } finally {
          await executor.close();
        }
      });
    }
  });

  it("answers a create whose docker CLI is missing as undecided, not released, when its release is not recorded", async () => {
    for (const releaseFails of RELEASE_FAILURES) {
      await withExecutor(async (executor) => {
        executor.docker.runFates = ["missing"];
        executor.store.forget = releaseFails;
        const failed = await request(executor, "POST", "/v1/sandboxes", { body: CREATE });
        assert.equal(failed.status, 503);
        assert.deepEqual(await failed.json(), { error: "create_unresolved" });
        assert.equal(executor.store.byLease("lease-1")?.status, "unresolved");
      });
    }
  });

  it("answers a create docker refused as undecided, not failed, when its release is not recorded", async () => {
    for (const releaseFails of RELEASE_FAILURES) {
      await withExecutor(async (executor) => {
        executor.docker.runFates = ["rejected"];
        executor.store.forget = releaseFails;
        const failed = await request(executor, "POST", "/v1/sandboxes", { body: CREATE });
        assert.equal(failed.status, 503);
        assert.deepEqual(await failed.json(), { error: "create_unresolved" });
        assert.equal(executor.store.byLease("lease-1")?.status, "unresolved");
      });
    }
  });
});
