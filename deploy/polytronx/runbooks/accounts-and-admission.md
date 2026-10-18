# Accounts, identities and admission

Every item here is an owner action or an external account. None is verified by this package, and
none has credentials in the repository. Each entry names the upstream file it was taken from, so the
owner can check it against the pinned revision before acting.

## 1. GitHub App (dedicated; installed on pilot repositories only)

Source: upstream `docs/GETTING_STARTED.md` lines 297–334, as summarized in the audit.

- Homepage URL: `https://ai.polytronx.com`
- Callback URL (user authorization): `https://ai.polytronx.com/api/auth/callback/github`. The match
  is exact.
- Keep "User-to-server token expiration" enabled.
- Repository permissions: Contents read and write; Pull requests read and write; Metadata read.
- Add only for the GitHub bot, which this deployment does not enable: Actions read, Checks read,
  Issues read and write.
- Webhook: inactive. It becomes active only with the bot.
- Install on the selected pilot repositories. Do not choose "all repositories".
- The helper records the App ID, the installation ID and the credentials in `control-plane.env`. Do
  not paste keys by hand (see 1a).
- Private key: GitHub creates it at registration. The helper converts it to PKCS#8, which
  `github-app.ts` requires, and writes one line with each newline as `\n`.

Whether an App already exists is not verified. The readiness check could not list installations
(HTTP 403 through the user API). Do not reuse another App without authorization.

### 1a. Register and verify with the helper

Run on the VPS as root, with `POLYTRONX_SECRETS_DIR` set to the absolute secrets directory. Node 18
or later. The helper prints no credential value.

1. Pinned in `deploy/polytronx/github-app-bootstrap.mjs` as `PILOT_ACCOUNT_ID = 186593041`: the
   numeric `id` from `GET https://api.github.com/users/jerryboganda` (public, no token), matching
   `owner.id` in `GET https://api.github.com/repos/jerryboganda/backgroundagents.dev`, both read
   2026-10-18. `verify` refuses while it is null, and `manifest` refuses an App whose `owner.id`
   differs from it.
2. Workstation: `ssh -L 8765:127.0.0.1:8765 <vps>`, then open `http://localhost:8765/`. Use
   `localhost`, not `127.0.0.1`: the callback and the cookie depend on it.
3. VPS:
   `sudo POLYTRONX_SECRETS_DIR=<secrets dir> node deploy/polytronx/github-app-bootstrap.mjs manifest`.
4. Owner step: click "Create the GitHub App" while signed in to GitHub as `jerryboganda`. The page
   then shows "Credentials stored. No values shown."
5. Before installing, open the new App's settings (Permissions & events > Account permissions) and
   set Email addresses to Read-only: GitHub's manifest rejects that permission, and `verify` refuses
   until it is set. Setting it first avoids a pending permission request on the installation.
6. Install the App on `jerryboganda/backgroundagents.dev` only ("Only select repositories"). Check
   the App's permissions: contents and pull requests write, issues write. If GitHub lists any other
   repository, change the selection before you run `verify`.
7. VPS:
   `sudo POLYTRONX_SECRETS_DIR=<secrets dir> node deploy/polytronx/github-app-bootstrap.mjs verify`.
   It prints `verify: PASS` or `verify: FAIL: <reason>`. Only PASS writes
   `GITHUB_APP_INSTALLATION_ID`. `verify` mints a token without a repository filter and passes only
   when the installation lists exactly one repository, the pilot. It also refuses a suspended
   installation, or one whose repository permissions differ from the manifest.

If the helper refuses after GitHub created the App, the helper has already used the code and nothing
was stored. GitHub's manifest docs call the code temporary, valid for one hour, and do not say it is
single-use. Delete that App in GitHub's developer settings before retrying, so no unused App
remains. Pass `--replace-existing-app` to `manifest` only when you mean to replace an App that is
already recorded; without it, `manifest` refuses. Every successful `manifest` run clears
`GITHUB_APP_INSTALLATION_ID`, so `verify` must run again.

Open before the first live run:

- The manifest redirect is `http://localhost:8765/manifest/callback`. The manifest docs set no
  scheme or host restriction on `redirect_url`, so only the first live submit shows whether GitHub
  accepts it. If it does not, the flow times out and stores nothing.
- The manifest omits `email_addresses`: GitHub's manifest page rejected it live ("Default permission
  ... resource is not included in the list"). `verify` reads `GET /app` and requires
  `email_addresses: read` instead. The live conversion response is checked against the manifest's
  repository permissions, and a mismatch refuses after the App exists (see above).
- `full_name` in the `GET /installation/repositories` items is not shown on
  `docs.github.com/en/rest/apps/installations`, so it is unconfirmed. `verify` refuses if it is
  absent.
- `DELETE /installation/token` is documented on `docs.github.com/en/rest/apps/installations`
  ("Revoke an installation access token", 204). If GitHub rejects it anyway, `verify` refuses and
  writes no installation ID.
- Issues write is requested because the control plane posts PR comments through the issues API
  (`packages/control-plane/src/source-control/providers/github-provider.ts:288`). The Issues bullet
  in section 1 lists Issues only for the bot. The owner decides which applies.
- `email_addresses` is an account permission. The installation object may omit it, so `verify` does
  not compare it there. The App's copy is checked by `verify` through `GET /app`. The installation's
  repository permissions (contents, issues and pull requests write, metadata read) are compared
  exactly.
- Reloading the manifest page keeps the same form and cookie. The page answers 409 only after GitHub
  redirects back with the code, until the flow ends. The helper cannot see the form submit.
- If the 15-minute window closes while credentials are being written, the write finishes and the
  helper reports the real result.

## 2. GitHub OAuth (sign-in)

The OAuth client pair belongs to the same App, which the upstream setup allows. Set
`GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. Both must be set, or neither. Google sign-in is
optional. If enabled, it needs its own pair and the callback
`https://ai.polytronx.com/api/auth/callback/google`.

## 3. Admission (fail closed)

Source: `packages/control-plane/src/auth/user/runtime.ts`, lines 92–153, as summarized in the audit.

- `UNSAFE_ALLOW_ALL_USERS=false`. Preflight fails on `true`.
- Name the pilot users. GitHub sign-in needs a GitHub-specific rule (`ALLOWED_USERS` or
  `ALLOWED_GITHUB_ORGS`) or a provider-neutral one (`ALLOWED_EMAILS` or `ALLOWED_EMAIL_DOMAINS`).
- `TEAMS_ENFORCEMENT=on` is what the mission asks for. The upstream default is `shadow`. Before the
  first deploy, confirm the accepted values in
  `packages/control-plane/src/authorization/teams-enforcement.ts`.
- The first Owner is set with `runbooks/owner-bootstrap.md`, after the user signs in.

## 4. Modal (sandbox provider; external paid account)

Source: upstream `docs/SETUP_GUIDE.md` lines 219–224, `packages/modal-infra/src/app.py` lines
47–108, and `packages/modal-infra/README.md`.

- Account, workspace and CLI authentication belong to the owner. This package does not hold Modal
  tokens. Preflight checks only the local `MODAL_API_SECRET` value's presence.
- Deploy the sandbox functions with the repository's documented commands, from
  `packages/modal-infra`: `uv run python deploy.py --build-sandbox-image`, then
  `uv run modal deploy deploy.py`. Deploy `deploy.py`, not `src/app.py`. Those commands create paid
  resources. Run them only after the owner approves the budget.
- Modal secret `internal-api` holds `MODAL_API_SECRET` (must equal the control plane's value) and
  `ALLOWED_CONTROL_PLANE_HOSTS`. Set the latter to the bare host `cp.ai.polytronx.com`. Do not add
  `:443`. The allowlist matches the whole netloc, so a port breaks it. Callback validation is
  fail-closed: an unset allowlist rejects every URL.
- Set `MAX_ACTIVE_SANDBOXES=2` (parent and child) in the dedicated Modal environment's
  `internal-api` secret, then deploy the functions. `preflight.sh` makes an unauthenticated GET of
  the provider's `api-health` and refuses the deploy unless it reports `max_active_sandboxes` 2 with
  `capacity_enforcement` `pre-create`. A provider that predates that field, or any other answer, is
  a blocker. The value 2 is `PROVIDER_MAX_ACTIVE_SANDBOXES` in `pins.env`.
- Set a spending limit in Modal. The code does not enforce one. See
  `runbooks/unsupported-and-gaps.md` for concurrency and session caps.
- Do not set `MODAL_API_URL`. Leave it unset, so the control plane derives the `*.modal.run`
  endpoint.
- The Docker-in-VM sandbox variant (`BUILD_MODAL_VM_IMAGE=true`) runs a Docker daemon inside a Modal
  VM. Do not enable it without review. This package does not use it.

## 5. Provider accounts (agent harnesses)

Source: `docs/CLAUDE_AGENT.md`, `docs/OPENAI_MODELS.md`, `provider-accounts.md`, as summarized in
the audit.

- **Claude Code / Claude subscription.** Connect the account under Settings > Provider Accounts.
  Browser consent (scope `user:inference`) is preferred. The alternative is `claude setup-token`,
  which gives a static token of about a year, encrypted at rest and never shown in the browser.
  Automated sessions use "Use default" or "No account (API key)". Verify that a session reports the
  connected account, not an API key.
- **OpenAI Codex (ChatGPT subscription).** Authorization is a device flow, not a browser redirect.
  Tokens are encrypted with `PROVIDER_ACCOUNTS_ENCRYPTION_KEY`. Account mode overrides
  `OPENAI_API_KEY` for the session. Confirm that no API key is required for the chosen mode.
- **OpenCode.** Anthropic models on OpenCode require `ANTHROPIC_API_KEY` (per `CLAUDE_AGENT.md`).
  Those calls are billed as API usage, whatever the Claude subscription. Other providers (OpenCode
  Zen and Go, and others) are opt-in. Their billing was not verified.
- Never put a provider token or setup token in a file in this repository, in a log, or in a chat.

## 6. DNS

- `ai.polytronx.com` resolves to Cloudflare proxied addresses. Its existing A/AAAA records are the
  owner's. Do not change them without authorization.
- `cp.ai.polytronx.com` does not exist (NXDOMAIN at the audit). The owner creates it, pointing to
  `185.252.233.186`. Decide whether it is DNS-only or proxied. A proxied name uses Cloudflare's
  certificate, but an HTTP-01 certificate on this host needs the name to reach the host.
- The origin certificate for the existing ai host was observed to expire on 2026-10-17 at 18:47 GMT.
  Renewal was not verified. Confirm the proxy's certificate before relying on the current route.

## 7. Proxy

`templates/npm-edge-proxy.md`. The owner attaches NPM to `polytronx-edge` and creates the two routes
in the UI. The ai host replacement needs explicit authorization.

## 8. Secrets handling

- Generate secrets on the VPS with `openssl`. Write them to files in `secrets/` (0600), never to a
  chat, a shell history or a repository file.
- Do not regenerate an encryption key. Records written with the old key cannot be read with a new
  one.
- Keep the backup key off the host. The encrypted backup holds these secrets, and the key is the
  only way to open it.
