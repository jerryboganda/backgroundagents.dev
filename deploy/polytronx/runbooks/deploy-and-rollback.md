# Deploy and rollback

Scope: the live project `polytronx-openinspect` on the PolytronX VPS, from the
pinned upstream revision. Read `README.md` first. Every command below is owner
or operator work, run on the VPS unless marked CI. Nothing here has been run
against the production host.

## Host layout

    /opt/polytronx/openinspect/
      source/            git archive of this package's commit; source/REVISION holds the upstream pin
      images/            CI image archives and SHA256SUMS, transient; delete after load
      state/             release.env (current), attempted.env, last-good.env, previous-good.env, deploy-log.txt, project.lock
      secrets/           mode 0700; control-plane.env, web.env, storage.env, each 0600
      backups/           mode 0700; one encrypted directory per backup
      keys/              mode 0700; backup.key, 0600, with a copy held off the host

Nothing under `source/` is a secret. The live Compose project is named
`polytronx-openinspect`, and its volumes are `polytronx-openinspect_control-plane-data`
and `polytronx-openinspect_object-store-data`.

## 1. Build (CI, GitHub-hosted runners only)

Run the workflow `.github/workflows/polytronx-openinspect.yml` by hand
(`workflow_dispatch`) on the commit under test. It checks that the upstream pin is
intact, runs the owner-bootstrap tests and the static checks, renders both Compose
files, builds both images from the pinned source, smokes them, and uploads a
`polytronx-release` artifact containing `release-manifest.env`, the two image
archives, and `SHA256SUMS`. The workflow has no publish step. Registry publication
is a separate, owner-authorized change and is not part of this runbook.

## 2. Transfer to the VPS (operator workstation)

    gh run download <run-id> --name polytronx-release --dir polytronx-release
    scp -r polytronx-release/. <vps>:/opt/polytronx/openinspect/images/

Use the existing SSH key. Do not print it or copy it into any file in this repository.

## 3. Prepare source and state (VPS, once per release)

    mkdir -p /opt/polytronx/openinspect/source && cd /opt/polytronx/openinspect
    # OVERLAY_REVISION from the manifest; the archive is this package's commit.
    git archive <OVERLAY_REVISION> | tar -x -C source
    cp source/deploy/polytronx/templates/release.env.template state/release.env
    # Fill every value from release-manifest.env, then:
    chmod 600 state/release.env

Write `source/REVISION` with the upstream pin, `UPSTREAM_REVISION` in
`source/deploy/polytronx/pins.env`. `preflight.sh` refuses a source tree whose
REVISION does not match.

## 4. Secrets (VPS, owner, once)

See `runbooks/accounts-and-admission.md`. Create the directory with `install -d -m 700`,
copy each template, generate every random value on the VPS with `openssl rand`,
and set each file to 0600. Nothing is printed, pasted into a chat, or committed.
`preflight.sh` checks names, modes and the web/control-plane secret hash match
without printing a value.

## 5. Preflight (read-only)

    source/deploy/polytronx/preflight.sh \
      --release state/release.env \
      --secrets-dir secrets --source source

Every line must read PASS or WARN. A single FAIL stops the deploy, and nothing
changes. Read each WARN and decide whether it is acceptable.

The provider cap line needs the Modal app deployed first, with `MAX_ACTIVE_SANDBOXES=2`
(`runbooks/accounts-and-admission.md`, section 4). preflight makes one unauthenticated GET
of the provider's `api-health`, and sends no credential.

## 6. Deploy

    source/deploy/polytronx/deploy.sh \
      --release state/release.env --secrets-dir secrets --source source \
      --backup-dir backups --key-file keys/backup.key --state-dir state \
      --image-archives images --confirm polytronx-openinspect

The order is fixed: archive checksums, load, pull of the pinned third-party images, preflight,
a whole-state encrypted backup, edge network creation if needed, `up --wait --pull never`, smoke. The
script never prunes, never removes a volume, and never passes `--remove-orphans`.
The first deploy has no volumes to back up, and the backup records that.

The backup stops only the services that are running, and restarts those same
containers with `--no-recreate`, so the restart cannot switch the release. If the
backup or that restart fails, the deploy stops before any release change, and the
failure is written to `state/deploy-log.txt`. A failed `up` or a failed smoke is
logged the same way.

Deploy, rollback and the scheduled backup share one lock, `state/project.lock`. A
second run exits at once with "holds ... project.lock" and changes nothing. If that
message appears with no other run in progress, check for a stale process before
removing anything.

Deploying to the live project needs the owner's approval for each release.

## 7. Post-deploy acceptance

`smoke.sh` runs inside `deploy.sh` and checks container health, loopback health,
limits, the admission flag, and logs for credential-shaped strings. It does not
cover sign-in, WebSockets, Modal, provider accounts or pull requests. Those are
owner-run checks in `runbooks/evidence-register.md`. Record each result there.

Then complete the route setup in `templates/npm-edge-proxy.md` (owner authorization
required for the network attach and the ai host replacement).

## Rollback

If smoke fails, `deploy.sh` prints the rollback command. Its target is
`state/last-good.env`, the last release that passed smoke. For a manual rollback
to the release before that one, use `state/previous-good.env`:

    source/deploy/polytronx/rollback.sh \
      --to state/previous-good.env --secrets-dir secrets --source source \
      --state-dir state --confirm polytronx-openinspect

`rollback.sh` refuses when the target's `MIGRATIONS_LATEST` is older than the
running release's. The schema only moves forward. Migrations are applied at boot
and recorded in the ledger, and upstream documents no Node rollback path for them.
If it refuses, restore the pre-deploy backup instead, as
`runbooks/backup-and-restore.md` describes. Rollback keeps every volume.

If the project has never been healthy (first deploy), there is no `last-good.env`, so
deploy.sh prints no rollback command, and rollback.sh would refuse the target anyway.
Stop it with `docker compose -p polytronx-openinspect --env-file state/release.env -f source/deploy/polytronx/compose.production.yml down`
(no `-v`). The volumes remain for inspection. Then fix the cause that smoke or `up`
reported, and deploy again from step 5.

## Scheduled backup (owner approval)

Each scheduled run stops the application for one to two minutes, so enabling it is an
owner decision. Install the units exactly as follows, on the VPS:

    sudo install -m 644 source/deploy/polytronx/templates/polytronx-backup.service /etc/systemd/system/
    sudo install -m 644 source/deploy/polytronx/templates/polytronx-backup.timer /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable --now polytronx-backup.timer
    systemctl list-timers polytronx-backup.timer

The timer runs daily at 03:20 UTC under the project lock. `monitor.sh` (the monitor timer
template, now given `--backup-dir`) alerts when the newest `periodic-*` backup is older than
36 hours, so a silently failing timer is visible. Archives accumulate: pruning is an owner
decision, and until it is made, the disk alert in `monitor.sh` is the limit.

## Upgrades

A new upstream revision is a new pin: change `UPSTREAM_REVISION` in `pins.env` in a
reviewed commit, run CI, then repeat steps 1–7 with the new manifest. Review the
upstream diff for migrations and configuration changes before deploying.

## Known limits

- The upstream control-plane Dockerfile names `node:24-slim` and `litestream/litestream:0.3.13` by tag. The deployment records and pins the built image IDs, but the base images inside that build are not digest-pinned. This is an upstream file that this package does not modify.
- The web image is built here. Its base image is digest-pinned in `pins.env` and in `packages/web/Dockerfile`.
- `docker compose` and `docker build` were not executed locally. The CI workflow runs them. Until a run passes, no claim of a working image or stack is made.
