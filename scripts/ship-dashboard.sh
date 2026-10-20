#!/usr/bin/env bash
# One-command dashboard deploy: ships the committed tree (LF endings) to the VPS, installs
# it there and runs the repo's own deployment steps on the host. No CI. Commit first: it
# ships HEAD.
#
# The CI path is .github/workflows/ssh-deploy-dashboard.yml. Both call the same host
# script, deploy/polytronx/host-dashboard-deploy.sh, so there is one deployment.
#
# Usage: bash scripts/ship-dashboard.sh [ssh-host]
set -euo pipefail
HOST="${1:-vps}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
[ -z "$(git status --porcelain)" ] || { echo "commit your changes first: this ships HEAD" >&2; exit 1; }
SHA="$(git rev-parse HEAD)"
# The staging directory belongs to the account the operator logs in as, and the host's
# root entry point reads it from there.
REMOTE_HOME="$(ssh "$HOST" 'printf %s "$HOME"')"
STAGE="$REMOTE_HOME/.polytronx/staging/$SHA"
ssh "$HOST" "set -e; rm -rf '$STAGE'; mkdir -p '$STAGE'; chmod 700 '$STAGE'"
git -c core.autocrlf=false -c core.eol=lf archive --format=tar HEAD | ssh "$HOST" "tar -xf - -C '$STAGE'"
ssh "$HOST" "set -e; bash '$STAGE/deploy/polytronx/host-dashboard-deploy.sh' --staged '$STAGE' --root /opt/polytronx/openinspect --revision '$SHA' --deploy"
