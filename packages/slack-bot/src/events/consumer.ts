import type { Env } from "../types";
import type { SlackEventPayload } from "./payload";
import { handleSlackEvent } from "./dispatcher";
import {
  resolveWebhookPayload,
  WEBHOOK_REPLAY_RETENTION_MS,
  type WebhookPayload,
} from "@open-inspect/shared/webhook-queue";

const PROCESSED_RETENTION_MS = WEBHOOK_REPLAY_RETENTION_MS;

/** Hourly retention sweep; active processing claims are never eligible. */
export async function pruneProcessedSlackDeliveries(env: Env): Promise<void> {
  await env.WEBHOOK_DB.prepare(
    `DELETE FROM bot_webhook_deliveries
     WHERE rowid IN (
       SELECT rowid FROM bot_webhook_deliveries
       WHERE service = 'slack' AND status = 'processed' AND processed_at_ms <= ?
       ORDER BY processed_at_ms LIMIT 500
     )`
  )
    .bind(Date.now() - PROCESSED_RETENTION_MS)
    .run();
}

export async function consumeSlackEvents(
  batch: MessageBatch<{ id: string } & WebhookPayload<SlackEventPayload>>,
  env: Env
): Promise<void> {
  for (const message of batch.messages) {
    const { id } = message.body;
    const token = crypto.randomUUID();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let heartbeatPending: Promise<void> = Promise.resolve();
    let ownershipLost = false;
    try {
      const claim = await env.WEBHOOK_DB.prepare(
        `INSERT INTO bot_webhook_deliveries (service, delivery_id, status, claimed_at_ms, claim_token)
         VALUES ('slack', ?, 'processing', ?, ?)
         ON CONFLICT(service, delivery_id) DO UPDATE SET claimed_at_ms = excluded.claimed_at_ms, claim_token = excluded.claim_token
         WHERE status = 'processing' AND claimed_at_ms < ?`
      )
        .bind(id, Date.now(), token, Date.now() - 15 * 60_000)
        .run();
      if (claim.meta.changes !== 1) {
        const row = await env.WEBHOOK_DB.prepare(
          "SELECT status FROM bot_webhook_deliveries WHERE service = 'slack' AND delivery_id = ?"
        )
          .bind(id)
          .first<{ status: string }>();
        if (row?.status === "processed") message.ack();
        else message.retry({ delaySeconds: 60 });
        continue;
      }
      heartbeat = setInterval(() => {
        heartbeatPending = heartbeatPending
          .then(async () => {
            const updated = await env.WEBHOOK_DB.prepare(
              "UPDATE bot_webhook_deliveries SET claimed_at_ms = ? WHERE service = 'slack' AND delivery_id = ? AND claim_token = ? AND status = 'processing'"
            )
              .bind(Date.now(), id, token)
              .run();
            if (updated.meta.changes !== 1) throw new Error("Slack delivery ownership lost");
          })
          .catch((error) => {
            ownershipLost = true;
            console.error("slack.event.heartbeat_failed", id, error);
          });
      }, 30_000);
      const payload = await resolveWebhookPayload<SlackEventPayload>(
        env.WEBHOOK_PAYLOADS,
        message.body
      );
      const pending: Promise<void>[] = [];
      await handleSlackEvent(payload, env, id, (promise) => {
        pending.push(promise);
      });
      for (let i = 0; i < pending.length; i++) await pending[i];
      if (heartbeat) clearInterval(heartbeat);
      await heartbeatPending;
      if (ownershipLost) throw new Error("Slack delivery ownership lost");
      const done = await env.WEBHOOK_DB.prepare(
        "UPDATE bot_webhook_deliveries SET status = 'processed', processed_at_ms = ? WHERE service = 'slack' AND delivery_id = ? AND claim_token = ? AND status = 'processing'"
      )
        .bind(Date.now(), id, token)
        .run();
      if (done.meta.changes !== 1) throw new Error("Slack delivery ownership lost");
      message.ack();
    } catch (error) {
      console.error("slack.event.processing_failed", id, error);
      await env.WEBHOOK_DB.prepare(
        "DELETE FROM bot_webhook_deliveries WHERE service = 'slack' AND delivery_id = ? AND claim_token = ? AND status = 'processing'"
      )
        .bind(id, token)
        .run()
        .catch(console.error);
      message.retry({ delaySeconds: 60 });
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }
}
