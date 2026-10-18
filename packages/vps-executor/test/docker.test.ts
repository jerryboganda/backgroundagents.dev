import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildFenceArgs,
  buildRunArgs,
  ContainerNotFoundError,
  createDockerRuntime,
  FenceUnknownError,
  IsolationUnavailableError,
  NameHeldError,
  RunNotStartedError,
  RunOutcomeUnknownError,
  RunRejectedByDaemonError,
  RuntimeLaunchUnknownError,
  RuntimeRefusedError,
  SESSION_CONTEXT_ACCEPTED_LINE,
  type DockerExec,
  type DockerRuntime,
  type SpawnDocker,
} from "../src/docker.ts";
import { FakeExecChild } from "./fake-exec-child.ts";

const IMAGE = "open-inspect/sandbox:test";
const LIMITS = { cpus: "2", memory: "4g", pidsLimit: 512 };
const MOUNT = { slot: 0, hostPath: "/srv/vps-ws/slots/0" };
const CONTAINER_ID = "a".repeat(64);
const OTHER_CONTAINER_ID = "b".repeat(64);

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

/** One `docker ps --format {{json .}}` line. */
function listed(id: string, name: string, labels: string): string {
  return JSON.stringify({ ID: id, Names: name, Labels: labels });
}

const NETWORK_INSPECT = ["network", "inspect", "oi-sandbox", "--format", "{{json .}}"];

/** The sandbox network as the host contract provisions it (a bridge, ICC off, IPv6 off), with `changes` applied. */
function isolatedNetwork(changes: Record<string, unknown> = {}): string {
  return JSON.stringify({
    Name: "oi-sandbox",
    Driver: "bridge",
    EnableIPv6: false,
    Options: { "com.docker.network.bridge.enable_icc": "false" },
    ...changes,
  });
}

/** docker's refusal of a create whose name another container holds. */
function nameTaken(name: string): Error {
  return Object.assign(new Error("docker create failed"), {
    stderr: `docker: Error response from daemon: Conflict. The container name "/${name}" is already in use by container "x". You have to remove (or rename) that container to be able to reuse that name.`,
    code: 125,
  });
}

/** The host path of each bind mount in a docker run argv, in order. */
function mountSources(args: readonly string[]): string[] {
  return args
    .filter((arg) => arg.startsWith("type=bind,"))
    .map((arg) => arg.split(",")[1].slice("source=".length));
}

describe("buildRunArgs", () => {
  it("runs under runsc with explicit limits, a non-root user, a read-only root, and its slot and home bound", () => {
    assert.deepEqual(buildRunArgs("sandbox-1", IMAGE, LIMITS, MOUNT), [
      "run",
      "-d",
      "--name",
      "oi-sandbox-1",
      "--pull",
      "never",
      "--network",
      "oi-sandbox",
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
      "--user",
      "1000:1000",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--tmpfs",
      "/tmp:exec,nosuid,nodev,size=256m",
      "--tmpfs",
      "/tmp/.X11-unix:nosuid,nodev,mode=1777,size=1m",
      "--mount",
      "type=bind,source=/srv/vps-ws/slots/0,target=/workspace",
      "--mount",
      `type=bind,source=${join("/srv/vps-ws/slots/0", "home")},target=/home/sandbox`,
      "--mount",
      "type=bind,source=/etc/polytronx/sandbox-resolv.conf,target=/etc/resolv.conf,readonly",
      "--workdir",
      "/workspace",
      "-e",
      "HOME=/home/sandbox",
      "-e",
      "OI_DEFERRED_START=true",
      "--label",
      "open-inspect.managed=vps-executor",
      "--label",
      "open-inspect.sandbox-id=sandbox-1",
      "--label",
      "open-inspect.workspace-slot=0",
      IMAGE,
    ]);
  });

  it("pulls nothing and joins only the sandbox network, never the host's", () => {
    const args = buildRunArgs("sandbox-1", IMAGE, LIMITS, MOUNT);
    assert.equal(args[args.indexOf("--pull") + 1], "never");
    assert.equal(args[args.indexOf("--network") + 1], "oi-sandbox");
    assert.equal(
      args.some((arg) => arg === "host" || arg.startsWith("container:")),
      false
    );
  });

  it("adds no privilege, no host network, no device, and no host path beyond its one slot", () => {
    const args = buildRunArgs("sandbox-1", IMAGE, LIMITS, MOUNT);
    for (const flag of [
      "--privileged",
      "--net",
      "--device",
      "--cap-add",
      "--volume",
      "-v",
      "--pid",
      "--ipc",
      "--userns",
    ])
      assert.equal(args.includes(flag), false, flag);
    // Three binds and no more: the slot, its home subdirectory, and the read-only resolver file.
    assert.deepEqual(mountSources(args), [
      MOUNT.hostPath,
      join(MOUNT.hostPath, "home"),
      "/etc/polytronx/sandbox-resolv.conf",
    ]);
    assert.ok(
      args.includes(
        "type=bind,source=/etc/polytronx/sandbox-resolv.conf,target=/etc/resolv.conf,readonly"
      )
    );
    assert.equal(
      args.some((arg) => arg.includes("docker.sock")),
      false
    );
  });

  it("rejects values that could reach docker as flags or malformed limits", () => {
    assert.throws(() => buildRunArgs("--privileged", IMAGE, LIMITS, MOUNT), /invalid sandbox id/);
    assert.throws(() => buildRunArgs("sandbox-1", "-v", LIMITS, MOUNT), /image/);
    assert.throws(() => buildRunArgs("sandbox-1", IMAGE, { ...LIMITS, cpus: "two" }, MOUNT), /cpu/);
    assert.throws(
      () => buildRunArgs("sandbox-1", IMAGE, { ...LIMITS, memory: "4 gigs" }, MOUNT),
      /memory/
    );
    assert.throws(
      () => buildRunArgs("sandbox-1", IMAGE, { ...LIMITS, pidsLimit: 0 }, MOUNT),
      /pids/
    );
  });

  it("binds only a slot's own path, and refuses a mount whose path or slot does not match", () => {
    assert.throws(
      () =>
        buildRunArgs("sandbox-1", IMAGE, LIMITS, {
          slot: 0,
          hostPath: "/srv/vps-ws/slots/0,readonly=false",
        }),
      /invalid workspace mount/
    );
    assert.throws(
      () => buildRunArgs("sandbox-1", IMAGE, LIMITS, { slot: 1, hostPath: "/srv/vps-ws/slots/0" }),
      /invalid workspace mount/
    );
    assert.throws(
      () => buildRunArgs("sandbox-1", IMAGE, LIMITS, { slot: 6, hostPath: "/srv/vps-ws/slots/6" }),
      /invalid workspace mount/
    );
    assert.throws(
      () =>
        buildRunArgs("sandbox-1", IMAGE, LIMITS, {
          slot: 0,
          hostPath: "/srv/vps-ws/slots\n/0",
        }),
      /invalid workspace mount/
    );
  });
});

const SECRET = "synthetic-session-token-0123456789abcdef";
const SESSION_CONTEXT = JSON.stringify({ version: 1, env: { SANDBOX_AUTH_TOKEN: SECRET } });
const LAUNCH_ARGS = [
  "exec",
  "-i",
  CONTAINER_ID,
  "/opt/openinspect/python/bin/python",
  "-m",
  "sandbox_runtime.entrypoint",
  "--session-context-stdin-v1",
];

/** A launch runtime whose docker children answer as `answer` says. Records every argv spawned. */
function launchingWith(answer: (child: FakeExecChild) => void, launchTimeoutMs = 5_000) {
  const spawned: string[][] = [];
  const children: FakeExecChild[] = [];
  const spawnDocker: SpawnDocker = (args) => {
    spawned.push([...args]);
    const child = new FakeExecChild(answer);
    children.push(child);
    return child.asChildProcess();
  };
  const runtime = createDockerRuntime({
    exec: fakeDocker(() => ({ stdout: "" })).exec,
    image: IMAGE,
    limits: LIMITS,
    spawnDocker,
    launchTimeoutMs,
  });
  return { runtime, spawned, children };
}

describe("launchRuntime", () => {
  it("writes the context to stdin and resolves on the acceptance line, which is the only proof", async () => {
    const { runtime, spawned, children } = launchingWith((child) => {
      child.stderr.write("noise\n");
      child.stdout.write(`booting\n${SESSION_CONTEXT_ACCEPTED_LINE}\n`);
    });
    await runtime.launchRuntime(CONTAINER_ID, SESSION_CONTEXT);
    assert.deepEqual(spawned, [LAUNCH_ARGS]);
    assert.deepEqual(children[0].input, [`${SESSION_CONTEXT}\n`]);
  });

  it("keeps the context out of argv and out of any error, and refuses a process that exits without accepting", async () => {
    const { runtime, spawned } = launchingWith((child) => {
      child.stdout.write(`prefixed ${SESSION_CONTEXT_ACCEPTED_LINE}\n`);
      child.finish(1, null);
    });
    await assert.rejects(runtime.launchRuntime(CONTAINER_ID, SESSION_CONTEXT), (error: unknown) => {
      assert.ok(error instanceof RuntimeRefusedError);
      assert.ok(!String(error).includes(SECRET));
      return true;
    });
    assert.deepEqual(spawned, [LAUNCH_ARGS]);
    assert.ok(!spawned.flat().some((arg) => arg.includes(SECRET)));
  });

  it("reports a launch that a signal ends as unknown, since the runtime may have started", async () => {
    const { runtime } = launchingWith((child) => child.finish(null, "SIGTERM"));
    await assert.rejects(
      runtime.launchRuntime(CONTAINER_ID, SESSION_CONTEXT),
      RuntimeLaunchUnknownError
    );
  });

  it("kills a launch that never answers at its deadline, and reports it as unknown", async () => {
    const { runtime, children } = launchingWith(() => {}, 20);
    await assert.rejects(
      runtime.launchRuntime(CONTAINER_ID, SESSION_CONTEXT),
      RuntimeLaunchUnknownError
    );
    assert.equal(children[0].killed, "SIGKILL");
  });

  it("refuses a container id that is not one docker issued, before spawning anything", async () => {
    const { runtime, spawned } = launchingWith(() => {});
    await assert.rejects(runtime.launchRuntime("not-an-id", SESSION_CONTEXT));
    assert.deepEqual(spawned, []);
  });
});

describe("buildFenceArgs", () => {
  it("creates a never-started container under the sandbox name, with no mount, no network, and no owner label", () => {
    assert.deepEqual(buildFenceArgs("sandbox-1", IMAGE), [
      "create",
      "--name",
      "oi-sandbox-1",
      "--pull",
      "never",
      "--network",
      "none",
      "--label",
      "open-inspect.fence=name-reservation",
      IMAGE,
      "true",
    ]);
    assert.throws(() => buildFenceArgs("--privileged", IMAGE), /invalid sandbox id/);
  });
});

describe("fenceSandbox", () => {
  it("places the fence when the name is free", async () => {
    const docker = fakeDocker(() => ({ stdout: `${CONTAINER_ID}\n` }));
    await runtimeWith(docker.exec).fenceSandbox("sandbox-1");
    assert.deepEqual(docker.calls, [buildFenceArgs("sandbox-1", IMAGE)]);
  });

  it("resolves when its own fence holds the name, and names the holder when another container does", async () => {
    const ownFence = fakeDocker((args) => {
      if (args[0] === "create") throw nameTaken("oi-sandbox-1");
      return {
        stdout: `${listed(CONTAINER_ID, "oi-sandbox-1", "open-inspect.fence=name-reservation")}\n`,
      };
    });
    await runtimeWith(ownFence.exec).fenceSandbox("sandbox-1");

    const held = fakeDocker((args) => {
      if (args[0] === "create") throw nameTaken("oi-sandbox-1");
      return {
        stdout: `${listed(OTHER_CONTAINER_ID, "oi-sandbox-1", "open-inspect.managed=vps-executor,open-inspect.sandbox-id=sandbox-1,open-inspect.workspace-slot=0")}\n`,
      };
    });
    await assert.rejects(runtimeWith(held.exec).fenceSandbox("sandbox-1"), NameHeldError);
  });

  it("reports a fence without a verified outcome as unknown", async () => {
    const dropped = fakeDocker(() => {
      throw Object.assign(new Error("docker create failed"), {
        stderr: 'error during connect: Post "http://docker/v1.47/containers/create": EOF',
      });
    });
    await assert.rejects(runtimeWith(dropped.exec).fenceSandbox("sandbox-1"), FenceUnknownError);

    const noImage = fakeDocker(() => {
      throw Object.assign(new Error("docker create failed"), {
        stderr: "docker: Error response from daemon: No such image: open-inspect/sandbox:test",
        code: 125,
      });
    });
    await assert.rejects(runtimeWith(noImage.exec).fenceSandbox("sandbox-1"), FenceUnknownError);

    const unreadable = fakeDocker((args) => {
      if (args[0] === "create") throw nameTaken("oi-sandbox-1");
      throw new Error("docker ps failed");
    });
    await assert.rejects(runtimeWith(unreadable.exec).fenceSandbox("sandbox-1"), FenceUnknownError);
  });
});

describe("createDockerRuntime", () => {
  it("fails closed unless docker has a runsc runtime registered", async () => {
    const runc = fakeDocker(() => ({ stdout: '{"runc":{"path":"runc"}}' }));
    await assert.rejects(runtimeWith(runc.exec).checkIsolation(), IsolationUnavailableError);

    const gvisor = fakeDocker((args) =>
      args[0] === "info"
        ? { stdout: '{"runc":{},"runsc":{"path":"runsc"}}' }
        : { stdout: isolatedNetwork() }
    );
    await runtimeWith(gvisor.exec).checkIsolation();
    assert.deepEqual(gvisor.calls, [["info", "--format", "{{json .Runtimes}}"], NETWORK_INSPECT]);

    const down = fakeDocker(() => {
      throw new Error("Cannot connect to the Docker daemon");
    });
    await assert.rejects(runtimeWith(down.exec).checkIsolation(), IsolationUnavailableError);

    const garbled = fakeDocker(() => ({ stdout: "not json" }));
    await assert.rejects(runtimeWith(garbled.exec).checkIsolation(), IsolationUnavailableError);
  });

  it("fails closed unless the sandbox network is an isolated bridge with ICC and IPv6 off", async () => {
    const runtimes = '{"runc":{},"runsc":{"path":"runsc"}}';
    const networks: Array<[string, string | Error]> = [
      ["ICC on", isolatedNetwork({ Options: { "com.docker.network.bridge.enable_icc": "true" } })],
      ["ICC unset", isolatedNetwork({ Options: {} })],
      ["IPv6 on", isolatedNetwork({ EnableIPv6: true })],
      ["not a bridge", isolatedNetwork({ Driver: "overlay" })],
      ["missing", new Error("Error: No such network: oi-sandbox")],
      ["garbled", "not json"],
    ];
    for (const [label, network] of networks) {
      const docker = fakeDocker((args) => {
        if (args[0] === "info") return { stdout: runtimes };
        if (network instanceof Error) throw network;
        return { stdout: network };
      });
      await assert.rejects(
        runtimeWith(docker.exec).checkIsolation(),
        IsolationUnavailableError,
        label
      );
    }
  });

  it("returns the container id from docker run", async () => {
    const docker = fakeDocker(() => ({ stdout: `${CONTAINER_ID}\n` }));
    const containerId = await runtimeWith(docker.exec).runSandbox("sandbox-1", MOUNT);
    assert.equal(containerId, CONTAINER_ID);
    assert.deepEqual(docker.calls, [buildRunArgs("sandbox-1", IMAGE, LIMITS, MOUNT)]);
  });

  it("reports docker run output that is not a container id as outcome unknown", async () => {
    const docker = fakeDocker(() => ({ stdout: "Error: something\n" }));
    await assert.rejects(
      runtimeWith(docker.exec).runSandbox("sandbox-1", MOUNT),
      RunOutcomeUnknownError
    );
  });

  it("maps 'No such container' on remove to ContainerNotFoundError", async () => {
    const docker = fakeDocker(() => {
      throw Object.assign(new Error("docker rm failed"), {
        stderr: "Error response from daemon: No such container: abc",
      });
    });
    await assert.rejects(
      runtimeWith(docker.exec).removeSandbox(CONTAINER_ID),
      ContainerNotFoundError
    );
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

  it("lists every container id, and only the containers this executor owns", async () => {
    const docker = fakeDocker(() => ({
      stdout: [
        listed(
          CONTAINER_ID,
          "oi-sandbox-1",
          "open-inspect.managed=vps-executor,open-inspect.sandbox-id=sandbox-1,open-inspect.workspace-slot=0"
        ),
        listed(OTHER_CONTAINER_ID, "oi-plain", ""),
        listed(
          "c".repeat(64),
          "oi-sandbox-3",
          "open-inspect.managed=vps-executor,open-inspect.sandbox-id=sandbox-9"
        ),
        listed(
          "d".repeat(64),
          "oi-sandbox-4",
          "open-inspect.managed=other,open-inspect.sandbox-id=sandbox-4"
        ),
        // Owned, but its label names no slot, so it is owned with a null slot.
        listed(
          "e".repeat(64),
          "oi-sandbox-5",
          "open-inspect.managed=vps-executor,open-inspect.sandbox-id=sandbox-5"
        ),
        "",
      ].join("\n"),
    }));
    const inventory = await runtimeWith(docker.exec).inventory();
    assert.deepEqual(
      [...inventory.containerIds].sort(),
      ["b".repeat(64), "c".repeat(64), "d".repeat(64), "e".repeat(64), CONTAINER_ID].sort()
    );
    assert.deepEqual(inventory.owned, [
      { containerId: CONTAINER_ID, sandboxId: "sandbox-1", workspaceSlot: 0 },
      { containerId: "e".repeat(64), sandboxId: "sandbox-5", workspaceSlot: null },
    ]);
  });

  it("lists a fence as a fence, never as an owned container", async () => {
    const docker = fakeDocker(() => ({
      stdout: `${listed(CONTAINER_ID, "oi-sandbox-1", "open-inspect.fence=name-reservation")}\n`,
    }));
    const inventory = await runtimeWith(docker.exec).inventory();
    assert.deepEqual(inventory.fences, [{ containerId: CONTAINER_ID, sandboxId: "sandbox-1" }]);
    assert.deepEqual(inventory.owned, []);
  });

  it("refuses a listing it cannot read, and passes a failed listing through", async () => {
    const garbled = fakeDocker(() => ({ stdout: "not json\n" }));
    await assert.rejects(runtimeWith(garbled.exec).inventory());

    const unexpected = fakeDocker(() => ({ stdout: '{"Names":"oi-sandbox-1"}\n' }));
    await assert.rejects(runtimeWith(unexpected.exec).inventory(), /unexpected listing/);

    const down = fakeDocker(() => {
      throw Object.assign(new Error("docker ps failed"), { stderr: "daemon unreachable" });
    });
    await assert.rejects(runtimeWith(down.exec).inventory(), /docker ps failed/);
  });

  it("reports a run docker was ended in as outcome unknown, including by a signal", async () => {
    const killed = fakeDocker(() => {
      throw Object.assign(new Error("docker run failed"), { killed: true });
    });
    await assert.rejects(
      runtimeWith(killed.exec).runSandbox("sandbox-1", MOUNT),
      RunOutcomeUnknownError
    );

    const signaled = fakeDocker(() => {
      throw Object.assign(new Error("docker run failed"), { signal: "SIGKILL" });
    });
    await assert.rejects(
      runtimeWith(signaled.exec).runSandbox("sandbox-1", MOUNT),
      RunOutcomeUnknownError
    );
  });

  it("reports a run whose docker CLI is not installed as not started, since nothing was sent", async () => {
    const missing = fakeDocker(() => {
      throw Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" });
    });
    await assert.rejects(
      runtimeWith(missing.exec).runSandbox("sandbox-1", MOUNT),
      RunNotStartedError
    );
  });

  it("reports a run that cannot reach the daemon as outcome unknown, since its create may already have landed", async () => {
    // docker run sends a create and then a start, so an unreachable daemon can fail the start after the create was accepted.
    const unreachable = fakeDocker(() => {
      throw Object.assign(new Error("docker run failed"), {
        code: 125,
        stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock.",
      });
    });
    await assert.rejects(
      runtimeWith(unreachable.exec).runSandbox("sandbox-1", MOUNT),
      RunOutcomeUnknownError
    );
  });

  it("reports a failure without docker's structured refusal as outcome unknown, even after a normal exit", async () => {
    const unstructured = fakeDocker(() => {
      throw Object.assign(new Error("docker run failed"), {
        code: 125,
        stderr: "invalid reference",
      });
    });
    await assert.rejects(
      runtimeWith(unstructured.exec).runSandbox("sandbox-1", MOUNT),
      RunOutcomeUnknownError
    );
  });

  it("reports the daemon's structured refusal after a normal exit as rejected by the daemon", async () => {
    // A bind source that does not exist, or an image that is not local, is refused before any container is made.
    const refused = fakeDocker(() => {
      throw Object.assign(new Error("docker run failed"), {
        code: 125,
        stderr:
          'docker: Error response from daemon: invalid mount config for type "bind": bind source path does not exist\n',
      });
    });
    await assert.rejects(
      runtimeWith(refused.exec).runSandbox("sandbox-1", MOUNT),
      RunRejectedByDaemonError
    );
  });

  it("never reads output that also shows a transport failure as a refusal, even after a normal exit", async () => {
    const mixed = fakeDocker(() => {
      throw Object.assign(new Error("docker run failed"), {
        code: 125,
        stderr:
          'docker: Error response from daemon: failed to start\ndocker: error during connect: Post "http://docker/v1.47/containers/create": EOF\n',
      });
    });
    await assert.rejects(
      runtimeWith(mixed.exec).runSandbox("sandbox-1", MOUNT),
      RunOutcomeUnknownError
    );
  });

  it("never reads a daemon refusal as definitive when the CLI was killed, since it may still be creating", async () => {
    const killed = fakeDocker(() => {
      throw Object.assign(new Error("docker run failed"), {
        code: null,
        killed: true,
        stderr: "Error response from daemon: failed to start",
      });
    });
    await assert.rejects(
      runtimeWith(killed.exec).runSandbox("sandbox-1", MOUNT),
      RunOutcomeUnknownError
    );
  });
});
