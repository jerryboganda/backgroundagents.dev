#!/usr/bin/env bash
#
# Private HTTPS ingress for the VPS executor. A host-run Caddy listens on 172.235.26.148:19443
# and forwards to the executor on 127.0.0.1:8787. Only the dashboard host may connect: UFW
# admits that source alone, and Caddy refuses any other remote address. Certificates come from
# a private CA created on the host; its public part is the one the control plane trusts. The CA lives
# in CA_DIR, outside the edge directory the proxy mounts and reads, so the proxy never sees its key.
#
#   private-executor-edge.sh render                       prints the rendered Caddyfile; writes nothing
#   private-executor-edge.sh check                        read-only; exits 1 on any blocker
#   private-executor-edge.sh apply [proxy options]        creates missing material, never replaces it
#   private-executor-edge.sh rollback                     stops the edge, removes the owned UFW rule,
#                                                         moves owned config aside; keeps TLS material
#
# Proxy options: --proxy binary (default) with --caddy-archive PATH, the official Caddy archive pinned
# below; apply checks its SHA-256 and installs it under the edge directory. Or --proxy container with
# --caddy-image NAME@sha256:<64 hex>. check takes the same proxy option as apply. Run as root on the
# executor host. The edge directory can be set with POLYTRONX_EDGE_DIR and the unit directory with
# POLYTRONX_UNIT_DIR; the tests use them. A path with a quote, backslash, $, |, & or a mount point, or one
# not written as its resolved form (a symlink, '.', '..', a repeated or trailing slash), is refused.
#
# Reboot: the unit is enabled by the operator (apply does not start it). It is ordered after
# docker.service and polytronx-sandbox-network.service, so the sandbox rules are in place first.

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

EDGE_ADDRESS="172.235.26.148"
EDGE_PORT="19443"
DASHBOARD_SOURCE="185.252.233.186"
UPSTREAM="127.0.0.1:8787"
EDGE_DIR="${POLYTRONX_EDGE_DIR:-/etc/polytronx/edge}"
CA_DIR="${POLYTRONX_EDGE_CA_DIR:-/etc/polytronx/edge-ca}"
UNIT_DIR="${POLYTRONX_UNIT_DIR:-/etc/systemd/system}"
UNIT_NAME="polytronx-executor-edge.service"
OWNER_MARK="# polytronx-owned: private-executor-edge"
OWNER_LABEL="io.polytronx.owner=private-executor-edge"
RENEW_WITHIN=2592000 # 30 days, in seconds
FAILURES=0

# The proxy is the official Caddy release archive, pinned by version and by the SHA-256 GitHub publishes
# for the asset caddy_<version>_linux_amd64.tar.gz. Moving to another version is a reviewed change here.
CADDY_VERSION="2.11.7"
CADDY_ARCHIVE_SHA256="727b91701a392de6ebc5027509f548bf39979e5216340d0faed8fa5e69c84f8b"
EDGE_BIN="$EDGE_DIR/bin/caddy-$CADDY_VERSION"

PROXY_MODE="binary"
CADDY_ARCHIVE=""
CADDY_IMAGE=""

usage() {
  grep '^#   ' "$0" | sed 's/^#   //' >&2
}

pass() { printf 'PASS  %s\n' "$*"; }
fail() {
  printf 'FAIL  %s\n' "$*"
  FAILURES=$((FAILURES + 1))
}

host_is_edge() {
  local addrs
  addrs="$(ip -4 -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1)"
  grep -qxF "$EDGE_ADDRESS" <<<"$addrs"
}

ufw_active() {
  local status
  status="$(ufw status 2>/dev/null || true)"
  grep -q '^Status: active' <<<"$status"
}

# Prints one problem per incoming rule that could admit another source to the edge port, and one when the
# default incoming policy is not deny. Each rule is read by its To field. Every-port rules are refused
# whatever their source. A port, range or protocol-less rule that covers the edge port is refused unless it
# is IPv4 from the dashboard. A rule whose ports are not read here (an application profile, an address with a
# port, or a port list) is refused unless the source is the dashboard; write the port number instead.
ufw_problems() {
  local status line to from port_re='^([0-9]+)(:([0-9]+))?(/([a-z]+))?([[:space:]]\(v6\))?$'
  status="$(ufw status verbose 2>/dev/null || true)"
  grep -q '^Default: deny (incoming)' <<<"$status" || echo "ufw's default incoming policy is not deny"
  while IFS= read -r line; do
    [[ "$line" =~ ^(.+[^[:space:]])[[:space:]]+(ALLOW|LIMIT)([[:space:]]+IN)?[[:space:]]+(.+)$ ]] || continue
    to="${BASH_REMATCH[1]%% on *}"
    from="${BASH_REMATCH[4]%%#*}"
    from="${from%"${from##*[![:space:]]}"}"
    case "$from" in OUT\ * | FWD\ *) continue ;; esac
    if [[ "$to" == Anywhere* ]]; then
      echo "ufw rule admits every port, not only $EDGE_PORT/tcp: $line"
    elif [[ "$to" =~ $port_re ]]; then
      if [ "$EDGE_PORT" -ge "${BASH_REMATCH[1]}" ] && [ "$EDGE_PORT" -le "${BASH_REMATCH[3]:-${BASH_REMATCH[1]}}" ] &&
        [ "${BASH_REMATCH[5]:-}" != udp ] && { [ -n "${BASH_REMATCH[6]:-}" ] || [ "$from" != "$DASHBOARD_SOURCE" ]; }; then
        echo "ufw rule admits $EDGE_PORT/tcp from another source or over IPv6: $line"
      fi
    elif [ "$from" != "$DASHBOARD_SOURCE" ]; then
      echo "ufw rule's ports are not read (an application profile, an address with a port, or a port list): $line"
    fi
  done <<<"$status"
}

ufw_rule_present() {
  local status lines
  status="$(ufw status 2>/dev/null || true)"
  lines="$(grep -E "^${EDGE_PORT}/tcp[[:space:]]+ALLOW" <<<"$status" || true)"
  grep -qF "$DASHBOARD_SOURCE" <<<"$lines"
}

# The rule apply added: one line that names the dashboard source and apply's comment. A rule an operator
# added by hand has the same port and source but no comment, so it is not owned and rollback leaves it.
ufw_rule_owned() {
  local status line
  status="$(ufw status 2>/dev/null || true)"
  while IFS= read -r line; do
    if [[ "$line" =~ ^${EDGE_PORT}/tcp[[:space:]]+ALLOW ]] && [[ "$line" == *"$DASHBOARD_SOURCE"* && "$line" == *"polytronx executor edge"* ]]; then
      return 0
    fi
  done <<<"$status"
  return 1
}

# Prints a problem with the edge or CA directory, or nothing. Both paths land in the Caddyfile or the
# unit, so characters that would break either are refused, as are the filesystem root, sockets, engine state and mount points.
# The CA directory must lie outside the edge directory the proxy mounts, and the edge directory outside
# the CA directory, which the unit makes unreadable to the proxy. Both are compared as resolved paths, so
# a symlink, '.', '..' or a repeated or trailing slash is refused rather than followed.
edge_dir_problem() {
  local re='^/[^]"\\$#{}|&[:cntrl:]]+$' canon_edge canon_ca
  [ "$EDGE_DIR" = / ] && { echo "edge directory must not be /"; return 0; }
  [ "$CA_DIR" = / ] && { echo "CA directory must not be /"; return 0; }
  [[ "$EDGE_DIR" =~ $re ]] || { echo "edge directory must be an absolute path without quotes, backslashes, \$ # { } | or &"; return 0; }
  [[ "$CA_DIR" =~ $re ]] || { echo "CA directory must be an absolute path without quotes, backslashes, \$ # { } | or &"; return 0; }
  case "$EDGE_DIR" in
    /var/run/* | /run/* | /var/lib/docker* | /proc/* | /sys/* | /dev/*)
      echo "edge directory is under a path that holds sockets or engine state"
      return 0
      ;;
  esac
  canon_edge="$(realpath -m -- "$EDGE_DIR" 2>/dev/null)" || canon_edge=""
  canon_ca="$(realpath -m -- "$CA_DIR" 2>/dev/null)" || canon_ca=""
  if [ "$canon_edge" != "$EDGE_DIR" ] || [ "$canon_ca" != "$CA_DIR" ]; then
    echo "edge and CA directories must be written as resolved paths, with no symlink, '.', '..' or repeated or trailing slash (edge $canon_edge, CA $canon_ca)"
    return 0
  fi
  case "$CA_DIR/" in "$EDGE_DIR"/*) echo "CA directory must lie outside the edge directory, which the proxy mounts"; return 0 ;; esac
  case "$EDGE_DIR/" in "$CA_DIR"/*) echo "edge directory must lie outside the CA directory, which the unit makes unreadable to the proxy"; return 0 ;; esac
  if mountpoint -q "$EDGE_DIR" 2>/dev/null; then
    echo "edge directory is a mount point; keys must live on the host filesystem"
  fi
  return 0
}

# Prints a problem with the chosen proxy, or nothing. The binary is the pinned version at EDGE_BIN.
proxy_problem() {
  local version
  if [ "$PROXY_MODE" = container ]; then
    [[ "$CADDY_IMAGE" =~ ^[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$ ]] ||
      { echo "--caddy-image must be NAME@sha256:<64 hex>; a tag is not reproducible"; return 0; }
    return 0
  fi
  [ -x "$EDGE_BIN" ] || { echo "Caddy $CADDY_VERSION is not installed at $EDGE_BIN; apply with --caddy-archive first"; return 0; }
  version="$("$EDGE_BIN" version 2>/dev/null || true)"
  [[ "$version" == "v$CADDY_VERSION "* ]] || echo "$EDGE_BIN is not Caddy $CADDY_VERSION"
  return 0
}

# Checks a certificate and never reads a key. Prints the first problem, or nothing.
cert_problem() { # $1 server cert, $2 CA cert
  local san
  san="$(openssl x509 -in "$1" -noout -ext subjectAltName 2>/dev/null || true)"
  grep -qF "IP Address:$EDGE_ADDRESS" <<<"$san" || { echo "server certificate lacks the IP SAN $EDGE_ADDRESS"; return 0; }
  openssl verify -CAfile "$2" "$1" >/dev/null 2>&1 || { echo "server certificate is not issued by the edge CA"; return 0; }
  openssl x509 -in "$1" -noout -checkend "$RENEW_WITHIN" >/dev/null 2>&1 ||
    { echo "server certificate expires within 30 days; renew it by hand, nothing was replaced"; return 0; }
  return 0
}

ca_problem() { # $1 CA cert
  local basic
  basic="$(openssl x509 -in "$1" -noout -ext basicConstraints 2>/dev/null || true)"
  grep -q 'CA:TRUE' <<<"$basic" || { echo "$1 is not a CA certificate"; return 0; }
  openssl x509 -in "$1" -noout -checkend "$RENEW_WITHIN" >/dev/null 2>&1 ||
    { echo "edge CA expires within 30 days; renew it by hand, nothing was replaced"; return 0; }
  return 0
}

# Creates the CA and the server key pair when none exists; verifies them when they do.
# A partial set is refused rather than completed.
ensure_tls() {
  local tls="$EDGE_DIR/tls" problem f
  [ -d "$tls" ] || { mkdir -p "$tls" && chmod 0700 "$tls"; }
  [ -d "$CA_DIR" ] || { mkdir -p "$CA_DIR" && chmod 0700 "$CA_DIR"; }
  if [ -e "$CA_DIR/ca.key" ] || [ -e "$CA_DIR/ca.crt" ] || [ -e "$tls/server.key" ] || [ -e "$tls/server.crt" ]; then
    for f in "$CA_DIR/ca.key" "$CA_DIR/ca.crt" "$tls/server.key" "$tls/server.crt"; do
      [ -f "$f" ] || die "$(basename "$f") is missing beside the other edge material; not generating a partial set"
    done
    problem="$(ca_problem "$CA_DIR/ca.crt")"
    [ -z "$problem" ] || die "$problem"
    problem="$(cert_problem "$tls/server.crt" "$CA_DIR/ca.crt")"
    [ -z "$problem" ] || die "$problem"
    info "existing edge certificates verified; nothing replaced"
    return 0
  fi
  # A subshell keeps the 077 umask from outliving the generation, and its EXIT trap removes the temporary
  # directory when any openssl call fails.
  (
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    umask 077
    openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$CA_DIR/ca.key"
    openssl req -x509 -new -key "$CA_DIR/ca.key" -sha256 -days 825 -subj "/CN=PolytronX executor private CA" \
      -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
      -addext "keyUsage=critical,keyCertSign,cRLSign" \
      -addext "nameConstraints=critical,permitted;IP:$EDGE_ADDRESS/255.255.255.255" \
      -out "$CA_DIR/ca.crt"
    openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$tls/server.key"
    chmod 600 "$CA_DIR/ca.key" "$tls/server.key"
    printf 'subjectAltName=IP:%s\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n' \
      "$EDGE_ADDRESS" >"$tmp/server.ext"
    openssl req -new -key "$tls/server.key" -subj "/CN=$EDGE_ADDRESS" -out "$tmp/server.csr"
    openssl x509 -req -in "$tmp/server.csr" -CA "$CA_DIR/ca.crt" -CAkey "$CA_DIR/ca.key" -CAcreateserial \
      -days 397 -sha256 -extfile "$tmp/server.ext" -out "$tls/server.crt"
    chmod 644 "$CA_DIR/ca.crt" "$tls/server.crt"
  )
  info "created the edge CA in $CA_DIR and the server certificate in $tls"
}

# Installs the pinned Caddy binary from the official archive. The archive must match the pinned
# SHA-256 before anything is extracted. An identical binary is kept; a different one at the same
# versioned path is refused, never overwritten.
install_caddy() { # $1 archive
  local archive="$1" got tmp
  [ -f "$archive" ] || die "archive not found: $archive"
  got="$(sha256sum "$archive" | awk '{print $1}')"
  [ "$got" = "$CADDY_ARCHIVE_SHA256" ] ||
    die "$archive does not match the pinned SHA-256 of Caddy $CADDY_VERSION; nothing was installed"
  tmp="$(mktemp -d)"
  tar -xzf "$archive" -C "$tmp" caddy 2>/dev/null || { rm -rf "$tmp"; die "$archive holds no caddy binary; nothing was installed"; }
  if [ -e "$EDGE_BIN" ] && ! cmp -s "$EDGE_BIN" "$tmp/caddy"; then
    rm -rf "$tmp"
    die "$EDGE_BIN exists and differs from the pinned Caddy; not replacing it"
  fi
  mkdir -p "$(dirname "$EDGE_BIN")"
  install -m 0755 "$tmp/caddy" "$EDGE_BIN"
  rm -rf "$tmp"
  info "Caddy $CADDY_VERSION installed at $EDGE_BIN"
}

# The rendered Caddyfile: the only inputs are the fixed scope above and the edge directory.
render_caddyfile() {
  sed -e "s|__EDGE_ADDRESS__|$EDGE_ADDRESS|g" -e "s|__EDGE_PORT__|$EDGE_PORT|g" \
    -e "s|__DASHBOARD_SOURCE__|$DASHBOARD_SOURCE|g" -e "s|__UPSTREAM__|$UPSTREAM|g" \
    -e "s|__TLS_CERT__|$EDGE_DIR/tls/server.crt|g" -e "s|__TLS_KEY__|$EDGE_DIR/tls/server.key|g" \
    "$DEPLOY_DIR/templates/executor-Caddyfile"
}

render_unit() {
  echo "$OWNER_MARK"
  cat <<EOF
[Unit]
Description=PolytronX executor private HTTPS edge ($EDGE_ADDRESS:$EDGE_PORT to $UPSTREAM)
After=network-online.target docker.service polytronx-sandbox-network.service
Wants=network-online.target

[Service]
EOF
  if [ "$PROXY_MODE" = binary ]; then
    echo "ExecStart=\"$EDGE_BIN\" run --config \"$EDGE_DIR/Caddyfile\" --adapter caddyfile"
  else
    # Only a container this unit labelled is removed or stopped. A foreign container that holds the name is
    # left alone, so the start fails on the name and the operator resolves it by hand.
    echo "ExecStartPre=-/bin/sh -c '/usr/bin/docker ps -aq --filter label=$OWNER_LABEL | xargs -r /usr/bin/docker rm -f'"
    echo "ExecStart=/usr/bin/docker run --rm --name polytronx-executor-edge --label $OWNER_LABEL --network host --read-only --cap-drop ALL --security-opt no-new-privileges --tmpfs /data -e XDG_DATA_HOME=/data -e XDG_CONFIG_HOME=/data -v \"$EDGE_DIR:$EDGE_DIR:ro\" --entrypoint caddy $CADDY_IMAGE run --config \"$EDGE_DIR/Caddyfile\" --adapter caddyfile"
    echo "ExecStop=/bin/sh -c '/usr/bin/docker ps -q --filter label=$OWNER_LABEL | xargs -r /usr/bin/docker stop'"
  fi
  # ponytail: root only to read server.key. Upgrade path: DynamicUser=yes with LoadCredential, and the Caddyfile reads the credentials directory. Needs a Linux run.
  cat <<EOF
Restart=on-failure
RestartSec=5
User=root
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadOnlyPaths=$EDGE_DIR
InaccessiblePaths=$CA_DIR
StateDirectory=polytronx-edge
Environment=XDG_DATA_HOME=/var/lib/polytronx-edge XDG_CONFIG_HOME=/var/lib/polytronx-edge

[Install]
WantedBy=multi-user.target
EOF
}

validate_caddyfile() { # $1 path
  if [ "$PROXY_MODE" = binary ]; then
    "$EDGE_BIN" validate --config "$1" --adapter caddyfile >/dev/null 2>&1
  else
    docker run --rm --network none -v "$EDGE_DIR:$EDGE_DIR:ro" --entrypoint caddy "$CADDY_IMAGE" \
      validate --config "$1" --adapter caddyfile >/dev/null 2>&1
  fi
}

# Replaces an owned file with new content, backing up the old owned copy first. A file this
# script did not write is refused, whatever it contains.
write_owned() { # $1 target, $2 new content, $3 mode
  local target="$1" new="$2"
  if [ -e "$target" ]; then
    grep -qxF "$OWNER_MARK" "$target" || die "$target exists and is not owned by this script; not replacing it"
    if cmp -s "$target" "$new"; then
      info "$target unchanged"
      return 0
    fi
    cp -p "$target" "$target.bak.$(date -u +%Y%m%dT%H%M%SZ)"
  fi
  install -m "$3" "$new" "$target"
  info "wrote $target"
}

check() {
  local problem problems tls="$EDGE_DIR/tls" key
  if host_is_edge; then pass "host owns $EDGE_ADDRESS"; else fail "host does not own $EDGE_ADDRESS"; fi
  problem="$(edge_dir_problem)"
  if [ -z "$problem" ]; then pass "edge directory $EDGE_DIR is acceptable"; else fail "$problem"; fi
  if ufw_active; then pass "ufw is active, so the source restriction is enforced"; else fail "ufw is inactive; the source restriction would not be enforced"; fi
  if ufw_rule_present; then pass "ufw admits $EDGE_PORT/tcp from $DASHBOARD_SOURCE"; else fail "ufw does not admit $EDGE_PORT/tcp from $DASHBOARD_SOURCE"; fi
  problems="$(ufw_problems)"
  if [ -z "$problems" ]; then
    pass "ufw denies incoming by default and admits $EDGE_PORT/tcp only from $DASHBOARD_SOURCE"
  else
    while IFS= read -r problem; do fail "$problem"; done <<<"$problems"
  fi
  if [ -f "$CA_DIR/ca.crt" ] && [ -f "$tls/server.crt" ] && [ -f "$CA_DIR/ca.key" ] && [ -f "$tls/server.key" ]; then
    problem="$(ca_problem "$CA_DIR/ca.crt")"
    [ -z "$problem" ] || fail "$problem"
    problem="$(cert_problem "$tls/server.crt" "$CA_DIR/ca.crt")"
    if [ -z "$problem" ]; then pass "server certificate carries $EDGE_ADDRESS and chains to the edge CA"; else fail "$problem"; fi
    for key in "$CA_DIR/ca.key" "$tls/server.key"; do
      if [ "$(stat -c '%a' "$key")" = 600 ]; then pass "$(basename "$key") is mode 0600"; else fail "$key is not mode 0600"; fi
    done
  else
    fail "edge certificates are missing from $tls"
  fi
  problem="$(proxy_problem)"
  if [ -z "$problem" ]; then pass "proxy is Caddy $CADDY_VERSION, as pinned"; else fail "$problem"; fi
  if [ -f "$EDGE_DIR/Caddyfile" ] && grep -qxF "$OWNER_MARK" "$EDGE_DIR/Caddyfile" &&
    diff <(render_caddyfile) "$EDGE_DIR/Caddyfile" >/dev/null; then
    pass "Caddyfile is the owned render of the template"
  else
    fail "Caddyfile is missing, not owned, or differs from the render"
  fi
  if [ -f "$UNIT_DIR/$UNIT_NAME" ] && grep -qxF "$OWNER_MARK" "$UNIT_DIR/$UNIT_NAME"; then
    pass "unit $UNIT_NAME is installed and owned"
  else
    fail "unit $UNIT_NAME is not installed (apply writes it)"
  fi
  info "service state: $(systemctl is-active "$UNIT_NAME" 2>/dev/null || true) (informational)"
  if [ "$FAILURES" -eq 0 ]; then
    echo "private-executor-edge: no blockers"
  else
    echo "private-executor-edge: $FAILURES blocker(s)"
    return 1
  fi
}

apply() {
  local problem new unit_new
  host_is_edge || die "this host does not own $EDGE_ADDRESS; nothing was changed"
  ufw_active || die "ufw is not active; enable it with SSH allowed first, so the source restriction is enforced"
  problem="$(edge_dir_problem)"
  [ -z "$problem" ] || die "$problem"
  if [ -n "$CADDY_ARCHIVE" ]; then
    [ "$PROXY_MODE" = binary ] || die "--caddy-archive applies to --proxy binary only"
    install_caddy "$CADDY_ARCHIVE"
  fi
  problem="$(proxy_problem)"
  [ -z "$problem" ] || die "$problem"
  mkdir -p "$EDGE_DIR"
  ensure_tls
  new="$EDGE_DIR/Caddyfile.new"
  render_caddyfile >"$new"
  if ! validate_caddyfile "$new"; then
    rm -f "$new"
    die "the proxy rejected the rendered Caddyfile; nothing was switched"
  fi
  write_owned "$EDGE_DIR/Caddyfile" "$new" 0644
  rm -f "$new"
  unit_new="$EDGE_DIR/unit.new"
  render_unit >"$unit_new"
  write_owned "$UNIT_DIR/$UNIT_NAME" "$unit_new" 0644
  rm -f "$unit_new"
  systemctl daemon-reload 2>/dev/null || warn "systemctl daemon-reload failed; run it by hand"
  if ufw_rule_present; then
    info "ufw already admits $EDGE_PORT/tcp from $DASHBOARD_SOURCE"
  else
    ufw allow from "$DASHBOARD_SOURCE" to any port "$EDGE_PORT" proto tcp comment 'polytronx executor edge' >/dev/null
    info "ufw admits $EDGE_PORT/tcp from $DASHBOARD_SOURCE only"
  fi
  info "$(openssl x509 -in "$CA_DIR/ca.crt" -noout -fingerprint -sha256) (public CA; copy $CA_DIR/ca.crt to the control plane)"
  info "not started. Start after the live checks in runbooks/private-edge.md: systemctl enable --now $UNIT_NAME"
  check
}

rollback() {
  local ts target
  host_is_edge || die "this host does not own $EDGE_ADDRESS; nothing was changed"
  # Ownership is proven before anything is stopped or deleted. A unit or rule this script did not write stays.
  if [ -f "$UNIT_DIR/$UNIT_NAME" ]; then
    if grep -qxF "$OWNER_MARK" "$UNIT_DIR/$UNIT_NAME"; then
      systemctl disable --now "$UNIT_NAME" 2>/dev/null || warn "could not stop $UNIT_NAME; check it by hand"
    else
      warn "$UNIT_DIR/$UNIT_NAME is not owned by this script; not stopped or moved aside"
    fi
  fi
  if ufw_rule_owned; then
    ufw --force delete allow from "$DASHBOARD_SOURCE" to any port "$EDGE_PORT" proto tcp >/dev/null
    info "removed the firewall rule this script added"
  elif ufw_rule_present; then
    warn "ufw admits $EDGE_PORT/tcp from $DASHBOARD_SOURCE, but not as a rule this script added; left in place"
  fi
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  for target in "$EDGE_DIR/Caddyfile" "$UNIT_DIR/$UNIT_NAME"; do
    if [ -f "$target" ] && grep -qxF "$OWNER_MARK" "$target"; then
      mv "$target" "$target.rolled-back.$ts"
    fi
  done
  systemctl daemon-reload 2>/dev/null || true
  info "owned config moved aside if present; TLS material and the pinned binary kept"
}

COMMAND="${1:-}"
[ "$#" -gt 0 ] && shift
while [ "$#" -gt 0 ]; do
  case "$1" in
    --proxy) PROXY_MODE="${2:?--proxy needs binary or container}"; shift 2 ;;
    --caddy-archive) CADDY_ARCHIVE="${2:?--caddy-archive needs the path to the official archive}"; shift 2 ;;
    --caddy-image) CADDY_IMAGE="${2:?--caddy-image needs a digest reference}"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) usage; die "unknown argument: $1" ;;
  esac
done
[ "$PROXY_MODE" = binary ] || [ "$PROXY_MODE" = container ] || die "--proxy must be binary or container"

case "$COMMAND" in
  render)
    problem="$(edge_dir_problem)"
    [ -z "$problem" ] || die "$problem"
    render_caddyfile
    ;;
  check) check ;;
  apply) apply ;;
  rollback) rollback ;;
  *) usage; die "command must be render, check, apply or rollback" ;;
esac
