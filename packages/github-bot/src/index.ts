/**
 * Open-Inspect GitHub Bot Worker
 *
 * Cloudflare Worker that handles GitHub webhook events and provides
 * automated code review and comment-triggered actions via the coding agent.
 */

import { Hono } from "hono";
import {
  enqueueWebhookPayload,
  resolveWebhookPayload,
  WEBHOOK_REPLAY_RETENTION_MS,
} from "@open-inspect/shared/webhook-queue";
import type { Env, GitHubWebhookMessage } from "./types";
import type { Logger } from "./logger";
import { createLogger, parseLogLevel } from "./logger";
import { verifyWebhookSignature } from "./verify";
import { normalizeGitHubEvent } from "@open-inspect/shared/triggers";
import { signedControlPlaneFetch } from "./internal-auth";
import {
  issueCommentPayloadSchema,
  pullRequestOpenedPayloadSchema,
  reviewCommentPayloadSchema,
  reviewRequestedPayloadSchema,
  webhookActionPayloadSchema,
  webhookSummaryPayloadSchema,
  type WebhookSummaryPayload,
} from "./payload-schemas";
import {
  handlePullRequestOpened,
  handleReviewRequested,
  handleIssueComment,
  handleReviewComment,
  isReviewRequestedForBot,
  type HandlerResult,
} from "./handlers";
import { createKvCacheStore } from "@open-inspect/shared/cache-store";
import { toAutofixEnvelope } from "./autofix-ingress";
import {
  claimDelivery,
  finalizeDelivery,
  isDeliveryProcessed,
  pruneExpiredDeliveries,
  releaseDelivery,
  renewDelivery,
} from "./delivery-claims";

const app = new Hono<{ Bindings: Env }>();
const DELIVERY_DEDUPE_TTL_MS = WEBHOOK_REPLAY_RETENTION_MS;
const DELIVERY_STATUS_PROCESSED = "processed";

app.get("/health", (c) => c.json({ status: "healthy", service: "open-inspect-github-bot" }));

app.post("/webhooks/github", async (c) => {
  const log = createLogger("webhook", {}, parseLogLevel(c.env.LOG_LEVEL));

  const rawBody = await c.req.text();
  const signature = c.req.header("X-Hub-Signature-256") ?? null;
  const event = c.req.header("X-GitHub-Event");
  const deliveryId = c.req.header("X-GitHub-Delivery");

  const valid = await verifyWebhookSignature(c.env.GITHUB_WEBHOOK_SECRET, rawBody, signature);
  if (!valid) {
    log.warn("webhook.signature_invalid", { delivery_id: deliveryId });
    return c.json({ error: "invalid signature" }, 401);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "invalid payload" }, 400);
  }

  const summaryResult = webhookSummaryPayloadSchema.safeParse(payload);
  const summary = summaryResult.success ? summaryResult.data : null;
  const actionResult = webhookActionPayloadSchema.safeParse(payload);
  const action = summary?.action ?? (actionResult.success ? actionResult.data.action : undefined);
  const traceId = crypto.randomUUID();

  log.info("webhook.received", {
    event_type: event,
    delivery_id: deliveryId,
    trace_id: traceId,
    repo: summary?.repository
      ? `${summary.repository.owner.login}/${summary.repository.name}`
      : undefined,
    action,
  });

  // Queue send is the acceptance boundary: an HTTP success means durable intake.
  const id =
    deliveryId ??
    "body:" +
      Array.from(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(event + rawBody))
        ),
        (byte) => byte.toString(16).padStart(2, "0")
      ).join("");
  try {
    await enqueueWebhookPayload(
      c.env.WEBHOOK_QUEUE,
      c.env.WEBHOOK_PAYLOADS,
      { deliveryId: id, traceId, event: event ?? undefined, receivedAt: new Date().toISOString() },
      payload
    );
  } catch (error) {
    log.error("webhook.enqueue_failed", { trace_id: traceId, delivery_id: id, error });
    return c.json({ error: "Webhook queue unavailable" }, 503);
  }
  return c.json({ ok: true });
});

export async function consumeGitHubWebhooks(
  batch: MessageBatch<GitHubWebhookMessage>,
  env: Env
): Promise<void> {
  const log = createLogger("webhook", {}, parseLogLevel(env.LOG_LEVEL));
  for (const message of batch.messages) {
    const { deliveryId, traceId, event, receivedAt } = message.body;
    const token = crypto.randomUUID();
    let claimed = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let heartbeatPending: Promise<void> = Promise.resolve();
    let ownershipLost = false;
    try {
      claimed = await claimDelivery(env, deliveryId, token);
      if (!claimed) {
        if (await isDeliveryProcessed(env, deliveryId)) message.ack();
        else message.retry({ delaySeconds: 60 });
        continue;
      }

      heartbeat = setInterval(() => {
        heartbeatPending = heartbeatPending
          .then(async () => {
            if (ownershipLost) return;
            if (!(await renewDelivery(env, deliveryId, token))) {
              throw new Error("GitHub delivery ownership lost during heartbeat");
            }
          })
          .catch((error) => {
            ownershipLost = true;
            log.error("webhook.heartbeat_failed", { delivery_id: deliveryId, error });
          });
      }, 30_000);

      const payload = await resolveWebhookPayload(env.WEBHOOK_PAYLOADS, message.body);
      const autofixEnvelope = toAutofixEnvelope({
        event,
        payload,
        deliveryId,
        botUsername: env.GITHUB_BOT_USERNAME,
        receivedAt: new Date(receivedAt),
      });
      if (autofixEnvelope) await env.AUTOFIX_QUEUE.send(autofixEnvelope);
      await handleWebhook(env, log, event, payload, traceId, deliveryId);

      clearInterval(heartbeat);
      await heartbeatPending;
      if (ownershipLost) throw new Error("GitHub delivery ownership lost");
      await finalizeDelivery(env, deliveryId, token);
      message.ack();
      try {
        await pruneExpiredDeliveries(env);
      } catch (error) {
        log.warn("webhook.dedupe_prune_failed", { trace_id: traceId, error });
      }
    } catch (error) {
      log.error("webhook.processing_error", { trace_id: traceId, delivery_id: deliveryId, error });
      if (claimed) {
        try {
          await releaseDelivery(env, deliveryId, token);
        } catch (releaseError) {
          log.warn("webhook.dedupe_clear_failed", {
            trace_id: traceId,
            delivery_id: deliveryId,
            error: releaseError,
          });
        }
      }
      message.retry({ delaySeconds: 60 });
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }
}

/** Skips that already posted a PR comment explaining why no session started. */
const COMMENTED_SKIP_REASONS: ReadonlySet<string> = new Set([
  "not_member",
  "target_team_missing_grant",
  "team_archived",
  "invalid_inline_flags",
  "model_preferences_unavailable",
  "harness_model_incompatible",
]);

async function handleWebhook(
  env: Env,
  log: Logger,
  event: string | undefined,
  payload: unknown,
  traceId: string,
  deliveryId: string | undefined
): Promise<void> {
  const parsed = webhookSummaryPayloadSchema.safeParse(payload);
  const actionResult = webhookActionPayloadSchema.safeParse(payload);
  const p: WebhookSummaryPayload = parsed.success
    ? parsed.data
    : { action: actionResult.success ? actionResult.data.action : undefined };
  const repo = p.repository ? `${p.repository.owner.login}/${p.repository.name}` : undefined;
  const sender = p.sender?.login;
  const pullNumber = p.pull_request?.number ?? p.issue?.number;

  const wideEventBase = {
    trace_id: traceId,
    delivery_id: deliveryId,
    event_type: event,
    action: p.action,
    repo,
    pull_number: pullNumber,
    sender,
  };

  const start = Date.now();
  const cacheStore = createKvCacheStore(env.GITHUB_KV);
  const dispatchKey = deliveryId ? `delivery-dispatch:${deliveryId}` : null;
  let result: HandlerResult | undefined;
  let dispatchFailure: { error: unknown } | undefined;

  try {
    if (dispatchKey && (await cacheStore.get(dispatchKey)) === DELIVERY_STATUS_PROCESSED) {
      result = { outcome: "skipped", skip_reason: "dispatch_completed" };
    } else {
      result = await dispatchHandler(env, log, event, p, payload, traceId);
      if (
        dispatchKey &&
        (result.outcome === "processed" || COMMENTED_SKIP_REASONS.has(result.skip_reason))
      ) {
        // Checkpoint completed external effects; preflight skips must be reevaluated.
        await cacheStore.put(dispatchKey, DELIVERY_STATUS_PROCESSED, {
          ttlMs: DELIVERY_DEDUPE_TTL_MS,
        });
      }
    }
  } catch (err) {
    dispatchFailure = { error: err };
    log.info("webhook.handled", {
      ...wideEventBase,
      outcome: "error",
      duration_ms: Date.now() - start,
      error: err instanceof Error ? err : new Error(String(err)),
    });
  }

  if (result !== undefined) {
    const wideEvent: Record<string, unknown> = {
      ...wideEventBase,
      outcome: result.outcome,
      duration_ms: Date.now() - start,
    };
    if (result.outcome === "skipped") {
      wideEvent.skip_reason = result.skip_reason;
    } else {
      wideEvent.session_id = result.session_id;
      wideEvent.message_id = result.message_id;
      wideEvent.handler_action = result.handler_action;
    }
    log.info("webhook.handled", wideEvent);
  }

  // Forwarding and built-in dispatch are independent; both must run before a
  // failure reaches the waitUntil cleanup path. Use the passthrough parse so
  // nested lifecycle fields are not stripped by the summary schema.
  let forwardingFailure: { error: unknown } | undefined;
  if (event) {
    const normalizationPayload = actionResult.success ? actionResult.data : {};
    const normalizedEvent = normalizeGitHubEvent(event, normalizationPayload, deliveryId);
    if (normalizedEvent !== null) {
      try {
        const url = "https://internal/internal/github-event";
        const body = JSON.stringify(normalizedEvent);
        const response = await signedControlPlaneFetch(env, { method: "POST", url, body, traceId });
        if (!response.ok) {
          forwardingFailure = {
            error: new Error(`GitHub event forwarding failed: ${response.status}`),
          };
          log.warn("webhook.github_event_forward_failed", {
            trace_id: traceId,
            delivery_id: deliveryId,
            event_type: event,
            status: response.status,
          });
        }
      } catch (err) {
        forwardingFailure = { error: err };
        log.warn("webhook.github_event_forward_error", {
          trace_id: traceId,
          delivery_id: deliveryId,
          event_type: event,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }
  }

  if (dispatchFailure !== undefined) throw dispatchFailure.error;
  if (forwardingFailure !== undefined) throw forwardingFailure.error;
}

function dispatchHandler(
  env: Env,
  log: Logger,
  event: string | undefined,
  p: WebhookSummaryPayload,
  payload: unknown,
  traceId: string
): Promise<HandlerResult> {
  switch (event) {
    case "pull_request":
      if (p.action === "opened") {
        const parsed = pullRequestOpenedPayloadSchema.safeParse(payload);
        if (!parsed.success) throw new Error("Malformed pull_request opened payload");
        return handlePullRequestOpened(env, log, parsed.data, traceId);
      }
      if (p.action === "review_requested") {
        if (!isReviewRequestedForBot(payload, env.GITHUB_BOT_USERNAME)) {
          return Promise.resolve({ outcome: "skipped", skip_reason: "review_not_for_bot" });
        }
        const parsed = reviewRequestedPayloadSchema.safeParse(payload);
        if (!parsed.success) throw new Error("Malformed pull_request review_requested payload");
        return handleReviewRequested(env, log, parsed.data, traceId);
      }
      return Promise.resolve({
        outcome: "skipped",
        skip_reason: "unsupported_action",
      });
    case "issue_comment":
      if (p.action === "created") {
        const parsed = issueCommentPayloadSchema.safeParse(payload);
        if (!parsed.success) throw new Error("Malformed issue_comment created payload");
        return handleIssueComment(env, log, parsed.data, traceId);
      }
      return Promise.resolve({
        outcome: "skipped",
        skip_reason: "unsupported_action",
      });
    case "pull_request_review_comment":
      if (p.action === "created") {
        const parsed = reviewCommentPayloadSchema.safeParse(payload);
        if (!parsed.success)
          throw new Error("Malformed pull_request_review_comment created payload");
        return handleReviewComment(env, log, parsed.data, traceId);
      }
      return Promise.resolve({
        outcome: "skipped",
        skip_reason: "unsupported_action",
      });
    default:
      return Promise.resolve({
        outcome: "skipped",
        skip_reason: "unsupported_event",
      });
  }
}

export default { fetch: app.fetch, queue: consumeGitHubWebhooks };
