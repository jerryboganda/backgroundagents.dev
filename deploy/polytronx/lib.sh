# Shared helpers for the PolytronX deployment scripts. Sourced, never run.
#
# Every script here names only resources this deployment owns: the project
# polytronx-openinspect and its rehearsal sibling, their volumes, and the edge
# network. Nothing here prunes, and nothing here prints a secret value.

LIVE_PROJECT="polytronx-openinspect"
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$DEPLOY_DIR/compose.production.yml"
REHEARSAL_OVERLAY="$DEPLOY_DIR/compose.rehearsal.yml"
# Every backup archive uses this cipher, and restores must decrypt with the same one.
BACKUP_CIPHER=(-aes-256-cbc -pbkdf2 -iter 300000 -salt)
# The live secrets directory. A restore into the rehearsal must never name it, under any spelling.
LIVE_SECRETS_DIR="/opt/polytronx/openinspect/secrets"
# Third-party images, pinned by digest in pins.env. Compose never pulls them (pull_policy: never),
# so the scripts that bring the stack up pull them first, and preflight checks their digests.
THIRD_PARTY_IMAGE_VARS=(LITESTREAM_IMAGE SEAWEEDFS_IMAGE)

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

warn() {
  printf 'WARN: %s\n' "$*" >&2
}

info() {
  printf 'INFO: %s\n' "$*"
}

require_cmd() {
  local cmd
  for cmd in "$@"; do
    command -v "$cmd" >/dev/null 2>&1 || die "required command not found: $cmd"
  done
}

# Reads KEY=VALUE lines into the environment. Values are assigned, never
# evaluated, so a release file cannot run code.
load_release_file() {
  local file="$1" line key value
  [ -f "$file" ] || die "release file not found: $file"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      '' | '#'*) continue ;;
    esac
    key="${line%%=*}"
    value="${line#*=}"
    [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || die "invalid key in $file: $key"
    declare -gx "$key=$value"
  done <"$file"
}

# True for an empty value or one a template left for the operator to replace.
is_placeholder() {
  case "$1" in
    '' | *REPLACE* | *CHANGEME* | *__*) return 0 ;;
    *) return 1 ;;
  esac
}

# Names of the release variables that are unset or still placeholders.
missing_release_values() {
  local name
  for name in "$@"; do
    if is_placeholder "${!name:-}"; then
      printf '%s\n' "$name"
    fi
  done
}

is_image_id() {
  [[ "${1:-}" =~ ^sha256:[0-9a-f]{64}$ ]]
}

is_revision() {
  [[ "${1:-}" =~ ^[0-9a-f]{40}$ ]]
}

# Compose for the live project, always with the pinned file and the loaded release.
live_compose() {
  local profile=()
  if [ -n "$(env_value DOCS_IMAGE "$RELEASE_FILE")" ]; then
    profile=(--profile docs)
  fi
  docker compose -p "$LIVE_PROJECT" --env-file "$RELEASE_FILE" -f "$COMPOSE_FILE" "${profile[@]}" "$@"
}

# Prints a description of the first problem with a secrets file, or nothing.
# Checks names and shape only; a value is never printed or compared outside
# this function.
secret_file_problem() {
  local file="$1" key
  shift
  [ -f "$file" ] || {
    printf 'missing file %s\n' "$(basename "$file")"
    return 0
  }
  case "$(stat -c '%a' "$file")" in
    600 | 400) ;;
    *)
      printf '%s must be mode 600 or 400\n' "$(basename "$file")"
      return 0
      ;;
  esac
  if grep -q $'\r' "$file"; then
    printf '%s has CRLF line endings\n' "$(basename "$file")"
    return 0
  fi
  for key in "$@"; do
    if ! grep -q "^${key}=." "$file"; then
      printf '%s has no value for %s\n' "$(basename "$file")" "$key"
      return 0
    fi
    if grep -q -E "^${key}=(REPLACE|CHANGEME|__)" "$file"; then
      printf '%s still holds a placeholder for %s\n' "$(basename "$file")" "$key"
      return 0
    fi
  done
  return 0
}

# True when a loopback port has a listener on this host.
port_in_use() {
  ss -Htln "sport = :$1" 2>/dev/null | grep -q .
}

# Container names of the live project, one per line.
live_container_ids() {
  docker ps -aq --filter "label=com.docker.compose.project=$LIVE_PROJECT"
}

# Takes the project lock for a command that stops, starts or snapshots the live
# project. The scheduled backup runs under the same lock (templates/polytronx-backup.service),
# so a deploy, a rollback and a backup never overlap. The lock lasts until the process exits.
take_project_lock() { # $1 state dir
  require_cmd flock
  mkdir -p "$1"
  exec 9>"$1/project.lock"
  flock -n 9 || die "another deploy, rollback or backup holds $1/project.lock; nothing was changed"
}

# Value of KEY in a KEY=VALUE file. Prints nothing when the key is absent.
env_value() { # $1 key, $2 file
  grep -m1 "^$1=" "$2" | cut -d= -f2- || true
}

# Root of Docker's data as the engine reports it. Empty when the engine cannot be asked.
docker_root_path() {
  docker info -f '{{.DockerRootDir}}' 2>/dev/null || true
}

# Free 1 KiB blocks on the filesystem that holds Docker's data. The data root is asked
# from the engine rather than assumed, because it can be moved. Empty when unreadable.
docker_root_free_kb() {
  local root
  root="$(docker_root_path)"
  [ -n "$root" ] || return 0
  df -Pk "$root" 2>/dev/null | awk 'NR==2 {print $4}'
}

# Percent of the filesystem that holds a path, as a bare number. Empty when unreadable.
filesystem_used_percent() { # $1 path
  df -P "$1" 2>/dev/null | awk 'NR==2 {gsub("%", "", $5); print $5}'
}

# Whole hours since the newest periodic-* backup in a directory was written. Prints
# nothing when there is none.
newest_periodic_backup_age_hours() { # $1 backup dir
  local newest
  newest="$(find "$1" -maxdepth 1 -mindepth 1 -type d -name 'periodic-*' -printf '%T@\n' 2>/dev/null |
    sort -n | tail -n 1 || true)"
  [ -n "$newest" ] || return 0
  echo $(( ($(date +%s) - ${newest%.*}) / 3600 ))
}

# Provider cap gate. The Modal provider must report the deployment's sandbox cap
# (PROVIDER_MAX_ACTIVE_SANDBOXES in pins.env) as max_active_sandboxes, with
# capacity_enforcement "pre-create", before provisioning is enabled. Prints the first
# problem, or nothing when the gate passes. The URL is the one the control plane calls for
# api-health: MODAL_API_URL when set, otherwise the derived *.modal.run host. The request is
# an unauthenticated GET that carries no credential. The response body is never printed.
provider_cap_problem() { # $1 control-plane.env
  local expect="${PROVIDER_MAX_ACTIVE_SANDBOXES:-}" workspace suffix api_url url body code problem=""
  if ! [[ "$expect" =~ ^[1-9][0-9]*$ ]]; then
    echo "PROVIDER_MAX_ACTIVE_SANDBOXES in pins.env is not a positive integer"
    return 0
  fi
  workspace="$(env_value MODAL_WORKSPACE "$1")"
  suffix="$(env_value MODAL_ENVIRONMENT_WEB_SUFFIX "$1")"
  api_url="$(env_value MODAL_API_URL "$1")"
  if [ -n "$api_url" ]; then
    url="${api_url%/}/api-health"
  elif [ -n "$workspace" ]; then
    url="https://${workspace}${suffix:+-$suffix}--open-inspect-api-health.modal.run"
  else
    echo "MODAL_WORKSPACE is not set, so the provider health URL cannot be derived"
    return 0
  fi
  body="$(mktemp)"
  code="$(curl -sS -o "$body" -w '%{http_code}' --max-time 10 "$url" 2>/dev/null || true)"
  if [ "$code" != "200" ]; then
    problem="provider health answered HTTP ${code:-none}"
  elif ! grep -Eq "\"max_active_sandboxes\"[[:space:]]*:[[:space:]]*${expect}[[:space:]]*([,}]|\$)" "$body"; then
    problem="provider does not report max_active_sandboxes=${expect}"
  elif ! grep -Eq '"capacity_enforcement"[[:space:]]*:[[:space:]]*"pre-create"' "$body"; then
    problem="provider does not report capacity_enforcement pre-create"
  fi
  rm -f "$body"
  [ -z "$problem" ] || echo "$problem"
  return 0
}

# Pulls each pinned third-party image that is not already on the host. Fails when a pull fails.
pull_third_party_images() {
  local var ref
  for var in "${THIRD_PARTY_IMAGE_VARS[@]}"; do
    ref="${!var:-}"
    if ! docker image inspect "$ref" >/dev/null 2>&1; then
      docker pull "$ref" || return 1
    fi
  done
}

# Prints a problem when a pinned third-party image is missing from the host or lacks its pinned
# digest, or nothing. Read-only, so preflight can call it.
third_party_image_problem() {
  local var ref digest repo_digests
  for var in "${THIRD_PARTY_IMAGE_VARS[@]}"; do
    ref="${!var:-}"
    if [[ "$ref" != *@sha256:* ]]; then
      echo "$var in pins.env is not pinned by digest"
      return 0
    fi
    digest="${ref##*@}"
    repo_digests="$(docker image inspect -f '{{range .RepoDigests}}{{println .}}{{end}}' "$ref" 2>/dev/null || true)"
    if ! grep -qF "@$digest" <<<"$repo_digests"; then
      echo "$ref is not on this host with its pinned digest"
      return 0
    fi
  done
  return 0
}
