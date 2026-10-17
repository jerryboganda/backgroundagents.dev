import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { admissionSignature } from "../src/admission.ts";
import { createDockerRuntime, type DockerExec } from "../src/docker.ts";
import { createExecutorServer, openStateStore } from "../src/server.ts";

const TOKEN = "test-executor-token-0123456789abcdef";
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const IMAGE = "open-inspect/sandbox:test";
const LIMITS = { cpus: "2", memory: "4g", pidsLimit: 512 };
const NOW = 1_700_000_000_000;
const ADMISSION_SECRET = "test-admission-secret-0123456789abcdef";
const CREATE = {
  sandboxId: "sandbox-1",
  sessionId: "session-1",
  admissionLease: signedLease("sandbox-1", "session-1", "lease-1", NOW + 60_000),
};

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

interface FixtureOptions {
  /** Set false to make docker report only runc. Defaults to gVisor present. */
  gvisor?: boolean;
  /** When set, every docker rm fails with this stderr. */
  rmStderr?: string;
}

interface Executor {
  baseUrl: string;
  dockerCalls: string[][];
  close(): Promise<void>;
}

/** Runs the real server against a fake docker CLI and the given state file. */
async function startExecutor(stateFile: string, options: FixtureOptions = {}): Promise<Executor> {
  const dockerCalls: string[][] = [];
  let containers = 0;
  const exec: DockerExec = async (args) => {
    dockerCalls.push([...args]);
    switch (args[0]) {
      case "info":
        return { stdout: JSON.stringify(options.gvisor === false ? { runc: {} } : { runc: {}, runsc: {} }) };
      case "run":
        containers += 1;
        return { stdout: `${containers.toString(16).padStart(64, "0")}\n` };
      case "rm":
        if (options.rmStderr) throw Object.assign(new Error("docker rm failed"), { stderr: options.rmStderr });
        return { stdout: "" };
      default:
        throw new Error(`unexpected docker call: ${args[0]}`);
    }
  };
  const runtime = createDockerRuntime({ exec, image: IMAGE, limits: LIMITS });
  const store = await openStateStore(stateFile);
  const server = createExecutorServer({
    token: TOKEN,
    admissionSecret: ADMISSION_SECRET,
    runtime,
    store,
    now: () => NOW,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    dockerCalls,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function withExecutor(options: FixtureOptions, run: (executor: Executor) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "vps-executor-"));
  const executor = await startExecutor(join(dir, "state.json"), options);
  try {
    await run(executor);
  } finally {
    await executor.close();
    await rm(dir, { recursive: true, force: true });
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

async function createSandbox(executor: Executor): Promise<string> {
  const res = await request(executor, "POST", "/v1/sandboxes", { body: CREATE });
  assert.equal(res.status, 201);
  return ((await res.json()) as { providerObjectId: string }).providerObjectId;
}

function hasFlag(args: string[], flag: string, value: string): boolean {
  const index = args.indexOf(flag);
  return index !== -1 && args[index + 1] === value;
}

describe("executor HTTP API", () => {
  it("reports health from the runsc check, without auth", async () => {
    await withExecutor({}, async (executor) => {
      const res = await request(executor, "GET", "/v1/health", { headers: {} });
      assert.equal(res.status, 200);
    });
    await withExecutor({ gvisor: false }, async (executor) => {
      const res = await request(executor, "GET", "/v1/health", { headers: {} });
      assert.equal(res.status, 503);
    });
  });

  it("requires the bearer token on every sandbox endpoint", async () => {
    await withExecutor({}, async (executor) => {
      const wrong = { Authorization: "Bearer not-the-token" };
      const create = await request(executor, "POST", "/v1/sandboxes", { body: CREATE, headers: {} });
      assert.equal(create.status, 401);
      assert.equal(create.headers.get("www-authenticate"), "Bearer");
      const wrongCreate = await request(executor, "POST", "/v1/sandboxes", { body: CREATE, headers: wrong });
      assert.equal(wrongCreate.status, 401);
      const resolve = await request(executor, "GET", "/v1/sandboxes/sandbox-1", { headers: {} });
      assert.equal(resolve.status, 401);
      const stop = await request(executor, "POST", "/v1/sandboxes/abc/stop", {
        body: { reason: "test" },
        headers: {},
      });
      assert.equal(stop.status, 401);
      assert.deepEqual(executor.dockerCalls, []);
    });
  });

  it("refuses create without a future admission lease before touching docker", async () => {
    await withExecutor({}, async (executor) => {
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
      assert.deepEqual(executor.dockerCalls, []);
    });
  });

  it("refuses a lease that is forged or signed for another sandbox before touching docker", async () => {
    await withExecutor({}, async (executor) => {
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
      assert.deepEqual(executor.dockerCalls, []);
    });
  });

  it("fails closed when docker has no runsc runtime", async () => {
    await withExecutor({ gvisor: false }, async (executor) => {
      const res = await request(executor, "POST", "/v1/sandboxes", { body: CREATE });
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { error: "isolation_unavailable" });
      assert.deepEqual(
        executor.dockerCalls.map((args) => args[0]),
        ["info"]
      );
    });
  });

  it("creates under runsc with explicit limits, then resolves and stops", async () => {
    await withExecutor({}, async (executor) => {
      const providerObjectId = await createSandbox(executor);
      assert.match(providerObjectId, /^[0-9a-f]{64}$/);

      const runArgs = executor.dockerCalls.find((args) => args[0] === "run");
      assert.ok(runArgs);
      assert.ok(hasFlag(runArgs, "--runtime", "runsc"));
      assert.ok(hasFlag(runArgs, "--cpus", "2"));
      assert.ok(hasFlag(runArgs, "--memory", "4g"));
      assert.ok(hasFlag(runArgs, "--pids-limit", "512"));

      const resolved = await request(executor, "GET", "/v1/sandboxes/sandbox-1");
      assert.deepEqual(await resolved.json(), { sandboxId: "sandbox-1", providerObjectId });

      const stopped = await request(executor, "POST", `/v1/sandboxes/${providerObjectId}/stop`, {
        body: { reason: "test" },
      });
      assert.equal(stopped.status, 200);
      assert.deepEqual(executor.dockerCalls.at(-1), ["rm", "-f", providerObjectId]);

      assert.equal((await request(executor, "GET", "/v1/sandboxes/sandbox-1")).status, 404);
      const again = await request(executor, "POST", `/v1/sandboxes/${providerObjectId}/stop`, {
        body: { reason: "again" },
      });
      assert.equal(again.status, 404);
    });
  });

  it("is idempotent per sandbox id", async () => {
    await withExecutor({}, async (executor) => {
      const providerObjectId = await createSandbox(executor);
      const again = await request(executor, "POST", "/v1/sandboxes", { body: CREATE });
      assert.equal(again.status, 200);
      assert.deepEqual(await again.json(), { providerObjectId });
      assert.equal(executor.dockerCalls.filter((args) => args[0] === "run").length, 1);
    });
  });

  it("refuses a sandbox id held by another session, without a second container", async () => {
    await withExecutor({}, async (executor) => {
      await createSandbox(executor);
      const other = {
        sandboxId: "sandbox-1",
        sessionId: "session-2",
        admissionLease: signedLease("sandbox-1", "session-2", "lease-2", NOW + 60_000),
      };
      const res = await request(executor, "POST", "/v1/sandboxes", { body: other });
      assert.equal(res.status, 409);
      assert.deepEqual(await res.json(), { error: "sandbox_id_conflict" });
      assert.equal(executor.dockerCalls.filter((args) => args[0] === "run").length, 1);
    });
  });

  it("treats an already-removed container as gone on stop", async () => {
    await withExecutor(
      { rmStderr: "Error response from daemon: No such container: gone" },
      async (executor) => {
        const providerObjectId = await createSandbox(executor);
        const stopped = await request(executor, "POST", `/v1/sandboxes/${providerObjectId}/stop`, {
          body: { reason: "test" },
        });
        assert.equal(stopped.status, 404);
        assert.equal((await request(executor, "GET", "/v1/sandboxes/sandbox-1")).status, 404);
      }
    );
  });

  it("keeps the record when docker fails to remove the container", async () => {
    await withExecutor({ rmStderr: "Cannot connect to the Docker daemon" }, async (executor) => {
      const providerObjectId = await createSandbox(executor);
      const stopped = await request(executor, "POST", `/v1/sandboxes/${providerObjectId}/stop`, {
        body: { reason: "test" },
      });
      assert.equal(stopped.status, 502);
      assert.equal((await request(executor, "GET", "/v1/sandboxes/sandbox-1")).status, 200);
    });
  });

  it("rejects malformed ids and bodies before docker runs", async () => {
    await withExecutor({}, async (executor) => {
      const badId = await request(executor, "POST", "/v1/sandboxes", {
        body: { ...CREATE, sandboxId: "--privileged" },
      });
      assert.equal(badId.status, 400);
      const badReason = await request(executor, "POST", "/v1/sandboxes/abc/stop", {
        body: { reason: 42 },
      });
      assert.equal(badReason.status, 400);
      assert.deepEqual(executor.dockerCalls, []);
    });
  });

  it("keeps records across a restart and refuses a corrupt state file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vps-executor-"));
    const stateFile = join(dir, "state.json");
    try {
      const first = await startExecutor(stateFile);
      try {
        await createSandbox(first);
      } finally {
        await first.close();
      }

      const second = await startExecutor(stateFile);
      try {
        assert.equal((await request(second, "GET", "/v1/sandboxes/sandbox-1")).status, 200);
      } finally {
        await second.close();
      }

      await writeFile(stateFile, "{not json");
      await assert.rejects(openStateStore(stateFile));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
