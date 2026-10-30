import { describe, expect, it } from "vitest";
import { jobKindForQueue } from "./job-queue";

describe("Cloudflare job queue routing", () => {
  it("delivers GitHub Autofix to the control-plane job handler using the Terraform queue name", () => {
    expect(jobKindForQueue("open-inspect-github-autofix-prod", "prod")).toBe("github.autofix");
    expect(jobKindForQueue("open-inspect-image-build-finalization-prod", "prod")).toBe(
      "image_build.finalize"
    );
    expect(jobKindForQueue("open-inspect-github-autofix-dlq-prod", "prod")).toBeUndefined();
  });
});
