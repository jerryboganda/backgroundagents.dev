import { constants as fsConstants, type Stats } from "node:fs";
import {
  chmod,
  chown,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
  rmdir,
  statfs,
  unlink,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";

/*
 * Workspace slots: the bounded storage behind each sandbox's /workspace. Host setup provisions
 * WORKSPACE_SLOT_COUNT ext4 images, each loop-mounted once at <root>/<slot>. This module only checks,
 * repairs and clears slots. The executor never mounts anything, and it never follows a link out of a slot.
 *
 * HOST PROVISIONING CONTRACT (for the deploy worker; checkSlot enforces it before every create):
 * - Root: an absolute, normalized directory, VPS_EXECUTOR_WORKSPACE_ROOT (default /srv/vps-ws/slots).
 *   It is bind-mounted into the executor at the same path, so the path checked and the path docker
 *   binds are one string.
 * - Images: /srv/vps-ws/images/slot-<k>.img for k in 0..5, each `fallocate -l 10G` (root, 0600).
 *   Six images are 60 GiB reserved at setup. Host free space beyond that is provisioning's concern.
 * - Filesystem: `mkfs.ext4 -F -m 0 -N 262144 -E root_owner=1000:1000` on each image.
 * - Mount: loop-mounted once at boot, from fstab: `<image> <root>/<k> ext4 loop,nosuid,nodev,noatime 0 0`.
 *   Mountpoints are created as root with mode 0700 before `mount -a`. The loop module must be loaded.
 * - Each mounted slot must read: a real directory (no symlink on its path), on a device other than
 *   its parent, ext4, 9-10 GiB, owned 1000:1000, owner rwx, and no group or world write.
 * - Home: `<slot>/home` is the sandbox's home, bound to /home/sandbox. It is created 0700 and handed to
 *   1000:1000 when absent (prepareHome), and proven before each bind under the same owner and mode rules.
 *   A reattached home has its mode restored first (repairHomeMode), once no owned container names the slot.
 *   It lives inside the bounded slot, so it persists with the workspace and a release clears it.
 * - Reset is only as safe as its caller. The server claims the slot for reset only after every owned
 *   container is proven gone, so no sandbox writes while it runs. Repair (repairSlotRoot, then resetSlot)
 *   restores owner write and never chmods by name: each directory is opened without following a link,
 *   verified against its lstat, and chmodded only through that descriptor. A link is unlinked, and its
 *   target is never touched.
 * - An unmounted slot is root-owned 0700, so both the identity proof and the reset refuse it.
 */

export const WORKSPACE_SLOT_COUNT = 6;
export const WORKSPACE_UID = 1000;
export const WORKSPACE_GID = 1000;
/** Bytes per slot image. The slot's filesystem is this size less ext4 metadata. */
export const WORKSPACE_SLOT_BYTES = 10 * 1024 ** 3;
const WORKSPACE_SLOT_MIN_BYTES = (WORKSPACE_SLOT_BYTES * 9) / 10;
const EXT4_MAGIC = 0xef53;
// Absolute, normalized, and free of the characters docker's --mount syntax splits on.
const ROOT_PATTERN = /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;
// The mode a repaired slot root gets: owner rwx, and read and traverse only for everyone else.
const ROOT_REPAIR_MODE = 0o755;
// Linux's O_PATH: a descriptor that names a directory without reading it, so a directory the sandbox locked still opens.
const LINUX_O_PATH = 0o10000000;
// Opening a directory without following a final link. On Linux the descriptor is path-only, which needs no read bit, and
// its mode is changed through /proc (see setModeOf). Elsewhere it is a plain read. Windows defines neither flag.
const DIRECTORY_NO_FOLLOW =
  (fsConstants.O_DIRECTORY ?? 0) |
  (fsConstants.O_NOFOLLOW ?? 0) |
  (process.platform === "linux" ? LINUX_O_PATH : fsConstants.O_RDONLY);
// Windows keeps no POSIX mode bits to repair, so the chmod steps are skipped there. Linux is the deployed platform.
const POSIX_MODES = process.platform !== "win32";

/** One slot, as the host path a sandbox binds. */
export interface WorkspaceMount {
  /** The integer the path is built from. */
  slot: number;
  /** The bind source. Checked and bound as the same string. */
  hostPath: string;
}

/** The facts checkSlot judges, read from the host. */
export interface SlotFacts {
  /** lstat says directory, and realpath returns the path itself, so no link is followed on the way. */
  realDirectory: boolean;
  dev: number;
  parentDev: number;
  /** statfs magic number of the filesystem. */
  fsType: number;
  totalBytes: number;
  uid: number;
  gid: number;
  /** Permission bits only. */
  mode: number;
}

export type SlotProbe = (hostPath: string) => Promise<SlotFacts>;

/** True for an absolute, normalized POSIX path with at least one segment and no "." or ".." segment. */
export function isWorkspaceRoot(root: string): boolean {
  if (!ROOT_PATTERN.test(root)) return false;
  return !root
    .split("/")
    .slice(1)
    .some((segment) => segment === "." || segment === "..");
}

/** The slot's host path. The integer slot is the only input, so no sandbox value reaches a path. */
export function workspaceMount(root: string, slot: number): WorkspaceMount {
  if (!Number.isSafeInteger(slot) || slot < 0 || slot >= WORKSPACE_SLOT_COUNT)
    throw new Error("invalid workspace slot");
  return { slot, hostPath: join(root, String(slot)) };
}

/** Proves a slot is the bounded image host setup mounted, every fact except its mode. */
export function checkSlotIdentity(facts: SlotFacts): void {
  if (!facts.realDirectory) throw unavailable("not a real directory");
  if (facts.dev === facts.parentDev) throw unavailable("not a separate mount");
  if (facts.fsType !== EXT4_MAGIC) throw unavailable("not ext4");
  if (facts.totalBytes > WORKSPACE_SLOT_BYTES || facts.totalBytes < WORKSPACE_SLOT_MIN_BYTES)
    throw unavailable("size outside the slot bound");
  if (facts.uid !== WORKSPACE_UID || facts.gid !== WORKSPACE_GID)
    throw unavailable("owner is not 1000:1000");
}

/**
 * Proves a slot is the bounded image host setup mounted, before a sandbox binds it. A probe that
 * cannot see the slot (missing path, EACCES) rejects too, so every unproven slot fails closed.
 */
export async function checkSlot(hostPath: string, probe: SlotProbe = probeSlot): Promise<void> {
  const facts = await probe(hostPath);
  checkSlotIdentity(facts);
  if ((facts.mode & 0o700) !== 0o700 || (facts.mode & 0o022) !== 0)
    throw unavailable("mode lacks owner rwx or allows group or world write");
}

/**
 * Restores a slot root's mode when the sandbox changed it: group or world write, or no owner rwx. The identity is
 * proven first, so an unmounted or foreign directory is never chmodded. The chmod then goes only to the directory a
 * no-follow open names, and only once that is a directory, so a link swapped in after the probe is never chmodded.
 * Call only once the slot is claimed for reset.
 */
export async function repairSlotRoot(
  hostPath: string,
  probe: SlotProbe = probeSlot
): Promise<void> {
  const facts = await probe(hostPath);
  checkSlotIdentity(facts);
  if (!POSIX_MODES || ((facts.mode & 0o700) === 0o700 && (facts.mode & 0o022) === 0)) return;
  const handle = await open(hostPath, DIRECTORY_NO_FOLLOW);
  try {
    if (!(await handle.stat()).isDirectory()) throw unavailable("changed before it was opened");
    await setModeOf(handle, ROOT_REPAIR_MODE);
  } finally {
    await handle.close();
  }
}

/**
 * Empties a slot. The slot directory itself stays, since it is the mount point. Every directory is opened without
 * following a link, proven against its lstat, repaired to owner rwx, emptied, then removed. A link is unlinked, and
 * its target is never touched. Call only after checkSlot, and only once the slot is claimed for reset.
 */
export async function resetSlot(hostPath: string): Promise<void> {
  const root = await lstat(hostPath);
  const handle = await openVerified(hostPath, root);
  try {
    await emptyDirectory(handle, hostPath, root.dev);
  } finally {
    await handle.close();
  }
}

/**
 * Empties an open directory. Its entries are named through `anchorOf`, so a path swapped for a link cannot redirect
 * the walk. Each entry is judged by lstat: a directory is emptied and removed, and anything else is unlinked.
 */
async function emptyDirectory(handle: FileHandle, path: string, device: number): Promise<void> {
  const anchor = anchorOf(handle, path);
  const { mode } = await handle.stat();
  if (POSIX_MODES && (mode & 0o700) !== 0o700) await setModeOf(handle, (mode & 0o777) | 0o700);
  for (const name of await readdir(anchor)) {
    const child = join(anchor, name);
    const entry = await lstat(child);
    if (!entry.isDirectory()) {
      await removeEntry(child);
      continue;
    }
    if (entry.dev !== device) throw unavailable("a directory is a separate mount");
    await emptyChild(child, entry, device);
    await rmdir(child);
  }
}

/**
 * Empties a subdirectory the walk entered. The open proves the entry is still that directory, without following a link,
 * and only then is its mode repaired, through the same descriptor. Exported so a test can replay an entry read before a swap.
 */
export async function emptyChild(child: string, entry: Stats, device: number): Promise<void> {
  const handle = await openVerified(child, entry);
  try {
    await emptyDirectory(handle, child, device);
  } finally {
    await handle.close();
  }
}

/**
 * Opens a directory without following a final link, and proves the open handle is the directory `expected` names.
 * A link or a swapped entry fails here, before anything is changed.
 */
async function openVerified(
  path: string,
  expected: Pick<Stats, "dev" | "ino">
): Promise<FileHandle> {
  const handle = await open(path, DIRECTORY_NO_FOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isDirectory() || opened.dev !== expected.dev || opened.ino !== expected.ino)
      throw unavailable("a directory changed before it was opened");
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Unlinks a file or a link by its own name, so nothing beneath it is walked. Windows has no such call for a directory junction, so it keeps rm there. */
async function removeEntry(path: string): Promise<void> {
  if (POSIX_MODES) await unlink(path);
  else await rm(path, { recursive: true, force: true });
}

/**
 * The name a directory's entries are reached by. On Linux, /proc/self/fd/<fd> names the inode this process holds open,
 * so no swap of the path can redirect the walk. Elsewhere the path stands. The executor is deployed on Linux, so that
 * fallback only serves the tests on other hosts.
 */
function anchorOf(handle: FileHandle, path: string): string {
  return process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : path;
}

/**
 * Changes the mode of the directory a verified handle holds. On Linux the handle is path-only, which fchmod rejects, so
 * the mode goes through its /proc name: that reaches the same inode, never a path. Elsewhere the handle is a plain descriptor.
 */
async function setModeOf(handle: FileHandle, mode: number): Promise<void> {
  if (process.platform === "linux") await chmod(`/proc/self/fd/${handle.fd}`, mode);
  else await handle.chmod(mode);
}

/** The slot's home subdirectory, bound to /home/sandbox. */
export const HOME_DIRECTORY = "home";

/** The facts checkHome judges, read from the host. */
export interface HomeFacts {
  /** lstat says directory, so no link is followed on the way. */
  realDirectory: boolean;
  /** The home is on the slot's device, so it is not a mount of its own. */
  sameDevice: boolean;
  uid: number;
  gid: number;
  /** Permission bits only. */
  mode: number;
}

/** The mode a repaired home gets: owner rwx, and nothing for anyone else, as prepareHome creates it. */
const HOME_REPAIR_MODE = 0o700;

/** Proves a home is a real directory on its slot's device, owned 1000:1000. The mode is judged by checkHome. */
function checkHomeIdentity(facts: HomeFacts): void {
  if (!facts.realDirectory) throw unavailable("home is not a real directory");
  if (!facts.sameDevice) throw unavailable("home is a separate mount");
  if (facts.uid !== WORKSPACE_UID || facts.gid !== WORKSPACE_GID)
    throw unavailable("home owner is not 1000:1000");
}

/** True for owner rwx with no group or world write. */
function homeModeOk(mode: number): boolean {
  return (mode & 0o700) === 0o700 && (mode & 0o022) === 0;
}

/** Reads a home's facts from the host. Rejects when the home is absent, as lstat does. */
export type HomeProbe = (home: string, slotPath: string) => Promise<HomeFacts>;

/** Proves a home is a real directory on its slot's device, owned 1000:1000, owner rwx, no group or world write. */
export function checkHome(facts: HomeFacts): void {
  checkHomeIdentity(facts);
  if (!homeModeOk(facts.mode))
    throw unavailable("home mode lacks owner rwx or allows group or world write");
}

/**
 * Restores a home's mode when the sandbox changed it: group or world write, or no owner rwx. An absent home is left for
 * prepareHome to create. The identity is proven first, and the chmod goes only to the directory a no-follow open names,
 * once that open is proven to be the inode the identity read. Call only once the slot is claimed and no owned container
 * names it.
 */
export async function repairHomeMode(
  slotPath: string,
  probe: HomeProbe = probeHome
): Promise<void> {
  const home = join(slotPath, HOME_DIRECTORY);
  let facts: HomeFacts;
  try {
    facts = await probe(home, slotPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  checkHomeIdentity(facts);
  if (!POSIX_MODES || homeModeOk(facts.mode)) return;
  const handle = await open(home, DIRECTORY_NO_FOLLOW);
  try {
    if (!(await handle.stat()).isDirectory())
      throw unavailable("home changed before it was opened");
    await setModeOf(handle, HOME_REPAIR_MODE);
  } finally {
    await handle.close();
  }
}

/**
 * Creates the slot's home subdirectory when it is absent, then proves it before a sandbox binds it. A new
 * subdirectory is handed to 1000:1000, which fails unless this process may chown. Call only after checkSlot.
 */
export async function prepareHome(slotPath: string): Promise<void> {
  const home = join(slotPath, HOME_DIRECTORY);
  const created = await mkdir(home, { mode: 0o700 }).then(
    () => true,
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
      throw error;
    }
  );
  if (created) await chown(home, WORKSPACE_UID, WORKSPACE_GID);
  checkHome(await probeHome(home, slotPath));
}

async function probeHome(home: string, slotPath: string): Promise<HomeFacts> {
  const [entry, slot] = await Promise.all([lstat(home), lstat(slotPath)]);
  return homeFacts(entry, slot);
}

/** The facts checkHome judges, read from a home's lstat and its slot's. */
function homeFacts(entry: Stats, slot: Stats): HomeFacts {
  return {
    realDirectory: entry.isDirectory(),
    sameDevice: entry.dev === slot.dev,
    uid: entry.uid,
    gid: entry.gid,
    mode: entry.mode & 0o777,
  };
}

function unavailable(reason: string): Error {
  return new Error(`workspace slot unavailable: ${reason}`);
}

async function probeSlot(hostPath: string): Promise<SlotFacts> {
  const [entry, parent, fs, resolved] = await Promise.all([
    lstat(hostPath),
    lstat(dirname(hostPath)),
    statfs(hostPath),
    realpath(hostPath),
  ]);
  return {
    realDirectory: entry.isDirectory() && resolved === hostPath,
    dev: entry.dev,
    parentDev: parent.dev,
    fsType: fs.type,
    totalBytes: fs.blocks * fs.bsize,
    uid: entry.uid,
    gid: entry.gid,
    mode: entry.mode & 0o777,
  };
}
