#!/usr/bin/env bash
# One-command executor deploy: uploads packages/vps-executor and deploy/polytronx to the Linode,
# builds the image there, provisions any missing workspace slots, and runs the repo's own
# preflight + deploy-executor.sh. No CI, no tests. Usage: bash scripts/ship-executor.sh [ssh-host]
set -euo pipefail
HOST="${1:-linode-executor}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tar -C "$ROOT/packages/vps-executor" -cf - Dockerfile package.json src |
  ssh "$HOST" 'rm -rf /opt/polytronx/executor/build/vps-executor.new && mkdir -p /opt/polytronx/executor/build/vps-executor.new && tar -C /opt/polytronx/executor/build/vps-executor.new -xf -'
tar -C "$ROOT/deploy" -cf - polytronx |
  ssh "$HOST" 'cd /opt/polytronx/executor && cp -a deploy/polytronx "deploy/polytronx.bak-$(date +%Y%m%dT%H%M%S)" && tar -C deploy -xf - && chmod +x deploy/polytronx/*.sh'
ssh "$HOST" 'set -e; cd /opt/polytronx/executor
TS=$(date +%Y%m%dT%H%M%S); IMG=open-inspect-vps-executor:ship-$TS
docker build -q -t "$IMG" --label io.polytronx.node-image="$(grep -m1 "^ARG NODE_IMAGE=" build/vps-executor.new/Dockerfile | cut -d= -f2-)" build/vps-executor.new >/dev/null
ID=$(docker image inspect "$IMG" --format "{{.Id}}")
bash deploy/polytronx/workspace-slots.sh --check >/dev/null 2>&1 || bash deploy/polytronx/workspace-slots.sh --apply
cp executor-release.env "executor-release.env.bak-$TS"
sed -i "s|^EXECUTOR_IMAGE=.*|EXECUTOR_IMAGE=$IMG|; s|^EXECUTOR_IMAGE_ID=.*|EXECUTOR_IMAGE_ID=$ID|" executor-release.env
bash deploy/polytronx/deploy-executor.sh --release executor-release.env --secrets-dir secrets --state-dir state --confirm polytronx-executor
curl -fsS http://127.0.0.1:8787/v1/health; echo'
