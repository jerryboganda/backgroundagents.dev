import { describe, expect, it } from "vitest";
import { DEFAULT_SPAWN_CONFIG, evaluateSpawnDecision } from "./decisions";
import { SANDBOX_RUNTIME_VERSION } from "../runtime-manifest";

const NOW = 1_800_000_000_000;
const stopped = {
  status: "stopped" as const,
  createdAt: NOW - 3_600_000,
  providerObjectId: "object-1",
  snapshotImageId: "vps-workspace:session-1",
  snapshotRuntimeVersion: null,
  hasActiveWebSocket: false,
  lastHeartbeat: NOW - 3_000_000,
};

describe("evaluateSpawnDecision: restoring a saved workspace", () => {
  it("holds a snapshot whose runtime version was never recorded, so a clean tree is never substituted", () => {
    const decision = evaluateSpawnDecision(stopped, DEFAULT_SPAWN_CONFIG, NOW, false);
    expect(decision.action).toBe("hold");
  });

  it("restores a workspace the provider boots the current runtime onto, whatever version was recorded", () => {
    const decision = evaluateSpawnDecision(stopped, DEFAULT_SPAWN_CONFIG, NOW, false, false, true);
    expect(decision).toEqual({
      action: "restore",
      snapshotImageId: "vps-workspace:session-1",
      snapshotRuntimeVersion: SANDBOX_RUNTIME_VERSION,
    });
  });

  it("still restores an image snapshot with a compatible recorded version", () => {
    const decision = evaluateSpawnDecision(
      { ...stopped, snapshotImageId: "img-1", snapshotRuntimeVersion: SANDBOX_RUNTIME_VERSION },
      DEFAULT_SPAWN_CONFIG,
      NOW,
      false
    );
    expect(decision.action).toBe("restore");
  });
});
