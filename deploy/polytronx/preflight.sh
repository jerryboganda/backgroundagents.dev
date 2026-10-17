#!/usr/bin/env bash
#
# Read-only preflight for the PolytronX deployment. Run it on the VPS before
# deploy.sh, and after any host change. It changes nothing on the host: no pulls,
# no networks, no containers, no volumes. Its one network request is a GET of the
# Modal provider's api-health, which carries no credential, for the provider cap
# gate. It prints PASS, WARN or FAIL for each check and exits 1 if any check
# fails. Secret values are never printed; they are checked by name, shape and,
# for the two shared secrets, by hash.
#
#   preflight.sh --release <release.env> --secrets-dir <dir> --source <dir>
#
# --source is the pinned upstream checkout (git archive of UPSTREAM_REVISION)
# that the Litestream configuration is mounted from.

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

RELEASE_FILE=""
SECRETS_DIR=""
SOURCE_DIR=""
FAILURES=0

usage() {
  sed -n '3,14p' "$0" | sed 's/^# \{0,1\}//'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --release) RELEASE_FILE="${2:?--release needs a path}"; shift 2 ;;
    --secrets-dir) SECRETS_DIR="${2:?--secrets-dir needs a path}"; shift 2 ;;
    --source) SOURCE_DIR="${2:?--source needs a path}"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ -n "$RELEASE_FILE" ] && [ -n "$SECRETS_DIR" ] && [ -n "$SOURCE_DIR" ] || {
  usage >&2
  die "--release, --secrets-dir and --source are required"
}

pass() { printf 'PASS  %s\n' "$*"; }
warn_check() { printf 'WARN  %s\n' "$*"; }
fail() {
  printf 'FAIL  %s\n' "$*"
  FAILURES=$((FAILURES + 1))
}

# ---------------------------------------------------------------------------
# Host tools and engine versions.
# ---------------------------------------------------------------------------
for cmd in docker ss curl openssl sha256sum stat df awk getent flock; do
  if command -v "$cmd" >/dev/null 2>&1; then
    pass "tool present: $cmd"
  else
    fail "tool missing: $cmd"
  fi
done

if engine="$(docker version --format '{{.Server.Version}}' 2>/dev/null)" && [ -n "$engine" ]; then
  # start_interval in the object-store healthcheck needs Docker Engine 25 or newer.
  if [ "${engine%%.*}" -ge 25 ]; then
    pass "Docker Engine $engine (25 or newer)"
  else
    fail "Docker Engine $engine is older than 25; the object-store healthcheck needs start_interval"
  fi
else
  fail "Docker Engine is not reachable as this user"
fi

compose_version="$(docker compose version --short 2>/dev/null || true)"
if [[ "$compose_version" =~ ^([0-9]+)\.([0-9]+) ]] &&
  { [ "${BASH_REMATCH[1]}" -gt 2 ] || { [ "${BASH_REMATCH[1]}" -eq 2 ] && [ "${BASH_REMATCH[2]}" -ge 24 ]; }; }; then
  pass "Compose $compose_version (2.24 or newer, for !override)"
else
  fail "Compose v2.24 or newer is required (found: ${compose_version:-none})"
fi

# ---------------------------------------------------------------------------
# Pins, release file and images.
# ---------------------------------------------------------------------------
load_release_file "$DEPLOY_DIR/pins.env"
load_release_file "$RELEASE_FILE"

missing="$(missing_release_values \
  OPEN_INSPECT_REVISION OVERLAY_REVISION MIGRATIONS_LATEST \
  CONTROL_PLANE_IMAGE CONTROL_PLANE_IMAGE_ID WEB_IMAGE WEB_IMAGE_ID \
  POLYTRONX_SECRETS_DIR POLYTRONX_SOURCE_DIR POLYTRONX_EDGE_NETWORK \
  CONTROL_PLANE_LOOPBACK_PORT WEB_LOOPBACK_PORT OBJECT_STORE_BUCKET LITESTREAM_BUCKET)"
if [ -z "$missing" ]; then
  pass "release file has every required value"
else
  fail "release file has unset or placeholder values: $(echo "$missing" | tr '\n' ' ')"
fi

if is_revision "${OPEN_INSPECT_REVISION:-}" && [ "${OPEN_INSPECT_REVISION:-}" = "$UPSTREAM_REVISION" ]; then
  pass "release is the pinned upstream revision ${UPSTREAM_REVISION:0:12}"
else
  fail "OPEN_INSPECT_REVISION must equal UPSTREAM_REVISION in pins.env"
fi

for pair in CONTROL_PLANE WEB; do
  ref_var="${pair}_IMAGE"
  id_var="${pair}_IMAGE_ID"
  if ! is_image_id "${!id_var:-}"; then
    fail "$id_var must be sha256 followed by 64 lowercase hex characters"
    continue
  fi
  if actual="$(docker image inspect -f '{{.Id}}' "${!ref_var:-}" 2>/dev/null)"; then
    if [ "$actual" = "${!id_var}" ]; then
      pass "$pair image matches its recorded ID"
    else
      fail "$pair image ID differs from $id_var; the reference no longer names the verified build"
    fi
  else
    fail "$pair image is not on this host; load the verified archive before deploying"
  fi
done

third_party_problem="$(third_party_image_problem)"
if [ -z "$third_party_problem" ]; then
  pass "pinned third-party images are on this host with their pinned digests"
else
  fail "$third_party_problem; deploy.sh pulls the pinned images before preflight"
fi

if [ -f "$DEPLOY_DIR/compose.production.yml" ] && live_compose config --quiet >/dev/null 2>&1; then
  pass "compose renders with this release (required values set, env files present)"
else
  fail "compose does not render with this release; run: docker compose ... config (values not shown)"
fi

# ---------------------------------------------------------------------------
# Secrets: names, shape, permissions, and the one parity rule that spans files.
# ---------------------------------------------------------------------------
if [ -d "$SECRETS_DIR" ]; then
  case "$(stat -c '%a' "$SECRETS_DIR")" in
    700 | 500) pass "secrets directory is owner-only" ;;
    *) fail "secrets directory must be mode 700" ;;
  esac
else
  fail "secrets directory missing: $SECRETS_DIR"
fi

check_secrets() {
  local file="$1"
  shift
  local problem
  problem="$(secret_file_problem "$SECRETS_DIR/$file" "$@")"
  if [ -z "$problem" ]; then
    pass "$file has every required key"
  else
    fail "$problem"
  fi
}
check_secrets control-plane.env \
  DEPLOYMENT_NAME GITHUB_BOT_USERNAME WORKER_URL WEB_APP_URL MODAL_WORKSPACE \
  TOKEN_ENCRYPTION_KEY PROVIDER_ACCOUNTS_ENCRYPTION_KEY REPO_SECRETS_ENCRYPTION_KEY \
  BROWSER_AUTH_SECRET IMAGE_CALLBACK_TOKEN_PEPPER SERVICE_AUTH_SECRET_WEB \
  GITHUB_APP_ID GITHUB_APP_INSTALLATION_ID GITHUB_APP_PRIVATE_KEY \
  GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET MODAL_API_SECRET
check_secrets web.env SERVICE_AUTH_SECRET
check_secrets storage.env AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY \
  LITESTREAM_ACCESS_KEY_ID LITESTREAM_SECRET_ACCESS_KEY

if [ -f "$SECRETS_DIR/control-plane.env" ]; then
  if grep -q -E '^UNSAFE_ALLOW_ALL_USERS=true' "$SECRETS_DIR/control-plane.env"; then
    fail "UNSAFE_ALLOW_ALL_USERS=true is set; production admission must stay restricted"
  else
    pass "UNSAFE_ALLOW_ALL_USERS is not enabled"
  fi
  if grep -q -E '^TEAMS_ENFORCEMENT=on$' "$SECRETS_DIR/control-plane.env"; then
    pass "TEAMS_ENFORCEMENT=on"
  else
    warn_check "TEAMS_ENFORCEMENT is not set to on; the upstream default is shadow"
  fi
fi

# The web's SERVICE_AUTH_SECRET must equal the control plane's SERVICE_AUTH_SECRET_WEB.
# Both values are hashed here; neither is printed or kept.
if [ -f "$SECRETS_DIR/web.env" ] && [ -f "$SECRETS_DIR/control-plane.env" ]; then
  web_hash="$(grep -m1 '^SERVICE_AUTH_SECRET=' "$SECRETS_DIR/web.env" | cut -d= -f2- | sha256sum | cut -d' ' -f1)"
  cp_hash="$(grep -m1 '^SERVICE_AUTH_SECRET_WEB=' "$SECRETS_DIR/control-plane.env" | cut -d= -f2- | sha256sum | cut -d' ' -f1)"
  if [ "$web_hash" = "$cp_hash" ]; then
    pass "web SERVICE_AUTH_SECRET matches control-plane SERVICE_AUTH_SECRET_WEB"
  else
    fail "web SERVICE_AUTH_SECRET does not match control-plane SERVICE_AUTH_SECRET_WEB"
  fi
fi

# The source tree is a git archive, so it has no .git. deploy.sh and the CI
# artifact write its revision to REVISION, which must be the pinned commit.
if [ "$(cat "$POLYTRONX_SOURCE_DIR/REVISION" 2>/dev/null || true)" = "$UPSTREAM_REVISION" ]; then
  pass "pinned source tree is at ${UPSTREAM_REVISION:0:12}"
else
  fail "POLYTRONX_SOURCE_DIR/REVISION is not the pinned upstream revision"
fi
if [ -f "$POLYTRONX_SOURCE_DIR/packages/control-plane/docker/litestream.yml" ] &&
  [ -f "$SOURCE_DIR/packages/control-plane/docker/litestream.yml" ]; then
  pass "Litestream configuration is present in the source tree"
else
  fail "packages/control-plane/docker/litestream.yml is missing from the source tree"
fi

# ---------------------------------------------------------------------------
# Provider cap gate. Provisioning must not be enabled unless the Modal provider
# reports the sandbox cap this deployment expects, with pre-create enforcement.
# A missing endpoint, a null or different value, or any other answer is a blocker.
# ---------------------------------------------------------------------------
cap_problem="$(provider_cap_problem "$SECRETS_DIR/control-plane.env")"
if [ -z "$cap_problem" ]; then
  pass "provider reports max_active_sandboxes=$PROVIDER_MAX_ACTIVE_SANDBOXES with pre-create enforcement"
else
  fail "provider cap gate: $cap_problem; the deploy stops before provisioning is enabled"
fi

# ---------------------------------------------------------------------------
# Ports, networks and the existing estate. Read-only: nothing is created here.
# ---------------------------------------------------------------------------
live_ports="$(docker ps --filter "label=com.docker.compose.project=$LIVE_PROJECT" --format '{{.Ports}}' 2>/dev/null || true)"
for port in "$CONTROL_PLANE_LOOPBACK_PORT" "$WEB_LOOPBACK_PORT"; do
  if [[ "$live_ports" == *"127.0.0.1:$port->"* ]]; then
    pass "loopback port $port is held by this project (re-deploy)"
  elif port_in_use "$port"; then
    fail "loopback port $port is in use by another service; choose a free one in release.env, do not stop that service"
  else
    pass "loopback port $port is free"
  fi
done

if docker network inspect "$POLYTRONX_EDGE_NETWORK" >/dev/null 2>&1; then
  pass "edge network $POLYTRONX_EDGE_NETWORK exists"
else
  warn_check "edge network $POLYTRONX_EDGE_NETWORK does not exist; deploy.sh creates it once, after confirmation"
fi

proxy_names="$(docker ps --format '{{.Names}}' | grep -i 'proxy' || true)"
if [ -n "$proxy_names" ]; then
  pass "existing proxy container(s) present (not modified here): $(echo "$proxy_names" | tr '\n' ' ')"
else
  warn_check "no proxy container found by name; confirm the ingress path before DNS changes"
fi

projects="$(docker ps -a --format '{{.Label "com.docker.compose.project"}}' | sort -u | grep -v '^$' | tr '\n' ' ' || true)"
pass "existing Compose projects (informational, untouched): ${projects:-none}"

disk_free_kb="$(docker_root_free_kb)"
if [ -n "$disk_free_kb" ] && [ "$disk_free_kb" -ge 10485760 ]; then
  pass "at least 10 GiB free on the filesystem of Docker's data root"
else
  fail "less than 10 GiB free on the filesystem of Docker's data root (or the engine's data root cannot be read)"
fi

mem_avail_kb="$(awk '/MemAvailable/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
if [ "$mem_avail_kb" -ge 4194304 ]; then
  pass "at least 4 GiB memory available"
else
  warn_check "less than 4 GiB memory available"
fi

for host in ai.polytronx.com cp.ai.polytronx.com; do
  resolved="$(getent ahostsv4 "$host" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' || true)"
  pass "DNS $host (informational): ${resolved:-no A record}"
done

# ---------------------------------------------------------------------------
echo
if [ "$FAILURES" -eq 0 ]; then
  echo "preflight: no blockers"
else
  echo "preflight: $FAILURES blocker(s); deploy.sh will not run"
  exit 1
fi
