import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = JSON.parse(
  readFileSync(join(root, "deploy/polytronx/legacy-drift-pins.json"), "utf8")
);
const expected = new Map(manifest.exceptions.map((entry) => [entry.path, entry]));
assert.equal(expected.size, manifest.exceptions.length, "duplicate drift exception paths");
assert.match(manifest.upstreamRevision, /^[0-9a-f]{40}$/);

// The paths the manifest pins, one per line. Reading them needs no git, so a caller
// that drives the workflow with a stubbed git can still use them.
if (process.argv.includes("--print-pinned")) {
  for (const path of expected.keys()) console.log(path);
  process.exit(0);
}

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

const actual = git("diff", "--name-status", "--no-renames", manifest.upstreamRevision, "HEAD")
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [status, path] = line.split("\t");
    return { status, path };
  });

const workflow = readFileSync(join(root, ".github/workflows/polytronx-openinspect.yml"), "utf8");
const allowed = new RegExp(workflow.match(/^\s*allowed='([^']+)'/m)?.[1] ?? "^$");
const credential = new RegExp(workflow.match(/^\s*credential='([^']+)'/m)?.[1] ?? "^$", "i");
const credentialExceptions = new Set([".env.example", "deploy/polytronx/pins.env"]);
const errors = [];

for (const { path, status } of actual) {
  const isCredential = credential.test(path) && !credentialExceptions.has(path);
  if (isCredential) {
    errors.push("Credential-like path changed: " + path);
    continue;
  }
  if (allowed.test(path)) continue;
  const pin = expected.get(path);
  if (!pin) {
    errors.push("Unreviewed upstream divergence: " + path);
    continue;
  }
  if (status !== pin.status) {
    errors.push("Drift status changed: " + path);
    continue;
  }
  if (status === "D") {
    if (pin.sha !== null) errors.push("Deletion has non-null pin: " + path);
    continue;
  }
  const actualBlob = git("rev-parse", "HEAD:" + path);
  if (actualBlob !== pin.sha) errors.push("Pinned drift file changed: " + path);
}
for (const [path] of expected) {
  if (!actual.some((item) => item.path === path)) {
    errors.push("Pinned drift entry no longer differs from upstream: " + path);
  }
  if (allowed.test(path)) errors.push("Drift entry redundantly allowlisted: " + path);
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Verified " + expected.size + " exact legacy drift exceptions; no additional paths.");
}
