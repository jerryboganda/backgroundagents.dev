# Unsupported features, gaps and open feasibility items

Container parity is not claimed. Each item below is either missing on the Node
host, unverified, or an owner gate. Evidence references point at the pinned
revision (`02a6bbf1c2720699444d91867026e8b0111ed6fc`). Items marked **code** would
need an upstream change, which this package does not make.

## A. Upstream features absent or Cloudflare-only on the Node container

| # | Feature | Status on the container | Evidence |
|---|---|---|---|
| A1 | GitHub autofix queue and its ingress | **Absent.** The Worker-only `github-bot` sends to `AUTOFIX_QUEUE`. The Node host has no sender for the `github.autofix` job. | `packages/github-bot/src/index.ts:106-110`; `src/jobs.ts:98`; `src/autofix/queue-health.ts:78-82` |
| A2 | Slack bot | **Absent.** Worker-only service binding; no HTTPS transport on Node. | `host.ts:190-196` vs `cloudflare/platform.ts` |
| A3 | Linear bot | **Absent**, same as A2. | same |
| A4 | Slack notices from the scheduler | **Silently skipped** when the binding or secret is missing. Not listed in upstream docs. | `scheduler/scheduler.ts:1714-1716, 1805-1807, 1858-1860` |
| A5 | Team channel lookups | Guarded. Skipped without the Slack binding. | `routes/team-channel-bindings.ts:60` |
| A6 | Owner bootstrap | **Replaced here** by `scripts/bootstrap-node-owner.ts`. The upstream path is D1-only. Tested against temporary stores. Not yet run against a live store. | `runbooks/owner-bootstrap.md` |
| A7 | Web frontend in a container | **Added here** (`packages/web/Dockerfile`). Upstream ships the web for Vercel and Cloudflare only. Build and start not yet executed. | `.codex-pipeline/upstream-audit.md` §12 |
| A8 | Cloudflare service binding for the web | Code path present; the Node path uses plain `fetch`. | `packages/web/src/lib/control-plane-transport.ts:2-5, 48-56, 110-114` |
| A9 | `Dockerfile.test` | Not used by any CI job or script. Not relied on. | grep, audit §16 |

## B. Missing enforcement (code gaps)

| # | Gap | Consequence | Mitigation available now |
|---|---|---|---|
| B1 | **No global cap on concurrent top-level sessions.** No `MAX_CONCURRENT`, `maxConcurrent`, `max_concurrent` or `MAX_SESSIONS` in the code. | Usage is limited only by admission and by provider budgets. | Keep the pilot user list small. Set a Modal spending limit and watch it. The per-parent child cap (default 5, HTTP 429) and the Node job concurrency (8) do limit parts of the load. |
| B2 | No Modal-side `concurrency_limit` or `max_containers`. | Modal does not cap concurrent sandboxes from this side. | Modal workspace limits (owner). |
| B3 | Session inactivity and budgets are not verified. | The defaults for `SANDBOX_INACTIVITY_TIMEOUT_MS` and the budgets were not read. | Set explicit values in `control-plane.env` after reading the code. |
| B4 | Backups of session databases, alarms, jobs and object storage. | Upstream has none. | Implemented here: `backup.sh`. Restore rehearsal: `restore-rehearsal.sh`, not yet run. |
| B5 | Automation trigger body schema, status polling, idempotency. | Not verified. | Needed for any orchestrator (section D). |
| B6 | `X-OpenInspect-Client-IP` trust. | Whether the control plane trusts it only from a verified service call was not verified. | Verify in code before relying on it for admission decisions. |
| B7 | Web health endpoint. | None upstream. | The web image's health probe checks for an HTTP status below 500 on `/`. |

## C. Base images and upstream files not modified here

- The upstream control-plane Dockerfile names `node:24-slim` and `litestream/litestream:0.3.13` by tag. The image built from it is pinned by its CI-recorded ID, but its base layers are not digest-pinned. This package does not edit upstream files.
- Digests in use, resolved 2026-10-16: `node:24-slim` `sha256:a5f4366e…daee5`; `litestream/litestream:0.3.13` `sha256:027eda2a…d8d58`; SeaweedFS `4.47` pinned upstream.
- The upstream dependabot check failed on the pin. It was not investigated.
- The upstream Compose smoke is the only container-level evidence upstream has. It passes at the pin according to CI. It uses a fake Modal, not the real one.
- Not covered by any upstream test: real GitHub OAuth, real Modal sandboxes, Claude and ChatGPT subscription flows, and a Litestream restore to real S3. The Dockerfile itself says Litestream restore works only against a plain-HTTP local store.

## D. Cross-harness orchestration (separate feature; feasibility only)

Upstream child sessions inherit the parent's harness. `spawn-child` cannot switch
harness, so the cross-harness pipeline in the mission cannot be built on child sessions.

- **Option A (no upstream change; unverified).** One automation per harness (Claude
  Agent, the OpenAI-backed harness, OpenCode). The orchestrator triggers each one with
  its Bearer key and reads back the returned `sessionId`. Unverified: the trigger body
  schema, status polling, PR outputs, and idempotency. The receipts table from
  migration 0088 suggests the idempotency path exists, but that was not tested.
- **Option B (upstream change; higher risk).** A fifth service principal. `SERVICE_NAMES`
  is a fixed tuple in `packages/shared/src/service-auth.ts:28`.
- **Option C (user identity).** Not suitable for unattended operation.

No orchestrator is implemented in this package. Its completion status is separate
from the deployment's, and it has not been started.

## E. Owner gates and unverified external facts

- GitHub App: created, installed or authorized? Not verified. See `accounts-and-admission.md` §1.
- Modal: workspace, tokens and deployed functions: unverified.
- Claude, ChatGPT and OpenCode providers: unverified.
- DNS for `cp.ai.polytronx.com`: absent. Owner action.
- Proxy attach and ai host replacement: owner authorization required.
- Off-server backup destination: none. Owner decision.
- Origin certificate expiry (observed 2026-10-17 18:47 GMT) and its renewal: unverified.

## F. Files this package could not read

The pipeline's deny rule blocked `.env.example` (root) and `packages/web/.env.example`, and
the rule was not bypassed. Variable names here come from the code
(`packages/control-plane/src/node/config.ts`), from the container smoke's environment
block (`scripts/compose-smoke.sh`), and from upstream docs. They were not read from the
example files. Check them against those files before the first deploy.
