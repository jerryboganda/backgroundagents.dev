# Executor deployment: remaining steps

The order of work for the VPS executor on the executor host, the CI gates that cover it, and what is still open. Commands and file formats are in [executor-host.md](executor-host.md). Nothing here has been run against a host. CI starts no sandbox.

## What the repository provides

- `packages/vps-executor/Dockerfile`: Node 24 base pinned by digest, the same value as `NODE_IMAGE` in `pins.env`. Runs as `node`. Docker CLI only. No socket or secret in the image.
- `compose.executor.yml`: one service. Only this service mounts the Docker socket. The port is published on `EXECUTOR_BIND_ADDRESS` only. Read-only root filesystem, all capabilities dropped, `no-new-privileges`, CPU and memory limits (defaults 1 CPU and 512m, overridable). Secrets come from `executor.env` through `env_file`.
- Sandboxes (`docker.ts`): `--runtime runsc`, `--cpus` and `--memory` from the release file, swap equal to memory, 512 pids, no mounts, no published ports, no socket.
- `preflight-executor.sh` (read-only) and `deploy-executor.sh` (refuses without `--confirm polytronx-executor`).
- CI, `.github/workflows/polytronx-openinspect.yml`:
  - `verify`: pin and overlay check, `bash -n` on `deploy/polytronx/*.sh`, deployment guard tests.
  - `vps-executor`: Dockerfile `NODE_IMAGE` matches `pins.env`, executor typecheck and tests, control-plane admission and VPS-provider tests (fakes only).
  - `compose-render`: renders the executor with placeholders, checks port, user, read-only root, capabilities and limits, and fails closed without `EXECUTOR_BIND_ADDRESS`.
  - `images`: builds the executor image, runs it with no runtime and expects 503, exports `executor.tar`.

## Before the first CI run

1. **`package-lock.json` has no `packages/vps-executor` entry.** The root workspace is `packages/*`, so `npm ci` fails in every job that runs it. Run `npm install --package-lock-only` and commit the lock.
2. **Overlay allowlist.** The `verify` job refuses committed changes outside its allowlist, which covers `deploy/polytronx/`, the workflow, `packages/web/Dockerfile`, `packages/vps-executor/`, and a few bootstrap and modal-infra files. Working-tree changes to control-plane, shared, `.env.example`, `docs/CONTROL_PLANE_CONTAINER.md` and the D1 migration are not covered. Move them under allowed paths, or extend the allowlist in a reviewed change.

## Before live use

3. **HTTPS is not met by the repository.** The control plane refuses a `VPS_EXECUTOR_URL` that is not `https://` (`packages/control-plane/src/sandbox/providers/vps-provider.ts:209-210`). The executor serves plain HTTP. Add a TLS terminator on the executor host:
   - Choose the proxy and pin its image by digest. Nothing in the repository adds it.
   - Decide the certificate source. A private CA must also be trusted by the dashboard host's control plane (Node: `NODE_EXTRA_CA_CERTS`).
   - Forward to `127.0.0.1:8787`, and set `EXECUTOR_BIND_ADDRESS=127.0.0.1`.
   - Restrict 443 to the dashboard host. Use `DOCKER-USER` if the proxy is a published container port, or an INPUT rule if it runs on the host, because `DOCKER-USER` does not see host-local traffic. Preflight checks port 8787 only.

   Until this is done, do not point the control plane at the executor.
4. **Sandbox image.** Choose one and pin it by digest. Pull it on the executor host. Preflight refuses a tag-only or missing image. This change builds none.

## Host steps (operator, as root)

5. Docker Engine is running and `docker info` works. Install `runsc` and register it with Docker as `runsc`, following gVisor's Docker setup. `docker info -f '{{json .Runtimes}}'` must list `runsc`.
6. Firewall. Needed only when `EXECUTOR_BIND_ADDRESS` is not `127.0.0.1`: `DOCKER-USER` accepts 8787 from the dashboard address before the DROP rule, and the rules persist across reboots. A non-loopback bind leaves plain HTTP reachable from the dashboard host, so prefer `127.0.0.1` once item 3 is in place.
7. `/opt/polytronx/executor/secrets` is mode 700. `executor.env` is mode 600, LF line endings, with both lines. Write the values straight into the file with `openssl rand -hex 32`, so they are never echoed:
   ```
   VPS_EXECUTOR_TOKEN=<32+ characters>
   VPS_EXECUTOR_ADMISSION_SECRET=<32+ characters>
   ```
   The executor refuses to start without both. The dashboard host's control plane needs the same two values, as `VPS_EXECUTOR_TOKEN` and `VPS_EXECUTOR_ADMISSION_SECRET`, plus `VPS_EXECUTOR_URL=https://<proxy address>`. Send them over a secure channel. Neither value goes in git, chat, or `executor-release.env`.

## Release (operator)

8. Copy `executor.tar` and `SHA256SUMS` from the `polytronx-release` artifact into `/opt/polytronx/executor/archives/`.
9. Write `executor-release.env` (keys in [executor-host.md](executor-host.md) §2). Preflight requires `EXECUTOR_IMAGE`, `EXECUTOR_IMAGE_ID`, `EXECUTOR_BIND_ADDRESS`, `EXECUTOR_SANDBOX_IMAGE`, `EXECUTOR_SANDBOX_CPUS`, `EXECUTOR_SANDBOX_MEMORY`, `EXECUTOR_MAX_ACTIVE_SANDBOXES` and `POLYTRONX_SECRETS_DIR`. It also requires `EXECUTOR_ALLOWED_SOURCE` unless the bind is `127.0.0.1`. Do not set `DOCKER_GID`; the scripts export it.
10. Preflight: `sudo bash deploy/polytronx/preflight-executor.sh --release <file> --secrets-dir <dir>`. Every line must be PASS. Resolve each WARN. Any FAIL stops the deploy.
11. Deploy: `sudo bash deploy/polytronx/deploy-executor.sh --release <file> --secrets-dir <dir> --state-dir <dir> --image-archive <dir> --confirm polytronx-executor`. Success is a `deploy ok` line in `<state-dir>/deploy-log.txt`.

## Live acceptance (operator; create a sandbox only with the operator's go-ahead)

12. `GET https://<proxy>/v1/health` returns 200 `{"ok":true}`. The same request from another host is refused or times out. With a loopback bind, `GET http://<executor address>:8787/v1/health` from the dashboard host fails.
13. `POST /v1/sandboxes` with no bearer token returns 401 `{"error":"unauthorized"}`. With the token and no `admissionLease` it returns 403 `{"error":"admission_missing"}`.
14. With a lease the control plane issued for this `sandboxId` and `sessionId`, `POST /v1/sandboxes` returns 201 `{"providerObjectId":"…"}`. Then `docker inspect <id>` must show `HostConfig.Runtime` = `runsc`, `NanoCpus` = `2000000000` (2 CPUs), `Memory` = `4294967296` (4g), `MemorySwap` = `Memory`, `PidsLimit` = `512`, no `docker.sock` in `Mounts`, and no entries in `NetworkSettings.Ports`.
15. `POST /v1/sandboxes/<providerObjectId>/stop` with body `{"reason":"acceptance"}` returns 200 `{"stopped":true}`. The container is gone. The request needs the JSON body; [executor-host.md](executor-host.md) §3 omits it.
16. `docker compose -p polytronx-executor restart vps-executor`, then `GET /v1/sandboxes/<sandboxId>` returns 200 for a sandbox that is still running. This shows the state file survived.
17. Capacity: start `EXECUTOR_MAX_ACTIVE_SANDBOXES` sandboxes at once. `docker stats --no-stream` shows memory under the host total minus 1 GiB.

## Rollback and stop

18. Last healthy release: `deploy-executor.sh --release <state-dir>/last-good.env --secrets-dir <dir> --state-dir <dir> --confirm polytronx-executor`, without `--image-archive`. The earlier image must still be on the host.
19. Stop: `docker compose -p polytronx-executor down`. Never add `-v`. Stopping the executor does not stop its sandboxes. Stop those through the control plane first.

## Open, not blocking

- Capacity arithmetic runs only in preflight, on the host. CI tests admission and the provider, not the memory and CPU headroom.
- Admission leases are checked for shape, signature and expiry. They are not checked against the control plane and not consumed, so a captured lease replays until it expires (`admission.ts`).
- The executor does not cap concurrent sandboxes, and nothing reconciles a sandbox whose record is lost after a restart (`server.ts`).
- The image installs `docker.io`, which brings engine packages in as dependencies. A CLI-only package pin is a follow-up.
- Sandboxes have outbound network access through the default bridge. Restrict egress in `DOCKER-USER` if policy requires it.
- No test covers `deploy-executor.sh` or `preflight-executor.sh`. `gates.test.mjs` does not cover them.
- [executor-host.md](executor-host.md) is out of date: its step 5 omits `VPS_EXECUTOR_ADMISSION_SECRET`, its HTTPS line reference should be `vps-provider.ts:209-210`, and its proxy-restriction advice applies only to a containerized proxy.
