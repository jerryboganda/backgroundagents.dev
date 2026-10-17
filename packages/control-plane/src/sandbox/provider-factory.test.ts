import { describe, expect, it } from "vitest";
import { createTestEnv } from "../router.test-support";
import type { Env } from "../types";
import { createSandboxProviderFromEnv } from "./provider-factory";

function createEnv(overrides: Partial<Env>): Env {
  return createTestEnv({ TOKEN_ENCRYPTION_KEY: "test-token-key", ...overrides });
}

describe("createSandboxProviderFromEnv", () => {
  it("rejects malformed Vercel numeric configuration", () => {
    const env = createEnv({
      VERCEL_TOKEN: "vercel-token",
      VERCEL_PROJECT_ID: "project-id",
      VERCEL_SNAPSHOT_EXPIRATION_MS: "10m",
    });

    expect(() => createSandboxProviderFromEnv(env, "vercel")).toThrow(
      "VERCEL_SNAPSHOT_EXPIRATION_MS must be a valid number"
    );
  });

  it("rejects malformed Daytona auto-stop configuration", () => {
    const env = createEnv({
      DAYTONA_API_URL: "https://daytona.test",
      DAYTONA_API_KEY: "daytona-key",
      DAYTONA_BASE_SNAPSHOT: "base",
      DAYTONA_AUTO_STOP_INTERVAL_MINUTES: "abc",
    });

    expect(() => createSandboxProviderFromEnv(env, "daytona")).toThrow(
      "DAYTONA_AUTO_STOP_INTERVAL_MINUTES must be a valid number"
    );
  });

  it("rejects malformed Daytona auto-archive configuration", () => {
    const env = createEnv({
      DAYTONA_API_URL: "https://daytona.test",
      DAYTONA_API_KEY: "daytona-key",
      DAYTONA_BASE_SNAPSHOT: "base",
      DAYTONA_AUTO_STOP_INTERVAL_MINUTES: "30",
      DAYTONA_AUTO_ARCHIVE_INTERVAL_MINUTES: "abc",
    });

    expect(() => createSandboxProviderFromEnv(env, "daytona")).toThrow(
      "DAYTONA_AUTO_ARCHIVE_INTERVAL_MINUTES must be a valid number"
    );
  });

  it("needs a base snapshot to create Daytona sandboxes", () => {
    const env = createEnv({
      DAYTONA_API_URL: "https://daytona.test",
      DAYTONA_API_KEY: "daytona-key",
    });

    expect(() => createSandboxProviderFromEnv(env, "daytona")).toThrow(
      "DAYTONA_BASE_SNAPSHOT is required to create Daytona sandboxes"
    );
  });

  it("still requires Daytona credentials", () => {
    expect(() =>
      createSandboxProviderFromEnv(
        createEnv({ DAYTONA_API_URL: "https://daytona.test" }),
        "daytona"
      )
    ).toThrow("DAYTONA_API_URL and DAYTONA_API_KEY are required");
  });

  it("rejects malformed E2B auto-pause configuration", () => {
    const env = createEnv({
      E2B_API_KEY: "e2b-key",
      E2B_TEMPLATE_ID: "tmpl",
      E2B_AUTO_PAUSE: "tru",
    });

    expect(() => createSandboxProviderFromEnv(env, "e2b")).toThrow(
      "E2B_AUTO_PAUSE must be a valid boolean"
    );
  });

  it("requires an OpenComputer template for starts but not existing-session cleanup", () => {
    const env = createEnv({
      OPENCOMPUTER_API_URL: "https://opencomputer.test",
      OPENCOMPUTER_API_KEY: "opencomputer-key",
    });

    expect(() => createSandboxProviderFromEnv(env, "opencomputer")).toThrow(
      "OPENCOMPUTER_TEMPLATE"
    );
    expect(() =>
      createSandboxProviderFromEnv(env, "opencomputer", {
        requireOpenComputerTemplate: false,
      })
    ).not.toThrow();
  });

  it("selects the VPS executor provider from SANDBOX_PROVIDER", () => {
    const env = createEnv({
      SANDBOX_PROVIDER: "vps",
      VPS_EXECUTOR_URL: "https://executor.test",
      VPS_EXECUTOR_TOKEN: "executor-token",
      VPS_EXECUTOR_ADMISSION_SECRET: "admission-secret",
    });

    expect(createSandboxProviderFromEnv(env).name).toBe("vps");
  });

  it("fails before any allocation when the VPS admission secret is missing", () => {
    expect(() =>
      createSandboxProviderFromEnv(
        createEnv({
          SANDBOX_PROVIDER: "vps",
          VPS_EXECUTOR_URL: "https://executor.test",
          VPS_EXECUTOR_TOKEN: "executor-token",
        })
      )
    ).toThrow("VPS executor admission secret is required");
  });

  it.each([
    { VPS_EXECUTOR_URL: "https://executor.test" },
    { VPS_EXECUTOR_TOKEN: "executor-token" },
  ])("fails fast on partial VPS executor config: %o", (partial) => {
    expect(() =>
      createSandboxProviderFromEnv(createEnv({ SANDBOX_PROVIDER: "vps", ...partial }))
    ).toThrow("VPS executor URL and token are required");
  });
});
