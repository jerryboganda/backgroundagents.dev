/**
 * Bootstrap the first workspace Owner in a Node host's global SQLite store.
 *
 * The Node counterpart of scripts/bootstrap-workspace-owner.ts, which runs
 * against remote D1. It reuses that script's SQL, so the preflight, the audited
 * assignment and the postcondition are the same statements. It adds what a
 * local file needs:
 *
 * - The store must already exist. The bootstrap never creates a database.
 * - The migration ledger must record the RBAC migrations the SQL was verified
 *   against, so a store at another schema is refused rather than guessed at.
 * - A dry run (the default) opens the store read-only.
 * - An execution takes the write lock first, runs the preflight under it, and
 *   commits the audit row and the assignment together, or neither.
 *
 * Dry run:
 *   node --experimental-transform-types scripts/bootstrap-node-owner.ts \
 *     --database /data/global.db --user <canonical-user-id>
 *
 * Execute after reviewing the preflight report:
 *   node --experimental-transform-types scripts/bootstrap-node-owner.ts \
 *     --database /data/global.db --user <canonical-user-id> --execute
 *
 * Imports only node:* modules and its sibling, so the same two files run
 * inside the control-plane image, where the store lives.
 */

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  buildBootstrapSql,
  parseArgs,
  type BootstrapCliOptions,
} from "./bootstrap-workspace-owner.ts";

/** The RBAC migrations the bootstrap SQL reads: the owner role and the audit table's shape. */
const REQUIRED_MIGRATIONS = [
  "0071_rbac_foundation.sql",
  "0072_rbac_audit_fidelity.sql",
  "0073_rbac_audit_decision_outcomes.sql",
] as const;

/** The busy timeout the Node host gives its own connections (sqlite-file.ts). */
const BUSY_TIMEOUT_MS = 5_000;

type Report = Record<string, unknown>;

/** Injectable inputs for deterministic audit identity and time in tests. */
export interface NodeBootstrapDependencies {
  randomUUID?: () => string;
  now?: () => number;
}

/** What a run saw and did. `ready` is a dry run that would assign Owner. */
export interface NodeBootstrapOutcome {
  status: "ready" | "no-op" | "executed";
  reports: Report[];
}

/** Opens a store that must already exist; a missing path is an error, never a new database. */
function openExistingStore(path: string, readOnly: boolean): DatabaseSync {
  if (!statSync(path, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`No database file at ${path}; the bootstrap never creates a store.`);
  }
  const db = new DatabaseSync(path, { readOnly });
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.exec("PRAGMA foreign_keys = ON");
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/** Refuses a store whose RBAC migrations are not the ones the bootstrap SQL was verified against. */
function assertVerifiedSchema(db: DatabaseSync): void {
  const hasLedger = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_schema_migrations'")
    .get();
  if (!hasLedger) {
    throw new Error("Refused: not a migrated control-plane store (no _schema_migrations ledger).");
  }
  for (const name of REQUIRED_MIGRATIONS) {
    const recorded = db
      .prepare("SELECT name FROM _schema_migrations WHERE version = ?")
      .get(name.slice(0, 4));
    if (recorded?.name !== name) {
      throw new Error(
        `Refused: migration ${name} is not recorded; this store's RBAC schema is not verified for bootstrap.`
      );
    }
  }
}

/** Reads the single report row a bootstrap statement returns. */
function readReport(db: DatabaseSync, sql: string, report: "preflight" | "postcondition"): Report {
  const rows = db.prepare(sql).all();
  if (rows.length !== 1 || rows[0]?.report !== report) {
    throw new Error(`Owner bootstrap returned no valid ${report} report`);
  }
  return { ...rows[0] };
}

function assertNotRefused(preflight: Report): void {
  if (preflight.status === "refused") {
    throw new Error(`Owner bootstrap preflight was refused: ${String(preflight.detail)}`);
  }
}

/**
 * Run the bootstrap against a local store. A dry run only reads. An execution
 * writes inside one immediate transaction and commits only when the
 * postcondition proves the exact audit row and assignment.
 */
export function bootstrapNodeOwner(
  options: BootstrapCliOptions,
  dependencies: NodeBootstrapDependencies = {}
): NodeBootstrapOutcome {
  const sql = buildBootstrapSql({
    userId: options.userId,
    auditId: dependencies.randomUUID?.() ?? randomUUID(),
    now: dependencies.now?.() ?? Date.now(),
  });
  const db = openExistingStore(resolve(options.database), !options.execute);
  try {
    if (!options.execute) {
      assertVerifiedSchema(db);
      const preflight = readReport(db, sql.preflight, "preflight");
      assertNotRefused(preflight);
      return { status: preflight.status === "no-op" ? "no-op" : "ready", reports: [preflight] };
    }

    db.exec("BEGIN IMMEDIATE");
    try {
      assertVerifiedSchema(db);
      const preflight = readReport(db, sql.preflight, "preflight");
      assertNotRefused(preflight);
      if (preflight.status === "no-op") {
        db.exec("ROLLBACK");
        return { status: "no-op", reports: [preflight] };
      }
      const [insertAudit, assignOwner, verification] = sql.execution;
      const audit = db.prepare(insertAudit).run();
      const assignment = db.prepare(assignOwner).run();
      const postcondition = readReport(db, verification, "postcondition");
      if (
        audit.changes !== 1 ||
        assignment.changes !== 1 ||
        postcondition.status !== "executed" ||
        postcondition.audit_written !== 1
      ) {
        throw new Error(
          "Owner bootstrap did not prove its exact audit and assignment; nothing was committed."
        );
      }
      db.exec("COMMIT");
      return { status: "executed", reports: [preflight, postcondition] };
    } catch (error) {
      rollbackQuietly(db);
      throw error;
    }
  } finally {
    db.close();
  }
}

/** Roll back if a transaction is open; a failed BEGIN leaves none. */
function rollbackQuietly(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // No transaction to roll back.
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  console.error(
    `${options.execute ? "Executing" : "Dry-running"} Owner bootstrap on ${resolve(options.database)}...`
  );
  const outcome = bootstrapNodeOwner(options);
  for (const report of outcome.reports) console.log(JSON.stringify(report));
  if (outcome.status === "ready") {
    console.error("Dry run only. Re-run with --execute after reviewing the preflight result.");
  } else if (outcome.status === "no-op") {
    console.error("The selected user is already the current Owner; nothing was written.");
  } else {
    console.error("Owner bootstrap committed; rerun the dry run and expect no-op.");
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
