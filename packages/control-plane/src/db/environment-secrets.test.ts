import { describe, it, expect } from "vitest";
import { EnvironmentSecretsStore } from "./environment-secrets";
import { SecretsValidationError } from "./secrets-validation";
import type { SqlDatabase, SqlStatement } from "./sql-database";

/**
 * Fake SqlDatabase: serves `sourceRows` to the repo_secrets import SELECT, reports
 * no existing environment keys, and records the statement count of each batch
 * (a batch is the only write path, so no entry means nothing was persisted).
 */
function fakeDb(sourceRows: Array<{ key: string; encrypted_value: string }>) {
  const batches: number[] = [];
  const statement = (query: string): SqlStatement => {
    const stmt: SqlStatement = {
      bind: () => stmt,
      first: async <T>() => null as T | null,
      run: async <T>() => ({ results: [] as T[], meta: { changes: 0 } }),
      all: async <T>() => ({
        results: (query.startsWith("SELECT key, encrypted_value FROM repo_secrets")
          ? sourceRows
          : []) as T[],
        meta: { changes: 0 },
      }),
    };
    return stmt;
  };
  const db: SqlDatabase = {
    prepare: statement,
    batch: async (statements) => {
      batches.push(statements.length);
      return [];
    },
  };
  return { db, batches };
}

describe("EnvironmentSecretsStore.importFromRepo", () => {
  it("import-all refuses a legacy reserved key before any write", async () => {
    const rows = [
      { key: "GOOD_ONE", encrypted_value: "ct-1" },
      { key: "PATH", encrypted_value: "ct-2" }, // stored before PATH was reserved
      { key: "GOOD_TWO", encrypted_value: "ct-3" },
    ];
    const { db, batches } = fakeDb(rows);
    const store = new EnvironmentSecretsStore(db, "unused-key");

    await expect(store.importFromRepo("env_1", 77)).rejects.toThrow(SecretsValidationError);
    expect(batches).toEqual([]);

    // Without the legacy row, the same import-all copies the valid keys in one batch.
    rows.splice(1, 1);
    const result = await store.importFromRepo("env_1", 77);
    expect(result).toEqual({ created: 2, updated: 0, keys: ["GOOD_ONE", "GOOD_TWO"] });
    expect(batches).toEqual([2]);
  });
});
