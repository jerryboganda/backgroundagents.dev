/** Cloudflare Queues cap JSON messages at 128,000 bytes, including internal metadata. */
export const WEBHOOK_QUEUE_INLINE_LIMIT_BYTES = 120_000;
/** Covers the 14-day primary queue and 14-day dead-letter retention ceilings. */
export const WEBHOOK_REPLAY_RETENTION_MS = 31 * 24 * 60 * 60_000;

export type WebhookPayload<T> =
  { payload: T; payloadKey?: never } | { payloadKey: string; payload?: never };

interface PayloadBucket {
  put(key: string, body: string): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
}

/** Queue acknowledgement follows the R2 write; a failed send leaves an expiring orphan. */
export async function enqueueWebhookPayload<T, M extends object>(
  queue: { send(message: M & WebhookPayload<T>): Promise<unknown> },
  bucket: PayloadBucket | undefined,
  metadata: M,
  payload: T
): Promise<void> {
  const inline = { ...metadata, payload } as M & WebhookPayload<T>;
  if (
    new TextEncoder().encode(JSON.stringify(inline)).byteLength <= WEBHOOK_QUEUE_INLINE_LIMIT_BYTES
  ) {
    await queue.send(inline);
    return;
  }

  const payloadKey = "webhooks/" + crypto.randomUUID();
  const reference = { ...metadata, payloadKey } as M & WebhookPayload<T>;
  if (
    new TextEncoder().encode(JSON.stringify(reference)).byteLength >
    WEBHOOK_QUEUE_INLINE_LIMIT_BYTES
  ) {
    throw new Error("Webhook queue reference exceeds the message size limit");
  }
  if (!bucket) throw new Error("Webhook payload storage binding unavailable");
  const stored = await bucket.put(payloadKey, JSON.stringify(payload));
  if (!stored) throw new Error("Webhook payload storage did not confirm persistence");
  await queue.send(reference);
}

/** Resolve only after claiming delivery ownership; duplicate messages need no R2 read. */
export async function resolveWebhookPayload<T>(
  bucket: PayloadBucket | undefined,
  message: WebhookPayload<T>
): Promise<T> {
  if (message.payloadKey === undefined) return message.payload as T;
  if (!bucket) throw new Error("Webhook payload storage binding unavailable");
  const object = await bucket.get(message.payloadKey);
  if (!object) throw new Error("Queued webhook payload missing from R2");
  return JSON.parse(await object.text()) as T;
}
