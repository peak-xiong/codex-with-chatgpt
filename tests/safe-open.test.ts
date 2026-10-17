import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  openWorkspaceFile,
  readDescriptorBoundedSync,
  SafeOpenError,
  SafeReadLimitError,
} from "../src/workspace/safe-open.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (directories.length > 0) cleanup(directories.pop()!);
});

function temporaryDirectory(name: string): string {
  const directory = makeTmpDir(name);
  directories.push(directory);
  return directory;
}

it("rejects a regular-file leaf replaced between validation and open", async () => {
  const root = temporaryDirectory("safe-open-leaf-race");
  const target = write(root, "source.txt", "validated object");
  const originalOpen = fs.promises.open.bind(fs.promises);
  let replaced = false;
  vi.spyOn(fs.promises, "open").mockImplementation(async (filePath, flags, mode) => {
    if (path.resolve(String(filePath)) === target && !replaced) {
      replaced = true;
      fs.renameSync(target, `${target}.old`);
      fs.writeFileSync(target, "replacement object");
    }
    return originalOpen(filePath, flags, mode);
  });

  await expect(openWorkspaceFile(root, target)).rejects.toBeInstanceOf(SafeOpenError);
  expect(replaced).toBe(true);
});

it("rejects an ancestor replaced with a symlink between validation and open", async () => {
  const root = temporaryDirectory("safe-open-parent-race");
  const outside = temporaryDirectory("safe-open-parent-outside");
  const parent = path.join(root, "nested");
  fs.mkdirSync(parent);
  const target = write(root, "nested/source.txt", "validated object");
  write(outside, "source.txt", "outside replacement");
  const originalOpen = fs.promises.open.bind(fs.promises);
  let replaced = false;
  vi.spyOn(fs.promises, "open").mockImplementation(async (filePath, flags, mode) => {
    if (path.resolve(String(filePath)) === target && !replaced) {
      replaced = true;
      fs.renameSync(parent, path.join(root, "nested-original"));
      fs.symlinkSync(outside, parent, "dir");
    }
    return originalOpen(filePath, flags, mode);
  });

  await expect(openWorkspaceFile(root, target)).rejects.toBeInstanceOf(SafeOpenError);
  expect(replaced).toBe(true);
});

it("keeps reading the opened object after the path is replaced", async () => {
  const root = temporaryDirectory("safe-open-after-open");
  const target = write(root, "source.txt", "original bytes");
  const handle = await openWorkspaceFile(root, target);
  try {
    fs.renameSync(target, `${target}.old`);
    fs.writeFileSync(target, "replacement bytes");
    const buffer = Buffer.alloc(32);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    expect(buffer.toString("utf8", 0, bytesRead)).toBe("original bytes");
  } finally {
    await handle.close();
  }
});

it("bounds descriptor reads at maxBytes plus one byte", () => {
  const root = temporaryDirectory("safe-open-read-limit");
  const target = write(root, "large.txt", "123456");
  const fd = fs.openSync(target, fs.constants.O_RDONLY);
  try {
    expect(() => readDescriptorBoundedSync(fd, 5)).toThrow(SafeReadLimitError);
  } finally {
    fs.closeSync(fd);
  }
});

it("preserves NOT_A_FILE for a workspace root", async () => {
  const root = temporaryDirectory("safe-open-directory");
  await expect(openWorkspaceFile(root, root)).rejects.toMatchObject({
    reason: "NOT_A_FILE",
  });
});

it("accepts a contained filename beginning with two dots", async () => {
  const root = temporaryDirectory("safe-open-dot-name");
  const target = write(root, "..notes.txt", "source");
  const handle = await openWorkspaceFile(root, target);
  try {
    const buffer = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    expect(buffer.toString("utf8", 0, bytesRead)).toBe("source");
  } finally {
    await handle.close();
  }
});
