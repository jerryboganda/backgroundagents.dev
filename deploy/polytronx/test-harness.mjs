// Shared helpers for the deployment guard tests. Each sandbox is a scratch copy of this
// directory with command stubs first on PATH (testdata/stubs). Nothing reaches a Docker
// daemon, a registry, a provider or the network. Paths are passed to bash with forward
// slashes, so the tests also run where bash is Cygwin or MSYS.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const DEPLOY_DIR = posix(dirname(fileURLToPath(import.meta.url)));
export const REPO_ROOT = `${DEPLOY_DIR}/../..`;
const STUBS = `${DEPLOY_DIR}/testdata/stubs`;
export const BASH = process.env.POLYTRONX_TEST_BASH || "bash";
export const LIVE_SECRETS = "/opt/polytronx/openinspect/secrets";
/** The default public CA path in the release template: outside the secrets directory. */
export const EXECUTOR_CA_PATH = "/opt/polytronx/openinspect/trust/executor-edge-ca.crt";
export const SAMPLE_ID = `sha256:${"a".repeat(64)}`;

export function posix(path) {
  return path.replace(/\\/g, "/");
}

function commandExists(name) {
  return spawnSync(BASH, ["-c", `command -v ${name}`], { encoding: "utf8" }).status === 0;
}

export const HAS_FLOCK = commandExists("flock");
const IS_WINDOWS = process.platform === "win32";

function installStub(bin, name) {
  copyFileSync(`${STUBS}/${name}`, `${bin}/${name}`);
  chmodSync(`${bin}/${name}`, 0o755);
}

/**
 * A scratch copy of deploy/polytronx. `replace` maps a script name in the copy to a stub
 * from testdata/stubs, so a test can stand in for preflight.sh, backup.sh or smoke.sh.
 */
export function makeSandbox({ replace = {} } = {}) {
  const root = posix(mkdtempSync(`${posix(tmpdir())}/polytronx-test-`));
  const bin = `${root}/bin`;
  const deploy = `${root}/deploy`;
  mkdirSync(bin);
  cpSync(DEPLOY_DIR, deploy, { recursive: true });
  for (const name of ["docker", "curl", "df", ...(HAS_FLOCK ? [] : ["flock"]), ...(IS_WINDOWS ? ["stat"] : [])]) {
    installStub(bin, name);
  }
  for (const [target, stub] of Object.entries(replace)) {
    copyFileSync(`${STUBS}/${stub}`, `${deploy}/${target}`);
    chmodSync(`${deploy}/${target}`, 0o755);
  }
  const log = `${root}/stub.log`;
  writeFileSync(log, "");
  const sandbox = {
    root,
    bin,
    deploy,
    log,
    state: `${root}/state`,
    secrets: `${root}/secrets`,
    backups: `${root}/backups`,
    keys: `${root}/keys`,
  };
  mkdirSync(sandbox.secrets, { recursive: true, mode: 0o700 });
  writeFileSync(`${sandbox.secrets}/control-plane.env`, "MODAL_WORKSPACE=example\n");
  return sandbox;
}

const RELEASE_DEFAULTS = {
  OPEN_INSPECT_REVISION: "02a6bbf1c2720699444d91867026e8b0111ed6fc",
  OVERLAY_REVISION: "1111111111111111111111111111111111111111",
  MIGRATIONS_LATEST: "0073",
  CONTROL_PLANE_IMAGE: "open-inspect-control-plane:test",
  CONTROL_PLANE_IMAGE_ID: SAMPLE_ID,
  WEB_IMAGE: "open-inspect-web:test",
  WEB_IMAGE_ID: SAMPLE_ID,
  POLYTRONX_EDGE_NETWORK: "polytronx-edge",
  CONTROL_PLANE_LOOPBACK_PORT: "18787",
  WEB_LOOPBACK_PORT: "13080",
  OBJECT_STORE_BUCKET: "openinspect-media",
  LITESTREAM_BUCKET: "openinspect-backups",
};

/** Writes a release.env into the sandbox root and returns its path. */
export function writeRelease(sandbox, name = "release.env", overrides = {}) {
  const values = {
    ...RELEASE_DEFAULTS,
    POLYTRONX_SECRETS_DIR: sandbox.secrets,
    POLYTRONX_SOURCE_DIR: sandbox.root,
    ...overrides,
  };
  const path = `${sandbox.root}/${name}`;
  writeFileSync(path, Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n") + "\n");
  return path;
}

/** Writes a backup key with the owner-only mode that backup.sh and restore-rehearsal.sh require. */
export function writeKey(sandbox) {
  mkdirSync(sandbox.keys, { recursive: true });
  const key = `${sandbox.keys}/backup.key`;
  writeFileSync(key, "test-key\n");
  chmodSync(key, 0o600);
  return key;
}

function childEnv(sandbox, env) {
  return {
    ...process.env,
    PATH: `${sandbox.bin}${delimiter}${process.env.PATH}`,
    STUB_LOG: sandbox.log,
    ...env,
  };
}

/** Runs deploy/polytronx/<script> with bash, with the stubs first on PATH. */
export function runScript(sandbox, script, args, env = {}) {
  return spawnSync(BASH, [`${sandbox.deploy}/${script}`, ...args], {
    encoding: "utf8",
    cwd: sandbox.root,
    env: childEnv(sandbox, env),
    timeout: 120_000,
  });
}

/** Runs a bash snippet, typically `source lib.sh` followed by one helper. */
export function runSnippet(sandbox, snippet, env = {}) {
  return spawnSync(BASH, ["-c", snippet], {
    encoding: "utf8",
    cwd: sandbox.root,
    env: childEnv(sandbox, env),
    timeout: 60_000,
  });
}

/** Every line the stubs recorded, in call order. */
export function stubCalls(sandbox) {
  return readFileSync(sandbox.log, "utf8").split("\n").filter(Boolean);
}

/** The recorded docker compose calls, with the project flags left in. */
export function composeCalls(sandbox) {
  return stubCalls(sandbox).filter((line) => line.startsWith("docker compose"));
}
