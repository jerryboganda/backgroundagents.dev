import { createHmac, timingSafeEqual } from "node:crypto";

/*
 * Admission lease check for the create request. The control plane forwards the lease it was
 * granted after claiming a slot: { leaseToken, expiresAtMs, signature }. The signature is
 * HMAC-SHA256 under the admission secret shared with the control plane, over a canonical payload
 * that binds the lease to one session and one sandbox id.
 *
 * Expiry is exact, with no clock skew tolerance: a lease is refused at or after expiresAtMs. A
 * tolerance would lengthen the replay window, so keep both clocks NTP-synced.
 *
 * ponytail: a valid lease replays until it expires, so a captured lease can start its sandbox
 * again after a stop, inside the window. Single-use needs consumed tokens kept in the state file.
 */

export type AdmissionFailure = "missing" | "invalid" | "expired";

export interface AdmissionLease {
  leaseToken: string;
  expiresAtMs: number;
}

/** The fields a signature covers. The control plane signs the same bytes. */
export interface SignedLeaseFields extends AdmissionLease {
  sessionId: string;
  sandboxId: string;
}

/** What a lease is checked against: the secret, the request's identity, and the clock. */
export interface AdmissionCheck {
  /** Empty fails every lease closed. */
  secret: string;
  sessionId: string;
  sandboxId: string;
  nowMs: number;
}

export class AdmissionError extends Error {
  readonly failure: AdmissionFailure;

  constructor(failure: AdmissionFailure) {
    super(`admission lease ${failure}`);
    this.name = "AdmissionError";
    this.failure = failure;
  }
}

const LEASE_TOKEN_PATTERN = /^[\x21-\x7e]{1,512}$/;
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;
// Domain tag: a signature made for another purpose under the same secret never verifies here.
const SIGNATURE_DOMAIN = "open-inspect.vps-admission.v1";

/** HMAC-SHA256 hex over the canonical payload. Keep in step with the control plane's vps-provider.ts. */
export function admissionSignature(secret: string, fields: SignedLeaseFields): string {
  const payload = JSON.stringify([
    SIGNATURE_DOMAIN,
    fields.sessionId,
    fields.sandboxId,
    fields.leaseToken,
    fields.expiresAtMs,
  ]);
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * Returns the lease when it is well-formed, signed for this session and sandbox, and not yet
 * expired. Throws AdmissionError. The signature is checked before expiry, so an unsigned lease
 * never reaches the clock check.
 */
export function parseAdmissionLease(value: unknown, check: AdmissionCheck): AdmissionLease {
  if (value === undefined || value === null) throw new AdmissionError("missing");
  if (typeof value !== "object") throw new AdmissionError("invalid");
  const { leaseToken, expiresAtMs, signature } = value as Record<string, unknown>;
  if (typeof leaseToken !== "string" || !LEASE_TOKEN_PATTERN.test(leaseToken))
    throw new AdmissionError("invalid");
  if (typeof expiresAtMs !== "number" || !Number.isSafeInteger(expiresAtMs))
    throw new AdmissionError("invalid");
  if (typeof signature !== "string" || !SIGNATURE_PATTERN.test(signature))
    throw new AdmissionError("invalid");
  // The empty key is public knowledge, so anyone could sign with it. Refuse.
  if (check.secret === "") throw new AdmissionError("invalid");
  const expected = admissionSignature(check.secret, {
    sessionId: check.sessionId,
    sandboxId: check.sandboxId,
    leaseToken,
    expiresAtMs,
  });
  if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex")))
    throw new AdmissionError("invalid");
  if (expiresAtMs <= check.nowMs) throw new AdmissionError("expired");
  return { leaseToken, expiresAtMs };
}
