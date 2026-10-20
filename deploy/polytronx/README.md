# PolytronX OpenInspect package

The production package for one pinned upstream revision of ColeMurray/background-agents
(`UPSTREAM_REVISION` in `pins.env`), run on the PolytronX VPS. The upstream code is not modified.
This directory, the web image, the owner bootstrap and the CI workflow are the additions.

## Read order

1. `runbooks/unsupported-and-gaps.md`: what does not work on this container, and why it is not
   claimed.
2. `runbooks/deploy-and-rollback.md`: build, transfer, deploy, rollback.
3. `runbooks/ssh-deployment.md`: the SSH deployment: keys, host key verification, the GitHub
   environments, and the executor rotation.
4. `runbooks/evidence-register.md`: what has been run, with results, and what has not.

Also: `runbooks/accounts-and-admission.md` (GitHub App, OAuth, Modal, provider accounts, DNS, proxy,
secrets), `runbooks/owner-bootstrap.md`, `runbooks/backup-and-restore.md`,
`templates/npm-edge-proxy.md`.

## Files

| Path                                          | Purpose                                                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `pins.env`                                    | Upstream revision, public WebSocket URL, base image digests. Changing a value is a release decision.          |
| `compose.production.yml`                      | Live project `polytronx-openinspect`: control plane, object store, Litestream, web.                           |
| `compose.rehearsal.yml`                       | Overlay for an isolated restore rehearsal project. No ports, no route out.                                    |
| `templates/*.env.template`                    | Non-secret release values and empty secret files. Placeholders fail preflight.                                |
| `preflight.sh`                                | Read-only checks. Any FAIL stops the deploy.                                                                  |
| `deploy.sh`, `smoke.sh`, `rollback.sh`        | Ordered deploy, post-deploy smoke, return to the last good release.                                           |
| `host-dashboard-deploy.sh`, `host-executor-deploy.sh` | The deployments, run on the host by the CI workflows or by the operator's ship scripts.             |
| `backup.sh`, `restore-rehearsal.sh`           | Encrypted whole-state backup. Restore only into the rehearsal project.                                        |
| `owner-bootstrap.sh`                          | Runs `scripts/bootstrap-node-owner.ts` inside the live control-plane image. Dry run by default.               |
| `monitor.sh`, `templates/polytronx-monitor.*` | Health monitor and its systemd units.                                                                         |
| `templates/polytronx-backup.*`                | Scheduled full-state backup, a systemd service and timer. Installed by hand, per the deploy runbook.          |
| `lib.sh`                                      | Shared helpers. Sourced only.                                                                                 |
| `rendered-config.mjs`                         | Rules for the rendered production and rehearsal Compose configuration. CI runs it.                            |
| `*.test.mjs`, `test-harness.mjs`, `testdata/` | Guard tests for the scripts above, against stubbed docker, curl and df. Nothing reaches a host or a provider. |

CI: `.github/workflows/polytronx-openinspect.yml`, run by hand. It builds and smokes both images,
renders both Compose files, and uploads `polytronx-release`.

The SSH deployment is separate: `.github/workflows/ssh-deploy-dashboard.yml` and
`.github/workflows/ssh-deploy-executor.yml` run by hand, each in its own GitHub environment, and
they run `host-dashboard-deploy.sh` and `host-executor-deploy.sh` on the host. The setup is in
`runbooks/ssh-deployment.md`.

## Status

- **Verified locally:** the guard tests (`node --test deploy/polytronx/*.test.mjs`), owner-bootstrap
  unit tests and shell syntax. CI-only checks (standalone bootstrap typecheck, rendered
  configuration, Linux Modal checks) are listed as NOT RUN in the evidence register.
- **Verified locally:** the SSH deployment contract tests
  (`npm run test:ssh-deploy-contract`): the two workflows and the shared SSH setup action keep
  their manual trigger, their separate environments, the least token permissions, the verified host
  key and the key out of the logs.
- **Not run anywhere yet:** image builds, Compose smoke, deploy, backup, restore, owner bootstrap
  against a live store, sign-in, Modal, provider accounts, DNS, proxy routes. The workflow has never
  been dispatched. Dispatch needs the commit pushed, which needs owner authorization.
- **Not run anywhere yet:** the SSH deployment. No environment exists, no key is installed on either
  host, and neither workflow has been dispatched.
- **Not in this package:** registry publication, a setup wizard, and the cross-harness controller.
  Secrets are created by the owner using `runbooks/accounts-and-admission.md`, not by a script.

## Rules the scripts enforce

- Nothing secret is in this repository, in `release.env`, or in a log. Secrets live in
  `POLYTRONX_SECRETS_DIR` (mode 0700, files 0600).
- Images are referenced by ID and verified before Compose starts. `pull_policy: never` on every
  service; the two pinned third-party images are pulled by digest by deploy and rehearsal, and
  preflight checks their digests.
- Deploy requires `--confirm polytronx-openinspect`. Nothing prunes, and nothing removes a volume.
- Only the proxy and the two public-facing services join the edge network. The object store
  publishes no port.
