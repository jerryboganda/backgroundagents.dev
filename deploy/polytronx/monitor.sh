#!/usr/bin/env bash
#
# Recurring health and hygiene checks for the live project, for a systemd timer
# or cron. Read-only. It prints one line per check. When any check needs
# attention it runs ALERT_HOOK, if set, with the summary on stdin, and exits 2.
#
#   ALERT_HOOK=/opt/polytronx/openinspect/bin/notify \
#     monitor.sh --release <release.env> --secrets-dir <dir> --backup-key <file>
#
# Checks: disk use on the Docker data filesystem (as the engine reports its data
# root) and the root filesystem; unhealthy or restarting services; days until the
# certificate served for ai and cp expires; permissions on the secrets directory,
# its files, and the backup key; and, with --backup-dir, the age of the newest
# periodic backup. The served certificate may be the edge's, not the origin's.
# Check the proxy's own certificate expiry too (runbooks/accounts-and-admission.md).
#
#   ALERT_HOOK=/opt/polytronx/openinspect/bin/notify \
#     monitor.sh --release <release.env> --secrets-dir <dir> --backup-key <file> \
#     [--backup-dir <dir>]

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

RELEASE_FILE=""
SECRETS_DIR=""
BACKUP_KEY=""
BACKUP_DIR=""
DISK_ALERT_PERCENT="${DISK_ALERT_PERCENT:-85}"
CERT_ALERT_DAYS="${CERT_ALERT_DAYS:-14}"
BACKUP_MAX_AGE_HOURS="${BACKUP_MAX_AGE_HOURS:-36}"
ALERTS=()

usage() {
  grep '^#   ' "$0" | sed 's/^#   //' >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --release) RELEASE_FILE="${2:?--release needs a path}"; shift 2 ;;
    --secrets-dir) SECRETS_DIR="${2:?--secrets-dir needs a path}"; shift 2 ;;
    --backup-key) BACKUP_KEY="${2:?--backup-key needs a path}"; shift 2 ;;
    --backup-dir) BACKUP_DIR="${2:?--backup-dir needs a path}"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) usage; die "unknown argument: $1" ;;
  esac
done
[ -n "$RELEASE_FILE" ] && [ -n "$SECRETS_DIR" ] && [ -n "$BACKUP_KEY" ] || { usage; die "missing a required option"; }

require_cmd docker df awk openssl date find
load_release_file "$RELEASE_FILE"

alert() {
  ALERTS+=("$*")
  printf 'ALERT %s\n' "$*"
}
ok() { printf 'OK    %s\n' "$*"; }

docker_root="$(docker_root_path)"
mounts=(/)
if [ -n "$docker_root" ]; then
  mounts=("$docker_root" /)
else
  alert "the engine's Docker data root could not be read"
fi
for mount in "${mounts[@]}"; do
  used="$(filesystem_used_percent "$mount")"
  if [ -z "$used" ]; then
    alert "disk usage unreadable for $mount"
  elif [ "$used" -ge "$DISK_ALERT_PERCENT" ]; then
    alert "disk $mount is ${used}% full (threshold ${DISK_ALERT_PERCENT}%)"
  else
    ok "disk $mount ${used}% used"
  fi
done

if [ -n "$BACKUP_DIR" ]; then
  age_hours="$(newest_periodic_backup_age_hours "$BACKUP_DIR")"
  if [ -z "$age_hours" ]; then
    alert "no periodic backup in $BACKUP_DIR; the backup timer may not be running"
  elif [ "$age_hours" -gt "$BACKUP_MAX_AGE_HOURS" ]; then
    alert "newest periodic backup is ${age_hours} h old (limit ${BACKUP_MAX_AGE_HOURS} h)"
  else
    ok "newest periodic backup is ${age_hours} h old"
  fi
fi

unhealthy="$(docker ps --filter "label=com.docker.compose.project=$LIVE_PROJECT" \
  --filter health=unhealthy --format '{{.Label "com.docker.compose.service"}}' | tr '\n' ' ')"
restarting="$(docker ps --filter "label=com.docker.compose.project=$LIVE_PROJECT" \
  --filter status=restarting --format '{{.Label "com.docker.compose.service"}}' | tr '\n' ' ')"
if [ -n "$unhealthy$restarting" ]; then
  alert "services unhealthy: ${unhealthy:-none}; restarting: ${restarting:-none}"
else
  ok "no unhealthy or restarting services in $LIVE_PROJECT"
fi

for host in ai.polytronx.com cp.ai.polytronx.com; do
  not_after="$(echo | timeout 10 openssl s_client -servername "$host" -connect "$host:443" 2>/dev/null |
    openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2- || true)"
  if [ -z "$not_after" ]; then
    alert "no certificate could be read from $host:443"
    continue
  fi
  days_left=$(( ($(date -d "$not_after" +%s) - $(date +%s)) / 86400 ))
  if [ "$days_left" -lt "$CERT_ALERT_DAYS" ]; then
    alert "certificate for $host expires in $days_left day(s)"
  else
    ok "certificate for $host valid for $days_left more day(s)"
  fi
done

if [ -d "$SECRETS_DIR" ] && [ "$(stat -c '%a' "$SECRETS_DIR")" != "700" ]; then
  alert "secrets directory is not mode 700"
fi
for file in control-plane.env web.env storage.env; do
  problem="$(secret_file_problem "$SECRETS_DIR/$file")"
  [ -z "$problem" ] || alert "$problem"
done
if [ -f "$BACKUP_KEY" ] && [[ "$(stat -c '%a' "$BACKUP_KEY")" =~ ^(600|400)$ ]]; then
  ok "backup key is owner-only"
else
  alert "backup key is missing or not owner-only"
fi

if [ "${#ALERTS[@]}" -eq 0 ]; then
  echo "monitor: no alerts"
  exit 0
fi
summary="$(printf '%s\n' "${ALERTS[@]}")"
if [ -n "${ALERT_HOOK:-}" ]; then
  printf 'PolytronX OpenInspect monitor\n%s\n' "$summary" | "$ALERT_HOOK" || warn "alert hook failed"
fi
exit 2
