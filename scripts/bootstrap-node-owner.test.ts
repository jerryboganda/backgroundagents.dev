import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { applyMigrations } from "../packages/control-plane/src/node/migrate.ts";
import { bootstrapNodeOwner } from "./bootstrap-node-owner.ts";

// The stores are built by the real migration runner from the same SQL the
// control plane applies at boot, so the bootstrap is tested against the schema
// and roles it will meet in production, not a hand-written imitation of them.
const MIGRATIONS_DIR = fileURLToPath(new URL("../terraform/d1/migrations/", import.meta.url));
const SCRIPT = fileURLToPath(new URL("./bootstrap-node-owner.ts", import.meta.url));
const SHARED_RBAC = fileURLToPath(new URL("../packages/shared/src/rbac.ts", import.meta.url));

const USER_ID = "11111111111111111111111111111111";
const OTHER_USER_ID = "22222222222222222222222222222222";
const MISSING_USER_ID = "33333333333333333333333333333333";
const AUDIT_ACTION = "workspace.owner_bootstrapped";

let workdir: string;
let template: string;
let storeCount = 0;
let storePath: string;

before(() => {
  workdir = mkdtempSync(join(tmpdir(), "owner-bootstrap-"));
  template = join(workdir, "template.db");
  const db = new DatabaseSync(template);
  try {
    db.exec("PRAGMA journal_mode = WAL");
    applyMigrations(db, MIGRATIONS_DIR);
    // Migration 0071's insert trigger gives the user the Member role.
    db.prepare("INSERT INTO users (id, created_at, updated_at) VALUES (?, 1, 1)").run(USER_ID);
  } finally {
    db.close();
  }
});

after(() => {
  rmSync(workdir, { recursive: true, force: true });
});

beforeEach(() => {
  storePath = join(workdir, `store-${++storeCount}.db`);
  copyFileSync(template, storePath);
});

function withStore<T>(path: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function roleOf(path: string, userId: string): unknown {
  return withStore(
    path,
    (db) =>
      db.prepare("SELECT role_id FROM user_role_assignments WHERE user_id = ?").get(userId)?.role_id
  );
}

function bootstrapAuditCount(path: string): number {
  return withStore(
    path,
    (db) =>
      db
        .prepare("SELECT COUNT(*) AS count FROM authorization_audit_events WHERE action = ?")
        .get(AUDIT_ACTION)!.count as number
  );
}

/** Adds a user who already holds the Owner role, bypassing the bootstrap under test. */
function addOwner(path: string, userId: string): void {
  withStore(path, (db) => {
    db.prepare("INSERT INTO users (id, created_at, updated_at) VALUES (?, 1, 1)").run(userId);
    db.prepare(
      "UPDATE user_role_assignments SET role_id = 'role_builtin_owner' WHERE user_id = ?"
    ).run(userId);
  });
}

function suspend(path: string, userId: string): void {
  withStore(path, (db) => {
    db.prepare("UPDATE users SET suspended_at = 1 WHERE id = ?").run(userId);
  });
}

function execute(path: string, userId = USER_ID) {
  return bootstrapNodeOwner(
    { database: path, userId, execute: true },
    { randomUUID: () => "audit-test", now: () => 100 }
  );
}

function dryRun(path: string, userId = USER_ID) {
  return bootstrapNodeOwner({ database: path, userId, execute: false });
}

function cli(...args: string[]) {
  return spawnSync(process.execPath, ["--experimental-transform-types", SCRIPT, ...args], {
    encoding: "utf8",
  });
}

describe("Node Owner bootstrap against a migrated store", () => {
  it("dry run reports ready and writes nothing", () => {
    const outcome = dryRun(storePath);

    assert.equal(outcome.status, "ready");
    assert.equal(outcome.reports[0]?.status, "ready");
    assert.equal(roleOf(storePath, USER_ID), "role_builtin_member");
    assert.equal(bootstrapAuditCount(storePath), 0);
  });

  it("execute assigns Owner and commits one redacted audit that survives reopening", () => {
    const outcome = execute(storePath);

    assert.equal(outcome.status, "executed");
    assert.equal(roleOf(storePath, USER_ID), "role_builtin_owner");
    const audit = withStore(storePath, (db) => ({
      ...db.prepare("SELECT * FROM authorization_audit_events WHERE action = ?").get(AUDIT_ACTION),
    })) as Record<string, unknown>;
    assert.deepEqual(
      {
        id: audit.id,
        occurred_at: audit.occurred_at,
        request_id: audit.request_id,
        principal_kind: audit.principal_kind,
        actor_user_id_snapshot: audit.actor_user_id_snapshot,
        actor_service_snapshot: audit.actor_service_snapshot,
        resource_type: audit.resource_type,
        resource_id: audit.resource_id,
        target_user_id_snapshot: audit.target_user_id_snapshot,
        reason_code: audit.reason_code,
        operation_result: audit.operation_result,
        metadata: JSON.parse(String(audit.metadata_json)),
      },
      {
        id: "audit-test",
        occurred_at: 100,
        request_id: "operator-cli:audit-test",
        principal_kind: "service",
        actor_user_id_snapshot: null,
        actor_service_snapshot: "operator-cli",
        resource_type: "workspace",
        resource_id: null,
        target_user_id_snapshot: USER_ID,
        reason_code: "operator_cli",
        operation_result: "applied",
        metadata: {
          before: { roleId: "role_builtin_member" },
          requested: { roleId: "role_builtin_owner" },
          after: { roleId: "role_builtin_owner" },
        },
      }
    );
  });

  it("a second execution is a no-op that writes nothing more", () => {
    execute(storePath);
    const again = execute(storePath);

    assert.equal(again.status, "no-op");
    assert.equal(roleOf(storePath, USER_ID), "role_builtin_owner");
    assert.equal(bootstrapAuditCount(storePath), 1);
  });

  it("refuses while another unsuspended Owner exists, and writes nothing", () => {
    addOwner(storePath, OTHER_USER_ID);

    assert.throws(() => dryRun(storePath), /another unsuspended Owner/);
    assert.throws(() => execute(storePath), /another unsuspended Owner/);
    assert.equal(roleOf(storePath, USER_ID), "role_builtin_member");
    assert.equal(bootstrapAuditCount(storePath), 0);
  });

  it("allows the bootstrap once the other Owner is suspended", () => {
    addOwner(storePath, OTHER_USER_ID);
    suspend(storePath, OTHER_USER_ID);

    assert.equal(execute(storePath).status, "executed");
    assert.equal(roleOf(storePath, USER_ID), "role_builtin_owner");
  });

  it("refuses a suspended target and writes nothing", () => {
    suspend(storePath, USER_ID);

    assert.throws(() => execute(storePath), /target user is suspended/);
    assert.equal(roleOf(storePath, USER_ID), "role_builtin_member");
    assert.equal(bootstrapAuditCount(storePath), 0);
  });

  it("refuses a user that does not exist", () => {
    assert.throws(() => execute(storePath, MISSING_USER_ID), /does not exist exactly once/);
    assert.equal(bootstrapAuditCount(storePath), 0);
  });

  it("rolls back the audit row when the assignment write fails", () => {
    withStore(storePath, (db) => {
      db.exec(`CREATE TRIGGER fail_owner_assignment BEFORE UPDATE ON user_role_assignments
        BEGIN SELECT RAISE(ABORT, 'simulated assignment failure'); END;`);
    });

    assert.throws(() => execute(storePath), /simulated assignment failure/);
    assert.equal(roleOf(storePath, USER_ID), "role_builtin_member");
    assert.equal(bootstrapAuditCount(storePath), 0);
  });

  it("refuses a store whose audit table is missing the RBAC shape", () => {
    withStore(storePath, (db) => {
      db.exec("DROP TABLE authorization_audit_events");
    });

    assert.throws(() => dryRun(storePath), /required RBAC schema is missing/);
    assert.throws(() => execute(storePath), /required RBAC schema is missing/);
    assert.equal(roleOf(storePath, USER_ID), "role_builtin_member");
  });

  it("refuses a store whose recorded RBAC migration name differs from the verified file", () => {
    withStore(storePath, (db) => {
      db.prepare("UPDATE _schema_migrations SET name = 'renamed.sql' WHERE version = '0072'").run();
    });

    assert.throws(() => dryRun(storePath), /0072_rbac_audit_fidelity\.sql is not recorded/);
    assert.throws(() => execute(storePath), /0072_rbac_audit_fidelity\.sql is not recorded/);
    assert.equal(roleOf(storePath, USER_ID), "role_builtin_member");
  });

  it("refuses a database that was never migrated by the control plane", () => {
    const bare = join(workdir, "bare.db");
    withStore(bare, (db) => {
      db.exec("CREATE TABLE users (id TEXT PRIMARY KEY)");
    });

    assert.throws(() => dryRun(bare), /not a migrated control-plane store/);
  });

  it("never creates a missing store", () => {
    const absent = join(workdir, "absent.db");

    assert.throws(() => dryRun(absent), /never creates a store/);
    assert.throws(() => execute(absent), /never creates a store/);
    assert.equal(existsSync(absent), false);
  });

  it("uses the Owner role id the shared RBAC registry defines", () => {
    assert.match(
      readFileSync(SHARED_RBAC, "utf8"),
      /owner: \{\s*id: "role_builtin_owner",\s*key: "owner",/
    );
  });
});

describe("Node Owner bootstrap CLI", () => {
  it("dry run prints the preflight as JSON, exits 0, and writes nothing", () => {
    const result = cli("--database", storePath, "--user", USER_ID);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"status":"ready"/);
    assert.equal(roleOf(storePath, USER_ID), "role_builtin_member");
  });

  it("execute exits 0, and a repeat run reports no-op", () => {
    const first = cli("--database", storePath, "--user", USER_ID, "--execute");
    const second = cli("--database", storePath, "--user", USER_ID, "--execute");

    assert.equal(first.status, 0, first.stderr);
    assert.equal(roleOf(storePath, USER_ID), "role_builtin_owner");
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /"status":"no-op"/);
    assert.equal(bootstrapAuditCount(storePath), 1);
  });

  it("refused execution exits 1 with the reason and writes nothing", () => {
    addOwner(storePath, OTHER_USER_ID);
    const result = cli("--database", storePath, "--user", USER_ID, "--execute");

    assert.equal(result.status, 1);
    assert.match(result.stderr, /another unsuspended Owner/);
    assert.equal(roleOf(storePath, USER_ID), "role_builtin_member");
  });

  it("rejects a non-canonical user id before touching the store, even with --execute", () => {
    const result = cli("--database", storePath, "--user", "owner@example.com", "--execute");

    assert.equal(result.status, 1);
    assert.match(result.stderr, /canonical/);
    assert.equal(roleOf(storePath, USER_ID), "role_builtin_member");
  });

  it("requires --user", () => {
    const result = cli("--database", storePath);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /--user is required/);
  });
});
