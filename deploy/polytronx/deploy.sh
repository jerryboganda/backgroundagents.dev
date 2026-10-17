#!/usr/bin/env bash
#
# Deploys one pinned release to the live project, in a fixed order:
#
#   1. Loads the release's image archives, if given, after checking SHA256SUMS, and pulls
#      the pinned third-party images that are missing (pins.env; preflight checks their digests).
#   2. Runs preflight.sh. Any FAIL stops the deploy before the live project changes.
#   3. Backs up the whole persistent state (backup.sh). A failed backup, or a failed
#      restart of the services it stopped, stops the deploy.
#   4. Creates the edge network if it does not exist. Nothing else is created outside the project.
#   5. Brings the project up with pull_policy: never and waits for health.
#   6. Runs smoke.sh. On failure it prints the way back: the rollback command when an
#      earlier release passed smoke, the first-deployment recovery otherwise. It exits 1.
#
# It never prunes, never removes a volume, and never passes --remove-orphans.
# The last release that passed smoke is kept in STATE_DIR, and rollback.sh
# returns to it. Each failure is appended to STATE_DIR/deploy-log.txt. A lock in
# STATE_DIR keeps a deploy, a rollback and a scheduled backup from overlapping.
#
#   deploy.sh --release <release.env> --secrets-dir <dir> --source <dir> \
#     --backup-dir <dir> --key-file <file> --state-dir <dir> \
#     [--image-archives <dir>] --confirm polytronx-openinspect

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

RELEASE_FILE=""
SECRETS_DIR=""
SOURCE_DIR=""
BACKUP_DIR=""
KEY_FILE=""
STATE_DIR=""
IMAGE_ARCHIVES=""
CONFIRM=""

usage() {
  grep '^#   ' "$0" | sed 's/^#   //' >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --release) RELEASE_FILE="${2:?--release needs a path}"; shift 2 ;;
    --secrets-dir) SECRETS_DIR="${2:?--secrets-dir needs a path}"; shift 2 ;;
    --source) SOURCE_DIR="${2:?--source needs a path}"; shift 2 ;;
    --backup-dir) BACKUP_DIR="${2:?--backup-dir needs a path}"; shift 2 ;;
    --key-file) KEY_FILE="${2:?--key-file needs a path}"; shift 2 ;;
    --state-dir) STATE_DIR="${2:?--state-dir needs a path}"; shift 2 ;;
    --image-archives) IMAGE_ARCHIVES="${2:?--image-archives needs a path}"; shift 2 ;;
    --confirm) CONFIRM="${2:-}"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) usage; die "unknown argument: $1" ;;
  esac
done
[ -n "$RELEASE_FILE" ] && [ -n "$SECRETS_DIR" ] && [ -n "$SOURCE_DIR" ] &&
  [ -n "$BACKUP_DIR" ] && [ -n "$KEY_FILE" ] && [ -n "$STATE_DIR" ] ||
  { usage; die "missing a required option"; }
[ "$CONFIRM" = "$LIVE_PROJECT" ] || die "pass --confirm $LIVE_PROJECT to deploy to the live project"

require_cmd docker sha256sum
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
take_project_lock "$STATE_DIR"

# Appends one line to the deploy log, tagged with the revision of the release being deployed.
log_deploy() { # $1 message
  printf '%s %s revision=%s\n' "$(date -u +%FT%TZ)" "$1" "$(env_value OPEN_INSPECT_REVISION "$RELEASE_FILE")" \
    >>"$STATE_DIR/deploy-log.txt"
}

# The way back after a failed deploy. A rollback target exists only once a release has passed smoke.
recovery_hint() {
  if [ -f "$STATE_DIR/last-good.env" ]; then
    echo "Roll back with: $DEPLOY_DIR/rollback.sh --to $STATE_DIR/last-good.env --secrets-dir $SECRETS_DIR --source $SOURCE_DIR --state-dir $STATE_DIR --confirm $LIVE_PROJECT"
  else
    echo "No earlier release has passed smoke, so there is no rollback target. Use the first-deployment recovery in runbooks/deploy-and-rollback.md (Rollback section). Volumes were not removed."
  fi
}

if [ -n "$IMAGE_ARCHIVES" ]; then
  info "verifying image archives"
  (cd "$IMAGE_ARCHIVES" && sha256sum -c SHA256SUMS) || die "image archive checksums do not match; nothing was loaded"
  for archive in "$IMAGE_ARCHIVES"/*.tar; do
    docker load -i "$archive"
  done
fi

load_release_file "$DEPLOY_DIR/pins.env"
info "pulling the pinned third-party images that are missing from this host"
pull_third_party_images || die "could not pull a pinned third-party image; the live project was not changed"

info "running preflight"
"$DEPLOY_DIR/preflight.sh" --release "$RELEASE_FILE" --secrets-dir "$SECRETS_DIR" --source "$SOURCE_DIR" ||
  die "preflight reported blockers; the live project was not changed (images may already be loaded or pulled on this host)"

load_release_file "$RELEASE_FILE"

info "backing up the persistent state before any change"
if ! "$DEPLOY_DIR/backup.sh" --release "$RELEASE_FILE" --secrets-dir "$SECRETS_DIR" \
  --backup-dir "$BACKUP_DIR" --key-file "$KEY_FILE" --label pre-deploy; then
  log_deploy "deploy STOPPED before any release change: backup or service restart failed"
  die "backup or the restart of its services failed; no release was changed. Run smoke.sh before anything else."
fi

if docker network inspect "$POLYTRONX_EDGE_NETWORK" >/dev/null 2>&1; then
  info "edge network $POLYTRONX_EDGE_NETWORK exists"
else
  docker network create --driver bridge "$POLYTRONX_EDGE_NETWORK" >/dev/null
  info "created edge network $POLYTRONX_EDGE_NETWORK"
fi

live_compose config --quiet
cp "$RELEASE_FILE" "$STATE_DIR/attempted.env"
info "bringing the project up (no pulls; images are verified above)"
if ! live_compose up -d --wait --wait-timeout 420 --pull never; then
  log_deploy "deploy FAILED up: services did not all become healthy on the new release"
  die "up failed on the new release, so services may be partly updated. $(recovery_hint) Run smoke.sh to see which service is unhealthy."
fi

if "$DEPLOY_DIR/smoke.sh" --release "$RELEASE_FILE"; then
  if [ -f "$STATE_DIR/last-good.env" ]; then
    cp "$STATE_DIR/last-good.env" "$STATE_DIR/previous-good.env"
  fi
  cp "$RELEASE_FILE" "$STATE_DIR/last-good.env"
  printf '%s deploy ok revision=%s control_plane=%s web=%s\n' \
    "$(date -u +%FT%TZ)" "$OPEN_INSPECT_REVISION" "$CONTROL_PLANE_IMAGE_ID" "$WEB_IMAGE_ID" \
    >>"$STATE_DIR/deploy-log.txt"
  info "deploy complete; last-good release updated"
else
  log_deploy "deploy FAILED smoke: the new release did not pass"
  warn "smoke failed on the new release. $(recovery_hint)"
  exit 1
fi
