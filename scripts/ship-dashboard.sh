#!/usr/bin/env bash
# One-command dashboard deploy: archives the committed tree (LF endings), builds the control-plane and web images
# on the VPS in parallel, then runs the repo's own preflight and deploy.sh. No CI. Commit first: it ships HEAD.
# Usage: bash scripts/ship-dashboard.sh [ssh-host]
set -euo pipefail
HOST="${1:-vps}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
[ -z "$(git status --porcelain)" ] || { echo "commit your changes first: this ships HEAD" >&2; exit 1; }
SHA="$(git rev-parse HEAD)"
git -c core.autocrlf=false -c core.eol=lf archive HEAD | ssh "$HOST" "set -e
cd /opt/polytronx/openinspect
mv source source.bak-\$(date +%Y%m%dT%H%M%S); mkdir source
tar -x -C source
chmod +x source/deploy/polytronx/*.sh
# Free models the two-hourly sync added on the host are not in this commit yet; carry them into the new tree.
NODE_IMAGE=\$(grep -m1 ^CONTROL_PLANE_IMAGE= state/release.env | cut -d= -f2-)
[ -f state/model-additions.json ] && docker run --rm --user 0 --entrypoint node -v \$PWD/source:/src -v \$PWD/state:/state -w /src \$NODE_IMAGE scripts/opencode-model-sync.mjs replay --models /src/packages/shared/src/models.ts --state /state/model-additions.json || true"
ssh "$HOST" "set -e; cd /opt/polytronx/openinspect/source
REV=\$(grep ^UPSTREAM_REVISION= deploy/polytronx/pins.env | cut -d= -f2); echo \$REV > REVISION
WS=\$(grep ^PUBLIC_WS_URL= deploy/polytronx/pins.env | cut -d= -f2)
nice docker build -q -f packages/control-plane/Dockerfile --label io.polytronx.overlay-revision=$SHA -t open-inspect-control-plane:$SHA . >/tmp/build-cp.log 2>&1 &
P1=\$!
nice docker build -q -f packages/web/Dockerfile --build-arg OPEN_INSPECT_REVISION=\$REV --build-arg NEXT_PUBLIC_WS_URL=\$WS --build-arg NEXT_PUBLIC_SANDBOX_PROVIDER=vps --label io.polytronx.overlay-revision=$SHA -t open-inspect-web:$SHA . >/tmp/build-web.log 2>&1 &
P2=\$!
wait \$P1 || { echo control-plane build failed; tail -20 /tmp/build-cp.log; exit 1; }
wait \$P2 || { echo web build failed; tail -20 /tmp/build-web.log; exit 1; }
cd /opt/polytronx/openinspect
CP=\$(docker image inspect open-inspect-control-plane:$SHA --format '{{.Id}}'); WEB=\$(docker image inspect open-inspect-web:$SHA --format '{{.Id}}')
cp state/release.env state/release.env.pre-${SHA:0:8}
sed -i \"s|^OVERLAY_REVISION=.*|OVERLAY_REVISION=$SHA|; s|^CONTROL_PLANE_IMAGE=.*|CONTROL_PLANE_IMAGE=open-inspect-control-plane:$SHA|; s|^CONTROL_PLANE_IMAGE_ID=.*|CONTROL_PLANE_IMAGE_ID=\$CP|; s|^WEB_IMAGE=.*|WEB_IMAGE=open-inspect-web:$SHA|; s|^WEB_IMAGE_ID=.*|WEB_IMAGE_ID=\$WEB|\" state/release.env
bash source/deploy/polytronx/deploy.sh --release state/release.env --secrets-dir secrets --source source --backup-dir backups --key-file keys/backup.key --state-dir state --confirm polytronx-openinspect 2>&1 | tail -6"
