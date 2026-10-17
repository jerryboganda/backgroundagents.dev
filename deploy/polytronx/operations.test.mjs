// Failure-path and restore-target guards for deploy.sh, backup.sh, rollback.sh and
// restore-rehearsal.sh. Each script runs as real bash against stubbed docker, curl and df
// (testdata/stubs), so the assertions are on exit status, messages, the deploy log and the
// docker calls the scripts made.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  BASH,
  EXECUTOR_CA_PATH,
  HAS_FLOCK,
  LIVE_SECRETS,
  composeCalls,
  makeSandbox,
  runScript,
  runSnippet,
  stubCalls,
  writeKey,
  writeRelease,
} from "./test-harness.mjs";

const DEPLOY_STUBS = {
  "preflight.sh": "stub-preflight.sh",
  "backup.sh": "stub-backup.sh",
  "smoke.sh": "stub-smoke.sh",
};
const ROLLBACK_STUBS = { "preflight.sh": "stub-preflight.sh", "smoke.sh": "stub-smoke.sh" };

const isUp = (line) => / up /.test(line);
const isSmoke = (line) => line.startsWith("smoke ");

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function deployFixture() {
  const sb = makeSandbox({ replace: DEPLOY_STUBS });
  return { sb, release: writeRelease(sb), key: writeKey(sb) };
}

function deployArgs({ sb, release, key }) {
  return [
    "--release", release,
    "--secrets-dir", sb.secrets,
    "--source", sb.root,
    "--backup-dir", sb.backups,
    "--key-file", key,
    "--state-dir", sb.state,
    "--confirm", "polytronx-openinspect",
  ];
}

function readDeployLog(sb) {
  const file = `${sb.state}/deploy-log.txt`;
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

describe("deploy.sh failure paths", () => {
  it("a failed up on the first deploy is logged, and offers first-deployment recovery rather than a rollback command", () => {
    const fixture = deployFixture();
    const result = runScript(fixture.sb, "deploy.sh", deployArgs(fixture), { STUB_UP_EXIT: "1" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /up failed on the new release/);
    assert.match(result.stderr, /No earlier release has passed smoke/);
    assert.doesNotMatch(result.stdout + result.stderr, /rollback\.sh --to/);
    assert.match(readDeployLog(fixture.sb), /deploy FAILED up/);
    assert.equal(stubCalls(fixture.sb).some(isSmoke), false, "smoke must not run after a failed up");
  });

  it("a failed smoke on the first deploy gives no rollback target", () => {
    const fixture = deployFixture();
    const result = runScript(fixture.sb, "deploy.sh", deployArgs(fixture), { STUB_SMOKE_EXIT: "1" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /No earlier release has passed smoke/);
    assert.doesNotMatch(result.stderr, /rollback\.sh --to/);
    assert.match(readDeployLog(fixture.sb), /deploy FAILED smoke/);
    assert.equal(existsSync(`${fixture.sb.state}/last-good.env`), false);
  });

  it("a failed smoke after an earlier good release prints the rollback command for last-good.env", () => {
    const fixture = deployFixture();
    mkdirSync(fixture.sb.state, { recursive: true });
    copyFileSync(fixture.release, `${fixture.sb.state}/last-good.env`);
    const result = runScript(fixture.sb, "deploy.sh", deployArgs(fixture), { STUB_SMOKE_EXIT: "1" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`rollback\\.sh --to ${escapeRegExp(fixture.sb.state)}/last-good\\.env`));
    assert.doesNotMatch(result.stderr, /No earlier release/);
  });

  it("a failed backup stops the deploy before any change, and the log says so", () => {
    const fixture = deployFixture();
    const result = runScript(fixture.sb, "deploy.sh", deployArgs(fixture), { STUB_BACKUP_EXIT: "1" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no release was changed/);
    assert.match(readDeployLog(fixture.sb), /deploy STOPPED before any release change/);
    assert.equal(composeCalls(fixture.sb).some(isUp), false, "no up may run after a failed backup");
    assert.equal(stubCalls(fixture.sb).some(isSmoke), false);
  });

  it("a deploy that passes smoke records last-good.env and a deploy-log line", () => {
    const fixture = deployFixture();
    const result = runScript(fixture.sb, "deploy.sh", deployArgs(fixture));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(`${fixture.sb.state}/last-good.env`), true);
    assert.match(readDeployLog(fixture.sb), /deploy ok revision=/);
    assert.match(result.stdout, /last-good release updated/);
  });

  it("a preflight refusal after the image archives were loaded does not claim nothing changed", () => {
    const fixture = deployFixture();
    const archives = `${fixture.sb.root}/archives`;
    mkdirSync(archives);
    const names = ["control-plane.tar", "web.tar"];
    for (const name of names) writeFileSync(`${archives}/${name}`, `${name}\n`);
    const sums = names.map((name) => `${createHash("sha256").update(readFileSync(`${archives}/${name}`)).digest("hex")}  ${name}`);
    writeFileSync(`${archives}/SHA256SUMS`, `${sums.join("\n")}\n`);
    const result = runScript(fixture.sb, "deploy.sh", [...deployArgs(fixture), "--image-archives", archives], {
      STUB_PREFLIGHT_EXIT: "1",
    });
    assert.equal(result.status, 1);
    assert.ok(stubCalls(fixture.sb).some((line) => line.startsWith("docker load")), "the archives load before preflight");
    assert.match(result.stderr, /the live project was not changed/);
    assert.doesNotMatch(result.stdout + result.stderr, /nothing was changed/);
  });

  it("refuses to run while another deploy, rollback or backup holds the project lock",{ skip: !HAS_FLOCK && "flock is not installed" }, async () => {
    const fixture = deployFixture();
    mkdirSync(fixture.sb.state, { recursive: true });
    const holder = spawn(BASH, ["-c", `flock -x "${fixture.sb.state}/project.lock" -c 'echo locked; read _'`], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    try {
      await new Promise((resolve, reject) => {
        holder.stdout.once("data", resolve);
        holder.once("error", reject);
      });
      const result = runScript(fixture.sb, "deploy.sh", deployArgs(fixture));
      assert.equal(result.status, 1);
      assert.match(result.stderr, /holds .*project\.lock/);
      assert.equal(stubCalls(fixture.sb).some((line) => line.startsWith("preflight")), false);
    } finally {
      holder.stdin.end();
    }
  });
});

describe("backup.sh restart and failure propagation", () => {
  const backupArgs = (sb, key, release) => [
    "--release", release,
    "--secrets-dir", sb.secrets,
    "--backup-dir", sb.backups,
    "--key-file", key,
    "--label", "test",
  ];

  it("with nothing running, stops and starts nothing and still writes a checksummed backup", () => {
    const sb = makeSandbox();
    const result = runScript(sb, "backup.sh", backupArgs(sb, writeKey(sb), writeRelease(sb)), { STUB_RUNNING: "" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(composeCalls(sb), []);
    assert.match(result.stdout, /no services are running/);
    const [dir] = readdirSync(sb.backups);
    assert.equal(existsSync(`${sb.backups}/${dir}/SHA256SUMS`), true);
  });

  it("with services running, restarts exactly the services it stopped, with --no-recreate", () => {
    const sb = makeSandbox();
    const result = runScript(sb, "backup.sh", backupArgs(sb, writeKey(sb), writeRelease(sb)), {
      STUB_RUNNING: "web\napp\nobject-store\nlitestream\n",
    });
    assert.equal(result.status, 0, result.stderr);
    const compose = composeCalls(sb);
    assert.match(compose.find((line) => / stop /.test(line)), / stop --timeout 60 app litestream object-store web$/);
    const ups = compose.filter(isUp);
    assert.equal(ups.length, 1);
    assert.match(ups[0], / up -d --no-recreate --wait --wait-timeout 420 --pull never app litestream object-store web$/);
  });

  it("a failed restart is an error, not a warning, and is not retried", () => {
    const sb = makeSandbox();
    const result = runScript(sb, "backup.sh", backupArgs(sb, writeKey(sb), writeRelease(sb)), {
      STUB_RUNNING: "app\nweb\n",
      STUB_UP_EXIT: "1",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /did not come back healthy/);
    assert.equal(composeCalls(sb).filter(isUp).length, 1);
  });

  it("a failed archive restarts the services it stopped and exits non-zero", () => {
    const sb = makeSandbox();
    const result = runScript(sb, "backup.sh", backupArgs(sb, writeKey(sb), writeRelease(sb)), {
      STUB_RUNNING: "app\nweb\n",
      STUB_VOLUME_EXIT: "0",
      STUB_RUN_EXIT: "1",
    });
    assert.equal(result.status, 1);
    assert.equal(composeCalls(sb).filter(isUp).length, 1, "the stopped services must be restarted once");
    assert.equal(existsSync(sb.backups) && readdirSync(sb.backups).some((dir) => existsSync(`${sb.backups}/${dir}/MANIFEST.env`)), false);
  });

  it("a failed stop archives nothing and still restarts what it stopped", () => {
    const sb = makeSandbox();
    const result = runScript(sb, "backup.sh", backupArgs(sb, writeKey(sb), writeRelease(sb)), {
      STUB_RUNNING: "app\nweb\n",
      STUB_STOP_EXIT: "1",
      STUB_VOLUME_EXIT: "0",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /could not stop the services; nothing was archived/);
    assert.equal(stubCalls(sb).some((line) => line.startsWith("docker run")), false, "no archive helper may run");
    assert.equal(composeCalls(sb).filter(isUp).length, 1);
  });

  it("refuses a missing backup key before any docker call", () => {
    const sb = makeSandbox();
    const result = runScript(sb, "backup.sh", backupArgs(sb, `${sb.keys}/absent.key`, writeRelease(sb)));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /backup key file missing or empty/);
    assert.deepEqual(stubCalls(sb), []);
  });
});

describe("rollback.sh restore-target guards", () => {
  const rollbackArgs = (sb, target) => [
    "--to", target,
    "--secrets-dir", sb.secrets,
    "--source", sb.root,
    "--state-dir", sb.state,
    "--confirm", "polytronx-openinspect",
  ];

  it("refuses a missing target before any docker call", () => {
    const sb = makeSandbox({ replace: ROLLBACK_STUBS });
    const result = runScript(sb, "rollback.sh", rollbackArgs(sb, `${sb.root}/absent.env`));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /rollback target not found/);
    assert.deepEqual(stubCalls(sb), []);
  });

  it("refuses a target whose schema is older than the running release, before any compose call", () => {
    const sb = makeSandbox({ replace: ROLLBACK_STUBS });
    mkdirSync(sb.state, { recursive: true });
    writeFileSync(`${sb.state}/attempted.env`, "MIGRATIONS_LATEST=0073\n");
    const target = writeRelease(sb, "target.env", { MIGRATIONS_LATEST: "0072", POLYTRONX_EXECUTOR_CA_FILE: EXECUTOR_CA_PATH });
    const result = runScript(sb, "rollback.sh", rollbackArgs(sb, target));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /schema \(0072\) is older than the running schema \(0073\)/);
    assert.deepEqual(composeCalls(sb), []);
  });

  it("refuses a release from before the executor CA mount, before any docker call, and says how to fix it", () => {
    const sb = makeSandbox({ replace: ROLLBACK_STUBS });
    const target = writeRelease(sb, "old.env");
    const result = runScript(sb, "rollback.sh", rollbackArgs(sb, target));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /names no POLYTRONX_EXECUTOR_CA_FILE: it predates the executor CA mount/);
    assert.match(result.stderr, /nothing was changed/);
    assert.equal(stubCalls(sb).some((line) => line.startsWith("docker")), false);
    assert.deepEqual(composeCalls(sb), []);
  });

  it("a failed up on the rollback target is logged, and smoke does not run", () => {
    const sb = makeSandbox({ replace: ROLLBACK_STUBS });
    const target = writeRelease(sb, "target.env", { POLYTRONX_EXECUTOR_CA_FILE: EXECUTOR_CA_PATH });
    const result = runScript(sb, "rollback.sh", rollbackArgs(sb, target), { STUB_UP_EXIT: "1" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /up failed on the rollback target/);
    assert.match(readFileSync(`${sb.state}/deploy-log.txt`, "utf8"), /rollback FAILED up/);
    assert.equal(stubCalls(sb).some(isSmoke), false);
  });
});

describe("restore-rehearsal.sh live-restore refusals", () => {
  function backupFixture(sb) {
    const dir = `${sb.root}/backup`;
    mkdirSync(dir);
    const files = {
      "control-plane-data.tar.enc": "encrypted\n",
      "object-store-data.tar.enc": "encrypted\n",
      "secrets.tar.enc": "encrypted\n",
      "MANIFEST.env": "migrations_latest=0073\nsession_db_count=0\n",
      "release.env": "OPEN_INSPECT_REVISION=x\n",
    };
    for (const [name, text] of Object.entries(files)) writeFileSync(`${dir}/${name}`, text);
    const sums = Object.keys(files)
      .map((name) => `${createHash("sha256").update(readFileSync(`${dir}/${name}`)).digest("hex")}  ./${name}`)
      .join("\n");
    writeFileSync(`${dir}/SHA256SUMS`, `${sums}\n`);
    return dir;
  }

  /** A backup whose archives are really encrypted with lib.sh's cipher, so the restore decrypts them. */
  function encryptedBackup(sb, key) {
    const dir = `${sb.root}/encrypted-backup`;
    const archives = {
      "control-plane-data.tar.enc": ["global.db"],
      "object-store-data.tar.enc": ["bucket.dat"],
      "secrets.tar.enc": ["control-plane.env", "storage.env", "web.env"],
    };
    mkdirSync(dir);
    for (const [name, files] of Object.entries(archives)) {
      const src = `${sb.root}/plain-${name}`;
      mkdirSync(src);
      for (const file of files) writeFileSync(`${src}/${file}`, `${file}=test\n`);
      const result = runSnippet(sb, `source "${sb.deploy}/lib.sh"; tar -C "${src}" -cf - . | openssl enc "\${BACKUP_CIPHER[@]}" -pass "file:${key}" -out "${dir}/${name}"`);
      assert.equal(result.status, 0, result.stderr);
    }
    writeFileSync(`${dir}/MANIFEST.env`, "migrations_latest=0073\nsession_db_count=0\n");
    writeFileSync(`${dir}/release.env`, "OPEN_INSPECT_REVISION=x\n");
    const names = [...Object.keys(archives), "MANIFEST.env", "release.env"];
    const sums = names.map((name) => `${createHash("sha256").update(readFileSync(`${dir}/${name}`)).digest("hex")}  ./${name}`);
    writeFileSync(`${dir}/SHA256SUMS`, `${sums.join("\n")}\n`);
    return dir;
  }

  const restoreArgs = (sb, backup, key, release, project = "polytronx-openinspect-rehearsal") => [
    "--backup", backup,
    "--key-file", key,
    "--release", release,
    "--secrets-dir", sb.secrets,
    "--project", project,
    "--confirm", project,
  ];

  it("refuses the live project name", () => {
    const sb = makeSandbox();
    const result = runScript(sb, "restore-rehearsal.sh",
      restoreArgs(sb, backupFixture(sb), writeKey(sb), writeRelease(sb), "polytronx-openinspect"));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /rehearsal project must be polytronx-openinspect-rehearsal/);
    assert.deepEqual(stubCalls(sb), []);
  });

  it("refuses the live secrets directory", () => {
    const sb = makeSandbox();
    const args = restoreArgs(sb, backupFixture(sb), writeKey(sb), writeRelease(sb));
    args[args.indexOf("--secrets-dir") + 1] = LIVE_SECRETS;
    const result = runScript(sb, "restore-rehearsal.sh", args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must not be the live secrets directory/);
    assert.deepEqual(stubCalls(sb), []);
  });

  it("refuses the live secrets directory under any spelling", () => {
    const spellings = [
      `${LIVE_SECRETS}/`,
      "/opt/polytronx//openinspect/secrets",
      "/opt/polytronx/openinspect/./secrets",
      `${"../".repeat(20)}opt/polytronx/openinspect/secrets`,
    ];
    for (const spelling of spellings) {
      const sb = makeSandbox();
      const args = restoreArgs(sb, backupFixture(sb), writeKey(sb), writeRelease(sb));
      args[args.indexOf("--secrets-dir") + 1] = spelling;
      const result = runScript(sb, "restore-rehearsal.sh", args);
      assert.equal(result.status, 1, spelling);
      assert.match(result.stderr, /must not be the live secrets directory/, spelling);
      assert.deepEqual(stubCalls(sb), [], spelling);
    }
  });

  it("happy restore setup: the rehearsal secrets are in place before compose create, and the restore reaches up", () => {
    const sb = makeSandbox();
    const key = writeKey(sb);
    // A fresh rehearsal secrets directory, as the documented flow gives it.
    const secrets = `${sb.root}/rehearsal-secrets`;
    const release = writeRelease(sb, "rehearsal.env", { POLYTRONX_SECRETS_DIR: secrets, POLYTRONX_EXECUTOR_CA_FILE: EXECUTOR_CA_PATH });
    const backup = encryptedBackup(sb, key);
    const result = runScript(
      sb,
      "restore-rehearsal.sh",
      [
        "--backup", backup,
        "--key-file", key,
        "--release", release,
        "--secrets-dir", secrets,
        "--project", "polytronx-openinspect-rehearsal",
        "--confirm", "polytronx-openinspect-rehearsal",
      ],
      { STUB_COMPOSE_ENV_CHECK: "1" },
    );
    // The stub answers no health probe, so the run ends at the health check. This covers setup only.
    const compose = composeCalls(sb);
    assert.doesNotMatch(result.stderr, /env file/);
    assert.ok(compose.some((line) => line.endsWith(" create")), compose.join("\n"));
    assert.ok(compose.some((line) => / up -d /.test(line)), `the restore must reach up:\n${result.stderr}`);
    assert.deepEqual(readdirSync(secrets).sort(), ["control-plane.env", "storage.env", "web.env"]);
  });

  it("refuses a backup whose checksums do not match", () => {
    const sb = makeSandbox();
    const backup = backupFixture(sb);
    writeFileSync(`${backup}/MANIFEST.env`, "migrations_latest=0001\n");
    const result = runScript(sb, "restore-rehearsal.sh", restoreArgs(sb, backup, writeKey(sb), writeRelease(sb)));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /backup checksums do not match; nothing was restored/);
    assert.deepEqual(stubCalls(sb), []);
  });

  it("refuses a rehearsal release with no CA file, which predates the executor CA mount, before any docker call", () => {
    const sb = makeSandbox();
    const result = runScript(sb, "restore-rehearsal.sh", restoreArgs(sb, backupFixture(sb), writeKey(sb), writeRelease(sb)));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must name POLYTRONX_EXECUTOR_CA_FILE/);
    assert.deepEqual(stubCalls(sb), []);
  });

  it("refuses a rehearsal CA file in the live secrets directory, under any spelling", () => {
    const spellings = [`${LIVE_SECRETS}/executor-edge-ca.crt`, "/opt/polytronx//openinspect/secrets/executor-edge-ca.crt"];
    for (const spelling of spellings) {
      const sb = makeSandbox();
      const release = writeRelease(sb, "rehearsal.env", { POLYTRONX_EXECUTOR_CA_FILE: spelling });
      const result = runScript(sb, "restore-rehearsal.sh", restoreArgs(sb, backupFixture(sb), writeKey(sb), release));
      assert.equal(result.status, 1, spelling);
      assert.match(result.stderr, /names a file in the live secrets directory/, spelling);
      assert.deepEqual(stubCalls(sb), [], spelling);
    }
  });

  it("refuses rehearsal volumes that already exist unless --reset is given", () => {
    const sb = makeSandbox();
    const result = runScript(sb, "restore-rehearsal.sh",
      restoreArgs(sb, backupFixture(sb), writeKey(sb), writeRelease(sb, "release.env", { POLYTRONX_EXECUTOR_CA_FILE: EXECUTOR_CA_PATH })),
      { STUB_VOLUMES: "polytronx-openinspect-rehearsal_control-plane-data\n" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /rehearsal volumes already exist; rerun with --reset/);
    assert.equal(composeCalls(sb).length, 0, "no compose call may run before the refusal");
  });
});
