import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readConfig } from "../src/index.ts";

const TOKEN = "x".repeat(32);
const ADMISSION_SECRET = "y".repeat(32);
const CONTROL_PLANE_URL = "https://cp.example.test";

describe("readConfig", () => {
  it("applies defaults that keep the service on localhost with bounded sandboxes", () => {
    const config = readConfig({
      VPS_EXECUTOR_TOKEN: TOKEN,
      VPS_EXECUTOR_ADMISSION_SECRET: ADMISSION_SECRET,
      VPS_EXECUTOR_IMAGE: "open-inspect/sandbox:1",
      VPS_EXECUTOR_CONTROL_PLANE_URL: CONTROL_PLANE_URL,
    });
    assert.equal(config.admissionSecret, ADMISSION_SECRET);
    assert.equal(config.controlPlaneUrl, CONTROL_PLANE_URL);
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.port, 8787);
    assert.deepEqual(config.limits, { cpus: "2", memory: "4g", pidsLimit: 512 });
    // A new SQLite file, so an upgrade never reads the first build's JSON state at the old name.
    assert.equal(config.stateFile, "executor-state.db");
  });

  it("fails closed without a strong token or an image", () => {
    assert.throws(() => readConfig({ VPS_EXECUTOR_IMAGE: "img" }), /VPS_EXECUTOR_TOKEN/);
    assert.throws(() => readConfig({ VPS_EXECUTOR_TOKEN: TOKEN }), /VPS_EXECUTOR_IMAGE/);
  });

  it("fails closed without a strong admission secret", () => {
    const env = { VPS_EXECUTOR_TOKEN: TOKEN, VPS_EXECUTOR_IMAGE: "img" };
    assert.throws(() => readConfig(env), /VPS_EXECUTOR_ADMISSION_SECRET/);
    const weak = "short-admission-secret";
    assert.throws(
      () => readConfig({ ...env, VPS_EXECUTOR_ADMISSION_SECRET: weak }),
      (error: unknown) =>
        error instanceof Error &&
        /VPS_EXECUTOR_ADMISSION_SECRET/.test(error.message) &&
        !error.message.includes(weak)
    );
  });

  it("never echoes a rejected token", () => {
    const weak = "short-secret-value";
    assert.throws(
      () => readConfig({ VPS_EXECUTOR_TOKEN: weak, VPS_EXECUTOR_IMAGE: "img" }),
      (error: unknown) => error instanceof Error && !error.message.includes(weak)
    );
  });

  it("requires a trusted https control-plane origin, without a trailing slash", () => {
    const env = {
      VPS_EXECUTOR_TOKEN: TOKEN,
      VPS_EXECUTOR_ADMISSION_SECRET: ADMISSION_SECRET,
      VPS_EXECUTOR_IMAGE: "img",
    };
    assert.throws(() => readConfig(env), /VPS_EXECUTOR_CONTROL_PLANE_URL/);
    for (const url of ["", "http://cp.example.test", "cp.example.test", "not a url"])
      assert.throws(
        () => readConfig({ ...env, VPS_EXECUTOR_CONTROL_PLANE_URL: url }),
        /VPS_EXECUTOR_CONTROL_PLANE_URL/
      );
    const config = readConfig({ ...env, VPS_EXECUTOR_CONTROL_PLANE_URL: `${CONTROL_PLANE_URL}//` });
    assert.equal(config.controlPlaneUrl, CONTROL_PLANE_URL);
  });

  it("bounds a sandbox's lifetime at two hours and five minutes by default, and refuses a value outside 10 minutes to a day", () => {
    const env = {
      VPS_EXECUTOR_TOKEN: TOKEN,
      VPS_EXECUTOR_ADMISSION_SECRET: ADMISSION_SECRET,
      VPS_EXECUTOR_IMAGE: "img",
      VPS_EXECUTOR_CONTROL_PLANE_URL: CONTROL_PLANE_URL,
    };
    assert.equal(readConfig(env).sandboxMaxLifetimeMs, 7_500_000);
    assert.equal(
      readConfig({ ...env, VPS_EXECUTOR_SANDBOX_MAX_LIFETIME_SECONDS: "3600" })
        .sandboxMaxLifetimeMs,
      3_600_000
    );
    for (const seconds of ["599", "86401", "0", "-1", "soon", "1.5", ""])
      assert.throws(
        () => readConfig({ ...env, VPS_EXECUTOR_SANDBOX_MAX_LIFETIME_SECONDS: seconds }),
        /VPS_EXECUTOR_SANDBOX_MAX_LIFETIME_SECONDS/
      );
  });

  it("keeps a stopped session's workspace three days by default, and refuses a value outside an hour to thirty days", () => {
    const env = {
      VPS_EXECUTOR_TOKEN: TOKEN,
      VPS_EXECUTOR_ADMISSION_SECRET: ADMISSION_SECRET,
      VPS_EXECUTOR_IMAGE: "img",
      VPS_EXECUTOR_CONTROL_PLANE_URL: CONTROL_PLANE_URL,
    };
    assert.equal(readConfig(env).retainedWorkspaceTtlMs, 259_200_000);
    assert.equal(
      readConfig({ ...env, VPS_EXECUTOR_RETAINED_WORKSPACE_TTL_SECONDS: "86400" })
        .retainedWorkspaceTtlMs,
      86_400_000
    );
    for (const seconds of ["3599", "2592001", "0", "-1", "week", "1.5", ""])
      assert.throws(
        () => readConfig({ ...env, VPS_EXECUTOR_RETAINED_WORKSPACE_TTL_SECONDS: seconds }),
        /VPS_EXECUTOR_RETAINED_WORKSPACE_TTL_SECONDS/
      );
    // The retention clock starts at the sandbox's creation, so it must outlast the sandbox itself.
    assert.throws(
      () => readConfig({ ...env, VPS_EXECUTOR_RETAINED_WORKSPACE_TTL_SECONDS: "7500" }),
      /must exceed/
    );
    assert.throws(
      () =>
        readConfig({
          ...env,
          VPS_EXECUTOR_SANDBOX_MAX_LIFETIME_SECONDS: "86400",
          VPS_EXECUTOR_RETAINED_WORKSPACE_TTL_SECONDS: "86400",
        }),
      /must exceed/
    );
  });

  it("defaults to the six provisioned slots under the host root, and refuses others", () => {
    const env = {
      VPS_EXECUTOR_TOKEN: TOKEN,
      VPS_EXECUTOR_ADMISSION_SECRET: ADMISSION_SECRET,
      VPS_EXECUTOR_IMAGE: "img",
      VPS_EXECUTOR_CONTROL_PLANE_URL: CONTROL_PLANE_URL,
    };
    const config = readConfig(env);
    assert.equal(config.workspaceRoot, "/srv/vps-ws/slots");
    assert.equal(config.workspaceSlots, 6);
    for (const slots of ["0", "7", "two", "1.5"])
      assert.throws(
        () => readConfig({ ...env, VPS_EXECUTOR_WORKSPACE_SLOTS: slots }),
        /VPS_EXECUTOR_WORKSPACE_SLOTS/
      );
    for (const root of ["slots", "/srv/vps-ws/../slots", "/srv/vps-ws/"])
      assert.throws(
        () => readConfig({ ...env, VPS_EXECUTOR_WORKSPACE_ROOT: root }),
        /VPS_EXECUTOR_WORKSPACE_ROOT/
      );
  });
});
