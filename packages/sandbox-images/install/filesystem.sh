#!/usr/bin/env bash
set -euo pipefail
if [[ -n "$OI_RUNTIME_UID" ]]; then
  # Pinned identity (VPS): create exactly UID:GID, or accept an existing account only if it already matches.
  if ! id "$OI_RUNTIME_USER" >/dev/null 2>&1; then
    if taken="$(getent passwd "$OI_RUNTIME_UID")"; then
      echo "UID $OI_RUNTIME_UID is already used by ${taken%%:*}; cannot create runtime user $OI_RUNTIME_USER" >&2
      exit 1
    fi
    if taken="$(getent group "$OI_RUNTIME_GID")"; then
      echo "GID $OI_RUNTIME_GID is already used by group ${taken%%:*}; cannot create runtime group $OI_RUNTIME_USER" >&2
      exit 1
    fi
    groupadd --gid "$OI_RUNTIME_GID" "$OI_RUNTIME_USER"
    useradd --uid "$OI_RUNTIME_UID" --gid "$OI_RUNTIME_GID" --create-home --home-dir "$OI_RUNTIME_HOME" --shell /bin/bash "$OI_RUNTIME_USER"
  fi
  actual="$(id -u "$OI_RUNTIME_USER"):$(id -g "$OI_RUNTIME_USER")"
  if [[ "$actual" != "$OI_RUNTIME_UID:$OI_RUNTIME_GID" ]]; then
    echo "Runtime user $OI_RUNTIME_USER is $actual, expected $OI_RUNTIME_UID:$OI_RUNTIME_GID" >&2
    exit 1
  fi
elif ! id "$OI_RUNTIME_USER" >/dev/null 2>&1; then
  useradd --create-home --home-dir "$OI_RUNTIME_HOME" --shell /bin/bash "$OI_RUNTIME_USER"
fi
mkdir -p /workspace /tmp/opencode /app/plugins /app/verify \
  "$OI_RUNTIME_HOME/.local/bin" "$OI_RUNTIME_HOME/.npm-global" "$OI_RUNTIME_HOME/.npm-cache" \
  "$OI_RUNTIME_HOME/.config/opencode" "$OI_RUNTIME_HOME/.cache/openinspect/scm" \
  "$OI_RUNTIME_HOME/.agent-browser"
# Configure only newly built images; do not inject a new Chrome path into legacy snapshots.
cp "$OI_INSTALL_DIR/agent-browser.json" "$OI_RUNTIME_HOME/.agent-browser/config.json"
cp -a /app/opencode-deps/. "$OI_RUNTIME_HOME/.config/opencode/"
install -m 0755 /app/sandbox_runtime/gh-wrapper.sh /usr/local/bin/gh
printf '%s\n' '#!/bin/sh' 'exec python3 -m sandbox_runtime.credentials.git_credential_helper "$@"' > /usr/local/bin/oi-git-credentials
chmod 0755 /usr/local/bin/oi-git-credentials
git config --system credential.helper /usr/local/bin/oi-git-credentials
git config --system credential.useHttpPath true
cp "$OI_BUNDLE/packages/sandbox-images/verify/smoke_test.py" /app/verify/smoke_test.py
cp "$OI_BUNDLE/build-config.json" /app/openinspect-build-config.json
cp "$OI_BUNDLE/packages/sandbox-images/toolchain.json" /app/openinspect-toolchain.json
# Best-effort: without a cached catalog OpenCode uses the one compiled into its binary.
HOME="$OI_RUNTIME_HOME" timeout 120 opencode models --refresh >/dev/null 2>&1 \
  || echo "OpenCode model catalog refresh failed; keeping OpenCode's built-in catalog" >&2
chown -R "$OI_RUNTIME_USER:$(id -gn "$OI_RUNTIME_USER")" /workspace /tmp/opencode /app/plugins \
  "$OI_RUNTIME_HOME/.local" "$OI_RUNTIME_HOME/.npm-global" "$OI_RUNTIME_HOME/.npm-cache" \
  "$OI_RUNTIME_HOME/.config" "$OI_RUNTIME_HOME/.cache" "$OI_RUNTIME_HOME/.agent-browser"

/opt/openinspect/python/bin/python -c 'import json; from pathlib import Path; plan = json.loads(Path("/app/openinspect-build-config.json").read_text()); Path("/app/openinspect-runtime-environment.json").write_text(json.dumps(plan["runtimeEnv"]))'
