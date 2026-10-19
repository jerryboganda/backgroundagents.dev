#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
info()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33mWARN:\033[0m %s\n' "$*"; }
error() { printf '\033[1;31mERROR:\033[0m %s\n' "$*"; }

check_cmd() {
  if ! command -v "$1" &>/dev/null; then
    error "$1 is not installed."
    return 1
  fi
}

# ---------------------------------------------------------------------------
# 1. Check prerequisites
# ---------------------------------------------------------------------------
info "Checking prerequisites…"

check_cmd node
check_cmd npm

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if (( NODE_MAJOR < 24 )); then
  warn "Node.js >= 24 required (found $(node -v)). Please upgrade; continuing setup."
else
  info "Node $(node -v) ✓"
fi

# ---------------------------------------------------------------------------
# 2. Install npm dependencies (also triggers husky via prepare script)
# ---------------------------------------------------------------------------
info "Installing npm dependencies…"
npm install

# ---------------------------------------------------------------------------
# 3. Build shared package (other packages depend on it)
# ---------------------------------------------------------------------------
info "Building @open-inspect/shared…"
npm run build -w @open-inspect/shared

# ---------------------------------------------------------------------------
# 4. Verify git hooks
# ---------------------------------------------------------------------------
if [ -f .git/hooks/pre-commit ]; then
  info "Git hooks (husky) installed ✓"
else
  warn "Git hooks not installed. Running husky…"
  npx husky
fi

# ---------------------------------------------------------------------------
# 5. Python environment (optional — for modal-infra development)
# ---------------------------------------------------------------------------
MODAL_DIR="$REPO_ROOT/packages/modal-infra"

setup_python() {
  info "Setting up Python environment for modal-infra…"

  if ! command -v python3 &>/dev/null; then
    warn "python3 not found — skipping Python setup."
    warn "Install Python >= 3.12 if you plan to work on packages/modal-infra."
    return
  fi

  PY_MINOR=$(python3 -c 'import sys; print(sys.version_info.minor)')
  if (( PY_MINOR < 12 )); then
    warn "Python >= 3.12 required for modal-infra (found $(python3 --version))."
    warn "Skipping Python setup."
    return
  fi

  if command -v uv &>/dev/null; then
    info "Syncing Python dependencies with uv.lock…"
    (
      cd "$MODAL_DIR"
      uv sync --frozen --extra dev
    )
    info "Python environment ready (activate with: source packages/modal-infra/.venv/bin/activate)"
    return
  fi

  warn "uv not found — falling back to pip editable install."
  warn "Install uv for lockfile-reproducible Python environments."

  if [ ! -d "$MODAL_DIR/.venv" ]; then
    info "Creating virtualenv at packages/modal-infra/.venv…"
    python3 -m venv "$MODAL_DIR/.venv"
  fi

  # shellcheck disable=SC1091
  source "$MODAL_DIR/.venv/bin/activate"
  info "Installing Python dev dependencies…"
  pip install -q -e "$REPO_ROOT/packages/sandbox-runtime"
  pip install -q -e "$MODAL_DIR[dev]"
  deactivate
  info "Python environment ready (activate with: source packages/modal-infra/.venv/bin/activate)"
}

# The Modal Python environment and the full type check are for working on modal-infra and for CI. A coding
# session does not need them, and together they added minutes to every sandbox start. Run them by hand when needed:
#   (cd packages/modal-infra && uv sync --frozen --extra dev)    and    npm run typecheck
# Set OI_FULL_SETUP=1 to run both here.
if [ "${OI_FULL_SETUP:-0}" = "1" ]; then
  if [ -d "$MODAL_DIR" ] && command -v python3 &>/dev/null; then setup_python; fi
  info "Running type check…"
  if npm run typecheck; then info "Type check passed ✓"; else warn "Type check had issues — you may need to build additional packages."; fi
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
printf '\n'
info "Setup complete! You can now:"
info "  npm run dev -w @open-inspect/web        # Start web dev server"
info "  npm run test -w @open-inspect/control-plane  # Run control-plane tests"
info "  npm run lint                             # Lint all packages"
info "  npm run typecheck                        # Type-check all packages"
