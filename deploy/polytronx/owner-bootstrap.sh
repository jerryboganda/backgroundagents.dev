#!/usr/bin/env bash
#
# Runs the Node owner bootstrap inside the live control plane's image, against
# the live global store. A dry run is the default. --execute commits the change.
#
# Before the first run the user must have signed in once, so the canonical
# user exists, and the RBAC migrations must be recorded. The bootstrap writes one
# audit row and one role change in one transaction, and it refuses while another
# unsuspended Owner exists. Run the dry run, read its report, then run again with --execute.
#
#   owner-bootstrap.sh --release <release.env> --source <dir> --user <32-hex-id> [--execute]

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

RELEASE_FILE=""
SOURCE_DIR=""
USER_ID=""
EXECUTE=0

usage() {
  grep '^#   ' "$0" | sed 's/^#   //' >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --release) RELEASE_FILE="${2:?--release needs a path}"; shift 2 ;;
    --source) SOURCE_DIR="${2:?--source needs a path}"; shift 2 ;;
    --user) USER_ID="${2:?--user needs a value}"; shift 2 ;;
    --execute) EXECUTE=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage; die "unknown argument: $1" ;;
  esac
done
[ -n "$RELEASE_FILE" ] && [ -n "$SOURCE_DIR" ] && [ -n "$USER_ID" ] || { usage; die "--release, --source and --user are required"; }
[[ "$USER_ID" =~ ^[0-9a-f]{32}$ ]] || die "--user must be the 32-character lowercase canonical user ID"
[ -f "$SOURCE_DIR/scripts/bootstrap-node-owner.ts" ] || die "scripts/bootstrap-node-owner.ts is missing from --source"

require_cmd docker
load_release_file "$RELEASE_FILE"

mode_args=()
if [ "$EXECUTE" -eq 1 ]; then
  mode_args+=(--execute)
fi

# The bootstrap runs with the control plane's own Node and volume. Its scripts
# are mounted read-only and the service's default entrypoint is replaced, so
# the container never starts the application or runs a migration.
live_compose run --rm --no-deps --entrypoint node \
  -v "$SOURCE_DIR/scripts:/opt/openinspect/scripts:ro" \
  app --experimental-transform-types /opt/openinspect/scripts/bootstrap-node-owner.ts \
  --database /data/global.db --user "$USER_ID" "${mode_args[@]}"
