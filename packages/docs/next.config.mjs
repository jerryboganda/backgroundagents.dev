import { createMDX } from "fumadocs-mdx/next";
import path from "node:path";

const withMDX = createMDX();

/**
 * Trace the monorepo root so the standalone server can run in the VPS container.
 *
 * @type {import("next").NextConfig}
 */
const monorepoRoot = path.join(import.meta.dirname, "../..");
const config = {
  reactStrictMode: true,
  output: "standalone",
  outputFileTracingRoot: monorepoRoot,
  turbopack: { root: monorepoRoot },
};

export default withMDX(config);
