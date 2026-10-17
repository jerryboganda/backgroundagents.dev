import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateSandboxConfig, ResolveSandboxConfig, StopConfig } from "../provider";
import { createVpsProviderFromEnv } from "../provider-factory";
import { parseVpsPendingVmReference } from "./pending-vm-reference";
import { createVpsProvider } from "./vps-provider";

const executorUrl = "https://executor.test";
const executorToken = "exec-token-secret";
// Same secret and fixture values as the executor's admission test, which pins the same signature.
const admissionSecret = "test-admission-secret-0123456789abcdef";

const createConfig: CreateSandboxConfig = {
  sessionId: "session-1",
  sandboxId: "sandbox-1",
  repoOwner: "acme",
  repoName: "repo",
  controlPlaneUrl: "https://control.example",
  sandboxAuthToken: "sandbox-auth-secret",
  harness: "opencode",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  userEnvVars: { REPO_SECRET: "repo-secret-value" },
  admissionLease: { leaseToken: "lease-1", expiresAtMs: 1_700_000_000_000 },
};

const stopConfig: StopConfig = {
  providerObjectId: "vm-1",
  sessionId: "session-1",
  reason: "inactivity_timeout",
  intent: "destroy",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Returns the thrown value so tests can assert on its type and classification. */
async function failureOf(action: () => unknown): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error("expected the action to fail");
}

describe("VpsSandboxProvider", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The lease the create was granted, so a pending stop's close signs the same tuple the create did.
  const leases = {
    leaseOf: vi.fn(async () => ({ leaseToken: "lease-1", expiresAtMs: 1_700_000_000_000 })),
  };
  const provider = () => createVpsProvider({ executorUrl, executorToken, admissionSecret, leases });

  it("advertises only the capabilities it implements", () => {
    expect(provider().capabilities).toEqual({
      supportsSandboxTimeout: false,
      supportsSnapshots: false,
      supportsRestore: false,
      supportsPersistentResume: false,
      supportsExplicitStop: true,
    });
  });

  it("fails fast with a typed error when URL or token is missing", async () => {
    const incomplete = [
      {},
      { executorUrl },
      { executorToken },
      { executorUrl, executorToken: " " },
    ];
    for (const config of incomplete) {
      expect(await failureOf(() => createVpsProvider(config))).toMatchObject({
        name: "SandboxProviderError",
        errorType: "permanent",
      });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("requires an https executor URL", async () => {
    const insecure = { executorUrl: "http://executor.test", executorToken };
    expect(await failureOf(() => createVpsProvider(insecure))).toMatchObject({
      errorType: "permanent",
      message: "VPS executor URL must use https",
    });
  });

  it("creates a sandbox with bearer auth, the admission proof, and the session environment", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ providerObjectId: "vm-1" }));

    await expect(provider().createSandbox(createConfig)).resolves.toMatchObject({
      sandboxId: "sandbox-1",
      providerObjectId: "vm-1",
      lifetime: { kind: "unknown" },
    });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://executor.test/v1/sandboxes");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Bearer ${executorToken}`);
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      sandboxId: "sandbox-1",
      sessionId: "session-1",
      admissionLease: {
        leaseToken: "lease-1",
        expiresAtMs: 1_700_000_000_000,
        signature: "18d08991beb7a63118d5b80776ebb1dd9011ed70bec9b26363bfb760415c8062",
      },
      runtimeContext: { env: expect.any(Object) },
    });
    // The same session env buildSandboxEnvVars assembles for every other provider.
    expect(body.runtimeContext.env).toMatchObject({
      SANDBOX_ID: "sandbox-1",
      CONTROL_PLANE_URL: "https://control.example",
      SANDBOX_AUTH_TOKEN: "sandbox-auth-secret",
      REPO_OWNER: "acme",
      REPO_NAME: "repo",
      REPO_SECRET: "repo-secret-value",
      VCS_HOST: "github.com",
    });
    expect(JSON.parse(body.runtimeContext.env.SESSION_CONFIG)).toMatchObject({
      session_id: "session-1",
    });
  });

  it("omits the admission proof when no gate is configured", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ providerObjectId: "vm-1" }));

    await provider().createSandbox({ ...createConfig, admissionLease: undefined });

    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({
      sandboxId: "sandbox-1",
      sessionId: "session-1",
      runtimeContext: { env: expect.any(Object) },
    });
  });

  it("keeps the session environment out of a refusal, and treats a refused context as allocating nothing", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ error: "runtime_context_mismatch" }, 403));
    const refused = await failureOf(() => provider().createSandbox(createConfig));
    expect(provider().isUnknownStartupError(refused)).toBe(false);
    expect(String((refused as Error).message)).not.toContain("sandbox-auth-secret");

    fetchSpy.mockResolvedValueOnce(jsonResponse({ error: "runtime_start_failed" }, 502));
    const unrun = await failureOf(() => provider().createSandbox(createConfig));
    expect(provider().isUnknownStartupError(unrun)).toBe(true);
  });

  it("names the configured SCM host in the runtime environment", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ providerObjectId: "vm-1" }));
    const gitlab = createVpsProviderFromEnv({
      VPS_EXECUTOR_URL: executorUrl,
      VPS_EXECUTOR_TOKEN: executorToken,
      VPS_EXECUTOR_ADMISSION_SECRET: admissionSecret,
      SCM_PROVIDER: "gitlab",
    });

    await gitlab.createSandbox({ ...createConfig, admissionLease: undefined });

    const env = JSON.parse(fetchSpy.mock.calls[0][1].body).runtimeContext.env;
    expect(env.VCS_HOST).toBe("gitlab.com");
    expect(env.VCS_CLONE_USERNAME).toBe("oauth2");
  });

  it("drops the session env keys the runtime refuses, logs their names only, and keeps the system env", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ providerObjectId: "vm-1" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const overlong = `A${"B".repeat(128)}`;

    await provider().createSandbox({
      ...createConfig,
      admissionLease: undefined,
      userEnvVars: {
        REPO_SECRET: "repo-secret-value",
        PYTHONPATH: "/evil-path",
        _FOO: "evil-underscore",
        [overlong]: "evil-overlong",
        foo_bar: "evil-lowercase",
      },
    });

    const env = JSON.parse(fetchSpy.mock.calls[0][1].body).runtimeContext.env;
    expect(env).toMatchObject({
      REPO_SECRET: "repo-secret-value",
      SANDBOX_ID: "sandbox-1",
      PYTHONUNBUFFERED: "1",
    });
    expect(env).not.toHaveProperty("PYTHONPATH");
    expect(env).not.toHaveProperty("_FOO");
    expect(env).not.toHaveProperty(overlong);
    expect(env).not.toHaveProperty("foo_bar");
    const logged = warn.mock.calls.flat().map(String).join("\n");
    expect(logged).toContain("PYTHONPATH");
    expect(logged).toContain("_FOO");
    expect(logged).toContain("foo_bar");
    expect(logged).toContain(overlong);
    expect(logged).not.toMatch(/evil-|repo-secret-value/);
    warn.mockRestore();
  });

  it("fails fast without an admission secret, before any request", async () => {
    expect(await failureOf(() => createVpsProvider({ executorUrl, executorToken }))).toMatchObject({
      errorType: "permanent",
      message: "VPS executor admission secret is required",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("classifies HTTP failures by status and never puts the token in errors", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("upstream down", { status: 503 }));
    expect(await failureOf(() => provider().createSandbox(createConfig))).toMatchObject({
      errorType: "transient",
    });

    fetchSpy.mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401));
    const rejected = await failureOf(() => provider().createSandbox(createConfig));
    expect(rejected).toMatchObject({
      errorType: "permanent",
      message: "Failed to create sandbox: executor returned HTTP 401",
    });
    expect((rejected as Error).message).not.toContain(executorToken);
  });

  it("classifies a create as refused only when the executor names a refusal that allocates nothing", async () => {
    const refusals: Array<[number, string]> = [
      [401, "unauthorized"],
      [403, "admission_expired"],
      [409, "workspace_busy"],
      [503, "capacity_exhausted"],
      [503, "workspace_capacity_exhausted"],
      [503, "isolation_unavailable"],
    ];
    for (const [status, code] of refusals) {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ error: code }, status));
      const failure = await failureOf(() => provider().createSandbox(createConfig));
      expect(provider().isUnknownStartupError(failure), code).toBe(false);
    }
  });

  it("treats every other create failure as possibly allocated", async () => {
    const ambiguous: Array<() => void> = [
      () => fetchSpy.mockResolvedValueOnce(jsonResponse({ error: "create_unresolved" }, 503)),
      // Answered after a container started, when its state write failed: the object may exist.
      () => fetchSpy.mockResolvedValueOnce(jsonResponse({ error: "state_unavailable" }, 503)),
      // Refused after its workspace was reserved, and that cleanup is best-effort: the answer proves nothing.
      () => fetchSpy.mockResolvedValueOnce(jsonResponse({ error: "workspace_unavailable" }, 503)),
      () => fetchSpy.mockResolvedValueOnce(jsonResponse({ error: "create_in_progress" }, 409)),
      // Answered for a create the executor already admitted under this lease or sandbox id: an object may exist.
      () => fetchSpy.mockResolvedValueOnce(jsonResponse({ error: "admission_replayed" }, 403)),
      () => fetchSpy.mockResolvedValueOnce(jsonResponse({ error: "sandbox_id_conflict" }, 409)),
      // docker run can start a container before it fails, so this one may have allocated.
      () => fetchSpy.mockResolvedValueOnce(jsonResponse({ error: "create_failed" }, 502)),
      () => fetchSpy.mockResolvedValueOnce(new Response("gateway", { status: 504 })),
      () => fetchSpy.mockResolvedValueOnce(new Response("<html>", { status: 403 })),
      () => fetchSpy.mockResolvedValueOnce(jsonResponse({}, 201)),
      () => fetchSpy.mockRejectedValueOnce(new TypeError("fetch failed")),
    ];
    for (const respond of ambiguous) {
      respond();
      const failure = await failureOf(() => provider().createSandbox(createConfig));
      expect(provider().isUnknownStartupError(failure)).toBe(true);
    }
  });

  it("names an ambiguous create by its sandbox, with a conservative start bound", () => {
    const pending = provider().pendingSandboxAllocation({
      sessionId: "session-1",
      sandboxId: "sandbox-1",
      generationCreatedAtMs: 1_000,
      timeoutSeconds: 60,
    });

    expect(parseVpsPendingVmReference(pending.reference)).toEqual({
      sessionId: "session-1",
      sandboxId: "sandbox-1",
    });
    expect(pending.lifetime).toEqual({
      kind: "finite",
      expiresAtMs: 61_000,
      observedAtMs: 1_000,
      source: "conservative_start_bound",
    });
    expect(() =>
      provider().pendingSandboxAllocation({ sessionId: "session-1", sandboxId: "sandbox-1" })
    ).toThrow("Missing VPS generation reservation time");
  });

  it("treats a network failure as transient", async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await failureOf(() => provider().createSandbox(createConfig))).toMatchObject({
      errorType: "transient",
    });
  });

  it("treats a request deadline as transient", async () => {
    fetchSpy.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        })
    );
    const impatient = createVpsProvider({
      executorUrl,
      executorToken,
      admissionSecret,
      requestTimeoutMs: 5,
    });

    expect(await failureOf(() => impatient.createSandbox(createConfig))).toMatchObject({
      errorType: "transient",
      message: "Failed to create sandbox",
    });
  });

  it("rejects a create response without a provider object id", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({}));
    expect(await failureOf(() => provider().createSandbox(createConfig))).toMatchObject({
      errorType: "permanent",
      message: "Failed to create sandbox: unexpected executor response",
    });
  });

  it("stops the object a pending reference names, and confirms the stop once the executor proves none exists", async () => {
    const pendingObject = provider().pendingSandboxAllocation({
      sessionId: "session-1",
      sandboxId: "sandbox-1",
      generationCreatedAtMs: 1_000,
    }).reference;
    const stopPending = { ...stopConfig, providerObjectId: pendingObject };

    fetchSpy.mockResolvedValueOnce(jsonResponse({ outcome: "present", providerObjectId: "vm-1" }));
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(provider().stopSandbox(stopPending)).resolves.toEqual({ success: true });
    expect(fetchSpy.mock.calls[0][0]).toBe(
      "https://executor.test/v1/sandboxes/sandbox-1/admission/close"
    );
    expect(fetchSpy.mock.calls[1][0]).toBe("https://executor.test/v1/sandboxes/vm-1/stop");

    // Absent: nothing was created or can be, so the stop is confirmed without a stop call.
    fetchSpy.mockResolvedValueOnce(jsonResponse({ outcome: "absent" }));
    await expect(provider().stopSandbox(stopPending)).resolves.toEqual({ success: true });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("does not claim a pending stop while the executor cannot close its id", async () => {
    const pendingObject = provider().pendingSandboxAllocation({
      sessionId: "session-1",
      sandboxId: "sandbox-1",
      generationCreatedAtMs: 1_000,
    }).reference;
    const stopPending = { ...stopConfig, providerObjectId: pendingObject };
    // A 404 may be a missing route, and a 409 says a create still runs: neither proves absence.
    fetchSpy.mockResolvedValueOnce(new Response("", { status: 404 }));
    fetchSpy.mockResolvedValueOnce(jsonResponse({ error: "create_in_progress" }, 409));
    fetchSpy.mockResolvedValueOnce(new Response("", { status: 503 }));

    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await failureOf(() => provider().stopSandbox(stopPending))).toMatchObject({
        errorType: "transient",
      });
    }
    // Only the close was called; no stop was ever sent for an unproven id.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    for (const [url] of fetchSpy.mock.calls) {
      expect(url).toBe("https://executor.test/v1/sandboxes/sandbox-1/admission/close");
    }
  });

  it("settles a pending stop whose admission lease a proof already freed, with no close and no stop", async () => {
    const pendingObject = provider().pendingSandboxAllocation({
      sessionId: "session-1",
      sandboxId: "sandbox-1",
      generationCreatedAtMs: 1_000,
    }).reference;
    // A lease is freed only by proof, so once it is gone nothing can appear under the reference.
    const freed = createVpsProvider({
      executorUrl,
      executorToken,
      admissionSecret,
      leases: { leaseOf: async () => null },
    });

    await expect(
      freed.stopSandbox({ ...stopConfig, providerObjectId: pendingObject })
    ).resolves.toEqual({ success: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps a pending stop pending when no admission lease source is configured, and sends no close", async () => {
    const pendingObject = provider().pendingSandboxAllocation({
      sessionId: "session-1",
      sandboxId: "sandbox-1",
      generationCreatedAtMs: 1_000,
    }).reference;
    const unsourced = createVpsProvider({ executorUrl, executorToken, admissionSecret });

    expect(
      await failureOf(() =>
        unsourced.stopSandbox({ ...stopConfig, providerObjectId: pendingObject })
      )
    ).toMatchObject({ errorType: "transient" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("closes admission for a sandbox id with its signed lease, and reads only the absent and present answers as proof", async () => {
    const admissionLease = { leaseToken: "lease-1", expiresAtMs: 1_700_000_000_000 };
    const close = () =>
      provider().closeAdmission({ sessionId: "session-1", sandboxId: "sandbox-1", admissionLease });

    fetchSpy.mockResolvedValueOnce(jsonResponse({ outcome: "absent" }));
    await expect(close()).resolves.toEqual({ kind: "absent" });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://executor.test/v1/sandboxes/sandbox-1/admission/close");
    expect(init.method).toBe("POST");
    // The same signed tuple the create carried, so the close names the same lease.
    expect(JSON.parse(init.body)).toEqual({
      sessionId: "session-1",
      admissionLease: {
        ...admissionLease,
        signature: "18d08991beb7a63118d5b80776ebb1dd9011ed70bec9b26363bfb760415c8062",
      },
    });

    fetchSpy.mockResolvedValueOnce(jsonResponse({ outcome: "present", providerObjectId: "vm-9" }));
    await expect(close()).resolves.toEqual({ kind: "present", providerObjectId: "vm-9" });

    const notProof: Array<() => void> = [
      () => fetchSpy.mockResolvedValueOnce(new Response("", { status: 404 })),
      () => fetchSpy.mockResolvedValueOnce(jsonResponse({ error: "create_in_progress" }, 409)),
      () => fetchSpy.mockResolvedValueOnce(jsonResponse({ outcome: "maybe" })),
      () => fetchSpy.mockResolvedValueOnce(jsonResponse({ outcome: "present" })),
      // A 503 names an unplaced or unacknowledged container: undecided, never absent.
      () => fetchSpy.mockResolvedValueOnce(jsonResponse({ error: "container_unaccounted" }, 503)),
      () => fetchSpy.mockResolvedValueOnce(jsonResponse({ error: "create_unresolved" }, 503)),
    ];
    for (const respond of notProof) {
      respond();
      expect(await close()).toEqual({ kind: "undecided" });
    }
    // An unreadable answer fails the request instead, which never frees a slot either.
    fetchSpy.mockResolvedValueOnce(new Response("not json", { status: 200 }));
    await expect(close()).rejects.toThrow();
  });

  it("destroys a sandbox by provider object id", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(provider().stopSandbox(stopConfig)).resolves.toEqual({ success: true });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://executor.test/v1/sandboxes/vm-1/stop");
    expect(JSON.parse(init.body)).toEqual({ reason: "inactivity_timeout" });
  });

  it("treats an already-gone sandbox as stopped, on the executor's typed sandbox_not_found", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ error: "sandbox_not_found" }, 404));
    await expect(provider().stopSandbox(stopConfig)).resolves.toEqual({ success: true });
  });

  it("keeps a stop unconfirmed on any 404 that is not the typed sandbox_not_found, including the router's generic not_found", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("", { status: 404 }));
    await expect(provider().stopSandbox(stopConfig)).rejects.toThrow();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ error: "not_found" }, 404));
    await expect(provider().stopSandbox(stopConfig)).rejects.toThrow();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ error: "stop_unknown" }, 404));
    await expect(provider().stopSandbox(stopConfig)).rejects.toThrow();
  });

  it("refuses preserve stops instead of destroying state silently", async () => {
    await expect(provider().stopSandbox({ ...stopConfig, intent: "preserve" })).resolves.toEqual({
      success: false,
      error: "VPS executor cannot preserve sandbox state",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("resolves a sandbox by logical id and rejects a different one", async () => {
    const lookup: ResolveSandboxConfig = {
      sessionId: "session-1",
      sandboxId: "sandbox-1",
      generationCreatedAtMs: 1_700_000_000_000,
    };
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ sandboxId: "sandbox-1", providerObjectId: "vm-1" })
    );

    await expect(provider().resolveSandbox(lookup)).resolves.toMatchObject({
      sandboxId: "sandbox-1",
      providerObjectId: "vm-1",
    });
    expect(fetchSpy.mock.calls[0][0]).toBe("https://executor.test/v1/sandboxes/sandbox-1");

    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ sandboxId: "sandbox-other", providerObjectId: "vm-2" })
    );
    expect(await failureOf(() => provider().resolveSandbox(lookup))).toMatchObject({
      errorType: "permanent",
    });
  });

  it("never resolves a sandbox the executor answers 503 for, so an unaccounted or unacknowledged runtime is not ready", async () => {
    const lookup: ResolveSandboxConfig = {
      sessionId: "session-1",
      sandboxId: "sandbox-1",
      generationCreatedAtMs: 1_700_000_000_000,
    };
    for (const error of ["container_unaccounted", "create_unresolved"]) {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ error }, 503));
      expect(await failureOf(() => provider().resolveSandbox(lookup)), error).toMatchObject({
        errorType: "transient",
      });
    }
  });

  it("probes executor health and reports an unhealthy executor as transient", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("", { status: 200 }));
    await expect(provider().healthCheck()).resolves.toBeUndefined();
    expect(fetchSpy.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${executorToken}`);

    fetchSpy.mockResolvedValueOnce(new Response("", { status: 503 }));
    expect(await failureOf(() => provider().healthCheck())).toMatchObject({
      errorType: "transient",
    });
  });
});

describe("createVpsProviderFromEnv", () => {
  it("builds the provider from VPS env fields and fails fast when they are missing", () => {
    expect(
      createVpsProviderFromEnv({
        VPS_EXECUTOR_URL: executorUrl,
        VPS_EXECUTOR_TOKEN: executorToken,
        VPS_EXECUTOR_ADMISSION_SECRET: admissionSecret,
      }).name
    ).toBe("vps");
    expect(() => createVpsProviderFromEnv({})).toThrow("VPS executor URL and token are required");
    expect(() =>
      createVpsProviderFromEnv({ VPS_EXECUTOR_URL: executorUrl, VPS_EXECUTOR_TOKEN: executorToken })
    ).toThrow("VPS executor admission secret is required");
  });
});
