import type { Env } from "./types";
import { WEBHOOK_REPLAY_RETENTION_MS } from "@open-inspect/shared/webhook-queue";

const DELIVERY_DEDUPE_TTL_MS = WEBHOOK_REPLAY_RETENTION_MS;
const DELIVERY_PROCESSING_TTL_MS = 5 * 60 * 1_000;

/** D1's single write statement is the claim; KV get/put cannot implement this. */
export async function claimDelivery(env: Env, id: string, token: string): Promise<boolean> {
  const now = Date.now();
  const result = await env.DB.prepare(
    `INSERT INTO github_webhook_deliveries (delivery_id, claim_token, status, expires_at_ms)
     VALUES (?, ?, 'processing', ?)
     ON CONFLICT(delivery_id) DO UPDATE SET
       claim_token = excluded.claim_token,
       status = 'processing',
       expires_at_ms = excluded.expires_at_ms
     WHERE github_webhook_deliveries.expires_at_ms <= ?`
  )
    .bind(id, token, now + DELIVERY_PROCESSING_TTL_MS, now)
    .run();
  return result.meta.changes === 1;
}

/** Extend only the current owner's processing claim. A failed heartbeat must stop further work. */
export async function renewDelivery(env: Env, id: string, token: string): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE github_webhook_deliveries SET expires_at_ms = ?
     WHERE delivery_id = ? AND claim_token = ? AND status = 'processing' AND expires_at_ms > ?`
  )
    .bind(Date.now() + DELIVERY_PROCESSING_TTL_MS, id, token, Date.now())
    .run();
  return result.meta.changes === 1;
}

export async function finalizeDelivery(env: Env, id: string, token: string): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE github_webhook_deliveries
     SET status = 'processed', expires_at_ms = ?
     WHERE delivery_id = ? AND claim_token = ? AND status = 'processing' AND expires_at_ms > ?`
  )
    .bind(Date.now() + DELIVERY_DEDUPE_TTL_MS, id, token, Date.now())
    .run();
  if (result.meta.changes !== 1) throw new Error("GitHub delivery ownership lost");
}

export async function isDeliveryProcessed(env: Env, id: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT status FROM github_webhook_deliveries WHERE delivery_id = ?"
  )
    .bind(id)
    .first<{ status: string }>();
  return row?.status === "processed";
}

export async function releaseDelivery(env: Env, id: string, token: string): Promise<void> {
  await env.DB.prepare(
    "DELETE FROM github_webhook_deliveries WHERE delivery_id = ? AND claim_token = ?"
  )
    .bind(id, token)
    .run();
}

/** Prune completed dedupe markers; expired processing claims are reclaimed by their next consumer. */
export async function pruneExpiredDeliveries(env: Env): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM github_webhook_deliveries
     WHERE delivery_id IN (
       SELECT delivery_id FROM github_webhook_deliveries
       WHERE status = 'processed' AND expires_at_ms <= ? ORDER BY expires_at_ms LIMIT 100
     )`
  )
    .bind(Date.now())
    .run();
}
