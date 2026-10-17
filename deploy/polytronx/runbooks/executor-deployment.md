# Executor deployment: remaining steps

The order of work for the VPS executor on the executor host, the CI gates that cover it, and what is
still open. Commands and file formats are in [executor-host.md](executor-host.md). Nothing here has
been run against a host. CI starts no sandbox.

## What the repository provides

- `packages/vps-executor/Dockerfile`: Node 24 base pinned by digest, the same value as `NODE_IMAGE`
  in `pins.env`. Runs as `node`. Docker CLI only. No socket or secret in the image.
- `compose.executor.yml`: one service. Only this service mounts the Docker socket. It binds the
  workspace slot root, `/srv/vps-ws/slots`, at the same path. The port is published on
  `127.0.0.1:8787` only. Six slots, the state file `executor-state.db` and the required
  `VPS_EXECUTOR_CONTROL_PLANE_URL` are fixed in the file; there is no workspace TTL. Read-only root
  filesystem, all capabilities dropped, `no-new-privileges`, CPU and memory limits (defaults 1 CPU
  and 512m, overridable). Secrets come from `executor.env` through `env_file`.
- Sandboxes (`docker.ts`): `--runtime runsc`, `--cpus` and `--memory` from the release file, swap
  equal to memory, 512 pids, one bind mount (the sandbox's workspace slot at `/workspace`), no
  published ports, no socket.
- `workspace-slots.sh`: one-time host setup of the six workspace slots as root. Its `--check` is
  read-only and runs inside preflight.
- `preflight-executor.sh` (read-only) and `deploy-executor.sh` (refuses without
  `--confirm polytronx-executor`).
- CI, `.github/workflows/polytronx-openinspect.yml`:
  - `verify`: pin and overlay check, `bash -n` on `deploy/polytronx/*.sh`, deployment guard tests.
  - `vps-executor`: Dockerfile `NODE_IMAGE` matches `pins.env`, executor typecheck and tests,
    control-plane admission and VPS-provider tests (fakes only).
  - `compose-render`: renders the executor with placeholders, checks the loopback port, six slots,
    the state file, the control-plane URL, user, read-only root, capabilities and limits, and fails
    closed without `VPS_EXECUTOR_CONTROL_PLANE_URL`.
  - `images`: builds the executor image, runs it with no runtime and expects 503, exports
    `executor.tar`.

## Before the first CI run

1. **`package-lock.json` has no `packages/vps-executor` entry.** The root workspace is `packages/*`,
   so `npm ci` fails in every job that runs it. Run `npm install --package-lock-only` and commit the
   lock.
2. **Overlay allowlist.** The `verify` job refuses committed changes outside its allowlist. The
   control-plane files, the sandbox image and runtime files, and
   `.github/workflows/sandbox-images.yml` are listed by exact path. The root notes
   `DEPLOY-SHELL-DIAG.md` and `VPS-IMAGE-LINUX-BUILD.md` are in ignored bookkeeping and are not
   admitted.

## Before live use

3. **HTTPS is provided by the private edge, not yet applied.** The control plane refuses a
   `VPS_EXECUTOR_URL` that is not `https://`
   (`packages/control-plane/src/sandbox/providers/vps-provider.ts`). `private-executor-edge.sh`
   serves `https://172.235.26.148:19443`, admits only `185.252.233.186`, and forwards to
   `127.0.0.1:8787` through the pinned Caddy 2.11.7 archive. `compose.production.yml` mounts the
   public `ca.crt` read-only from `POLYTRONX_EXECUTOR_CA_FILE` (default
   `/opt/polytronx/openinspect/trust/executor-edge-ca.crt`, mode 0644) and names it with
   `NODE_EXTRA_CA_CERTS`. `preflight.sh` checks the file, including that it is world-readable,
   before deploy. Live steps: [private-edge.md](private-edge.md).

   Until the edge is up and checked, do not point the control plane at the executor.

4. **Sandbox image.** Choose one and pin it by digest. Pull it on the executor host. Preflight
   refuses a tag-only or missing image. This change builds none.

## Host steps (operator, as root)

5. Docker Engine is running and `docker info` works. Install `runsc` and register it with Docker as
   `runsc`, following gVisor's Docker setup. `docker info -f '{{json .Runtimes}}'` must list
   `runsc`.
6. Firewall and boot. The executor is loopback-only, so no `DOCKER-USER` rule is needed. Enable UFW
   with SSH allowed by port (`ufw allow 22/tcp`), apply the edge (`private-executor-edge.sh apply`),
   and apply the sandbox network (`sandbox-network.sh apply`). The sandbox apply enables
   `polytronx-sandbox-network.service`, whose `restore` command restores the owned rules after every
   reboot, ordered after Docker and UFW.
7. `/opt/polytronx/executor/secrets` is mode 700. `executor.env` is mode 600, LF line endings, with
   both lines. Write the values straight into the file with `openssl rand -hex 32`, so they are
   never echoed:

   ```
   VPS_EXECUTOR_TOKEN=<32+ characters>
   VPS_EXECUTOR_ADMISSION_SECRET=<32+ characters>
   ```

   The executor refuses to start without both. The dashboard host's control plane needs the same two
   values, as `VPS_EXECUTOR_TOKEN` and `VPS_EXECUTOR_ADMISSION_SECRET`, plus
   `VPS_EXECUTOR_URL=https://172.235.26.148:19443`. Send them over a secure channel. Neither value
   goes in git, chat, or `executor-release.env`.

   Workspace slots, once, before preflight: `sudo bash deploy/polytronx/workspace-slots.sh --check`,
   then `--apply`, then `--check` again. The steps, the boot order and the rollback are in
   [executor-host.md](executor-host.md), section 1, step 7.

## Release (operator)

8. Copy `executor.tar` and `SHA256SUMS` from the `polytronx-release` artifact into
   `/opt/polytronx/executor/archives/`.
9. Write `executor-release.env` (keys in [executor-host.md](executor-host.md) §2). Preflight
   requires `EXECUTOR_IMAGE`, `EXECUTOR_IMAGE_ID`, `VPS_EXECUTOR_CONTROL_PLANE_URL` (https),
   `EXECUTOR_SANDBOX_IMAGE`, `EXECUTOR_SANDBOX_CPUS`, `EXECUTOR_SANDBOX_MEMORY`,
   `EXECUTOR_MAX_ACTIVE_SANDBOXES` and `POLYTRONX_SECRETS_DIR`. It also requires the sandbox network
   check to pass. Do not set `DOCKER_GID`; the scripts export it.
10. Preflight:
    `sudo bash deploy/polytronx/preflight-executor.sh --release <file> --secrets-dir <dir>`. Every
    line must be PASS. Resolve each WARN. Any FAIL stops the deploy.
11. Deploy:
    `sudo bash deploy/polytronx/deploy-executor.sh --release <file> --secrets-dir <dir> --state-dir <dir> --image-archive <dir> --confirm polytronx-executor`.
    Success is a `deploy ok` line in `<state-dir>/deploy-log.txt`.

## Live acceptance (operator; create a sandbox only with the operator's go-ahead)

12. `GET https://<proxy>/v1/health` returns 200 `{"ok":true}`. The same request from another host is
    refused or times out. With a loopback bind, `GET http://<executor address>:8787/v1/health` from
    the dashboard host fails.
13. `POST /v1/sandboxes` with no bearer token returns 401 `{"error":"unauthorized"}`. With the token
    and no `admissionLease` it returns 403 `{"error":"admission_missing"}`.
14. With a lease the control plane issued for this `sandboxId` and `sessionId`, `POST /v1/sandboxes`
    returns 201 `{"providerObjectId":"…"}`. Then `docker inspect <id>` must show
    `HostConfig.Runtime` = `runsc`, `NanoCpus` = `2000000000` (2 CPUs), `Memory` = `4294967296`
    (4g), `MemorySwap` = `Memory`, `PidsLimit` = `512`, no `docker.sock` in `Mounts`, the slot as
    the only `/workspace` mount, and no entries in `NetworkSettings.Ports`.
15. `POST /v1/sandboxes/<providerObjectId>/stop` with body `{"reason":"acceptance"}` returns 200
    `{"stopped":true}`. The container is gone. The request needs the JSON body;
    [executor-host.md](executor-host.md) §3 omits it.
16. `docker compose -p polytronx-executor restart vps-executor`, then
    `GET /v1/sandboxes/<sandboxId>` returns 200 for a sandbox that is still running. This shows the
    state file survived.
17. Capacity: start `EXECUTOR_MAX_ACTIVE_SANDBOXES` sandboxes at once. `docker stats --no-stream`
    shows memory under the host total minus 1 GiB.

## Rollback and stop

18. Last healthy release:
    `deploy-executor.sh --release <state-dir>/last-good.env --secrets-dir <dir> --state-dir <dir> --confirm polytronx-executor`,
    without `--image-archive`. The earlier image must still be on the host.
19. Stop: `docker compose -p polytronx-executor down`. Never add `-v`. Stopping the executor does
    not stop its sandboxes. Stop those through the control plane first.

## Open, not blocking

- Capacity arithmetic runs only in preflight, on the host. CI tests admission and the provider, not
  the memory and CPU headroom.
- Admission leases are checked for shape, signature and expiry. They are not checked against the
  control plane and not consumed, so a captured lease replays until it expires (`admission.ts`).
- The executor does not cap concurrent sandboxes, and a container with no valid slot label keeps
  running, unaccounted for, after a restart (`server.ts`).
- The image installs `docker.io`, which brings engine packages in as dependencies. A CLI-only
  package pin is a follow-up.
- Sandbox egress is limited by the owned rules in `sandbox-network.sh`, and `docker.ts` attaches
  sandboxes to `oi-sandbox`. The live egress proof (runbooks/private-edge.md) has not run on a Linux
  host.
- `deploy-executor.sh` and `preflight-executor.sh` have no direct test. `workspace-slots.test.mjs`
  checks that preflight runs the slot and sandbox-network checks.
