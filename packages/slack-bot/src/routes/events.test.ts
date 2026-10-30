import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SharedSlack from "@open-inspect/shared/slack";
import { makeExecutionContext } from "../test-helpers";
import type { Env } from "../types";

const verify = vi.hoisted(() => vi.fn());
vi.mock("@open-inspect/shared/slack", async (importOriginal) => ({
  ...(await importOriginal<typeof SharedSlack>()),
  verifySlackSignature: verify,
}));
import { eventRoutes } from "./events";

const payload = {
  type: "event_callback",
  event_id: "Ev-1",
  event: { type: "app_home_opened", user: "U123" },
};
const request = (body = JSON.stringify(payload)) =>
  new Request("http://localhost/events", {
    method: "POST",
    body,
    headers: { "x-slack-signature": "v0=test", "x-slack-request-timestamp": "1700000000" },
  });
const env = () => ({ SLACK_EVENTS_QUEUE: { send: vi.fn(async () => {}) } }) as unknown as Env;

describe("POST /events durable intake", () => {
  beforeEach(() => verify.mockReset().mockResolvedValue(true));

  it("returns 200 only after durable queue acceptance", async () => {
    const e = env();
    let accept!: () => void;
    (e.SLACK_EVENTS_QUEUE.send as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          accept = resolve;
        })
    );
    let responded = false;
    const pending = Promise.resolve(eventRoutes.fetch(request(), e, makeExecutionContext())).then(
      () => {
        responded = true;
      }
    );
    await vi.waitFor(() => expect(e.SLACK_EVENTS_QUEUE.send).toHaveBeenCalledOnce());
    expect(responded).toBe(false);
    accept();
    await pending;
    expect(e.SLACK_EVENTS_QUEUE.send).toHaveBeenCalledWith({ id: "Ev-1", payload });
  });

  it("returns retryable 503 when queue acceptance fails", async () => {
    const e = env();
    vi.mocked(e.SLACK_EVENTS_QUEUE.send).mockRejectedValueOnce(new Error("queue offline"));
    const response = await eventRoutes.fetch(request(), e, makeExecutionContext());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Webhook queue unavailable" });
  });

  it("accepts duplicate deliveries so atomic consumer ownership determines execution", async () => {
    const e = env();
    const responses = await Promise.all(
      Array.from({ length: 2 }, () => eventRoutes.fetch(request(), e, makeExecutionContext()))
    );
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(e.SLACK_EVENTS_QUEUE.send).toHaveBeenCalledTimes(2);
  });

  it("preserves validated attachments in queued payload", async () => {
    const e = env();
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "Ev-files",
      event: { type: "message", files: [{ id: "F1", name: "trace.txt", size: 42, ignored: "x" }] },
    });
    expect((await eventRoutes.fetch(request(body), e, makeExecutionContext())).status).toBe(200);
    expect(e.SLACK_EVENTS_QUEUE.send).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          event: expect.objectContaining({ files: [{ id: "F1", name: "trace.txt", size: 42 }] }),
        }),
      })
    );
  });

  it("rejects invalid signatures and malformed payloads before enqueue", async () => {
    const e = env();
    verify.mockResolvedValueOnce(false);
    expect((await eventRoutes.fetch(request(), e, makeExecutionContext())).status).toBe(401);
    expect((await eventRoutes.fetch(request("{"), e, makeExecutionContext())).status).toBe(400);
    expect(
      (
        await eventRoutes.fetch(
          request(JSON.stringify({ event_id: "Ev-1" })),
          e,
          makeExecutionContext()
        )
      ).status
    ).toBe(400);
    expect(e.SLACK_EVENTS_QUEUE.send).not.toHaveBeenCalled();
  });

  it("returns the Slack challenge without publishing to the queue", async () => {
    const e = env();
    const res = await eventRoutes.fetch(
      request(JSON.stringify({ type: "url_verification", challenge: "challenge" })),
      e,
      makeExecutionContext()
    );
    expect(await res.json()).toEqual({ challenge: "challenge" });
    expect(e.SLACK_EVENTS_QUEUE.send).not.toHaveBeenCalled();
  });
});
