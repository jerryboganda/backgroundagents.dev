import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readConfig } from "../src/index.ts";

const TOKEN = "x".repeat(32);
const ADMISSION_SECRET = "y".repeat(32);

describe("readConfig", () => {
  it("applies defaults that keep the service on localhost with bounded sandboxes", () => {
    const config = readConfig({
      VPS_EXECUTOR_TOKEN: TOKEN,
      VPS_EXECUTOR_ADMISSION_SECRET: ADMISSION_SECRET,
      VPS_EXECUTOR_IMAGE: "open-inspect/sandbox:1",
    });
    assert.equal(config.admissionSecret, ADMISSION_SECRET);
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.port, 8787);
    assert.deepEqual(config.limits, { cpus: "2", memory: "4g", pidsLimit: 512 });
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
});
