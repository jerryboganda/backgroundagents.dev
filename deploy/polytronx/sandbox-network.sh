#!/usr/bin/env bash
#
# Egress isolation for the executor's sandboxes. Creates the dedicated bridge oi-sandbox
# (inter-container traffic off, IPv6 off) and two owned iptables chains: POLYTRONX-SBX-FWD
# for traffic sandboxes forward out, and POLYTRONX-SBX-IN for traffic they send to the host.
# Only those chains and their jumps are written or removed. No built-in chain, Docker chain
# or other UFW rule is flushed, no policy is changed, and Docker is never restarted.
#
#   sandbox-network.sh check [--subnet S]      read-only; exits 1 on any mismatch
#   sandbox-network.sh apply [--subnet S]      idempotent; refuses to replace an existing network
#   sandbox-network.sh restore [--subnet S]    the boot unit's command: restores the rules and sysctl; writes nothing
#   sandbox-network.sh rollback [--subnet S]   removes the owned jumps, chains and boot unit; keeps the network
#
# Reboot: apply also writes and enables the owned oneshot polytronx-sandbox-network.service. It runs
# restore after docker.service and ufw.service and before polytronx-executor-edge.service, so the rules
# and the IPv6 setting come back on every boot. restore writes no file and runs no systemctl. Only that
# unit file is written or removed here.
#
# Run as root on the executor host. Every command refuses unless this host owns HOST_IP.
# The network itself is removed by hand, once no container is attached:
#   docker network rm oi-sandbox

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

HOST_IP="172.235.26.148"
NETWORK="oi-sandbox"
BRIDGE_IF="br-oisandbox"
DEFAULT_SUBNET="10.251.7.0/24"
FWD_CHAIN="POLYTRONX-SBX-FWD"
IN_CHAIN="POLYTRONX-SBX-IN"
NETWORK_FORMAT='{{.Driver}} {{index .Options "com.docker.network.bridge.name"}} {{index .Options "com.docker.network.bridge.enable_icc"}} {{.EnableIPv6}} {{range .IPAM.Config}}{{.Subnet}}{{end}}'
UNIT_DIR="${POLYTRONX_UNIT_DIR:-/etc/systemd/system}"
UNIT_NAME="polytronx-sandbox-network.service"
OWNER_MARK="# polytronx-owned: sandbox-network"
SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

SUBNET="$DEFAULT_SUBNET"
GATEWAY=""

usage() {
  grep '^#   ' "$0" | sed 's/^#   //' >&2
}

pass() { printf 'PASS  %s\n' "$*"; }
fail() {
  printf 'FAIL  %s\n' "$*"
  FAILURES=$((FAILURES + 1))
}
FAILURES=0

# An RFC1918 /24 that is not inside 172.17.0.0/16, which Docker's default bridge uses.
valid_subnet() {
  local net="${1%/24}" a b c d octet
  [[ "$1" == */24 ]] || return 1
  IFS=. read -r a b c d <<<"$net"
  for octet in "$a" "$b" "$c" "$d"; do
    [[ "$octet" =~ ^[0-9]{1,3}$ ]] && [ "$octet" -le 255 ] || return 1
  done
  [ "$d" = 0 ] || return 1
  [ "$a.$b" = "172.17" ] && return 1
  [ "$a" = 10 ] && return 0
  [ "$a" = 172 ] && [ "$b" -ge 16 ] && [ "$b" -le 31 ] && return 0
  [ "$a.$b" = "192.168" ] && return 0
  return 1
}

host_is_edge() {
  local addrs
  addrs="$(ip -4 -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1)"
  grep -qxF "$HOST_IP" <<<"$addrs"
}

# Another network already holding this exact subnet, by name. Empty when none does.
overlapping_network() {
  local ids
  ids="$(docker network ls -q 2>/dev/null || true)"
  [ -n "$ids" ] || return 0
  # shellcheck disable=SC2086 # ids are hex IDs, one per word
  docker network inspect $ids --format '{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{end}}' 2>/dev/null |
    awk -v s="$SUBNET" -v n="$NETWORK" '$1 != n { for (i = 2; i <= NF; i++) if ($i == s) { print $1; exit } }'
}

expected_network_state() {
  printf 'bridge %s false false %s' "$BRIDGE_IF" "$SUBNET"
}

ensure_network() {
  local state other
  if state="$(docker network inspect "$NETWORK" --format "$NETWORK_FORMAT" 2>/dev/null)"; then
    [ "$state" = "$(expected_network_state)" ] || die "network $NETWORK exists with other options ($state); not replacing it"
    info "network $NETWORK already matches"
    return 0
  fi
  other="$(overlapping_network)"
  [ -z "$other" ] || die "subnet $SUBNET already belongs to network $other"
  docker network create --driver bridge --subnet "$SUBNET" --gateway "$GATEWAY" \
    --opt "com.docker.network.bridge.name=$BRIDGE_IF" \
    --opt "com.docker.network.bridge.enable_icc=false" \
    --ipv6=false "$NETWORK" >/dev/null
  info "created network $NETWORK on $SUBNET"
}

# Forwarded traffic from the owned subnet. Order matters: metadata, private and loopback
# destinations drop before any allowance, and the final DROP closes everything else. Written as
# iptables -S prints them (-p udp -m udp, RELATED,ESTABLISHED in kernel order), so check compares like with like.
fwd_rules() {
  cat <<EOF
-A $FWD_CHAIN -d 169.254.0.0/16 -j DROP
-A $FWD_CHAIN -d 10.0.0.0/8 -j DROP
-A $FWD_CHAIN -d 172.16.0.0/12 -j DROP
-A $FWD_CHAIN -d 192.168.0.0/16 -j DROP
-A $FWD_CHAIN -d 127.0.0.0/8 -j DROP
-A $FWD_CHAIN -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
-A $FWD_CHAIN -p udp -m udp --dport 53 -j ACCEPT
-A $FWD_CHAIN -p tcp -m tcp --dport 53 -j ACCEPT
-A $FWD_CHAIN -p tcp -m tcp --dport 443 -j ACCEPT
-A $FWD_CHAIN -j DROP
EOF
}

# Traffic from the owned bridge addressed to this host: replies only. Nothing on the host
# (SSH, the public HTTPS of other sites, the executor on loopback, the edge) is reachable.
in_rules() {
  cat <<EOF
-A $IN_CHAIN -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
-A $IN_CHAIN -j DROP
EOF
}

# Replaces one owned chain atomically: --noflush leaves every other chain alone, and the
# -F names only the owned chain.
restore_chain() { # $1 chain, $2 rules
  {
    printf '*filter\n:%s - [0:0]\n-F %s\n' "$1" "$1"
    printf '%s\n' "$2"
    printf 'COMMIT\n'
  } | iptables-restore --noflush
}

# Inserts a jump at the top of a built-in chain unless it is already present.
ensure_jump() { # $1 built-in chain, then the match and target
  iptables -C "$@" 2>/dev/null || iptables -I "$1" 1 "${@:2}"
}

remove_jump() {
  while iptables -C "$@" 2>/dev/null; do iptables -D "$1" "${@:2}"; done
}

remove_chain() { # $1 owned chain
  iptables -S "$1" >/dev/null 2>&1 || return 0
  iptables -F "$1"
  iptables -X "$1"
}

# The owned boot unit. Its ExecStart is this script's absolute path, so a path that would break the
# unit file is refused before anything is written.
render_unit() {
  local re='^/[^]"\\$#{}|&[:cntrl:]]+$'
  [[ "$SCRIPT_PATH" =~ $re ]] || die "the script path must be absolute without quotes, backslashes, \$ # { } | or &: $SCRIPT_PATH"
  echo "$OWNER_MARK"
  cat <<EOF
[Unit]
Description=PolytronX sandbox network: owned bridge and firewall rules for $NETWORK
After=docker.service ufw.service
Requires=docker.service
Before=polytronx-executor-edge.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash "$SCRIPT_PATH" restore --subnet $SUBNET

[Install]
WantedBy=multi-user.target
EOF
}

# Prints a problem when the boot unit path holds a file this script did not write, or nothing.
unit_problem() {
  local target="$UNIT_DIR/$UNIT_NAME"
  if [ -e "$target" ] && ! grep -qxF "$OWNER_MARK" "$target"; then
    echo "$target exists and is not owned by this script; not replacing it"
  fi
  return 0
}

# Writes the owned boot unit, backing up the owned copy it replaces. A foreign file is refused.
install_unit() {
  local target="$UNIT_DIR/$UNIT_NAME" new
  new="$(mktemp)"
  render_unit >"$new"
  if [ -e "$target" ]; then
    grep -qxF "$OWNER_MARK" "$target" || { rm -f "$new"; die "$target exists and is not owned by this script; not replacing it"; }
    if cmp -s "$target" "$new"; then
      rm -f "$new"
      info "$UNIT_NAME unchanged"
      return 0
    fi
    cp -p "$target" "$target.bak.$(date -u +%Y%m%dT%H%M%SZ)"
  fi
  install -m 0644 "$new" "$target"
  rm -f "$new"
  info "wrote $target"
}

check() {
  local count
  if host_is_edge; then pass "host owns $HOST_IP"; else fail "host does not own $HOST_IP"; fi
  if [ "$(docker network inspect "$NETWORK" --format "$NETWORK_FORMAT" 2>/dev/null || true)" = "$(expected_network_state)" ]; then
    pass "network $NETWORK: bridge $BRIDGE_IF, $SUBNET, ICC off, IPv6 off"
  else
    fail "network $NETWORK is missing or differs from the expected options"
  fi
  if iptables -C DOCKER-USER -s "$SUBNET" -j "$FWD_CHAIN" 2>/dev/null; then
    pass "DOCKER-USER jumps from $SUBNET to $FWD_CHAIN"
  else
    fail "DOCKER-USER has no jump from $SUBNET to $FWD_CHAIN"
  fi
  if iptables -C INPUT -i "$BRIDGE_IF" -j "$IN_CHAIN" 2>/dev/null; then
    pass "INPUT jumps from $BRIDGE_IF to $IN_CHAIN"
  else
    fail "INPUT has no jump from $BRIDGE_IF to $IN_CHAIN"
  fi
  # Exact and ordered: a rule edited by hand, or moved, fails even when the count is right.
  if [ "$(iptables -S "$FWD_CHAIN" 2>/dev/null | grep '^-A ' || true)" = "$(fwd_rules)" ]; then
    pass "$FWD_CHAIN holds exactly its rules, in order"
  else
    fail "$FWD_CHAIN differs from its expected rules, in order"
  fi
  if [ "$(iptables -S "$IN_CHAIN" 2>/dev/null | grep '^-A ' || true)" = "$(in_rules)" ]; then
    pass "$IN_CHAIN holds exactly its rules, in order"
  else
    fail "$IN_CHAIN differs from its expected rules, in order"
  fi
  if [ "$(sysctl -n "net.ipv6.conf.$BRIDGE_IF.disable_ipv6" 2>/dev/null || true)" = 1 ]; then
    pass "IPv6 is disabled on $BRIDGE_IF (re-applied on every boot by $UNIT_NAME)"
  else
    fail "IPv6 is not disabled on $BRIDGE_IF"
  fi
  if [ -f "$UNIT_DIR/$UNIT_NAME" ] && grep -qxF "$OWNER_MARK" "$UNIT_DIR/$UNIT_NAME" &&
    [ "$(systemctl is-enabled "$UNIT_NAME" 2>/dev/null || true)" = enabled ]; then
    pass "boot unit $UNIT_NAME is owned and enabled, so the rules return after a reboot"
  else
    fail "boot unit $UNIT_NAME is not owned and enabled (apply writes and enables it)"
  fi
  if [ "$FAILURES" -eq 0 ]; then
    echo "sandbox-network: no blockers"
  else
    echo "sandbox-network: $FAILURES blocker(s)"
    return 1
  fi
}

# The boot path: the network, the owned chains and their jumps, and the IPv6 setting. It writes no unit
# and runs no systemctl, so a boot cannot rewrite or re-enable anything.
restore() {
  host_is_edge || die "this host does not own $HOST_IP; nothing was changed"
  iptables -S DOCKER-USER >/dev/null 2>&1 || die "DOCKER-USER does not exist; start Docker with iptables enabled first"
  ensure_network
  restore_chain "$FWD_CHAIN" "$(fwd_rules)"
  restore_chain "$IN_CHAIN" "$(in_rules)"
  ensure_jump DOCKER-USER -s "$SUBNET" -j "$FWD_CHAIN"
  ensure_jump INPUT -i "$BRIDGE_IF" -j "$IN_CHAIN"
  sysctl -q -w "net.ipv6.conf.$BRIDGE_IF.disable_ipv6=1"
}

apply() {
  local problem
  problem="$(unit_problem)"
  [ -z "$problem" ] || die "$problem"
  restore
  install_unit
  systemctl daemon-reload 2>/dev/null || die "systemctl daemon-reload failed; $UNIT_NAME is not registered"
  systemctl enable "$UNIT_NAME" >/dev/null 2>&1 || die "could not enable $UNIT_NAME; the rules would not return after a reboot"
  check
}

rollback() {
  local ts target="$UNIT_DIR/$UNIT_NAME"
  host_is_edge || die "this host does not own $HOST_IP; nothing was changed"
  if [ -e "$target" ]; then
    grep -qxF "$OWNER_MARK" "$target" || die "$target is not owned by this script; nothing was changed"
    # The unit goes first, so a reboot during rollback cannot bring the rules back.
    systemctl disable "$UNIT_NAME" 2>/dev/null || warn "could not disable $UNIT_NAME; check it by hand"
    ts="$(date -u +%Y%m%dT%H%M%SZ)"
    mv "$target" "$target.rolled-back.$ts"
    systemctl daemon-reload 2>/dev/null || true
  fi
  remove_jump DOCKER-USER -s "$SUBNET" -j "$FWD_CHAIN"
  remove_jump INPUT -i "$BRIDGE_IF" -j "$IN_CHAIN"
  remove_chain "$FWD_CHAIN"
  remove_chain "$IN_CHAIN"
  info "owned boot unit, jumps and chains removed; network $NETWORK kept"
}

COMMAND="${1:-}"
[ "$#" -gt 0 ] && shift
while [ "$#" -gt 0 ]; do
  case "$1" in
    --subnet) SUBNET="${2:?--subnet needs a value}"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) usage; die "unknown argument: $1" ;;
  esac
done
valid_subnet "$SUBNET" || die "subnet must be an RFC1918 /24 outside 172.17.0.0/16: $SUBNET"
GATEWAY="${SUBNET%.*}.1"

case "$COMMAND" in
  check) check ;;
  apply) apply ;;
  restore) restore ;;
  rollback) rollback ;;
  *) usage; die "command must be check, apply, restore or rollback" ;;
esac
