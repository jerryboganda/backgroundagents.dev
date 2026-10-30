import { defineConfig } from "vitest/config";
import { coverageExclusions } from "../../scripts/coverage-policy";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/conformance/**/*.test.ts"],
    maxWorkers: process.platform === "win32" ? 1 : undefined,
    coverage: {
      provider: "v8",
      reporter: ["text", "json"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: coverageExclusions("control-plane"),
    },
  },
});
