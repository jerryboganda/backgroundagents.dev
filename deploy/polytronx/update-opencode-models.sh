#!/usr/bin/env bash
#
# Every two hours (see templates/polytronx-model-sync.*): checks OpenCode's live Zen and Go model lists, and when a
# free-tier model is missing from the catalog, adds it, rebuilds the web and control-plane images and deploys them
# with the normal deploy.sh (preflight, backup, smoke). A failed deploy is rolled back to the last healthy release.
#
# It does nothing while a sandbox slot is held, because a deploy restarts the control plane. The next run tries again.
# Additions are recorded in state/model-additions.json, which scripts/ship-dashboard.sh replays onto a fresh tree, so a
# later release from the repository keeps them.
#
#   update-opencode-models.sh [--check-only]

set -euo pipefail

ROOT="${POLYTRONX_ROOT:-/opt/polytronx/openinspect}"
SRC="$ROOT/source"
STATE_DIR="$ROOT/state"
ADDITIONS="$STATE_DIR/model-additions.json"
LOG="$STATE_DIR/model-sync.log"
CHECK_ONLY=0
[ "${1:-}" = "--check-only" ] && CHECK_ONLY=1

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOG"; }
alert() { log "ALERT $*"; [ -x "$ROOT/bin/notify" ] && printf '%s\n' "$*" | "$ROOT/bin/notify" || true; }

NODE_IMAGE="$(grep -m1 '^NODE_IMAGE=' "$SRC/deploy/polytronx/pins.env" | cut -d= -f2-)"
docker image inspect "$NODE_IMAGE" >/dev/null 2>&1 || { log "node image is not on this host; skipping"; exit 0; }

run_node() {
  docker run --rm -v "$SRC:/src" -v "$STATE_DIR:/state" -w /src "$NODE_IMAGE" node scripts/opencode-model-sync.mjs "$@"
}

if ! result="$(run_node check --models /src/packages/shared/src/models.ts 2>>"$LOG")"; then
  log "could not read OpenCode's model lists; will retry"
  exit 0
fi
if printf '%s' "$result" | grep -q '"missing":\[\]'; then
  log "catalog is current"
  exit 0
fi
ids="$(printf '%s' "$result" | sed -E 's/.*\[(.*)\].*/\1/; s/"//g')"
log "new free models: $ids"
[ "$CHECK_ONLY" = 1 ] && exit 0

held="$(docker exec polytronx-openinspect-app-1 node -e "
const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/global.db',{readOnly:true});
console.log(d.prepare('select count(*) c from sandbox_admission_reservations').get().c)" 2>/dev/null || echo unknown)"
if [ "$held" != "0" ]; then
  log "deploy postponed: sandbox slots in use ($held); will retry"
  exit 0
fi

cd "$SRC"
run_node apply --models /src/packages/shared/src/models.ts --ids "$ids" >/dev/null
run_node record --state /state/model-additions.json --ids "$ids" >/dev/null

TAG="$(grep -m1 '^OVERLAY_REVISION=' "$STATE_DIR/release.env" | cut -d= -f2)-m$(date +%Y%m%d%H%M%S)"
REV="$(grep -m1 '^UPSTREAM_REVISION=' deploy/polytronx/pins.env | cut -d= -f2)"
WS="$(grep -m1 '^PUBLIC_WS_URL=' deploy/polytronx/pins.env | cut -d= -f2)"
log "building images $TAG"
nice docker build -q -f packages/control-plane/Dockerfile -t "open-inspect-control-plane:$TAG" . >/tmp/model-sync-cp.log 2>&1 &
p1=$!
nice docker build -q -f packages/web/Dockerfile --build-arg OPEN_INSPECT_REVISION="$REV" --build-arg NEXT_PUBLIC_WS_URL="$WS" \
  --build-arg NEXT_PUBLIC_SANDBOX_PROVIDER=vps -t "open-inspect-web:$TAG" . >/tmp/model-sync-web.log 2>&1 &
p2=$!
if ! wait "$p1" || ! wait "$p2"; then
  alert "model sync: image build failed; the catalog change is not live (see /tmp/model-sync-*.log)"
  exit 1
fi

cd "$ROOT"
CP_ID="$(docker image inspect "open-inspect-control-plane:$TAG" --format '{{.Id}}')"
WEB_ID="$(docker image inspect "open-inspect-web:$TAG" --format '{{.Id}}')"
cp "$STATE_DIR/release.env" "$STATE_DIR/release.env.pre-model-sync"
sed -i "s|^CONTROL_PLANE_IMAGE=.*|CONTROL_PLANE_IMAGE=open-inspect-control-plane:$TAG|; s|^CONTROL_PLANE_IMAGE_ID=.*|CONTROL_PLANE_IMAGE_ID=$CP_ID|; s|^WEB_IMAGE=.*|WEB_IMAGE=open-inspect-web:$TAG|; s|^WEB_IMAGE_ID=.*|WEB_IMAGE_ID=$WEB_ID|" "$STATE_DIR/release.env"

if bash "$SRC/deploy/polytronx/deploy.sh" --release state/release.env --secrets-dir secrets --source source --backup-dir backups \
  --key-file keys/backup.key --state-dir state --confirm polytronx-openinspect >>"$LOG" 2>&1; then
  log "deployed: $ids are now in the model picker (enable them under Settings > Models)"
else
  alert "model sync: deploy failed, rolling back to the last healthy release"
  bash "$SRC/deploy/polytronx/rollback.sh" --to state/last-good.env --secrets-dir secrets --source source --state-dir state \
    --confirm polytronx-openinspect >>"$LOG" 2>&1 || alert "model sync: ROLLBACK FAILED, check the dashboard"
  exit 1
fi
