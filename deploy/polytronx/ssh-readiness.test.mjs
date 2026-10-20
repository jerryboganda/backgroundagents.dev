import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = join(dirname(fileURLToPath(import.meta.url)), "ssh-readiness.sh");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bg-ssh-readiness-"));
  const scratch = join(root, "runner");
  const bin = join(root, "bin");
  mkdirSync(scratch);
  mkdirSync(bin);

  const key = join(root, "test-key");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
  const [algorithm, material] = readFileSync(key + ".pub", "utf8").trim().split(" ");
  const sshStub = join(bin, "ssh");
  const record = join(root, "ssh-args.txt");
  writeFileSync(
    sshStub,
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$SSH_RECORD_ARGS"\n',
    { mode: 0o755 }
  );
  const env = {
    ...process.env,
    PATH: bin + ":" + process.env.PATH,
    RUNNER_TEMP: scratch,
    SSH_PRIVATE_KEY: readFileSync(key, "utf8"),
    SSH_HOST: "executor.example.test",
    SSH_USER: "deploy",
    SSH_PORT: "22",
    SSH_KNOWN_HOSTS: "executor.example.test " + algorithm + " " + material,
    SSH_RECORD_ARGS: record,
  };

  return {
    root,
    scratch,
    record,
    env,
    run(target = "executor", overrides = {}) {
      return spawnSync("bash", [script, target], {
        encoding: "utf8",
        env: { ...env, ...overrides },
      });
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("read-only readiness accepts independently pinned SSH access for both environments", () => {
  const f = fixture();
  try {
    for (const target of ["dashboard", "executor"]) {
      const result = f.run(target);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /verified connection only/);
      const args = readFileSync(f.record, "utf8");
      assert.match(args, /StrictHostKeyChecking=yes/);
      assert.match(args, /IdentitiesOnly=yes/);
      assert.match(args, /PasswordAuthentication=no/);
      assert.match(args, /deploy@executor\.example\.test/);
      assert.match(args, /test "\$\(id -u\)" -ne 0/);
      assert.doesNotMatch(args, /BEGIN OPENSSH PRIVATE KEY/);
      assert.deepEqual(readdirSync(f.scratch), []);
    }
  } finally {
    f.cleanup();
  }
});

test("root login and unsafe connection variables fail before network access", () => {
  const f = fixture();
  try {
    for (const overrides of [
      { SSH_USER: "root" },
      { SSH_HOST: "-oProxyCommand=evil" },
      { SSH_HOST: "a..example.test" },
      { SSH_PORT: "0" },
      { SSH_PORT: "65536" },
      { SSH_PORT: "22;echo bad" },
      { SSH_PRIVATE_KEY: "" },
      { SSH_KNOWN_HOSTS: "" },
    ]) {
      rmSync(f.record, { force: true });
      const result = f.run("dashboard", overrides);
      assert.notEqual(result.status, 0, JSON.stringify(overrides));
      assert.equal(readdirSync(f.scratch).length, 0);
      assert.throws(() => readFileSync(f.record));
    }
  } finally {
    f.cleanup();
  }
});

test("an unverified host, an invalid key, or mismatched SSH port fails closed", () => {
  const f = fixture();
  try {
    for (const overrides of [
      { SSH_HOST: "other.example.test" },
      { SSH_PRIVATE_KEY: "not a key" },
      { SSH_PORT: "2222" },
    ]) {
      rmSync(f.record, { force: true });
      const result = f.run("executor", overrides);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /refused/i);
      assert.equal(readdirSync(f.scratch).length, 0);
      assert.throws(() => readFileSync(f.record));
    }
  } finally {
    f.cleanup();
  }
});


test("both deployment environments remain manual, distinct, and main-only", () => {
  const workflowDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".github", "workflows");
  for (const target of ["dashboard", "executor"]) {
    const yaml = readFileSync(join(workflowDir, target + "-ssh-readiness.yml"), "utf8");
    assert.match(yaml, /^  workflow_dispatch:/m);
    assert.doesNotMatch(yaml, /^  pull_request:/m);
    assert.match(yaml, /if: github\.ref == 'refs\/heads\/main'/);
    assert.match(yaml, new RegExp("environment: " + target + "-production"));
    assert.match(yaml, /secrets\.SSH_PRIVATE_KEY/);
    assert.match(yaml, /vars\.SSH_KNOWN_HOSTS/);
    assert.match(yaml, new RegExp("ssh-readiness\\.sh " + target));
    assert.doesNotMatch(yaml, /StrictHostKeyChecking=no|ssh-keyscan|deploy\.sh --/);
  }
});
