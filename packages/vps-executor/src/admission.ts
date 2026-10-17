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
 * A lease is spent by the first create it admits. The server keeps the spent token in its state
 * file, so a replay after that create is refused there. This module only proves the lease is
 * genuine, current, and short-lived.
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

/** The scope a lease is signed for: the secret, and the request's session and sandbox id. */
export interface LeaseScope {
  /** Empty fails every lease closed. */
  secret: string;
  sessionId: string;
  sandboxId: string;
}

/** What a create's lease is checked against: its scope, and the clock. */
export interface AdmissionCheck extends LeaseScope {
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
// Longest a lease may run from the check. The control plane's lease is short (its launch window);
// this headroom absorbs clock skew, and anything longer is refused as invalid.
export const MAX_LEASE_LIFETIME_MS = 60_000;

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
 * Returns the lease when it is well-formed and signed for this scope. Expiry is not checked, so a
 * settlement proof still settles a lapsed lease, and never creates one. Throws AdmissionError
 * (missing or invalid).
 */
export function verifySignedLease(value: unknown, scope: LeaseScope): AdmissionLease {
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
  if (scope.secret === "") throw new AdmissionError("invalid");
  const expected = admissionSignature(scope.secret, {
    sessionId: scope.sessionId,
    sandboxId: scope.sandboxId,
    leaseToken,
    expiresAtMs,
  });
  if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex")))
    throw new AdmissionError("invalid");
  return { leaseToken, expiresAtMs };
}

/**
 * Returns the lease when it is verified, not yet expired, and within MAX_LEASE_LIFETIME_MS. Throws
 * AdmissionError. The signature is checked before the clock, so an unsigned lease never reaches the
 * clock checks.
 */
export function parseAdmissionLease(value: unknown, check: AdmissionCheck): AdmissionLease {
  const lease = verifySignedLease(value, check);
  if (lease.expiresAtMs <= check.nowMs) throw new AdmissionError("expired");
  if (lease.expiresAtMs - check.nowMs > MAX_LEASE_LIFETIME_MS) throw new AdmissionError("invalid");
  return lease;
}
