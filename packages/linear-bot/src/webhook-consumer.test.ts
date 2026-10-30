import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, AgentSessionWebhook } from "./types";

const handler = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("./webhook-handler", () => ({ handleAgentSessionEvent: handler }));
import { consumeLinearEvents, pruneProcessedLinearDeliveries } from "./webhook-consumer";

const payload = {
  type: "AgentSessionEvent",
  action: "created",
  organizationId: "org",
  appUserId: "user",
  webhookId: "config",
  agentSession: { id: "agent" },
} as AgentSessionWebhook;

function harness() {
  const rows = new Map<
    string,
    { status: string; token: string; time: number; processedAt?: number }
  >();
  const prepare = vi.fn((sql: string) => ({
    bind: (...params: unknown[]) => ({
      run: async () => {
        if (sql.includes("INSERT INTO")) {
          const [id, time, token, before] = params as [string, number, string, number];
          const old = rows.get(id);
          if (old && (old.status === "processed" || old.time >= before))
            return { meta: { changes: 0 } };
          rows.set(id, { status: "processing", token, time });
          return { meta: { changes: 1 } };
        }
        if (sql.includes("UPDATE")) {
          const [time, id, token] = params as [number, string, string];
          const old = rows.get(id);
          if (!old || old.token !== token || old.status !== "processing")
            return { meta: { changes: 0 } };
          if (sql.includes("SET claimed_at_ms")) old.time = time;
          else {
            old.status = "processed";
            old.processedAt = time;
          }
          return { meta: { changes: 1 } };
        }
        if (sql.includes("processed_at_ms")) {
          const cutoff = params[0] as number;
          let deleted = 0;
          for (const [id, row] of rows) {
            if (deleted < 500 && row.status === "processed" && row.processedAt! <= cutoff) {
              rows.delete(id);
              deleted++;
            }
          }
          return { meta: { changes: 1 } };
        }
        const [id, token] = params as string[];
        if (rows.get(id)?.token === token && rows.get(id)?.status === "processing") rows.delete(id);
        return { meta: { changes: 1 } };
      },
      first: async () => {
        const row = rows.get(params[0] as string);
        return row ? { status: row.status } : null;
      },
    }),
  }));
  const env = { WEBHOOK_DB: { prepare } } as unknown as Env;
  function message(id = "delivery") {
    return { body: { id, payload }, ack: vi.fn(), retry: vi.fn(), attempts: 1, id };
  }
  const consume = (messages: ReturnType<typeof message>[]) =>
    consumeLinearEvents({ messages } as unknown as Parameters<typeof consumeLinearEvents>[0], env);
  return { rows, prepare, message, consume, prune: () => pruneProcessedLinearDeliveries(env) };
}

describe("Linear queue ownership", () => {
  beforeEach(() => handler.mockReset().mockResolvedValue(undefined));

  it("marks a delivery processed and acknowledges it", async () => {
    const h = harness();
    const m = h.message();
    await h.consume([m]);
    expect(handler).toHaveBeenCalledOnce();
    expect(h.rows.get("delivery")?.status).toBe("processed");
    expect(h.rows.get("delivery")?.processedAt).toBeGreaterThan(0);
    expect(m.ack).toHaveBeenCalledOnce();
  });

  it("retries failed processing and can recover on a later attempt", async () => {
    const h = harness();
    const first = h.message();
    handler.mockRejectedValueOnce(new Error("transient"));
    await h.consume([first]);
    expect(first.retry).toHaveBeenCalledOnce();
    expect(h.rows.size).toBe(0);
    const next = h.message();
    await h.consume([next]);
    expect(next.ack).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("serializes concurrent duplicate deliveries with atomic claim", async () => {
    const h = harness();
    const first = h.message();
    const duplicate = h.message();
    let release!: () => void;
    handler.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const running = h.consume([first]);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    await h.consume([duplicate]);
    expect(duplicate.retry).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledOnce();
    release();
    await running;
    const later = h.message();
    await h.consume([later]);
    expect(later.ack).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledOnce();
  });

  it("recovers a stale claim after a crash, while fencing stale tokens", async () => {
    const h = harness();
    h.rows.set("delivery", {
      status: "processing",
      token: "dead-worker",
      time: Date.now() - 20 * 60_000,
    });
    const m = h.message();
    await h.consume([m]);
    expect(m.ack).toHaveBeenCalledOnce();
    expect(h.rows.get("delivery")?.status).toBe("processed");
    expect(h.rows.get("delivery")?.token).not.toBe("dead-worker");
  });

  it("prunes processed markers after the queue replay window but preserves live claims", async () => {
    const h = harness();
    const now = Date.now();
    h.rows.set("old", {
      status: "processed",
      token: "one",
      time: now,
      processedAt: now - 32 * 86400_000,
    });
    h.rows.set("fresh", {
      status: "processed",
      token: "two",
      time: now,
      processedAt: now - 6 * 86400_000,
    });
    h.rows.set("active", {
      status: "processing",
      token: "three",
      time: now - 20 * 60_000,
      processedAt: now - 8 * 86400_000,
    });
    await h.prune();
    expect([...h.rows.keys()].sort()).toEqual(["active", "fresh"]);
  });
});
