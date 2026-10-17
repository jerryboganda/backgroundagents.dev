# Sandbox images

One build-only package owns platform dependencies for Modal, Daytona, E2B, Vercel, and OpenComputer.
Provider adapters own native creation, uploads, snapshots, restores, provider overlays, and cleanup.
The control plane does not consume build hashes or dependency inventories.

## Update dependencies

From the repository root, with Python 3.12+, uv 0.9.7, Node 24+, and npm installed:

```bash
# Edit toolchain.json, or sandbox-runtime/pyproject.toml for runtime dependencies.
# For changed runtime Python requirements, first run:
uv lock --project packages/sandbox-runtime
npm run sandbox:images -- lock
npm run sandbox:images -- lock --check
npm run sandbox:images -- plan --provider all
```

`toolchain.json` owns tool versions and archive checksums. `targets.json` owns native substrate and
runtime-user differences. `locks/` contains frozen npm closures and hash-checked Python exports.
Runtime environments are calculated directly from target configuration. Ordinary builds do not
resolve new dependency versions. To intentionally refresh distro packages, change `osRefresh`. OS
packages remain substrate-dependent; builds are not byte-for-byte attestations.

Each image owns its launch paths. Infrastructure Python is private and is not activated as the
project virtualenv. Existing images retain their legacy launch environment.

## Build

Install workspace dependencies with `npm ci` for Node adapters. Native operations require provider
credentials and create billable temporary sandboxes; they do not deploy the control plane.

| Provider     | Configuration                                                               |
| ------------ | --------------------------------------------------------------------------- |
| Modal        | Modal CLI credentials and intended environment                              |
| Daytona      | DAYTONA_API_KEY, DAYTONA_BASE_SNAPSHOT name prefix; optional API URL/target |
| E2B          | E2B_API_KEY, E2B_TEMPLATE_ID name prefix; optional API URL/CPU/memory       |
| Vercel       | VERCEL_TOKEN, VERCEL_PROJECT_ID; optional team/API URL                      |
| OpenComputer | OPENCOMPUTER_API_KEY; optional API URL/template prefix                      |

```bash
npm run sandbox:images -- build --provider e2b --output /tmp/e2b-image.json
# Output is {"reference":"<verified-native-reference>"}.
```

Verification is a build gate, not a separate CLI operation. There are no candidate record schemas,
release IDs, inventory digests, promotion commands, or release locks.

Every build verifies a fresh native restore before returning the reference. Checks include isolated
Python imports, exact pinned tool versions, plugin loading, writable user paths, SCM helpers,
OpenCode health, code-server, ttyd, Chromium screenshots, user-global pnpm execution, and the full
desktop WebSocket/RFB chain. Vercel may lack the optional ffmpeg encoder.

Manual builds use unique names. Terraform supplies deterministic names; retries re-verify retained
artifacts instead of overwriting them. Temporary verification sandboxes are terminated, including on
failure. Failed native artifacts remain for investigation and explicit cleanup.

### VPS Docker image

`vps` has no native build. It packs the same bundle and builds with `Dockerfile.vps` on linux/amd64:
runtime user `sandbox` (UID/GID 1000, `/home/sandbox`), digest-pinned base, and the runtime as
`ENTRYPOINT`. `build --provider vps` is rejected.

```bash
bundle=$(python3 packages/sandbox-images/cli.py pack --provider vps)
docker build --platform linux/amd64 --pull=false -f packages/sandbox-images/Dockerfile.vps -t oi-vps-runtime:dev "$bundle"
```

The base digest and runtime IDs live in `targets.json` and `Dockerfile.vps`; tests keep them equal.
Root filesystem, volumes and capabilities are set by the executor, not the image.

#### VPS runtime contract

- Identity: `install/filesystem.sh` creates `sandbox` as UID:GID 1000:1000. It fails if either ID or
  the group name is taken, or if an existing account has other IDs. The image runs as
  `USER 1000:1000`.
- Entrypoint: `/usr/local/bin/openinspect-entrypoint` (`vps/entrypoint.sh`). It requires a writable
  `$HOME` and `/app/home-seed`, then (1) copies the seed into `$HOME` with `tar --skip-old-files`:
  missing paths are added, existing paths are never overwritten, and a rerun changes nothing. A seed
  entry that conflicts with a user entry stops the entrypoint before any write: a seed directory
  over a user file, a seed file or symlink over a user directory, or a seed directory where `$HOME`
  has a symlink. (2) recreates `/tmp/opencode` for UID 1000; (3) `exec`s its arguments. `CMD` is
  `python -m sandbox_runtime.entrypoint`, so an argument-less launch runs the runtime. Any arguments
  replace that command.
- Seed: `/app/home-seed` is a root-owned copy of the build-time `/home/sandbox`, taken before the
  install smoke. It holds build output: OpenCode config (`.config/opencode`), browser config
  (`.agent-browser/config.json`), npm paths (`.npm-cache`, `.npm-global`), `.local/bin`, the
  `/etc/skel` dotfiles and the empty `.cache/openinspect/scm`. Before the copy, the build deletes
  OpenCode session state under `.local/share/opencode`: `opencode.db*`, `auth.json`, `log`,
  `storage` and `snapshot`. The contract refuses session and auth state: `auth.json`,
  `opencode.db*`, `.local/share/opencode/{storage,snapshot}`, `.codex`, `.claude`, `.config/gh`,
  `.ssh`, `.netrc`, `.npmrc`, `.git-credentials`, and any file under `.cache/openinspect`. Under
  `.cache` it admits only OpenCode's model catalog (`.cache/opencode`) and the SCM cache directory.
  Other OpenCode output is not validated until the first Linux build runs the contract on the real
  seed. Docker does not copy image contents into a bind mount, so the entrypoint performs the
  seeding.
- Packing: NUL-free `.sh` and `#!` files pack as LF with mode 0755. Other files keep their bytes and
  pack as 0644. Lone CR and binary bytes are never rewritten. The mode comes from this rule, not the
  checkout, because NTFS reports 0666 for every file. Standard pack sets each mode and checks it, so
  a filesystem that keeps no POSIX modes (Windows) fails closed; run pack on Linux or macOS.
  Changing this rule changes every provider's build hash once, so each image rebuilds on its next
  build.
- Executor: bind `HOME` and `/workspace` from directories owned by 1000:1000. The root may be
  read-only, and `/tmp` may be an exec tmpfs with a `size=` bound. A tmpfs on `/tmp` hides
  `/tmp/.X11-unix`, so desktop services also need `--tmpfs /tmp/.X11-unix:mode=1777`.
- Harness homes, created at runtime under `HOME` and required to be writable: OpenCode
  `.config/opencode` (seeded), Claude `.openinspect/claude` (or `CLAUDE_CONFIG_DIR`), Codex
  `.openinspect/codex`.
- Gate: the `vps` entry of the `contract` job in `.github/workflows/sandbox-images.yml` builds the
  image, asserts the user IDs, runs `smoke_test.py verify` through `--entrypoint`, then runs
  `smoke_test.py contract` twice on a read-only root with an exec tmpfs `/tmp` and empty bind
  mounts. A preexisting user file must survive.

## Deployment and refresh

Terraform uses the shared build-input hash for change detection and the existing provider bindings
for artifact selection. Modal passes the verified native image ID to function deployment; other
providers use verified template/snapshot references. E2B and Daytona now build distinct names before
switching their existing Worker bindings. The configured E2B/Daytona base names act as prefixes.
Vercel/OpenComputer retain their existing manual-reference overrides.

For manual deployment, use the returned reference in the provider's existing configuration; do not
assume building alone redirects sessions. Roll back using a previous known-good configuration and
retained artifact. Do not delete artifacts still referenced by sessions or prepared images.

The `filesystem` phase also runs `opencode models --refresh` for the runtime user, so sessions
without a prepared image still see models newer than the pinned OpenCode release. It is best-effort:
a failure leaves OpenCode's built-in catalog in use. Prepared repository and environment images
refresh the catalog on every build.

**Prepared repository images do not automatically refresh when the base toolchain changes.** Use the
existing repository/environment image-build workflow to rebuild them after dependency-only updates
when needed. Runtime version reporting, compatibility floors, and saved-session behavior are
unchanged. This package adds no database columns or callback fields.

## Build implementation and local validation

One conservative source hash covers installation and build/deployment tooling. Changes to broad
provider or Vercel control-plane/shared source roots may trigger extra builds; there is no separate
installed-image hash or exact-content attestation.

`pack` creates a fresh staging directory from explicitly allowed payload roots. It sets and checks
the packed modes, keeps contained symlinks, rejects missing inputs, and never reuses another
caller's directory. No detailed file manifest or shared staging-cache reconciliation remains. Build
from a stable checkout. Staging directories under `.cache/sandbox-images` may be removed when no
build is using them.

```bash
uv run --frozen --project packages/sandbox-images --extra dev pytest packages/sandbox-images/tests
bundle=$(python3 packages/sandbox-images/cli.py pack --provider e2b)
docker build --platform linux/amd64 -f packages/sandbox-images/Dockerfile -t openinspect-image-contract "$bundle"
docker run --rm --platform linux/amd64 openinspect-image-contract
```

For Amazon Linux, use a Vercel bundle and `--build-arg BASE_IMAGE=amazonlinux:2023`. Native-amd64 CI
tests both OS families. Chromium may trap under amd64 emulation on ARM Macs. Reference-container
success does not replace provider-native verification.

See [design scope](../../docs/plans/sandbox-image-dependency-consolidation.md).
