#!/usr/bin/env bash
#
# Deploys one pinned VPS executor release to the executor host, in a fixed order:
#
#   1. Checks executor.tar against SHA256SUMS and loads it, when --image-archive is given.
#   2. Runs preflight-executor.sh. Any FAIL stops the deploy before the project changes.
#   3. Exports the docker group of the engine socket, then brings the polytronx-executor project
#      up with pull_policy: never and waits for its healthcheck. The healthcheck answers only
#      when gVisor is registered with the engine.
#
# It never prunes, never removes a volume, and never passes --remove-orphans. It does not stop or
# remove sandboxes that are already running. The last release that came up healthy is kept in
# STATE_DIR/last-good.env, and each failed deploy is appended to STATE_DIR/deploy-log.txt. A lock
# in STATE_DIR keeps two deploys from overlapping.
#
#   deploy-executor.sh --release <executor-release.env> --secrets-dir <dir> --state-dir <dir> \
#     [--image-archive <dir>] --confirm polytronx-executor

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

EXECUTOR_PROJECT="polytronx-executor"
EXECUTOR_COMPOSE_FILE="$DEPLOY_DIR/compose.executor.yml"
DOCKER_SOCKET="/var/run/docker.sock"

RELEASE_FILE=""
SECRETS_DIR=""
STATE_DIR=""
IMAGE_ARCHIVE=""
CONFIRM=""

usage() {
  grep '^#   ' "$0" | sed 's/^#   //' >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --release) RELEASE_FILE="${2:?--release needs a path}"; shift 2 ;;
    --secrets-dir) SECRETS_DIR="${2:?--secrets-dir needs a path}"; shift 2 ;;
    --state-dir) STATE_DIR="${2:?--state-dir needs a path}"; shift 2 ;;
    --image-archive) IMAGE_ARCHIVE="${2:?--image-archive needs a path}"; shift 2 ;;
    --confirm) CONFIRM="${2:-}"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) usage; die "unknown argument: $1" ;;
  esac
done
[ -n "$RELEASE_FILE" ] && [ -n "$SECRETS_DIR" ] && [ -n "$STATE_DIR" ] ||
  { usage; die "missing a required option"; }
[ "$CONFIRM" = "$EXECUTOR_PROJECT" ] || die "pass --confirm $EXECUTOR_PROJECT to deploy to the executor host"

require_cmd docker sha256sum stat
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
take_project_lock "$STATE_DIR"

# Appends one line to the deploy log, tagged with the image the release names.
log_deploy() { # $1 message
  printf '%s %s image_id=%s\n' "$(date -u +%FT%TZ)" "$1" "$(env_value EXECUTOR_IMAGE_ID "$RELEASE_FILE")" \
    >>"$STATE_DIR/deploy-log.txt"
}

# The way back after a failed deploy: the last release that came up healthy, if there is one.
recovery_hint() {
  if [ -f "$STATE_DIR/last-good.env" ]; then
    echo "Roll back with: bash $0 --release $STATE_DIR/last-good.env --secrets-dir $SECRETS_DIR --state-dir $STATE_DIR --confirm $EXECUTOR_PROJECT"
  else
    echo "No earlier release has come up healthy on this host, so there is no rollback target."
  fi
}

if [ -n "$IMAGE_ARCHIVE" ]; then
  info "verifying the executor archive"
  (cd "$IMAGE_ARCHIVE" && grep ' executor\.tar$' SHA256SUMS | sha256sum -c -) ||
    die "executor.tar does not match SHA256SUMS; nothing was loaded"
  docker load -i "$IMAGE_ARCHIVE/executor.tar"
fi

load_release_file "$RELEASE_FILE"

info "running preflight"
bash "$DEPLOY_DIR/preflight-executor.sh" --release "$RELEASE_FILE" --secrets-dir "$SECRETS_DIR" ||
  die "preflight reported blockers; the executor project was not changed"

# The same socket preflight checked. The compose file refuses to render without it.
DOCKER_GID="$(stat -c '%g' "$DOCKER_SOCKET")"
export DOCKER_GID

executor_compose() {
  docker compose -p "$EXECUTOR_PROJECT" --env-file "$RELEASE_FILE" -f "$EXECUTOR_COMPOSE_FILE" "$@"
}

executor_compose config --quiet
cp "$RELEASE_FILE" "$STATE_DIR/attempted.env"
info "bringing the executor up (no pulls; the image was verified above)"
if ! executor_compose up -d --wait --wait-timeout 180 --pull never; then
  log_deploy "deploy FAILED up: the executor did not become healthy"
  die "up failed: the executor is not healthy. Its own output: docker compose -p $EXECUTOR_PROJECT logs vps-executor. $(recovery_hint)"
fi

cp "$RELEASE_FILE" "$STATE_DIR/last-good.env"
log_deploy "deploy ok"
info "executor is healthy inside its container; reachability from the dashboard host is a separate check (runbooks/executor-host.md)"
