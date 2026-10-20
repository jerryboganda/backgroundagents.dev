#!/usr/bin/env node
// Checks the SSH identity of a deployment host before GitHub Actions is allowed to use
// it. The key stays on the operator's machine: this tool reads it, never prints it, and
// never copies it anywhere.
//
//   node scripts/ssh-verify.mjs --host <host> --user <user> --key <private key>
//       [--port 22] [--known-hosts <file>] --fingerprint <SHA256 fingerprint>
//
// The fingerprint is the one the server itself printed, read from the provider's console:
//
//   sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256
//
// The tool then does what the deployment workflow does: it reads the key the host
// presents, compares it with that fingerprint, and authenticates with the key under
// strict host key checking. A mismatch is a failure, never a warning.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

const PRIVATE_KEY_HEADER = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const FINGERPRINT = /SHA256:[A-Za-z0-9+/=]+/g;

/** Runs a command and returns its status and output. */
export function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  return {
    status: result.status === null ? 1 : result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** The options the tool needs. Every one of them is named, so nothing is guessed. */
export function parseArgs(argv) {
  const options = { port: "22", knownHosts: "", fingerprint: "" };
  const names = {
    "--host": "host",
    "--user": "user",
    "--port": "port",
    "--key": "key",
    "--known-hosts": "knownHosts",
    "--fingerprint": "fingerprint",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const name = names[argv[index]];
    if (!name) throw new Error(`unknown argument: ${argv[index]}`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${argv[index]} needs a value`);
    options[name] = value;
    index += 1;
  }
  for (const name of ["host", "user", "key", "fingerprint"]) {
    if (!options[name])
      throw new Error(
        `--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`
      );
  }
  options.key = resolve(options.key);
  if (options.knownHosts) options.knownHosts = resolve(options.knownHosts);
  return options;
}

/** The SHA256 fingerprints in the output of ssh-keygen, without duplicates. */
export function fingerprintsOf(output) {
  return [...new Set(output.match(FINGERPRINT) ?? [])].sort();
}

/** True when the path is inside the repository, where a private key must never be. */
export function isInsideRepository(path) {
  const inside = relative(REPO_ROOT, resolve(path));
  return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside);
}

/** True when the file holds a private key header. */
export function looksLikePrivateKey(path) {
  const head = readFileSync(path, "utf8").slice(0, 4096);
  return PRIVATE_KEY_HEADER.test(head);
}

/**
 * Compares the recorded fingerprint with the ones the host presents. The recorded value
 * may be the whole ssh-keygen line; only its SHA256 token is compared.
 */
export function compareFingerprints(recorded, presented) {
  const expected = fingerprintsOf(recorded)[0];
  if (!expected)
    return { ok: false, detail: "the recorded fingerprint is not a SHA256 fingerprint" };
  const actual = fingerprintsOf(presented);
  if (actual.length === 0) return { ok: false, detail: "the host presented no key" };
  if (actual.length > 1) {
    return {
      ok: false,
      detail: `the host presented ${actual.length} keys, so none can be trusted`,
    };
  }
  if (actual[0] !== expected) {
    return {
      ok: false,
      detail: `the host presented ${actual[0]} and the console printed ${expected}`,
    };
  }
  return { ok: true, detail: expected };
}

/** The ssh-keyscan arguments for a host and port. */
export function keyscanArgs({ host, port }) {
  return ["-p", port, "-t", "ed25519", host];
}

/** The ssh arguments for the authentication check. */
export function authenticationArgs({ user, host, port, key, knownHosts }) {
  return [
    "-i",
    key,
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${knownHosts}`,
    "-o",
    "BatchMode=yes",
    "-o",
    "PasswordAuthentication=no",
    "-p",
    port,
    `${user}@${host}`,
    "true",
  ];
}

/**
 * Runs the checks and returns them. The caller decides how to report them, so the same
 * checks run in the tool and in its tests.
 */
export function verify(options, deps = {}) {
  const run = deps.run ?? runCommand;
  const checks = [];
  // A detail explains a failure. A check that passed keeps its detail to itself.
  const add = (name, ok, detail = "") => checks.push({ name, ok, detail: ok ? "" : detail });

  if (!existsSync(options.key)) {
    add("the private key is there", false, `${options.key} does not exist`);
  } else {
    add("the private key is there", true);
    add(
      "the private key holds a private key",
      looksLikePrivateKey(options.key),
      `${options.key} does not start with a private key header`
    );
  }
  add(
    "the private key is outside the repository",
    !isInsideRepository(options.key),
    `${options.key} is inside the repository`
  );

  const scan = run("ssh-keyscan", keyscanArgs(options));
  const scanned = scan.status === 0 ? scan.stdout : "";
  // The scan gives public keys. ssh-keygen turns them into the fingerprints the console
  // printed, which is what the comparison is about.
  const listed = scanned
    ? run("ssh-keygen", ["-l", "-f", "-", "-E", "sha256"], { input: scanned })
    : { status: 1, stdout: "" };
  const comparison = compareFingerprints(options.fingerprint, listed.stdout);
  add("the host key matches the fingerprint from the console", comparison.ok, comparison.detail);
  if (!comparison.ok) return { checks, ok: false };

  let knownHosts = options.knownHosts;
  let temporary = "";
  if (!knownHosts) {
    // The key the host presented was just verified against the console fingerprint, so
    // it is the one record the check needs.
    temporary = mkdtempSync(join(tmpdir(), "polytronx-ssh-verify-"));
    knownHosts = join(temporary, "known_hosts");
    writeFileSync(knownHosts, scanned, { mode: 0o600 });
  } else if (!existsSync(knownHosts)) {
    add("the known hosts file is there", false, `${knownHosts} does not exist`);
    return { checks, ok: false };
  } else {
    const known = run("ssh-keygen", ["-F", options.host, "-f", knownHosts]);
    add(
      "the known hosts file holds the host",
      known.status === 0,
      `${knownHosts} holds no record for ${options.host}`
    );
    if (known.status !== 0) return { checks, ok: false };
  }

  const auth = run("ssh", authenticationArgs({ ...options, knownHosts }));
  add(
    "the key authenticates as the deployment account",
    auth.status === 0,
    auth.status === 0 ? "" : `ssh exited ${auth.status}: ${auth.stderr.trim()}`
  );

  if (temporary) rmSync(temporary, { recursive: true, force: true });
  return { checks, ok: checks.every((check) => check.ok) };
}

/** Runs the tool. Returns the exit status. */
export function main(argv, deps = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`ssh-verify: ${error.message}`);
    return 2;
  }
  const result = verify(options, deps);
  for (const check of result.checks) {
    console.log(
      `${check.ok ? "PASS" : "FAIL"}  ${check.name}${check.detail ? `: ${check.detail}` : ""}`
    );
  }
  console.log(result.ok ? "ssh-verify: every check passed" : "ssh-verify: a check failed");
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
