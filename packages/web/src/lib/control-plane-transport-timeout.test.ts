import { describe, expect, it } from "vitest";
import { controlPlaneTimeoutMs } from "./control-plane-transport";

describe("controlPlaneTimeoutMs", () => {
  it("gives only the session delete request a long bound", () => {
    expect(controlPlaneTimeoutMs("https://cp.test/sessions/abc123", "DELETE")).toBe(300_000);
    expect(controlPlaneTimeoutMs("https://cp.test/sessions/abc123", "delete")).toBe(300_000);
  });

  it("keeps the short bound for every other request", () => {
    expect(controlPlaneTimeoutMs("https://cp.test/sessions/abc123", "GET")).toBe(15_000);
    expect(controlPlaneTimeoutMs("https://cp.test/sessions/abc123/archive", "POST")).toBe(15_000);
    expect(controlPlaneTimeoutMs("https://cp.test/sessions/abc123/messages", "DELETE")).toBe(15_000);
    expect(controlPlaneTimeoutMs("https://cp.test/automations/x", "DELETE")).toBe(15_000);
    expect(controlPlaneTimeoutMs("not a url", "DELETE")).toBe(15_000);
  });
});
