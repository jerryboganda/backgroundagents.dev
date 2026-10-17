# Backup and restore

## What is protected

Upstream replicates `global.db` only, through Litestream. That does not restore a
deployment. The session databases, the host alarm index, the jobs store and the
cache hold data the global store points at. The object store holds media and the
Litestream replica. `backup.sh` therefore archives every persistent volume and the
secrets directory:

| Captured | Why |
|---|---|
| `control-plane-data`: global.db, sessions/*.db, host-alarms.db, jobs.db, cache.db | Full application state. Upstream excludes jobs.db and cache.db from its own backups. This package includes them, because the mission requires the complete state. |
| `object-store-data` | SeaweedFS volumes: media and the replica bucket. |
| secrets directory | The encryption keys. Records in the store cannot be read without the keys they were written with. |

`cache.db` holds a live GitHub installation token. Every archive is a credential.

## Method and downtime

`backup.sh` stops the services that are running (of `app`, `litestream`, `web` and
`object-store`), archives each volume through a network-less helper running as root,
reads each archive back to prove it decrypts and lists, and starts the same services
again with `--no-recreate`. Each container comes back with the image and configuration
it was stopped with, so a backup never changes the release. A failed restart exits
non-zero. This matches upstream's guidance for a volume snapshot, which requires the
application to be stopped. Expect about one to two minutes of downtime per backup, and
the pre-deploy backup in `deploy.sh` has the same cost. The recurring backup is
installed as `runbooks/deploy-and-rollback.md` ("Scheduled backup") describes.

Archives are encrypted with `openssl enc -aes-256-cbc -pbkdf2 -iter 300000`. The key
file lives in `keys/` on the host, and a copy belongs off the host. No plaintext
archive is written to disk. Nothing deletes an archive or a volume.

    source/deploy/polytronx/backup.sh \
      --release state/release.env --secrets-dir secrets \
      --backup-dir backups --key-file keys/backup.key --label manual

Each run writes `backups/<label>-<UTC timestamp>/` with `*.tar.enc`, `secrets.tar.enc`,
`release.env`, `MANIFEST.env` (revisions, migration version, session database
count, no secrets) and `SHA256SUMS`.

## Off-server copy (gate)

No off-host destination is configured. Copying the encrypted directory somewhere
else needs an owner decision on storage, its access controls and its retention.
Until that exists, the only copy is on this host, and the backup key may be the
only other copy. Record the decision in the evidence register.

## Rehearsal restore (isolated, required before go-live)

A restore is rehearsed in a separate project. It never touches the live volumes.

1. Make a rehearsal `release.env` from the backup's `release.env`. Set
   `POLYTRONX_SECRETS_DIR` to a separate directory, such as
   `/opt/polytronx/openinspect/rehearsal/secrets`.
2. Run:

       source/deploy/polytronx/restore-rehearsal.sh \
         --backup backups/<label>-<timestamp> --key-file keys/backup.key \
         --release rehearsal/release.env --secrets-dir rehearsal/secrets \
         --project polytronx-openinspect-rehearsal \
         --confirm polytronx-openinspect-rehearsal

The script checks the backup's checksums, refuses the live project name and the
live secrets directory, and creates the rehearsal's volumes, networks and
containers. It streams each archive into its volume, so no plaintext lands on disk.
Then it starts the stack and checks, inside the containers: the control plane
reports ok; the restored migration ledger ends at the version the backup recorded;
the session database count matches the manifest; the web and object store answer;
and the restored control plane cannot reach GitHub or Modal, or resolve GitHub's name.

Containment has three parts. The rehearsal publishes no ports, and every network it
uses is internal, so nothing leaves the host. `compose.rehearsal.yml` sets that
through overrides, and CI checks the rendered configuration, not the overlay text:
`rendered-config.mjs` requires no published port and no network that reaches outside,
and no service on the live `polytronx-edge` network. The restore-time probes above
then test the running containers. A restored control plane still has its automations
and cron loops. Without a route out, they cannot push a branch, open a pull request,
or call Modal. They still run against the rehearsal's own database. Keep the rehearsal
contained until the owner has reviewed it.

Run with `--reset` to remove the rehearsal project's volumes. That removes nothing
else.

## Live restore (gated: owner approval, a fresh backup first)

Restoring over the live volumes replaces current data. Do it only when the
rehearsal has passed and the owner has approved the specific backup and reason.
Procedure, with the live project stopped:

1. Take a fresh backup with `backup.sh --label pre-restore`. It is the way back.
2. Stop the project without removing volumes: `live_compose stop` (see `lib.sh`), or `docker compose ... stop`.
3. Empty each live volume through a helper container, then extract the matching
   archive into it. These two steps delete data, so verify the backup and the
   `pre-restore` archive before each one.
4. Restore `secrets.tar.enc` into the secrets directory only if the keys differ.
   If they do, stop: a changed key cannot read the restored records.
5. Start with `up -d --wait --pull never` and run `smoke.sh`.

This procedure is documented, not automated, deliberately. The scripts here never
empty a live volume.

## Verification of backups

A backup is only as good as its last restore. Rehearse a restore at least once
per release that changes the schema, and after any change to the backup scripts.
Record the rehearsal's results in the evidence register.
