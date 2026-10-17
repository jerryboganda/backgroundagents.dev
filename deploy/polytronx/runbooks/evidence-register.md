# Evidence register

One line per check. A check is **PASS** only with a recorded command, exit code
and output. Static reads, dry runs and unit tests are not runtime acceptance.
Fill the table as runs happen. Never record a secret value. Record run IDs, digests
and PASS/FAIL lines only.

## Status at WP-7 (package complete, nothing deployed)

| Check | Where it runs | Status | Evidence |
|---|---|---|---|
| Owner bootstrap unit tests (18 cases, real migrations, temp stores) | local | **PASS**: exit 0, 18 pass, 0 fail, Node v24.19.0 | `node --experimental-transform-types --test scripts/bootstrap-node-owner.test.ts` |
| Shell syntax, the nine top-level `deploy/polytronx/*.sh` | local | **PASS**: exit 0, no output | `find deploy/polytronx -maxdepth 1 -name '*.sh' -exec bash -n '{}' ';'` |
| Dependency install | local | **FAIL**: one bounded attempt hit its 240 s limit (exit 124) with no output. Not retried | `timeout 240s env CI=1 HUSKY=0 npm ci --no-audit --fund=false --fetch-retries=0 --fetch-timeout=45000` |
| Shared and control-plane bundle builds, web build, unit tests, lint, typecheck | local | **NOT RUN**: no dependencies installed | job `verify` |
| Owner bootstrap tests, shell syntax, builds, unit tests, lint, typecheck | CI, job `verify` | **NOT RUN**: workflow written, not dispatched | `.github/workflows/polytronx-openinspect.yml` |
| Web image build, layout, start | CI, job `images` | **NOT RUN** | `packages/web/Dockerfile` |
| Control-plane image build and upstream Compose smoke at the pin | CI, job `images` | **NOT RUN** here. Upstream CI reported PASS at the pin | `scripts/compose-smoke.sh`; upstream audit §1 |
| `docker compose config` render, production and rehearsal, plus fail-closed case | CI, job `compose-render` | **NOT RUN** | job `compose-render` |
| Existing NPM origin certificate for ai (npm-38): `nginx -t`, graceful reload, origin handshake | VPS, trusted SSH, WP-7 | **PASS**: `nginx -t` exit 0; `nginx -s reload` exit 0. Origin notAfter is now Jan 13 2027 (was Oct 17 2026), fingerprint equal to on-disk npm-38. HTTP 401 before and after. NPM container uptime unchanged. Containers 72 total, 69 running, 3 exited, before and after. medicalos-api-1 unhealthy before and after | this file |
| Shell scripts: smoke, deploy, rollback, backup, restore, monitor against a live Docker | VPS, after approval | **NOT RUN** | — |
| Backup archive round trip (encrypt, list, decrypt) | VPS | **NOT RUN** | `backup.sh` reads back its own archives; the result is in its output |
| Restore rehearsal in an isolated project | VPS, after approval | **NOT RUN** | `restore-rehearsal.sh` |
| Owner bootstrap against a live store | VPS, after sign-in | **NOT RUN** | `runbooks/owner-bootstrap.md` |
| GitHub App, OAuth, sign-in, admission | owner | **NOT RUN** | `runbooks/accounts-and-admission.md` §1–3 |
| Modal sandbox provisioning and callback | owner (paid) | **NOT RUN** | §4 |
| Claude, Codex and OpenCode sessions | owner | **NOT RUN** | §5 |
| DNS `cp.ai.polytronx.com` | owner | **NOT RUN** (record absent at audit) | §6 |
| Proxy routes for web and control plane, TLS, WebSockets | owner | **NOT RUN** | `templates/npm-edge-proxy.md` |
| Agent branch, pull request, child session, review comments | owner, pilot repo | **NOT RUN** | — |
| Cross-harness controller | separate feature | **NOT STARTED** | `runbooks/unsupported-and-gaps.md` §D |

## Status at WP-10 (release repair, nothing deployed)

| Check | Where it runs | Status | Evidence |
|---|---|---|---|
| Deployment guard tests: deploy, backup, rollback, restore refusals, cap gate, disk root, backup age, overlay allowlist | local, stubbed docker, curl, df | **PASS** on Windows, Node v24.19.0: 47 pass, 0 fail, 1 skipped (the real `flock` lock test, which runs in CI). Windows stands in for `stat -c %a` (NTFS keeps no POSIX modes) | `node --test deploy/polytronx/*.test.mjs` |
| Rendered-config rules (production and rehearsal, fixtures) | local | **PASS** (inside the run above) | `rendered-config.test.mjs` |
| Owner bootstrap unit tests | local | **PASS**: 18 pass, 0 fail, Node v24.19.0 | `node --experimental-transform-types --test scripts/bootstrap-node-owner.test.ts` |
| Shell syntax, the nine top-level `deploy/polytronx/*.sh` | local | **PASS**: exit 0 | `find deploy/polytronx -maxdepth 1 -name '*.sh' -exec bash -n '{}' ';'` |
| Overlay allowlist witness: a nested `.gitignore` is refused, the anchored `.gitignore` is accepted | local | **PASS** | `grep -Ev` against the workflow's `allowed` line |
| Action refs: `actions/checkout`, `actions/setup-node`, `actions/upload-artifact`, `astral-sh/setup-uv` | `git ls-remote --tags` of the official repositories | **PASS**: tags exist; the workflow pins commit SHAs with the release tag as a comment | `.github/workflows/polytronx-openinspect.yml` |
| Standalone bootstrap typecheck | CI, job `verify` | **NOT RUN**: no TypeScript installed locally, and no npm install is permitted here | `npx --no-install tsc -p scripts/tsconfig.bootstrap.json` |
| Rendered compose configuration, production and rehearsal | CI, job `compose-render` | **NOT RUN**: no Docker locally | `rendered-config.mjs` on `docker compose config --format json` |
| Linux Modal checks: `uv sync --locked`, ruff, mypy, pytest | CI, job `modal-linux` | **NOT RUN**: no Linux runner here. Windows baseline not run | `packages/modal-infra` |
| Image builds, compose up, smoke, rehearsal restore, backup round trip | VPS and CI | **NOT RUN** | — |
| Provider cap gate against the deployed Modal app | VPS, after the Modal app is deployed with the cap | **NOT RUN**: this repair made no provider call | `preflight.sh` |
| NPM forward hostnames on `polytronx-edge`, `access_log off` on `ai` | owner | **NOT RUN** | `templates/npm-edge-proxy.md` |
| Periodic backup timer, and the backup-age alert | VPS, owner approval | **NOT RUN** | `templates/polytronx-backup.*`, `monitor.sh` |

## Runtime record (filled during deployment)

| Date (UTC) | Check | Command or action | Exit or result | Evidence reference |
|---|---|---|---|---|
| | CI images | run ID | | digests in `release-manifest.env` |
| | preflight | `preflight.sh` | | output, PASS/WARN/FAIL lines |
| | pre-deploy backup | `backup.sh --label pre-deploy` | | `MANIFEST.env`, `SHA256SUMS` |
| | deploy | `deploy.sh` | | `state/deploy-log.txt` |
| | smoke | `smoke.sh` | | output |
| | rehearsal restore | `restore-rehearsal.sh` | | output |
| | owner bootstrap dry run | `owner-bootstrap.sh` | | `preflight` line |
| | owner bootstrap execute | `owner-bootstrap.sh --execute` | | `postcondition` line |
| | sign-in and admission | browser, owner | | |
| | WebSocket reconnect | browser, owner | | |
| | Modal provisioning | owner | | |
| | agent sessions | owner | | |
| | monitor | `monitor.sh` | | output |

## Gates that must hold before a claim of completion

1. Every row in the runtime record shows an exit code or an owner's observed result.
2. `deploy-log.txt` shows a deploy that passed smoke, for the release under test.
3. A restore rehearsal succeeded for that release's backup.
4. The GitHub App, OAuth and Modal items are complete, with the owner's sign-off.
5. Each unsupported item in `unsupported-and-gaps.md` is either accepted by the owner or still listed as open.
