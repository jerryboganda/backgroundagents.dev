# Accounts, identities and admission

Every item here is an owner action or an external account. None is verified by
this package, and none has credentials in the repository. Each entry names the
upstream file it was taken from, so the owner can check it against the pinned
revision before acting.

## 1. GitHub App (dedicated; installed on pilot repositories only)

Source: upstream `docs/GETTING_STARTED.md` lines 297–334, as summarized in the audit.

- Homepage URL: `https://ai.polytronx.com`
- Callback URL (user authorization): `https://ai.polytronx.com/api/auth/callback/github`. The match is exact.
- Keep "User-to-server token expiration" enabled.
- Repository permissions: Contents read and write; Pull requests read and write; Metadata read.
- Add only for the GitHub bot, which this deployment does not enable: Actions read, Checks read, Issues read and write.
- Webhook: inactive. It becomes active only with the bot.
- Install on the selected pilot repositories. Do not choose "all repositories".
- Record the App ID and the installation ID in `control-plane.env`.
- Private key: generate it in the App settings. Put the PEM in `control-plane.env` on one line, with each newline written as `\n`. `github-app.ts` accepts that form.

Whether an App already exists is not verified. The readiness check could not list
installations (HTTP 403 through the user API). Do not reuse another App without
authorization.

## 2. GitHub OAuth (sign-in)

The OAuth client pair belongs to the same App, which the upstream setup allows.
Set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. Both must be set, or neither.
Google sign-in is optional. If enabled, it needs its own pair and the callback
`https://ai.polytronx.com/api/auth/callback/google`.

## 3. Admission (fail closed)

Source: `packages/control-plane/src/auth/user/runtime.ts`, lines 92–153, as summarized in the audit.

- `UNSAFE_ALLOW_ALL_USERS=false`. Preflight fails on `true`.
- Name the pilot users. GitHub sign-in needs a GitHub-specific rule (`ALLOWED_USERS`
  or `ALLOWED_GITHUB_ORGS`) or a provider-neutral one (`ALLOWED_EMAILS` or `ALLOWED_EMAIL_DOMAINS`).
- `TEAMS_ENFORCEMENT=on` is what the mission asks for. The upstream default is
  `shadow`. Before the first deploy, confirm the accepted values in
  `packages/control-plane/src/authorization/teams-enforcement.ts`.
- The first Owner is set with `runbooks/owner-bootstrap.md`, after the user signs in.

## 4. Modal (sandbox provider; external paid account)

Source: upstream `docs/SETUP_GUIDE.md` lines 219–224, `packages/modal-infra/src/app.py` lines 47–108, and `packages/modal-infra/README.md`.

- Account, workspace and CLI authentication belong to the owner. This package does not
  hold Modal tokens. Preflight checks only the local `MODAL_API_SECRET` value's presence.
- Deploy the sandbox functions with the repository's documented commands, from
  `packages/modal-infra`: `uv run python deploy.py --build-sandbox-image`, then
  `uv run modal deploy deploy.py`. Deploy `deploy.py`, not `src/app.py`. Those
  commands create paid resources. Run them only after the owner approves the budget.
- Modal secret `internal-api` holds `MODAL_API_SECRET` (must equal the control
  plane's value) and `ALLOWED_CONTROL_PLANE_HOSTS`. Set the latter to the bare host
  `cp.ai.polytronx.com`. Do not add `:443`. The allowlist matches the whole netloc,
  so a port breaks it. Callback validation is fail-closed: an unset allowlist
  rejects every URL.
- Set `MAX_ACTIVE_SANDBOXES=2` (parent and child) in the dedicated Modal environment's
  `internal-api` secret, then deploy the functions. `preflight.sh` makes an unauthenticated
  GET of the provider's `api-health` and refuses the deploy unless it reports
  `max_active_sandboxes` 2 with `capacity_enforcement` `pre-create`. A provider that
  predates that field, or any other answer, is a blocker. The value 2 is
  `PROVIDER_MAX_ACTIVE_SANDBOXES` in `pins.env`.
- Set a spending limit in Modal. The code does not enforce one. See
  `runbooks/unsupported-and-gaps.md` for concurrency and session caps.
- Do not set `MODAL_API_URL`. Leave it unset, so the control plane derives the
  `*.modal.run` endpoint.
- The Docker-in-VM sandbox variant (`BUILD_MODAL_VM_IMAGE=true`) runs a Docker
  daemon inside a Modal VM. Do not enable it without review. This package does not
  use it.

## 5. Provider accounts (agent harnesses)

Source: `docs/CLAUDE_AGENT.md`, `docs/OPENAI_MODELS.md`, `provider-accounts.md`, as summarized in the audit.

- **Claude Code / Claude subscription.** Connect the account under Settings > Provider
  Accounts. Browser consent (scope `user:inference`) is preferred. The alternative is
  `claude setup-token`, which gives a static token of about a year, encrypted at rest and
  never shown in the browser. Automated sessions use "Use default" or "No account
  (API key)". Verify that a session reports the connected account, not an API key.
- **OpenAI Codex (ChatGPT subscription).** Authorization is a device flow, not a browser
  redirect. Tokens are encrypted with `PROVIDER_ACCOUNTS_ENCRYPTION_KEY`. Account mode overrides
  `OPENAI_API_KEY` for the session. Confirm that no API key is required for the
  chosen mode.
- **OpenCode.** Anthropic models on OpenCode require `ANTHROPIC_API_KEY` (per
  `CLAUDE_AGENT.md`). Those calls are billed as API usage, whatever the Claude
  subscription. Other providers (OpenCode Zen and Go, and others) are opt-in. Their billing was not
  verified.
- Never put a provider token or setup token in a file in this repository, in a log,
  or in a chat.

## 6. DNS

- `ai.polytronx.com` resolves to Cloudflare proxied addresses. Its existing A/AAAA
  records are the owner's. Do not change them without authorization.
- `cp.ai.polytronx.com` does not exist (NXDOMAIN at the audit). The owner creates it,
  pointing to `185.252.233.186`. Decide whether it is DNS-only or proxied. A proxied
  name uses Cloudflare's certificate, but an HTTP-01 certificate on this host needs
  the name to reach the host.
- The origin certificate for the existing ai host was observed to expire on
  2026-10-17 at 18:47 GMT. Renewal was not verified. Confirm the proxy's certificate
  before relying on the current route.

## 7. Proxy

`templates/npm-edge-proxy.md`. The owner attaches NPM to `polytronx-edge` and creates
the two routes in the UI. The ai host replacement needs explicit authorization.

## 8. Secrets handling

- Generate secrets on the VPS with `openssl`. Write them to files in
  `secrets/` (0600), never to a chat, a shell history or a repository file.
- Do not regenerate an encryption key. Records written with the old key cannot be read with a new one.
- Keep the backup key off the host. The encrypted backup holds these secrets, and the key
  is the only way to open it.
