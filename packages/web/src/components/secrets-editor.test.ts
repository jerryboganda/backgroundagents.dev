import { describe, expect, it } from "vitest";
import { validateKey } from "./secrets-editor";

// Keys reach validateKey normalized (uppercase), as handleSave sends them.
describe("secret key validation", () => {
  it("accepts a key the save and the runtime both allow, up to 128 characters", () => {
    expect(validateKey("MY_TOKEN_2")).toBeNull();
    expect(validateKey("A".repeat(128))).toBeNull();
  });

  it("refuses a leading underscore, as the save and the runtime do", () => {
    expect(validateKey("_TOKEN")).toBe(
      "Key must start with a letter and use only letters, digits, and underscores"
    );
  });

  it("refuses a key over 128 characters", () => {
    expect(validateKey("A".repeat(129))).toBe("Key is too long");
  });

  it("refuses the keys the save refuses as reserved, including the boot-mode and tunnel controls", () => {
    for (const key of [
      "PATH",
      "PYTHONPATH",
      "IMAGE_BUILD_MODE",
      "OPENINSPECT_BOOT_MODE",
      "EXPECTED_TUNNEL_PORTS",
    ]) {
      expect(validateKey(key)).toBe(`Key '${key}' is reserved`);
    }
  });
});
