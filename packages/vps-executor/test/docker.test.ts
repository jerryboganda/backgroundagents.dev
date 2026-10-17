import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildRunArgs,
  ContainerNotFoundError,
  createDockerRuntime,
  IsolationUnavailableError,
  type DockerExec,
  type DockerRuntime,
} from "../src/docker.ts";

const IMAGE = "open-inspect/sandbox:test";
const LIMITS = { cpus: "2", memory: "4g", pidsLimit: 512 };
const CONTAINER_ID = "a".repeat(64);

/** Fake docker CLI. Records argv and never spawns a process. */
function fakeDocker(respond: (args: readonly string[]) => { stdout: string }) {
  const calls: string[][] = [];
  const exec: DockerExec = async (args) => {
    calls.push([...args]);
    return respond(args);
  };
  return { exec, calls };
}

function runtimeWith(exec: DockerExec): DockerRuntime {
  return createDockerRuntime({ exec, image: IMAGE, limits: LIMITS });
}

describe("buildRunArgs", () => {
  it("runs under runsc with explicit cpu, memory, swap and pid limits", () => {
    assert.deepEqual(buildRunArgs("sandbox-1", IMAGE, LIMITS), [
      "run",
      "-d",
      "--name",
      "oi-sandbox-1",
      "--runtime",
      "runsc",
      "--cpus",
      "2",
      "--memory",
      "4g",
      "--memory-swap",
      "4g",
      "--pids-limit",
      "512",
      "--security-opt",
      "no-new-privileges",
      "--label",
      "open-inspect.managed=vps-executor",
      "--label",
      "open-inspect.sandbox-id=sandbox-1",
      IMAGE,
    ]);
  });

  it("rejects values that could reach docker as flags or malformed limits", () => {
    assert.throws(() => buildRunArgs("--privileged", IMAGE, LIMITS), /invalid sandbox id/);
    assert.throws(() => buildRunArgs("sandbox-1", "-v", LIMITS), /image/);
    assert.throws(() => buildRunArgs("sandbox-1", IMAGE, { ...LIMITS, cpus: "two" }), /cpu/);
    assert.throws(() => buildRunArgs("sandbox-1", IMAGE, { ...LIMITS, memory: "4 gigs" }), /memory/);
    assert.throws(() => buildRunArgs("sandbox-1", IMAGE, { ...LIMITS, pidsLimit: 0 }), /pids/);
  });
});

describe("createDockerRuntime", () => {
  it("fails closed unless docker has a runsc runtime registered", async () => {
    const runc = fakeDocker(() => ({ stdout: '{"runc":{"path":"runc"}}' }));
    await assert.rejects(runtimeWith(runc.exec).checkIsolation(), IsolationUnavailableError);

    const gvisor = fakeDocker(() => ({ stdout: '{"runc":{},"runsc":{"path":"runsc"}}' }));
    await runtimeWith(gvisor.exec).checkIsolation();
    assert.deepEqual(gvisor.calls, [["info", "--format", "{{json .Runtimes}}"]]);

    const down = fakeDocker(() => {
      throw new Error("Cannot connect to the Docker daemon");
    });
    await assert.rejects(runtimeWith(down.exec).checkIsolation(), IsolationUnavailableError);

    const garbled = fakeDocker(() => ({ stdout: "not json" }));
    await assert.rejects(runtimeWith(garbled.exec).checkIsolation(), IsolationUnavailableError);
  });

  it("returns the container id from docker run", async () => {
    const docker = fakeDocker(() => ({ stdout: `${CONTAINER_ID}\n` }));
    const containerId = await runtimeWith(docker.exec).runSandbox("sandbox-1");
    assert.equal(containerId, CONTAINER_ID);
    assert.deepEqual(docker.calls, [buildRunArgs("sandbox-1", IMAGE, LIMITS)]);
  });

  it("rejects docker run output that is not a container id", async () => {
    const docker = fakeDocker(() => ({ stdout: "Error: something\n" }));
    await assert.rejects(runtimeWith(docker.exec).runSandbox("sandbox-1"), /container id/);
  });

  it("maps 'No such container' on remove to ContainerNotFoundError", async () => {
    const docker = fakeDocker(() => {
      throw Object.assign(new Error("docker rm failed"), {
        stderr: "Error response from daemon: No such container: abc",
      });
    });
    await assert.rejects(runtimeWith(docker.exec).removeSandbox(CONTAINER_ID), ContainerNotFoundError);
    assert.deepEqual(docker.calls, [["rm", "-f", CONTAINER_ID]]);
  });

  it("propagates other remove failures and refuses non-id input before calling docker", async () => {
    const docker = fakeDocker(() => {
      throw Object.assign(new Error("docker rm failed"), { stderr: "daemon unreachable" });
    });
    const runtime = runtimeWith(docker.exec);
    await assert.rejects(runtime.removeSandbox(CONTAINER_ID), (error: unknown) => {
      return error instanceof Error && !(error instanceof ContainerNotFoundError);
    });
    await assert.rejects(runtime.removeSandbox("--all"), /invalid container id/);
    assert.equal(docker.calls.length, 1);
  });
});
