import { describe, expect, it, vi } from "vitest";
import {
  enqueueWebhookPayload,
  resolveWebhookPayload,
  WEBHOOK_QUEUE_INLINE_LIMIT_BYTES,
} from "./webhook-queue";

function harness() {
  const objects = new Map<string, string>();
  const bucket = {
    put: vi.fn(async (key: string, body: string) => {
      objects.set(key, body);
      return { key };
    }),
    get: vi.fn(async (key: string) => {
      const body = objects.get(key);
      return body === undefined ? null : { text: async () => body };
    }),
  };
  const queue = { send: vi.fn(async (_body: unknown) => {}) };
  return { bucket, queue, objects };
}

describe("webhook queue message size boundary", () => {
  it("queues inline at the cutoff and writes oversized UTF-8 messages to R2 first", async () => {
    const h = harness();
    const size = (payload: string) =>
      new TextEncoder().encode(JSON.stringify({ id: "x", payload })).byteLength;
    const exact = "x".repeat(WEBHOOK_QUEUE_INLINE_LIMIT_BYTES - size(""));
    await enqueueWebhookPayload(h.queue, h.bucket, { id: "x" }, exact);
    expect(h.bucket.put).not.toHaveBeenCalled();
    expect(h.queue.send).toHaveBeenCalledWith({ id: "x", payload: exact });

    const large = exact + "😊";
    await enqueueWebhookPayload(h.queue, h.bucket, { id: "x" }, large);
    const ref = h.queue.send.mock.calls.at(-1)?.[0] as { payloadKey: string };
    expect(ref.payloadKey).toMatch(/^webhooks\//);
    expect(h.bucket.put).toHaveBeenCalledOnce();
    expect(await resolveWebhookPayload(h.bucket, ref)).toBe(large);
    expect(size(large)).toBeGreaterThan(WEBHOOK_QUEUE_INLINE_LIMIT_BYTES);
    expect(new TextEncoder().encode(JSON.stringify(ref)).byteLength).toBeLessThan(128_000);
  });

  it("never enqueues after failed R2 persistence", async () => {
    const h = harness();
    h.bucket.put.mockRejectedValueOnce(new Error("R2 unavailable"));
    await expect(
      enqueueWebhookPayload(h.queue, h.bucket, { id: "x" }, "x".repeat(128_000))
    ).rejects.toThrow("R2 unavailable");
    expect(h.queue.send).not.toHaveBeenCalled();
  });

  it("does not acknowledge failed queue sends, and retains the staged payload for retries", async () => {
    const h = harness();
    h.queue.send.mockRejectedValueOnce(new Error("queue unavailable"));
    await expect(
      enqueueWebhookPayload(h.queue, h.bucket, { id: "x" }, "x".repeat(128_000))
    ).rejects.toThrow("queue unavailable");
    expect(h.objects.size).toBe(1);
    expect(h.queue.send).toHaveBeenCalledOnce();
  });

  it("refuses missing staged payloads instead of silently dropping webhook content", async () => {
    const h = harness();
    await expect(resolveWebhookPayload(h.bucket, { payloadKey: "webhooks/lost" })).rejects.toThrow(
      "missing from R2"
    );
  });
});
