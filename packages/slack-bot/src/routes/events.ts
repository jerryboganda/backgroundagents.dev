import { verifySlackSignature } from "@open-inspect/shared/slack";
import { enqueueWebhookPayload } from "@open-inspect/shared/webhook-queue";
import { Hono } from "hono";
import { slackEventPayloadSchema } from "../events/payload";
import { createLogger } from "../logger";
import type { Env } from "../types";

const log = createLogger("handler");
export const eventRoutes = new Hono<{ Bindings: Env }>();

eventRoutes.post("/events", async (c) => {
  const startTime = Date.now();
  const traceId = crypto.randomUUID();
  const body = await c.req.text();
  const isValid = await verifySlackSignature(
    c.req.header("x-slack-signature") ?? null,
    c.req.header("x-slack-request-timestamp") ?? null,
    body,
    c.env.SLACK_SIGNING_SECRET
  );
  if (!isValid) {
    log.warn("http.request", {
      trace_id: traceId,
      http_method: "POST",
      http_path: "/events",
      http_status: 401,
      outcome: "rejected",
      reject_reason: "invalid_signature",
      duration_ms: Date.now() - startTime,
    });
    return c.json({ error: "Invalid signature" }, 401);
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(body);
  } catch {
    return c.json({ error: "Invalid payload" }, 400);
  }
  const parsedPayload = slackEventPayloadSchema.safeParse(parsedJson);
  if (!parsedPayload.success) return c.json({ error: "Invalid payload" }, 400);
  const payload = parsedPayload.data;
  if (payload.type === "url_verification") return c.json({ challenge: payload.challenge });

  const eventId =
    payload.event_id ??
    `body:${await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)).then((value) => Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join(""))}`;
  try {
    await enqueueWebhookPayload(
      c.env.SLACK_EVENTS_QUEUE,
      c.env.WEBHOOK_PAYLOADS,
      { id: eventId },
      payload
    );
  } catch (error) {
    log.error("slack.event.enqueue_failed", { trace_id: traceId, event_id: eventId, error });
    return c.json({ error: "Webhook queue unavailable" }, 503);
  }
  log.info("http.request", {
    trace_id: traceId,
    http_method: "POST",
    http_path: "/events",
    http_status: 200,
    event_id: eventId,
    event_type: payload.event?.type,
    duration_ms: Date.now() - startTime,
  });
  return c.json({ ok: true });
});
