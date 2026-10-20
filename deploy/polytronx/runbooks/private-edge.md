# Private executor edge and sandbox egress

Assets for the VPS executor's HTTPS ingress and its sandbox network. Written and unit-tested; not
applied to any host. Nothing here has run against `172.235.26.148`. Live steps are operator steps.

- `templates/executor-Caddyfile`: the Caddy site, rendered by `private-executor-edge.sh`.
- `private-executor-edge.sh`: CA and server certificate, pinned Caddy install, rendered Caddyfile,
  systemd unit, one UFW allow.
- `sandbox-network.sh`: the `oi-sandbox` bridge, the owned iptables chains, and the owned boot unit
  `polytronx-sandbox-network.service`.
- `private-executor-edge.test.mjs`: focused tests with stubs. CI runs it with
  `node --test deploy/polytronx/*.test.mjs`.

## Scope (fixed port and private upstream; configurable validated IPv4 endpoints)

| Item           | Value                                                                                        |
| -------------- | -------------------------------------------------------------------------------------------- |
| Edge address   | `POLYTRONX_EXECUTOR_EDGE_ADDRESS` (default `172.235.26.148`), port `19443`; bound only there |
| Allowed source | `POLYTRONX_DASHBOARD_SOURCE_IPV4` (default `185.252.233.186`); UFW and Caddy restrict it     |
| Upstream       | `127.0.0.1:8787` (executor, loopback only; compose publishes nothing else)                   |
| Other ports    | Untouched. `80` and `443` are never opened or changed                                        |
| Sandbox bridge | `oi-sandbox`, bridge `br-oisandbox`, `10.251.7.0/24`, ICC off, IPv6 off                      |

No plaintext listener is created. `auto_https off` and `admin off` are set, and there is no
`http://` site.

## Pinned proxy

| Item    | Value                                                                                       |
| ------- | ------------------------------------------------------------------------------------------- |
| Caddy   | `2.11.7` (`CADDY_VERSION` in `private-executor-edge.sh`)                                    |
| Archive | `caddy_2.11.7_linux_amd64.tar.gz`                                                           |
| SHA-256 | `727b91701a392de6ebc5027509f548bf39979e5216340d0faed8fa5e69c84f8b` (`CADDY_ARCHIVE_SHA256`) |

- `apply --caddy-archive PATH` refuses any archive whose SHA-256 differs, extracts only `caddy`, and
  installs it at `/etc/polytronx/edge/bin/caddy-2.11.7` (0755). It refuses to replace a different
  binary there, and it checks `caddy version` before the Caddyfile is rendered.
- The digest was read from GitHub's release-asset metadata; the official checksums file lists
  SHA-512 for the same archive. Before the first apply, the operator checks the downloaded archive
  on the VPS: `sha256sum caddy_2.11.7_linux_amd64.tar.gz` must print the digest above. Verify the
  release signature too, if the host has the tools.
- Moving to another version is a reviewed change to the two constants.

## Trust contract

- The CA is created on the host, as is the server key pair. Keys are `root` `0600`. Generation
  writes straight to disk; nothing is echoed or read back by the scripts. `check` refuses any other
  key mode.
- Only the CA **certificate** leaves the host: `/etc/polytronx/edge-ca/ca.crt` (public, `0644`, in a
  root-only `0700` directory). Copy it to the dashboard host, to the path in
  `POLYTRONX_EXECUTOR_CA_FILE` (the template default is
  `/opt/polytronx/openinspect/trust/executor-edge-ca.crt`, outside the secrets directory), through a
  channel you trust. Compare its fingerprint with the one `apply` prints.
- The control plane trusts it with `NODE_EXTRA_CA_CERTS=/etc/polytronx/executor-ca/ca.crt`, the
  in-container path. Do not set `NODE_TLS_REJECT_UNAUTHORIZED=0`, and do not use an insecure-TLS
  option.
- `compose.production.yml` mounts `POLYTRONX_EXECUTOR_CA_FILE` read-only at that path, in long
  syntax with `create_host_path: false`, so a missing file stops the start instead of creating a
  directory. `preflight.sh` refuses a missing file, a directory, a non-certificate, or any file that
  holds private-key bytes.
- The CA name constraint is the configured executor IPv4 with a `/32` mask (default
  `172.235.26.148/32`). It cannot sign for a changed address. Create fresh TLS material on a new
  host; an existing mismatched certificate is refused.
- The CA directory and the edge directory are disjoint. `render`, `check` and `apply` refuse them
  when they are equal or nested in either direction, and refuse any path not written as its resolved
  form (a symlink, `.`, `..`, a repeated or trailing slash).
- Existing certificates are verified and never replaced. A partial set is refused. Renewal (before
  the 30-day window) is a manual step.

## Apply (operator, as root, on the VPS)

Prerequisites: on a replacement executor, set `POLYTRONX_EXECUTOR_EDGE_ADDRESS` and
`POLYTRONX_DASHBOARD_SOURCE_IPV4` to independently verified unicast IPv4 addresses, and use the same
values for render/check/apply/rollback. Read [executor-rotation.md](executor-rotation.md) before
changing hosts. compose.executor.yml publishes the executor on `127.0.0.1:8787`, UFW is active with
SSH allowed, and the Caddy archive has passed the SHA-256 check above (or a Caddy image is pinned by
digest). Run the sandbox network first: `preflight-executor.sh` requires it before any executor
deploy.

```
cd /opt/polytronx/openinspect
sudo bash deploy/polytronx/sandbox-network.sh apply        # oi-sandbox, owned rules, boot unit, enabled
sudo bash deploy/polytronx/private-executor-edge.sh check  # reports the missing material before the first apply

# Pinned binary, from the archive that passed the SHA-256 check:
sudo bash deploy/polytronx/private-executor-edge.sh apply --caddy-archive /root/caddy_2.11.7_linux_amd64.tar.gz
# Or a digest-pinned container:
sudo bash deploy/polytronx/private-executor-edge.sh apply --proxy container --caddy-image caddy@sha256:<64 hex>
```

`apply` never starts the edge. Start it only after the live checks below pass:

```
sudo systemctl enable --now polytronx-executor-edge.service
```

`check` exits 1 until every blocker is cleared. Use the same proxy option with `check` as with
`apply`.

## Reboot

- `polytronx-sandbox-network.service` (enabled by `sandbox-network.sh apply`) is a oneshot. It runs
  after `docker.service` and `ufw.service`, and before `polytronx-executor-edge.service`. On each
  boot it re-applies the owned chains, the owned jumps and the IPv6 setting on `br-oisandbox`.
- `polytronx-executor-edge.service` (enabled by the operator) starts after `docker.service` and the
  sandbox unit.
- The executor container restarts with Docker (`restart: unless-stopped`). systemd does not hold it
  back, so the sandbox rules are not guaranteed to exist the instant the container starts. The only
  ingress is the edge, which waits for the rules, and the executor's loopback port is reachable only
  by root on the host.
- Workspace slots come back from `/etc/fstab` (`nofail` loop mounts), before Docker starts. See
  [executor-host.md](executor-host.md).
- Container mode (`--proxy container`): before each start the unit removes, and on stop it stops,
  only a container labelled `io.polytronx.owner=private-executor-edge`. A foreign container that
  holds the name is left alone, so the start fails on the name. Check that container, then remove it
  by hand.

## Rollback (operator)

```
sudo bash deploy/polytronx/private-executor-edge.sh rollback   # stops the unit, removes the UFW rule, moves owned config aside; keeps keys and the pinned binary
sudo bash deploy/polytronx/sandbox-network.sh rollback         # disables and moves aside the owned boot unit, removes owned jumps and chains; keeps the network
sudo docker network rm oi-sandbox                              # only when no container is attached
```

Rollback never flushes a built-in or Docker chain, never deletes keys, and never restarts Docker.
After the sandbox rollback, sandboxes are no longer isolated; stop the executor first if policy
requires it.

## Settings the other components need

- Dashboard control plane: `VPS_EXECUTOR_URL=https://172.235.26.148:19443`,
  `POLYTRONX_EXECUTOR_CA_FILE` pointing at the copied `ca.crt`, and
  `NODE_EXTRA_CA_CERTS=/etc/polytronx/executor-ca/ca.crt`, which `compose.production.yml` sets.
  `vps-provider.ts` already requires `https://`.
- `executor-release.env` on the executor host: `VPS_EXECUTOR_CONTROL_PLANE_URL` must name the
  trusted control plane's https URL. It is required by compose and checked by
  `preflight-executor.sh`; a placeholder fails there. The executor is always published on loopback,
  so there is no bind setting.
- Executor sandbox creation (`packages/vps-executor/src/docker.ts`) passes `--network oi-sandbox`,
  so the owned egress rules apply to sandboxes. The live proof below has not run on a Linux host.
- Linode Cloud Firewall, if used: allow `19443/tcp` from `185.252.233.186` only. The host cannot see
  it.

## Live proof (run on the VPS, after apply and before enabling traffic)

```
# 1. Listener only on the edge address; no plaintext or 443 change by this edge
ss -Htlnp 'sport = :19443'
ss -Htlnp 'sport = :80'            # empty, or not caddy

# 2. Firewall: SSH, plus the one edge rule
sudo ufw status numbered

# 3. Owned chains, jumps and the untouched default
sudo iptables -S DOCKER-USER | head -n 3
sudo iptables -S POLYTRONX-SBX-FWD
sudo iptables -S POLYTRONX-SBX-IN
sudo iptables -S INPUT | head -n 3
sudo sysctl net.ipv6.conf.br-oisandbox.disable_ipv6   # 1

# 4. Boot units: enabled, and the sandbox unit ordered first
sudo systemctl is-enabled polytronx-sandbox-network.service
sudo systemctl show -p After -p Before polytronx-sandbox-network.service polytronx-executor-edge.service

# 5. Both checks report no blockers
sudo bash deploy/polytronx/private-executor-edge.sh check
sudo bash deploy/polytronx/sandbox-network.sh check
```

Step 3 must print the rules in the form `iptables -S` prints them: `-p udp -m udp --dport 53`,
`-p tcp -m tcp --dport 53`, `-p tcp -m tcp --dport 443`, and `--ctstate RELATED,ESTABLISHED`.
`sandbox-network.sh check` compares exactly that form. Whether a real host prints it this way is not
proven yet; the first run on the VPS is that proof. A mismatch is a finding to report, not a reason
to loosen the check.

After a reboot, repeat steps 2 to 5 without running `apply`. Step 3 must show the owned chains
before any sandbox is created.

From the dashboard host (`185.252.233.186`), with the copied CA:

```
curl --cacert /opt/polytronx/openinspect/trust/executor-edge-ca.crt https://172.235.26.148:19443/v1/health   # 200 {"ok":true}
```

From any other host, and over plaintext, the edge must not answer:

```
curl -m 5 https://172.235.26.148:19443/v1/health          # refused or timeout
curl -m 5 http://172.235.26.148:19443/                    # refused or timeout
```

Sandbox egress, from a sandbox on `oi-sandbox` or from a test container on it (operator go-ahead;
the image must be digest-pinned):

```
docker run --rm --network oi-sandbox <sandbox image@sha256:...> sh -c 'wget -qO- -T 5 http://169.254.169.254/ ; echo "metadata=$?"'
docker run --rm --network oi-sandbox <sandbox image@sha256:...> sh -c 'wget -qO- -T 5 https://172.235.26.148:19443/v1/health ; echo "edge=$?"'
docker run --rm --network oi-sandbox <sandbox image@sha256:...> sh -c 'wget -qO- -T 5 https://example.com >/dev/null ; echo "public_https=$?"'
```

Expected: `metadata` and `edge` non-zero, `public_https` zero. DNS must also resolve from inside
(`nslookup example.com`), since INPUT drops host-directed traffic from the bridge except replies.

## Risks and open items

- Caddy directives (`persist_config`, `remote_ip`, `protocols`, `bind`) were written against Caddy
  v2 documentation and not run here. `apply` runs `caddy validate` on the installed binary and
  refuses on failure. This is the explicit Linux gate, and it runs only on the VPS.
- The executor container is started by Docker, not by systemd (see Reboot). The oneshot is ordered
  before the edge, not before the container.
- `docker.ts` attaches sandboxes to `oi-sandbox`, but the egress rules are unproven until the live
  proof above passes on the executor host.
- The control-plane mount is in `compose.production.yml`. The render gate and preflight check it; no
  live host has run it.
- `executor-deployment.md` item 3 names `19443`, the port this edge uses. `443` stays with other
  websites, so this edge never uses it.
- The binary-mode Caddy runs as `root` (`User=root`) to read `server.key`. The upgrade is
  `DynamicUser=yes` with `LoadCredential=`, and the Caddyfile reads the credentials directory. That
  changes the unit, the key paths and the key checks together, and nothing here has run on Linux. It
  stays explicit debt, marked by a `ponytail:` note in `private-executor-edge.sh`.
- Linux proof still pending, all on the VPS and none run here: `iptables -S` printing the owned
  chains in the form `check` expects; the Caddy TLS handshake with no SNI (curl and Node); loop
  mounts ordered before Docker; the boot unit restoring the rules after a reboot; the container-mode
  unit under `ProtectSystem=strict`. The tests use stubs only and run no host command for real.
- The Caddy version and digest were read from GitHub release metadata, not by downloading the
  archive in this change. The operator's SHA-256 check is the verification.
