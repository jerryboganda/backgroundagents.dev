# VPS executor host

The executor is the sandbox service of the VPS provider. The dashboard host (185.252.233.186) runs
the control plane, which calls the executor with a bearer token. The executor host (172.235.26.148)
runs the executor, and the sandboxes it starts under gVisor (`runsc`).

Nothing in this runbook has been run against either host. Each step is for the operator, in order.

## What the repository provides

| Asset                                         | Role                                                                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `packages/vps-executor/Dockerfile`            | Executor image. Node 24 base pinned by digest, the same value as `NODE_IMAGE` in `pins.env`. Non-root `node` user. Docker CLI. |
| `deploy/polytronx/compose.executor.yml`       | One service. Port published on `EXECUTOR_BIND_ADDRESS` only. Read-only root, all capabilities dropped, limits set.             |
| `deploy/polytronx/preflight-executor.sh`      | Read-only checks, run as root. Each line is PASS, WARN or FAIL.                                                                |
| `deploy/polytronx/deploy-executor.sh`         | Loads `executor.tar`, runs preflight, brings the project up, keeps `last-good.env`.                                            |
| `.github/workflows/polytronx-openinspect.yml` | `vps-executor` job: typecheck, executor tests, admission tests. `images` job builds, smoke-tests and exports `executor.tar`.   |

## Constraints the deployment enforces

- Sandboxes run under `runsc`. `/v1/health` answers 503 when `runsc` is not registered, and
  preflight fails.
- Sandboxes never receive the Docker socket. The executor's `docker run` arguments mount nothing and
  publish no port.
- Each sandbox gets `EXECUTOR_SANDBOX_CPUS` and `EXECUTOR_SANDBOX_MEMORY`, with no swap. The
  executor service has its own CPU and memory limits.
- Only the executor container mounts `/var/run/docker.sock`. That socket is root-equivalent on the
  host.
- The executor port is reachable from the dashboard host only.

## 1. Host prerequisites (manual)

1. Docker Engine is running, and `docker info` works for the operator.
2. gVisor: install `runsc` and register it with Docker as the `runsc` runtime, following gVisor's
   Docker setup. Then `docker info -f '{{json .Runtimes}}'` must list `runsc`.
3. Firewall. Docker publishes ports past ufw's INPUT rules, so limit the port in the `DOCKER-USER`
   chain:
   ```
   sudo iptables -I DOCKER-USER -p tcp --dport 8787 -j DROP
   sudo iptables -I DOCKER-USER -s 185.252.233.186/32 -p tcp --dport 8787 -j ACCEPT
   sudo iptables -S DOCKER-USER
   ```
   Make the rules survive a reboot with the host's firewall tooling. Preflight checks that the
   ACCEPT rule comes before the DROP rule.
4. Secrets directory, owner only:
   ```
   sudo install -d -m 700 /opt/polytronx/executor/secrets
   ```
5. Create `/opt/polytronx/executor/secrets/executor.env` with mode 600. It holds one line,
   `VPS_EXECUTOR_TOKEN=` followed by 32 or more characters, for example `openssl rand -hex 32`
   written straight into the file, so the value is never echoed. Give the same value to the
   dashboard host's control-plane secrets as `VPS_EXECUTOR_TOKEN`, through a secure channel. Never
   put it in git, in chat, or in `executor-release.env`.
6. Sandbox image. Choose the image the sandboxes run, and pull it by digest on this host with
   `docker pull <name>@sha256:<digest>`. Preflight refuses an image without a digest, or one that is
   not on the host.

## 2. Release

1. Download the `polytronx-release` artifact from the CI run. Copy `executor.tar` and `SHA256SUMS`
   into `/opt/polytronx/executor/archives/`, using the transfer method the operator uses for the
   dashboard release.
2. Write `/opt/polytronx/executor/executor-release.env`:
   ```
   EXECUTOR_IMAGE=open-inspect-vps-executor:<OVERLAY_REVISION from the manifest>
   EXECUTOR_IMAGE_ID=<EXECUTOR_IMAGE_ID from the manifest>
   POLYTRONX_SECRETS_DIR=/opt/polytronx/executor/secrets
   EXECUTOR_BIND_ADDRESS=172.235.26.148
   EXECUTOR_ALLOWED_SOURCE=185.252.233.186
   EXECUTOR_SANDBOX_IMAGE=<name>@sha256:<digest from step 1.6>
   EXECUTOR_SANDBOX_CPUS=2
   EXECUTOR_SANDBOX_MEMORY=4g
   EXECUTOR_MAX_ACTIVE_SANDBOXES=<sandboxes the control plane admits to this executor at once>
   ```
   Optional: `EXECUTOR_CPUS` (default 1) and `EXECUTOR_MEM_LIMIT` (default 512m) limit the executor
   service itself. `EXECUTOR_BIND_ADDRESS=127.0.0.1` is the alternative when a TLS proxy on this
   host fronts the executor (see open item 1). Then the DOCKER-USER check does not apply, and the
   proxy carries the restriction.
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

## 4. Rollback and stop

- Back to the last release that came up healthy: run `deploy-executor.sh` with
  `--release /opt/polytronx/executor/state/last-good.env`, the same `--state-dir`, and no
  `--image-archive`. The earlier image must still be on the host. These scripts never prune images.
- Stop the executor with `docker compose -p polytronx-executor down`. Never add `-v`, which would
  remove the state volume and the record of sandboxes.
- Stopping the executor does not stop its sandboxes. List them with
  `docker ps --filter label=open-inspect.managed=vps-executor`. Stop them through the control plane
  first. Nothing reconciles a sandbox that was removed by hand (see gaps).

## 5. Open items before live use

Blockers:

1. **HTTPS.** The control plane refuses a `VPS_EXECUTOR_URL` that is not `https://`
   (`packages/control-plane/src/sandbox/providers/vps-provider.ts`, lines 181-182). The executor
   serves plain HTTP. Put a TLS terminator in front of it on the executor host: bind it to 443,
   restrict it to the dashboard host with the same DOCKER-USER rule, and forward it to
   `127.0.0.1:8787` with `EXECUTOR_BIND_ADDRESS=127.0.0.1`. Pin that proxy's image by digest when it
   is added. Nothing here adds it.
2. **Sandbox image.** This change builds no sandbox image. Choose and pin one before step 2.
3. **Lockfile.** `package-lock.json` has no `packages/vps-executor` entry. Run
   `npm install --package-lock-only` and commit the lock before the first CI run. I did not run
   `npm ci`, so the failure is expected, not observed.
4. **Overlay allowlist.** The release workflow's overlay check refuses committed changes to upstream
   paths. The working tree has changes to control-plane, shared types, `.env.example`,
   `docs/CONTROL_PLANE_CONTAINER.md` and a D1 migration, none of which the allowlist covers. Move
   them to overlay paths or extend the allowlist.

Gaps, not blockers:

- The admission lease is checked for shape and expiry only. It is not verified against the control
  plane and is not consumed, so a captured lease replays until it expires
  (`packages/vps-executor/src/admission.ts`).
- The executor does not cap concurrent sandboxes. The control plane must.
- No reconcile after a restart. A sandbox whose record is lost keeps running
  (`packages/vps-executor/src/server.ts`).
- The image installs `docker.io` for its CLI, which pulls in engine packages as dependencies. The
  version is not pinned. A CLI-only pin is a follow-up.
- Sandboxes have normal outbound network access, which agents need. The executor's own container
  uses the default bridge network. Restrict egress with DOCKER-USER if policy requires it.
- The two scripts have no test file, and `gates.test.mjs` does not cover them.
