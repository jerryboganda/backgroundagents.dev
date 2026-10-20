import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  authenticationArgs,
  compareFingerprints,
  fingerprintsOf,
  isInsideRepository,
  keyscanArgs,
  main,
  parseArgs,
  REPO_ROOT,
  verify,
} from "./ssh-verify.mjs";

const FINGERPRINT = "SHA256:0BGt5sT4t0dCFuXa5sT2m0aQ4eR8pZ1lQ7mZ0kZ4bW0";

/** A private key file that is not a real key: the tool only reads its header. */
function writeKey(name = "id_ed25519") {
  const directory = mkdtempSync(join(tmpdir(), "polytronx-ssh-verify-test-"));
  const path = join(directory, name);
  writeFileSync(
    path,
    "-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key\n-----END OPENSSH PRIVATE KEY-----\n"
  );
  return path;
}

/** A runner that answers the three commands the tool uses. */
function stubRunner({ scan = `host ${FINGERPRINT}`, authStatus = 0, authError = "" } = {}) {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args].join(" "));
    if (command === "ssh-keyscan") return { status: 0, stdout: scan, stderr: "" };
    if (command === "ssh-keygen") return { status: 0, stdout: "", stderr: "" };
    if (command === "ssh") return { status: authStatus, stdout: "", stderr: authError };
    return { status: 1, stdout: "", stderr: `unexpected command ${command}` };
  };
  return { run, calls };
}

describe("ssh-verify arguments", () => {
  it("needs a host, a user, a key and a fingerprint", () => {
    assert.throws(
      () => parseArgs(["--host", "h", "--user", "u", "--key", "k"]),
      /fingerprint is required/
    );
    assert.throws(
      () => parseArgs(["--host", "h", "--user", "u", "--key", "k", "--nope", "x"]),
      /unknown argument/
    );
  });

  it("defaults the port to 22 and keeps the rest", () => {
    const options = parseArgs([
      "--host",
      "185.252.233.186",
      "--user",
      "deploy",
      "--key",
      "id_ed25519",
      "--fingerprint",
      FINGERPRINT,
    ]);
    assert.equal(options.port, "22");
    assert.equal(options.host, "185.252.233.186");
    assert.equal(options.user, "deploy");
    assert.equal(options.fingerprint, FINGERPRINT);
    assert.equal(options.knownHosts, "");
  });
});

describe("fingerprint comparison", () => {
  it("reads the SHA256 token out of an ssh-keygen line", () => {
    assert.deepEqual(fingerprintsOf(`256 ${FINGERPRINT} host (ED25519)`), [FINGERPRINT]);
  });

  it("accepts the key the console printed", () => {
    const result = compareFingerprints(
      `256 ${FINGERPRINT} host (ED25519)`,
      `256 ${FINGERPRINT} host (ED25519)`
    );
    assert.equal(result.ok, true);
    assert.equal(result.detail, FINGERPRINT);
  });

  it("refuses a different key", () => {
    const result = compareFingerprints(
      FINGERPRINT,
      "256 SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA host (ED25519)"
    );
    assert.equal(result.ok, false);
    assert.match(result.detail, /the console printed/);
  });

  it("refuses a host that presents no key, or more than one", () => {
    assert.equal(compareFingerprints(FINGERPRINT, "").ok, false);
    const two = `256 ${FINGERPRINT} a (ED25519)\n256 SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB b (ED25519)`;
    assert.equal(compareFingerprints(FINGERPRINT, two).ok, false);
  });

  it("refuses a recorded value that is not a fingerprint", () => {
    assert.equal(compareFingerprints("the host is fine", `256 ${FINGERPRINT}`).ok, false);
  });
});

describe("the private key stays out of the repository", () => {
  it("names a path inside the repository", () => {
    assert.equal(isInsideRepository(join(REPO_ROOT, "scripts", "ssh-verify.mjs")), true);
    assert.equal(isInsideRepository(join(tmpdir(), "id_ed25519")), false);
  });
});

describe("the ssh arguments the check uses", () => {
  it("pins the key, the known hosts file and strict host key checking", () => {
    const args = authenticationArgs({
      user: "deploy",
      host: "185.252.233.186",
      port: "22",
      key: "/keys/id_ed25519",
      knownHosts: "/keys/known_hosts",
    });
    assert.ok(args.includes("IdentitiesOnly=yes"));
    assert.ok(args.includes("StrictHostKeyChecking=yes"));
    assert.ok(args.includes("BatchMode=yes"));
    assert.ok(args.includes("UserKnownHostsFile=/keys/known_hosts"));
    assert.ok(args.includes("deploy@185.252.233.186"));
    assert.equal(args[args.length - 1], "true");
  });

  it("scans the host key on the given port", () => {
    assert.deepEqual(keyscanArgs({ host: "h", port: "2222" }), [
      "-p",
      "2222",
      "-t",
      "ed25519",
      "h",
    ]);
  });
});

describe("the checks as a whole", () => {
  const options = (overrides = {}) => ({
    host: "185.252.233.186",
    user: "deploy",
    port: "22",
    key: writeKey(),
    knownHosts: "",
    fingerprint: FINGERPRINT,
    ...overrides,
  });

  it("passes when the host key matches and the key authenticates", () => {
    const stub = stubRunner();
    const result = verify(options(), { run: stub.run });
    assert.equal(result.ok, true, JSON.stringify(result.checks));
    assert.ok(stub.calls.some((call) => call.startsWith("ssh -i ")));
  });

  it("stops at a fingerprint that does not match, before it authenticates", () => {
    const stub = stubRunner({ scan: "host SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
    const result = verify(options(), { run: stub.run });
    assert.equal(result.ok, false);
    assert.ok(!stub.calls.some((call) => call.startsWith("ssh -i ")));
  });

  it("reports a key that cannot authenticate", () => {
    const stub = stubRunner({ authStatus: 255, authError: "Permission denied" });
    const result = verify(options(), { run: stub.run });
    assert.equal(result.ok, false);
    assert.match(result.checks.at(-1).detail, /Permission denied/);
  });

  it("refuses a private key that is inside the repository", () => {
    const stub = stubRunner();
    const result = verify(options({ key: join(REPO_ROOT, "deploy", "id_ed25519") }), {
      run: stub.run,
    });
    assert.equal(result.ok, false);
    assert.ok(
      result.checks.some((check) => check.name.includes("outside the repository") && !check.ok)
    );
  });

  it("returns a non-zero status when a check fails", () => {
    const stub = stubRunner({ scan: "host SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
    assert.equal(
      main(["--host", "h", "--user", "u", "--key", writeKey(), "--fingerprint", FINGERPRINT], {
        run: stub.run,
      }),
      1
    );
  });

  it("returns a status of two when the arguments are wrong", () => {
    assert.equal(main(["--host", "h"], { run: stubRunner().run }), 2);
  });
});
