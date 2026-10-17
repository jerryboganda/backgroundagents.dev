import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import {
  MAX_ALLOCATED_SANDBOXES,
  openStateStore,
  type SandboxRecord,
  type StateStore,
} from "../src/state.ts";

const PROVIDER_OBJECT_ID = "a".repeat(64);
const STATE_MODULE = new URL("../src/state.ts", import.meta.url).href;

function record(overrides: Partial<SandboxRecord> = {}): SandboxRecord {
  return {
    leaseToken: "lease-1",
    sessionId: "session-1",
    sandboxId: "sandbox-1",
    status: "creating",
    providerObjectId: null,
    createdAtMs: 1,
    ...overrides,
  };
}

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "vps-executor-state-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withStore(
  stateFile: string,
  run: (store: StateStore) => void | Promise<void>
): Promise<void> {
  const store = await openStateStore(stateFile);
  try {
    await run(store);
  } finally {
    store.close();
  }
}

/** Opens the state file the way another process would, for failure injection and inspection. */
function withRawDb<T>(stateFile: string, run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(stateFile);
  try {
    return run(db);
  } finally {
    db.close();
  }
}

/** Makes the matching writes fail inside the database, as a full disk would. */
function failWritesWhen(stateFile: string, name: string, when: string): void {
  withRawDb(stateFile, (db) =>
    db.exec(
      `CREATE TRIGGER ${name} BEFORE ${when} BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END`
    )
  );
}

/** The status a lease's row holds, read through a connection that is not the owner's. */
function statusOf(stateFile: string, leaseToken: string): string | undefined {
  return withRawDb(stateFile, (db) => {
    const row = db.prepare("SELECT status FROM sandboxes WHERE lease_token = ?").get(leaseToken);
    return row === undefined ? undefined : String(row.status);
  });
}

function clearWriteFailure(stateFile: string, name: string): void {
  withRawDb(stateFile, (db) => db.exec(`DROP TRIGGER ${name}`));
}

/** Runs a node script in a child process. Resolves however it ends. */
function runChild(
  script: string,
  env: Record<string, string>
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// Opens the state file as its owner and admits one lease, then holds the file until it is killed, as a live executor does.
const OWNER_SCRIPT = `
  const { openStateStore, MAX_ALLOCATED_SANDBOXES } = await import(process.env.STATE_MODULE);
  const store = await openStateStore(process.env.STATE_FILE);
  store.admit({
    leaseToken: "lease-owner",
    sessionId: "session-owner",
    sandboxId: "sandbox-owner",
    status: "creating",
    providerObjectId: null,
    createdAtMs: 1,
  }, MAX_ALLOCATED_SANDBOXES);
  console.log("ready");
  setInterval(() => {}, 1_000);
`;

// Admits leases until the cap refuses, then reports how many this process admitted.
const ADMIT_SCRIPT = `
  const { openStateStore, MAX_ALLOCATED_SANDBOXES } = await import(process.env.STATE_MODULE);
  const store = await openStateStore(process.env.STATE_FILE);
  let admitted = 0;
  for (let n = 0; n < 25; n += 1) {
    const outcome = store.admit({
      leaseToken: process.env.TAG + "-lease-" + n,
      sessionId: "session-" + process.env.TAG,
      sandboxId: process.env.TAG + "-sandbox-" + n,
      status: "creating",
      providerObjectId: null,
      createdAtMs: 1,
    }, MAX_ALLOCATED_SANDBOXES);
    if (outcome.kind === "reserved") admitted += 1;
  }
  store.close();
  console.log(JSON.stringify({ admitted }));
`;

// Writes a reservation inside a transaction that never commits, then dies.
const CRASH_BEFORE_COMMIT_SCRIPT = `
  import { writeFileSync } from "node:fs";
  import { DatabaseSync } from "node:sqlite";
  const db = new DatabaseSync(process.env.STATE_FILE);
  db.exec("BEGIN IMMEDIATE");
  db.prepare("INSERT INTO sandboxes (lease_token, session_id, sandbox_id, status, provider_object_id, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)")
    .run("lease-1", "session-1", "sandbox-1", "creating", null, 1);
  writeFileSync(process.env.MARKER, "reached");
  process.kill(process.pid, "SIGKILL");
`;

// Admits leases under a cap of six, then reports the workspace slot each reservation bound, and when this process
// held the owner lock: from its claim to its release.
const ADMIT_SLOTS_SCRIPT = `
  const { openStateStore } = await import(process.env.STATE_MODULE);
  const store = await openStateStore(process.env.STATE_FILE);
  const claimedAt = Date.now();
  const slots = [];
  for (let n = 0; n < 25; n += 1) {
    const outcome = store.admit({
      leaseToken: process.env.TAG + "-lease-" + n,
      sessionId: "session-" + process.env.TAG,
      sandboxId: process.env.TAG + "-sandbox-" + n,
      status: "creating",
      providerObjectId: null,
      createdAtMs: 1,
    }, 6);
    if (outcome.kind === "reserved") slots.push(outcome.workspaceSlot);
  }
  const releasedAt = Date.now();
  store.close();
  console.log(JSON.stringify({ slots, claimedAt, releasedAt }));
`;

// Commits a reservation through the store, then dies.
const CRASH_AFTER_COMMIT_SCRIPT = `
  import { writeFileSync } from "node:fs";
  const { openStateStore } = await import(process.env.STATE_MODULE);
  const store = await openStateStore(process.env.STATE_FILE);
  store.admit({
    leaseToken: "lease-1",
    sessionId: "session-1",
    sandboxId: "sandbox-1",
    status: "creating",
    providerObjectId: null,
    createdAtMs: 1,
  }, 2);
  writeFileSync(process.env.MARKER, "reached");
  process.kill(process.pid, "SIGKILL");
`;

describe("openStateStore", () => {
  it("loads a create that never reported back as unresolved, still holding its slot", async () => {
    await withDir(async (dir) => {
      const stateFile = join(dir, "state.db");
      await withStore(stateFile, (store) => {
        assert.equal(store.admit(record(), MAX_ALLOCATED_SANDBOXES).kind, "reserved");
      });
      await withStore(stateFile, (store) => {
        assert.equal(store.byLease("lease-1")?.status, "unresolved");
        assert.equal(store.slotHolders().length, 1);
      });
    });
  });

  it("keeps a terminated record as a tombstone that holds no slot", async () => {
    await withDir(async (dir) => {
      const stateFile = join(dir, "state.db");
      await withStore(stateFile, (store) => {
        store.admit(record(), MAX_ALLOCATED_SANDBOXES);
        store.markRunning("lease-1", PROVIDER_OBJECT_ID);
        assert.equal(store.terminate("lease-1", PROVIDER_OBJECT_ID), true);
      });
      await withStore(stateFile, (reopened) => {
        assert.equal(reopened.byLease("lease-1")?.status, "terminated");
        assert.equal(reopened.slotHolders().length, 0);
        assert.equal(reopened.holding("sandbox-1"), undefined);
      });
    });
  });

  it("admits up to the cap and refuses the next lease without recording it", async () => {
    await withDir(async (dir) => {
      await withStore(join(dir, "state.db"), (store) => {
        assert.equal(
          store.admit(record({ leaseToken: "lease-1", sandboxId: "sandbox-1" }), 2).kind,
          "reserved"
        );
        assert.equal(
          store.admit(record({ leaseToken: "lease-2", sandboxId: "sandbox-2" }), 2).kind,
          "reserved"
        );
        assert.equal(
          store.admit(record({ leaseToken: "lease-3", sandboxId: "sandbox-3" }), 2).kind,
          "full"
        );
        assert.equal(store.byLease("lease-3"), undefined);
        assert.equal(store.slotHolders().length, 2);
      });
    });
  });

  it("refuses a second live lease for a sandbox id that is held", async () => {
    await withDir(async (dir) => {
      await withStore(join(dir, "state.db"), (store) => {
        store.admit(record(), MAX_ALLOCATED_SANDBOXES);
        const other = store.admit(
          record({ leaseToken: "lease-2", sessionId: "session-2" }),
          MAX_ALLOCATED_SANDBOXES
        );
        assert.equal(other.kind, "sandbox_held");
        assert.equal(store.byLease("lease-2"), undefined);
      });
    });
  });

  it("answers a spent lease with its record instead of admitting it again", async () => {
    await withDir(async (dir) => {
      await withStore(join(dir, "state.db"), (store) => {
        store.admit(record(), MAX_ALLOCATED_SANDBOXES);
        assert.deepEqual(store.admit(record(), MAX_ALLOCATED_SANDBOXES), {
          kind: "known",
          record: record(),
        });
      });
    });
  });

  it("rolls a reservation back when its write fails, and admits once the write can succeed", async () => {
    await withDir(async (dir) => {
      const stateFile = join(dir, "state.db");
      await withStore(stateFile, (store) => {
        failWritesWhen(stateFile, "fail_insert", "INSERT ON sandboxes");
        assert.throws(
          () => store.admit(record(), MAX_ALLOCATED_SANDBOXES),
          /simulated write failure/
        );
        assert.equal(store.byLease("lease-1"), undefined);
        assert.equal(store.slotHolders().length, 0);

        clearWriteFailure(stateFile, "fail_insert");
        assert.equal(store.admit(record(), MAX_ALLOCATED_SANDBOXES).kind, "reserved");
      });
    });
  });

  it("a failed status write leaves the previous status on disk", async () => {
    await withDir(async (dir) => {
      const stateFile = join(dir, "state.db");
      await withStore(stateFile, (store) => {
        store.admit(record(), MAX_ALLOCATED_SANDBOXES);
        failWritesWhen(
          stateFile,
          "fail_running",
          "UPDATE ON sandboxes WHEN NEW.status = 'running'"
        );
        assert.throws(
          () => store.markRunning("lease-1", PROVIDER_OBJECT_ID),
          /simulated write failure/
        );
      });
      clearWriteFailure(stateFile, "fail_running");
      const status = withRawDb(stateFile, (db) =>
        db.prepare("SELECT status FROM sandboxes WHERE lease_token = 'lease-1'").get()
      );
      assert.equal(status?.status, "creating");
    });
  });

  it("a crash before commit leaves no record", async () => {
    await withDir(async (dir) => {
      const stateFile = join(dir, "state.db");
      const marker = join(dir, "marker");
      await withStore(stateFile, () => {});
      const child = await runChild(CRASH_BEFORE_COMMIT_SCRIPT, {
        STATE_FILE: stateFile,
        MARKER: marker,
      });
      assert.ok(existsSync(marker), child.stderr);
      assert.notEqual(child.code, 0);
      await withStore(stateFile, (store) => {
        assert.equal(store.byLease("lease-1"), undefined);
        assert.equal(store.slotHolders().length, 0);
      });
    });
  });

  it("a crash after a committed reservation keeps its slot, as unresolved", async () => {
    await withDir(async (dir) => {
      const stateFile = join(dir, "state.db");
      const marker = join(dir, "marker");
      await withStore(stateFile, () => {});
      const child = await runChild(CRASH_AFTER_COMMIT_SCRIPT, {
        STATE_FILE: stateFile,
        STATE_MODULE,
        MARKER: marker,
      });
      assert.ok(existsSync(marker), child.stderr);
      assert.notEqual(child.code, 0);
      await withStore(stateFile, (store) => {
        assert.equal(store.byLease("lease-1")?.status, "unresolved");
        assert.equal(store.slotHolders().length, 1);
      });
    });
  });

  it("admits no more than the cap across processes, since one process owns the file at a time", async () => {
    await withDir(async (dir) => {
      const stateFile = join(dir, "state.db");
      await withStore(stateFile, () => {});
      const runs = await Promise.all(
        ["a", "b", "c", "d"].map((tag) =>
          runChild(ADMIT_SCRIPT, { STATE_FILE: stateFile, STATE_MODULE, TAG: tag })
        )
      );
      let total = 0;
      for (const run of runs) {
        // A process that finds another owner holding the file is refused before it admits anything.
        if (run.code !== 0) {
          assert.match(run.stderr, /owned by another running process/);
          continue;
        }
        total += (JSON.parse(run.stdout.trim()) as { admitted: number }).admitted;
      }
      assert.equal(total, MAX_ALLOCATED_SANDBOXES);
      await withStore(stateFile, (store) => {
        assert.equal(store.slotHolders().length, MAX_ALLOCATED_SANDBOXES);
      });
    });
  });

  it("refuses a state file in the JSON format of the first build", async () => {
    await withDir(async (dir) => {
      const stateFile = join(dir, "state.json");
      await writeFile(stateFile, JSON.stringify({ version: 2, sandboxes: [] }));
      await assert.rejects(openStateStore(stateFile), /unsupported format/);
    });
  });

  it("refuses a corrupt state file", async () => {
    await withDir(async (dir) => {
      const stateFile = join(dir, "state.db");
      await writeFile(stateFile, "not a database at all");
      await assert.rejects(openStateStore(stateFile));
    });
  });

  it("gives each sandbox one workspace slot, and reattaches a stopped one only to its own session", async () => {
    await withDir(async (dir) => {
      const stateFile = join(dir, "state.db");
      await withStore(stateFile, (store) => {
        assert.deepEqual(
          store.admit(record({ leaseToken: "lease-1", sandboxId: "sandbox-1" }), 10),
          {
            kind: "reserved",
            workspaceSlot: 0,
            reattached: false,
          }
        );
        assert.deepEqual(
          store.admit(
            record({ leaseToken: "lease-2", sandboxId: "sandbox-2", sessionId: "session-2" }),
            10
          ),
          { kind: "reserved", workspaceSlot: 1, reattached: false }
        );
        store.markRunning("lease-1", PROVIDER_OBJECT_ID);
        assert.equal(store.terminate("lease-1", PROVIDER_OBJECT_ID), true);
      });
      await withStore(stateFile, (store) => {
        assert.equal(
          store.admit(
            record({ leaseToken: "lease-3", sandboxId: "sandbox-1", sessionId: "session-2" }),
            10
          ).kind,
          "sandbox_held"
        );
        assert.deepEqual(
          store.admit(record({ leaseToken: "lease-4", sandboxId: "sandbox-1" }), 10),
          {
            kind: "reserved",
            workspaceSlot: 0,
            reattached: true,
          }
        );
      });
    });
  });

  it("refuses with workspace_full once every workspace is held or retained, and records nothing", async () => {
    await withDir(async (dir) => {
      const store = await openStateStore(join(dir, "state.db"), { workspaceSlots: 2 });
      try {
        assert.equal(
          store.admit(record({ leaseToken: "lease-1", sandboxId: "sandbox-1" }), 10).kind,
          "reserved"
        );
        assert.equal(
          store.admit(record({ leaseToken: "lease-2", sandboxId: "sandbox-2" }), 10).kind,
          "reserved"
        );
        assert.equal(
          store.admit(record({ leaseToken: "lease-3", sandboxId: "sandbox-3" }), 10).kind,
          "workspace_full"
        );
        assert.equal(store.byLease("lease-3"), undefined);
        store.markRunning("lease-1", PROVIDER_OBJECT_ID);
        assert.equal(store.terminate("lease-1", PROVIDER_OBJECT_ID), true);
        // A stopped sandbox keeps its workspace, so no slot is free for a new sandbox.
        assert.equal(
          store.admit(record({ leaseToken: "lease-4", sandboxId: "sandbox-4" }), 10).kind,
          "workspace_full"
        );
      } finally {
        store.close();
      }
    });
  });

  it("forget frees a fresh workspace, and leaves a retained one retained for its owner", async () => {
    await withDir(async (dir) => {
      await withStore(join(dir, "state.db"), (store) => {
        assert.equal(
          store.admit(record({ leaseToken: "lease-1", sandboxId: "sandbox-1" }), 10).kind,
          "reserved"
        );
        assert.equal(store.forget("lease-1"), true);
        assert.deepEqual(
          store.admit(record({ leaseToken: "lease-2", sandboxId: "sandbox-2" }), 10),
          {
            kind: "reserved",
            workspaceSlot: 0,
            reattached: false,
          }
        );
        store.markRunning("lease-2", PROVIDER_OBJECT_ID);
        assert.equal(store.terminate("lease-2", PROVIDER_OBJECT_ID), true);
        // A reattach that never runs gives the workspace back as retained, still owned by session-1.
        assert.equal(
          store.admit(record({ leaseToken: "lease-3", sandboxId: "sandbox-2" }), 10).kind,
          "reserved"
        );
        assert.equal(store.forget("lease-3"), true);
        assert.equal(
          store.admit(
            record({ leaseToken: "lease-4", sandboxId: "sandbox-2", sessionId: "session-2" }),
            10
          ).kind,
          "sandbox_held"
        );
        assert.deepEqual(
          store.admit(record({ leaseToken: "lease-5", sandboxId: "sandbox-2" }), 10),
          {
            kind: "reserved",
            workspaceSlot: 0,
            reattached: true,
          }
        );
      });
    });
  });

  it("a fenced forget closes the lease and its sandbox id in the same write, and frees the slot", async () => {
    await withDir(async (dir) => {
      await withStore(join(dir, "state.db"), (store) => {
        assert.equal(
          store.admit(record({ leaseToken: "lease-1", sandboxId: "sandbox-1" }), 10).kind,
          "reserved"
        );
        assert.equal(store.forget("lease-1", 5), true);
        // Neither the lease nor its sandbox id admits again, under any lease.
        assert.equal(store.settledFor("lease-1", "sandbox-1"), true);
        assert.equal(
          store.admit(record({ leaseToken: "lease-1", sandboxId: "sandbox-1" }), 10).kind,
          "settled"
        );
        assert.equal(
          store.admit(record({ leaseToken: "lease-2", sandboxId: "sandbox-1" }), 10).kind,
          "settled"
        );
        assert.deepEqual(
          store.admit(record({ leaseToken: "lease-3", sandboxId: "sandbox-2" }), 10),
          { kind: "reserved", workspaceSlot: 0, reattached: false }
        );
      });
    });
  });

  it("a fence never lands on a record that holds a container", async () => {
    await withDir(async (dir) => {
      await withStore(join(dir, "state.db"), (store) => {
        store.admit(record({ leaseToken: "lease-1", sandboxId: "sandbox-1" }), 10);
        store.markRunning("lease-1", PROVIDER_OBJECT_ID);
        assert.equal(store.forget("lease-1", 5), false);
        assert.equal(store.settledFor("lease-1", "sandbox-1"), false);
        assert.equal(store.byLease("lease-1")?.status, "running");
      });
    });
  });

  it("attaches a late container to the unresolved create that holds its slot, without making it running", async () => {
    await withDir(async (dir) => {
      await withStore(join(dir, "state.db"), (store) => {
        assert.equal(store.admit(record(), MAX_ALLOCATED_SANDBOXES).kind, "reserved");
        assert.equal(store.markUnresolved("lease-1"), true);
        assert.equal(store.attach("lease-1", PROVIDER_OBJECT_ID, 1), false);
        assert.equal(store.byLease("lease-1")?.providerObjectId, null);
        assert.equal(store.attach("lease-1", PROVIDER_OBJECT_ID, 0), true);
        // Named by its id and still unresolved: its runtime was never acknowledged here.
        assert.equal(store.byContainer(PROVIDER_OBJECT_ID)?.status, "unresolved");
        assert.equal(store.attach("lease-1", "b".repeat(64), 0), false);
      });
    });
  });

  it("adopts a container only into a free workspace, or one no session owns, and never one a session retains", async () => {
    await withDir(async (dir) => {
      await withStore(join(dir, "state.db"), (store) => {
        store.admit(record({ leaseToken: "lease-1", sandboxId: "sandbox-1" }), 10);
        store.markRunning("lease-1", PROVIDER_OBJECT_ID);
        store.terminate("lease-1", PROVIDER_OBJECT_ID);
        const orphan = (sandboxId: string, providerObjectId: string): SandboxRecord =>
          record({
            leaseToken: `reconciled:${providerObjectId}`,
            sessionId: "",
            sandboxId,
            status: "unresolved",
            providerObjectId,
          });
        // Slot 0 is retained for session-1, so no orphan takes it, not even one for its own sandbox id.
        assert.equal(store.adopt(orphan("sandbox-2", "b".repeat(64)), 0), false);
        assert.equal(store.adopt(orphan("sandbox-1", "b".repeat(64)), 0), false);
        assert.equal(store.adopt(orphan("sandbox-3", "c".repeat(64)), 1), true);
        assert.equal(store.adopt(orphan("sandbox-4", "d".repeat(64)), 1), false);
        assert.equal(store.byContainer("c".repeat(64))?.status, "unresolved");
        assert.equal(store.slotHolders().length, 1);
      });
    });
  });

  it("clears an adopted workspace only by an operator, once it is stopped, and reuses the slot", async () => {
    await withDir(async (dir) => {
      await withStore(join(dir, "state.db"), (store) => {
        const orphanId = "c".repeat(64);
        const lease = `reconciled:${orphanId}`;
        assert.equal(
          store.adopt(
            record({
              leaseToken: lease,
              sessionId: "",
              sandboxId: "sandbox-3",
              status: "unresolved",
              providerObjectId: orphanId,
            }),
            1
          ),
          true
        );
        assert.equal(store.terminate(lease, orphanId), true);
        // No session owns it, so no lease releases it, and an owner's name does not either.
        assert.equal(store.beginRelease("sandbox-3", "", lease).kind, "refused");
        assert.equal(store.beginRelease("sandbox-3", "session-1", lease).kind, "refused");
        assert.equal(store.beginOperatorRelease("sandbox-1").kind, "not_found");
        assert.deepEqual(store.beginOperatorRelease("sandbox-3"), {
          kind: "started",
          workspaceSlot: 1,
        });
        assert.equal(store.finishRelease(1), true);
        // Slot 0 was never claimed, so it is the lowest free slot. The released slot 1 is free for the next claim.
        assert.deepEqual(
          store.admit(record({ leaseToken: "lease-9", sandboxId: "sandbox-9" }), 10),
          {
            kind: "reserved",
            workspaceSlot: 0,
            reattached: false,
          }
        );
        assert.deepEqual(
          store.admit(record({ leaseToken: "lease-10", sandboxId: "sandbox-10" }), 10),
          {
            kind: "reserved",
            workspaceSlot: 1,
            reattached: false,
          }
        );
      });
    });
  });

  it("abandons an unresolved create with no container: its lease and sandbox id close, and its workspace stays with its owner", async () => {
    await withDir(async (dir) => {
      await withStore(join(dir, "state.db"), (store) => {
        store.admit(record({ leaseToken: "lease-1", sandboxId: "sandbox-1" }), 10);
        store.markUnresolved("lease-1");
        assert.deepEqual(store.abandon("sandbox-1", 5), { kind: "abandoned" });
        assert.equal(store.byLease("lease-1"), undefined);
        assert.equal(store.occupancy(), 0);
        assert.equal(store.settledFor("lease-1", "sandbox-1"), true);
        // Another session's create is refused as settled, and a stale lease cannot release the slot.
        assert.equal(
          store.admit(
            record({ leaseToken: "lease-2", sandboxId: "sandbox-1", sessionId: "session-2" }),
            10
          ).kind,
          "settled"
        );
        assert.equal(store.beginRelease("sandbox-1", "session-1", "lease-2").kind, "refused");
        assert.deepEqual(store.beginRelease("sandbox-1", "session-1", "lease-1"), {
          kind: "started",
          workspaceSlot: 0,
        });
        assert.equal(store.finishRelease(0), true);
        assert.deepEqual(
          store.admit(record({ leaseToken: "lease-3", sandboxId: "sandbox-2" }), 10),
          {
            kind: "reserved",
            workspaceSlot: 0,
            reattached: false,
          }
        );
      });
    });
  });

  it("refuses to abandon a create that is in flight, one that holds a container, or an unknown sandbox", async () => {
    await withDir(async (dir) => {
      await withStore(join(dir, "state.db"), (store) => {
        store.admit(record(), MAX_ALLOCATED_SANDBOXES);
        assert.deepEqual(store.abandon("sandbox-1", 5), { kind: "creating" });
        store.markUnresolved("lease-1", PROVIDER_OBJECT_ID);
        assert.deepEqual(store.abandon("sandbox-1", 5), { kind: "container_known" });
        assert.deepEqual(store.abandon("sandbox-9", 5), { kind: "not_found" });
        assert.equal(store.byLease("lease-1")?.status, "unresolved");
      });
    });
  });

  it("never lets an abandon and a late attach of one create both win", async () => {
    await withDir(async (dir) => {
      await withStore(join(dir, "state.db"), (store) => {
        // The container lands first: the abandon judges it and refuses.
        store.admit(
          record({ leaseToken: "lease-1", sandboxId: "sandbox-1" }),
          MAX_ALLOCATED_SANDBOXES
        );
        store.markUnresolved("lease-1");
        assert.equal(store.attach("lease-1", PROVIDER_OBJECT_ID, 0), true);
        assert.deepEqual(store.abandon("sandbox-1", 5), { kind: "container_known" });

        // The abandon lands first: the late attach finds no record, so the create stays closed.
        store.admit(
          record({ leaseToken: "lease-2", sandboxId: "sandbox-2" }),
          MAX_ALLOCATED_SANDBOXES
        );
        store.markUnresolved("lease-2");
        assert.deepEqual(store.abandon("sandbox-2", 5), { kind: "abandoned" });
        const late = "b".repeat(64);
        assert.equal(store.attach("lease-2", late, 1), false);
        assert.equal(
          store.adopt(
            record({
              leaseToken: `reconciled:${late}`,
              sessionId: "",
              sandboxId: "sandbox-2",
              status: "unresolved",
              providerObjectId: late,
            }),
            1
          ),
          false
        );
      });
    });
  });

  it("refuses a second owner while the first holds the file, and leaves its creating row as it was", async () => {
    await withDir(async (dir) => {
      const file = join(dir, "state.db");
      const first = await openStateStore(file);
      try {
        first.admit(
          record({ leaseToken: "lease-1", sandboxId: "sandbox-1" }),
          MAX_ALLOCATED_SANDBOXES
        );
        await assert.rejects(openStateStore(file), /owned by another running process/);
        assert.equal(first.byLease("lease-1")?.status, "creating");
        assert.equal(statusOf(file, "lease-1"), "creating");
      } finally {
        first.close();
      }
    });
  });

  it("keeps a live owner's creating row through another process's open, and converts it once the owner dies", async () => {
    await withDir(async (dir) => {
      const file = join(dir, "state.db");
      const owner = spawn(process.execPath, ["--input-type=module", "-e", OWNER_SCRIPT], {
        env: { ...process.env, STATE_FILE: file, STATE_MODULE },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const exited = new Promise<void>((resolve) => owner.once("exit", () => resolve()));
      try {
        await new Promise<void>((resolve, reject) => {
          owner.once("exit", () => reject(new Error("the owner exited before it held the file")));
          owner.stdout.setEncoding("utf8");
          owner.stdout.once("data", () => resolve());
        });
        await assert.rejects(openStateStore(file), /owned by another running process/);
        assert.equal(statusOf(file, "lease-owner"), "creating");
      } finally {
        owner.kill("SIGKILL");
        await exited;
      }

      // The OS released the dead owner's lock, so the next owner converts its create. The slot stays held.
      const next = await openStateStore(file);
      try {
        assert.equal(next.byLease("lease-owner")?.status, "unresolved");
        assert.equal(next.occupancy(), 1);
      } finally {
        next.close();
      }
    });
  });

  it("holds the slot of an orphan whose sandbox id is closed for operator cleanup, so the next sandbox binds another slot", async () => {
    await withDir(async (dir) => {
      await withStore(join(dir, "state.db"), (store) => {
        store.admit(record({ leaseToken: "lease-1", sandboxId: "sandbox-1" }), 10);
        store.markUnresolved("lease-1");
        assert.deepEqual(store.abandon("sandbox-1", 5), { kind: "abandoned" });
        assert.deepEqual(store.beginRelease("sandbox-1", "session-1", "lease-1"), {
          kind: "started",
          workspaceSlot: 0,
        });
        assert.equal(store.finishRelease(0), true);
        // A container docker still shows under the closed id is never adopted as running. Its slot waits for cleanup.
        const orphanId = "c".repeat(64);
        assert.equal(
          store.adopt(
            record({
              leaseToken: `reconciled:${orphanId}`,
              sessionId: "",
              sandboxId: "sandbox-1",
              status: "unresolved",
              providerObjectId: orphanId,
            }),
            0
          ),
          false
        );
        assert.deepEqual(
          store.admit(record({ leaseToken: "lease-2", sandboxId: "sandbox-2" }), 10),
          {
            kind: "reserved",
            workspaceSlot: 1,
            reattached: false,
          }
        );
        assert.deepEqual(store.beginOperatorRelease("sandbox-1"), {
          kind: "started",
          workspaceSlot: 0,
        });
        assert.equal(store.finishRelease(0), true);
        assert.deepEqual(
          store.admit(record({ leaseToken: "lease-3", sandboxId: "sandbox-3" }), 10),
          {
            kind: "reserved",
            workspaceSlot: 0,
            reattached: false,
          }
        );
      });
    });
  });

  it("starts a release only for the owning session and the lease that retained the workspace", async () => {
    await withDir(async (dir) => {
      await withStore(join(dir, "state.db"), (store) => {
        store.admit(record({ leaseToken: "lease-1", sandboxId: "sandbox-1" }), 10);
        store.markRunning("lease-1", PROVIDER_OBJECT_ID);
        assert.deepEqual(store.beginRelease("sandbox-1", "session-1", "lease-1"), {
          kind: "active",
        });
        store.terminate("lease-1", PROVIDER_OBJECT_ID);

        assert.deepEqual(store.beginRelease("sandbox-1", "session-2", "lease-1"), {
          kind: "refused",
        });
        assert.deepEqual(store.beginRelease("sandbox-1", "session-1", "lease-0"), {
          kind: "refused",
        });
        assert.deepEqual(store.beginRelease("sandbox-9", "session-1", "lease-1"), {
          kind: "not_found",
        });

        assert.deepEqual(store.beginRelease("sandbox-1", "session-1", "lease-1"), {
          kind: "started",
          workspaceSlot: 0,
        });
        // A resetting slot binds nothing, and repeating the release resumes the same slot.
        assert.equal(
          store.admit(record({ leaseToken: "lease-2", sandboxId: "sandbox-1" }), 10).kind,
          "workspace_busy"
        );
        assert.deepEqual(store.beginRelease("sandbox-1", "session-1", "lease-1"), {
          kind: "started",
          workspaceSlot: 0,
        });

        assert.equal(store.finishRelease(0), true);
        assert.equal(store.finishRelease(0), false);
        assert.deepEqual(
          store.admit(record({ leaseToken: "lease-2", sandboxId: "sandbox-1" }), 10),
          {
            kind: "reserved",
            workspaceSlot: 0,
            reattached: false,
          }
        );
      });
    });
  });

  it("never binds one workspace slot twice across processes, since one process owns the file at a time", async () => {
    await withDir(async (dir) => {
      const stateFile = join(dir, "state.db");
      await withStore(stateFile, () => {});
      const runs = await Promise.all(
        ["a", "b", "c", "d"].map((tag) =>
          runChild(ADMIT_SLOTS_SCRIPT, { STATE_FILE: stateFile, STATE_MODULE, TAG: tag })
        )
      );
      const slots: number[] = [];
      const owners: { claimedAt: number; releasedAt: number }[] = [];
      for (const run of runs) {
        // A process that finds another owner holding the file is refused before it binds anything.
        if (run.code !== 0) {
          assert.match(run.stderr, /owned by another running process/);
          continue;
        }
        const report = JSON.parse(run.stdout.trim()) as {
          slots: number[];
          claimedAt: number;
          releasedAt: number;
        };
        slots.push(...report.slots);
        owners.push({ claimedAt: report.claimedAt, releasedAt: report.releasedAt });
      }
      assert.deepEqual(
        [...slots].sort((a, b) => a - b),
        [0, 1, 2, 3, 4, 5]
      );
      // Each owner holds the file from its claim to its release, and the next claims it only after that release.
      owners.sort((a, b) => a.claimedAt - b.claimedAt);
      for (let i = 1; i < owners.length; i += 1)
        assert.ok(
          owners[i - 1].releasedAt <= owners[i].claimedAt,
          "two processes held the state file's owner lock at once"
        );
      await withStore(stateFile, (store) => {
        assert.equal(store.slotHolders().length, 6);
      });
    });
  });

  it("refuses a state file from before workspace slots, one holding more slots than configured, and a bad count", async () => {
    await withDir(async (dir) => {
      const legacy = join(dir, "legacy.db");
      const db = new DatabaseSync(legacy);
      db.exec(
        "CREATE TABLE sandboxes (lease_token TEXT PRIMARY KEY, session_id TEXT NOT NULL, sandbox_id TEXT NOT NULL, status TEXT NOT NULL, provider_object_id TEXT, created_at_ms INTEGER NOT NULL)"
      );
      db.close();
      await assert.rejects(openStateStore(legacy), /unsupported format/);

      const wide = join(dir, "wide.db");
      await withStore(wide, () => {});
      await assert.rejects(openStateStore(wide, { workspaceSlots: 2 }), /more workspace slots/);
      await assert.rejects(
        openStateStore(join(dir, "bad.db"), { workspaceSlots: 7 }),
        /invalid workspace slot count/
      );
    });
  });
});

describe("retired containers and orphaned creates", () => {
  it("forgetRemoved frees a fresh claim and retires its container id, so a stale listing cannot adopt it", async () => {
    await withDir(async (dir) => {
      await withStore(join(dir, "state.db"), (store) => {
        assert.equal(
          store.admit(record({ leaseToken: "lease-1", sandboxId: "sandbox-1" }), 10).kind,
          "reserved"
        );
        assert.equal(store.retiredContainer(PROVIDER_OBJECT_ID), false);
        assert.equal(store.forgetRemoved("lease-1", PROVIDER_OBJECT_ID), true);
        assert.equal(store.byLease("lease-1"), undefined);
        assert.equal(store.retiredContainer(PROVIDER_OBJECT_ID), true);
        assert.equal(store.retiredContainer("b".repeat(64)), false);
        // The slot went back to free, so the next claim is fresh and takes slot 0 again.
        assert.deepEqual(
          store.admit(record({ leaseToken: "lease-2", sandboxId: "sandbox-2" }), 10),
          {
            kind: "reserved",
            workspaceSlot: 0,
            reattached: false,
          }
        );
      });
    });
  });

  it("forgetRemoved keeps a reattached claim retained for its owner, under the lease that retained it", async () => {
    await withDir(async (dir) => {
      await withStore(join(dir, "state.db"), (store) => {
        assert.equal(
          store.admit(record({ leaseToken: "lease-1", sandboxId: "sandbox-1" }), 10).kind,
          "reserved"
        );
        store.markRunning("lease-1", PROVIDER_OBJECT_ID);
        assert.equal(store.terminate("lease-1", PROVIDER_OBJECT_ID), true);
        assert.equal(store.retiredContainer(PROVIDER_OBJECT_ID), true);
        assert.deepEqual(
          store.admit(record({ leaseToken: "lease-2", sandboxId: "sandbox-1" }), 10),
          {
            kind: "reserved",
            workspaceSlot: 0,
            reattached: true,
          }
        );
        assert.equal(store.forgetRemoved("lease-2", PROVIDER_OBJECT_ID), true);
        // Still retained for session-1: another session is refused, and the owner's release names lease-1.
        assert.equal(
          store.admit(
            record({ leaseToken: "lease-3", sandboxId: "sandbox-1", sessionId: "session-2" }),
            10
          ).kind,
          "sandbox_held"
        );
        assert.deepEqual(store.beginRelease("sandbox-1", "session-1", "lease-1"), {
          kind: "started",
          workspaceSlot: 0,
        });
      });
    });
  });

  it("settles a creating record that no request runs as unresolved, and leaves the ones in flight", async () => {
    await withDir(async (dir) => {
      await withStore(join(dir, "state.db"), (store) => {
        store.admit(record({ leaseToken: "lease-1", sandboxId: "sandbox-1" }), 10);
        store.admit(record({ leaseToken: "lease-2", sandboxId: "sandbox-2" }), 10);
        assert.equal(store.unresolveOrphans(new Set(["lease-1"])), 1);
        assert.equal(store.byLease("lease-1")?.status, "creating");
        assert.equal(store.byLease("lease-2")?.status, "unresolved");
        assert.equal(store.unresolveOrphans(new Set(["lease-1"])), 0);
        // Unresolved creates hold their slots, so both still count toward the cap.
        assert.equal(store.occupancy(), 2);
        assert.equal(store.unresolveOrphans(new Set()), 1);
        assert.equal(store.byLease("lease-1")?.status, "unresolved");
      });
    });
  });
});
