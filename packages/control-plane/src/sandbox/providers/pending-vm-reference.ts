const MODAL_PREFIX = "modal-vm-session:";
/** VPS references have their own prefix, so a reference names the one provider that can resolve it. */
const VPS_PREFIX = "vps-vm-session:";

/**
 * Format modal-vm-session:["sessionId","sandboxId"]. Session names the allocation;
 * both ids name its ownership tags.
 */
export function formatPendingVmReference(sessionId: string, sandboxId: string): string {
  return `${MODAL_PREFIX}${JSON.stringify([sessionId, sandboxId])}`;
}

/** Format vps-vm-session:["sessionId","sandboxId"], the reference a VPS executor create is named by. */
export function formatVpsPendingVmReference(sessionId: string, sandboxId: string): string {
  return `${VPS_PREFIX}${JSON.stringify([sessionId, sandboxId])}`;
}

/**
 * Parse a reference, which resolves only while its generation's allocation runs.
 * An invisible allocation is confirmed absent only after the launch window,
 * endpoint timeout and margin (PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS).
 */
export function parsePendingVmReference(
  value: string
): { sessionId: string; sandboxId: string } | null {
  return parseIdentity(MODAL_PREFIX, value);
}

/** Parse a VPS reference. A Modal reference is not one, so a VPS stop never resolves a Modal object. */
export function parseVpsPendingVmReference(
  value: string
): { sessionId: string; sandboxId: string } | null {
  return parseIdentity(VPS_PREFIX, value);
}

function parseIdentity(
  prefix: string,
  value: string
): { sessionId: string; sandboxId: string } | null {
  if (!value.startsWith(prefix)) return null;
  try {
    const identity: unknown = JSON.parse(value.slice(prefix.length));
    if (
      !Array.isArray(identity) ||
      identity.length !== 2 ||
      !identity.every((part) => typeof part === "string" && part.length > 0)
    )
      return null;
    return { sessionId: identity[0], sandboxId: identity[1] };
  } catch {
    return null;
  }
}
