#!/usr/bin/env bash
#
# Returns the live project to an earlier release that passed smoke.
#
# The schema only moves forward. Migrations are applied at boot and recorded in
# the global store's ledger, and upstream documents no Node rollback path for
# them. So a target whose MIGRATIONS_LATEST is older than the running release's
# is refused. Restore the pre-deploy backup instead, as runbooks/backup-and-restore.md
# describes. Each run stops the project's services but keeps every volume.
#
#   rollback.sh --to <release.env> --secrets-dir <dir> --source <dir> \
#     --state-dir <dir> --confirm polytronx-openinspect

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

TARGET=""
SECRETS_DIR=""
SOURCE_DIR=""
STATE_DIR=""
CONFIRM=""

usage() {
  grep '^#   ' "$0" | sed 's/^#   //' >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --to) TARGET="${2:?--to needs a path}"; shift 2 ;;
    --secrets-dir) SECRETS_DIR="${2:?--secrets-dir needs a path}"; shift 2 ;;
    --source) SOURCE_DIR="${2:?--source needs a path}"; shift 2 ;;
    --state-dir) STATE_DIR="${2:?--state-dir needs a path}"; shift 2 ;;
    --confirm) CONFIRM="${2:-}"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) usage; die "unknown argument: $1" ;;
  esac
done
[ -n "$TARGET" ] && [ -n "$SECRETS_DIR" ] && [ -n "$SOURCE_DIR" ] && [ -n "$STATE_DIR" ] ||
  { usage; die "missing a required option"; }
[ "$CONFIRM" = "$LIVE_PROJECT" ] || die "pass --confirm $LIVE_PROJECT to roll back the live project"

require_cmd docker
[ -f "$TARGET" ] || die "rollback target not found: $TARGET"
take_project_lock "$STATE_DIR"

# Values from the release that is running now, read before the target is loaded.
running_migrations=""
if [ -f "$STATE_DIR/attempted.env" ]; then
  running_migrations="$(grep -m1 '^MIGRATIONS_LATEST=' "$STATE_DIR/attempted.env" | cut -d= -f2- || true)"
fi

# Missing docs keys in historical releases must not inherit the caller's environment.
unset DOCS_IMAGE DOCS_IMAGE_ID DOCS_LOOPBACK_PORT
load_release_file "$TARGET"
RELEASE_FILE="$TARGET"
# A release from before the executor CA mount has no CA line, and the compose render would fail on it.
# The file is read, not the environment, which a caller's shell could have set.
[ -n "$(env_value POLYTRONX_EXECUTOR_CA_FILE "$TARGET")" ] ||
  die "rollback target names no POLYTRONX_EXECUTOR_CA_FILE: it predates the executor CA mount. Add the public ca.crt path to it (runbooks/deploy-and-rollback.md); nothing was changed"

if [ -n "${DOCS_IMAGE:-}" ] || [ -n "${DOCS_IMAGE_ID:-}" ] || [ -n "${DOCS_LOOPBACK_PORT:-}" ]; then
  [ -n "${DOCS_IMAGE:-}" ] && [ -n "${DOCS_IMAGE_ID:-}" ] && [ -n "${DOCS_LOOPBACK_PORT:-}" ] ||
    die "rollback target docs metadata is incomplete (nothing was changed)"
  actual="$(docker image inspect -f '{{.Id}}' "$DOCS_IMAGE" 2>/dev/null || true)"
  is_image_id "$DOCS_IMAGE_ID" && [ "$actual" = "$DOCS_IMAGE_ID" ] ||
    die "DOCS target image is missing or differs from its recorded ID (nothing was changed)"
fi

for pair in CONTROL_PLANE WEB; do
  ref_var="${pair}_IMAGE"
  id_var="${pair}_IMAGE_ID"
  actual="$(docker image inspect -f '{{.Id}}' "${!ref_var:-}" 2>/dev/null || true)"
  if [ -z "$actual" ] || [ "$actual" != "${!id_var:-}" ]; then
    die "$pair target image is not present with the recorded ID; load its archive first (nothing was changed)"
  fi
done

[[ "${MIGRATIONS_LATEST:-}" =~ ^[0-9]{4}$ ]] || die "target MIGRATIONS_LATEST must be four digits (nothing was changed)"
if [[ "$running_migrations" =~ ^[0-9]{4}$ && "$((10#${MIGRATIONS_LATEST}))" -lt "$((10#${running_migrations}))" ]]; then
  die "target schema ($MIGRATIONS_LATEST) is older than the running schema ($running_migrations); the schema is forward-only, so restore the pre-deploy backup instead (nothing was changed)"
fi

"$DEPLOY_DIR/preflight.sh" --release "$TARGET" --secrets-dir "$SECRETS_DIR" --source "$SOURCE_DIR" >/dev/null ||
  die "preflight reported blockers for the rollback target (nothing was changed)"

info "rolling back to revision $OPEN_INSPECT_REVISION"
if [ -z "${DOCS_IMAGE:-}" ]; then
  # A first docs release may be unhealthy; remove its container before restoring the older stack.
  live_compose --profile docs rm -sf docs || die "could not remove the failed docs container"
fi
cp "$TARGET" "$STATE_DIR/attempted.env"
if ! live_compose up -d --wait --wait-timeout 420 --pull never; then
  printf '%s rollback FAILED up revision=%s\n' "$(date -u +%FT%TZ)" "$OPEN_INSPECT_REVISION" >>"$STATE_DIR/deploy-log.txt"
  die "up failed on the rollback target; volumes were not changed. Run smoke.sh before anything else."
fi

if "$DEPLOY_DIR/smoke.sh" --release "$TARGET"; then
  cp "$TARGET" "$STATE_DIR/last-good.env"
  printf '%s rollback ok revision=%s\n' "$(date -u +%FT%TZ)" "$OPEN_INSPECT_REVISION" >>"$STATE_DIR/deploy-log.txt"
  info "rollback complete and smoke passed"
else
  printf '%s rollback FAILED smoke revision=%s\n' "$(date -u +%FT%TZ)" "$OPEN_INSPECT_REVISION" >>"$STATE_DIR/deploy-log.txt"
  die "smoke failed after rollback; investigate before anything else (volumes were not changed)"
fi
