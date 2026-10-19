import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { applyIds, catalogIds, displayName, missingFree } from "./opencode-model-sync.mjs";

const CATALOG = `export const MODEL_OPTIONS = [
  {
    category: "OpenCode Zen",
    enabledByDefault: false,
    models: [
      { id: "opencode/kimi-k3", name: "Kimi K3", description: "Moonshot AI" },
      { id: "opencode/big-pickle", name: "Big Pickle (free)", description: "OpenCode free tier" },
    ],
  },
  {
    category: "OpenCode Go",
    enabledByDefault: false,
    models: [
      { id: "opencode-go/kimi-k3", name: "Kimi K3", description: "Moonshot AI" },
    ],
  },
];
`;

describe("opencode model sync", () => {
  it("names a model from its id", () => {
    assert.equal(displayName("minimax-m3.1-flash-free"), "Minimax M3.1 Flash (free)");
    assert.equal(displayName("space-bunny-free"), "Space Bunny (free)");
  });

  it("finds only free-tier models the catalog lacks, per gateway", () => {
    const missing = missingFree(CATALOG, ["kimi-k3", "new-thing-free", "paid-model"], ["kimi-k3", "new-thing-free", "go-only-free"]);
    assert.deepEqual(missing, ["opencode/new-thing-free", "opencode-go/new-thing-free", "opencode-go/go-only-free"]);
  });

  it("inserts each id at the end of its own category and is idempotent", () => {
    const ids = ["opencode/new-thing-free", "opencode-go/new-thing-free"];
    const first = applyIds(CATALOG, ids);
    assert.deepEqual(first.added, ids);
    const have = catalogIds(first.source);
    assert.ok(have.has("opencode/new-thing-free") && have.has("opencode-go/new-thing-free"));
    // The Zen entry sits before the Go category, the Go entry after it.
    assert.ok(first.source.indexOf("opencode/new-thing-free") < first.source.indexOf('category: "OpenCode Go"'));
    assert.ok(first.source.indexOf("opencode-go/new-thing-free") > first.source.indexOf('category: "OpenCode Go"'));
    assert.deepEqual(applyIds(first.source, ids).added, []);
  });

  it("keeps CRLF files CRLF", () => {
    const crlf = CATALOG.replace(/\n/g, "\r\n");
    const result = applyIds(crlf, ["opencode/x-free"]);
    assert.ok(result.source.includes("\r\n") && !/[^\r]\n/.test(result.source));
  });
});
