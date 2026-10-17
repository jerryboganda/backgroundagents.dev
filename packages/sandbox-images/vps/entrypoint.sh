#!/usr/bin/env bash
# VPS image entrypoint: bootstrap bind-hidden runtime state, then exec the command. Contract: packages/sandbox-images/README.md.
set -euo pipefail

fail() {
  echo "openinspect-entrypoint: $*" >&2
  exit 1
}

# seed_home SEED HOME copies each seed path that HOME lacks. Existing entries are kept, so user data and markers
# are never overwritten and reruns change nothing. Every refusal happens before the first write.
seed_home() {
  local seed=$1 home=$2 path rel target
  while IFS= read -r -d '' path; do
    rel=${path#"$seed"/}
    target=$home/$rel
    [[ -L "$path" || -r "$path" ]] || fail "image seed entry $rel is not readable by UID $(id -u)"
    if [[ -L "$target" ]]; then
      # Seeding a directory through a user symlink would write outside HOME; other user symlinks are kept.
      [[ -L "$path" || ! -d "$path" ]] || fail "$target is a symlink; refusing to seed through it"
    elif [[ -d "$path" && ! -L "$path" ]]; then
      [[ ! -e "$target" || -d "$target" ]] || fail "$target is a file, but the image seed needs a directory"
    elif [[ -d "$target" ]]; then
      fail "$target is a directory, but the image seed needs a file"
    fi
  done < <(find "$seed" -mindepth 1 -print0)
  tar -C "$seed" -cf - . | tar -C "$home" --skip-old-files -xf -
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  [[ -w "${HOME:-}" ]] || fail "HOME ${HOME:-<unset>} is not writable by UID $(id -u)"
  [[ -d /app/home-seed ]] || fail "image home seed /app/home-seed is missing"
  seed_home /app/home-seed "$HOME"
  # /tmp is a tmpfs at runtime, which hides the build-time /tmp/opencode.
  mkdir -p /tmp/opencode
  [[ -w /tmp/opencode ]] || fail "/tmp/opencode is not writable by UID $(id -u)"
  (( $# )) || fail "no command to exec"
  exec "$@"
fi
