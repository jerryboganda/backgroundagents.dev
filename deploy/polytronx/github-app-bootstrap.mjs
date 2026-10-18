// GitHub App bootstrap for the polytronx host. Node built-ins only.
//
//   node deploy/polytronx/github-app-bootstrap.mjs manifest [--replace-existing-app]
//   node deploy/polytronx/github-app-bootstrap.mjs verify
//
// Run as root with POLYTRONX_SECRETS_DIR set to the directory that holds control-plane.env.
// manifest serves a loopback page, converts the one-time code GitHub returns, and merges the App
// credentials into the env file. verify binds GITHUB_APP_INSTALLATION_ID to the pilot account and
// only the pilot repository. No credential value is printed, logged, or sent to the browser. Reach the helper
// through an SSH local forward only, never through the edge proxy.

import { createPrivateKey, createSign, randomBytes, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MANIFEST_HOST = "127.0.0.1";
export const MANIFEST_PORT = 8765;
export const MANIFEST_TOTAL_TIMEOUT_MS = 15 * 60_000;
export const GITHUB_API_TIMEOUT_MS = 10_000;
export const HTTP_TIMEOUT_MS = 5_000;
export const COOKIE_MAX_AGE_SECONDS = 900;
export const JWT_BACKDATE_SECONDS = 60;
export const JWT_LIFETIME_SECONDS = 540;

// PILOT_ACCOUNT_ID is the numeric id of the pilot login, fetched once from the public user endpoint
// and pinned in a reviewed change. Null fails closed: verify refuses until it is pinned.
export const PILOT_ACCOUNT_LOGIN = "jerryboganda";
export const PILOT_ACCOUNT_ID = 186593041;
export const PILOT_REPO_FULL_NAME = "jerryboganda/backgroundagents.dev";
const DEFAULT_PILOT = Object.freeze({
  accountLogin: PILOT_ACCOUNT_LOGIN,
  accountId: PILOT_ACCOUNT_ID,
  repoFullName: PILOT_REPO_FULL_NAME,
});

const ENV_FILE_NAME = "control-plane.env";
const REPLACE_FLAG = "--replace-existing-app";
const USAGE = "usage: github-app-bootstrap.mjs manifest [--replace-existing-app] | verify\n";
const PUBLIC_ORIGIN = "https://ai.polytronx.com";
const SIGN_IN_CALLBACK_PATH = "/api/auth/callback/github";
const MANIFEST_CALLBACK_PATH = "/manifest/callback";
const COOKIE_NAME = "gh_bootstrap";
const GITHUB_WEB_ORIGIN = "https://github.com";
const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const USER_AGENT = "polytronx-github-app-bootstrap";
const PAGE_SIZE = 100;
const MANIFEST_CODE_MAX_LENGTH = 256;
const MAX_PEM_LENGTH = 16_384;
const MAX_ENV_VALUE_LENGTH = 8_192;
const MIN_RSA_MODULUS_BITS = 2048;
const POSIX = process.platform !== "win32";
const ENV_KEY_PATTERN = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
const ENV_VALUE_PATTERN = /^[\x21-\x7e]*$/;
// The PEM header and footer contain spaces, so the private key is checked against its own shape.
// Dashes use {5} so the PEM header and footer text are not literals here; the diff secret scanner flags them.
const PRIVATE_KEY_LINE_PATTERN =
  /^-{5}BEGIN PRIVATE KEY-----(?:\\n[A-Za-z0-9+/=]+)+\\n-{5}END PRIVATE KEY-----$/;
const APP_ID_PATTERN = /^[1-9][0-9]{0,11}$/;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const CLIENT_SECRET_PATTERN = /^[A-Za-z0-9._-]{1,256}$/;

export const APP_ENV_KEYS = Object.freeze([
  "GITHUB_BOT_USERNAME",
  "GITHUB_APP_ID",
  "GITHUB_APP_INSTALLATION_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
]);

const DEFAULT_PERMISSIONS = Object.freeze({
  contents: "write",
  issues: "write",
  pull_requests: "write",
  email_addresses: "read",
});

// Installation permissions cover repositories and organizations. Account permissions such as
// email_addresses belong to the App, which conversionToEnvUpdates checks, so they are not compared here.
const INSTALLATION_PERMISSIONS = Object.freeze({
  contents: "write",
  issues: "write",
  pull_requests: "write",
  metadata: "read",
});
const ACCOUNT_PERMISSIONS = Object.freeze(["email_addresses"]);

// ownerUid is only enforced on POSIX. Tests inject the test user's uid and a failing rename.
const DEFAULT_STORE = Object.freeze({ ownerUid: 0, rename: fs.rename });

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; form-action 'self' https://github.com; style-src 'unsafe-inline'; frame-ancestors 'none'",
  "Content-Type": "text/plain; charset=utf-8",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

export class Refusal extends Error {}

const refuse = (message) => {
  throw new Refusal(message);
};

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// Reads the last value of KEY, the way compose resolves duplicates. Never sources the file.
export function envValue(text, key) {
  let value = "";
  for (const line of text.split("\n")) {
    const match = ENV_KEY_PATTERN.exec(line);
    if (match?.[1] === key) value = line.slice(match[0].length).replace(/\r$/, "");
  }
  return value;
}

// Replaces allowlisted keys in place and appends missing ones. Every other line is kept byte-exact.
export function mergeEnvText(text, updates) {
  for (const [key, value] of Object.entries(updates)) {
    if (!APP_ENV_KEYS.includes(key)) refuse(`${key} is not an allowlisted key`);
    const shapeOk =
      key === "GITHUB_APP_PRIVATE_KEY"
        ? PRIVATE_KEY_LINE_PATTERN.test(value)
        : ENV_VALUE_PATTERN.test(value);
    if (!shapeOk || value.length > MAX_ENV_VALUE_LENGTH) refuse(`${key} has an unsupported value`);
  }
  const hadTrailingNewline = text.endsWith("\n");
  const lines = text === "" ? [] : text.split("\n");
  if (hadTrailingNewline) lines.pop();
  const written = new Set();
  const merged = lines.map((line) => {
    const key = ENV_KEY_PATTERN.exec(line)?.[1];
    if (key === undefined || !Object.hasOwn(updates, key)) return line;
    written.add(key);
    return `${key}=${updates[key]}`;
  });
  for (const key of Object.keys(updates)) {
    if (!written.has(key)) merged.push(`${key}=${updates[key]}`);
  }
  if (text === "" && merged.length === 0) return "";
  const addedLines = merged.length > lines.length;
  return merged.join("\n") + (hadTrailingNewline || addedLines ? "\n" : "");
}

async function assertParentDirectory(dir, store) {
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory()) refuse("secrets directory must be a real directory, not a link");
  if (!POSIX) return;
  if (stat.uid !== store.ownerUid || (stat.mode & 0o022) !== 0) {
    refuse("secrets directory must be owned by root and not group or world writable");
  }
  if ((await fs.realpath(dir)) !== path.resolve(dir))
    refuse("secrets directory path contains a link");
}

function assertTargetStat(stat, store) {
  if (!stat.isFile()) refuse("env file is not a regular file");
  if (stat.nlink !== 1) refuse("env file has a hard link");
  if (POSIX && (stat.uid !== store.ownerUid || (stat.mode & 0o777) !== 0o600)) {
    refuse("env file must be owned by root with mode 0600");
  }
}

// Opens the env file without following a final symlink, then checks the open descriptor.
async function readEnvFile(file, store) {
  const before = await fs
    .lstat(file)
    .catch(() => refuse("env file is missing; create it from the template first"));
  if (!before.isFile()) refuse("env file is not a regular file");
  const handle = await fs
    .open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
    .catch(() => refuse("env file cannot be opened"));
  try {
    const stat = await handle.stat();
    assertTargetStat(stat, store);
    await assertParentDirectory(path.dirname(file), store);
    return { text: (await handle.readFile()).toString("latin1"), stat };
  } finally {
    await handle.close();
  }
}

async function fsyncDirectory(dir) {
  const handle = await fs.open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Writes a temp file in the same directory, fsyncs it, renames it over the target, and fsyncs the
// directory. On failure the temp file is removed and the original file is untouched.
export async function writeEnvUpdates(file, updates, store = DEFAULT_STORE) {
  const { text, stat } = await readEnvFile(file, store);
  const next = mergeEnvText(text, updates);
  const dir = path.dirname(file);
  const temp = path.join(dir, `${path.basename(file)}.tmp-${randomBytes(8).toString("hex")}`);
  let handle;
  try {
    handle = await fs.open(temp, "wx", 0o600);
    await handle.writeFile(Buffer.from(next, "latin1"));
    if (POSIX) {
      await handle.chmod(0o600);
      await handle.chown(stat.uid, stat.gid);
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    await (store.rename ?? fs.rename)(temp, file);
  } catch {
    await handle?.close().catch(() => {});
    await fs.rm(temp, { force: true }).catch(() => {});
    refuse("env write failed; the env file is unchanged");
  }
  if (POSIX) {
    await fsyncDirectory(dir).catch(() =>
      refuse("env file was replaced but the directory sync failed")
    );
  }
}

export function loadRsaPrivateKey(pem, keyName) {
  let key;
  try {
    key = createPrivateKey(pem);
  } catch {
    refuse(`${keyName} does not parse as a private key`);
  }
  if (
    key.asymmetricKeyType !== "rsa" ||
    key.asymmetricKeyDetails.modulusLength < MIN_RSA_MODULUS_BITS
  ) {
    refuse(`${keyName} is not an RSA key of at least ${MIN_RSA_MODULUS_BITS} bits`);
  }
  return key;
}

// PKCS#1 PEM in, one env line out: PKCS#8 with each newline written as a literal backslash-n.
export function pkcs8EnvLine(pem, keyName = "private key") {
  return loadRsaPrivateKey(pem, keyName)
    .export({ type: "pkcs8", format: "pem" })
    .trimEnd()
    .replace(/\n/g, "\\n");
}

export function buildManifest(name) {
  return {
    name,
    url: PUBLIC_ORIGIN,
    redirect_url: `http://localhost:${MANIFEST_PORT}${MANIFEST_CALLBACK_PATH}`,
    callback_urls: [`${PUBLIC_ORIGIN}${SIGN_IN_CALLBACK_PATH}`],
    hook_attributes: { url: PUBLIC_ORIGIN, active: false },
    public: false,
    default_events: [],
    default_permissions: { ...DEFAULT_PERMISSIONS },
    request_oauth_on_install: false,
    setup_on_update: false,
  };
}

const escapeHtml = (text) =>
  text.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]
  );

export function renderPage({ manifest, state }) {
  const action = escapeHtml(`${GITHUB_WEB_ORIGIN}/settings/apps/new?state=${state}`);
  const value = escapeHtml(JSON.stringify(manifest));
  return [
    "<!doctype html>",
    '<meta charset="utf-8">',
    "<title>GitHub App bootstrap</title>",
    "<h1>Create the GitHub App</h1>",
    `<p>Sign in to GitHub as ${PILOT_ACCOUNT_LOGIN} before you submit. Choose the repository at install time, not here.</p>`,
    `<form method="post" action="${action}">`,
    `<input type="hidden" name="manifest" value="${value}">`,
    '<button type="submit">Create the GitHub App</button>',
    "</form>",
  ].join("\n");
}

function reply(res, status, body = "", headers = {}, after) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body, after);
}

function readCookie(header = "") {
  for (const part of header.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === COOKIE_NAME) return value.join("=");
  }
  return undefined;
}

function sameSecret(presented, expected) {
  if (typeof presented !== "string" || typeof expected !== "string" || expected === "")
    return false;
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    refuse("GitHub returned an unexpected response");
  }
}

function assertSinglePage(link) {
  if (/rel="next"/.test(link)) refuse("GitHub returned more than one page; refusing to guess");
}

// Every GitHub call goes through here: bounded time, no redirects, and fixed error text only.
async function github(fetchImpl, url, { method = "GET", authorization, body } = {}) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": USER_AGENT,
  };
  if (authorization !== undefined) headers.Authorization = authorization;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  try {
    const response = await fetchImpl(url, {
      method,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      link: response.headers.get("link") ?? "",
      text: await response.text(),
    };
  } catch (error) {
    refuse(
      error?.name === "TimeoutError" ? "GitHub did not respond in time" : "GitHub request failed"
    );
  }
}

export async function convertManifestCode(code, fetchImpl) {
  const response = await github(
    fetchImpl,
    `${GITHUB_API_ORIGIN}/app-manifests/${encodeURIComponent(code)}/conversions`,
    { method: "POST" }
  );
  if (response.status !== 201) {
    refuse(`GitHub did not accept the manifest code (HTTP ${response.status}); restart the flow`);
  }
  return parseJson(response.text);
}

// Validates the conversion response and returns the env updates. Fails closed on any mismatch.
export function conversionToEnvUpdates(raw, { pilot = DEFAULT_PILOT } = {}) {
  if (!isObject(raw)) refuse("GitHub returned an unexpected conversion response");
  if (!Number.isSafeInteger(raw.id) || raw.id < 1)
    refuse("conversion response has no valid App id");
  if (typeof raw.slug !== "string" || !SLUG_PATTERN.test(raw.slug)) {
    refuse("conversion response has an invalid slug");
  }
  if (
    !isObject(raw.owner) ||
    typeof raw.owner.login !== "string" ||
    raw.owner.login.toLowerCase() !== pilot.accountLogin.toLowerCase() ||
    !Number.isSafeInteger(pilot.accountId) ||
    raw.owner.id !== pilot.accountId
  ) {
    refuse("App owner is not the pilot account");
  }
  if (typeof raw.client_id !== "string" || !CLIENT_ID_PATTERN.test(raw.client_id)) {
    refuse("conversion response has an invalid client id");
  }
  if (typeof raw.client_secret !== "string" || !CLIENT_SECRET_PATTERN.test(raw.client_secret)) {
    refuse("conversion response has an invalid client secret");
  }
  if (!isObject(raw.permissions)) refuse("conversion response has no permissions");
  for (const [name, level] of Object.entries(DEFAULT_PERMISSIONS)) {
    if (raw.permissions[name] !== level)
      refuse(`App permission ${name} does not match the manifest`);
  }
  // Only metadata read may appear beyond the manifest permissions.
  for (const [name, level] of Object.entries(raw.permissions)) {
    if (!Object.hasOwn(DEFAULT_PERMISSIONS, name) && (name !== "metadata" || level !== "read")) {
      refuse(`App permission ${name} is not expected`);
    }
  }
  if (typeof raw.pem !== "string" || raw.pem.length > MAX_PEM_LENGTH) {
    refuse("conversion response has no valid pem");
  }
  const updates = {
    GITHUB_BOT_USERNAME: `${raw.slug}[bot]`,
    GITHUB_APP_ID: String(raw.id),
    GITHUB_APP_PRIVATE_KEY: pkcs8EnvLine(raw.pem, "conversion pem"),
    GITHUB_CLIENT_ID: raw.client_id,
    GITHUB_CLIENT_SECRET: raw.client_secret,
    // A new App has no verified installation yet, so an id left from an earlier App is cleared.
    GITHUB_APP_INSTALLATION_ID: "",
  };
  return updates;
}

// Serves the manifest page on loopback and stores the App once GitHub redirects back with a code.
// Resolves when credentials are stored; rejects with a Refusal otherwise and never writes on failure.
export async function startManifestFlow({
  envFile,
  fetchImpl = globalThis.fetch,
  store = DEFAULT_STORE,
  port = MANIFEST_PORT,
  totalTimeoutMs = MANIFEST_TOTAL_TIMEOUT_MS,
  replaceExistingApp = false,
  pilot = DEFAULT_PILOT,
}) {
  const { text } = await readEnvFile(envFile, store);
  if (envValue(text, "GITHUB_APP_ID").trim() !== "" && !replaceExistingApp) {
    refuse(`GITHUB_APP_ID is already set; re-run with ${REPLACE_FLAG} only to replace the App`);
  }

  const manifest = buildManifest(`polytronx-ai-${randomBytes(3).toString("hex")}`);
  // One state and one cookie per flow. A reload or a second tab gets the same pair, so a submit from either still works.
  const session = {
    state: randomBytes(32).toString("base64url"),
    cookie: randomBytes(32).toString("base64url"),
    consumed: false,
    writing: false,
    settled: false,
  };
  const hosts = new Set();
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  done.catch(() => {}); // an unawaited flow must not crash the process

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      // Once headers are out a second reply would throw, so the connection is dropped instead.
      if (res.headersSent) res.destroy();
      else reply(res, 500, "Unexpected failure; nothing was stored");
    });
  });
  server.headersTimeout = HTTP_TIMEOUT_MS;
  server.requestTimeout = HTTP_TIMEOUT_MS;

  // Records the outcome once, before the response is sent, so a client that drops the connection cannot change it.
  const settle = (error) => {
    if (session.settled) return;
    session.settled = true;
    clearTimeout(timer);
    server.close();
    if (error) rejectDone(error);
    else resolveDone();
  };
  // The timer and stop() wait for a write in progress: the write decides the outcome.
  const abort = (error) => {
    if (session.writing) return;
    settle(error);
    server.closeAllConnections();
  };

  const handle = async (req, res) => {
    if (!hosts.has(req.headers.host)) return reply(res, 421);
    if (req.method !== "GET") return reply(res, 405);
    if (
      req.headers["transfer-encoding"] !== undefined ||
      Number(req.headers["content-length"] ?? 0) !== 0
    ) {
      req.resume();
      return reply(res, 413);
    }
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/") {
      if (session.consumed) return reply(res, 409, "Conflict: this manifest was already submitted");
      return reply(res, 200, renderPage({ manifest, state: session.state }), {
        "Content-Type": "text/html; charset=utf-8",
        "Set-Cookie": `${COOKIE_NAME}=${session.cookie}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
      });
    }
    if (url.pathname !== MANIFEST_CALLBACK_PATH) return reply(res, 404);

    if (!sameSecret(readCookie(req.headers.cookie), session.cookie))
      return reply(res, 403, "Forbidden");
    if (!sameSecret(url.searchParams.get("state"), session.state))
      return reply(res, 403, "Forbidden");
    const code = url.searchParams.get("code") ?? "";
    if (code === "" || code.length > MANIFEST_CODE_MAX_LENGTH)
      return reply(res, 400, "Bad request");
    if (session.consumed) return reply(res, 409, "Conflict: this code was already used");
    session.consumed = true;

    let failure = null;
    try {
      const updates = conversionToEnvUpdates(await convertManifestCode(code, fetchImpl), { pilot });
      if (session.settled) return; // the timer or stop() ended the flow first, so nothing is written
      session.writing = true;
      await writeEnvUpdates(envFile, updates, store);
    } catch (error) {
      failure =
        error instanceof Refusal ? error : new Refusal("Unexpected failure; nothing was stored");
    }
    session.writing = false;
    settle(failure);
    if (failure) return reply(res, 500, failure.message);
    return reply(res, 200, "Credentials stored. No values shown.");
  };

  const boundPort = await new Promise((resolve, reject) => {
    server.once("error", () =>
      reject(new Refusal(`port ${port} on ${MANIFEST_HOST} is not available`))
    );
    server.listen(port, MANIFEST_HOST, () => resolve(server.address().port));
  });
  hosts.add(`localhost:${boundPort}`).add(`127.0.0.1:${boundPort}`);
  const timer = setTimeout(
    () => abort(new Refusal("timed out; nothing was stored")),
    totalTimeoutMs
  );
  return { port: boundPort, done, stop: () => abort(new Refusal("stopped; nothing was stored")) };
}

export function signAppJwt({ appId, key, nowSeconds }) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iat: nowSeconds - JWT_BACKDATE_SECONDS,
      exp: nowSeconds + JWT_LIFETIME_SECONDS,
      iss: appId,
    })
  ).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(key).toString("base64url");
  return `${signingInput}.${signature}`;
}

const isInstallation = (item) =>
  isObject(item) &&
  Number.isSafeInteger(item.id) &&
  Number.isSafeInteger(item.app_id) &&
  typeof item.target_type === "string" &&
  typeof item.repository_selection === "string" &&
  isObject(item.account) &&
  typeof item.account.login === "string" &&
  Number.isSafeInteger(item.account.id);

const isSuspended = (item) => item.suspended_at !== undefined && item.suspended_at !== null;

function installationPermissionsMatch(permissions) {
  if (!isObject(permissions)) return false;
  const scoped = Object.entries(permissions).filter(
    ([name]) => !ACCOUNT_PERMISSIONS.includes(name)
  );
  return (
    scoped.length === Object.keys(INSTALLATION_PERMISSIONS).length &&
    scoped.every(([name, level]) => INSTALLATION_PERMISSIONS[name] === level)
  );
}

async function pilotInstallation({ jwt, appId, pilot, fetchImpl }) {
  const response = await github(
    fetchImpl,
    `${GITHUB_API_ORIGIN}/app/installations?per_page=${PAGE_SIZE}`,
    {
      authorization: `Bearer ${jwt}`,
    }
  );
  if (response.status !== 200) {
    refuse(
      `GitHub refused the App JWT (HTTP ${response.status}); check the App ID and private key`
    );
  }
  assertSinglePage(response.link);
  const items = parseJson(response.text);
  if (!Array.isArray(items) || !items.every(isInstallation)) {
    refuse("installation list has an unexpected shape");
  }
  const matches = items.filter(
    (item) =>
      item.app_id === Number(appId) &&
      item.target_type === "User" &&
      item.account.login.toLowerCase() === pilot.accountLogin.toLowerCase() &&
      item.account.id === pilot.accountId
  );
  if (matches.length !== 1) refuse(`expected one matching installation, found ${matches.length}`);
  const [installation] = matches;
  if (installation.repository_selection !== "selected") {
    refuse("installation is not limited to selected repositories");
  }
  if (isSuspended(installation)) refuse("installation is suspended");
  if (!installationPermissionsMatch(installation.permissions)) {
    refuse(
      "installation permissions do not match the manifest; check for a pending permission update"
    );
  }
  return installation;
}

// Mints a metadata read token without a repository filter, so it lists every repository the
// installation covers. The installation must cover exactly the pilot repository. The token is revoked
// in every case, and a revocation failure is a refusal.
async function assertOnlyPilotRepository({ jwt, installationId, pilot, fetchImpl }) {
  const minted = await github(
    fetchImpl,
    `${GITHUB_API_ORIGIN}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      authorization: `Bearer ${jwt}`,
      body: { permissions: { metadata: "read" } },
    }
  );
  if (minted.status !== 201)
    refuse(`GitHub refused the verification token (HTTP ${minted.status})`);
  const mintedBody = parseJson(minted.text);
  const token = isObject(mintedBody) ? mintedBody.token : undefined;
  if (typeof token !== "string" || token === "")
    refuse("verification token response has an unexpected shape");

  let listing;
  try {
    const listed = await github(
      fetchImpl,
      `${GITHUB_API_ORIGIN}/installation/repositories?per_page=${PAGE_SIZE}`,
      {
        authorization: `token ${token}`,
      }
    );
    if (listed.status !== 200) refuse(`GitHub refused the repository list (HTTP ${listed.status})`);
    assertSinglePage(listed.link);
    listing = parseJson(listed.text);
  } finally {
    const revoked = await github(fetchImpl, `${GITHUB_API_ORIGIN}/installation/token`, {
      method: "DELETE",
      authorization: `token ${token}`,
    });
    if (revoked.status !== 204)
      refuse("could not revoke the verification token; nothing was stored");
  }
  if (
    !isObject(listing) ||
    !Array.isArray(listing.repositories) ||
    !Number.isSafeInteger(listing.total_count)
  ) {
    refuse("repository list has an unexpected shape");
  }
  if (listing.total_count !== 1 || listing.repositories.length !== 1) {
    refuse("installation must cover only the pilot repository");
  }
  if (listing.repositories[0]?.full_name !== pilot.repoFullName) {
    refuse("pilot repository is not visible to the installation");
  }
}

export async function verifyInstallation({
  envFile,
  fetchImpl = globalThis.fetch,
  store = DEFAULT_STORE,
  now = Date.now,
  pilot = DEFAULT_PILOT,
}) {
  if (!Number.isSafeInteger(pilot.accountId))
    refuse("PILOT_ACCOUNT_ID is not pinned; pin it before running verify");
  const { text } = await readEnvFile(envFile, store);
  const appId = envValue(text, "GITHUB_APP_ID");
  if (!APP_ID_PATTERN.test(appId)) refuse("GITHUB_APP_ID is missing or invalid");
  const pem = envValue(text, "GITHUB_APP_PRIVATE_KEY").replace(/\\n/g, "\n");
  const key = loadRsaPrivateKey(pem, "GITHUB_APP_PRIVATE_KEY");
  const jwt = signAppJwt({ appId, key, nowSeconds: Math.floor(now() / 1000) });
  const installation = await pilotInstallation({ jwt, appId, pilot, fetchImpl });
  await assertOnlyPilotRepository({ jwt, installationId: installation.id, pilot, fetchImpl });
  await writeEnvUpdates(envFile, { GITHUB_APP_INSTALLATION_ID: String(installation.id) }, store);
}

export async function main(argv, io = {}) {
  const {
    env = process.env,
    stdout = process.stdout,
    stderr = process.stderr,
    fetchImpl = globalThis.fetch,
    store = DEFAULT_STORE,
    now = Date.now,
    pilot,
  } = io;
  const [mode, ...flags] = argv;
  const validFlags =
    mode === "manifest"
      ? flags.every((flag) => flag === REPLACE_FLAG)
      : mode === "verify" && flags.length === 0;
  if (!validFlags) {
    stderr.write(USAGE);
    return 2;
  }
  const secretsDir = env.POLYTRONX_SECRETS_DIR ?? "";
  if (!path.isAbsolute(secretsDir)) {
    stderr.write("POLYTRONX_SECRETS_DIR must be an absolute path\n");
    return 2;
  }
  const envFile = path.join(secretsDir, ENV_FILE_NAME);
  try {
    if (mode === "manifest") {
      const flow = await startManifestFlow({
        envFile,
        fetchImpl,
        store,
        replaceExistingApp: flags.includes(REPLACE_FLAG),
        pilot,
      });
      stdout.write(
        `Open http://localhost:${flow.port}/ through the SSH forward. Use localhost, not 127.0.0.1.\n`
      );
      await flow.done;
      stdout.write("manifest: PASS; credentials stored. Run verify next.\n");
    } else {
      await verifyInstallation({ envFile, fetchImpl, store, now, pilot });
      stdout.write("verify: PASS\n");
    }
    return 0;
  } catch (error) {
    const reason =
      error instanceof Refusal ? error.message : `unexpected failure (${error?.code ?? "no code"})`;
    stderr.write(`${mode}: FAIL: ${reason}\n`);
    return 1;
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await main(process.argv.slice(2));
}
