# VPS executor host

The executor is the sandbox service of the VPS provider. The dashboard host (185.252.233.186) runs
the control plane, which calls the executor with a bearer token. The executor host (172.235.26.148)
runs the executor, and the sandboxes it starts under gVisor (`runsc`).

Nothing in this runbook has been run against either host. Each step is for the operator, in order.

## What the repository provides

| Asset                                         | Role                                                                                                                                                                                                     |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/vps-executor/Dockerfile`            | Executor image. Node 24 base pinned by digest, the same value as `NODE_IMAGE` in `pins.env`. Non-root `node` user. Docker CLI.                                                                           |
| `deploy/polytronx/compose.executor.yml`       | One service. Port published on `127.0.0.1:8787` only. Six fixed workspace slots, state in `executor-state.db`, required trusted control-plane URL. Read-only root, all capabilities dropped, limits set. |
| `deploy/polytronx/sandbox-network.sh`         | `oi-sandbox`, owned iptables chains, and the owned boot unit `polytronx-sandbox-network.service`. See step 8 below.                                                                                      |
| `deploy/polytronx/private-executor-edge.sh`   | Private HTTPS edge to the executor, pinned Caddy. See [private-edge.md](private-edge.md).                                                                                                                |
| `deploy/polytronx/preflight-executor.sh`      | Read-only checks, run as root. Each line is PASS, WARN or FAIL.                                                                                                                                          |
| `deploy/polytronx/workspace-slots.sh`         | One-time host setup of the six workspace slots (`--apply`, as root). `--check` is read-only and runs inside preflight.                                                                                   |
| `deploy/polytronx/deploy-executor.sh`         | Loads `executor.tar`, runs preflight, brings the project up, keeps `last-good.env`.                                                                                                                      |
| `.github/workflows/polytronx-openinspect.yml` | `vps-executor` job: typecheck, executor tests, admission tests. `images` job builds, smoke-tests and exports `executor.tar`.                                                                             |

## Constraints the deployment enforces

- Sandboxes run under `runsc`. `/v1/health` answers 503 when `runsc` is not registered, and
  preflight fails.
- Sandboxes never receive the Docker socket. Each sandbox mounts only its own workspace slot, at
  `/workspace`, and publishes no port.
- Each sandbox gets `EXECUTOR_SANDBOX_CPUS` and `EXECUTOR_SANDBOX_MEMORY`, with no swap. The
  executor service has its own CPU and memory limits.
- Only the executor container mounts `/var/run/docker.sock`. That socket is root-equivalent on the
  host.
- The executor port is published on loopback only. The dashboard host reaches it through the private
  HTTPS edge, which admits that one source ([private-edge.md](private-edge.md)).
- Executor state is one SQLite file, `executor-state.db`, in the `executor-state` volume. Nothing
  evicts workspace data automatically; the reset TTL was removed.

## 1. Host prerequisites (manual)

1. Docker Engine is running, and `docker info` works for the operator.
2. gVisor: install `runsc` and register it with Docker as the `runsc` runtime, following gVisor's
   Docker setup. Then `docker info -f '{{json .Runtimes}}'` must list `runsc`.
3. Firewall. The executor is published on `127.0.0.1:8787` only, so Docker's rule bypass does not
   expose it, and no `DOCKER-USER` rule is needed for it. The dashboard host reaches it through the
   private HTTPS edge, which UFW admits from `185.252.233.186` alone. Enable UFW with SSH allowed by
   port (`sudo ufw allow 22/tcp`) before the edge is applied ([private-edge.md](private-edge.md)).
   The edge check requires `Default: deny (incoming)` and reads every rule: an all-port rule, or an
   application profile name such as `OpenSSH`, is a blocker, so write ports by number.
4. Secrets directory, owner only:
   ```
   sudo install -d -m 700 /opt/polytronx/executor/secrets
   ```
5. Create `/opt/polytronx/executor/secrets/executor.env` with mode 600. It holds two lines,
   `VPS_EXECUTOR_TOKEN=` and `VPS_EXECUTOR_ADMISSION_SECRET=`, each followed by 32 or more
   characters. For example, `openssl rand -hex 32` written straight into the file, so the values are
   never echoed. Give the token to the dashboard host's control-plane secrets as
   `VPS_EXECUTOR_TOKEN`, and the admission secret as `VPS_EXECUTOR_ADMISSION_SECRET`, through a
   secure channel. Never put either in git, in chat, or in `executor-release.env`.
6. Sandbox image. Choose the image the sandboxes run, and pull it by digest on this host with
   `docker pull <name>@sha256:<digest>`. Preflight refuses an image without a digest, or one that is
   not on the host.
7. Workspace slots, once, as root. Each sandbox's `/workspace` is one of six 10 GiB ext4 images,
   each mounted at `/srv/vps-ws/slots/<k>`. On a new host the first check shows FAIL lines; that is
   expected.

   ```
   sudo bash deploy/polytronx/workspace-slots.sh --check
   sudo bash deploy/polytronx/workspace-slots.sh --apply
   sudo bash deploy/polytronx/workspace-slots.sh --check
   ```

   `--apply` judges every slot before it changes an image or an fstab line. Then it:
   - creates each `/srv/vps-ws/images/slot-<k>.img` with `fallocate -l 10G` (root, mode 600). That
     reserves 60 GiB, and it refuses unless 30 GiB stay free afterwards;
   - formats a new image only, with `mkfs.ext4 -F -m 0 -N 262144 -E root_owner=1000:1000`;
   - backs up `/etc/fstab`, then appends one line per slot:
     `<image> /srv/vps-ws/slots/<k> ext4 loop,nosuid,nodev,noatime,nofail,x-systemd.before=docker.service 0 0`.
     No other line changes;
   - mounts each slot by its own path, never with `mount -a`, then sets its root to 1000:1000,
     mode 700.

   It never formats, overwrites or removes an existing image or file. An image that is not ext4, a
   mount that is not the expected one, or a directory with content stops the run with a FAIL line.

   Boot order: each slot line carries `x-systemd.before=docker.service`, so systemd mounts the slot
   before it starts Docker. `nofail` still applies: a slot that fails to mount does not stop the
   boot, and it stays root 0700, so the executor refuses it with `workspace_unavailable`. The
   executor binds `/srv/vps-ws/slots` when its container starts, so a slot mounted later is
   invisible to it; after a slot is mounted by hand, restart the executor. Docker's unit is not
   changed: no drop-in and no restart. The reboot proof is in section 3 and has not been run. fsck
   never runs at boot (pass 0). To check an image, unmount its slot first, then run
   `sudo e2fsck -n <image>`, which only reads.

8. Sandbox network, as root, before the first executor deploy. Preflight requires it:
   ```
   sudo bash deploy/polytronx/sandbox-network.sh apply
   sudo bash deploy/polytronx/sandbox-network.sh check
   ```
   `apply` creates `oi-sandbox`, the two owned iptables chains and their jumps, and enables
   `polytronx-sandbox-network.service`. It also writes `/etc/polytronx/sandbox-resolv.conf`
   (1.1.1.1 and 9.9.9.9), which the executor bind-mounts read-only over every sandbox's
   `/etc/resolv.conf`, because runsc cannot reach Docker's embedded resolver. That unit runs
   `restore` on every boot, after Docker and UFW: it re-applies the rules, the IPv6 setting and
   the resolver file, and writes and enables nothing else. It needs Docker's `DOCKER-USER`
   chain, so Docker must run with iptables enabled.

## 2. Release

1. Download the `polytronx-release` artifact from the CI run. Copy `executor.tar` and `SHA256SUMS`
   into `/opt/polytronx/executor/archives/`, using the transfer method the operator uses for the
   dashboard release.
2. Write `/opt/polytronx/executor/executor-release.env`:
   ```
   EXECUTOR_IMAGE=open-inspect-vps-executor:<OVERLAY_REVISION from the manifest>
   EXECUTOR_IMAGE_ID=<EXECUTOR_IMAGE_ID from the manifest>
   POLYTRONX_SECRETS_DIR=/opt/polytronx/executor/secrets
   VPS_EXECUTOR_CONTROL_PLANE_URL=<the trusted control plane's https URL>
   EXECUTOR_SANDBOX_IMAGE=<name>@sha256:<digest from step 1.6>
   EXECUTOR_SANDBOX_CPUS=2
   EXECUTOR_SANDBOX_MEMORY=4g
   EXECUTOR_MAX_ACTIVE_SANDBOXES=<sandboxes the control plane admits to this executor at once>
   ```
   There is no bind setting: compose publishes the executor on `127.0.0.1:8787` only. The
   control-plane URL is required. Preflight fails on the placeholder and on anything that is not
   `https://`, and the executor refuses to start without it, so take it from the dashboard host's
   reviewed configuration rather than guessing. The six workspace slots and the executor state file
   are fixed in `compose.executor.yml`. Optional: `EXECUTOR_CPUS` (default 1) and
   `EXECUTOR_MEM_LIMIT` (default 512m) limit the executor service itself.
3. Preflight, alone, as root:
   ```
   sudo bash deploy/polytronx/preflight-executor.sh --release /opt/polytronx/executor/executor-release.env --secrets-dir /opt/polytronx/executor/secrets
   ```
   Every line must be PASS. WARN lines need a decision. Any FAIL stops the deploy.
4. Deploy, as root:
   ```
   sudo bash deploy/polytronx/deploy-executor.sh --release /opt/polytronx/executor/executor-release.env --secrets-dir /opt/polytronx/executor/secrets --state-dir /opt/polytronx/executor/state --image-archive /opt/polytronx/executor/archives --confirm polytronx-executor
   ```
   A successful run ends with `deploy ok` in `/opt/polytronx/executor/state/deploy-log.txt`, after
   the container's health check passes.

The scripts are run with `bash`, so they do not depend on the file mode that git records.

## 3. Verify

Automatic at deploy: preflight, `docker compose up --wait` (the healthcheck calls `/v1/health`
inside the container), and `last-good.env`.

Manual, from the dashboard host, once the control plane's `VPS_EXECUTOR_URL` is the https address of
the executor (open item 1). Operator-run. Create a sandbox only with the operator's go-ahead.

1. `curl -sS https://<executor-url>/v1/health` returns 200 and `{"ok":true}`. The same request from
   any other host is refused or times out.
2. `POST /v1/sandboxes` without the bearer token returns 401. With the token but no
   `admissionLease`, it returns 403 `admission_missing`.
3. With a lease from the control plane, `POST /v1/sandboxes` returns 201 with `providerObjectId`. On
   the executor host, `docker inspect` of that container shows `HostConfig.Runtime` as `runsc`,
   `NanoCpus` as `2000000000` for 2 CPUs, `Memory` as `4294967296` for 4g, no Docker socket in
   `Mounts`, and no entries in `NetworkSettings.Ports`.
4. `POST /v1/sandboxes/<providerObjectId>/stop` returns 200 with `{"stopped":true}`, and the
   container is gone.
5. Restart the executor with `docker compose -p polytronx-executor restart vps-executor`.
   `GET /v1/sandboxes/<sandboxId>` for a live sandbox still returns 200, which shows the state file
   survived.
6. Capacity: run `EXECUTOR_MAX_ACTIVE_SANDBOXES` sandboxes at once and watch
   `docker stats --no-stream`. Memory use stays under the host's total minus 1 GiB.

Workspace slots, on the host. Each command is read-only:

- `sudo bash deploy/polytronx/workspace-slots.sh --check` prints six PASS lines and exits 0.
- `sudo bash deploy/polytronx/sandbox-network.sh check` prints `sandbox-network: no blockers`. Run
  it again after a reboot, without `apply`, to confirm the boot unit restored the rules.
- `findmnt -no TARGET,FSTYPE,OPTIONS /srv/vps-ws/slots/0` shows `ext4`, with `nosuid,nodev,noatime`
  in the options.
- `stat -f -c %t /srv/vps-ws/slots/0` prints `ef53`, and `stat -c '%u:%g %a' /srv/vps-ws/slots/0`
  prints `1000:1000 700`.
- `stat -c '%u:%g %n' /srv/vps-ws/slots/0/*` shows `1000:1000` for every entry a sandbox wrote
  (gofer ownership).

Reboot proof, operator, not yet run. Reboot the executor host, then, read-only:

- `systemctl show -p After -- docker.service` lists `srv-vps\x2dws-slots-0.mount` and the other five
  slot mounts (`systemd-escape -p --suffix=mount /srv/vps-ws/slots/<k>` gives each name).
- `sudo bash deploy/polytronx/workspace-slots.sh --check` prints six PASS lines, before anyone
  restarts the executor.
- `sudo bash deploy/polytronx/sandbox-network.sh check` prints `sandbox-network: no blockers`.

Edge gate, operator, not yet run. From the dashboard host, with the CA copy at the path
`POLYTRONX_EXECUTOR_CA_FILE` names:

- `curl -sS --cacert <that CA file> https://172.235.26.148:19443/v1/health` returns 200
  `{"ok":true}`. curl sends no SNI for an IP literal, so this exercises `default_sni`.
- The same handshake from Node:
  `NODE_EXTRA_CA_CERTS=<that CA file> node -e "fetch('https://172.235.26.148:19443/v1/health').then((r) => console.log(r.status))"`
  prints `200`.

Destructive checks, on a test host or with the operator's go-ahead to create a sandbox:

- Disk full: in a sandbox, `head -c 12G /dev/zero > /workspace/fill` fails with ENOSPC, and
  `df -B1 /` on the host does not move.
- Persistence: write a marker in `/workspace`, `docker rm -f` the sandbox, restart the executor,
  re-create the same ids. The marker is still there.
- Symlink: in a sandbox, `ln -s /etc/hostname /workspace/l`, then a reset. `/etc/hostname` is intact
  and the slot no longer has `l`.
- Fail closed: `sudo umount /srv/vps-ws/slots/0` leaves the directory `0:0 700`. A sandbox create
  then returns 503 `workspace_unavailable`. Mount the slot again and restart the executor.

## 4. Rollback and stop

- Back to the last release that came up healthy: run `deploy-executor.sh` with
  `--release /opt/polytronx/executor/state/last-good.env`, the same `--state-dir`, and no
  `--image-archive`. The earlier image must still be on the host. These scripts never prune images.
- A `last-good.env` written before `VPS_EXECUTOR_CONTROL_PLANE_URL` was required has no such line.
  Preflight and compose refuse it, which is deliberate. Before rolling back to it, add
  `VPS_EXECUTOR_CONTROL_PLANE_URL=<the same https URL the dashboard host uses>` to that file.
  `EXECUTOR_BIND_ADDRESS` from older releases is no longer read, so it can stay or go.
- Stop the executor with `docker compose -p polytronx-executor down`. Never add `-v`, which would
  remove the state volume and the record of sandboxes.
- Stopping the executor does not stop its sandboxes. List them with
  `docker ps --filter label=open-inspect.managed=vps-executor`. Stop them through the control plane
  first. Nothing reconciles a sandbox that was removed by hand (see gaps).
- Workspace slots: stop the executor, and the sandboxes through the control plane. Then
  `docker ps -a --filter label=open-inspect.managed=vps-executor` must list nothing. Unmount each
  slot with `sudo umount /srv/vps-ws/slots/<k>`, never `-l`: umount fails while a container still
  uses the slot, and that failure is the protection. Unmounting keeps the image and its data.
  Restore `/etc/fstab` from the `/etc/fstab.polytronx-workspace-*.bak` that `--apply` wrote, or
  delete the six lines. No script deletes an image. Deleting one destroys that slot's data, so that
  is the operator's call.

## 5. Open items before live use

Blockers:

1. **HTTPS.** The control plane refuses a `VPS_EXECUTOR_URL` that is not `https://`
   (`createVpsProvider` in `packages/control-plane/src/sandbox/providers/vps-provider.ts`). The
   private edge provides it: TLS on `172.235.26.148:19443`, one source, loopback upstream. Its
   assets are written and tested, not applied. Apply and the live checks are in
   [private-edge.md](private-edge.md). The control plane mounts the public CA through
   `compose.production.yml` (`POLYTRONX_EXECUTOR_CA_FILE`) and names it with `NODE_EXTRA_CA_CERTS`.
   The CA certificate lives in `/etc/polytronx/edge-ca/ca.crt` on this host (public, 0644, in a
   root-only 0700 directory beside the key). Copy `ca.crt` to
   `/opt/polytronx/openinspect/trust/executor-edge-ca.crt` on the dashboard host with mode 0644.
   Preflight refuses any other mode, because the container reads the file as uid 1000, and root's
   read check would not show that.
2. **Sandbox image.** This change builds no sandbox image. Choose and pin one before step 2.
3. **Lockfile.** `package-lock.json` has no `packages/vps-executor` entry. Run
   `npm install --package-lock-only` and commit the lock before the first CI run. I did not run
   `npm ci`, so the failure is expected, not observed.
4. **Overlay allowlist.** The release workflow's overlay check refuses committed changes to upstream
   paths. The control-plane shutdown files, the sandbox image and runtime files, and
   `.github/workflows/sandbox-images.yml` are listed by exact path. The root notes
   `DEPLOY-SHELL-DIAG.md` and `VPS-IMAGE-LINUX-BUILD.md` are in ignored bookkeeping and are not
   admitted.

Gaps, not blockers:

- The admission lease is checked for shape and expiry only. It is not verified against the control
  plane and is not consumed, so a captured lease replays until it expires
  (`packages/vps-executor/src/admission.ts`).
- The executor does not cap concurrent sandboxes. The control plane must.
- Reconcile runs at startup and every 30 seconds. It frees the slot of a container that is gone, and
  adopts containers by their slot label. A container with no valid slot label keeps running and is
  not accounted for (`packages/vps-executor/src/server.ts`).
- The image installs `docker.io` for its CLI, which pulls in engine packages as dependencies. The
  version is not pinned. A CLI-only pin is a follow-up.
- Sandboxes leave through the owned egress rules in `sandbox-network.sh`. `docker.ts` attaches them
  to `oi-sandbox`. The live egress proof in private-edge.md has not run on a Linux host.
- The executor container is started by Docker (`restart: unless-stopped`), not by systemd. The
  sandbox rules are ordered before the edge, which is the only ingress, not before the container.
- `private-executor-edge.test.mjs` covers both edge and sandbox-network scripts with stubs. Nothing
  it runs touches iptables, UFW, Docker, systemd or Caddy for real.
