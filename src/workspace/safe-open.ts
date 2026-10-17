import fs from "node:fs";
import path from "node:path";
import type { FileHandle } from "node:fs/promises";

export class SafeOpenError extends Error {
  constructor(message: string, readonly reason: "UNSAFE_PATH" | "NOT_A_FILE" = "UNSAFE_PATH") {
    super(message);
    this.name = "SafeOpenError";
  }
}

interface Identity {
  dev: bigint;
  ino: bigint;
}

interface Snapshot {
  root: string;
  target: string;
  parents: Array<{ path: string; identity: Identity }>;
  identity: Identity;
}

function identity(stat: fs.BigIntStats): Identity {
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || !(relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));
}

function capture(rootInput: string, expectedTarget: string): Snapshot {
  const root = fs.realpathSync.native(rootInput);
  const target = path.resolve(expectedTarget);
  const canonicalTarget = fs.realpathSync.native(target);
  if (canonicalTarget !== target || !isWithin(root, target)) {
    throw new SafeOpenError("file path no longer matches its validated workspace path");
  }
  if (target === root) throw new SafeOpenError("workspace target is not a regular file", "NOT_A_FILE");

  const relativeParent = path.relative(root, path.dirname(target));
  const parents = [root];
  if (relativeParent) {
    let current = root;
    for (const segment of relativeParent.split(path.sep)) {
      current = path.join(current, segment);
      parents.push(current);
    }
  }

  const parentSnapshots = parents.map((parent) => {
    const stat = fs.lstatSync(parent, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new SafeOpenError("workspace parent path is not a real directory");
    }
    return { path: parent, identity: identity(stat) };
  });

  const targetStat = fs.lstatSync(target, { bigint: true });
  if (targetStat.isSymbolicLink()) {
    throw new SafeOpenError("workspace target is not a regular file");
  }
  if (!targetStat.isFile()) throw new SafeOpenError("workspace target is not a regular file", "NOT_A_FILE");
  return { root, target, parents: parentSnapshots, identity: identity(targetStat) };
}

function verifyFdPath(fd: number, expectedTarget: string): void {
  if (process.platform !== "linux") return;
  try {
    const fdPath = fs.realpathSync.native(`/proc/self/fd/${fd}`);
    if (fdPath !== expectedTarget) {
      throw new SafeOpenError("opened descriptor does not refer to the validated path");
    }
  } catch (error) {
    if (error instanceof SafeOpenError) throw error;
    // Some Linux containers do not mount procfs; the identity and path checks remain active.
  }
}

function verifySnapshot(snapshot: Snapshot, fdStat: fs.BigIntStats, fd: number): void {
  if (!fdStat.isFile() || !sameIdentity(identity(fdStat), snapshot.identity)) {
    throw new SafeOpenError("opened file identity changed during validation");
  }

  let current: Snapshot;
  try {
    current = capture(snapshot.root, snapshot.target);
  } catch {
    throw new SafeOpenError("workspace path changed during file open");
  }
  if (
    current.target !== snapshot.target ||
    !sameIdentity(current.identity, snapshot.identity) ||
    current.parents.length !== snapshot.parents.length ||
    current.parents.some((parent, index) =>
      parent.path !== snapshot.parents[index].path ||
      !sameIdentity(parent.identity, snapshot.parents[index].identity)
    )
  ) {
    throw new SafeOpenError("workspace path changed during file open");
  }
  verifyFdPath(fd, snapshot.target);
}

const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);

export async function openWorkspaceFile(root: string, expectedTarget: string): Promise<FileHandle> {
  const snapshot = capture(root, expectedTarget);
  let handle: FileHandle;
  try {
    handle = await fs.promises.open(snapshot.target, OPEN_FLAGS);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new SafeOpenError("workspace target changed to a symbolic link while opening");
    }
    throw error;
  }
  try {
    verifySnapshot(snapshot, await handle.stat({ bigint: true }), handle.fd);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export function openWorkspaceFileSync(root: string, expectedTarget: string): number {
  const snapshot = capture(root, expectedTarget);
  let fd: number;
  try {
    fd = fs.openSync(snapshot.target, OPEN_FLAGS);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new SafeOpenError("workspace target changed to a symbolic link while opening");
    }
    throw error;
  }
  try {
    verifySnapshot(snapshot, fs.fstatSync(fd, { bigint: true }), fd);
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

export class SafeReadLimitError extends Error {
  constructor() {
    super("file exceeded the bounded descriptor read limit");
    this.name = "SafeReadLimitError";
  }
}

/** Read at most maxBytes + 1 bytes from an already validated descriptor. */
export function readDescriptorBoundedSync(fd: number, maxBytes: number): Buffer {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("maxBytes must be a nonnegative safe integer");
  const buffer = Buffer.alloc(maxBytes + 1);
  let size = 0;
  while (size < buffer.length) {
    const bytesRead = fs.readSync(fd, buffer, size, Math.min(64 * 1024, buffer.length - size), size);
    if (bytesRead === 0) break;
    size += bytesRead;
  }
  if (size > maxBytes) throw new SafeReadLimitError();
  return buffer.subarray(0, size);
}
