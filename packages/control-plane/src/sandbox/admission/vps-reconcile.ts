import type { SqlDatabase } from "../../db/sql-database";
import type { Logger } from "../../logger";
import type { Env } from "../../types";
import { PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS } from "../lifecycle/decisions";
import { createVpsProviderFromEnv } from "../provider-factory";
import { parseVpsPendingVmReference } from "../providers/pending-vm-reference";
import { SandboxAdmissionGate, admissionProofOf, type AdmissionLookup } from "./gate";
import { SandboxAdmissionStore } from "./reservations";

/** Whether the VPS executor is this deployment's sandbox backend, the only deployment this reconciles. */
export function isVpsSandboxBackend(env: Pick<Env, "SANDBOX_PROVIDER">): boolean {
  return env.SANDBOX_PROVIDER?.trim().toLowerCase() === "vps";
}

/** Bounds each executor call of a reconcile run. A run makes at most two calls per slot, well inside a tick. */
export const RECONCILE_REQUEST_TIMEOUT_MS = 10_000;

/** Set while a run is in flight, so a tick that fires during a slow run does not start a second one. */
let running = false;

/**
 * Settles the unknown VPS leases in the durable gate. A lease frees its slot only on the executor's close
 * answer: "absent" proves no object is or can become live under it, and "present" names an object, which is
 * stopped before the slot frees, since no launch is left to stop it. A 404, a timeout or any other error keeps
 * the lease held. A lease is not looked up until its launch's own lookups have ended, so a live launch is never
 * stopped under its owner. Allocated objects their owner no longer uses (a newer generation of the session holds a
 * lease, or the owner relinquished the object) are stopped the same way: the slot frees only on a confirmed stop,
 * never on time, and no new allocation is needed first. Runs do not overlap.
 */
export async function reconcileVpsAdmission(
  env: Env,
  db: SqlDatabase,
  nowMs: number,
  log: Pick<Logger, "info" | "warn">
): Promise<void> {
  if (running) return;
  running = true;
  try {
    const gate = new SandboxAdmissionGate(new SandboxAdmissionStore(db));
    const provider = createVpsProviderFromEnv(env, {
      requestTimeoutMs: RECONCILE_REQUEST_TIMEOUT_MS,
      leases: gate,
    });
    const counts = await gate.reconcileUnknown(async (record): Promise<AdmissionLookup> => {
      const pending = parseVpsPendingVmReference(record.operationRef);
      if (!pending) return { kind: "undecided" };
      if (nowMs - record.createdAt < PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS)
        return { kind: "undecided" };
      const closed = await provider.closeAdmission({
        ...pending,
        admissionLease: admissionProofOf(record),
      });
      if (closed.kind === "absent") return { kind: "gone" };
      if (closed.kind === "undecided") return { kind: "undecided" };
      // The launch that created this object has ended, so nothing else will stop it.
      const stopped = await provider.stopSandbox({
        providerObjectId: closed.providerObjectId,
        sessionId: pending.sessionId,
        reason: "admission_reconcile",
        intent: "destroy",
        generationCreatedAtMs: record.generation,
      });
      return stopped.success ? { kind: "gone" } : { kind: "undecided" };
    }, nowMs);
    let orphaned = 0;
    for (const record of await gate.orphanedAllocated()) {
      if (!record.modalObjectId) continue;
      try {
        // The lease's own generation fences the release, so the object it holds is the only one freed.
        const stopped = await provider.stopSandbox({
          providerObjectId: record.modalObjectId,
          sessionId: record.sessionId,
          reason: "admission_reconcile",
          intent: "destroy",
          generationCreatedAtMs: record.generation,
        });
        if (
          stopped.success &&
          (await gate.releaseStopped(record.sessionId, record.modalObjectId, record.generation)) ===
            "released"
        )
          orphaned++;
      } catch {
        // The stop was not confirmed, so the slot stays held and the next run retries it.
      }
    }
    if (counts.recorded > 0 || counts.released > 0 || orphaned > 0)
      log.info("VPS admission leases settled", {
        event: "sandbox.admission_reconciled",
        ...counts,
        orphaned,
      });
  } catch (error) {
    log.warn("VPS admission reconciliation failed", {
      event: "sandbox.admission_reconcile_failed",
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    running = false;
  }
}
