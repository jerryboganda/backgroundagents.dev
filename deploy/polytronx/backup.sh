#!/usr/bin/env bash
#
# Encrypted backup of the whole persistent state of the live project.
#
# Stop-and-snapshot: the services that are running are stopped, so every SQLite file and the
# object store are at rest. Each volume is then archived through an encrypted pipe, read back to
# prove the archive decrypts and lists, and the same services are started again. Upstream's own
# guidance for a volume snapshot is the same (docs/CONTROL_PLANE_CONTAINER.md).
#
# A restart never recreates a container, so it never switches release: each stopped service comes
# back with the image and configuration it was stopped with. deploy.sh's ordered up is the only
# step that changes the release. A failed restart is an error, not a warning.
#
# Captured:
#   control-plane-data  global.db, sessions/*.db, host-alarms.db, jobs.db, cache.db
#   object-store-data   SeaweedFS volumes: media and the Litestream replica bucket
#   secrets             the host secrets directory: encryption keys and credentials
#
# Restoring the store alone is not a restore: session databases and the
# encryption keys are needed to read what global.db points at.
#
# cache.db holds a live GitHub installation token, so treat every archive here
# as a credential. Nothing plaintext is written. The key file never leaves the
# host, and nothing here deletes an archive or a volume.
#
#   backup.sh --release <release.env> --secrets-dir <dir> --backup-dir <dir> \
#     --key-file <file> [--label <name>]
#
# On a live project, run it under the project lock:
#   flock -n <state-dir>/project.lock backup.sh ...

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

RELEASE_FILE=""
SECRETS_DIR=""
BACKUP_DIR=""
KEY_FILE=""
LABEL="manual"
RUNNING_SERVICES=""
STOPPED=0

usage() {
  grep '^#   ' "$0" | sed 's/^#   //' >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --release) RELEASE_FILE="${2:?--release needs a path}"; shift 2 ;;
    --secrets-dir) SECRETS_DIR="${2:?--secrets-dir needs a path}"; shift 2 ;;
    --backup-dir) BACKUP_DIR="${2:?--backup-dir needs a path}"; shift 2 ;;
    --key-file) KEY_FILE="${2:?--key-file needs a path}"; shift 2 ;;
    --label) LABEL="${2:?--label needs a name}"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) usage; die "unknown argument: $1" ;;
  esac
done
[ -n "$RELEASE_FILE" ] && [ -n "$SECRETS_DIR" ] && [ -n "$BACKUP_DIR" ] && [ -n "$KEY_FILE" ] ||
  { usage; die "--release, --secrets-dir, --backup-dir and --key-file are required"; }
[[ "$LABEL" =~ ^[a-z0-9-]{1,40}$ ]] || die "--label must be lowercase letters, digits and hyphens"

require_cmd docker openssl tar sha256sum stat
[ -s "$KEY_FILE" ] || die "backup key file missing or empty: $KEY_FILE"
case "$(stat -c '%a' "$KEY_FILE")" in
  600 | 400) ;;
  *) die "backup key file must be mode 600 or 400" ;;
esac
[ -d "$SECRETS_DIR" ] || die "secrets directory missing: $SECRETS_DIR"

umask 077
load_release_file "$RELEASE_FILE"
[ -n "${CONTROL_PLANE_IMAGE:-}" ] || die "release file does not name CONTROL_PLANE_IMAGE"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$BACKUP_DIR/$LABEL-$TIMESTAMP"
mkdir -m 700 "$DEST"

# The services that are running now, by compose service name, space separated. Empty when none run.
RUNNING_SERVICES="$(docker ps --filter "label=com.docker.compose.project=$LIVE_PROJECT" \
  --format '{{.Label "com.docker.compose.service"}}' | sort -u | paste -sd' ' -)"

# Only the services that were running are restarted, and --no-recreate keeps each
# container's image and configuration. A restart cannot switch the release.
restart_services() {
  [ -n "$RUNNING_SERVICES" ] || return 0
  # shellcheck disable=SC2086
  live_compose up -d --no-recreate --wait --wait-timeout 420 --pull never $RUNNING_SERVICES >&2 || return 1
  info "services restarted on the containers they were stopped from, and healthy"
}

on_exit() {
  local status=$?
  if [ "$STOPPED" -eq 1 ]; then
    STOPPED=0
    if ! restart_services; then
      warn "the services did not restart after the failed backup; run smoke.sh before anything else"
      status=1
    fi
  fi
  exit "$status"
}
trap on_exit EXIT

encrypt_to() { # $1 destination file; stdin is the plaintext stream
  openssl enc "${BACKUP_CIPHER[@]}" -pass "file:$KEY_FILE" -out "$1"
}

decrypt_from() { # $1 source file; writes plaintext to stdout
  openssl enc -d "${BACKUP_CIPHER[@]}" -pass "file:$KEY_FILE" -in "$1"
}

# Archives one volume through a helper container with no network. The helper
# runs as root so it can read the object store's files, and it has no
# capabilities beyond reading and writing its stdout.
archive_volume() { # $1 short volume name
  local volume="${LIVE_PROJECT}_$1"
  if ! docker volume inspect "$volume" >/dev/null 2>&1; then
    info "volume $volume does not exist yet (first deployment); nothing to archive"
    return 0
  fi
  docker run --rm -i --network none --user 0:0 --cap-drop ALL \
    --security-opt no-new-privileges --entrypoint tar \
    -v "$volume:/src:ro" "$CONTROL_PLANE_IMAGE" -C /src -cf - . |
    encrypt_to "$DEST/$1.tar.enc"
  # Reading the archive back proves the key decrypts it and the tar lists.
  decrypt_from "$DEST/$1.tar.enc" | tar -tf - >/dev/null
  info "archived $1 ($(decrypt_from "$DEST/$1.tar.enc" | tar -tf - | wc -l) entries)"
}

if [ -n "$RUNNING_SERVICES" ]; then
  info "stopping the running services for a consistent snapshot: $RUNNING_SERVICES"
  STOPPED=1
  # shellcheck disable=SC2086
  live_compose stop --timeout 60 $RUNNING_SERVICES >/dev/null || die "could not stop the services; nothing was archived"
else
  info "no services are running; none are stopped or restarted"
fi

archive_volume control-plane-data
archive_volume object-store-data

tar -C "$SECRETS_DIR" -cf - . | encrypt_to "$DEST/secrets.tar.enc"
decrypt_from "$DEST/secrets.tar.enc" | tar -tf - >/dev/null
info "archived secrets (contents not listed)"

session_count="$(decrypt_from "$DEST/control-plane-data.tar.enc" 2>/dev/null | tar -tf - 2>/dev/null | grep -c '^\(\./\)\?sessions/[^/]*\.db$' || true)"

cp "$RELEASE_FILE" "$DEST/release.env"
{
  echo "label=$LABEL"
  echo "created_utc=$TIMESTAMP"
  echo "project=$LIVE_PROJECT"
  echo "open_inspect_revision=${OPEN_INSPECT_REVISION:-}"
  echo "overlay_revision=${OVERLAY_REVISION:-}"
  echo "migrations_latest=${MIGRATIONS_LATEST:-}"
  echo "control_plane_image_id=${CONTROL_PLANE_IMAGE_ID:-}"
  echo "session_db_count=${session_count:-0}"
  echo "encryption=openssl enc ${BACKUP_CIPHER[*]}"
} >"$DEST/MANIFEST.env"

(cd "$DEST" && sha256sum ./*.enc release.env MANIFEST.env >SHA256SUMS)

STOPPED=0
if ! restart_services; then
  die "backup written to $DEST, but the services did not come back healthy; run smoke.sh before anything else"
fi
info "backup complete: $DEST"
info "checksums: $DEST/SHA256SUMS"
info "keep the key file separately from this directory; a backup without its key is unreadable"
