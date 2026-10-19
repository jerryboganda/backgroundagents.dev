import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  checkHome,
  checkSlot,
  emptyChild,
  isWorkspaceRoot,
  prepareHome,
  repairHomeMode,
  repairSlotRoot,
  resetSlot,
  WORKSPACE_GID,
  WORKSPACE_SLOT_BYTES,
  WORKSPACE_UID,
  workspaceMount,
  type HomeFacts,
  type SlotFacts,
} from "../src/workspace.ts";

const GIB = 1024 ** 3;

/** The facts host setup produces for a slot it got right. Each test changes one field. */
const PROVISIONED: SlotFacts = {
  realDirectory: true,
  dev: 2049,
  parentDev: 2048,
  fsType: 0xef53,
  totalBytes: WORKSPACE_SLOT_BYTES - 200 * 1024 * 1024,
  uid: WORKSPACE_UID,
  gid: WORKSPACE_GID,
  mode: 0o755,
};

/** A probe that reports the provisioned facts with the given fields changed. */
function probeWith(changes: Partial<SlotFacts>): () => Promise<SlotFacts> {
  return async () => ({ ...PROVISIONED, ...changes });
}

describe("checkSlot", () => {
  it("accepts a slot with the facts host setup provisions", async () => {
    await checkSlot("/srv/vps-ws/slots/0", probeWith({}));
  });

  it("fails closed on each fact the host must prove", async () => {
    const unproven: Array<[string, Partial<SlotFacts>]> = [
      ["not a real directory", { realDirectory: false }],
      ["not a separate mount", { dev: 2048 }],
      ["not ext4", { fsType: 0x9123683e }],
      ["a smaller image", { totalBytes: GIB }],
      ["a larger image", { totalBytes: 11 * GIB }],
      ["the wrong owner", { uid: 0 }],
      ["the wrong group", { gid: 0 }],
      ["group-writable", { mode: 0o775 }],
      ["world-writable", { mode: 0o757 }],
      ["no owner write", { mode: 0o555 }],
    ];
    for (const [label, changes] of unproven) {
      await assert.rejects(
        checkSlot("/srv/vps-ws/slots/0", probeWith(changes)),
        /workspace slot unavailable/,
        label
      );
    }
  });

  it("fails closed when the probe cannot see the slot, such as a missing mount point", async () => {
    const missing = async (): Promise<SlotFacts> => {
      throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
    };
    await assert.rejects(checkSlot("/srv/vps-ws/slots/0", missing), /ENOENT/);
  });
});

describe("workspaceMount and isWorkspaceRoot", () => {
  it("builds the slot path from the integer slot alone", () => {
    assert.deepEqual(workspaceMount("/srv/vps-ws/slots", 2), {
      slot: 2,
      hostPath: join("/srv/vps-ws/slots", "2"),
    });
    for (const slot of [-1, 1.5, 16, Number.NaN])
      assert.throws(() => workspaceMount("/srv/vps-ws/slots", slot), /invalid workspace slot/);
  });

  it("accepts only absolute, normalized roots", () => {
    assert.equal(isWorkspaceRoot("/srv/vps-ws/slots"), true);
    for (const root of [
      "srv/vps-ws",
      "/srv/vps-ws/",
      "/srv/../x",
      "/srv/./x",
      "/",
      "/srv/x y",
      "/srv/x,y",
      "",
    ])
      assert.equal(isWorkspaceRoot(root), false, root);
  });
});

describe("resetSlot", () => {
  it("empties a lost+found the tenant made below the slot root, and the slot root keeps only the filesystem's own", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vps-slot-"));
    try {
      const slot = join(dir, "slot");
      await mkdir(join(slot, "project", "lost+found"), { recursive: true });
      await writeFile(join(slot, "project", "lost+found", "data.txt"), "data");

      await resetSlot(slot);

      assert.deepEqual(await readdir(slot), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("empties the slot and never follows a link out of it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vps-slot-"));
    try {
      const slot = join(dir, "slot");
      const outside = join(dir, "outside");
      await mkdir(slot);
      await mkdir(outside);
      await writeFile(join(outside, "canary.txt"), "keep");
      await mkdir(join(slot, "nested", "deeper"), { recursive: true });
      await writeFile(join(slot, "nested", "deeper", "data.txt"), "data");
      // A directory link out of the slot: a junction on Windows, a symlink elsewhere.
      await symlink(outside, join(slot, "escape"), "junction");

      await resetSlot(slot);

      assert.deepEqual(await readdir(slot), []);
      assert.equal(await readFile(join(outside, "canary.txt"), "utf8"), "keep");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("repairSlotRoot and reset of read-only trees", () => {
  // Permission bits are POSIX only, so the mode assertions run on Linux, where the executor is deployed.
  const POSIX = process.platform !== "win32";

  it("restores a slot root the sandbox widened, once its identity is proven, and never touches an unproven one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vps-slot-"));
    try {
      const slot = join(dir, "slot");
      await mkdir(slot);
      await chmod(slot, 0o777);
      await repairSlotRoot(slot, probeWith({ mode: 0o777 }));
      if (POSIX) assert.equal((await stat(slot)).mode & 0o777, 0o755);

      await chmod(slot, 0o777);
      await assert.rejects(
        repairSlotRoot(slot, probeWith({ dev: PROVISIONED.parentDev })),
        /not a separate mount/
      );
      if (POSIX) assert.equal((await stat(slot)).mode & 0o777, 0o777);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("empties a tree the sandbox left read-only, and never follows a link out of it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vps-slot-"));
    try {
      const slot = join(dir, "slot");
      const outside = join(dir, "outside");
      await mkdir(outside);
      await writeFile(join(outside, "canary.txt"), "keep");
      // A Go module cache: nested directories created read-only, as the go tool leaves them.
      const module = join(slot, "go", "pkg", "mod", "example.com", "lib@v1");
      await mkdir(module, { recursive: true });
      await writeFile(join(module, "lib.go"), "package lib");
      await symlink(outside, join(module, "escape"), "junction");
      await chmod(module, 0o555);
      await chmod(join(slot, "go", "pkg", "mod", "example.com"), 0o555);

      await resetSlot(slot);

      assert.deepEqual(await readdir(slot), []);
      assert.equal(await readFile(join(outside, "canary.txt"), "utf8"), "keep");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it(
    "restores a root and a directory the sandbox made unreadable, then empties them",
    { skip: !POSIX && "permission bits are POSIX only" },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "vps-slot-"));
      try {
        const slot = join(dir, "slot");
        const locked = join(slot, "locked");
        await mkdir(locked, { recursive: true });
        await writeFile(join(locked, "data.txt"), "data");
        await chmod(locked, 0o000);
        await chmod(slot, 0o000);

        await repairSlotRoot(slot, probeWith({ mode: 0 }));
        assert.equal((await stat(slot)).mode & 0o777, 0o755);
        await resetSlot(slot);
        assert.deepEqual(await readdir(slot), []);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  );

  it(
    "never chmods through a link that replaces the slot root after the probe",
    { skip: !POSIX && "permission bits are POSIX only" },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "vps-slot-"));
      try {
        const slot = join(dir, "slot");
        const outside = join(dir, "outside");
        await mkdir(outside);
        await chmod(outside, 0o777);
        await symlink(outside, slot, "junction");

        await assert.rejects(repairSlotRoot(slot, probeWith({ mode: 0o777 })));
        assert.equal((await stat(outside)).mode & 0o777, 0o777);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  );

  it(
    "never chmods a link that replaces an entry after the walk read it",
    { skip: !POSIX && "permission bits are POSIX only" },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "vps-slot-"));
      try {
        const slot = join(dir, "slot");
        const outside = join(dir, "outside");
        const locked = join(slot, "locked");
        await mkdir(outside);
        await writeFile(join(outside, "canary.txt"), "keep");
        await chmod(outside, 0o555);
        await mkdir(locked, { recursive: true });
        await chmod(locked, 0o000);
        // The walk read `locked` as a directory that needs its mode repaired. Before the entry is opened, the sandbox
        // swaps in a link to `outside`.
        const entry = await lstat(locked);
        await chmod(locked, 0o700);
        await rm(locked, { recursive: true });
        await symlink(outside, locked, "junction");
        try {
          await assert.rejects(emptyChild(locked, entry, entry.dev));
          assert.equal((await stat(outside)).mode & 0o777, 0o555);
          assert.equal(await readFile(join(outside, "canary.txt"), "utf8"), "keep");
        } finally {
          await chmod(outside, 0o755);
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  );

  it(
    "never follows a link out of a directory the sandbox made unreadable",
    { skip: !POSIX && "permission bits are POSIX only" },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "vps-slot-"));
      try {
        const slot = join(dir, "slot");
        const outside = join(dir, "outside");
        const locked = join(slot, "locked");
        await mkdir(outside);
        await writeFile(join(outside, "canary.txt"), "keep");
        await mkdir(locked, { recursive: true });
        await symlink(outside, join(locked, "escape"), "junction");
        await chmod(locked, 0o000);

        await resetSlot(slot);
        assert.deepEqual(await readdir(slot), []);
        assert.equal(await readFile(join(outside, "canary.txt"), "utf8"), "keep");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  );
});

const HOME_PROVISIONED: HomeFacts = {
  realDirectory: true,
  sameDevice: true,
  uid: WORKSPACE_UID,
  gid: WORKSPACE_GID,
  mode: 0o700,
};

describe("checkHome", () => {
  it("accepts a home owned 1000:1000 with owner rwx and no group or world write", () => {
    checkHome(HOME_PROVISIONED);
    checkHome({ ...HOME_PROVISIONED, mode: 0o750 });
  });

  it("fails closed on each fact the home must prove", () => {
    const unproven: Array<[string, Partial<HomeFacts>]> = [
      ["not a real directory", { realDirectory: false }],
      ["a separate mount", { sameDevice: false }],
      ["the wrong owner", { uid: 0 }],
      ["the wrong group", { gid: 0 }],
      ["no owner write", { mode: 0o500 }],
      ["group-writable", { mode: 0o770 }],
      ["world-writable", { mode: 0o702 }],
    ];
    for (const [label, changes] of unproven)
      assert.throws(
        () => checkHome({ ...HOME_PROVISIONED, ...changes }),
        /workspace slot unavailable/,
        label
      );
  });
});

describe("prepareHome", () => {
  it("refuses a home that is a link out of the slot, rather than creating or chowning through it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vps-home-"));
    try {
      const slot = join(dir, "slot");
      const outside = join(dir, "outside");
      await mkdir(slot);
      await mkdir(outside);
      await symlink(outside, join(slot, "home"), "junction");

      await assert.rejects(prepareHome(slot), /home is not a real directory/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("repairHomeMode", () => {
  // Permission bits are POSIX only, so the mode assertions run on Linux, where the executor is deployed.
  const POSIX = process.platform !== "win32";

  it(
    "restores a home the sandbox widened, through its own descriptor, once its identity is proven",
    { skip: !POSIX && "permission bits are POSIX only" },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "vps-home-"));
      try {
        const slot = join(dir, "slot");
        const home = join(slot, "home");
        await mkdir(home, { recursive: true });
        await chmod(home, 0o777);
        // The probe stands for host setup's 1000:1000 owner, which the test process cannot hold.
        await repairHomeMode(slot, async () => ({ ...HOME_PROVISIONED, mode: 0o777 }));
        assert.equal((await stat(home)).mode & 0o777, 0o700);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  );

  it("refuses a home whose identity the probe does not prove, before any chmod", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vps-home-"));
    try {
      const slot = join(dir, "slot");
      const home = join(slot, "home");
      await mkdir(home, { recursive: true });
      await chmod(home, 0o777);
      await assert.rejects(
        repairHomeMode(slot, async () => ({ ...HOME_PROVISIONED, uid: 0, mode: 0o777 })),
        /home owner is not 1000:1000/
      );
      await assert.rejects(
        repairHomeMode(slot, async () => ({ ...HOME_PROVISIONED, sameDevice: false })),
        /home is a separate mount/
      );
      if (POSIX) assert.equal((await stat(home)).mode & 0o777, 0o777);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("leaves an absent home for prepareHome to create", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vps-home-"));
    try {
      const slot = join(dir, "slot");
      await mkdir(slot);
      await repairHomeMode(slot);
      assert.deepEqual(await readdir(slot), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it(
    "never chmods through a link that replaces the home",
    { skip: !POSIX && "permission bits are POSIX only" },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "vps-home-"));
      try {
        const slot = join(dir, "slot");
        const outside = join(dir, "outside");
        await mkdir(slot);
        await mkdir(outside);
        await chmod(outside, 0o777);
        await symlink(outside, join(slot, "home"), "junction");

        await assert.rejects(repairHomeMode(slot), /home is not a real directory/);
        assert.equal((await stat(outside)).mode & 0o777, 0o777);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  );
});
