import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AdmissionError,
  admissionSignature,
  MAX_LEASE_LIFETIME_MS,
  parseAdmissionLease,
  type AdmissionFailure,
} from "../src/admission.ts";

const NOW = 1_700_000_000_000;
const SECRET = "test-admission-secret-0123456789abcdef";
const CHECK = { secret: SECRET, sessionId: "session-1", sandboxId: "sandbox-1", nowMs: NOW };

/** A lease as the control plane sends it, signed for CHECK's session and sandbox. */
function signed(leaseToken: string, expiresAtMs: number) {
  const signature = admissionSignature(SECRET, {
    sessionId: CHECK.sessionId,
    sandboxId: CHECK.sandboxId,
    leaseToken,
    expiresAtMs,
  });
  return { leaseToken, expiresAtMs, signature };
}

function assertFailure(value: unknown, failure: AdmissionFailure, check = CHECK): void {
  assert.throws(
    () => parseAdmissionLease(value, check),
    (error: unknown) => error instanceof AdmissionError && error.failure === failure
  );
}

describe("parseAdmissionLease", () => {
  it("accepts a signed lease whose expiry is in the future", () => {
    const lease = signed("lease-1", NOW + 1);
    assert.deepEqual(parseAdmissionLease(lease, CHECK), {
      leaseToken: "lease-1",
      expiresAtMs: NOW + 1,
    });
  });

  it("requires a lease", () => {
    assertFailure(undefined, "missing");
    assertFailure(null, "missing");
  });

  it("rejects malformed leases", () => {
    assertFailure("lease-1", "invalid");
    assertFailure({ expiresAtMs: NOW + 1 }, "invalid");
    assertFailure({ leaseToken: "", expiresAtMs: NOW + 1 }, "invalid");
    assertFailure({ leaseToken: "has space", expiresAtMs: NOW + 1 }, "invalid");
    assertFailure({ leaseToken: "x".repeat(513), expiresAtMs: NOW + 1 }, "invalid");
    assertFailure({ leaseToken: "lease-1", expiresAtMs: String(NOW + 1) }, "invalid");
    assertFailure({ leaseToken: "lease-1", expiresAtMs: NOW + 0.5 }, "invalid");
  });

  it("rejects a lease without a well-formed signature", () => {
    const { leaseToken, expiresAtMs, signature } = signed("lease-1", NOW + 1);
    assertFailure({ leaseToken, expiresAtMs }, "invalid");
    assertFailure({ leaseToken, expiresAtMs, signature: signature.toUpperCase() }, "invalid");
    assertFailure({ leaseToken, expiresAtMs, signature: signature.slice(1) }, "invalid");
    assertFailure({ leaseToken, expiresAtMs, signature: "0".repeat(64) }, "invalid");
  });

  it("rejects a valid signature moved to another session, sandbox, token or expiry", () => {
    const lease = signed("lease-1", NOW + 1);
    assertFailure(lease, "invalid", { ...CHECK, sessionId: "session-2" });
    assertFailure(lease, "invalid", { ...CHECK, sandboxId: "sandbox-2" });
    assertFailure({ ...lease, leaseToken: "lease-2" }, "invalid");
    assertFailure({ ...lease, expiresAtMs: NOW + 2 }, "invalid");
  });

  it("rejects a lease signed under a different secret", () => {
    const signature = admissionSignature("another-admission-secret-0123456789", {
      sessionId: CHECK.sessionId,
      sandboxId: CHECK.sandboxId,
      leaseToken: "lease-1",
      expiresAtMs: NOW + 1,
    });
    assertFailure({ leaseToken: "lease-1", expiresAtMs: NOW + 1, signature }, "invalid");
  });

  it("refuses every lease when no secret is configured", () => {
    assertFailure(signed("lease-1", NOW + 1), "invalid", { ...CHECK, secret: "" });
  });

  it("accepts a lease until it expires, then refuses it", () => {
    const lease = signed("lease-1", NOW + 1);
    assert.ok(parseAdmissionLease(lease, CHECK));
    assert.ok(parseAdmissionLease(lease, { ...CHECK, nowMs: NOW }));
    assertFailure(lease, "expired", { ...CHECK, nowMs: NOW + 1 });
    assertFailure(lease, "expired", { ...CHECK, nowMs: NOW + 60_000 });
  });

  it("rejects leases that are expired or expire right now", () => {
    assertFailure(signed("lease-1", NOW - 1), "expired");
    assertFailure(signed("lease-1", NOW), "expired");
  });

  it("refuses a lease that would run longer than the lifetime bound", () => {
    assert.ok(parseAdmissionLease(signed("lease-1", NOW + MAX_LEASE_LIFETIME_MS), CHECK));
    assertFailure(signed("lease-1", NOW + MAX_LEASE_LIFETIME_MS + 1), "invalid");
  });

  it("signs the canonical payload to the pinned vector the control plane also asserts", () => {
    assert.equal(
      admissionSignature(SECRET, {
        sessionId: "session-1",
        sandboxId: "sandbox-1",
        leaseToken: "lease-1",
        expiresAtMs: 1_700_000_000_000,
      }),
      "18d08991beb7a63118d5b80776ebb1dd9011ed70bec9b26363bfb760415c8062"
    );
  });
});
