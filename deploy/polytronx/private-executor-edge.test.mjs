// Guards for the private executor edge and the sandbox network: the rendered TLS config, the
// refusals (host, scope, certificate, mount, owned files, pinned proxy), idempotence, the rule that
// only owned chains, jumps and units are written or removed, and the boot unit's ordering. The
// scripts run under bash with stubs first on PATH (ip, openssl, caddy, ufw, systemctl, mountpoint,
// docker, iptables, iptables-restore, sysctl, sha256sum), so nothing touches a host firewall, UFW,
// Docker, systemd or a certificate authority. The Caddy archive is a real tar.gz with a stub inside;
// sha256sum is stubbed to report the pinned digest, since no test can produce the published archive.
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { describe, it } from "node:test";
import { DEPLOY_DIR, makeSandbox, runScript, runSnippet, stubCalls } from "./test-harness.mjs";

const SUBNET = "10.251.7.0/24";
const KEY_HEX = "a".repeat(64);
const UFW_POLICY =
  "Status: active\nDefault: deny (incoming), allow (outgoing), disabled (routed)\n";
const UFW_DEFAULT = `${UFW_POLICY}22/tcp ALLOW IN Anywhere\n`;

const IP_STUB = 'echo "2: eth0    inet ${STUB_HOST_IP:-172.235.26.148}/24 scope global eth0"';
const SYSCTL_STUB = 'case " $* " in *" -n "*) echo "${STUB_IPV6_OFF:-1}" ;; esac';

const OPENSSL_STUB = `
out=""; prev=""
for a in "$@"; do [ "$prev" = -out ] && out="$a"; prev="$a"; done
case "$1" in
  genpkey) printf 'key-stub\\n' > "$out" ;;
  req) printf 'req-stub\\n' > "$out" ;;
  verify) exit \${STUB_VERIFY:-0} ;;
  x509)
    case " $* " in
      *" -req "*) printf 'cert-stub\\n' > "$out" ;;
      *" -ext subjectAltName "*) printf 'X509v3 Subject Alternative Name:\\n    IP Address:%s\\n' "\${STUB_SAN:-172.235.26.148}" ;;
      *" -ext basicConstraints "*) printf 'X509v3 Basic Constraints: critical\\n    CA:TRUE\\n' ;;
      *" -checkend "*) exit \${STUB_CHECKEND:-0} ;;
      *" -fingerprint "*) echo 'sha256 Fingerprint=AA:BB' ;;
    esac ;;
esac
exit 0
`;

const CADDY_STUB = `
case "$1" in
  version) echo "\${STUB_CADDY_VERSION:-v2.11.7 h1:stub}" ;;
  validate) exit \${STUB_VALIDATE:-0} ;;
esac
exit 0
`;

// The digest the script pins, read from the script so the tests follow it. A real archive cannot carry
// the published digest, so sha256sum reports the pin for whatever archive it is given; STUB_ARCHIVE_SHA256
// overrides that for the refusal test.
const CADDY_PIN = /^CADDY_ARCHIVE_SHA256="([0-9a-f]{64})"$/m.exec(
  readFileSync(`${DEPLOY_DIR}/private-executor-edge.sh`, "utf8")
)[1];
const SHA_STUB = `echo "\${STUB_ARCHIVE_SHA256:-${CADDY_PIN}}  $1"`;

const UFW_STUB = `
[ "$1" = --force ] && shift
state="$STUB_STATE/ufw-status"
case "$1" in
  status) cat "$state" ;;
  allow) rule="19443/tcp ALLOW $3"; case " $* " in *" comment "*) rule="$rule # polytronx executor edge" ;; esac; echo "$rule" >> "$state" ;;
  delete) grep -v '^19443/tcp' "$state" > "$state.tmp"; mv "$state.tmp" "$state" ;;
esac
exit 0
`;

// Records each restore line, and keeps each owned chain's rules in its own file.
const RESTORE_STUB = `
while IFS= read -r line; do
  echo "restore-line $line" >> "$STUB_LOG"
  case "$line" in
    -F\\ *) chain="\${line#-F }"; : > "$STUB_STATE/chain-$chain" ;;
    -A\\ *) rest="\${line#-A }"; chain="\${rest%% *}"; printf '%s\\n' "$line" >> "$STUB_STATE/chain-$chain" ;;
  esac
done
exit 0
`;

// iptables -S prints a rule the way the tool and the kernel normalise it: the implicit match module
// (-p udp -m udp, -p tcp -m tcp) and conntrack states in kernel order (RELATED,ESTABLISHED). The stub
// prints a chain the same way, so a rule written in any other form fails check here, as it would on a host.
const IPTABLES_STUB = `
case "$1" in
  -S)
    if [ "$2" = DOCKER-USER ]; then
      [ -z "$STUB_NO_DOCKER_USER" ] || exit 1
      echo "-N DOCKER-USER"
    else
      sed -e 's/ -p \\(udp\\|tcp\\) --dport/ -p \\1 -m \\1 --dport/' -e 's/--ctstate ESTABLISHED,RELATED /--ctstate RELATED,ESTABLISHED /' "$STUB_STATE/chain-$2" 2>/dev/null
    fi ;;
  -C) shift; grep -qxF -- "$*" "$STUB_STATE/jumps" 2>/dev/null; exit $? ;;
  -I) chain="$2"; shift 3; echo "$chain $*" >> "$STUB_STATE/jumps" ;;
  -D) chain="$2"; shift 2; grep -vxF -- "$chain $*" "$STUB_STATE/jumps" > "$STUB_STATE/jumps.tmp" 2>/dev/null; mv "$STUB_STATE/jumps.tmp" "$STUB_STATE/jumps" ;;
  -F) : > "$STUB_STATE/chain-$2" ;;
  -X) rm -f "$STUB_STATE/chain-$2" ;;
esac
exit 0
`;

const DOCKER_NET_STUB = `
case "$1 $2" in
  "network inspect") [ -f "$STUB_STATE/network" ] || exit 1; echo "\${STUB_NETWORK_STATE:-bridge br-oisandbox false false ${SUBNET}}" ;;
  "network create") : > "$STUB_STATE/network" ;;
esac
exit 0
`;

// Answers the label filters of the container cleanup, from "id<TAB>name<TAB>label" lines in $STUB_STATE/containers.
const DOCKER_OWNED_STUB = `
case "$1" in
  ps)
    for arg in "$@"; do case "$arg" in label=*) label="\${arg#label=}" ;; esac; done
    awk -F'\\t' -v l="$label" '$3 == l { print $1 }' "$STUB_STATE/containers" ;;
  rm) shift; [ "$1" = -f ] && shift; for id in "$@"; do echo "$id" >> "$STUB_STATE/removed"; done ;;
  stop) shift; for id in "$@"; do echo "$id" >> "$STUB_STATE/stopped"; done ;;
esac
exit 0
`;

// The boot unit's state lives in a marker file: enable creates it, disable removes it.
const SYSTEMCTL_STUB = `
case "$1" in
  is-enabled) if [ -f "$STUB_STATE/unit-enabled" ]; then echo enabled; else echo disabled; exit 1; fi ;;
  enable) : > "$STUB_STATE/unit-enabled" ;;
  disable) rm -f "$STUB_STATE/unit-enabled" ;;
esac
exit 0
`;

/** Writes an executable stub that logs its arguments, then runs `body`. */
function stub(sb, name, body) {
  const path = `${sb.bin}/${name}`;
  writeFileSync(path, `#!/usr/bin/env bash\necho "${name} $*" >> "$STUB_LOG"\n${body}\n`);
  chmodSync(path, 0o755);
}

/** The sandbox root as bash names it, so the scripts receive a path bash can open. */
const bashRoot = (sb) => runSnippet(sb, "pwd").stdout.trim();

/** The rules a chain holds as the restore wrote them, without the chain name. */
function chainRules(sb, chain) {
  const prefix = `restore-line -A ${chain} `;
  return stubCalls(sb)
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
}

/** The command inside a container-mode unit line such as ExecStop=/bin/sh -c '...', with docker resolved on PATH. */
function unitShell(unit, key) {
  const line = unit.split("\n").find((text) => text.startsWith(`${key}=`));
  const script = /^-?\/bin\/sh -c '(.*)'$/.exec(line.slice(key.length + 1))[1];
  return script.replaceAll("/usr/bin/docker", "docker");
}

function edgeSandbox(ufw = UFW_DEFAULT) {
  const sb = makeSandbox();
  mkdirSync(sb.state, { recursive: true });
  mkdirSync(`${sb.root}/units`);
  writeFileSync(`${sb.state}/ufw-status`, ufw);
  stub(sb, "ip", IP_STUB);
  stub(sb, "openssl", OPENSSL_STUB);
  stub(sb, "sha256sum", SHA_STUB);
  stub(sb, "ufw", UFW_STUB);
  stub(sb, "systemctl", "exit 0");
  stub(sb, "mountpoint", "exit ${STUB_MOUNTPOINT:-1}");
  stub(sb, "docker", "exit 0");
  // The official archive's shape: one file named caddy, which the script extracts and installs.
  mkdirSync(`${sb.root}/archive`);
  writeFileSync(
    `${sb.root}/archive/caddy`,
    `#!/usr/bin/env bash\necho "caddy $*" >> "$STUB_LOG"\n${CADDY_STUB}\n`
  );
  chmodSync(`${sb.root}/archive/caddy`, 0o755);
  // Run from inside the sandbox: GNU tar reads a drive letter in an argument as a remote host.
  const made = runSnippet(sb, "cd archive && tar -czf ../caddy_linux_amd64.tar.gz caddy");
  assert.equal(made.status, 0, made.stderr);
  return sb;
}

function edge(sb, root, args, env = {}) {
  return runScript(sb, "private-executor-edge.sh", args, {
    STUB_STATE: sb.state,
    POLYTRONX_EDGE_DIR: `${root}/edge`,
    POLYTRONX_EDGE_CA_DIR: `${root}/edge-ca`,
    POLYTRONX_UNIT_DIR: `${root}/units`,
    POLYTRONX_RESOLV_CONF: `${root}/sandbox-resolv.conf`,
    ...env,
  });
}

const applyArgs = (root) => ["apply", "--caddy-archive", `${root}/caddy_linux_amd64.tar.gz`];

function netSandbox() {
  const sb = makeSandbox();
  mkdirSync(sb.state, { recursive: true });
  mkdirSync(`${sb.root}/units`);
  stub(sb, "ip", IP_STUB);
  stub(sb, "docker", DOCKER_NET_STUB);
  stub(sb, "iptables", IPTABLES_STUB);
  stub(sb, "iptables-restore", RESTORE_STUB);
  stub(sb, "sysctl", SYSCTL_STUB);
  stub(sb, "systemctl", SYSTEMCTL_STUB);
  return sb;
}

const net = (sb, args, env = {}) =>
  runScript(sb, "sandbox-network.sh", args, {
    STUB_STATE: sb.state,
    POLYTRONX_UNIT_DIR: `${sb.root}/units`,
    POLYTRONX_RESOLV_CONF: `${sb.root}/sandbox-resolv.conf`,
    ...env,
  });

describe("private executor edge", () => {
  it("renders TLS for the fixed scope, with no plaintext listener, and writes nothing", () => {
    const sb = edgeSandbox();
    const root = bashRoot(sb);
    const result = edge(sb, root, ["render"]);
    assert.equal(result.status, 0, result.stderr);
    const out = result.stdout;
    assert.match(out, /^https:\/\/172\.235\.26\.148:19443 \{$/m);
    assert.match(out, /^\tbind 172\.235\.26\.148$/m);
    assert.match(out, /^\tdefault_sni 172\.235\.26\.148$/m);
    assert.match(out, /^\t@dashboard remote_ip 185\.252\.233\.186$/m);
    assert.match(out, /^\t\treverse_proxy 127\.0\.0\.1:8787$/m);
    assert.ok(out.includes(`\ttls "${root}/edge/tls/server.crt" "${root}/edge/tls/server.key" {`));
    assert.doesNotMatch(out, /http:\/\/|insecure|skip_verify|__[A-Z_]+__|PRIVATE KEY|key-stub/);
    assert.equal(existsSync(`${sb.root}/edge`), false);
  });

  it("refuses an edge directory that would break the Caddyfile, sits on engine state, or is a mount point", () => {
    const sb = edgeSandbox();
    const root = bashRoot(sb);
    const quoted = edge(sb, root, ["render"], { POLYTRONX_EDGE_DIR: `${root}/ed"ge` });
    assert.equal(quoted.status, 1);
    assert.match(quoted.stderr, /absolute path without quotes/);
    const engine = edge(sb, root, ["render"], { POLYTRONX_EDGE_DIR: "/var/lib/docker/edge" });
    assert.equal(engine.status, 1);
    assert.match(engine.stderr, /engine state/);
    const mounted = edge(sb, root, ["render"], { STUB_MOUNTPOINT: "0" });
    assert.equal(mounted.status, 1);
    assert.match(mounted.stderr, /mount point/);
  });

  it("refuses a host that does not own the edge address, before any change", () => {
    const sb = edgeSandbox();
    const root = bashRoot(sb);
    const result = edge(sb, root, applyArgs(root), { STUB_HOST_IP: "10.0.0.5" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not own 172\.235\.26\.148/);
    assert.equal(existsSync(`${sb.root}/edge`), false);
    assert.equal(
      stubCalls(sb).some((line) => /^(openssl|ufw|systemctl|sha256sum) /.test(line)),
      false
    );
  });

  it("refuses unknown options, so the scope cannot be widened from the command line", () => {
    const sb = edgeSandbox();
    const root = bashRoot(sb);
    const result = edge(sb, root, ["apply", "--source", "0.0.0.0/0"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown argument: --source/);
  });

  it("refuses an inactive firewall, since the source restriction would not be enforced", () => {
    const sb = edgeSandbox("Status: inactive\n");
    const root = bashRoot(sb);
    const result = edge(sb, root, applyArgs(root));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ufw is not active/);
    assert.equal(
      stubCalls(sb).some((line) => line.startsWith("ufw allow")),
      false
    );
  });

  it("refuses existing certificates that do not carry the edge address, and replaces nothing", () => {
    const sb = edgeSandbox();
    const root = bashRoot(sb);
    mkdirSync(`${sb.root}/edge/tls`, { recursive: true });
    mkdirSync(`${sb.root}/edge-ca`);
    for (const file of ["ca.key", "ca.crt"]) writeFileSync(`${sb.root}/edge-ca/${file}`, "old\n");
    for (const file of ["server.key", "server.crt"])
      writeFileSync(`${sb.root}/edge/tls/${file}`, "old\n");
    const result = edge(sb, root, applyArgs(root), { STUB_SAN: "10.9.9.9" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /lacks the IP SAN 172\.235\.26\.148/);
    assert.equal(readFileSync(`${sb.root}/edge/tls/server.crt`, "utf8"), "old\n");
    assert.equal(readFileSync(`${sb.root}/edge/tls/server.key`, "utf8"), "old\n");
  });

  it("refuses a partial set of certificates rather than completing it", () => {
    const sb = edgeSandbox();
    const root = bashRoot(sb);
    mkdirSync(`${sb.root}/edge-ca`, { recursive: true });
    writeFileSync(`${sb.root}/edge-ca/ca.crt`, "old\n");
    const result = edge(sb, root, applyArgs(root));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing beside the other edge material/);
    assert.equal(existsSync(`${sb.root}/edge/tls/server.key`), false);
  });

  it("refuses a CA directory inside the edge directory, which the proxy mounts whole", () => {
    const sb = edgeSandbox();
    const root = bashRoot(sb);
    const result = edge(sb, root, ["render"], { POLYTRONX_EDGE_CA_DIR: `${root}/edge/ca` });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CA directory must lie outside the edge directory/);
  });

  it("refuses a CA directory equal to the edge directory, and an edge directory inside the CA directory", () => {
    const sb = edgeSandbox();
    const root = bashRoot(sb);
    const equal = edge(sb, root, ["render"], { POLYTRONX_EDGE_CA_DIR: `${root}/edge` });
    assert.equal(equal.status, 1);
    assert.match(equal.stderr, /CA directory must lie outside the edge directory/);
    const nested = edge(sb, root, ["render"], { POLYTRONX_EDGE_DIR: `${root}/edge-ca/edge` });
    assert.equal(nested.status, 1);
    assert.match(nested.stderr, /edge directory must lie outside the CA directory/);
    assert.equal(existsSync(`${sb.root}/edge`), false);
  });

  it("refuses a directory written other than as its resolved path, with '..' or a trailing slash", () => {
    const sb = edgeSandbox();
    const root = bashRoot(sb);
    for (const ca of [`${root}/edge/../edge-ca`, `${root}/edge-ca/`]) {
      const result = edge(sb, root, ["render"], { POLYTRONX_EDGE_CA_DIR: ca });
      assert.equal(result.status, 1, ca);
      assert.match(result.stderr, /must be written as resolved paths/, ca);
    }
  });

  it(
    "refuses a directory reached through a symlink, which the path check would otherwise follow",
    {
      skip:
        process.platform === "win32" &&
        "creating a symlink needs privileges on Windows; the Linux runner checks this",
    },
    () => {
      const sb = edgeSandbox();
      const root = bashRoot(sb);
      mkdirSync(`${sb.root}/real-ca`);
      symlinkSync(`${sb.root}/real-ca`, `${sb.root}/ca-link`);
      const result = edge(sb, root, ["render"], { POLYTRONX_EDGE_CA_DIR: `${root}/ca-link` });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /must be written as resolved paths/);
      assert.equal(existsSync(`${sb.root}/edge`), false);
    }
  );

  it("refuses to overwrite a Caddyfile it did not write", () => {
    const sb = edgeSandbox();
    const root = bashRoot(sb);
    mkdirSync(`${sb.root}/edge`, { recursive: true });
    writeFileSync(`${sb.root}/edge/Caddyfile`, "foreign\n");
    const result = edge(sb, root, applyArgs(root));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not owned by this script/);
    assert.equal(readFileSync(`${sb.root}/edge/Caddyfile`, "utf8"), "foreign\n");
  });

  it("creates the material once, re-runs unchanged, and backs up owned config before replacing it", () => {
    const sb = edgeSandbox();
    const root = bashRoot(sb);
    let result = edge(sb, root, applyArgs(root));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /private-executor-edge: no blockers/);
    assert.equal(stubCalls(sb).filter((line) => line.startsWith("ufw allow")).length, 1);
    assert.match(
      readFileSync(`${sb.state}/ufw-status`, "utf8"),
      /19443\/tcp ALLOW 185\.252\.233\.186/
    );
    if (process.platform !== "win32") {
      assert.equal(statSync(`${sb.root}/edge-ca/ca.key`).mode & 0o777, 0o600, "ca.key");
      assert.equal(statSync(`${sb.root}/edge/tls/server.key`).mode & 0o777, 0o600, "server.key");
    }
    assert.equal(
      existsSync(`${sb.root}/edge/tls/ca.key`),
      false,
      "the CA key stays out of the edge directory"
    );
    assert.ok(existsSync(`${sb.root}/edge/bin/caddy-2.11.7`));
    const unit = readFileSync(`${sb.root}/units/polytronx-executor-edge.service`, "utf8");
    assert.match(
      unit,
      /^ExecStart="[^"]*\/edge\/bin\/caddy-2\.11\.7" run --config ".*\/edge\/Caddyfile" --adapter caddyfile$/m
    );
    assert.match(
      unit,
      /^After=network-online\.target docker\.service polytronx-sandbox-network\.service$/m
    );
    assert.ok(
      unit.split("\n").includes(`InaccessiblePaths=${root}/edge-ca`),
      "the proxy cannot read the CA directory"
    );

    result = edge(sb, root, applyArgs(root));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /unchanged/);
    assert.equal(stubCalls(sb).filter((line) => line.startsWith("ufw allow")).length, 1);
    assert.equal(
      readdirSync(`${sb.root}/edge`).some((file) => file.includes(".bak.")),
      false
    );

    const caddyfile = `${sb.root}/edge/Caddyfile`;
    writeFileSync(caddyfile, `${readFileSync(caddyfile, "utf8")}# operator note\n`);
    result = edge(sb, root, applyArgs(root));
    assert.equal(result.status, 0, result.stderr);
    const backups = readdirSync(`${sb.root}/edge`).filter((file) =>
      file.startsWith("Caddyfile.bak.")
    );
    assert.equal(backups.length, 1);
    assert.match(readFileSync(`${sb.root}/edge/${backups[0]}`, "utf8"), /# operator note/);
    assert.doesNotMatch(readFileSync(caddyfile, "utf8"), /# operator note/);
  });

  it(
    "refuses a private key that is not mode 0600 at check",
    {
      skip:
        process.platform === "win32" && "NTFS keeps no POSIX modes; the Linux runner checks this",
    },
    () => {
      const sb = edgeSandbox();
      const root = bashRoot(sb);
      assert.equal(edge(sb, root, applyArgs(root)).status, 0);
      chmodSync(`${sb.root}/edge/tls/server.key`, 0o644);
      const result = edge(sb, root, ["check"]);
      assert.equal(result.status, 1);
      assert.match(result.stdout, /FAIL {2}.*server\.key is not mode 0600/);
    }
  );

  it("container mode refuses a tag, admits a digest, and mounts only the edge directory read-only", () => {
    const sb = edgeSandbox();
    const root = bashRoot(sb);
    const tag = edge(sb, root, ["apply", "--proxy", "container", "--caddy-image", "caddy:2"]);
    assert.equal(tag.status, 1);
    assert.match(tag.stderr, /not reproducible/);
    const pinned = edge(sb, root, [
      "apply",
      "--proxy",
      "container",
      "--caddy-image",
      `caddy@sha256:${KEY_HEX}`,
    ]);
    assert.equal(pinned.status, 0, pinned.stderr);
    const unit = readFileSync(`${sb.root}/units/polytronx-executor-edge.service`, "utf8");
    assert.match(unit, /--network host --read-only --cap-drop ALL/);
    assert.equal(unit.split(" -v ").length - 1, 1);
    assert.ok(unit.includes(`-v "${root}/edge:${root}/edge:ro"`));
    assert.equal(unit.includes("docker.sock"), false);
  });

  it("container mode clears before a start only a leftover it labelled, and stops only its own container", () => {
    const sb = edgeSandbox();
    const root = bashRoot(sb);
    stub(sb, "docker", DOCKER_OWNED_STUB);
    assert.equal(
      edge(sb, root, ["apply", "--proxy", "container", "--caddy-image", `caddy@sha256:${KEY_HEX}`])
        .status,
      0
    );
    const unit = readFileSync(`${sb.root}/units/polytronx-executor-edge.service`, "utf8");
    assert.ok(
      unit
        .split("\n")
        .includes(
          "ExecStartPre=-/bin/sh -c '/usr/bin/docker ps -aq --filter label=io.polytronx.owner=private-executor-edge | xargs -r /usr/bin/docker rm -f'"
        )
    );
    assert.match(
      unit,
      /^ExecStart=\/usr\/bin\/docker run --rm --name polytronx-executor-edge --label io\.polytronx\.owner=private-executor-edge --network host /m
    );
    assert.doesNotMatch(
      unit,
      /docker (rm|stop) .*polytronx-executor-edge/,
      "no removal or stop by name alone"
    );
    const run = (key) => runSnippet(sb, unitShell(unit, key), { STUB_STATE: sb.state });
    // A foreign container holds the name without the label: neither the cleanup nor the stop touches it.
    writeFileSync(`${sb.state}/containers`, "f1\tpolytronx-executor-edge\t\nx1\tother\t\n");
    assert.equal(run("ExecStartPre").status, 0);
    assert.equal(run("ExecStop").status, 0);
    assert.equal(existsSync(`${sb.state}/removed`), false, "a foreign container is not removed");
    assert.equal(existsSync(`${sb.state}/stopped`), false, "a foreign container is not stopped");
    // A leftover this unit labelled is removed before the start and stopped on stop; the other container is kept.
    writeFileSync(
      `${sb.state}/containers`,
      "o1\tpolytronx-executor-edge\tio.polytronx.owner=private-executor-edge\nx1\tother\t\n"
    );
    assert.equal(run("ExecStartPre").status, 0);
    assert.equal(readFileSync(`${sb.state}/removed`, "utf8"), "o1\n");
    assert.equal(run("ExecStop").status, 0);
    assert.equal(readFileSync(`${sb.state}/stopped`, "utf8"), "o1\n");
  });

  it("binary mode refuses an archive whose SHA-256 is not the pinned one, and installs nothing", () => {
    const sb = edgeSandbox();
    const root = bashRoot(sb);
    const result = edge(sb, root, applyArgs(root), { STUB_ARCHIVE_SHA256: "0".repeat(64) });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not match the pinned SHA-256 of Caddy 2\.11\.7/);
    assert.equal(existsSync(`${sb.root}/edge/bin`), false);
    assert.equal(existsSync(`${sb.root}/edge/Caddyfile`), false);
    assert.equal(
      stubCalls(sb).some((line) => line.startsWith("ufw allow")),
      false
    );
  });

  it("binary mode refuses to replace a binary at the pinned path that differs from the archive", () => {
    const sb = edgeSandbox();
    const root = bashRoot(sb);
    mkdirSync(`${sb.root}/edge/bin`, { recursive: true });
    writeFileSync(`${sb.root}/edge/bin/caddy-2.11.7`, "other\n");
    const result = edge(sb, root, applyArgs(root));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /exists and differs from the pinned Caddy/);
    assert.equal(readFileSync(`${sb.root}/edge/bin/caddy-2.11.7`, "utf8"), "other\n");
  });

  it("binary mode refuses an installed Caddy of another version, at apply and at check", () => {
    const sb = edgeSandbox();
    const root = bashRoot(sb);
    assert.equal(edge(sb, root, applyArgs(root)).status, 0);
    const applied = edge(sb, root, ["apply"], { STUB_CADDY_VERSION: "v1.9.0 h1:stub" });
    assert.equal(applied.status, 1);
    assert.match(applied.stderr, /is not Caddy 2\.11\.7/);
    const checked = edge(sb, root, ["check"], { STUB_CADDY_VERSION: "v1.9.0 h1:stub" });
    assert.equal(checked.status, 1);
    assert.match(checked.stdout, /FAIL {2}.*is not Caddy 2\.11\.7/);
  });

  it("rollback removes only the owned firewall rule and config, and keeps the key material", () => {
    const sb = edgeSandbox();
    const root = bashRoot(sb);
    assert.equal(edge(sb, root, applyArgs(root)).status, 0);
    const result = edge(sb, root, ["rollback"]);
    assert.equal(result.status, 0, result.stderr);
    const status = readFileSync(`${sb.state}/ufw-status`, "utf8");
    assert.doesNotMatch(status, /19443/);
    assert.match(status, /22\/tcp/);
    assert.equal(existsSync(`${sb.root}/edge/Caddyfile`), false);
    assert.ok(
      readdirSync(`${sb.root}/edge`).some((file) => file.startsWith("Caddyfile.rolled-back."))
    );
    assert.ok(existsSync(`${sb.root}/edge/tls/server.key`));
    assert.ok(existsSync(`${sb.root}/edge-ca/ca.key`));
    assert.ok(existsSync(`${sb.root}/edge/bin/caddy-2.11.7`));
    assert.ok(
      stubCalls(sb).includes(
        "ufw --force delete allow from 185.252.233.186 to any port 19443 proto tcp"
      )
    );
    assert.ok(stubCalls(sb).includes("systemctl disable --now polytronx-executor-edge.service"));
    assert.ok(
      readdirSync(`${sb.root}/units`).some((file) =>
        file.startsWith("polytronx-executor-edge.service.rolled-back.")
      )
    );
  });

  it("rollback leaves a firewall rule it did not add, including one that matches the edge rule but for its comment", () => {
    const rules = `${UFW_POLICY}22/tcp ALLOW IN Anywhere\n19443/tcp ALLOW 185.252.233.186\n19443/tcp ALLOW 10.9.9.9 # polytronx executor edge\n`;
    const sb = edgeSandbox(rules);
    const root = bashRoot(sb);
    const result = edge(sb, root, ["rollback"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(`${sb.state}/ufw-status`, "utf8"), rules);
    assert.equal(
      stubCalls(sb).some((line) => line.startsWith("ufw --force delete")),
      false
    );
    assert.match(result.stderr, /not as a rule this script added/);
  });

  it("rollback leaves a unit it did not write in place, and stops nothing", () => {
    const sb = edgeSandbox();
    const root = bashRoot(sb);
    const unit = `${sb.root}/units/polytronx-executor-edge.service`;
    writeFileSync(unit, "[Unit]\nDescription=written by someone else\n");
    const result = edge(sb, root, ["rollback"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(unit, "utf8"), "[Unit]\nDescription=written by someone else\n");
    assert.equal(
      stubCalls(sb).some((line) => line.startsWith("systemctl disable")),
      false
    );
    assert.match(result.stderr, /not owned by this script/);
  });

  it("refuses the filesystem root as the edge or CA directory", () => {
    const sb = edgeSandbox();
    const root = bashRoot(sb);
    const edgeAtRoot = edge(sb, root, ["render"], { POLYTRONX_EDGE_DIR: "/" });
    assert.equal(edgeAtRoot.status, 1);
    assert.match(edgeAtRoot.stderr, /edge directory must not be \//);
    const caAtRoot = edge(sb, root, ["render"], { POLYTRONX_EDGE_CA_DIR: "/" });
    assert.equal(caAtRoot.status, 1);
    assert.match(caAtRoot.stderr, /CA directory must not be \//);
  });

  it("removes its TLS temporary directory when key generation fails", () => {
    const sb = edgeSandbox();
    const root = bashRoot(sb);
    mkdirSync(`${sb.root}/tmp`);
    stub(sb, "openssl", "exit 1");
    const result = edge(sb, root, applyArgs(root), { TMPDIR: `${root}/tmp` });
    assert.notEqual(result.status, 0);
    assert.deepEqual(
      readdirSync(`${sb.root}/tmp`),
      [],
      "nothing is left in the temporary directory"
    );
  });
});

describe("private edge UFW check", () => {
  const DASHBOARD = "19443/tcp ALLOW IN 185.252.233.186\n";
  /** The check's output for these ufw rules under the given status header; the default is deny. */
  function checkWith(rules, policy = UFW_POLICY) {
    const sb = edgeSandbox(`${policy}${rules}`);
    return edge(sb, bashRoot(sb), ["check"]);
  }
  const lines = (result) => result.stdout.split("\n");

  it("passes when only the dashboard reaches the edge port, beside rules for other ports and outbound rules", () => {
    const result = checkWith(
      "22/tcp ALLOW IN Anywhere\n22/tcp (v6) ALLOW IN Anywhere (v6)\n19000:19442/tcp ALLOW IN Anywhere\n" +
        `19444/tcp (v6) ALLOW IN Anywhere (v6)\nAnywhere ALLOW OUT Anywhere\n${DASHBOARD}`
    );
    assert.ok(
      lines(result).includes(
        "PASS  ufw denies incoming by default and admits 19443/tcp only from 185.252.233.186"
      )
    );
    assert.equal(
      lines(result).some((line) => line.startsWith("FAIL  ufw")),
      false,
      result.stdout
    );
  });

  it("refuses a default incoming policy other than deny", () => {
    const result = checkWith(
      DASHBOARD,
      "Status: active\nDefault: allow (incoming), allow (outgoing), disabled (routed)\n"
    );
    assert.equal(result.status, 1);
    assert.ok(lines(result).includes("FAIL  ufw's default incoming policy is not deny"));
  });

  it("refuses an IPv6 entry for the edge port, a range covering it, and a rule with no protocol", () => {
    for (const rule of [
      "19443/tcp (v6) ALLOW IN Anywhere (v6)",
      "19000:20000/tcp ALLOW IN Anywhere",
      "19443 ALLOW IN Anywhere",
    ]) {
      const result = checkWith(`${DASHBOARD}${rule}\n`);
      assert.ok(
        lines(result).includes(
          `FAIL  ufw rule admits 19443/tcp from another source or over IPv6: ${rule}`
        ),
        rule
      );
    }
  });

  it("refuses an every-port rule from any source, the dashboard included", () => {
    for (const rule of ["Anywhere ALLOW IN 10.0.0.9", "Anywhere ALLOW IN 185.252.233.186"]) {
      const result = checkWith(`${DASHBOARD}${rule}\n`);
      assert.ok(
        lines(result).includes(`FAIL  ufw rule admits every port, not only 19443/tcp: ${rule}`),
        rule
      );
    }
  });

  it("refuses an application profile whose ports the check cannot read, unless the dashboard is its source", () => {
    const result = checkWith(`${DASHBOARD}OpenSSH ALLOW IN Anywhere\n`);
    assert.ok(
      lines(result).includes(
        "FAIL  ufw rule's ports are not read (an application profile, an address with a port, or a port list): OpenSSH ALLOW IN Anywhere"
      )
    );
  });

  it("refuses an address-and-port rule and a port list, whose ports the check does not read, from any source but the dashboard", () => {
    for (const rule of [
      "172.235.26.148 19443/tcp ALLOW IN Anywhere",
      "22,19443/tcp ALLOW IN Anywhere",
    ]) {
      const result = checkWith(`${DASHBOARD}${rule}\n`);
      assert.equal(result.status, 1, rule);
      assert.ok(
        lines(result).includes(
          `FAIL  ufw rule's ports are not read (an application profile, an address with a port, or a port list): ${rule}`
        ),
        rule
      );
    }
  });
});

describe("sandbox network", () => {
  it("refuses a host that does not own the edge address, before any iptables or Docker call", () => {
    const sb = netSandbox();
    const result = net(sb, ["apply"], { STUB_HOST_IP: "10.0.0.5" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not own 172\.235\.26\.148/);
    assert.equal(
      stubCalls(sb).some((line) => /^(iptables|docker|sysctl|systemctl) /.test(line)),
      false
    );
  });

  it("refuses a subnet that is not an RFC1918 /24, or sits inside Docker's 172.17.0.0/16", () => {
    for (const subnet of ["8.8.8.0/24", "172.17.5.0/24", "10.0.0.0/16", "10.0.0.1/24"]) {
      const result = net(netSandbox(), ["check", "--subnet", subnet]);
      assert.equal(result.status, 1, subnet);
      assert.match(result.stderr, /RFC1918 \/24 outside 172\.17\.0\.0\/16/, subnet);
    }
  });

  it("apply writes only owned chains, jumps and its own boot unit, and never flushes a built-in or Docker chain", () => {
    const sb = netSandbox();
    const result = net(sb, ["apply"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /sandbox-network: no blockers/);
    const calls = stubCalls(sb);
    for (const line of calls.filter((call) => call.startsWith("iptables "))) {
      assert.doesNotMatch(line, /^iptables -[PXZF] (?!POLYTRONX-SBX-)/, line);
      assert.doesNotMatch(line, / -t /, line);
    }
    for (const line of calls.filter((call) => call.startsWith("restore-line -F "))) {
      assert.match(line, /^restore-line -F POLYTRONX-SBX-(FWD|IN)$/, line);
    }
    for (const line of calls.filter((call) => call.startsWith("restore-line :"))) {
      assert.match(line, /^restore-line :POLYTRONX-SBX-(FWD|IN) - \[0:0\]$/, line);
    }
    assert.ok(calls.includes("iptables-restore --noflush"));
    assert.deepEqual(
      calls.filter((call) => call.startsWith("iptables -I ")),
      [
        `iptables -I DOCKER-USER 1 -s ${SUBNET} -j POLYTRONX-SBX-FWD`,
        "iptables -I INPUT 1 -i br-oisandbox -j POLYTRONX-SBX-IN",
      ]
    );
    assert.ok(calls.includes("sysctl -q -w net.ipv6.conf.br-oisandbox.disable_ipv6=1"));
    assert.equal(
      calls.some((call) => /docker (restart|rm)|ufw/.test(call)),
      false
    );
    for (const line of calls.filter((call) => call.startsWith("systemctl "))) {
      assert.match(
        line,
        /^systemctl (daemon-reload|(enable|is-enabled) polytronx-sandbox-network\.service)$/,
        line
      );
    }
  });

  it("installs and enables an owned boot unit ordered after Docker and UFW and before the edge", () => {
    const sb = netSandbox();
    const result = net(sb, ["apply"]);
    assert.equal(result.status, 0, result.stderr);
    const unit = readFileSync(`${sb.root}/units/polytronx-sandbox-network.service`, "utf8");
    assert.match(unit, /^# polytronx-owned: sandbox-network$/m);
    assert.match(unit, /^After=docker\.service ufw\.service$/m);
    assert.match(unit, /^Requires=docker\.service$/m);
    assert.match(unit, /^Before=polytronx-executor-edge\.service$/m);
    assert.match(unit, /^Type=oneshot$/m);
    assert.match(unit, /^RemainAfterExit=yes$/m);
    assert.match(
      unit,
      /^ExecStart=\/bin\/bash "[^"]*sandbox-network\.sh" restore --subnet 10\.251\.7\.0\/24$/m
    );
    assert.ok(stubCalls(sb).includes("systemctl enable polytronx-sandbox-network.service"));
    assert.match(
      result.stdout,
      /boot unit polytronx-sandbox-network\.service is owned and enabled/
    );
  });

  it("refuses a boot unit it did not write, before any rule changes", () => {
    const sb = netSandbox();
    writeFileSync(`${sb.root}/units/polytronx-sandbox-network.service`, "foreign\n");
    const result = net(sb, ["apply"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not owned by this script/);
    const calls = stubCalls(sb);
    assert.equal(
      calls.some((call) => call.startsWith("iptables -") && !call.startsWith("iptables -S ")),
      false
    );
    assert.equal(
      calls.some(
        (call) => call.startsWith("iptables-restore") || call.startsWith("docker network create")
      ),
      false
    );
    assert.equal(
      readFileSync(`${sb.root}/units/polytronx-sandbox-network.service`, "utf8"),
      "foreign\n"
    );
  });

  it("applying twice adds no second jump, no second network, and leaves the unit unchanged", () => {
    const sb = netSandbox();
    assert.equal(net(sb, ["apply"]).status, 0);
    const second = net(sb, ["apply"]);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /already matches/);
    assert.match(second.stdout, /polytronx-sandbox-network\.service unchanged/);
    const calls = stubCalls(sb);
    assert.equal(calls.filter((call) => call.startsWith("iptables -I ")).length, 2);
    assert.equal(calls.filter((call) => call.startsWith("docker network create")).length, 1);
  });

  it("refuses an existing network with other options, and does not replace it", () => {
    const sb = netSandbox();
    writeFileSync(`${sb.state}/network`, "");
    const result = net(sb, ["apply"], {
      STUB_NETWORK_STATE: `bridge br-oisandbox true false ${SUBNET}`,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /other options/);
    const calls = stubCalls(sb);
    assert.equal(
      calls.some((call) => call.startsWith("docker network create")),
      false
    );
    assert.equal(
      calls.some((call) => call.startsWith("iptables -I")),
      false
    );
  });

  it("refuses when DOCKER-USER does not exist, since the forward rules could not be enforced", () => {
    const sb = netSandbox();
    const result = net(sb, ["apply"], { STUB_NO_DOCKER_USER: "1" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /DOCKER-USER does not exist/);
    assert.equal(
      stubCalls(sb).some((call) => call.startsWith("docker network create")),
      false
    );
  });

  it("the owned forward chain drops metadata, private and loopback before any allowance, and ends in DROP", () => {
    const sb = netSandbox();
    assert.equal(net(sb, ["apply"]).status, 0);
    const rules = stubCalls(sb)
      .filter((call) => call.startsWith("restore-line -A POLYTRONX-SBX-FWD "))
      .map((call) => call.replace("restore-line -A POLYTRONX-SBX-FWD ", ""));
    assert.equal(rules[0], "-d 169.254.0.0/16 -j DROP");
    assert.equal(rules.at(-1), "-j DROP");
    const firstAccept = rules.findIndex((rule) => rule.endsWith("ACCEPT"));
    for (const drop of [
      "-d 10.0.0.0/8 -j DROP",
      "-d 172.16.0.0/12 -j DROP",
      "-d 192.168.0.0/16 -j DROP",
      "-d 127.0.0.0/8 -j DROP",
    ]) {
      assert.ok(rules.indexOf(drop) < firstAccept, drop);
    }
    assert.equal(
      rules.some((rule) => rule.includes("185.252.233.186")),
      false,
      "the next rule already accepts every 443"
    );
  });

  it("restore re-applies the rules and sysctl only: it writes no unit and runs no systemctl", () => {
    const sb = netSandbox();
    const result = net(sb, ["restore"]);
    assert.equal(result.status, 0, result.stderr);
    const calls = stubCalls(sb);
    assert.ok(calls.includes("iptables-restore --noflush"));
    assert.ok(calls.includes(`sysctl -q -w net.ipv6.conf.br-oisandbox.disable_ipv6=1`));
    assert.equal(
      calls.some((call) => call.startsWith("systemctl")),
      false
    );
    assert.equal(existsSync(`${sb.root}/units/polytronx-sandbox-network.service`), false);
    // The one file it does write: the resolver every sandbox mounts, whole and without a leftover temp file.
    const resolv = `${sb.root}/sandbox-resolv.conf`;
    assert.equal(
      readFileSync(resolv, "utf8"),
      "nameserver 1.1.1.1\nnameserver 9.9.9.9\noptions ndots:0\n"
    );
    // NTFS reports 0666 whatever chmod did; the mode is proven on Linux only.
    if (process.platform !== "win32") assert.equal(statSync(resolv).mode & 0o777, 0o644);
    assert.equal(existsSync(`${resolv}.tmp`), false);
  });

  it("check fails a chain whose rules are reordered, or edited, while the count stays right", () => {
    const sb = netSandbox();
    assert.equal(net(sb, ["apply"]).status, 0);
    const file = `${sb.state}/chain-POLYTRONX-SBX-FWD`;
    const rules = readFileSync(file, "utf8").split("\n").filter(Boolean);
    writeFileSync(file, [rules[1], rules[0], ...rules.slice(2)].join("\n") + "\n");
    let result = net(sb, ["check"]);
    assert.equal(result.status, 1);
    assert.match(
      result.stdout,
      /FAIL {2}POLYTRONX-SBX-FWD differs from its expected rules, in order/
    );
    writeFileSync(
      file,
      rules.map((rule) => rule.replace("--dport 53 -j ACCEPT", "--dport 54 -j ACCEPT")).join("\n") +
        "\n"
    );
    result = net(sb, ["check"]);
    assert.match(
      result.stdout,
      /FAIL {2}POLYTRONX-SBX-FWD differs from its expected rules, in order/
    );
  });

  it("writes the owned chains in the form iptables -S prints them, in order", () => {
    const sb = netSandbox();
    assert.equal(net(sb, ["apply"]).status, 0);
    assert.deepEqual(chainRules(sb, "POLYTRONX-SBX-FWD"), [
      "-d 169.254.0.0/16 -j DROP",
      "-d 10.0.0.0/8 -j DROP",
      "-d 172.16.0.0/12 -j DROP",
      "-d 192.168.0.0/16 -j DROP",
      "-d 127.0.0.0/8 -j DROP",
      "-m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT",
      "-p udp -m udp --dport 53 -j ACCEPT",
      "-p tcp -m tcp --dport 53 -j ACCEPT",
      "-p tcp -m tcp --dport 443 -j ACCEPT",
      "-j DROP",
    ]);
    assert.deepEqual(chainRules(sb, "POLYTRONX-SBX-IN"), [
      "-m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT",
      "-j DROP",
    ]);
  });

  it("the iptables stub prints a chain as iptables -S does, not as it was written", () => {
    const sb = netSandbox();
    writeFileSync(
      `${sb.state}/chain-POLYTRONX-SBX-IN`,
      "-A POLYTRONX-SBX-IN -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT\n-A POLYTRONX-SBX-IN -p udp --dport 53 -j ACCEPT\n"
    );
    const printed = runSnippet(sb, "iptables -S POLYTRONX-SBX-IN", { STUB_STATE: sb.state });
    assert.equal(
      printed.stdout,
      "-A POLYTRONX-SBX-IN -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT\n-A POLYTRONX-SBX-IN -p udp -m udp --dport 53 -j ACCEPT\n"
    );
  });

  it("check fails a chain whose protocol match or conntrack state changed, with the rule count unchanged", () => {
    const sb = netSandbox();
    assert.equal(net(sb, ["apply"]).status, 0);
    const file = `${sb.state}/chain-POLYTRONX-SBX-FWD`;
    const original = readFileSync(file, "utf8");
    for (const [from, to] of [
      ["-p tcp -m tcp --dport 443", "-p udp -m udp --dport 443"],
      ["--ctstate RELATED,ESTABLISHED", "--ctstate RELATED,NEW"],
    ]) {
      writeFileSync(file, original.replace(from, to));
      const result = net(sb, ["check"]);
      assert.equal(result.status, 1, to);
      assert.match(
        result.stdout,
        /FAIL {2}POLYTRONX-SBX-FWD differs from its expected rules, in order/,
        to
      );
    }
    writeFileSync(file, original);
    assert.equal(net(sb, ["check"]).status, 0);
  });

  it("rollback disables and moves aside the owned boot unit, removes only the owned jumps and chains, and keeps the network", () => {
    const sb = netSandbox();
    assert.equal(net(sb, ["apply"]).status, 0);
    const result = net(sb, ["rollback"]);
    assert.equal(result.status, 0, result.stderr);
    const calls = stubCalls(sb);
    assert.ok(calls.includes(`iptables -D DOCKER-USER -s ${SUBNET} -j POLYTRONX-SBX-FWD`));
    assert.ok(calls.includes("iptables -D INPUT -i br-oisandbox -j POLYTRONX-SBX-IN"));
    assert.ok(calls.includes("iptables -X POLYTRONX-SBX-FWD"));
    assert.ok(calls.includes("iptables -X POLYTRONX-SBX-IN"));
    assert.ok(calls.includes("systemctl disable polytronx-sandbox-network.service"));
    assert.equal(existsSync(`${sb.root}/units/polytronx-sandbox-network.service`), false);
    assert.ok(
      readdirSync(`${sb.root}/units`).some((file) =>
        file.startsWith("polytronx-sandbox-network.service.rolled-back.")
      )
    );
    assert.equal(
      calls.some((call) => call.startsWith("docker network rm")),
      false
    );
    assert.equal(
      calls.some((call) => /^iptables -[FXPZ] /.test(call) && !/POLYTRONX-SBX-/.test(call)),
      false
    );
  });

  it("check reports a network, a jump and the boot unit as blockers on a host that was never applied", () => {
    const sb = netSandbox();
    const result = net(sb, ["check"]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /FAIL {2}network oi-sandbox/);
    assert.match(result.stdout, /FAIL {2}DOCKER-USER has no jump/);
    assert.match(
      result.stdout,
      /FAIL {2}boot unit polytronx-sandbox-network\.service is not owned and enabled/
    );
    assert.match(result.stdout, /FAIL {2}sandbox resolver file .* is missing or differs/);
  });

  it("check fails an edited resolver file, passes the restored one, and the executor binds the same path", () => {
    const sb = netSandbox();
    const resolv = `${sb.root}/sandbox-resolv.conf`;
    assert.equal(net(sb, ["restore"]).status, 0);
    writeFileSync(resolv, "nameserver 127.0.0.1\n");
    assert.match(net(sb, ["check"]).stdout, /FAIL {2}sandbox resolver file/);
    writeFileSync(resolv, "nameserver 1.1.1.1\nnameserver 9.9.9.9\noptions ndots:0\n");
    assert.match(net(sb, ["check"]).stdout, /PASS {2}sandbox resolver file/);
    const script = readFileSync(`${DEPLOY_DIR}/sandbox-network.sh`, "utf8");
    const executor = readFileSync(
      `${DEPLOY_DIR}/../../packages/vps-executor/src/docker.ts`,
      "utf8"
    );
    const shellDefault = script.match(/POLYTRONX_RESOLV_CONF:-([^}]+)\}/)?.[1];
    assert.ok(shellDefault);
    assert.ok(executor.includes(`const RESOLV_CONF_SOURCE = "${shellDefault}";`));
  });
});

describe("replaceable VPS edge endpoints", () => {
  it("accepts explicitly configured unicast IPv4 addresses without weakening the edge policy", () => {
    const sb = edgeSandbox();
    const root = bashRoot(sb);
    const result = edge(sb, root, ["render"], {
      POLYTRONX_EXECUTOR_EDGE_ADDRESS: "198.51.100.42",
      POLYTRONX_DASHBOARD_SOURCE_IPV4: "203.0.113.15",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^https:\/\/198\.51\.100\.42:19443 \{$/m);
    assert.match(result.stdout, /^\tbind 198\.51\.100\.42$/m);
    assert.match(result.stdout, /^\tdefault_sni 198\.51\.100\.42$/m);
    assert.match(result.stdout, /^\t@dashboard remote_ip 203\.0\.113\.15$/m);
    assert.match(result.stdout, /^\t\treverse_proxy 127\.0\.0\.1:8787$/m);
    assert.doesNotMatch(result.stdout, /http:\/\/|skip_verify|insecure/);
    assert.equal(existsSync(`${sb.root}/edge`), false);
  });

  it("rejects invalid or unsafe executor edge addresses before touching host state", () => {
    for (const invalid of [
      "",
      "0.0.0.0",
      "127.0.0.1",
      "169.254.1.10",
      "224.0.0.1",
      "255.255.255.255",
      "192.168.001.1",
      "192.168.1.256",
      "example.com",
      "192.0.2.1/32",
      "192.0.2.1;echo hacked",
    ]) {
      const sb = edgeSandbox();
      const root = bashRoot(sb);
      const result = edge(sb, root, ["apply"], {
        POLYTRONX_EXECUTOR_EDGE_ADDRESS: invalid,
      });
      assert.equal(result.status, 1, invalid);
      assert.match(
        result.stderr,
        /POLYTRONX_EXECUTOR_EDGE_ADDRESS must be a unicast IPv4 host address/,
        invalid
      );
      assert.equal(existsSync(`${sb.root}/edge`), false, invalid);
      assert.equal(stubCalls(sb).length, 0, invalid);
    }
  });

  it("rejects invalid or unsafe dashboard sources before rendering the firewall policy", () => {
    for (const invalid of [
      "",
      "0.0.0.0",
      "127.0.0.1",
      "169.254.100.1",
      "240.0.0.1",
      "198.51.100.999",
      "010.0.0.1",
      "example.net",
      "203.0.113.10/24",
      "203.0.113.1 & echo hacked",
    ]) {
      const sb = edgeSandbox();
      const root = bashRoot(sb);
      const result = edge(sb, root, ["render"], {
        POLYTRONX_DASHBOARD_SOURCE_IPV4: invalid,
      });
      assert.equal(result.status, 1, invalid);
      assert.match(
        result.stderr,
        /POLYTRONX_DASHBOARD_SOURCE_IPV4 must be a unicast IPv4 host address/,
        invalid
      );
      assert.equal(existsSync(`${sb.root}/edge`), false, invalid);
    }
  });

  it("refuses to reuse an old TLS server certificate when the executor IP changes", () => {
    const sb = edgeSandbox();
    const root = bashRoot(sb);
    mkdirSync(`${sb.root}/edge/tls`, { recursive: true });
    mkdirSync(`${sb.root}/edge-ca`);
    for (const file of ["ca.key", "ca.crt"]) writeFileSync(`${sb.root}/edge-ca/${file}`, "old\n");
    for (const file of ["server.key", "server.crt"])
      writeFileSync(`${sb.root}/edge/tls/${file}`, "old\n");
    const result = edge(sb, root, applyArgs(root), {
      POLYTRONX_EXECUTOR_EDGE_ADDRESS: "198.51.100.42",
      STUB_HOST_IP: "198.51.100.42",
      STUB_SAN: "172.235.26.148",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /lacks the IP SAN 198\.51\.100\.42/);
    assert.equal(readFileSync(`${sb.root}/edge/tls/server.key`, "utf8"), "old\n");
  });
});
