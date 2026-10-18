// Guards for workspace-slots.sh and the executor's view of the slots. The script runs against a
// scratch host: its host tools are stubs (testdata/stubs/host-tool) that answer from a state directory,
// so nothing is mounted, formatted or changed.
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { DEPLOY_DIR, makeSandbox, runScript, stubCalls } from "./test-harness.mjs";

const HOST_TOOL = `${DEPLOY_DIR}/testdata/stubs/host-tool`;
const TOOLS = ["findmnt", "losetup", "blkid", "fallocate", "mkfs.ext4", "mount", "stat", "df", "id", "chmod", "systemctl"];
const SLOTS = [0, 1, 2, 3, 4, 5];
const DEFAULT_FSTAB = "UUID=root / ext4 defaults 0 1\nproc /proc proc defaults 0 0\n";
const MUTATING = /^(fallocate|mkfs\.ext4|mount|chmod|systemctl)\b/;

/** A scratch host: stub tools, an fstab and stub state. `freeGiB` is what df reports for the images. */
function scratchHost({ freeGiB = 200 } = {}) {
  const sb = makeSandbox();
  mkdirSync(join(sb.root, "srv")); // /srv exists on the host; the script creates only vps-ws below it
  for (const name of TOOLS) {
    copyFileSync(HOST_TOOL, `${sb.bin}/${name}`);
    chmodSync(`${sb.bin}/${name}`, 0o755);
  }
  const host = { sb, base: `${sb.root}/srv/vps-ws`, fstab: `${sb.root}/fstab`, state: `${sb.root}/host-state` };
  mkdirSync(host.state);
  writeFileSync(host.fstab, DEFAULT_FSTAB);
  host.env = {
    POLYTRONX_WS_BASE: host.base,
    POLYTRONX_FSTAB: host.fstab,
    HT_BASE: host.base,
    HT_FSTAB: host.fstab,
    HT_STATE: host.state,
    HT_FREE_KB: String(freeGiB * 1024 * 1024),
  };
  return host;
}

const image = (h, k) => `${h.base}/images/slot-${k}.img`;
/** A deploy file with LF line endings: the Windows working copy has CRLF, git stores LF. */
const read = (name) => readFileSync(`${DEPLOY_DIR}/${name}`, "utf8").replace(/\r\n/g, "\n");
const slotDir = (h, k) => `${h.base}/slots/${k}`;
const run = (h, args) => runScript(h.sb, "workspace-slots.sh", args, h.env);
const mutations = (h) => stubCalls(h.sb).filter((line) => MUTATING.test(line));
const resetLog = (h) => writeFileSync(h.sb.log, "");
const withoutComments = (text) => text.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");

describe("workspace-slots.sh --apply on a new host", () => {
  it("creates six images with the pinned flags, mounts each slot by its own path, and keeps the rest of fstab", () => {
    const h = scratchHost();
    const result = run(h, ["--apply"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const calls = stubCalls(h.sb);
    for (const k of SLOTS) {
      assert.ok(calls.includes(`fallocate -l 10G ${image(h, k)}`), `fallocate for slot ${k}`);
      assert.ok(calls.includes(`mkfs.ext4 -q -F -m 0 -N 262144 -E root_owner=1000:1000 ${image(h, k)}`));
      assert.ok(calls.includes(`mount ${slotDir(h, k)}`), `explicit mount of slot ${k}`);
      assert.ok(calls.includes(`chmod 700 ${slotDir(h, k)}`));
      assert.match(result.stdout, new RegExp(`PASS  slot ${k}: `));
    }
    assert.ok(!calls.some((line) => line.startsWith("mount -a")), "mount -a is never used");
    assert.equal(calls.filter((line) => line === "systemctl daemon-reload").length, 1);

    const lines = readFileSync(h.fstab, "utf8").split("\n");
    assert.deepEqual(lines.slice(0, 2), ["UUID=root / ext4 defaults 0 1", "proc /proc proc defaults 0 0"]);
    for (const k of SLOTS) {
      assert.ok(lines.includes(`${image(h, k)} ${slotDir(h, k)} ext4 loop,nosuid,nodev,noatime,nofail,x-systemd.before=docker.service 0 0`));
    }
    assert.ok(
      readdirSync(dirname(h.fstab)).some((name) => name.startsWith("fstab.polytronx-workspace-") && name.endsWith(".bak")),
      "fstab is backed up before it changes",
    );
  });

  it("is idempotent: a second run changes nothing, including fstab", () => {
    const h = scratchHost();
    assert.equal(run(h, ["--apply"]).status, 0);
    const fstab = readFileSync(h.fstab, "utf8");
    resetLog(h);
    const again = run(h, ["--apply"]);
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.deepEqual(mutations(h), []);
    assert.equal(readFileSync(h.fstab, "utf8"), fstab);
  });
});

describe("workspace-slots.sh --apply refuses and changes nothing", () => {
  it("refuses an existing image that is not ext4, and never formats it", () => {
    const h = scratchHost();
    mkdirSync(dirname(image(h, 2)), { recursive: true });
    writeFileSync(image(h, 2), "");
    const result = run(h, ["--apply"]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /FAIL {2}slot 2: image .* holds no ext4 filesystem/);
    assert.deepEqual(mutations(h), []);
    assert.equal(readFileSync(h.fstab, "utf8"), DEFAULT_FSTAB);
  });

  it("refuses a fstab entry for a slot that differs from the expected line", () => {
    const h = scratchHost();
    writeFileSync(h.fstab, `${DEFAULT_FSTAB}${image(h, 4)} ${slotDir(h, 4)} ext4 defaults 0 0\n`);
    const result = run(h, ["--apply"]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /FAIL {2}slot 4: fstab differs/);
    assert.deepEqual(mutations(h), []);
  });

  it("refuses a slot line written before the boot ordering was added, and rewrites nothing", () => {
    const h = scratchHost();
    const oldLine = `${image(h, 0)} ${slotDir(h, 0)} ext4 loop,nosuid,nodev,noatime,nofail 0 0\n`;
    writeFileSync(h.fstab, `${DEFAULT_FSTAB}${oldLine}`);
    const result = run(h, ["--apply"]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /FAIL {2}slot 0: fstab differs/);
    assert.deepEqual(mutations(h), []);
    assert.equal(readFileSync(h.fstab, "utf8"), `${DEFAULT_FSTAB}${oldLine}`);
  });

  it("refuses a slot directory with content in it, which a mount would hide", () => {
    const h = scratchHost();
    mkdirSync(slotDir(h, 1), { recursive: true });
    writeFileSync(join(slotDir(h, 1), "stray.txt"), "data");
    const result = run(h, ["--apply"]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /FAIL {2}slot 1: directory .* is not empty/);
    assert.deepEqual(mutations(h), []);
  });

  it("refuses when fewer than 30 GiB would stay free after allocation, before allocating anything", () => {
    const h = scratchHost({ freeGiB: 50 });
    const result = run(h, ["--apply"]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /FAIL {2}-?\d+ GiB free on .* after allocation; 30 GiB must stay free/);
    // Empty base directories are created before this check; no image, format, mount or fstab change is.
    assert.deepEqual(stubCalls(h.sb).filter((line) => /^(fallocate|mkfs\.ext4|mount)\b/.test(line)), []);
    assert.equal(readFileSync(h.fstab, "utf8"), DEFAULT_FSTAB);
  });
});

describe("workspace-slots.sh --check", () => {
  it("reports every slot as FAIL on a host with nothing provisioned, and changes nothing", () => {
    const h = scratchHost();
    const result = run(h, ["--check"]);
    assert.equal(result.status, 1);
    for (const k of SLOTS) assert.match(result.stdout, new RegExp(`FAIL  slot ${k}: image missing`));
    assert.deepEqual(mutations(h), []);
  });

  it("fails only the slot whose root is not 1000:1000 mode 700", () => {
    const h = scratchHost();
    assert.equal(run(h, ["--apply"]).status, 0);
    mkdirSync(join(h.state, "stat"));
    // The stub names state files by path, with / and : (a drive colon is an NTFS stream name) as %.
    writeFileSync(join(h.state, "stat", slotDir(h, 3).replace(/[/:]/g, "%")), "0 0 700\n");
    const result = run(h, ["--check"]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /FAIL {2}slot 3: .*root is not 1000:1000 mode 700/);
    for (const k of [0, 1, 2, 4, 5]) assert.match(result.stdout, new RegExp(`PASS  slot ${k}: `));
  });

  it("fails a provisioned slot that is not mounted, which is what a failed boot mount looks like", () => {
    const h = scratchHost();
    assert.equal(run(h, ["--apply"]).status, 0);
    rmSync(join(h.state, "mounted", "2"));
    const result = run(h, ["--check"]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /FAIL {2}slot 2: image ok; fstab ok; mount unmounted/);
  });
});

describe("the host contract in the source", () => {
  const script = withoutComments(read("workspace-slots.sh"));

  it("never runs mount -a or fsck", () => {
    assert.doesNotMatch(script, /mount -a/);
    assert.doesNotMatch(script, /\bfsck\b|e2fsck/);
  });

  it("orders every slot mount before docker.service, and never restarts Docker or writes a Docker unit override", () => {
    assert.match(script, /MOUNT_OPTS="loop,nosuid,nodev,noatime,nofail,x-systemd\.before=docker\.service"/);
    assert.doesNotMatch(script, /systemctl (restart|reload|start|stop|enable)|docker\.service\.d/);
  });

  it("creates root-owned 10 GiB images and formats them with the bounded inode count and the sandbox owner", () => {
    assert.match(script, /\(umask 077 && fallocate -l 10G "\$img"\)/);
    assert.match(script, /mkfs\.ext4 -q -F -m 0 -N 262144 -E root_owner=1000:1000 "\$img"/);
  });
});

describe("the executor's view of the slots", () => {
  const compose = withoutComments(read("compose.executor.yml"));

  it("binds only the slot root, at the same path, privately, and never creates it on the host", () => {
    assert.match(compose, /source: \/srv\/vps-ws\/slots\n\s+target: \/srv\/vps-ws\/slots/);
    assert.match(compose, /propagation: rprivate/);
    assert.match(compose, /create_host_path: false/);
    for (const banned of ["/srv/vps-ws/images", "rshared", "privileged", "SYS_ADMIN", "devices:", "cap_add"]) {
      assert.ok(!compose.includes(banned), `compose.executor.yml must not contain ${banned}`);
    }
  });

  it("fixes the six slots, the state file and the trusted control-plane URL, with no reset TTL, and publishes the API on loopback only", () => {
    assert.match(compose, /VPS_EXECUTOR_WORKSPACE_ROOT: \/srv\/vps-ws\/slots/);
    assert.match(compose, /VPS_EXECUTOR_WORKSPACE_SLOTS: "6"/);
    assert.match(compose, /VPS_EXECUTOR_STATE_FILE: \/var\/lib\/vps-executor\/executor-state\.db/);
    assert.match(compose, /VPS_EXECUTOR_CONTROL_PLANE_URL: \$\{VPS_EXECUTOR_CONTROL_PLANE_URL:\?/);
    assert.match(compose, /- "127\.0\.0\.1:8787:8787"/);
    assert.doesNotMatch(compose, /TTL|\bEXECUTOR_(BIND_ADDRESS|WORKSPACE_SLOTS)\b/);
  });

  it("keeps the executor's control-plane URL out of the dashboard release template, and has preflight run both read-only checks", () => {
    const template = read("templates/release.env.template");
    assert.doesNotMatch(template, /VPS_EXECUTOR_/);
    assert.match(read("runbooks/executor-host.md"), /^\s*VPS_EXECUTOR_CONTROL_PLANE_URL=<the trusted control plane's https URL>$/m);
    assert.doesNotMatch(template, /TTL|\bEXECUTOR_(BIND_ADDRESS|WORKSPACE_SLOTS)\b/);
    const preflight = read("preflight-executor.sh");
    assert.match(preflight, /workspace-slots\.sh" --check/);
    assert.match(preflight, /sandbox-network\.sh" check/);
  });
});
