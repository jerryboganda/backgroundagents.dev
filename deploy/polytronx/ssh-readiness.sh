#!/usr/bin/env bash
# Read-only GitHub Actions SSH readiness probe for one production environment.
# No deployment, privilege escalation, port forwarding, or host-file mutation.
set -euo pipefail

fail() {
  printf 'SSH readiness refused: %s\n' "$1" >&2
  exit 1
}

[[ $# -eq 1 && ( "$1" == "dashboard" || "$1" == "executor" ) ]] ||
  fail "expected exactly one target: dashboard or executor"
target="$1"

for variable in SSH_PRIVATE_KEY SSH_HOST SSH_USER SSH_PORT SSH_KNOWN_HOSTS RUNNER_TEMP; do
  [[ -n "${!variable:-}" ]] || fail "missing required setting: $variable"
done

# Refuse shell metacharacters, option-looking targets, root logins and bad ports.
[[ "$SSH_HOST" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$ ]] &&
  [[ "$SSH_HOST" != *..* ]] || fail "invalid SSH_HOST (use an IPv4 address or DNS hostname)"
[[ "$SSH_USER" =~ ^[a-z_][a-z0-9_-]*$ && "$SSH_USER" != "root" ]] ||
  fail "SSH_USER must name a dedicated non-root deployment account"
[[ "$SSH_PORT" =~ ^[0-9]{1,5}$ ]] || fail "SSH_PORT must be numeric"
port_number=$((10#$SSH_PORT))
(( port_number >= 1 && port_number <= 65535 )) || fail "SSH_PORT is out of range"

umask 077
key_file="$(mktemp "${RUNNER_TEMP%/}/bg-ssh-key.XXXXXXXX")"
hosts_file="$(mktemp "${RUNNER_TEMP%/}/bg-known-hosts.XXXXXXXX")"
trap 'rm -f "$key_file" "$hosts_file"' EXIT
printf '%s\n' "$SSH_PRIVATE_KEY" >"$key_file"
printf '%s\n' "$SSH_KNOWN_HOSTS" >"$hosts_file"
chmod 600 "$key_file" "$hosts_file"

# This key must be usable noninteractively, and the independently verified
# known_hosts entry must name exactly the configured destination and port.
ssh-keygen -y -P '' -f "$key_file" >/dev/null 2>&1 ||
  fail "SSH_PRIVATE_KEY is invalid or requires a passphrase"
known_host="$SSH_HOST"
if [[ "$port_number" -ne 22 ]]; then
  known_host="[$SSH_HOST]:$port_number"
fi
ssh-keygen -F "$known_host" -f "$hosts_file" >/dev/null ||
  fail "SSH_KNOWN_HOSTS is missing the configured host and port"

# No commands requiring sudo or Docker are run on the target.
remote_probe='set -eu; test "$(id -u)" -ne 0; test "$(uname -s)" = "Linux"; printf "Non-root Linux SSH probe passed\\n"'
ssh -T -F /dev/null \
  -o BatchMode=yes \
  -o ConnectTimeout=15 \
  -o ConnectionAttempts=1 \
  -o IdentitiesOnly=yes \
  -o PasswordAuthentication=no \
  -o PreferredAuthentications=publickey \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="$hosts_file" \
  -o GlobalKnownHostsFile=/dev/null \
  -o UpdateHostKeys=no \
  -o ForwardAgent=no \
  -o ClearAllForwardings=yes \
  -o LogLevel=ERROR \
  -i "$key_file" -p "$port_number" "$SSH_USER@$SSH_HOST" "$remote_probe"

printf '%s SSH readiness: verified connection only; no deployment was attempted.\n' "$target"
