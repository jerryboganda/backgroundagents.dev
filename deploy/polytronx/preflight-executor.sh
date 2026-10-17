#!/usr/bin/env bash
#
# Read-only preflight for the VPS executor host. Run it before deploy-executor.sh, and after any
# host change. It changes nothing: no pulls, networks, containers, volumes or firewall rules. It
# prints PASS, WARN or FAIL for each check and exits 1 if any check fails. Secret values are never
# printed; the executor token and admission secret are checked by name and length only.
#
#   preflight-executor.sh --release <executor-release.env> --secrets-dir <dir>
#
# Run as root. The sandbox network check reads the owned iptables chains and the oi-sandbox network.

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

RELEASE_FILE=""
SECRETS_DIR=""
FAILURES=0
EXECUTOR_PROJECT="polytronx-executor"
EXECUTOR_PORT=8787
DOCKER_SOCKET="/var/run/docker.sock"
# Kept free for the host itself: the OS, dockerd, the proxy and the executor process.
HOST_RESERVE_KB=1048576
MIN_DISK_FREE_KB=10485760

usage() {
  grep '^#   ' "$0" | sed 's/^#   //' >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --release) RELEASE_FILE="${2:?--release needs a path}"; shift 2 ;;
    --secrets-dir) SECRETS_DIR="${2:?--secrets-dir needs a path}"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) usage; die "unknown argument: $1" ;;
  esac
done
[ -n "$RELEASE_FILE" ] && [ -n "$SECRETS_DIR" ] || {
  usage
  die "--release and --secrets-dir are required"
}

pass() { printf 'PASS  %s\n' "$*"; }
warn_check() { printf 'WARN  %s\n' "$*"; }
fail() {
  printf 'FAIL  %s\n' "$*"
  FAILURES=$((FAILURES + 1))
}

# Bytes in a Docker memory size such as 4g, 512m or 1048576. Prints nothing for a value Docker refuses.
memory_bytes() {
  local number unit
  [[ "$1" =~ ^([1-9][0-9]*)([bBkKmMgG]?)$ ]] || return 0
  number="${BASH_REMATCH[1]}"
  unit="${BASH_REMATCH[2]}"
  case "$unit" in
    [kK]) echo $((number * 1024)) ;;
    [mM]) echo $((number * 1024 * 1024)) ;;
    [gG]) echo $((number * 1024 * 1024 * 1024)) ;;
    *) echo "$number" ;;
  esac
}

# ---------------------------------------------------------------------------
# Host tools and the engine.
# ---------------------------------------------------------------------------
for cmd in docker ss ip iptables sha256sum stat awk nproc; do
  if command -v "$cmd" >/dev/null 2>&1; then
    pass "tool present: $cmd"
  else
    fail "tool missing: $cmd"
  fi
done

if engine="$(docker version --format '{{.Server.Version}}' 2>/dev/null)" && [ -n "$engine" ]; then
  pass "Docker Engine $engine is reachable"
else
  fail "Docker Engine is not reachable as this user"
fi

# gVisor is the only runtime sandboxes may use. The executor's health check asks the same question.
runtimes="$(docker info -f '{{json .Runtimes}}' 2>/dev/null || true)"
if [[ "$runtimes" == *'"runsc"'* ]]; then
  pass "gVisor runtime runsc is registered with the engine"
else
  fail "runsc is not registered with the engine; sandboxes would not be isolated, and the executor answers 503"
fi

compose_version="$(docker compose version --short 2>/dev/null || true)"
if [[ "$compose_version" =~ ^[2-9]\. ]]; then
  pass "Compose $compose_version"
else
  fail "Compose v2 is required (found: ${compose_version:-none})"
fi

# ---------------------------------------------------------------------------
# Pins, release file and images.
# ---------------------------------------------------------------------------
load_release_file "$DEPLOY_DIR/pins.env"
load_release_file "$RELEASE_FILE"

missing="$(missing_release_values \
  EXECUTOR_IMAGE EXECUTOR_IMAGE_ID VPS_EXECUTOR_CONTROL_PLANE_URL EXECUTOR_SANDBOX_IMAGE \
  EXECUTOR_SANDBOX_CPUS EXECUTOR_SANDBOX_MEMORY EXECUTOR_MAX_ACTIVE_SANDBOXES \
  POLYTRONX_SECRETS_DIR)"
if [ -z "$missing" ]; then
  pass "release file has every required value"
else
  fail "release file has unset or placeholder values: $(echo "$missing" | tr '\n' ' ')"
fi

# The executor refuses any control-plane URL that is not an absolute https URL.
if [[ "${VPS_EXECUTOR_CONTROL_PLANE_URL:-}" =~ ^https://[^[:space:]]+$ ]]; then
  pass "control-plane URL is https (VPS_EXECUTOR_CONTROL_PLANE_URL)"
else
  fail "VPS_EXECUTOR_CONTROL_PLANE_URL must be an absolute https URL"
fi

if is_image_id "${EXECUTOR_IMAGE_ID:-}"; then
  if actual="$(docker image inspect -f '{{.Id}}' "${EXECUTOR_IMAGE:-}" 2>/dev/null)" && [ "$actual" = "$EXECUTOR_IMAGE_ID" ]; then
    pass "executor image matches its recorded ID"
  else
    fail "executor image is not on this host, or its ID differs from EXECUTOR_IMAGE_ID; load the verified archive"
  fi
else
  fail "EXECUTOR_IMAGE_ID must be sha256 followed by 64 lowercase hex characters"
fi

labels="$(docker image inspect -f '{{json .Config.Labels}}' "${EXECUTOR_IMAGE:-}" 2>/dev/null || true)"
if grep -qF "\"io.polytronx.node-image\":\"${NODE_IMAGE:-}\"" <<<"$labels"; then
  pass "executor image was built on the Node image pinned in pins.env"
else
  fail "executor image lacks an io.polytronx.node-image label that matches NODE_IMAGE in pins.env"
fi

if [[ "${EXECUTOR_SANDBOX_IMAGE:-}" == *@sha256:* ]]; then
  if docker image inspect "$EXECUTOR_SANDBOX_IMAGE" >/dev/null 2>&1; then
    pass "sandbox image is pinned by digest and on this host"
  else
    fail "sandbox image is not on this host; pull the digest reference first, since docker run would pull it at create time"
  fi
else
  fail "EXECUTOR_SANDBOX_IMAGE must be pinned by digest (name@sha256:...)"
fi

# ---------------------------------------------------------------------------
# Capacity: the limits each sandbox gets, against this host. CPU overcommit is allowed with a
# warning; memory overcommit is a blocker, because the kernel would kill something else.
# ---------------------------------------------------------------------------
cpus="${EXECUTOR_SANDBOX_CPUS:-}"
cores="$(nproc 2>/dev/null || echo 1)"
sandbox_bytes="$(memory_bytes "${EXECUTOR_SANDBOX_MEMORY:-}")"
max="${EXECUTOR_MAX_ACTIVE_SANDBOXES:-}"

if [[ "$cpus" =~ ^[0-9]+(\.[0-9]+)?$ ]] && awk -v c="$cpus" 'BEGIN { exit !(c > 0) }'; then
  pass "sandbox CPU limit is $cpus"
else
  fail "EXECUTOR_SANDBOX_CPUS must be a positive number of CPUs"
fi
if [ -n "$sandbox_bytes" ]; then
  pass "sandbox memory limit is ${EXECUTOR_SANDBOX_MEMORY:-}"
else
  fail "EXECUTOR_SANDBOX_MEMORY must be a Docker memory size such as 4g"
fi
if [[ "$max" =~ ^[1-9][0-9]*$ ]]; then
  pass "at most $max sandbox(es) at once, from EXECUTOR_MAX_ACTIVE_SANDBOXES"
else
  fail "EXECUTOR_MAX_ACTIVE_SANDBOXES must be a positive integer"
  max=""
fi

mem_total_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
if [ -n "$max" ] && [ -n "$sandbox_bytes" ]; then
  needed_kb=$((max * sandbox_bytes / 1024 + HOST_RESERVE_KB))
  if [ "$needed_kb" -le "$mem_total_kb" ]; then
    pass "memory: $max sandbox(es) plus 1 GiB for the host fit in $((mem_total_kb / 1024 / 1024)) GiB"
  else
    fail "memory: $max sandbox(es) at ${EXECUTOR_SANDBOX_MEMORY:-} plus 1 GiB for the host need $((needed_kb / 1024 / 1024)) GiB; this host has $((mem_total_kb / 1024 / 1024)) GiB"
  fi
fi
if [ -n "$max" ] && [[ "$cpus" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
  if awk -v a="$cpus" -v m="$max" -v c="$cores" 'BEGIN { exit !(a * m <= c) }'; then
    pass "CPU: $max sandbox(es) at $cpus CPU(s) fit in $cores core(s)"
  else
    warn_check "CPU: $max sandbox(es) at $cpus CPU(s) exceed $cores core(s); sandboxes will share CPU"
  fi
fi

disk_free_kb="$(docker_root_free_kb || true)"
if [ -n "$disk_free_kb" ] && [ "$disk_free_kb" -ge "$MIN_DISK_FREE_KB" ]; then
  pass "at least 10 GiB free on the filesystem of Docker's data root"
else
  fail "less than 10 GiB free on the filesystem of Docker's data root (or the data root cannot be read)"
fi

# ---------------------------------------------------------------------------
# Workspace slots: the bounded storage behind each sandbox's /workspace. workspace-slots.sh --check
# reads the six images, their mounts and their fstab lines. It changes nothing; its lines print as they are.
# ---------------------------------------------------------------------------
slots_ok=1
slots_report="$(bash "$DEPLOY_DIR/workspace-slots.sh" --check 2>&1)" || slots_ok=0
printf '%s\n' "$slots_report"
[ "$slots_ok" = 1 ] || fail "workspace slots are not provisioned as expected (see the FAIL lines above; workspace-slots.sh --apply, as root, provisions them once)"

# ---------------------------------------------------------------------------
# Sandbox network: sandboxes must sit on oi-sandbox under the owned rules. sandbox-network.sh check
# is read-only; apply (as root, once) creates the network and rules, and the boot unit keeps them.
# ---------------------------------------------------------------------------
network_ok=1
network_report="$(bash "$DEPLOY_DIR/sandbox-network.sh" check 2>&1)" || network_ok=0
printf '%s\n' "$network_report"
[ "$network_ok" = 1 ] || fail "sandbox network is not applied as expected (see the FAIL lines above; sandbox-network.sh apply, as root, applies it)"

# ---------------------------------------------------------------------------
# Secrets: names, shape and permissions. The token and admission secret are never printed.
# ---------------------------------------------------------------------------
if [ -d "$SECRETS_DIR" ]; then
  case "$(stat -c '%a' "$SECRETS_DIR")" in
    700 | 500) pass "secrets directory is owner-only" ;;
    *) fail "secrets directory must be mode 700" ;;
  esac
else
  fail "secrets directory missing: $SECRETS_DIR"
fi

problem="$(secret_file_problem "$SECRETS_DIR/executor.env" VPS_EXECUTOR_TOKEN VPS_EXECUTOR_ADMISSION_SECRET)"
if [ -n "$problem" ]; then
  fail "$problem"
elif grep -Eq '^VPS_EXECUTOR_TOKEN=.{32,}$' "$SECRETS_DIR/executor.env" &&
  grep -Eq '^VPS_EXECUTOR_ADMISSION_SECRET=.{32,}$' "$SECRETS_DIR/executor.env"; then
  pass "executor.env has VPS_EXECUTOR_TOKEN and VPS_EXECUTOR_ADMISSION_SECRET of at least 32 characters"
else
  fail "VPS_EXECUTOR_TOKEN and VPS_EXECUTOR_ADMISSION_SECRET in executor.env must each be at least 32 characters"
fi

# ---------------------------------------------------------------------------
# Engine socket. The executor joins the socket's group. Group 0 would give it root-equivalent
# access, so it is refused.
# ---------------------------------------------------------------------------
DOCKER_GID=""
if [ -S "$DOCKER_SOCKET" ]; then
  DOCKER_GID="$(stat -c '%g' "$DOCKER_SOCKET" 2>/dev/null || true)"
fi
if [[ "$DOCKER_GID" =~ ^[1-9][0-9]*$ ]]; then
  pass "docker socket is group-owned by gid $DOCKER_GID, which the executor joins with group_add"
else
  fail "docker socket at $DOCKER_SOCKET must exist and belong to a group other than root (found: ${DOCKER_GID:-none})"
  DOCKER_GID=""
fi
export DOCKER_GID

if [ -n "$DOCKER_GID" ] && docker compose -p "$EXECUTOR_PROJECT" --env-file "$RELEASE_FILE" \
  -f "$DEPLOY_DIR/compose.executor.yml" config --quiet >/dev/null 2>&1; then
  pass "compose renders the executor with this release (required values set, env file present)"
else
  fail "compose does not render the executor with this release; run config --quiet by hand to see which value is missing (values are not shown here)"
fi

# ---------------------------------------------------------------------------
# Port exposure. compose.executor.yml publishes the executor on loopback only. The private HTTPS
# edge (private-executor-edge.sh) is the one way in from the dashboard host.
# ---------------------------------------------------------------------------
live_ports="$(docker ps --filter "label=com.docker.compose.project=$EXECUTOR_PROJECT" --format '{{.Ports}}' 2>/dev/null || true)"
if [[ "$live_ports" == *"127.0.0.1:${EXECUTOR_PORT}->"* ]]; then
  pass "port $EXECUTOR_PORT is held by this project on 127.0.0.1 (re-deploy)"
elif port_in_use "$EXECUTOR_PORT"; then
  fail "port $EXECUTOR_PORT already has a listener; find it with ss -Htlnp and resolve it by hand, do not stop it blindly"
else
  pass "port $EXECUTOR_PORT is free"
fi

# ---------------------------------------------------------------------------
echo
if [ "$FAILURES" -eq 0 ]; then
  echo "preflight: no blockers"
else
  echo "preflight: $FAILURES blocker(s); deploy-executor.sh will not run"
  exit 1
fi
