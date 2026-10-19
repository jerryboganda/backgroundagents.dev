#!/usr/bin/env node
// Keeps the OpenCode Zen and Go model catalog (packages/shared/src/models.ts) in step with OpenCode's live lists.
//
//   node scripts/opencode-model-sync.mjs check  --models <models.ts>
//       Prints {"missing":[ids]}: free-tier models the live Zen/Go lists carry and the catalog does not.
//   node scripts/opencode-model-sync.mjs apply  --models <models.ts> --ids <id,id,...>
//       Inserts those ids (opencode/<m> or opencode-go/<m>) into the matching category. Ids already present are skipped.
//   node scripts/opencode-model-sync.mjs record --state <additions.json> --ids <id,id,...>
//       Adds those ids to the state file the replay reads.
//   node scripts/opencode-model-sync.mjs replay --models <models.ts> --state <additions.json>
//       Applies every id recorded in the state file, so additions survive a deploy from a tree that lacks them.
//
// Only free-tier models (ids ending in "-free") are added automatically. Paid models need a decision (price, reasoning
// options), so they are left to a code change.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ZEN_URL = "https://opencode.ai/zen/v1/models";
const GO_URL = "https://opencode.ai/zen/go/v1/models";

export function displayName(modelId) {
  const base = modelId.replace(/-free$/, "");
  const words = base.split("-").map((part) => {
    if (/^\d/.test(part)) return part.toUpperCase();
    return part.charAt(0).toUpperCase() + part.slice(1);
  });
  return `${words.join(" ")} (free)`;
}

function entryLine(prefixedId) {
  const model = prefixedId.slice(prefixedId.indexOf("/") + 1);
  const name = displayName(model);
  return `      { id: "${prefixedId}", name: "${name}", description: "OpenCode free tier" },`;
}

export function catalogIds(source) {
  return new Set([...source.matchAll(/id: "(opencode(?:-go)?\/[^"]+)"/g)].map((m) => m[1]));
}

/** Free-tier ids in `live` that the catalog lacks, as prefixed ids. */
export function missingFree(source, zenIds, goIds) {
  const have = catalogIds(source);
  const missing = [];
  for (const id of zenIds) if (/-free$/.test(id) && !have.has(`opencode/${id}`)) missing.push(`opencode/${id}`);
  for (const id of goIds) if (/-free$/.test(id) && !have.has(`opencode-go/${id}`)) missing.push(`opencode-go/${id}`);
  return missing;
}

/** Inserts the ids at the end of their category's model list. Returns the new source and what was added. */
export function applyIds(source, ids) {
  let text = source.replace(/\r\n/g, "\n");
  const have = catalogIds(text);
  const added = [];
  for (const [prefix, category] of [
    ["opencode/", "OpenCode Zen"],
    ["opencode-go/", "OpenCode Go"],
  ]) {
    const wanted = ids.filter((id) => id.startsWith(prefix) && !have.has(id));
    if (wanted.length === 0) continue;
    const at = text.indexOf(`category: "${category}"`);
    if (at < 0) throw new Error(`category ${category} not found in the catalog`);
    const close = text.indexOf("\n    ],\n", at);
    if (close < 0) throw new Error(`end of ${category} model list not found`);
    text = text.slice(0, close + 1) + wanted.map(entryLine).join("\n") + "\n" + text.slice(close + 1);
    added.push(...wanted);
  }
  return { source: source.includes("\r\n") ? text.replace(/\n/g, "\r\n") : text, added };
}

async function liveIds(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body.data)) throw new Error(`${url} answered an unexpected shape`);
  return body.data.map((entry) => String(entry.id));
}

function option(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : undefined;
}

async function main() {
  const [mode] = process.argv.slice(2);
  const modelsPath = option("models");
  if (mode === "record") {
    const state = option("state");
    if (!state) throw new Error("record needs --state");
    const known = existsSync(state) ? (JSON.parse(readFileSync(state, "utf8")).ids ?? []) : [];
    const ids = [...new Set([...known, ...(option("ids") ?? "").split(",").filter(Boolean)])];
    writeFileSync(state, JSON.stringify({ ids }, null, 2) + "\n");
    console.log(JSON.stringify({ ids }));
    return;
  }
  if (!mode || !modelsPath) throw new Error("usage: opencode-model-sync.mjs check|apply|replay --models <models.ts> ...");
  const source = readFileSync(modelsPath, "utf8");
  if (mode === "check") {
    const [zen, go] = await Promise.all([liveIds(ZEN_URL), liveIds(GO_URL)]);
    console.log(JSON.stringify({ missing: missingFree(source, zen, go) }));
    return;
  }
  if (mode === "apply" || mode === "replay") {
    let ids;
    if (mode === "apply") ids = (option("ids") ?? "").split(",").filter(Boolean);
    else {
      const state = option("state");
      ids = state && existsSync(state) ? JSON.parse(readFileSync(state, "utf8")).ids ?? [] : [];
    }
    const result = applyIds(source, ids);
    if (result.added.length > 0) writeFileSync(modelsPath, result.source);
    console.log(JSON.stringify({ added: result.added }));
    return;
  }
  throw new Error(`unknown mode ${mode}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`opencode-model-sync: ${error.message}`);
    process.exitCode = 1;
  });
}
