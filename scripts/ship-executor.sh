#!/usr/bin/env bash
# One-command executor deploy: ships the executor package and the deployment scripts to
# the Linode, installs them there and runs the repo's own deployment steps on the host.
# No CI, no tests. Commit first: it ships HEAD, and the image is tagged with that
# revision.
#
# The CI path is .github/workflows/ssh-deploy-executor.yml. Both call the same host
# script, deploy/polytronx/host-executor-deploy.sh, so there is one deployment.
#
# Usage: bash scripts/ship-executor.sh [ssh-host]
set -euo pipefail
HOST="${1:-linode-executor}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
[ -z "$(git status --porcelain)" ] || { echo "commit your changes first: this ships HEAD" >&2; exit 1; }
SHA="$(git rev-parse HEAD)"
# The staging directory belongs to the account the operator logs in as, and the host's
# root entry point reads it from there.
REMOTE_HOME="$(ssh "$HOST" 'printf %s "$HOME"')"
STAGE="$REMOTE_HOME/.polytronx/staging/$SHA"
ssh "$HOST" "set -e; rm -rf '$STAGE'; mkdir -p '$STAGE'; chmod 700 '$STAGE'"
git -c core.autocrlf=false -c core.eol=lf archive --format=tar HEAD \
  packages/vps-executor deploy/polytronx | ssh "$HOST" "tar -xf - -C '$STAGE'"
ssh "$HOST" "set -e; bash '$STAGE/deploy/polytronx/host-executor-deploy.sh' --staged '$STAGE' --root /opt/polytronx/executor --revision '$SHA' --deploy"
