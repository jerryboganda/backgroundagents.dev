#!/usr/bin/env bash
#
# Post-deploy checks for the live project. Read-only: it requests the loopback
# health endpoints and reads container state, configuration flags and logs.
# Each check prints PASS, WARN or FAIL. Exit status is 1 if any check fails.
#
#   smoke.sh --release <release.env>
#
# This does not prove sign-in, WebSocket streaming, a Modal sandbox, a provider
# account, or a pull request. Those need an account or a browser, and they are
# owner-run checks listed in runbooks/evidence-register.md.

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

RELEASE_FILE=""
FAILURES=0

usage() {
  grep '^#   ' "$0" | sed 's/^#   //' >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --release) RELEASE_FILE="${2:?--release needs a path}"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) usage; die "unknown argument: $1" ;;
  esac
done
[ -n "$RELEASE_FILE" ] || { usage; die "--release is required"; }

require_cmd docker curl grep
load_release_file "$RELEASE_FILE"

pass() { printf 'PASS  %s\n' "$*"; }
warn_check() { printf 'WARN  %s\n' "$*"; }
fail() {
  printf 'FAIL  %s\n' "$*"
  FAILURES=$((FAILURES + 1))
}

# ---------------------------------------------------------------------------
# Containers: each service healthy (or running, where it has no healthcheck).
# ---------------------------------------------------------------------------
service_rows="$(docker ps --filter "label=com.docker.compose.project=$LIVE_PROJECT" \
  --format '{{.Label "com.docker.compose.service"}}|{{.Status}}|{{.Ports}}' || true)"

services=(app web object-store)
[ -z "${DOCS_IMAGE:-}" ] || services+=(docs)
for service in "${services[@]}"; do
  row="$(grep "^${service}|" <<<"$service_rows" || true)"
  if [[ "$row" == *"(healthy)"* ]]; then
    pass "$service is healthy"
  else
    fail "$service is not healthy: ${row:-not running}"
  fi
done
if grep -q '^litestream|Up' <<<"$service_rows"; then
  pass "litestream is running"
else
  fail "litestream is not running"
fi

# The object store must not be reachable from the host or the internet.
if grep '^object-store|' <<<"$service_rows" | grep -q '127.0.0.1\|0.0.0.0\|->'; then
  fail "object-store publishes a port; it must stay on the internal network"
else
  pass "object-store publishes no port"
fi

# ---------------------------------------------------------------------------
# Endpoints on loopback.
# ---------------------------------------------------------------------------
health="$(curl -fsS --max-time 10 "http://127.0.0.1:${CONTROL_PLANE_LOOPBACK_PORT}/healthz" 2>/dev/null || true)"
if grep -q '"status":"ok"' <<<"$health"; then
  migrations="$(grep -o '"migrations_applied":[0-9]*' <<<"$health" | cut -d: -f2 || true)"
  pass "control plane /healthz reports ok (migrations_applied=${migrations:-?})"
else
  fail "control plane /healthz did not report status ok"
fi

web_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:${WEB_LOOPBACK_PORT}/" || true)"
case "$web_code" in
  2?? | 3?? | 401 | 403) pass "web answers on loopback (HTTP $web_code)" ;;
  *) fail "web did not answer on loopback (HTTP ${web_code:-none})" ;;
esac
if [ -n "${DOCS_IMAGE:-}" ]; then
  docs_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:${DOCS_LOOPBACK_PORT}/" || true)"
  case "$docs_code" in
    2??) pass "docs answers on loopback (HTTP $docs_code)" ;;
    *) fail "docs did not answer on loopback (HTTP ${docs_code:-none})" ;;
  esac
fi

# ---------------------------------------------------------------------------
# Configuration and resource limits, read from container metadata.
# ---------------------------------------------------------------------------
app_id="$(docker ps -q --filter "label=com.docker.compose.project=$LIVE_PROJECT" \
  --filter "label=com.docker.compose.service=app" | head -n1)"
if [ -n "$app_id" ]; then
  if docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$app_id" |
    grep -q -x 'UNSAFE_ALLOW_ALL_USERS=true'; then
    fail "UNSAFE_ALLOW_ALL_USERS=true is in the control plane's environment"
  else
    pass "UNSAFE_ALLOW_ALL_USERS is not enabled in the control plane"
  fi
  restarts="$(docker inspect -f '{{.RestartCount}}' "$app_id")"
  if [ "$restarts" -eq 0 ]; then
    pass "control plane has not restarted"
  else
    warn_check "control plane has restarted $restarts time(s); read its logs"
  fi
fi

while read -r cid; do
  [ -n "$cid" ] || continue
  name="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$cid")"
  limits="$(docker inspect -f '{{.HostConfig.Memory}} {{.HostConfig.PidsLimit}} {{.HostConfig.NanoCpus}}' "$cid")"
  read -r mem pids nano <<<"$limits"
  if [ "$mem" -gt 0 ] && [ "$pids" -gt 0 ] && [ "$nano" -gt 0 ]; then
    pass "$name has memory, CPU and PID limits"
  else
    fail "$name is missing a memory, CPU or PID limit"
  fi
done < <(docker ps -q --filter "label=com.docker.compose.project=$LIVE_PROJECT")

# ---------------------------------------------------------------------------
# Logs: a count of credential-shaped strings, never their text.
# ---------------------------------------------------------------------------
leaks="$(live_compose logs --no-color --tail 2000 2>&1 |
  grep -c -E 'BEGIN [A-Z ]*PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}' || true)"
if [ "${leaks:-0}" -eq 0 ]; then
  pass "recent logs contain no credential-shaped strings"
else
  fail "recent logs contain $leaks credential-shaped line(s); scrub and rotate before sharing logs"
fi

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "smoke: all checks passed"
else
  echo "smoke: $FAILURES check(s) failed"
  exit 1
fi
