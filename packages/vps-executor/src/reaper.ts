import { ContainerNotFoundError, type DockerRuntime } from "./docker.ts";
import type { StateStore } from "./state.ts";

/**
 * The control plane assumes a VPS sandbox ends two hours after it starts (DEFAULT_SANDBOX_TIMEOUT_SECONDS), and the
 * executor enforced nothing, so a sandbox whose session was archived, failed or lost stayed up until an operator
 * removed it. Five minutes of grace keeps a session that is finishing right at the bound from being cut off.
 */
export const DEFAULT_MAX_LIFETIME_MS = 7_500_000;
/** A container that is not running is dead weight. Ten minutes covers a restart or a slow docker start. */
export const DEAD_GRACE_MS = 600_000;

export interface ReapLimits {
  maxLifetimeMs: number;
  deadGraceMs: number;
}

export const DEFAULT_REAP_LIMITS: ReapLimits = {
  maxLifetimeMs: DEFAULT_MAX_LIFETIME_MS,
  deadGraceMs: DEAD_GRACE_MS,
};

export interface ReapResult {
  /** Owned containers removed because they outlived the lifetime, or sat dead past the grace. */
  reaped: number;
  /** Containers that should go but could not be removed this pass. The next pass tries again. */
  failed: number;
}

/**
 * Removes the executor's own containers that are stale: running past the maximum lifetime, or not running past the
 * grace. Only containers carrying this executor's owner labels are judged, and only by docker's own creation time, so
 * a restart that re-adopts a container never resets its age. A container with no readable creation time is left alone.
 *
 * A removal takes the same route as a stop: the container goes first, and only a verified removal (or docker saying
 * it is already gone) terminates the record, which frees the slot and keeps the lease spent. The workspace is
 * retained for its session exactly as after a stop. A create still in flight is never touched. An owned container the
 * state does not hold is removed too, and its unplaced row is dropped as after a stop. Fences and containers without
 * owner labels are never owned here, so they are never removed.
 *
 * The one lifetime applies to every sandbox: a create carries no per-session timeout. Set
 * VPS_EXECUTOR_SANDBOX_MAX_LIFETIME_SECONDS to at least the longest session timeout the control plane allows, plus grace.
 */
export async function reapStaleContainers(
  store: StateStore,
  runtime: DockerRuntime,
  now: () => number = Date.now,
  inFlight: ReadonlySet<string> = new Set(),
  limits: ReapLimits = DEFAULT_REAP_LIMITS
): Promise<ReapResult> {
  const inventory = await runtime.inventory();
  const result: ReapResult = { reaped: 0, failed: 0 };
  for (const container of inventory.owned) {
    if (container.createdAtMs === undefined) continue;
    // A create names its container only once docker answers, so its record is found by sandbox id, not container id.
    const holder = store.holding(container.sandboxId);
    if (holder !== undefined && (holder.status === "creating" || inFlight.has(holder.leaseToken)))
      continue;
    const ageMs = now() - container.createdAtMs;
    // Every state but running (exited, dead, created, paused, restarting) is dead weight: the executor pauses nothing
    // and sets no restart policy, so none of them is a state a healthy sandbox is in.
    const running = container.state === "running";
    const reason =
      ageMs > limits.maxLifetimeMs
        ? "outlived its maximum lifetime"
        : !running && ageMs > limits.deadGraceMs
          ? `is ${container.state ?? "not running"}`
          : undefined;
    if (reason === undefined) continue;
    let alreadyGone = false;
    try {
      await runtime.removeSandbox(container.containerId);
    } catch (error) {
      if (!(error instanceof ContainerNotFoundError)) {
        result.failed += 1;
        const detail = error instanceof Error ? error.message : "unknown error";
        console.error(
          `vps-executor: could not remove stale container for sandbox ${container.sandboxId}: ${detail}`
        );
        continue;
      }
      alreadyGone = true;
    }
    // Docker has verified the container absent, so its record ends and its unplaced row goes, as after a stop. A failed
    // write here costs nothing but time: reconciliation sees the id gone and frees it on its next pass.
    try {
      const record = store.byContainer(container.containerId);
      if (record !== undefined) store.terminate(record.leaseToken, container.containerId);
      else store.dropUnplaced(container.containerId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown error";
      console.error(
        `vps-executor: removed the container for sandbox ${container.sandboxId} but could not record it: ${detail}`
      );
    }
    if (alreadyGone) continue;
    result.reaped += 1;
    console.log(`vps-executor: removed container for sandbox ${container.sandboxId}; it ${reason}`);
  }
  return result;
}
