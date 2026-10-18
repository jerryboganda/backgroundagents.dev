#!/usr/bin/env bash
#
# Restores a backup into the isolated rehearsal project and checks the result.
# The live project is never touched. The rehearsal has its own name, volumes,
# networks and secrets directory, publishes no ports, and has no route out.
# The script refuses any project name except polytronx-openinspect-rehearsal
# with an optional suffix, and it refuses the live secrets directory. A
# rehearsal that already holds volumes is refused unless --reset is given, and
# --reset removes only the rehearsal project's own volumes.
#
#   restore-rehearsal.sh --backup <dir> --key-file <file> --release <rehearsal-release.env> \
#     --secrets-dir <rehearsal secrets dir> --project polytronx-openinspect-rehearsal \
#     --confirm polytronx-openinspect-rehearsal [--reset]
#
# The rehearsal release file is the backup's release.env with POLYTRONX_SECRETS_DIR
# set to the rehearsal secrets directory. This script fills that directory from
# the backup's encrypted secrets archive, because restored records are encrypted
# with the production keys.

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

BACKUP=""
KEY_FILE=""
RELEASE_FILE=""
SECRETS_DIR=""
PROJECT=""
CONFIRM=""
RESET=0
FAILURES=0

usage() {
  grep '^#   ' "$0" | sed 's/^#   //' >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --backup) BACKUP="${2:?--backup needs a path}"; shift 2 ;;
    --key-file) KEY_FILE="${2:?--key-file needs a path}"; shift 2 ;;
    --release) RELEASE_FILE="${2:?--release needs a path}"; shift 2 ;;
    --secrets-dir) SECRETS_DIR="${2:?--secrets-dir needs a path}"; shift 2 ;;
    --project) PROJECT="${2:?--project needs a name}"; shift 2 ;;
    --confirm) CONFIRM="${2:-}"; shift 2 ;;
    --reset) RESET=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage; die "unknown argument: $1" ;;
  esac
done
[ -n "$BACKUP" ] && [ -n "$KEY_FILE" ] && [ -n "$RELEASE_FILE" ] && [ -n "$SECRETS_DIR" ] && [ -n "$PROJECT" ] ||
  { usage; die "missing a required option"; }

# Guards: the target is the rehearsal, never the live project or its secrets.
[[ "$PROJECT" =~ ^polytronx-openinspect-rehearsal(-[a-z0-9]{1,20})?$ ]] ||
  die "rehearsal project must be polytronx-openinspect-rehearsal with an optional -suffix"
[ "$CONFIRM" = "$PROJECT" ] || die "pass --confirm $PROJECT to restore into the rehearsal project"
# Compared canonically, so a trailing slash, a doubled slash or a relative spelling cannot pass.
secrets_canonical="$(realpath -m -- "$SECRETS_DIR")" || die "cannot resolve the rehearsal secrets directory"
live_canonical="$(realpath -m -- "$LIVE_SECRETS_DIR")" || die "cannot resolve the live secrets directory"
[ "$secrets_canonical" != "$live_canonical" ] ||
  die "the rehearsal secrets directory must not be the live secrets directory"

require_cmd docker openssl tar sha256sum
[ -f "$BACKUP/SHA256SUMS" ] || die "backup has no SHA256SUMS: $BACKUP"
(cd "$BACKUP" && sha256sum -c SHA256SUMS >/dev/null) || die "backup checksums do not match; nothing was restored"
[ -s "$KEY_FILE" ] || die "backup key file missing or empty"
case "$(stat -c '%a' "$KEY_FILE")" in
  600 | 400) ;;
  *) die "backup key file must be mode 600 or 400" ;;
esac

umask 077
load_release_file "$RELEASE_FILE"
[ "$POLYTRONX_SECRETS_DIR" = "$SECRETS_DIR" ] ||
  die "POLYTRONX_SECRETS_DIR in the rehearsal release must equal --secrets-dir"
# The rehearsal mounts the public CA read-only, from a path that must not be in the live secrets directory.
# The file is read, not the environment, which a caller's shell could have set.
ca_file="$(env_value POLYTRONX_EXECUTOR_CA_FILE "$RELEASE_FILE")"
[ -n "$ca_file" ] ||
  die "the rehearsal release must name POLYTRONX_EXECUTOR_CA_FILE, a public CA copy outside the live secrets directory (runbooks/backup-and-restore.md)"
ca_canonical="$(realpath -m -- "$ca_file")" || die "cannot resolve POLYTRONX_EXECUTOR_CA_FILE"
case "$ca_canonical" in
  "$live_canonical"/*) die "POLYTRONX_EXECUTOR_CA_FILE names a file in the live secrets directory; copy the public ca.crt elsewhere for the rehearsal" ;;
esac

pass() { printf 'PASS  %s\n' "$*"; }
fail() {
  printf 'FAIL  %s\n' "$*"
  FAILURES=$((FAILURES + 1))
}

rehearsal_compose() {
  docker compose -p "$PROJECT" --env-file "$RELEASE_FILE" -f "$COMPOSE_FILE" -f "$REHEARSAL_OVERLAY" "$@"
}

decrypt() { # $1 archive; plaintext to stdout
  openssl enc -d "${BACKUP_CIPHER[@]}" -pass "file:$KEY_FILE" -in "$1"
}

existing_volumes="$(docker volume ls -q | grep "^${PROJECT}_" || true)"
if [ -n "$existing_volumes" ]; then
  [ "$RESET" -eq 1 ] || die "rehearsal volumes already exist; rerun with --reset to remove only those"
  info "resetting the rehearsal project (its own volumes only)"
  rehearsal_compose down -v
fi

# The rehearsal secrets come first: compose create reads each service's env_file, so they must exist
# before it runs. They are restored from the backup, and their contents are never printed.
mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"
decrypt "$BACKUP/secrets.tar.enc" | tar -C "$SECRETS_DIR" -xf -
info "restored secrets into the rehearsal secrets directory (contents not printed)"

load_release_file "$DEPLOY_DIR/pins.env"
pull_third_party_images || die "could not pull a pinned third-party image; no volume was restored"
problem="$(third_party_image_problem)"
[ -z "$problem" ] || die "$problem"

rehearsal_compose create >/dev/null

# Volumes are filled through helper containers with no network and only the capabilities named
# capabilities, streaming the decrypted archive on stdin. No plaintext archive
# touches the host's disk.
restore_volume() { # $1 short name, $2 archive file name
  [ -f "$BACKUP/$2" ] || die "backup is missing $2"
  docker run --rm -i --network none --user 0:0 --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
    --security-opt no-new-privileges --entrypoint tar \
    -v "${PROJECT}_$1:/dst" "$CONTROL_PLANE_IMAGE" -C /dst -xf - < <(decrypt "$BACKUP/$2")
  info "restored volume $1"
}
restore_volume control-plane-data control-plane-data.tar.enc
restore_volume object-store-data object-store-data.tar.enc

rehearsal_compose up -d --wait --wait-timeout 420 --pull never

expected_migrations="$(grep '^migrations_latest=' "$BACKUP/MANIFEST.env" | cut -d= -f2-)"
expected_sessions="$(grep '^session_db_count=' "$BACKUP/MANIFEST.env" | cut -d= -f2-)"

health="$(rehearsal_compose exec -T app node -e \
  "fetch('http://127.0.0.1:8787/healthz').then((r) => r.json()).then((b) => { console.log(JSON.stringify({ status: b.status, migrations_applied: b.migrations_applied })); process.exit(b.status === 'ok' ? 0 : 1); }, () => process.exit(1))" 2>/dev/null || true)"
if grep -q '"status":"ok"' <<<"$health"; then
  pass "restored control plane reports ok ($health)"
else
  fail "restored control plane did not report ok"
fi

ledger_max="$(rehearsal_compose exec -T app node -e \
  "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync('/data/global.db', { readOnly: true }); console.log(db.prepare('SELECT MAX(version) AS v FROM _schema_migrations').get().v);" 2>/dev/null | tr -d '\r' || true)"
if [ "$ledger_max" = "$expected_migrations" ]; then
  pass "restored migration ledger ends at $ledger_max, as the backup recorded"
else
  fail "restored ledger ends at '${ledger_max:-none}', backup recorded '$expected_migrations'"
fi

sessions_now="$(rehearsal_compose exec -T app node -e \
  "const fs = require('fs'); const d = '/data/sessions'; console.log(fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.db')).length : 0);" 2>/dev/null | tr -d '\r' || echo 0)"
if [ "$sessions_now" = "$expected_sessions" ]; then
  pass "restored session databases: $sessions_now, as the backup recorded"
else
  fail "restored session databases: $sessions_now, backup recorded $expected_sessions"
fi

if rehearsal_compose exec -T web node -e \
  "fetch('http://127.0.0.1:3000/').then((r) => process.exit(r.status < 500 ? 0 : 1), () => process.exit(1))"; then
  pass "restored web answers inside the rehearsal network"
else
  fail "restored web did not answer"
fi

if rehearsal_compose exec -T object-store curl -sf -o /dev/null http://localhost:9000/healthz; then
  pass "restored object store answers"
else
  fail "restored object store did not answer"
fi

# Containment: the restored control plane must reach no live provider, by HTTP or by name.
# Every probe is expected to fail, because the rehearsal networks are internal and have no
# route out. A probe that succeeds, or any HTTP answer, means the rehearsal is not contained.
probe_blocked() { # $1 URL; exits 0 when the request fails
  rehearsal_compose exec -T app node -e \
    "fetch('$1', { signal: AbortSignal.timeout(5000) }).then(() => process.exit(1), () => process.exit(0))"
}
for url in https://api.github.com/ https://api.modal.com/; do
  if probe_blocked "$url"; then
    pass "rehearsal control plane cannot reach $url (no route out)"
  else
    fail "rehearsal control plane reached $url; stop the rehearsal project now"
  fi
done
if rehearsal_compose exec -T app node -e \
  "require('dns').lookup('api.github.com', (error) => process.exit(error ? 0 : 1))"; then
  pass "rehearsal control plane cannot resolve api.github.com"
else
  fail "rehearsal control plane resolved api.github.com; stop the rehearsal project now"
fi

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "rehearsal restore: all checks passed in project $PROJECT"
else
  echo "rehearsal restore: $FAILURES check(s) failed in project $PROJECT"
  exit 1
fi
