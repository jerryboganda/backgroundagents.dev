#!/usr/bin/env bash
#
# Installs a staged tree on the executor host and deploys it. It runs as root: it writes
# the host's state directory, provisions the workspace slots and drives Docker.
#
# Two modes:
#
#   --staged <dir>   install the staged tree, then continue with the installed copy. The
#                    CI workflow calls the installed copy of this script in this mode, so
#                    the entry point on the host stays small and each release brings its
#                    own deployment steps.
#   (no --staged)    deploy the tree that is already installed on this host.
#
#   host-executor-deploy.sh [--staged <dir>] --root <dir> [--revision <sha>]
#                          [--deploy] [--rollback-on-failure]
#
# The staged tree holds two paths: packages/vps-executor, which is the image, and
# deploy/polytronx, which are the deployment scripts. The install copies both into the
# host's own directories: deploy/polytronx next to the release file, and the executor
# package into the image build directory.
#
# Without --deploy the run stops after the preflight: the tree is installed and the
# release file names the candidate release, but nothing that runs the executor changes.

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

STAGED=""
ROOT="/opt/polytronx/executor"
REVISION=""
DEPLOY=0
ROLLBACK=0
STATE_DIR=""
RELEASE_FILE=""
DEPLOY_DIR=""
BUILD_DIR=""

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
RELEASE_FILE="$ROOT/executor-release.env"
DEPLOY_DIR="$ROOT/deploy/polytronx"
BUILD_DIR="$ROOT/build/vps-executor"

# Installs the staged tree: the deployment scripts into the host's deploy directory and
# the executor package into the image build directory. The previous scripts are kept
# under a timestamped name.
install_tree() {
  local staged="$1" stamp
  [ -f "$staged/deploy/polytronx/compose.executor.yml" ] ||
    die "the staged tree has no deploy/polytronx/compose.executor.yml"
  [ -f "$staged/deploy/polytronx/deploy-executor.sh" ] ||
    die "the staged tree has no deploy/polytronx/deploy-executor.sh"
  [ -f "$staged/packages/vps-executor/Dockerfile" ] ||
    die "the staged tree has no packages/vps-executor/Dockerfile"
  [ -f "$staged/deploy/polytronx/host-executor-deploy.sh" ] ||
    die "the staged tree has no deploy/polytronx/host-executor-deploy.sh"
  stamp="$(date -u +%Y%m%dT%H%M%S)"
  mkdir -p "$ROOT/deploy" "$ROOT/build"
  rm -rf "$ROOT/deploy/polytronx.new" "$ROOT/build/vps-executor.new"
  cp -R "$staged/deploy/polytronx" "$ROOT/deploy/polytronx.new"
  cp -R "$staged/packages/vps-executor" "$ROOT/build/vps-executor.new"
  chown -R root:root "$ROOT/deploy/polytronx.new" "$ROOT/build/vps-executor.new"
  chmod +x "$ROOT/deploy/polytronx.new"/*.sh
  if [ -d "$ROOT/deploy/polytronx" ]; then
    mv "$ROOT/deploy/polytronx" "$ROOT/deploy/polytronx.bak-$stamp"
    info "the previous deployment scripts are at $ROOT/deploy/polytronx.bak-$stamp"
  fi
  mv "$ROOT/deploy/polytronx.new" "$ROOT/deploy/polytronx"
  rm -rf "$BUILD_DIR"
  mv "$ROOT/build/vps-executor.new" "$BUILD_DIR"
  info "installed the staged tree as $DEPLOY_DIR and $BUILD_DIR"
}

if [ -n "$STAGED" ]; then
  [ -d "$STAGED" ] || die "the staged tree is not there: $STAGED"
  install_tree "$STAGED"
  args=(--root "$ROOT")
  if [ -n "$REVISION" ]; then args+=(--revision "$REVISION"); fi
  if [ "$DEPLOY" = 1 ]; then args+=(--deploy); fi
  if [ "$ROLLBACK" = 1 ]; then args+=(--rollback-on-failure); fi
  exec bash "$DEPLOY_DIR/host-executor-deploy.sh" "${args[@]}"
fi

[ -d "$DEPLOY_DIR" ] || die "no deployment scripts at $DEPLOY_DIR; stage a tree first"
[ -d "$BUILD_DIR" ] || die "no executor package at $BUILD_DIR; stage a tree first"
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

# The workspace slots are the bounded storage behind every sandbox's /workspace. They are
# provisioned once per host; the check reads them.
ensure_workspace_slots() {
  if bash "$DEPLOY_DIR/workspace-slots.sh" --check >/dev/null 2>&1; then
    info "the workspace slots are provisioned"
    return 0
  fi
  warn "the workspace slots are not provisioned yet; provisioning them now"
  bash "$DEPLOY_DIR/workspace-slots.sh" --apply ||
    die "the workspace slots could not be provisioned; nothing was deployed"
}

# Builds the executor image from the installed package. The tag carries the revision, and
# the label names the Node image the package is pinned to, which preflight-executor.sh
# checks against pins.env.
build_image() {
  local node_image image_id
  node_image="$(grep -m1 '^ARG NODE_IMAGE=' "$BUILD_DIR/Dockerfile" | cut -d= -f2- | tr -d '\r')"
  [ -n "$node_image" ] || die "the executor Dockerfile names no NODE_IMAGE"
  info "building the executor image for $REVISION"
  if ! docker build -q -t "open-inspect-vps-executor:$REVISION" \
    --label "io.polytronx.node-image=$node_image" \
    --label "io.polytronx.overlay-revision=$REVISION" \
    "$BUILD_DIR" >/tmp/polytronx-build-executor.log 2>&1; then
    warn "the executor build failed; the tail of its log follows"
    tail -n 20 /tmp/polytronx-build-executor.log
    die "the executor image was not built; the running release is unchanged"
  fi
  image_id="$(docker image inspect "open-inspect-vps-executor:$REVISION" --format '{{.Id}}')"
  set_release_value EXECUTOR_IMAGE "open-inspect-vps-executor:$REVISION" "$RELEASE_FILE"
  set_release_value EXECUTOR_IMAGE_ID "$image_id" "$RELEASE_FILE"
  info "the release file names the executor image of revision $REVISION"
}

info "the executor package at $BUILD_DIR is revision $REVISION"

ensure_workspace_slots

# The previous release file is kept, so a failed preflight can put it back.
cp "$RELEASE_FILE" "$ROOT/executor-release.env.pre-${REVISION:0:8}"

build_image

info "running the preflight"
if ! bash "$DEPLOY_DIR/preflight-executor.sh" --release "$RELEASE_FILE" \
  --secrets-dir "$ROOT/secrets"; then
  cp "$ROOT/executor-release.env.pre-${REVISION:0:8}" "$RELEASE_FILE"
  die "the preflight reported blockers; the running release is unchanged"
fi

if [ "$DEPLOY" != 1 ]; then
  info "the preflight passed; nothing was deployed. Run again with --deploy to deploy this tree."
  exit 0
fi

info "deploying revision $REVISION"
if bash "$DEPLOY_DIR/deploy-executor.sh" --release "$RELEASE_FILE" \
  --secrets-dir "$ROOT/secrets" --state-dir "$STATE_DIR" \
  --confirm polytronx-executor; then
  info "the executor came up healthy"
  curl -fsS --max-time 10 http://127.0.0.1:8787/v1/health && echo
else
  warn "the deployment failed; the executor that is running may be partly updated"
  if [ "$ROLLBACK" = 1 ] && [ -f "$STATE_DIR/last-good.env" ]; then
    warn "rolling back to the last release that came up healthy"
    if bash "$DEPLOY_DIR/deploy-executor.sh" --release "$STATE_DIR/last-good.env" \
      --secrets-dir "$ROOT/secrets" --state-dir "$STATE_DIR" \
      --confirm polytronx-executor; then
      info "the rollback finished and the executor came up healthy"
    else
      warn "the rollback failed; the executor needs the owner"
    fi
  fi
  die "the deployment failed; read $STATE_DIR/deploy-log.txt"
fi
