import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const releaseWorkflow = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".github", "workflows", "polytronx-openinspect.yml"),
  "utf8"
);
const admittedText = releaseWorkflow.match(/^\s*allowed='([^']+)'/m)?.[1];
const credentialText = releaseWorkflow.match(/^\s*credential='([^']+)'/m)?.[1];
assert.ok(admittedText, "missing release overlay file allowlist");
assert.ok(credentialText, "missing independent credential-path denylist");

const admittedRegex = new RegExp(admittedText);
const credentialRegex = new RegExp(credentialText, "i");
const credentialExceptions = new Set([".env.example", "deploy/polytronx/pins.env"]);
const canEnterRelease = (path) =>
  admittedRegex.test(path) &&
  (!credentialRegex.test(path) || credentialExceptions.has(path));

test("exact reviewed multi-agent and VPS overlay paths are admitted", () => {
  const expected = [
    ".github/workflows/cross-harness-child-ci.yml",
    ".github/workflows/vps-workspace-contract.yml",
    ".github/workflows/vps-edge-contract.yml",
    ".github/workflows/dashboard-ssh-readiness.yml",
    ".github/workflows/executor-ssh-readiness.yml",
    ".github/workflows/dual-vps-ssh-contracts.yml",
    ".github/workflows/polytronx-overlay-contract.yml",
    "scripts/ship-executor.sh",
    "docs/AGENT_ROLES.md",
    "docs/HOW_IT_WORKS.md",
    "packages/control-plane/src/agent-role-profiles.test.ts",
    "packages/control-plane/src/agent-role-profiles.ts",
    "packages/control-plane/src/harness-admission.test.ts",
    "packages/control-plane/src/harness-admission.ts",
    "packages/control-plane/src/router.spawn-child.test.ts",
    "packages/control-plane/src/routes/session-child-spawn.ts",
    "packages/docs/content/docs/models/agent-harnesses.mdx",
    "packages/docs/content/docs/sessions/child-sessions.mdx",
    "packages/sandbox-runtime/src/sandbox_runtime/harness/tools.py",
    "packages/sandbox-runtime/src/sandbox_runtime/tools/spawn-child.js",
    "packages/sandbox-runtime/tests/test_spawn_child_tool.py",
    "packages/sandbox-runtime/tests/test_tools.py",
    "packages/shared/src/types/boundary-schemas.test.ts",
    "packages/shared/src/types/session-api.ts",
    "deploy/polytronx/ssh-readiness.sh",
    "deploy/polytronx/ssh-readiness.test.mjs",
    "deploy/polytronx/runbooks/ssh-access.md",
  ];
  for (const path of expected) {
    assert.equal(canEnterRelease(path), true, "missing exact reviewed overlay path: " + path);
  }
});

test("unreviewed source files and credential-shaped paths remain blocked", () => {
  const blocked = [
    "docs/UNREVIEWED.md",
    "scripts/unsafe.sh",
    ".github/workflows/unapproved.yml",
    "packages/shared/src/types/unapproved.ts",
    "packages/control-plane/src/agent-role-profiles.ts.bak",
    "deploy/polytronx/.env",
    "deploy/polytronx/production.env",
    "deploy/polytronx/secrets/deploy.json",
    "deploy/polytronx/id_ed25519",
    "deploy/polytronx/host-private.key",
    "deploy/polytronx/.ssh/authorized_keys",
    ".github/workflows/real-secret.pem",
  ];
  for (const path of blocked) {
    assert.equal(canEnterRelease(path), false, "unsafe path was admitted: " + path);
  }
});
