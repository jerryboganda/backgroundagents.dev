#!/usr/bin/env bash
#
# Installs a staged tree on the dashboard host and deploys it. It runs as root: it writes
# the host's state directory and drives Docker.
#
# Two modes:
#
#   --staged <dir>   install the staged tree as <root>/source, then continue with the
#                    installed copy. The CI workflow calls the installed copy of this
#                    script in this mode, so the entry point on the host stays small and
#                    each release brings its own deployment steps.
#   (no --staged)    deploy the tree that is already installed at <root>/source.
#
#   host-dashboard-deploy.sh [--staged <dir>] --root <dir> [--revision <sha>]
#                           [--deploy] [--rollback-on-failure]
#
# Without --deploy the run stops after the preflight: the tree is installed and the
# release file names the candidate release, but nothing that runs the project changes.
#
# The deployment itself is deploy.sh: it takes the project lock, backs up the persistent
# state, brings the project up with the verified images and runs the smoke checks. This
# script prepares the tree, the images and the release file, and reports the result.

set -euo pipefail

# The helpers live in the tree this script works on: the staged tree while it installs
# that tree, and the installed tree afterwards. The copy of this script that sits in
# /usr/local/sbin has no lib.sh beside it, so these three are defined here as well and
# lib.sh replaces them once it is sourced.
die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

info() {
  printf 'INFO: %s\n' "$*"
}

warn() {
  printf 'WARN: %s\n' "$*" >&2
}

STAGED=""
ROOT="/opt/polytronx/openinspect"
REVISION=""
DEPLOY=0
ROLLBACK=0
STATE_DIR=""
RELEASE_FILE=""
SRC=""

usage() {
  grep '^#   ' "$0" | sed 's/^#   //' >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --staged) STAGED="${2:?--staged needs a path}"; shift 2 ;;
    --root) ROOT="${2:?--root needs a path}"; shift 2 ;;
    --revision) REVISION="${2:?--revision needs a value}"; shift 2 ;;
    --deploy) DEPLOY=1; shift ;;
    --rollback-on-failure) ROLLBACK=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage; die "unknown argument: $1" ;;
  esac
done

STATE_DIR="$ROOT/state"
RELEASE_FILE="$STATE_DIR/release.env"
SRC="$ROOT/source"

# lib.sh carries the release helpers: reading a release file and pulling the pinned
# third-party images. It comes from the tree this script works on.
if [ -n "$STAGED" ] && [ -f "$STAGED/deploy/polytronx/lib.sh" ]; then
  # shellcheck source=lib.sh
  source "$STAGED/deploy/polytronx/lib.sh"
else
  # shellcheck source=lib.sh
  source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
fi

# Installs the staged tree as the live source tree. The previous tree is kept under a
# timestamped name, so a failed deployment can be inspected and deployed again.
install_tree() {
  local staged="$1" stamp
  [ -f "$staged/deploy/polytronx/pins.env" ] ||
    die "the staged tree has no deploy/polytronx/pins.env"
  [ -f "$staged/packages/control-plane/Dockerfile" ] ||
    die "the staged tree has no packages/control-plane/Dockerfile"
  [ -f "$staged/packages/web/Dockerfile" ] ||
    die "the staged tree has no packages/web/Dockerfile"
  [ -f "$staged/packages/docs/Dockerfile" ] ||
    die "the staged tree has no packages/docs/Dockerfile"
  [ -f "$staged/deploy/polytronx/host-dashboard-deploy.sh" ] ||
    die "the staged tree has no deploy/polytronx/host-dashboard-deploy.sh"
  stamp="$(date -u +%Y%m%dT%H%M%S)"
  mkdir -p "$ROOT"
  rm -rf "$ROOT/source.new"
  cp -R "$staged" "$ROOT/source.new"
  chown -R root:root "$ROOT/source.new"
  chmod +x "$ROOT/source.new"/deploy/polytronx/*.sh
  if [ -d "$SRC" ]; then
    mv "$SRC" "$ROOT/source.bak-$stamp"
    info "the previous tree is at $ROOT/source.bak-$stamp"
  fi
  mv "$ROOT/source.new" "$SRC"
  info "installed the staged tree as $SRC"
}

if [ -n "$STAGED" ]; then
  [ -d "$STAGED" ] || die "the staged tree is not there: $STAGED"
  install_tree "$STAGED"
  args=(--root "$ROOT")
  if [ -n "$REVISION" ]; then args+=(--revision "$REVISION"); fi
  if [ "$DEPLOY" = 1 ]; then args+=(--deploy); fi
  if [ "$ROLLBACK" = 1 ]; then args+=(--rollback-on-failure); fi
  exec bash "$SRC/deploy/polytronx/host-dashboard-deploy.sh" "${args[@]}"
fi

[ -d "$SRC" ] || die "no source tree at $SRC; stage one first"
[ -n "$REVISION" ] || die "--revision is required: it names the commit being deployed"
[[ "$REVISION" =~ ^[0-9a-f]{40}$ ]] || die "--revision must be a full commit"
[ -f "$RELEASE_FILE" ] || die "no release file at $RELEASE_FILE"

# Sets KEY=VALUE in a release file, in place. The mode is kept: the release file is 0600.
set_release_value() { # $1 key, $2 value, $3 file
  local key="$1" value="$2" file="$3" mode
  mode="$(stat -c '%a' "$file")"
  if grep -q "^${key}=" "$file"; then
    awk -v k="$key" -v v="$value" 'BEGIN { FS = OFS = "=" } $1 == k { print k "=" v; next } { print }' \
      "$file" >"$file.tmp"
  else
    cp "$file" "$file.tmp"
    printf '%s=%s\n' "$key" "$value" >>"$file.tmp"
  fi
  chmod "$mode" "$file.tmp"
  mv "$file.tmp" "$file"
}

# The free models the two-hourly sync adds on the host are not in the repository tree.
# They are recorded in state/model-additions.json, and this replays them onto the new
# tree, so a release from the repository keeps them.
replay_model_additions() {
  local additions="$STATE_DIR/model-additions.json" node_image
  [ -f "$additions" ] || return 0
  [ -f "$SRC/scripts/opencode-model-sync.mjs" ] || return 0
  node_image="$(grep -m1 '^CONTROL_PLANE_IMAGE=' "$RELEASE_FILE" | cut -d= -f2- || true)"
  if [ -z "$node_image" ]; then
    warn "the release file names no control-plane image; the recorded model additions are not replayed"
    return 0
  fi
  if ! docker image inspect "$node_image" >/dev/null 2>&1; then
    warn "the control-plane image $node_image is not on this host; the recorded model additions are not replayed"
    return 0
  fi
  info "replaying the recorded model additions onto the new tree"
  if ! docker run --rm --user 0 --entrypoint node \
    -v "$SRC:/src" -v "$STATE_DIR:/state" -w /src "$node_image" \
    scripts/opencode-model-sync.mjs replay --models /src/packages/shared/src/models.ts \
    --state /state/model-additions.json; then
    warn "the recorded model additions could not be replayed; the release keeps the catalog in the repository"
  fi
}

# Builds all three dashboard images from the installed tree and records them in the release file. The
# tags carry the revision, so an image on this host names the commit it was built from.
build_images() {
  local rev ws cp_id web_id docs_id p1 p2 p3 failed=0
  rev="$(grep -m1 '^UPSTREAM_REVISION=' "$SRC/deploy/polytronx/pins.env" | cut -d= -f2-)"
  ws="$(grep -m1 '^PUBLIC_WS_URL=' "$SRC/deploy/polytronx/pins.env" | cut -d= -f2-)"
  info "building the control-plane, web and docs images for $REVISION"
  (cd "$SRC" && exec nice docker build -q -f packages/control-plane/Dockerfile \
    --label "io.polytronx.overlay-revision=$REVISION" \
    -t "open-inspect-control-plane:$REVISION" .) \
    >/tmp/polytronx-build-control-plane.log 2>&1 &
  p1=$!
  (cd "$SRC" && exec nice docker build -q -f packages/web/Dockerfile \
    --build-arg "OPEN_INSPECT_REVISION=$rev" --build-arg "NEXT_PUBLIC_WS_URL=$ws" \
    --build-arg "NEXT_PUBLIC_SANDBOX_PROVIDER=vps" \
    --label "io.polytronx.overlay-revision=$REVISION" \
    -t "open-inspect-web:$REVISION" .) \
    >/tmp/polytronx-build-web.log 2>&1 &
  p2=$!
  (cd "$SRC" && exec nice docker build --progress=plain -f packages/docs/Dockerfile \
    --label "io.polytronx.overlay-revision=$REVISION" \
    -t "open-inspect-docs:$REVISION" .) \
    >/tmp/polytronx-build-docs.log 2>&1 &
  p3=$!
  if ! wait "$p1"; then
    warn "the control-plane build failed; the tail of its log follows"
    tail -n 20 /tmp/polytronx-build-control-plane.log
    failed=1
  fi
  if ! wait "$p2"; then
    warn "the web build failed; the tail of its log follows"
    tail -n 20 /tmp/polytronx-build-web.log
    failed=1
  fi
  if ! wait "$p3"; then
    warn "the docs build failed; the tail of its log follows"
    tail -n 80 /tmp/polytronx-build-docs.log
    failed=1
  fi
  if [ "$failed" = 1 ]; then
    die "the images were not built; the running release is unchanged"
  fi
  cp_id="$(docker image inspect "open-inspect-control-plane:$REVISION" --format '{{.Id}}')"
  web_id="$(docker image inspect "open-inspect-web:$REVISION" --format '{{.Id}}')"
  docs_id="$(docker image inspect "open-inspect-docs:$REVISION" --format '{{.Id}}')"
  set_release_value OVERLAY_REVISION "$REVISION" "$RELEASE_FILE"
  set_release_value CONTROL_PLANE_IMAGE "open-inspect-control-plane:$REVISION" "$RELEASE_FILE"
  set_release_value CONTROL_PLANE_IMAGE_ID "$cp_id" "$RELEASE_FILE"
  set_release_value WEB_IMAGE "open-inspect-web:$REVISION" "$RELEASE_FILE"
  set_release_value WEB_IMAGE_ID "$web_id" "$RELEASE_FILE"
  set_release_value DOCS_IMAGE "open-inspect-docs:$REVISION" "$RELEASE_FILE"
  set_release_value DOCS_IMAGE_ID "$docs_id" "$RELEASE_FILE"
  if [ -z "$(env_value DOCS_LOOPBACK_PORT "$RELEASE_FILE")" ]; then
    set_release_value DOCS_LOOPBACK_PORT 13081 "$RELEASE_FILE"
  fi
  info "the release file names the images of revision $REVISION"
}

info "the tree at $SRC is revision $REVISION"

# The revision of the pinned upstream commit. preflight.sh and the compose render read
# it from the tree.
upstream_revision="$(grep -m1 '^UPSTREAM_REVISION=' "$SRC/deploy/polytronx/pins.env" | cut -d= -f2-)"
[ -n "$upstream_revision" ] || die "pins.env has no UPSTREAM_REVISION"
printf '%s\n' "$upstream_revision" >"$SRC/REVISION"

replay_model_additions

# The pinned third-party images are pulled when they are missing, exactly as deploy.sh
# does before its preflight. Nothing else on the host changes.
load_release_file "$SRC/deploy/polytronx/pins.env"
if ! pull_third_party_images; then
  die "a pinned third-party image could not be pulled; nothing was deployed"
fi

# The previous release file is kept, so a failed preflight can put it back.
cp "$RELEASE_FILE" "$STATE_DIR/release.env.pre-${REVISION:0:8}"

build_images

info "running the preflight"
if ! bash "$SRC/deploy/polytronx/preflight.sh" --release "$RELEASE_FILE" \
  --secrets-dir "$ROOT/secrets" --source "$SRC"; then
  cp "$STATE_DIR/release.env.pre-${REVISION:0:8}" "$RELEASE_FILE"
  die "the preflight reported blockers; the running release is unchanged"
fi

if [ "$DEPLOY" != 1 ]; then
  info "the preflight passed; nothing was deployed. Run again with --deploy to deploy this tree."
  exit 0
fi

info "deploying revision $REVISION"
if bash "$SRC/deploy/polytronx/deploy.sh" --release "$RELEASE_FILE" \
  --secrets-dir "$ROOT/secrets" --source "$SRC" --backup-dir "$ROOT/backups" \
  --key-file "$ROOT/keys/backup.key" --state-dir "$STATE_DIR" \
  --confirm polytronx-openinspect; then
  info "the deployment finished and the smoke checks passed"
  tail -n 3 "$STATE_DIR/deploy-log.txt" || true
else
  warn "the deployment failed; the release that is running may be partly updated"
  if [ "$ROLLBACK" = 1 ] && [ -f "$STATE_DIR/last-good.env" ]; then
    warn "rolling back to the last release that passed smoke"
    if bash "$SRC/deploy/polytronx/rollback.sh" --to "$STATE_DIR/last-good.env" \
      --secrets-dir "$ROOT/secrets" --source "$SRC" --state-dir "$STATE_DIR" \
      --confirm polytronx-openinspect; then
      info "the rollback finished and its smoke checks passed"
    else
      warn "the rollback failed; the dashboard needs the owner"
    fi
  fi
  die "the deployment failed; read $STATE_DIR/deploy-log.txt"
fi
