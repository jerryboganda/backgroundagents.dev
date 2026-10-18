import assert from "node:assert/strict";
import {
  createPrivateKey,
  createVerify,
  generateKeyPairSync,
  randomBytes,
  webcrypto,
} from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import * as bootstrap from "./github-app-bootstrap.mjs";

const POSIX_ONLY =
  process.platform === "win32"
    ? { skip: "POSIX modes, owners and links are not checked on win32" }
    : {};
const KEY_OPTIONS = {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
};
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048, ...KEY_OPTIONS });
const weak = generateKeyPairSync("rsa", { modulusLength: 1024, ...KEY_OPTIONS });
const PKCS8_LINE = bootstrap.pkcs8EnvLine(rsa.privateKey);
const PILOT = {
  accountLogin: "jerryboganda",
  accountId: 4321,
  repoFullName: "jerryboganda/backgroundagents.dev",
};
// Runtime-generated sentinels: leak checks compare against these, so no secret-shaped literal sits in source.
const sentinel = (name) => `SENTINEL${name}${randomBytes(4).toString("hex")}`;
const CLIENT_SECRET = sentinel("CLIENT_SECRET");
const WEBHOOK_SECRET = sentinel("WEBHOOK_SECRET");
const GH_TOKEN = `ghs_${sentinel("GH_TOKEN")}`;
const ORIGINAL_ENV =
  [
    "# operator notes stay byte-exact",
    "DATABASE_URL=postgres://db/x?sslmode=require",
    "export OTHER_NOTE='quoted value'",
    "GITHUB_CLIENT_ID=old-client",
    "UNRELATED=keep\r",
  ].join("\n") + "\n";
const APP_ENV = `GITHUB_APP_ID=4242\nGITHUB_APP_PRIVATE_KEY=${PKCS8_LINE}\nUNRELATED=keep\r\n`;

const storeFor = () => ({
  ownerUid: process.platform === "win32" ? 0 : process.getuid(),
  rename: fs.rename,
});

async function tempDir(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "gh-app-bootstrap-")));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeEnv(dir, text, mode = 0o600) {
  const file = path.join(dir, "control-plane.env");
  await fs.writeFile(file, text, "latin1");
  if (process.platform !== "win32") await fs.chmod(file, mode);
  return file;
}

function fakeGitHub(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const { pathname } = new URL(url);
    calls.push({ method, pathname, url, init });
    const route = routes[`${method} ${pathname}`];
    if (route === undefined) throw new Error(`unrouted ${method} ${pathname}`);
    const headers = {
      "content-type": "application/json",
      ...(route.link ? { link: route.link } : {}),
    };
    const body = route.status === 204 ? null : JSON.stringify(route.json ?? {});
    return new Response(body, { status: route.status ?? 200, headers });
  };
  return { fetchImpl, calls };
}

function conversion(overrides = {}) {
  return {
    id: 4242,
    slug: "polytronx-ai-abc123",
    owner: { login: "jerryboganda", id: 4321 },
    client_id: "Iv1.0123456789abcdef",
    client_secret: CLIENT_SECRET,
    webhook_secret: WEBHOOK_SECRET,
    pem: rsa.privateKey,
    permissions: {
      contents: "write",
      issues: "write",
      pull_requests: "write",
      metadata: "read",
    },
    ...overrides,
  };
}

const INSTALL_PERMISSIONS = {
  contents: "write",
  issues: "write",
  pull_requests: "write",
  metadata: "read",
};
const installation = (overrides = {}) => ({
  id: 999,
  app_id: 4242,
  target_type: "User",
  account: { login: "jerryboganda", id: 4321 },
  repository_selection: "selected",
  permissions: INSTALL_PERMISSIONS,
  suspended_at: null,
  ...overrides,
});

function githubRoutes({
  installations = [installation()],
  repos = [{ full_name: PILOT.repoFullName }],
  totalCount = repos.length,
  link = "",
  appPermissions = { ...INSTALL_PERMISSIONS, emails: "read" },
} = {}) {
  return {
    "GET /app": { json: { id: 4242, permissions: appPermissions } },
    "GET /app/installations": { json: installations, link },
    "POST /app/installations/999/access_tokens": { status: 201, json: { token: GH_TOKEN } },
    "GET /installation/repositories": { json: { total_count: totalCount, repositories: repos } },
    "DELETE /installation/token": { status: 204 },
  };
}

function request(
  port,
  pathname,
  { hostHeader = `127.0.0.1:${port}`, cookie, method = "GET", headers = {}, body } = {}
) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method,
        agent: false,
        headers: { host: hostHeader, ...(cookie ? { cookie } : {}), ...headers },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

async function openPage(port) {
  const res = await request(port, "/");
  assert.equal(res.status, 200);
  const cookie = /gh_bootstrap=([^;]+)/.exec(res.headers["set-cookie"][0])[1];
  const state = /state=([A-Za-z0-9_-]+)/.exec(res.body)[1];
  return { cookie: `gh_bootstrap=${cookie}`, state, res };
}

async function startFlow(t, options) {
  const flow = await bootstrap.startManifestFlow({
    port: 0,
    store: storeFor(),
    pilot: PILOT,
    ...options,
  });
  t.after(() => flow.stop());
  return flow;
}

async function until(predicate) {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), "condition was not reached");
}

describe("env file merge", () => {
  it("replaces allowlisted keys, appends missing ones and keeps every other byte", () => {
    const merged = bootstrap.mergeEnvText(ORIGINAL_ENV, {
      GITHUB_CLIENT_ID: "new-client",
      GITHUB_APP_ID: "7",
    });
    assert.equal(
      merged,
      ORIGINAL_ENV.replace("GITHUB_CLIENT_ID=old-client", "GITHUB_CLIENT_ID=new-client") +
        "GITHUB_APP_ID=7\n"
    );
  });

  it("does not treat inherited object properties as keys", () => {
    assert.equal(
      bootstrap.mergeEnvText("constructor=1\n", { GITHUB_APP_ID: "7" }),
      "constructor=1\nGITHUB_APP_ID=7\n"
    );
  });

  it("refuses non-allowlisted keys and values that would break the line", () => {
    assert.throws(
      () => bootstrap.mergeEnvText("", { DATABASE_URL: "x" }),
      /not an allowlisted key/
    );
    assert.throws(
      () => bootstrap.mergeEnvText("", { GITHUB_APP_ID: "1\nDATABASE_URL=x" }),
      /unsupported value/
    );
    assert.throws(() => bootstrap.mergeEnvText("", { GITHUB_APP_ID: "1 2" }), /unsupported value/);
    assert.throws(
      () => bootstrap.mergeEnvText("", { GITHUB_APP_PRIVATE_KEY: "not a key" }),
      /unsupported value/
    );
  });

  it("accepts the one-line PKCS#8 key, whose PEM header contains spaces", () => {
    assert.ok(
      bootstrap.mergeEnvText("", { GITHUB_APP_PRIVATE_KEY: PKCS8_LINE }).includes(PKCS8_LINE)
    );
  });
});

describe("manifest and conversion", () => {
  it("builds the reviewed manifest", () => {
    assert.deepEqual(bootstrap.buildManifest("polytronx-ai-abc123"), {
      name: "polytronx-ai-abc123",
      url: "https://ai.polytronx.com",
      redirect_url: "http://localhost:8765/manifest/callback",
      callback_urls: ["https://ai.polytronx.com/api/auth/callback/github"],
      hook_attributes: { url: "https://ai.polytronx.com", active: false },
      public: false,
      default_events: [],
      default_permissions: {
        contents: "write",
        issues: "write",
        pull_requests: "write",
      },
      request_oauth_on_install: false,
      setup_on_update: false,
    });
  });

  it("maps a pilot-owned App to env updates with a one-line PKCS#8 key", () => {
    assert.deepEqual(bootstrap.conversionToEnvUpdates(conversion(), { pilot: PILOT }), {
      GITHUB_BOT_USERNAME: "polytronx-ai-abc123[bot]",
      GITHUB_APP_ID: "4242",
      GITHUB_APP_PRIVATE_KEY: PKCS8_LINE,
      GITHUB_CLIENT_ID: "Iv1.0123456789abcdef",
      GITHUB_CLIENT_SECRET: CLIENT_SECRET,
      GITHUB_APP_INSTALLATION_ID: "",
    });
  });

  it("fails closed on owner, permission, identity and key mismatches", () => {
    const perms = conversion().permissions;
    const cases = [
      [conversion({ owner: { login: "someone-else" } }), /pilot account/],
      [conversion({ owner: { login: "jerryboganda", id: 9999 } }), /pilot account/],
      [
        conversion({ permissions: { ...perms, pull_requests: "read" } }),
        /pull_requests does not match/,
      ],
      [conversion({ permissions: { ...perms, emails: "read" } }), /emails is not expected/],
      [
        conversion({ permissions: { ...perms, administration: "write" } }),
        /administration is not expected/,
      ],
      [conversion({ permissions: { ...perms, secrets: "read" } }), /secrets is not expected/],
      [conversion({ permissions: { ...perms, metadata: "write" } }), /metadata is not expected/],
      [conversion({ id: 0 }), /valid App id/],
      [conversion({ slug: "bad slug\n" }), /invalid slug/],
      [conversion({ client_secret: `${CLIENT_SECRET} has space` }), /invalid client secret/],
      [conversion({ pem: weak.privateKey }), /at least 2048 bits/],
      [conversion({ pem: "not a key" }), /does not parse as a private key/],
    ];
    for (const [raw, pattern] of cases) {
      assert.throws(() => bootstrap.conversionToEnvUpdates(raw, { pilot: PILOT }), pattern);
    }
  });

  it("pins the owner id: the reviewed pilot id converts and any other id is refused", () => {
    const updates = bootstrap.conversionToEnvUpdates(
      conversion({ owner: { login: "jerryboganda", id: 186593041 } })
    );
    assert.equal(updates.GITHUB_APP_ID, "4242");
    assert.throws(
      () =>
        bootstrap.conversionToEnvUpdates(
          conversion({ owner: { login: "jerryboganda", id: 4321 } })
        ),
      /pilot account/
    );
  });

  it("writes a PKCS#8 value that WebCrypto imports with the control plane's algorithm", async () => {
    assert.ok(!/[\r\n]/.test(PKCS8_LINE));
    assert.match(PKCS8_LINE, /^-{5}BEGIN PRIVATE KEY-----\\n/);
    assert.match(PKCS8_LINE, /\\n-{5}END PRIVATE KEY-----$/);
    const pem = PKCS8_LINE.replaceAll("\\n", "\n");
    const der = Buffer.from(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");
    const key = await webcrypto.subtle.importKey(
      "pkcs8",
      der,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"]
    );
    assert.equal(key.algorithm.name, "RSASSA-PKCS1-v1_5");
  });
});

describe("App JWT", () => {
  it("carries the backdate, lifetime and issuer the consumer expects, and verifies", () => {
    const jwt = bootstrap.signAppJwt({
      appId: "4242",
      key: createPrivateKey(rsa.privateKey),
      nowSeconds: 1_700_000_000,
    });
    const [header, payload, signature] = jwt.split(".");
    assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "RS256", typ: "JWT" });
    assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url")), {
      iat: 1_699_999_940,
      exp: 1_700_000_540,
      iss: "4242",
    });
    assert.ok(
      createVerify("RSA-SHA256")
        .update(`${header}.${payload}`)
        .verify(rsa.publicKey, Buffer.from(signature, "base64url"))
    );
  });
});

describe("manifest flow", () => {
  it("refuses to replace an existing App without the explicit flag, before listening", async (t) => {
    const dir = await tempDir(t);
    const file = await writeEnv(dir, "GITHUB_APP_ID=1\n");
    const github = fakeGitHub({});
    await assert.rejects(
      bootstrap.startManifestFlow({
        envFile: file,
        fetchImpl: github.fetchImpl,
        store: storeFor(),
      }),
      /already set/
    );
    assert.equal(github.calls.length, 0);
  });

  it("refuses a missing env file", async (t) => {
    const dir = await tempDir(t);
    await assert.rejects(
      bootstrap.startManifestFlow({
        envFile: path.join(dir, "control-plane.env"),
        store: storeFor(),
      }),
      /is missing/
    );
  });

  it("converts the code once and stores only the allowlisted keys", async (t) => {
    const dir = await tempDir(t);
    const file = await writeEnv(dir, ORIGINAL_ENV);
    const github = fakeGitHub({
      "POST /app-manifests/CODE-ok/conversions": { status: 201, json: conversion() },
    });
    const flow = await startFlow(t, { envFile: file, fetchImpl: github.fetchImpl });
    const page = await openPage(flow.port);
    const callback = await request(
      flow.port,
      `/manifest/callback?code=CODE-ok&state=${page.state}`,
      {
        cookie: page.cookie,
      }
    );
    assert.equal(callback.status, 200);
    assert.equal(callback.body, "Credentials stored. No values shown.");
    await flow.done;

    assert.equal(github.calls.length, 1);
    const [call] = github.calls;
    assert.equal(call.method, "POST");
    assert.equal(call.url, "https://api.github.com/app-manifests/CODE-ok/conversions");
    assert.equal(call.init.redirect, "error");
    assert.equal(call.init.headers["X-GitHub-Api-Version"], "2022-11-28");

    const after = await fs.readFile(file, "latin1");
    assert.equal(bootstrap.envValue(after, "GITHUB_APP_ID"), "4242");
    assert.equal(bootstrap.envValue(after, "GITHUB_APP_PRIVATE_KEY"), PKCS8_LINE);
    assert.equal(bootstrap.envValue(after, "GITHUB_BOT_USERNAME"), "polytronx-ai-abc123[bot]");
    assert.equal(bootstrap.envValue(after, "GITHUB_CLIENT_ID"), "Iv1.0123456789abcdef");
    assert.equal(bootstrap.envValue(after, "GITHUB_APP_INSTALLATION_ID"), "");
    assert.ok(
      after.startsWith(
        "# operator notes stay byte-exact\nDATABASE_URL=postgres://db/x?sslmode=require\nexport OTHER_NOTE='quoted value'\n"
      )
    );
    assert.ok(after.includes("UNRELATED=keep\r\n"));
  });

  it("refuses a wrong, missing or foreign session state with 403 and no conversion", async (t) => {
    const dir = await tempDir(t);
    const file = await writeEnv(dir, ORIGINAL_ENV);
    const github = fakeGitHub({});
    const flow = await startFlow(t, { envFile: file, fetchImpl: github.fetchImpl });
    const page = await openPage(flow.port);
    const attempts = [
      { pathname: "/manifest/callback?code=C1&state=WRONG", cookie: page.cookie },
      { pathname: "/manifest/callback?code=C1", cookie: page.cookie },
      { pathname: `/manifest/callback?code=C1&state=${page.state}` },
      { pathname: `/manifest/callback?code=C1&state=${page.state}`, cookie: "gh_bootstrap=WRONG" },
    ];
    for (const attempt of attempts) {
      const res = await request(flow.port, attempt.pathname, { cookie: attempt.cookie });
      assert.equal(res.status, 403);
    }
    assert.equal(github.calls.length, 0);
    assert.equal(await fs.readFile(file, "latin1"), ORIGINAL_ENV);
  });

  it("answers a second use of the code with 409 while the first conversion is in flight", async (t) => {
    const dir = await tempDir(t);
    const file = await writeEnv(dir, ORIGINAL_ENV);
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const github = fakeGitHub({
      "POST /app-manifests/CODE-once/conversions": { status: 201, json: conversion() },
    });
    let started = 0;
    const gated = async (url, init) => {
      started += 1;
      await gate;
      return github.fetchImpl(url, init);
    };
    const flow = await startFlow(t, { envFile: file, fetchImpl: gated });
    const page = await openPage(flow.port);
    const pathname = `/manifest/callback?code=CODE-once&state=${page.state}`;
    const first = request(flow.port, pathname, { cookie: page.cookie });
    await until(() => started === 1);
    const second = await request(flow.port, pathname, { cookie: page.cookie });
    assert.equal(second.status, 409);
    assert.equal((await request(flow.port, "/")).status, 409);
    release();
    assert.equal((await first).status, 200);
    await flow.done;
    assert.equal(github.calls.length, 1);
  });

  it("reuses one state and cookie on reload, so an earlier tab's submit still converts", async (t) => {
    const dir = await tempDir(t);
    const file = await writeEnv(dir, ORIGINAL_ENV);
    const github = fakeGitHub({
      "POST /app-manifests/CODE-tab/conversions": { status: 201, json: conversion() },
    });
    const flow = await startFlow(t, { envFile: file, fetchImpl: github.fetchImpl });
    const firstTab = await openPage(flow.port);
    const reloaded = await openPage(flow.port);
    assert.equal(reloaded.state, firstTab.state);
    assert.equal(reloaded.cookie, firstTab.cookie);
    const callback = await request(
      flow.port,
      `/manifest/callback?code=CODE-tab&state=${firstTab.state}`,
      {
        cookie: firstTab.cookie,
      }
    );
    assert.equal(callback.status, 200);
    await flow.done;
  });

  it("rejects foreign hosts with 421, other methods with 405, bodies with 413 and unknown paths with 404", async (t) => {
    const dir = await tempDir(t);
    const file = await writeEnv(dir, ORIGINAL_ENV);
    const flow = await startFlow(t, { envFile: file, fetchImpl: fakeGitHub({}).fetchImpl });
    const foreign = await request(flow.port, "/", { hostHeader: "evil.example" });
    assert.equal(foreign.status, 421);
    assert.equal(foreign.body, "");
    assert.equal((await request(flow.port, "/", { method: "POST" })).status, 405);
    assert.equal(
      (await request(flow.port, "/", { headers: { "content-length": "5" }, body: "hello" })).status,
      413
    );
    assert.equal(
      (
        await request(flow.port, "/", {
          headers: { "transfer-encoding": "chunked" },
          body: "hello",
        })
      ).status,
      413
    );
    assert.equal((await request(flow.port, "/nope")).status, 404);
  });

  it("answers a fixed 500 when the handler throws before it replies", async (t) => {
    const dir = await tempDir(t);
    const file = await writeEnv(dir, ORIGINAL_ENV);
    const flow = await startFlow(t, { envFile: file, fetchImpl: fakeGitHub({}).fetchImpl });
    const res = await request(flow.port, "//x:99999");
    assert.equal(res.status, 500);
    assert.equal(res.body, "Unexpected failure; nothing was stored");
  });

  it("sets the session cookie and the no-store, no-referrer and CSP headers", async (t) => {
    const dir = await tempDir(t);
    const file = await writeEnv(dir, ORIGINAL_ENV);
    const flow = await startFlow(t, { envFile: file, fetchImpl: fakeGitHub({}).fetchImpl });
    const res = await request(flow.port, "/");
    assert.match(
      res.headers["set-cookie"][0],
      /^gh_bootstrap=[A-Za-z0-9_-]+; HttpOnly; SameSite=Lax; Path=\/; Max-Age=900$/
    );
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal(res.headers["referrer-policy"], "no-referrer");
    assert.match(
      res.headers["content-security-policy"],
      /form-action 'self' https:\/\/github\.com/
    );
    assert.match(
      res.body,
      /action="https:\/\/github\.com\/settings\/apps\/new\?state=[A-Za-z0-9_-]+"/
    );
  });

  it("keeps credential values out of responses and refusal messages", async (t) => {
    const dir = await tempDir(t);
    const file = await writeEnv(dir, ORIGINAL_ENV);
    const github = fakeGitHub({
      "POST /app-manifests/SENTINELCODE7731/conversions": { status: 201, json: conversion() },
    });
    const flow = await startFlow(t, { envFile: file, fetchImpl: github.fetchImpl });
    const page = await openPage(flow.port);
    const callback = await request(
      flow.port,
      `/manifest/callback?code=SENTINELCODE7731&state=${page.state}`,
      {
        cookie: page.cookie,
      }
    );
    await flow.done;
    const seen = JSON.stringify([page.res, callback]);
    for (const secret of [
      "SENTINELCODE7731",
      CLIENT_SECRET,
      WEBHOOK_SECRET,
      rsa.privateKey.split("\n")[1],
    ]) {
      assert.equal(seen.includes(secret), false);
    }

    const otherDir = await tempDir(t);
    const otherFile = await writeEnv(otherDir, ORIGINAL_ENV);
    const refusing = fakeGitHub({
      "POST /app-manifests/SENTINELCODE7731/conversions": {
        status: 201,
        json: conversion({ owner: { login: "SENTINELOWNER7731" } }),
      },
    });
    const failing = await startFlow(t, { envFile: otherFile, fetchImpl: refusing.fetchImpl });
    const failingPage = await openPage(failing.port);
    const refused = await request(
      failing.port,
      `/manifest/callback?code=SENTINELCODE7731&state=${failingPage.state}`,
      {
        cookie: failingPage.cookie,
      }
    );
    assert.equal(refused.status, 500);
    assert.equal(refused.body, "App owner is not the pilot account");
    await assert.rejects(
      failing.done,
      (error) => error instanceof bootstrap.Refusal && !String(error.message).includes("SENTINEL")
    );
    assert.equal(await fs.readFile(otherFile, "latin1"), ORIGINAL_ENV);
  });

  it("stores nothing and fails the flow when GitHub does not return 201", async (t) => {
    const dir = await tempDir(t);
    const file = await writeEnv(dir, ORIGINAL_ENV);
    const github = fakeGitHub({
      "POST /app-manifests/CODE-bad/conversions": { status: 422, json: { message: "bad" } },
    });
    const flow = await startFlow(t, { envFile: file, fetchImpl: github.fetchImpl });
    const page = await openPage(flow.port);
    const callback = await request(
      flow.port,
      `/manifest/callback?code=CODE-bad&state=${page.state}`,
      {
        cookie: page.cookie,
      }
    );
    assert.equal(callback.status, 500);
    await assert.rejects(flow.done, /did not accept the manifest code \(HTTP 422\)/);
    assert.equal(await fs.readFile(file, "latin1"), ORIGINAL_ENV);
  });

  it("exits with a refusal, closes the server and writes nothing when the total timeout expires", async (t) => {
    const dir = await tempDir(t);
    const file = await writeEnv(dir, ORIGINAL_ENV);
    const flow = await startFlow(t, {
      envFile: file,
      fetchImpl: fakeGitHub({}).fetchImpl,
      totalTimeoutMs: 50,
    });
    await assert.rejects(flow.done, /timed out/);
    await assert.rejects(request(flow.port, "/"), (error) => error.code === "ECONNREFUSED");
    assert.equal(await fs.readFile(file, "latin1"), ORIGINAL_ENV);
  });

  for (const failWrite of [false, true]) {
    it(`reports the real outcome when stop() lands during the env write (write ${failWrite ? "fails" : "succeeds"})`, async (t) => {
      const dir = await tempDir(t);
      const file = await writeEnv(dir, ORIGINAL_ENV);
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      let renaming = false;
      const gatedStore = {
        ...storeFor(),
        rename: async (from, to) => {
          renaming = true;
          await gate;
          if (failWrite) throw Object.assign(new Error("injected"), { code: "EIO" });
          return fs.rename(from, to);
        },
      };
      const github = fakeGitHub({
        "POST /app-manifests/CODE-stop/conversions": { status: 201, json: conversion() },
      });
      const flow = await startFlow(t, {
        envFile: file,
        fetchImpl: github.fetchImpl,
        store: gatedStore,
      });
      const page = await openPage(flow.port);
      const callback = request(flow.port, `/manifest/callback?code=CODE-stop&state=${page.state}`, {
        cookie: page.cookie,
      });
      await until(() => renaming);
      flow.stop();
      release();
      const response = await callback;
      if (failWrite) {
        assert.equal(response.status, 500);
        await assert.rejects(flow.done, /env write failed; the env file is unchanged/);
        assert.equal(await fs.readFile(file, "latin1"), ORIGINAL_ENV);
      } else {
        assert.equal(response.status, 200);
        await flow.done;
        assert.equal(
          bootstrap.envValue(await fs.readFile(file, "latin1"), "GITHUB_APP_ID"),
          "4242"
        );
      }
    });
  }

  it("replacing an App clears the old installation id end to end", async (t) => {
    const dir = await tempDir(t);
    const file = await writeEnv(dir, "GITHUB_APP_ID=1\nGITHUB_APP_INSTALLATION_ID=555\n");
    const github = fakeGitHub({
      "POST /app-manifests/CODE-replace/conversions": { status: 201, json: conversion() },
    });
    const flow = await startFlow(t, {
      envFile: file,
      fetchImpl: github.fetchImpl,
      replaceExistingApp: true,
    });
    const page = await openPage(flow.port);
    const callback = await request(
      flow.port,
      `/manifest/callback?code=CODE-replace&state=${page.state}`,
      {
        cookie: page.cookie,
      }
    );
    assert.equal(callback.status, 200);
    await flow.done;
    const after = await fs.readFile(file, "latin1");
    assert.equal(bootstrap.envValue(after, "GITHUB_APP_ID"), "4242");
    assert.equal(bootstrap.envValue(after, "GITHUB_APP_INSTALLATION_ID"), "");
  });

  it("clears a leftover installation id when no App is recorded, without the replace flag", async (t) => {
    const dir = await tempDir(t);
    const file = await writeEnv(dir, "GITHUB_APP_ID=\nGITHUB_APP_INSTALLATION_ID=555\n");
    const github = fakeGitHub({
      "POST /app-manifests/CODE-fresh/conversions": { status: 201, json: conversion() },
    });
    const flow = await startFlow(t, { envFile: file, fetchImpl: github.fetchImpl });
    const page = await openPage(flow.port);
    const callback = await request(
      flow.port,
      `/manifest/callback?code=CODE-fresh&state=${page.state}`,
      {
        cookie: page.cookie,
      }
    );
    assert.equal(callback.status, 200);
    await flow.done;
    const after = await fs.readFile(file, "latin1");
    assert.equal(bootstrap.envValue(after, "GITHUB_APP_ID"), "4242");
    assert.equal(bootstrap.envValue(after, "GITHUB_APP_INSTALLATION_ID"), "");
  });
});

describe("atomic env writes", () => {
  it("leaves the original bytes and no temporary file when the rename fails", async (t) => {
    const dir = await tempDir(t);
    const file = await writeEnv(dir, APP_ENV);
    const failingStore = {
      ...storeFor(),
      rename: async () => {
        throw Object.assign(new Error("injected"), { code: "EIO" });
      },
    };
    await assert.rejects(
      bootstrap.writeEnvUpdates(file, { GITHUB_APP_INSTALLATION_ID: "999" }, failingStore),
      /env file is unchanged/
    );
    assert.equal(await fs.readFile(file, "latin1"), APP_ENV);
    assert.deepEqual(
      (await fs.readdir(dir)).filter((name) => name.includes(".tmp-")),
      []
    );
  });

  it("keeps the file at mode 0600 after an atomic write", POSIX_ONLY, async (t) => {
    const dir = await tempDir(t);
    const file = await writeEnv(dir, APP_ENV);
    await bootstrap.writeEnvUpdates(file, { GITHUB_APP_INSTALLATION_ID: "999" }, storeFor());
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  });

  it("refuses a credentials file that is not mode 0600", POSIX_ONLY, async (t) => {
    const dir = await tempDir(t);
    const file = await writeEnv(dir, APP_ENV, 0o644);
    await assert.rejects(
      bootstrap.writeEnvUpdates(file, { GITHUB_APP_INSTALLATION_ID: "999" }, storeFor()),
      /mode 0600/
    );
    assert.equal(await fs.readFile(file, "latin1"), APP_ENV);
  });

  it("refuses a symlinked env file and leaves its target alone", POSIX_ONLY, async (t) => {
    const dir = await tempDir(t);
    const target = path.join(dir, "real.env");
    await fs.writeFile(target, APP_ENV, { mode: 0o600 });
    const link = path.join(dir, "control-plane.env");
    await fs.symlink(target, link);
    await assert.rejects(
      bootstrap.writeEnvUpdates(link, { GITHUB_APP_INSTALLATION_ID: "999" }, storeFor()),
      /not a regular file/
    );
    assert.equal(await fs.readFile(target, "latin1"), APP_ENV);
  });

  it("refuses a secrets directory reached through a symlink", POSIX_ONLY, async (t) => {
    const dir = await tempDir(t);
    const file = await writeEnv(dir, APP_ENV);
    const base = await tempDir(t);
    const link = path.join(base, "secrets-link");
    await fs.symlink(dir, link, "dir");
    await assert.rejects(
      bootstrap.writeEnvUpdates(
        path.join(link, "control-plane.env"),
        { GITHUB_APP_INSTALLATION_ID: "999" },
        storeFor()
      ),
      /real directory/
    );
    assert.equal(await fs.readFile(file, "latin1"), APP_ENV);
  });

  it("refuses a group-writable secrets directory", POSIX_ONLY, async (t) => {
    const dir = await tempDir(t);
    const file = await writeEnv(dir, APP_ENV);
    await fs.chmod(dir, 0o770);
    await assert.rejects(
      bootstrap.writeEnvUpdates(file, { GITHUB_APP_INSTALLATION_ID: "999" }, storeFor()),
      /group or world writable/
    );
  });

  it("refuses a hard-linked env file", async (t) => {
    const dir = await tempDir(t);
    const file = await writeEnv(dir, APP_ENV);
    await fs.link(file, path.join(dir, "second-name.env"));
    await assert.rejects(
      bootstrap.writeEnvUpdates(file, { GITHUB_APP_INSTALLATION_ID: "999" }, storeFor()),
      /hard link/
    );
    assert.equal(await fs.readFile(file, "latin1"), APP_ENV);
  });
});

describe("verify", () => {
  const verifyWith = (file, fetchImpl) =>
    bootstrap.verifyInstallation({
      envFile: file,
      fetchImpl,
      store: storeFor(),
      now: () => 1_700_000_000_000,
      pilot: PILOT,
    });

  it("binds one pilot installation, writes only its id, and uses and revokes a read-only token", async (t) => {
    const dir = await tempDir(t);
    const file = await writeEnv(dir, APP_ENV);
    const github = fakeGitHub(
      githubRoutes({ installations: [installation(), installation({ app_id: 1 })] })
    );
    await verifyWith(file, github.fetchImpl);
    assert.equal(await fs.readFile(file, "latin1"), APP_ENV + "GITHUB_APP_INSTALLATION_ID=999\n");

    const mint = github.calls.find((call) => call.method === "POST");
    assert.deepEqual(JSON.parse(mint.init.body), { permissions: { metadata: "read" } });
    const revoke = github.calls.find((call) => call.method === "DELETE");
    assert.equal(revoke.pathname, "/installation/token");
    assert.equal(revoke.init.headers.Authorization, `token ${GH_TOKEN}`);

    const listing = github.calls.find((call) => call.pathname === "/app/installations");
    assert.equal(listing.url, "https://api.github.com/app/installations?per_page=100");
    const [header, payload, signature] = listing.init.headers.Authorization.replace(
      "Bearer ",
      ""
    ).split(".");
    assert.equal(JSON.parse(Buffer.from(payload, "base64url")).iss, "4242");
    assert.ok(
      createVerify("RSA-SHA256")
        .update(`${header}.${payload}`)
        .verify(rsa.publicKey, Buffer.from(signature, "base64url"))
    );
  });

  it("refuses wrong App, wrong account, zero or two matches, and all-repository installs without writing", async (t) => {
    const cases = [
      [[installation({ app_id: 1 })], /found 0/],
      [[installation({ account: { login: "jerryboganda", id: 1 } })], /found 0/],
      [[installation({ account: { login: "someone", id: 4321 } })], /found 0/],
      [[], /found 0/],
      [[installation({ id: 999 }), installation({ id: 1000 })], /found 2/],
      [[installation({ repository_selection: "all" })], /selected repositories/],
      [[installation({ suspended_at: "2026-10-01T00:00:00Z" })], /suspended/],
      [
        [installation({ permissions: { ...INSTALL_PERMISSIONS, contents: "read" } })],
        /permissions do not match/,
      ],
      [
        [installation({ permissions: { ...INSTALL_PERMISSIONS, administration: "write" } })],
        /permissions do not match/,
      ],
    ];
    for (const [installations, pattern] of cases) {
      const dir = await tempDir(t);
      const file = await writeEnv(dir, APP_ENV);
      const github = fakeGitHub(githubRoutes({ installations }));
      await assert.rejects(verifyWith(file, github.fetchImpl), pattern);
      assert.equal(await fs.readFile(file, "latin1"), APP_ENV);
      assert.equal(
        github.calls.some((call) => call.method === "POST"),
        false
      );
    }
  });

  it("revokes the verification token even when the pilot repository is not visible", async (t) => {
    const dir = await tempDir(t);
    const file = await writeEnv(dir, APP_ENV);
    const github = fakeGitHub(githubRoutes({ repos: [{ full_name: "jerryboganda/other" }] }));
    await assert.rejects(verifyWith(file, github.fetchImpl), /not visible/);
    assert.equal(github.calls.filter((call) => call.method === "DELETE").length, 1);
    assert.equal(await fs.readFile(file, "latin1"), APP_ENV);
  });

  it("refuses an installation that also covers another repository, and writes nothing", async (t) => {
    const dir = await tempDir(t);
    const file = await writeEnv(dir, APP_ENV);
    const repos = [{ full_name: PILOT.repoFullName }, { full_name: "jerryboganda/other" }];
    const github = fakeGitHub(githubRoutes({ repos }));
    await assert.rejects(
      verifyWith(file, github.fetchImpl),
      /must cover only the pilot repository/
    );
    assert.equal(await fs.readFile(file, "latin1"), APP_ENV);
    assert.equal(github.calls.filter((call) => call.method === "DELETE").length, 1);
  });

  it("refuses when total_count is not 1, even if the listed repository is the pilot", async (t) => {
    const dir = await tempDir(t);
    const file = await writeEnv(dir, APP_ENV);
    const github = fakeGitHub(githubRoutes({ totalCount: 2 }));
    await assert.rejects(
      verifyWith(file, github.fetchImpl),
      /must cover only the pilot repository/
    );
    assert.equal(await fs.readFile(file, "latin1"), APP_ENV);
  });

  it("refuses and writes nothing when the verification token cannot be revoked", async (t) => {
    const dir = await tempDir(t);
    const file = await writeEnv(dir, APP_ENV);
    const github = fakeGitHub({ ...githubRoutes(), "DELETE /installation/token": { status: 500 } });
    await assert.rejects(verifyWith(file, github.fetchImpl), /could not revoke/);
    assert.equal(await fs.readFile(file, "latin1"), APP_ENV);
  });

  it("ignores the account permission on the installation object; the App's copy is checked through GET /app", async (t) => {
    const dir = await tempDir(t);
    const file = await writeEnv(dir, APP_ENV);
    const withAccount = installation({
      permissions: { ...INSTALL_PERMISSIONS, emails: "read" },
    });
    await verifyWith(file, fakeGitHub(githubRoutes({ installations: [withAccount] })).fetchImpl);
    assert.equal(await fs.readFile(file, "latin1"), APP_ENV + "GITHUB_APP_INSTALLATION_ID=999\n");
  });

  it("refuses when the App lacks the Email addresses read permission", async (t) => {
    const dir = await tempDir(t);
    const file = await writeEnv(dir, APP_ENV);
    for (const appPermissions of [
      INSTALL_PERMISSIONS,
      { ...INSTALL_PERMISSIONS, emails: "write" },
    ]) {
      const github = fakeGitHub(githubRoutes({ appPermissions }));
      await assert.rejects(verifyWith(file, github.fetchImpl), /Email addresses is not Read-only/);
      assert.equal(
        github.calls.some((call) => call.method === "POST"),
        false
      );
    }
    assert.equal(await fs.readFile(file, "latin1"), APP_ENV);
  });

  it("refuses an installation list that spans more than one page", async (t) => {
    const dir = await tempDir(t);
    const file = await writeEnv(dir, APP_ENV);
    const github = fakeGitHub(
      githubRoutes({ link: '<https://api.github.com/app/installations?page=2>; rel="next"' })
    );
    await assert.rejects(verifyWith(file, github.fetchImpl), /more than one page/);
    assert.equal(
      github.calls.some((call) => call.method === "POST"),
      false
    );
  });

  it("refuses to run while the pilot account id is null, before any network call", async (t) => {
    const dir = await tempDir(t);
    const file = await writeEnv(dir, APP_ENV);
    const github = fakeGitHub({});
    await assert.rejects(
      bootstrap.verifyInstallation({
        envFile: file,
        fetchImpl: github.fetchImpl,
        store: storeFor(),
        pilot: { ...PILOT, accountId: null },
      }),
      /not pinned/
    );
    assert.equal(github.calls.length, 0);
  });

  it("refuses a missing env file", async (t) => {
    const dir = await tempDir(t);
    await assert.rejects(
      bootstrap.verifyInstallation({
        envFile: path.join(dir, "control-plane.env"),
        store: storeFor(),
        pilot: PILOT,
      }),
      /is missing/
    );
  });

  it("maps a GitHub timeout to a fixed message that carries no URL", async (t) => {
    const dir = await tempDir(t);
    const file = await writeEnv(dir, APP_ENV);
    const fetchImpl = async () => {
      throw Object.assign(new Error("https://api.github.com/app/installations"), {
        name: "TimeoutError",
      });
    };
    await assert.rejects(
      verifyWith(file, fetchImpl),
      (error) => error.message === "GitHub did not respond in time"
    );
  });
});

describe("command line", () => {
  it("prints one PASS line on success and never the verification token", async (t) => {
    const dir = await tempDir(t);
    await writeEnv(dir, APP_ENV);
    const out = [];
    const err = [];
    const code = await bootstrap.main(["verify"], {
      env: { POLYTRONX_SECRETS_DIR: dir },
      stdout: { write: (text) => out.push(text) },
      stderr: { write: (text) => err.push(text) },
      fetchImpl: fakeGitHub(githubRoutes()).fetchImpl,
      store: storeFor(),
      now: () => 1_700_000_000_000,
      pilot: PILOT,
    });
    assert.equal(code, 0);
    assert.deepEqual(out, ["verify: PASS\n"]);
    assert.deepEqual(err, []);
  });

  it("reports a refusal as one FAIL line with exit 1", async (t) => {
    const dir = await tempDir(t);
    await writeEnv(dir, APP_ENV);
    const out = [];
    const err = [];
    const code = await bootstrap.main(["verify"], {
      env: { POLYTRONX_SECRETS_DIR: dir },
      stdout: { write: (text) => out.push(text) },
      stderr: { write: (text) => err.push(text) },
      fetchImpl: fakeGitHub(githubRoutes({ installations: [] })).fetchImpl,
      store: storeFor(),
      now: () => 1_700_000_000_000,
      pilot: PILOT,
    });
    assert.equal(code, 1);
    assert.deepEqual(out, []);
    assert.deepEqual(err, ["verify: FAIL: expected one matching installation, found 0\n"]);
  });

  it("rejects an unknown mode and a relative secrets directory with exit 2", async () => {
    const err = [];
    const stderr = { write: (text) => err.push(text) };
    assert.equal(await bootstrap.main(["bogus"], { stderr }), 2);
    assert.match(err[0], /^usage:/);
    assert.equal(
      await bootstrap.main(["verify"], { env: { POLYTRONX_SECRETS_DIR: "relative" }, stderr }),
      2
    );
    assert.equal(err[1], "POLYTRONX_SECRETS_DIR must be an absolute path\n");
  });
});
