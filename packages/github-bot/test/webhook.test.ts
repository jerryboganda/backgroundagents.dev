import { describe, it, expect, vi } from "vitest";
import type { ExecutionContext as HonoExecutionContext } from "hono";
import type { Env } from "../src/types";

vi.mock("../src/github-auth", () => ({
  generateInstallationToken: vi.fn().mockResolvedValue("installation-token"),
  postReaction: vi.fn().mockResolvedValue(true),
  postIssueComment: vi.fn().mockResolvedValue(true),
  checkSenderPermission: vi.fn().mockResolvedValue({ hasPermission: true }),
}));

import worker, { consumeGitHubWebhooks } from "../src/index";
import {
  claimDelivery,
  finalizeDelivery,
  pruneExpiredDeliveries,
  releaseDelivery,
  renewDelivery,
} from "../src/delivery-claims";
import { postReaction, postIssueComment, checkSenderPermission } from "../src/github-auth";

/** Generate a valid GitHub webhook signature for a given secret and body. */
async function sign(secret: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256=${hex}`;
}

const SECRET = "test-webhook-secret";

function createMockKV() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
}

type DeliveryRow = { token: string; status: "processing" | "processed"; expiresAt: number };

function createMockDeliveryDB() {
  const rows = new Map<string, DeliveryRow>();
  return {
    rows,
    prepare: vi.fn((sql: string) => ({
      bind: (...args: unknown[]) => ({
        run: async () => {
          if (sql.startsWith("INSERT INTO github_webhook_deliveries")) {
            const [id, token, expiresAt, now] = args as [string, string, number, number];
            const current = rows.get(id);
            if (current && current.expiresAt > now) return { meta: { changes: 0 } };
            rows.set(id, { token, status: "processing", expiresAt });
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("UPDATE github_webhook_deliveries")) {
            if (sql.includes("SET expires_at_ms")) {
              const [expiresAt, id, token, now] = args as [number, string, string, number];
              const current = rows.get(id);
              if (
                !current ||
                current.token !== token ||
                current.status !== "processing" ||
                current.expiresAt <= now
              )
                return { meta: { changes: 0 } };
              current.expiresAt = expiresAt;
              return { meta: { changes: 1 } };
            }
            const [expiresAt, id, token, now] = args as [number, string, string, number];
            const current = rows.get(id);
            if (
              !current ||
              current.token !== token ||
              current.status !== "processing" ||
              current.expiresAt <= now
            )
              return { meta: { changes: 0 } };
            rows.set(id, { token, status: "processed", expiresAt });
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("SELECT status FROM github_webhook_deliveries")) {
            throw new Error("Use first() for SELECT");
          }
          if (sql.startsWith("DELETE FROM github_webhook_deliveries")) {
            if (sql.includes("WHERE delivery_id IN")) {
              const now = args[0] as number;
              const expired = [...rows.entries()]
                .filter(([, row]) => row.expiresAt <= now)
                .sort((a, b) => a[1].expiresAt - b[1].expiresAt)
                .slice(0, 100);
              for (const [id] of expired) rows.delete(id);
              return { meta: { changes: expired.length } };
            }
            const [id, token] = args as [string, string];
            const current = rows.get(id);
            if (!current || current.token !== token) return { meta: { changes: 0 } };
            rows.delete(id);
            return { meta: { changes: 1 } };
          }
          throw new Error(`Unexpected D1 statement: ${sql}`);
        },
        first: async () => {
          const row = rows.get(args[0] as string);
          return row ? { status: row.status } : null;
        },
      }),
    })),
  };
}

function deliveryStatus(env: Env, id: string): string | null {
  return (
    (env.DB as unknown as ReturnType<typeof createMockDeliveryDB>).rows.get(id)?.status ?? null
  );
}

function makeEnv() {
  const githubKv = createMockKV();
  return {
    GITHUB_KV: githubKv,
    DB: createMockDeliveryDB(),
    AUTOFIX_QUEUE: {
      send: vi.fn(async () => undefined),
    },
    WEBHOOK_QUEUE: {
      send: vi.fn(async () => undefined),
    },
    CONTROL_PLANE: {
      fetch: vi.fn(async () => new Response(null, { status: 204 })),
    },
    GITHUB_WEBHOOK_SECRET: SECRET,
    SERVICE_AUTH_SECRET: "test-internal-secret",
    GITHUB_BOT_USERNAME: "test-bot[bot]",
    DEPLOYMENT_NAME: "test",
    DEFAULT_MODEL: "anthropic/claude-haiku-4-5",
    LOG_LEVEL: "error",
  } as unknown as Env;
}

// Run the durable consumer explicitly after the provider's HTTP response.
// Legacy delivery checks still observe the resulting retry and completion paths.
const app = {
  fetch: async (request: Request, env: Env, ctx: ReturnType<typeof makeCtx>) => {
    const response = await worker.fetch(request, env, ctx);
    if (response.ok && request.method === "POST" && request.url.endsWith("/webhooks/github")) {
      const sent = vi.mocked(env.WEBHOOK_QUEUE.send).mock.lastCall?.[0];
      if (sent) {
        ctx.waitUntil(
          consumeGitHubWebhooks(
            {
              messages: [
                {
                  body: sent,
                  ack: vi.fn(),
                  retry: vi.fn(),
                },
              ],
            } as unknown as Parameters<typeof consumeGitHubWebhooks>[0],
            env
          )
        );
      }
    }
    return response;
  },
};

function makeCtx() {
  return {
    props: {},
    waitUntil: vi.fn<HonoExecutionContext["waitUntil"]>(),
    passThroughOnException: vi.fn<HonoExecutionContext["passThroughOnException"]>(),
  } satisfies HonoExecutionContext;
}

async function flushWaitUntil(ctx: ReturnType<typeof makeCtx>, callIndex = 0): Promise<void> {
  await ctx.waitUntil.mock.calls[callIndex]?.[0];
}

describe("POST /webhooks/github", () => {
  it("returns 503 without processing when durable intake fails", async () => {
    const body = JSON.stringify({ action: "opened" });
    const env = makeEnv();
    const ctx = makeCtx();
    vi.mocked(env.WEBHOOK_QUEUE.send).mockRejectedValueOnce(new Error("intake offline"));
    const request = () =>
      new Request("http://localhost/webhooks/github", {
        method: "POST",
        body,
        headers: {
          "X-Hub-Signature-256": "",
          "X-GitHub-Event": "push",
          "X-GitHub-Delivery": "intake-retry",
        },
      });
    const signedRequest = async () => {
      const req = request();
      req.headers.set("X-Hub-Signature-256", await sign(SECRET, body));
      return req;
    };
    expect((await app.fetch(await signedRequest(), env, ctx)).status).toBe(503);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(env.CONTROL_PLANE.fetch).not.toHaveBeenCalled();
    expect(deliveryStatus(env, "intake-retry")).toBeNull();
    expect((await app.fetch(await signedRequest(), env, ctx)).status).toBe(200);
    await flushWaitUntil(ctx);
    expect(deliveryStatus(env, "intake-retry")).toBe("processed");
  });

  it("queues an eligible pull request comment before acknowledging the webhook", async () => {
    const body = JSON.stringify({
      action: "created",
      issue: {
        number: 42,
        title: "Handle nullable input",
        pull_request: {
          url: "https://api.github.com/repos/test/repo/pulls/42",
        },
      },
      comment: {
        id: 1234,
        body: "Please handle the null case.",
        user: { login: "alice" },
      },
      repository: {
        id: 99,
        name: "repo",
        private: false,
        owner: { login: "test" },
      },
      sender: {
        id: 7,
        login: "alice",
        type: "User",
        avatar_url: "https://example.com/alice.png",
      },
    });
    const signature = await sign(SECRET, body);
    const env = makeEnv();
    const ctx = makeCtx();

    const res = await app.fetch(
      new Request("http://localhost/webhooks/github", {
        method: "POST",
        body,
        headers: {
          "X-Hub-Signature-256": signature,
          "X-GitHub-Event": "issue_comment",
          "X-GitHub-Delivery": "delivery-comment-1234",
        },
      }),
      env,
      ctx
    );

    expect(res.status).toBe(200);
    await flushWaitUntil(ctx);
    expect(env.AUTOFIX_QUEUE.send).toHaveBeenCalledOnce();
    expect(env.AUTOFIX_QUEUE.send).toHaveBeenCalledWith({
      version: 1,
      eventType: "issue_comment",
      action: "created",
      deliveryId: "delivery-comment-1234",
      providerObject: { kind: "pr_comment", id: "1234" },
      repository: { id: "99", owner: "test", name: "repo" },
      pullRequestNumber: 42,
      receivedAt: expect.any(String),
    });
    await flushWaitUntil(ctx);
    expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledWith(
      "https://internal/internal/github-event",
      expect.any(Object)
    );
  });

  it("does not queue explicit bot mentions for Autofix", async () => {
    const body = JSON.stringify({
      action: "created",
      issue: {
        number: 42,
        title: "Handle nullable input",
        pull_request: {
          url: "https://api.github.com/repos/test/repo/pulls/42",
        },
      },
      comment: {
        id: 1235,
        body: "@test-bot[bot] please investigate this.",
        user: { login: "alice" },
      },
      repository: {
        id: 99,
        name: "repo",
        private: false,
        owner: { login: "test" },
      },
      sender: {
        id: 7,
        login: "alice",
        type: "User",
        avatar_url: "https://example.com/alice.png",
      },
    });
    const signature = await sign(SECRET, body);
    const env = makeEnv();
    const ctx = makeCtx();

    const res = await app.fetch(
      new Request("http://localhost/webhooks/github", {
        method: "POST",
        body,
        headers: {
          "X-Hub-Signature-256": signature,
          "X-GitHub-Event": "issue_comment",
          "X-GitHub-Delivery": "delivery-comment-1235",
        },
      }),
      env,
      ctx
    );

    expect(res.status).toBe(200);
    expect(env.AUTOFIX_QUEUE.send).not.toHaveBeenCalled();
    expect(ctx.waitUntil).toHaveBeenCalledOnce();
  });

  it("queues one Autofix request for a submitted review", async () => {
    const body = JSON.stringify({
      action: "submitted",
      review: {
        id: 5678,
        state: "changes_requested",
      },
      pull_request: { number: 42 },
      repository: {
        id: 99,
        name: "repo",
        owner: { login: "test" },
      },
      sender: { id: 7, login: "alice", type: "User" },
    });
    const signature = await sign(SECRET, body);
    const env = makeEnv();

    const res = await app.fetch(
      new Request("http://localhost/webhooks/github", {
        method: "POST",
        body,
        headers: {
          "X-Hub-Signature-256": signature,
          "X-GitHub-Event": "pull_request_review",
          "X-GitHub-Delivery": "delivery-review-5678",
        },
      }),
      env,
      makeCtx()
    );

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(env.AUTOFIX_QUEUE.send).toHaveBeenCalledOnce());
    expect(env.AUTOFIX_QUEUE.send).toHaveBeenCalledOnce();
    expect(env.AUTOFIX_QUEUE.send).toHaveBeenCalledWith({
      version: 1,
      eventType: "pull_request_review",
      action: "submitted",
      deliveryId: "delivery-review-5678",
      providerObject: { kind: "review", id: "5678" },
      repository: { id: "99", owner: "test", name: "repo" },
      pullRequestNumber: 42,
      receivedAt: expect.any(String),
    });
  });

  it("does not queue individual review comment webhooks", async () => {
    const body = JSON.stringify({
      action: "created",
      pull_request: {
        number: 42,
        title: "Handle nullable input",
        head: { ref: "feature/nulls", sha: "abc123" },
        base: { ref: "main" },
      },
      comment: {
        id: 5679,
        body: "Please handle the null case.",
        path: "src/input.ts",
        diff_hunk: "@@ -1 +1 @@",
        user: { login: "alice" },
      },
      repository: {
        id: 99,
        name: "repo",
        private: false,
        owner: { login: "test" },
      },
      sender: {
        id: 7,
        login: "alice",
        type: "User",
        avatar_url: "https://example.com/alice.png",
      },
    });
    const signature = await sign(SECRET, body);
    const env = makeEnv();

    const res = await app.fetch(
      new Request("http://localhost/webhooks/github", {
        method: "POST",
        body,
        headers: {
          "X-Hub-Signature-256": signature,
          "X-GitHub-Event": "pull_request_review_comment",
          "X-GitHub-Delivery": "delivery-review-comment-5679",
        },
      }),
      env,
      makeCtx()
    );

    expect(res.status).toBe(200);
    expect(env.AUTOFIX_QUEUE.send).not.toHaveBeenCalled();
  });

  it("acknowledges durable intake, then retries failed Autofix delivery", async () => {
    const body = JSON.stringify({
      action: "created",
      issue: {
        number: 42,
        title: "Handle nullable input",
        pull_request: {
          url: "https://api.github.com/repos/test/repo/pulls/42",
        },
      },
      comment: {
        id: 1236,
        body: "Please handle the null case.",
        user: { login: "alice" },
      },
      repository: {
        id: 99,
        name: "repo",
        private: false,
        owner: { login: "test" },
      },
      sender: {
        id: 7,
        login: "alice",
        type: "User",
        avatar_url: "https://example.com/alice.png",
      },
    });
    const signature = await sign(SECRET, body);
    const env = makeEnv();
    const ctx = makeCtx();
    vi.mocked(env.AUTOFIX_QUEUE.send).mockRejectedValueOnce(new Error("queue unavailable"));

    const request = () =>
      new Request("http://localhost/webhooks/github", {
        method: "POST",
        body,
        headers: {
          "X-Hub-Signature-256": signature,
          "X-GitHub-Event": "issue_comment",
          "X-GitHub-Delivery": "delivery-comment-1236",
        },
      });
    const res = await app.fetch(request(), env, ctx);

    expect(res.status).toBe(200);
    await flushWaitUntil(ctx);
    expect(ctx.waitUntil).toHaveBeenCalledOnce();
    expect(deliveryStatus(env, "delivery-comment-1236")).toBeNull();
    expect(env.CONTROL_PLANE.fetch).not.toHaveBeenCalled();

    expect((await app.fetch(request(), env, ctx)).status).toBe(200);
    await flushWaitUntil(ctx, 1);
    expect(env.AUTOFIX_QUEUE.send).toHaveBeenCalledTimes(2);
    expect(deliveryStatus(env, "delivery-comment-1236")).toBe("processed");
    expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledWith(
      "https://internal/internal/github-event",
      expect.any(Object)
    );
  });

  it("keys forwarded ready_for_review events by delivery id", async () => {
    const body = JSON.stringify({
      action: "ready_for_review",
      pull_request: { number: 42, draft: false, head: { ref: "feature", sha: "abc123" } },
      repository: { id: 99, name: "repo", private: false, owner: { login: "test" } },
      sender: { id: 7, login: "alice", type: "User" },
    });
    const env = makeEnv();
    const ctx = makeCtx();

    const res = await app.fetch(
      new Request("http://localhost/webhooks/github", {
        method: "POST",
        body,
        headers: {
          "X-Hub-Signature-256": await sign(SECRET, body),
          "X-GitHub-Event": "pull_request",
          "X-GitHub-Delivery": "delivery-ready-1",
        },
      }),
      env,
      ctx
    );

    expect(res.status).toBe(200);
    await flushWaitUntil(ctx);
    const forwarded = vi
      .mocked(env.CONTROL_PLANE.fetch)
      .mock.calls.find(([url]) => url === "https://internal/internal/github-event");
    expect(JSON.parse(String(forwarded?.[1]?.body)).triggerKey).toBe(
      "pr:42:ready_for_review:abc123:delivery-ready-1"
    );
  });

  it("returns 401 for invalid signature", async () => {
    const body = '{"action":"created"}';
    const res = await app.fetch(
      new Request("http://localhost/webhooks/github", {
        method: "POST",
        body,
        headers: {
          "X-Hub-Signature-256": "sha256=invalid",
          "X-GitHub-Event": "issue_comment",
        },
      }),
      makeEnv(),
      makeCtx()
    );
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json).toEqual({ error: "invalid signature" });
  });

  it("returns 401 for missing signature", async () => {
    const res = await app.fetch(
      new Request("http://localhost/webhooks/github", {
        method: "POST",
        body: "{}",
        headers: { "X-GitHub-Event": "push" },
      }),
      makeEnv(),
      makeCtx()
    );
    expect(res.status).toBe(401);
  });

  it("returns 200 and calls waitUntil for valid webhook", async () => {
    const body = JSON.stringify({
      action: "review_requested",
      repository: { id: 99, owner: { login: "test" }, name: "repo" },
    });
    const signature = await sign(SECRET, body);
    const ctx = makeCtx();

    const res = await app.fetch(
      new Request("http://localhost/webhooks/github", {
        method: "POST",
        body,
        headers: {
          "X-Hub-Signature-256": signature,
          "X-GitHub-Event": "pull_request",
          "X-GitHub-Delivery": "delivery-123",
        },
      }),
      makeEnv(),
      ctx
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(ctx.waitUntil).toHaveBeenCalledOnce();
    await flushWaitUntil(ctx);
  });

  it("keeps reaction work in the root Worker lifecycle task", async () => {
    let finishReaction!: (ok: boolean) => void;
    vi.mocked(postReaction).mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        finishReaction = resolve;
      })
    );
    const body = JSON.stringify({
      action: "review_requested",
      pull_request: {
        number: 42,
        title: "Bound GitHub requests",
        body: null,
        user: { login: "alice" },
        head: { ref: "feature/timeouts", sha: "abc123" },
        base: { ref: "main" },
      },
      requested_reviewer: { login: "test-bot[bot]" },
      repository: { id: 99, owner: { login: "test" }, name: "repo", private: false },
      sender: {
        login: "alice",
        id: 1001,
        avatar_url: "https://avatars.githubusercontent.com/u/1001",
      },
    });
    const signature = await sign(SECRET, body);
    const ctx = makeCtx();
    const env = makeEnv();
    const controlPlaneFetch = vi.mocked(env.CONTROL_PLANE.fetch);
    controlPlaneFetch.mockImplementation(async (url) => {
      const requestUrl = String(url);
      if (requestUrl.includes("/integration-settings/github/resolved/")) {
        return new Response(JSON.stringify({ config: null }));
      }
      if (requestUrl.startsWith("https://internal/github/route?")) {
        return Response.json({ teamId: null, via: "workspace" });
      }
      if (requestUrl.endsWith("/metadata")) {
        return new Response(JSON.stringify({ repo: "test/repo", metadata: null }));
      }
      if (requestUrl === "https://internal/sessions") {
        return new Response(JSON.stringify({ sessionId: "session-123", status: "created" }));
      }
      if (requestUrl.endsWith("/prompt")) {
        return new Response(JSON.stringify({ messageId: "message-123" }));
      }
      return new Response(null, { status: 204 });
    });

    const res = await app.fetch(
      new Request("http://localhost/webhooks/github", {
        method: "POST",
        body,
        headers: {
          "X-Hub-Signature-256": signature,
          "X-GitHub-Event": "pull_request",
          "X-GitHub-Delivery": "delivery-reaction",
        },
      }),
      env,
      ctx
    );

    expect(res.status).toBe(200);
    expect(ctx.waitUntil).toHaveBeenCalledOnce();
    const rootTask = ctx.waitUntil.mock.calls[0][0] as Promise<void>;
    let rootSettled = false;
    void rootTask.finally(() => {
      rootSettled = true;
    });
    await vi.waitFor(() =>
      expect(controlPlaneFetch).toHaveBeenCalledWith(
        "https://internal/sessions/session-123/prompt",
        expect.any(Object)
      )
    );
    expect(rootSettled).toBe(false);

    finishReaction(true);
    await rootTask;
    expect(rootSettled).toBe(true);
  });

  it("deduplicates repeated deliveries by X-GitHub-Delivery", async () => {
    const body = JSON.stringify({
      action: "review_requested",
      repository: { id: 99, owner: { login: "test" }, name: "repo" },
    });
    const signature = await sign(SECRET, body);
    const ctx = makeCtx();
    const env = makeEnv();

    const request = () =>
      new Request("http://localhost/webhooks/github", {
        method: "POST",
        body,
        headers: {
          "X-Hub-Signature-256": signature,
          "X-GitHub-Event": "pull_request",
          "X-GitHub-Delivery": "delivery-123",
        },
      });

    const firstRes = await app.fetch(request(), env, ctx);
    expect(firstRes.status).toBe(200);
    expect(await firstRes.json()).toEqual({ ok: true });
    await flushWaitUntil(ctx, 0);

    const secondRes = await app.fetch(request(), env, ctx);
    expect(secondRes.status).toBe(200);
    expect(await secondRes.json()).toEqual({ ok: true });

    expect(ctx.waitUntil).toHaveBeenCalledTimes(2);
    expect(deliveryStatus(env, "delivery-123")).toBe("processed");
    expect(env.CONTROL_PLANE.fetch).not.toHaveBeenCalled();
  });

  it("atomically admits only one of two concurrent deliveries", async () => {
    const body = JSON.stringify({
      action: "created",
      issue: {
        number: 42,
        title: "Fix concurrency",
        pull_request: { url: "https://api.github.com/repos/test/repo/pulls/42" },
      },
      comment: { id: 7788, body: "Fix this", user: { login: "alice" } },
      repository: { id: 99, name: "repo", private: false, owner: { login: "test" } },
      sender: { id: 7, login: "alice", type: "User", avatar_url: "https://example.com/alice.png" },
    });
    const signature = await sign(SECRET, body);
    const request = () =>
      new Request("http://localhost/webhooks/github", {
        method: "POST",
        body,
        headers: {
          "X-Hub-Signature-256": signature,
          "X-GitHub-Event": "issue_comment",
          "X-GitHub-Delivery": "concurrent-7788",
        },
      });
    const env = makeEnv();
    const ctx = makeCtx();
    let unblockQueue!: () => void;
    const queueBlocked = new Promise<void>((resolve) => {
      unblockQueue = resolve;
    });
    vi.mocked(env.AUTOFIX_QUEUE.send).mockImplementation(async () => queueBlocked);

    const firstResponse = app.fetch(request(), env, ctx);
    await vi.waitFor(() => expect(env.AUTOFIX_QUEUE.send).toHaveBeenCalledOnce());
    const secondResponse = app.fetch(request(), env, ctx);
    const second = await secondResponse;
    expect(await second.json()).toEqual({ ok: true });
    expect(deliveryStatus(env, "concurrent-7788")).toBe("processing");
    unblockQueue();
    expect((await firstResponse).status).toBe(200);
    await flushWaitUntil(ctx);
    expect(deliveryStatus(env, "concurrent-7788")).toBe("processed");
    expect(env.AUTOFIX_QUEUE.send).toHaveBeenCalledOnce();
    await flushWaitUntil(ctx, 1);
    expect(ctx.waitUntil).toHaveBeenCalledTimes(2);
  });

  it("fences stale claim completion after a processing lease expires", async () => {
    const env = makeEnv();
    const db = env.DB as unknown as ReturnType<typeof createMockDeliveryDB>;
    expect(await claimDelivery(env, "recoverable", "old")).toBe(true);
    db.rows.get("recoverable")!.expiresAt = Date.now() - 1;
    expect(await claimDelivery(env, "recoverable", "new")).toBe(true);
    await releaseDelivery(env, "recoverable", "old");
    await expect(finalizeDelivery(env, "recoverable", "old")).rejects.toThrow("ownership lost");
    expect(deliveryStatus(env, "recoverable")).toBe("processing");
    await finalizeDelivery(env, "recoverable", "new");
    expect(deliveryStatus(env, "recoverable")).toBe("processed");
  });

  it("prunes expired claims while preserving active deliveries", async () => {
    const env = makeEnv();
    const db = env.DB as unknown as ReturnType<typeof createMockDeliveryDB>;
    await claimDelivery(env, "stale", "one");
    db.rows.get("stale")!.expiresAt = Date.now() - 1;
    await claimDelivery(env, "active", "two");

    await pruneExpiredDeliveries(env);
    expect(deliveryStatus(env, "stale")).toBeNull();
    expect(deliveryStatus(env, "active")).toBe("processing");
  });

  it("rejects malformed JSON without claiming the delivery", async () => {
    const body = "{";
    const env = makeEnv();
    const response = await app.fetch(
      new Request("http://localhost/webhooks/github", {
        method: "POST",
        body,
        headers: {
          "X-Hub-Signature-256": await sign(SECRET, body),
          "X-GitHub-Event": "issue_comment",
          "X-GitHub-Delivery": "invalid-json",
        },
      }),
      env,
      makeCtx()
    );
    expect(response.status).toBe(400);
    expect(deliveryStatus(env, "invalid-json")).toBeNull();
    expect(env.DB.prepare).not.toHaveBeenCalled();
  });

  it.each([undefined, "99", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects a session-triggering webhook with repository id %s before dispatch",
    async (repositoryId) => {
      const body = JSON.stringify({
        action: "review_requested",
        pull_request: {
          number: 42,
          title: "Requires stable repository identity",
          body: null,
          user: { login: "alice" },
          head: { ref: "feature/test", sha: "abc123" },
          base: { ref: "main" },
        },
        requested_reviewer: { login: "test-bot[bot]" },
        repository: { id: repositoryId, owner: { login: "test" }, name: "repo", private: false },
        sender: { login: "alice", id: 1001 },
      });
      const signature = await sign(SECRET, body);
      const ctx = makeCtx();
      const env = makeEnv();
      const request = () =>
        new Request("http://localhost/webhooks/github", {
          method: "POST",
          body,
          headers: {
            "X-Hub-Signature-256": signature,
            "X-GitHub-Event": "pull_request",
            "X-GitHub-Delivery": "delivery-invalid-repository-id",
          },
        });

      expect((await app.fetch(request(), env, ctx)).status).toBe(200);
      await flushWaitUntil(ctx);
      const cpFetch = vi.mocked(env.CONTROL_PLANE.fetch);
      expect(
        cpFetch.mock.calls.some(([url]) => String(url).startsWith("https://internal/github/route?"))
      ).toBe(false);
      expect(cpFetch.mock.calls.some(([url]) => String(url) === "https://internal/sessions")).toBe(
        false
      );
      expect(deliveryStatus(env, "delivery-invalid-repository-id")).toBeNull();
    }
  );

  it.each([
    { status: 403, code: "not_member" },
    { status: 409, code: "target_team_missing_grant" },
    { status: 409, code: "team_archived" },
  ])(
    "allows redelivery after a failed $code refusal comment clears the marker",
    async ({ status, code }) => {
      vi.mocked(postIssueComment).mockResolvedValueOnce(false);
      const body = JSON.stringify({
        action: "review_requested",
        pull_request: {
          number: 42,
          title: "Refused session",
          body: null,
          user: { login: "alice" },
          head: { ref: "feature/test", sha: "abc123" },
          base: { ref: "main" },
        },
        requested_reviewer: { login: "test-bot[bot]" },
        repository: { id: 99, owner: { login: "test" }, name: "repo", private: false },
        sender: { login: "alice", id: 1001, avatar_url: "https://example.com/alice.png" },
      });
      const signature = await sign(SECRET, body);
      const ctx = makeCtx();
      const env = makeEnv();
      const cpFetch = vi.mocked(env.CONTROL_PLANE.fetch);
      cpFetch.mockImplementation(async (url) => {
        const requestUrl = String(url);
        if (requestUrl.includes("/integration-settings/github/resolved/")) {
          return Response.json({ config: null });
        }
        if (requestUrl.startsWith("https://internal/github/route?")) {
          return Response.json({ teamId: "team_pr", via: "pull_request_session" });
        }
        if (requestUrl.endsWith("/metadata")) {
          return Response.json({ repo: "test/repo", metadata: null });
        }
        if (requestUrl === "https://internal/sessions") {
          return Response.json({ code, repository: "test/secondary" }, { status });
        }
        return new Response(null, { status: 204 });
      });
      const request = () =>
        new Request("http://localhost/webhooks/github", {
          method: "POST",
          body,
          headers: {
            "X-Hub-Signature-256": signature,
            "X-GitHub-Event": "pull_request",
            "X-GitHub-Delivery": "delivery-refusal-comment",
          },
        });

      const firstRes = await app.fetch(request(), env, ctx);
      expect(await firstRes.json()).toEqual({ ok: true });
      await flushWaitUntil(ctx, 0);

      expect(deliveryStatus(env, "delivery-refusal-comment")).toBeNull();
      expect(await env.GITHUB_KV.get("delivery-dispatch:delivery-refusal-comment")).toBeNull();
      expect(
        cpFetch.mock.calls.filter(([url]) => String(url) === "https://internal/sessions")
      ).toHaveLength(1);
      expect(cpFetch.mock.calls.some(([url]) => String(url).endsWith("/prompt"))).toBe(false);

      const secondRes = await app.fetch(request(), env, ctx);
      expect(await secondRes.json()).toEqual({ ok: true });
      await flushWaitUntil(ctx, 1);

      expect(ctx.waitUntil).toHaveBeenCalledTimes(2);
      expect(
        cpFetch.mock.calls.filter(([url]) => String(url) === "https://internal/sessions")
      ).toHaveLength(2);
      expect(cpFetch.mock.calls.some(([url]) => String(url).endsWith("/prompt"))).toBe(false);
      expect(deliveryStatus(env, "delivery-refusal-comment")).toBe("processed");
      expect(await env.GITHUB_KV.get("delivery-dispatch:delivery-refusal-comment")).toBe(
        "processed"
      );

      const duplicateRes = await app.fetch(request(), env, ctx);
      expect(await duplicateRes.json()).toEqual({ ok: true });
      await flushWaitUntil(ctx, 2);
      expect(ctx.waitUntil).toHaveBeenCalledTimes(3);
    }
  );

  it.each([
    { name: "network failure", respond: () => Promise.reject(new Error("unavailable")) },
    { name: "HTTP outage", respond: () => new Response("unavailable", { status: 503 }) },
    { name: "invalid JSON", respond: () => new Response("truncated JSON") },
    { name: "invalid contract", respond: () => Response.json({ teamId: null }) },
    { name: "missing team", respond: () => Response.json({ via: "workspace" }) },
    {
      name: "invalid team",
      respond: () => Response.json({ teamId: 123, via: "sender_membership" }),
    },
    {
      name: "empty PR team",
      respond: () => Response.json({ teamId: "", via: "pull_request_session" }),
    },
    {
      name: "null sender team",
      respond: () => Response.json({ teamId: null, via: "sender_membership" }),
    },
    {
      name: "empty sender team",
      respond: () => Response.json({ teamId: "", via: "sender_membership" }),
    },
    {
      name: "non-null workspace team",
      respond: () => Response.json({ teamId: "team_pr", via: "workspace" }),
    },
    { name: "invalid via", respond: () => Response.json({ teamId: null, via: "unknown" }) },
  ])(
    "permits redelivery after a routing $name even when forwarding also fails",
    async ({ respond }) => {
      const body = JSON.stringify({
        action: "created",
        issue: {
          number: 42,
          title: "Retry routing",
          pull_request: { url: "https://api.github.com/repos/test/repo/pulls/42" },
        },
        comment: { id: 123, body: "@test-bot[bot] fix this", user: { login: "alice" } },
        repository: { id: 99, owner: { login: "test" }, name: "repo", private: false },
        sender: { login: "alice", id: 1001, avatar_url: "https://example.com/alice.png" },
      });
      const signature = await sign(SECRET, body);
      const ctx = makeCtx();
      const env = makeEnv();
      const cpFetch = vi.mocked(env.CONTROL_PLANE.fetch);
      let routingFailed = false;
      let forwardingFailed = false;
      cpFetch.mockImplementation(async (url) => {
        const requestUrl = String(url);
        if (requestUrl.includes("/integration-settings/github/resolved/")) {
          return Response.json({ config: null });
        }
        if (requestUrl.startsWith("https://internal/github/route?")) {
          if (!routingFailed) {
            routingFailed = true;
            return respond();
          }
          return Response.json({ teamId: "team_pr", via: "pull_request_session" });
        }
        if (requestUrl.endsWith("/metadata")) {
          return Response.json({ repo: "test/repo", metadata: null });
        }
        if (requestUrl === "https://internal/sessions") {
          return Response.json({ sessionId: "session-123", status: "created" });
        }
        if (requestUrl.endsWith("/prompt")) return Response.json({ messageId: "message-123" });
        if (requestUrl.endsWith("/github-event") && !forwardingFailed) {
          forwardingFailed = true;
          return new Response("admission exhausted", { status: 502 });
        }
        return new Response(null, { status: 204 });
      });
      const request = () =>
        new Request("http://localhost/webhooks/github", {
          method: "POST",
          body,
          headers: {
            "X-Hub-Signature-256": signature,
            "X-GitHub-Event": "issue_comment",
            "X-GitHub-Delivery": "delivery-routing-retry",
          },
        });

      expect(await (await app.fetch(request(), env, ctx)).json()).toEqual({ ok: true });
      await flushWaitUntil(ctx, 0);
      expect(deliveryStatus(env, "delivery-routing-retry")).toBeNull();
      expect(await env.GITHUB_KV.get("delivery-dispatch:delivery-routing-retry")).toBeNull();
      expect(
        cpFetch.mock.calls.filter(([url]) => String(url).endsWith("/github-event"))
      ).toHaveLength(1);
      expect(cpFetch.mock.calls.some(([url]) => String(url) === "https://internal/sessions")).toBe(
        false
      );

      expect(await (await app.fetch(request(), env, ctx)).json()).toEqual({ ok: true });
      await flushWaitUntil(ctx, 1);
      expect(deliveryStatus(env, "delivery-routing-retry")).toBe("processed");
      expect(
        cpFetch.mock.calls.filter(([url]) => String(url) === "https://internal/sessions")
      ).toHaveLength(1);
      expect(cpFetch.mock.calls.filter(([url]) => String(url).endsWith("/prompt"))).toHaveLength(1);
      expect(
        cpFetch.mock.calls.filter(([url]) => String(url).endsWith("/github-event"))
      ).toHaveLength(2);
      expect(await (await app.fetch(request(), env, ctx)).json()).toEqual({
        ok: true,
      });
      await flushWaitUntil(ctx, 2);
      expect(ctx.waitUntil).toHaveBeenCalledTimes(3);
    }
  );

  it("checkpoints an inline flag rejection so redelivery does not comment twice", async () => {
    const commentsBefore = vi.mocked(postIssueComment).mock.calls.length;
    const body = JSON.stringify({
      action: "created",
      issue: {
        number: 42,
        title: "Inline flags",
        pull_request: { url: "https://api.github.com/repos/test/repo/pulls/42" },
      },
      comment: {
        id: 123,
        body: "@test-bot[bot] !reasoning bogus fix this",
        user: { login: "alice" },
      },
      repository: { id: 99, owner: { login: "test" }, name: "repo", private: false },
      sender: { login: "alice", id: 1001, avatar_url: "https://example.com/alice.png" },
    });
    const signature = await sign(SECRET, body);
    const ctx = makeCtx();
    const env = makeEnv();
    const cpFetch = vi.mocked(env.CONTROL_PLANE.fetch);
    cpFetch.mockImplementation(async (url) =>
      String(url).includes("/integration-settings/github/resolved/")
        ? Response.json({ config: null })
        : new Response(null, { status: 204 })
    );

    const res = await app.fetch(
      new Request("http://localhost/webhooks/github", {
        method: "POST",
        body,
        headers: {
          "X-Hub-Signature-256": signature,
          "X-GitHub-Event": "issue_comment",
          "X-GitHub-Delivery": "delivery-inline-flags",
        },
      }),
      env,
      ctx
    );
    expect(await res.json()).toEqual({ ok: true });
    await flushWaitUntil(ctx, 0);

    expect(postIssueComment).toHaveBeenCalledTimes(commentsBefore + 1);
    expect(vi.mocked(postIssueComment).mock.calls.at(-1)?.[2]).toContain(
      "Reasoning effort `bogus` is not valid"
    );
    expect(cpFetch.mock.calls.some(([url]) => String(url) === "https://internal/sessions")).toBe(
      false
    );
    expect(await env.GITHUB_KV.get("delivery-dispatch:delivery-inline-flags")).toBe("processed");
  });

  it.each(["failed response", "network failure"])(
    "retries a compatibility refusal after a comment posting %s",
    async (failure) => {
      const commentsBefore = vi.mocked(postIssueComment).mock.calls.length;
      if (failure === "failed response") {
        vi.mocked(postIssueComment).mockResolvedValueOnce(false);
      } else {
        vi.mocked(postIssueComment).mockRejectedValueOnce(new Error("unavailable"));
      }
      const body = JSON.stringify({
        action: "created",
        issue: {
          number: 42,
          title: "Retry refusal",
          pull_request: { url: "https://api.github.com/repos/test/repo/pulls/42" },
        },
        comment: { id: 123, body: "@test-bot[bot] fix this", user: { login: "alice" } },
        repository: { id: 99, owner: { login: "test" }, name: "repo", private: false },
        sender: { login: "alice", id: 1001, avatar_url: "https://example.com/alice.png" },
      });
      const signature = await sign(SECRET, body);
      const env = makeEnv();
      const ctx = makeCtx();
      env.DEFAULT_MODEL = "gpt-6-sol";
      const cpFetch = vi.mocked(env.CONTROL_PLANE.fetch);
      cpFetch.mockImplementation(async (url) => {
        if (String(url).includes("/integration-settings/github/resolved/")) {
          return Response.json({
            config: {
              model: null,
              harness: "claude",
              reasoningEffort: null,
              autoReviewOnOpen: true,
              enabledRepos: null,
              allowedTriggerUsers: null,
              codeReviewInstructions: null,
              commentActionInstructions: null,
            },
          });
        }
        return new Response(null, { status: 204 });
      });
      const request = () =>
        new Request("http://localhost/webhooks/github", {
          method: "POST",
          body,
          headers: {
            "X-Hub-Signature-256": signature,
            "X-GitHub-Event": "issue_comment",
            "X-GitHub-Delivery": "delivery-refusal-retry",
          },
        });

      expect(await (await app.fetch(request(), env, ctx)).json()).toEqual({ ok: true });
      await flushWaitUntil(ctx, 0);
      expect(deliveryStatus(env, "delivery-refusal-retry")).toBeNull();
      expect(await env.GITHUB_KV.get("delivery-dispatch:delivery-refusal-retry")).toBeNull();
      expect(postIssueComment).toHaveBeenCalledTimes(commentsBefore + 1);
      expect(
        cpFetch.mock.calls.filter(([url]) => String(url).endsWith("/github-event"))
      ).toHaveLength(1);

      expect(await (await app.fetch(request(), env, ctx)).json()).toEqual({ ok: true });
      await flushWaitUntil(ctx, 1);
      expect(postIssueComment).toHaveBeenCalledTimes(commentsBefore + 2);
      expect(vi.mocked(postIssueComment).mock.calls.at(-1)?.[2]).toContain(
        'Model "openai/gpt-6-sol" cannot run on the Claude Agent harness.'
      );
      expect(cpFetch.mock.calls.some(([url]) => String(url).includes("/sessions"))).toBe(false);
      expect(await env.GITHUB_KV.get("delivery-dispatch:delivery-refusal-retry")).toBe("processed");
      expect(deliveryStatus(env, "delivery-refusal-retry")).toBe("processed");
      expect(await (await app.fetch(request(), env, ctx)).json()).toEqual({
        ok: true,
      });
      await flushWaitUntil(ctx, 2);
      expect(postIssueComment).toHaveBeenCalledTimes(commentsBefore + 2);
    }
  );

  describe.each([
    "terminal skip",
    "success",
    "not_member",
    "target_team_missing_grant",
    "team_archived",
    "harness_model_incompatible",
    "config failure",
    "permission API error",
  ])("forwarding after builtin %s", (builtin) => {
    it.each([
      { name: "network failure", respond: () => Promise.reject(new Error("unavailable")) },
      {
        name: "admission exhaustion 502",
        respond: () => new Response("exhausted", { status: 502 }),
      },
      { name: "HTTP outage 503", respond: () => new Response("unavailable", { status: 503 }) },
    ])("retries $name without repeating completed external effects", async ({ respond }) => {
      const compatibilityRefusal = builtin === "harness_model_incompatible";
      const isRefusal =
        builtin === "not_member" ||
        builtin === "target_team_missing_grant" ||
        builtin === "team_archived" ||
        compatibilityRefusal;
      const checkpointed = builtin === "success" || isRefusal;
      const recovers = builtin === "config failure" || builtin === "permission API error";
      const refusalCommentsBefore = vi.mocked(postIssueComment).mock.calls.length;
      if (builtin === "permission API error") {
        vi.mocked(checkSenderPermission).mockResolvedValueOnce({
          hasPermission: false,
          error: true,
        });
      }
      const body = JSON.stringify({
        action: "created",
        issue: {
          number: 42,
          title: "Retry forwarding",
          pull_request: { url: "https://api.github.com/repos/test/repo/pulls/42" },
        },
        comment: { id: 123, body: "@test-bot[bot] fix this", user: { login: "alice" } },
        repository: { id: 99, owner: { login: "test" }, name: "repo", private: false },
        sender: { login: "alice", id: 1001, avatar_url: "https://example.com/alice.png" },
      });
      const signature = await sign(SECRET, body);
      const ctx = makeCtx();
      const env = makeEnv();
      const cpFetch = vi.mocked(env.CONTROL_PLANE.fetch);
      let forwardFailed = false;
      cpFetch.mockImplementation(async (url) => {
        const requestUrl = String(url);
        if (requestUrl.includes("/integration-settings/github/resolved/")) {
          if (builtin === "config failure" && !forwardFailed) {
            return new Response("config unavailable", { status: 503 });
          }
          if (builtin === "terminal skip" || compatibilityRefusal) {
            return Response.json({
              config: {
                model: compatibilityRefusal ? "gpt-6-sol" : null,
                harness: compatibilityRefusal ? "claude" : "opencode",
                reasoningEffort: null,
                autoReviewOnOpen: true,
                enabledRepos: compatibilityRefusal ? null : [],
                allowedTriggerUsers: null,
                codeReviewInstructions: null,
                commentActionInstructions: null,
              },
            });
          }
          return Response.json({ config: null });
        }
        if (requestUrl.startsWith("https://internal/github/route?")) {
          return Response.json({ teamId: "team_pr", via: "pull_request_session" });
        }
        if (requestUrl.endsWith("/metadata")) return Response.json({ metadata: null });
        if (requestUrl === "https://internal/sessions") {
          if (isRefusal && !compatibilityRefusal) {
            return Response.json(
              { code: builtin },
              { status: builtin === "not_member" ? 403 : 409 }
            );
          }
          return Response.json({ sessionId: "session-123", status: "created" });
        }
        if (requestUrl.endsWith("/prompt")) return Response.json({ messageId: "message-123" });
        if (requestUrl.endsWith("/github-event") && !forwardFailed) {
          forwardFailed = true;
          return respond();
        }
        return new Response(null, { status: 204 });
      });
      const request = () =>
        new Request("http://localhost/webhooks/github", {
          method: "POST",
          body,
          headers: {
            "X-Hub-Signature-256": signature,
            "X-GitHub-Event": "issue_comment",
            "X-GitHub-Delivery": "delivery-forward-retry",
          },
        });

      expect(await (await app.fetch(request(), env, ctx)).json()).toEqual({ ok: true });
      await flushWaitUntil(ctx, 0);
      expect(deliveryStatus(env, "delivery-forward-retry")).toBeNull();
      expect(await env.GITHUB_KV.get("delivery-dispatch:delivery-forward-retry")).toBe(
        checkpointed ? "processed" : null
      );
      if (checkpointed) {
        expect(env.GITHUB_KV.put).toHaveBeenCalledWith(
          "delivery-dispatch:delivery-forward-retry",
          "processed",
          { expirationTtl: 2678400 }
        );
      } else {
        expect(env.GITHUB_KV.put).not.toHaveBeenCalledWith(
          "delivery-dispatch:delivery-forward-retry",
          expect.anything(),
          expect.anything()
        );
      }
      expect(
        cpFetch.mock.calls.filter(([url]) => String(url) === "https://internal/sessions")
      ).toHaveLength(checkpointed && !compatibilityRefusal ? 1 : 0);
      expect(cpFetch.mock.calls.filter(([url]) => String(url).endsWith("/prompt"))).toHaveLength(
        builtin === "success" ? 1 : 0
      );

      expect(await (await app.fetch(request(), env, ctx)).json()).toEqual({ ok: true });
      await flushWaitUntil(ctx, 1);
      expect(cpFetch.mock.calls.filter(([url]) => String(url).includes("/resolved/"))).toHaveLength(
        checkpointed ? 1 : 2
      );
      expect(
        cpFetch.mock.calls.filter(([url]) => String(url) === "https://internal/sessions")
      ).toHaveLength(builtin === "terminal skip" || compatibilityRefusal ? 0 : 1);
      expect(cpFetch.mock.calls.filter(([url]) => String(url).endsWith("/prompt"))).toHaveLength(
        builtin === "success" || recovers ? 1 : 0
      );
      expect(postIssueComment).toHaveBeenCalledTimes(refusalCommentsBefore + (isRefusal ? 1 : 0));
      if (compatibilityRefusal) {
        expect(vi.mocked(postIssueComment).mock.calls.at(-1)?.[2]).toContain(
          'Model "openai/gpt-6-sol" cannot run on the Claude Agent harness.'
        );
      }
      expect(await env.GITHUB_KV.get("delivery-dispatch:delivery-forward-retry")).toBe(
        builtin === "terminal skip" ? null : "processed"
      );
      expect(
        cpFetch.mock.calls.filter(([url]) => String(url).endsWith("/github-event"))
      ).toHaveLength(2);
      expect(deliveryStatus(env, "delivery-forward-retry")).toBe("processed");
      expect(await (await app.fetch(request(), env, ctx)).json()).toEqual({
        ok: true,
      });
      await flushWaitUntil(ctx, 2);
      expect(ctx.waitUntil).toHaveBeenCalledTimes(3);
      expect(
        cpFetch.mock.calls.filter(([url]) => String(url).endsWith("/github-event"))
      ).toHaveLength(2);
    });
  });

  it("allows redelivery after async processing failure clears the marker", async () => {
    const body = JSON.stringify({
      action: "opened",
      pull_request: {
        number: 42,
        title: "Broken payload",
        body: null,
        user: { login: "alice" },
        head: { ref: "feature/test", sha: "abc123" },
        base: { ref: "main" },
        draft: false,
      },
      repository: { id: 99, owner: { login: "test" }, name: "repo" },
      sender: { login: "alice" },
    });
    const signature = await sign(SECRET, body);
    const ctx = makeCtx();
    const env = makeEnv();

    const request = () =>
      new Request("http://localhost/webhooks/github", {
        method: "POST",
        body,
        headers: {
          "X-Hub-Signature-256": signature,
          "X-GitHub-Event": "pull_request",
          "X-GitHub-Delivery": "delivery-failure",
        },
      });

    const firstRes = await app.fetch(request(), env, ctx);
    expect(firstRes.status).toBe(200);
    expect(await firstRes.json()).toEqual({ ok: true });
    await flushWaitUntil(ctx, 0);

    const secondRes = await app.fetch(request(), env, ctx);
    expect(secondRes.status).toBe(200);
    expect(await secondRes.json()).toEqual({ ok: true });
    await flushWaitUntil(ctx, 1);

    expect(ctx.waitUntil).toHaveBeenCalledTimes(2);
    const controlPlaneFetch = (env.CONTROL_PLANE as unknown as { fetch: ReturnType<typeof vi.fn> })
      .fetch;
    expect(controlPlaneFetch).toHaveBeenCalledTimes(2);
    for (const [url, init] of controlPlaneFetch.mock.calls) {
      expect(url).toBe("https://internal/internal/github-event");
      expect(JSON.parse(init.body as string)).toMatchObject({
        eventType: "pull_request.opened",
        repoOwner: "test",
        repoName: "repo",
        pullRequest: { number: 42 },
      });
    }
    expect(deliveryStatus(env, "delivery-failure")).toBeNull();
  });

  it("returns 200 for unhandled event type", async () => {
    const body = '{"action":"opened"}';
    const signature = await sign(SECRET, body);
    const ctx = makeCtx();

    const res = await app.fetch(
      new Request("http://localhost/webhooks/github", {
        method: "POST",
        body,
        headers: {
          "X-Hub-Signature-256": signature,
          "X-GitHub-Event": "push",
        },
      }),
      makeEnv(),
      ctx
    );

    expect(res.status).toBe(200);
    expect(ctx.waitUntil).toHaveBeenCalledOnce();
    await flushWaitUntil(ctx);
  });

  it("forwards closed pull request lifecycle fields to the control plane", async () => {
    const body = JSON.stringify({
      action: "closed",
      repository: { id: 99, owner: { login: "test" }, name: "repo" },
      sender: { login: "alice" },
      pull_request: {
        number: 42,
        title: "Ship lifecycle updates",
        body: null,
        state: "closed",
        draft: false,
        merged: true,
        html_url: "https://github.com/test/repo/pull/42",
        created_at: "2026-07-10T10:00:00Z",
        updated_at: "2026-07-14T11:00:00Z",
        merged_at: "2026-07-14T10:59:00Z",
        closed_at: "2026-07-14T11:00:00Z",
        user: { login: "alice" },
        labels: [{ name: "ready" }],
        head: { ref: "feature/lifecycle", sha: "abc123", repo: { id: 99 } },
        base: { ref: "main", repo: { id: 99 } },
      },
    });
    const signature = await sign(SECRET, body);
    const ctx = makeCtx();
    const env = makeEnv();

    const res = await app.fetch(
      new Request("http://localhost/webhooks/github", {
        method: "POST",
        body,
        headers: {
          "X-Hub-Signature-256": signature,
          "X-GitHub-Event": "pull_request",
        },
      }),
      env,
      ctx
    );

    expect(res.status).toBe(200);
    expect(ctx.waitUntil).toHaveBeenCalledOnce();
    await flushWaitUntil(ctx);

    const controlPlaneFetch = (env.CONTROL_PLANE as unknown as { fetch: ReturnType<typeof vi.fn> })
      .fetch;
    expect(controlPlaneFetch).toHaveBeenCalledOnce();
    const [url, init] = controlPlaneFetch.mock.calls[0];
    expect(url).toBe("https://internal/internal/github-event");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toMatchObject({
      eventType: "pull_request.closed",
      repoOwner: "test",
      repoName: "repo",
      branch: "feature/lifecycle",
      targetBranch: "main",
      labels: ["ready"],
      pullRequest: {
        number: 42,
        state: "closed",
        draft: false,
        merged: true,
        headSha: "abc123",
        isCrossRepository: false,
        url: "https://github.com/test/repo/pull/42",
        repositoryExternalId: "99",
        providerCreatedAt: Date.parse("2026-07-10T10:00:00Z"),
        providerUpdatedAt: Date.parse("2026-07-14T11:00:00Z"),
        mergedAt: Date.parse("2026-07-14T10:59:00Z"),
        closedAt: Date.parse("2026-07-14T11:00:00Z"),
      },
    });
  });

  it("forwards a completed workflow run", async () => {
    const body = JSON.stringify({
      action: "completed",
      repository: { id: 99, owner: { login: "acme-org" }, name: "my-app" },
      sender: { login: "github-actions[bot]" },
      workflow_run: {
        id: 123456789,
        run_attempt: 1,
        name: "CI",
        conclusion: "failure",
        head_branch: "main",
        head_sha: "abc1234def5678",
        path: ".github/workflows/ci.yml",
        html_url: "https://github.com/acme-org/my-app/actions/runs/123456789",
      },
    });
    const signature = await sign(SECRET, body);
    const ctx = makeCtx();
    const env = makeEnv();

    const response = await app.fetch(
      new Request("http://localhost/webhooks/github", {
        method: "POST",
        body,
        headers: {
          "X-Hub-Signature-256": signature,
          "X-GitHub-Event": "workflow_run",
          "X-GitHub-Delivery": "delivery-workflow-run-123456789",
        },
      }),
      env,
      ctx
    );

    expect(response.status).toBe(200);
    await flushWaitUntil(ctx);

    const controlPlaneFetch = (env.CONTROL_PLANE as unknown as { fetch: ReturnType<typeof vi.fn> })
      .fetch;
    expect(controlPlaneFetch).toHaveBeenCalledOnce();
    const [url, init] = controlPlaneFetch.mock.calls[0];
    expect(url).toBe("https://internal/internal/github-event");
    expect(JSON.parse(init.body as string)).toMatchObject({
      eventType: "workflow_run.completed",
      repoOwner: "acme-org",
      repoName: "my-app",
      workflowName: "CI",
      conclusion: "failure",
      triggerKey: "workflow_run:123456789:1",
    });
  });
});

describe("GET /health", () => {
  it("returns healthy status", async () => {
    const res = await app.fetch(new Request("http://localhost/health"), makeEnv(), makeCtx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "healthy",
      service: "open-inspect-github-bot",
    });
  });
});

describe("GitHub delivery heartbeat fencing", () => {
  it("extends only the current live owner's lease and rejects stale owners", async () => {
    const env = makeEnv();
    expect(await claimDelivery(env, "heartbeat-1", "owner-1")).toBe(true);
    const rows = (env.DB as unknown as ReturnType<typeof createMockDeliveryDB>).rows;
    const before = rows.get("heartbeat-1")!.expiresAt;
    expect(await renewDelivery(env, "heartbeat-1", "stale-owner")).toBe(false);
    expect(rows.get("heartbeat-1")!.expiresAt).toBe(before);
    expect(await renewDelivery(env, "heartbeat-1", "owner-1")).toBe(true);
    expect(rows.get("heartbeat-1")!.expiresAt).toBeGreaterThanOrEqual(before);
    await finalizeDelivery(env, "heartbeat-1", "owner-1");
    expect(await renewDelivery(env, "heartbeat-1", "owner-1")).toBe(false);
    await expect(finalizeDelivery(env, "heartbeat-1", "stale-owner")).rejects.toThrow(
      "ownership lost"
    );
  });
});
