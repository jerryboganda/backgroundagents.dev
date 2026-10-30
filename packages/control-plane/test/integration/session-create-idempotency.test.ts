import { beforeEach, describe, expect, it } from "vitest";
import { createExecutionContext, env } from "cloudflare:test";
import { cleanD1Tables } from "./cleanup";
import { routeRequest, serviceFetch, serviceRequestHeaders } from "./helpers";
import { runInSessionDO } from "./session-do-access";

const SESSIONS_URL = "https://test.local/sessions";
const KEY = "linear:org-1:issue-1:agent-session-1";

async function createForLinear(idempotencyKey: string, title: string) {
  return serviceFetch(SESSIONS_URL, {
    method: "POST",
    service: "linear-bot",
    actor: "linear:human-user-1",
    body: JSON.stringify({ idempotencyKey, title, model: "anthropic/claude-haiku-4-5" }),
  });
}

describe("Linear session-creation idempotency", () => {
  beforeEach(cleanD1Tables);

  it("reuses the committed session when its successful response was lost before KV mapping", async () => {
    const first = await createForLinear(KEY, "Initial Linear delegation");
    expect(first.status).toBe(201);
    // The caller crashes after control-plane creation and never sees the response.

    const replay = await createForLinear(KEY, "Initial Linear delegation (retry)");
    expect(replay.status).toBe(200);
    const { sessionId } = await replay.json<{ sessionId: string }>();
    const sessions = await env.DB.prepare(
      "SELECT id, title, creation_idempotency_key FROM sessions"
    ).all<{ id: string; title: string; creation_idempotency_key: string }>();
    expect(sessions.results).toEqual([
      {
        id: sessionId,
        title: "Initial Linear delegation",
        creation_idempotency_key: KEY,
      },
    ]);
  });

  it.each(["failed", "created"] as const)(
    "finishes a %s D1 reservation on replay without duplicating session state or work",
    async (reservationStatus) => {
      const title = "Linear init interrupted after D1 insert";
      const body = JSON.stringify({
        idempotencyKey: KEY,
        title,
        model: "anthropic/claude-haiku-4-5",
      });
      const failedNamespace = {
        idFromName: (name: string) => env.SESSION.idFromName(name),
        get: (id: Parameters<typeof env.SESSION.get>[0]) => ({
          fetch: (request: Request) =>
            new URL(request.url).pathname === "/internal/init"
              ? Response.json({ error: "Injected DO init outage" }, { status: 503 })
              : env.SESSION.get(id).fetch(request),
        }),
      } as unknown as DurableObjectNamespace;

      const requestWithUnavailableDO = async () =>
        routeRequest(
          new Request(SESSIONS_URL, {
            method: "POST",
            body,
            headers: await serviceRequestHeaders(SESSIONS_URL, {
              method: "POST",
              body,
              service: "linear-bot",
              actor: "linear:human-user-1",
            }),
          }),
          { ...env, SESSION: failedNamespace },
          createExecutionContext()
        );
      const first = await requestWithUnavailableDO();
      expect(first.status).toBe(500);
      const inserted = await env.DB.prepare(
        "SELECT id, title, status, creation_init_payload FROM sessions WHERE creation_idempotency_key = ?"
      )
        .bind(KEY)
        .first<{
          id: string;
          title: string;
          status: string;
          creation_init_payload: string;
        }>();
      expect(inserted).toMatchObject({ title, status: "failed" });
      expect(JSON.parse(inserted!.creation_init_payload)).toMatchObject({ title });
      if (reservationStatus === "created") {
        // The process can exit after D1 commit, before its failed-status compensation.
        await env.DB.prepare("UPDATE sessions SET status = 'created' WHERE id = ?")
          .bind(inserted!.id)
          .run();
      }
      // A delayed replay must refresh the recovered draft before orphan expiry.
      await env.DB.prepare("UPDATE sessions SET updated_at = 1 WHERE id = ?")
        .bind(inserted!.id)
        .run();
      const stub = env.SESSION.get(env.SESSION.idFromName(inserted!.id));
      expect((await stub.fetch("http://internal/internal/state")).status).toBe(404);
      const unavailableReplay = await requestWithUnavailableDO();
      expect(unavailableReplay.status).toBe(503);
      expect(await unavailableReplay.json()).not.toHaveProperty("sessionId");

      const replay = await createForLinear(KEY, "Ignored new title on retry");
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ sessionId: inserted!.id, status: "created" });
      const state = await stub.fetch("http://internal/internal/state");
      expect(state.status).toBe(200);
      expect(await state.json()).toMatchObject({ title, status: "created" });

      const countDoRows = () =>
        runInSessionDO(
          stub,
          (_instance, doState) =>
            doState.storage.sql
              .exec(
                `SELECT (SELECT COUNT(*) FROM session) AS sessions,
                      (SELECT COUNT(*) FROM participants) AS participants,
                      (SELECT COUNT(*) FROM sandbox) AS sandboxes,
                      (SELECT COUNT(*) FROM messages) AS messages,
                      (SELECT COUNT(*) FROM events) AS events`
              )
              .toArray()[0]
        );
      const counts = await countDoRows();
      expect(counts).toMatchObject({ sessions: 1, participants: 1, sandboxes: 1, messages: 0 });
      const recoveredRows = await env.DB.prepare(
        "SELECT id, title, status, updated_at FROM sessions"
      ).all<{ id: string; title: string; status: string; updated_at: number }>();
      expect(recoveredRows.results).toEqual([
        { id: inserted!.id, title, status: "created", updated_at: expect.any(Number) },
      ]);
      expect(recoveredRows.results[0].updated_at).toBeGreaterThan(1);
      expect((await createForLinear(KEY, "Another retry")).status).toBe(200);
      expect(await countDoRows()).toEqual(counts);
      const rows = await env.DB.prepare("SELECT id, title, status, updated_at FROM sessions").all();
      expect(rows.results).toEqual(recoveredRows.results);
    }
  );

  it("rejects the same durable key for non-Linear services", async () => {
    const response = await serviceFetch(SESSIONS_URL, {
      method: "POST",
      service: "slack-bot",
      actor: "slack:U0123",
      body: JSON.stringify({ idempotencyKey: KEY, title: "Unauthorized key" }),
    });
    expect(response.status).toBe(403);
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM sessions").first<{
      count: number;
    }>();
    expect(count?.count).toBe(0);
  });
});
