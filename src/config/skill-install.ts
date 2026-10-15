import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_NAME = "codex-with-chatgpt";
const PLACEHOLDER = "<ACTUAL_CHECKOUT_PATH>";
const SKILL_RELATIVE_PATH = path.join("skill", "SKILL.md");

export interface SkillInstallOptions {
  /** Checkout containing the source skill. Defaults to this package checkout. */
  checkoutRoot?: string;
  /** Codex home used for the destination. Defaults to CODEX_HOME or ~/.codex. */
  codexHome?: string;
}

export interface SkillInstallResult {
  installed: true;
  changed: boolean;
  path: string;
  contentHash: string;
  sourcePath: string;
  checkoutRoot: string;
}

export interface SkillStatusResult {
  installed: boolean;
  matches: boolean;
  path: string;
  contentHash: string | null;
  expectedContentHash: string;
  sourcePath: string;
  checkoutRoot: string;
}

export interface SkillInstallSnapshot {
  readonly codexHome: string;
  /** Codex-visible path, which may pass through the approved directory link. */
  readonly path: string;
  /** Validated physical target used for filesystem operations. */
  readonly ioPath: string;
  readonly directory: SkillDirectorySnapshot;
  readonly previous: { readonly kind: "missing" } | {
    readonly kind: "file";
    readonly bytes: Buffer;
    readonly mode: number;
  };
}

type SkillDirectorySnapshot = {
  readonly kind: "missing" | "directory" | "supported-symlink";
  readonly linkText?: string;
  readonly resolvedPath?: string;
  readonly dev?: number;
  readonly ino?: number;
  readonly parentDev?: number;
  readonly parentIno?: number;
};

type SkillTargetResolution = {
  /** Codex-visible path. */
  readonly path: string;
  /** Physical path used for filesystem operations. */
  readonly ioPath: string;
  readonly directory: string;
  readonly parent: string;
  readonly directoryState: SkillDirectorySnapshot;
};

export function getSkillCheckoutRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function getSkillInstallPath(codexHome?: string): string {
  return path.join(resolveCodexHome(codexHome), "skills", SKILL_NAME, "SKILL.md");
}

export function renderSkill(source: string, checkoutRoot: string): string {
  const count = source.split(PLACEHOLDER).length - 1;
  if (count === 0) {
    throw new Error(`Skill source must contain exactly one ${PLACEHOLDER} placeholder`);
  }
  if (count !== 1) {
    throw new Error(`Skill source contains ${count} ${PLACEHOLDER} placeholders; exactly one is required`);
  }
  return source.replace(PLACEHOLDER, checkoutRoot);
}

export function installGlobalSkill(options: SkillInstallOptions = {}): SkillInstallResult {
  const sourceInfo = readSkillSource(options.checkoutRoot);
  const rendered = renderSkill(sourceInfo.content, sourceInfo.checkoutRoot);
  const contentHash = hashContent(rendered);
  let resolution = resolveCanonicalSkillTarget(options.codexHome);
  const target = resolution.path;
  ensureSafeDirectory(resolution.parent);
  if (resolution.directoryState.kind === "missing") {
    ensureSafeDirectory(resolution.directory);
    resolution = resolveCanonicalSkillTarget(options.codexHome);
  }

  let changed = true;
  const ioTarget = resolution.ioPath;
  assertResolutionUnchanged(resolution, resolveCanonicalSkillTarget(options.codexHome));
  const existing = readSafeTarget(ioTarget);
  if (existing !== null && existing.content === rendered) {
    assertResolutionUnchanged(resolution, resolveCanonicalSkillTarget(options.codexHome));
    changed = false;
    chmodOwnerOnly(ioTarget, 0o600);
  } else {
    writeAtomicSkill(ioTarget, rendered, () => {
      assertResolutionUnchanged(resolution, resolveCanonicalSkillTarget(options.codexHome));
    });
  }

  return {
    installed: true,
    changed,
    path: target,
    contentHash,
    sourcePath: sourceInfo.sourcePath,
    checkoutRoot: sourceInfo.checkoutRoot,
  };
}

/** Capture the global Skill target before a multi-step machine setup. */
export function snapshotGlobalSkill(options: SkillInstallOptions = {}): SkillInstallSnapshot {
  const codexHome = resolveCodexHome(options.codexHome);
  const resolution = resolveCanonicalSkillTarget(codexHome);
  const target = resolution.path;
  const ioTarget = resolution.ioPath;
  assertResolutionUnchanged(resolution, resolveCanonicalSkillTarget(codexHome));
  const existing = fs.lstatSync(ioTarget, { throwIfNoEntry: false });
  if (!existing) {
    assertResolutionUnchanged(resolution, resolveCanonicalSkillTarget(codexHome));
    return {
      codexHome,
      path: target,
      ioPath: ioTarget,
      directory: resolution.directoryState,
      previous: { kind: "missing" },
    };
  }
  if (existing.isSymbolicLink()) throw new Error(`Refusing to snapshot symlink Skill target: ${target}`);
  if (!existing.isFile()) throw new Error(`Skill target is not a regular file: ${target}`);
  const bytes = fs.readFileSync(ioTarget);
  assertResolutionUnchanged(resolution, resolveCanonicalSkillTarget(codexHome));
  return {
    codexHome,
    path: target,
    ioPath: ioTarget,
    directory: resolution.directoryState,
    previous: { kind: "file", bytes, mode: existing.mode & 0o777 },
  };
}

/** Restore the global Skill target captured by snapshotGlobalSkill. */
export function restoreGlobalSkill(snapshot: SkillInstallSnapshot): void {
  const resolution = resolveCanonicalSkillTarget(snapshot.codexHome);
  const target = resolution.path;
  const ioTarget = resolution.ioPath;
  if (target !== snapshot.path || ioTarget !== snapshot.ioPath) {
    throw new Error("Skill rollback target does not match its snapshot");
  }
  assertSnapshotDirectoryUnchanged(snapshot.directory, resolution.directoryState, true);
  if (snapshot.previous.kind === "missing") {
    assertRestorableTarget(resolution, ioTarget, () => resolveCanonicalSkillTarget(snapshot.codexHome));
    fs.rmSync(ioTarget, { force: true });
    return;
  }
  restoreSnapshotFile(ioTarget, snapshot.previous.bytes, snapshot.previous.mode, () => {
    assertRestorableTarget(resolution, ioTarget, () => resolveCanonicalSkillTarget(snapshot.codexHome));
  });
}

export function statusGlobalSkill(options: SkillInstallOptions = {}): SkillStatusResult {
  const sourceInfo = readSkillSource(options.checkoutRoot);
  const rendered = renderSkill(sourceInfo.content, sourceInfo.checkoutRoot);
  const resolution = resolveCanonicalSkillTarget(options.codexHome);
  const target = resolution.path;
  const ioTarget = resolution.ioPath;
  const parentSafe = assertSafeDirectory(resolution.parent);
  assertResolutionUnchanged(resolution, resolveCanonicalSkillTarget(options.codexHome));
  const existing = parentSafe && resolution.directoryState.kind !== "missing"
    ? readSafeTarget(ioTarget, { allowMissing: true })
    : null;
  assertResolutionUnchanged(resolution, resolveCanonicalSkillTarget(options.codexHome));
  const contentHash = existing === null ? null : hashContent(existing.content);
  const expectedContentHash = hashContent(rendered);
  return {
    installed: existing !== null,
    matches: existing !== null && existing.content === rendered,
    path: target,
    contentHash,
    expectedContentHash,
    sourcePath: sourceInfo.sourcePath,
    checkoutRoot: sourceInfo.checkoutRoot,
  };
}

function resolveCodexHome(override?: string): string {
  const configured = override?.trim() || process.env.CODEX_HOME?.trim();
  return path.resolve(configured || path.join(os.homedir(), ".codex"));
}

function resolveCanonicalSkillTarget(codexHome?: string): SkillTargetResolution {
  const home = resolveCodexHome(codexHome);
  const parent = path.join(home, "skills");
  const directory = path.join(parent, SKILL_NAME);
  const target = path.join(directory, "SKILL.md");
  const parentExists = assertSafeDirectory(parent);
  if (!parentExists) {
    return { path: target, ioPath: target, directory, parent, directoryState: { kind: "missing" } };
  }

  const directoryInfo = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!directoryInfo) {
    const parentInfo = fs.lstatSync(parent);
    return {
      path: target,
      ioPath: target,
      directory,
      parent,
      directoryState: { kind: "missing", parentDev: parentInfo.dev, parentIno: parentInfo.ino },
    };
  }
  if (directoryInfo.isSymbolicLink()) {
    const linkText = fs.readlinkSync(directory);
    const resolvedPath = path.resolve(path.dirname(directory), linkText);
    const expectedPath = path.join(os.homedir(), ".agents", "skills", SKILL_NAME);
    if (resolvedPath !== expectedPath) {
      throw new Error(`Unsupported Skill directory symlink target: ${directory} -> ${linkText}`);
    }
    const realUserHome = fs.realpathSync(os.homedir());
    const physicalDirectory = path.join(realUserHome, ".agents", "skills", SKILL_NAME);
    assertPlainDirectoryPath(physicalDirectory, realUserHome);
    const targetInfo = fs.lstatSync(physicalDirectory);
    const parentInfo = fs.lstatSync(parent);
    return {
      path: target,
      ioPath: path.join(physicalDirectory, "SKILL.md"),
      directory,
      parent,
      directoryState: {
        kind: "supported-symlink",
        linkText,
        resolvedPath,
        dev: targetInfo.dev,
        ino: targetInfo.ino,
        parentDev: parentInfo.dev,
        parentIno: parentInfo.ino,
      },
    };
  }
  if (!directoryInfo.isDirectory()) throw new Error(`Skill target directory is not a directory: ${directory}`);
  const parentInfo = fs.lstatSync(parent);
  return {
    path: target,
    ioPath: target,
    directory,
    parent,
    directoryState: {
      kind: "directory",
      dev: directoryInfo.dev,
      ino: directoryInfo.ino,
      parentDev: parentInfo.dev,
      parentIno: parentInfo.ino,
    },
  };
}

function assertPlainDirectoryPath(directory: string, trustedRoot: string): void {
  const absolute = path.resolve(directory);
  const root = path.resolve(trustedRoot);
  const relative = path.relative(root, absolute);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error(`Supported Skill symlink target is outside the current user's home: ${absolute}`);
  }
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Supported Skill symlink target is not a plain directory path: ${current}`);
    }
  }
}

function assertResolutionUnchanged(
  before: SkillTargetResolution,
  after: SkillTargetResolution,
): void {
  if (before.path !== after.path || before.ioPath !== after.ioPath) {
    throw new Error("Skill target path changed during operation");
  }
  assertSnapshotDirectoryUnchanged(before.directoryState, after.directoryState);
}

function assertSnapshotDirectoryUnchanged(
  before: SkillDirectorySnapshot,
  after: SkillDirectorySnapshot,
  allowCreatedDirectory = false,
): void {
  if (allowCreatedDirectory && before.kind === "missing" && after.kind === "directory") {
    if ((before.parentDev !== undefined && before.parentDev !== after.parentDev) ||
        (before.parentIno !== undefined && before.parentIno !== after.parentIno)) {
      throw new Error("Skill target parent directory changed during operation");
    }
    return;
  }
  if (before.kind !== after.kind || before.linkText !== after.linkText ||
      before.resolvedPath !== after.resolvedPath || before.dev !== after.dev || before.ino !== after.ino ||
      before.parentDev !== after.parentDev || before.parentIno !== after.parentIno) {
    throw new Error("Skill target directory or symlink changed during operation");
  }
}

function assertRestorableTarget(
  resolution: SkillTargetResolution,
  ioTarget: string,
  resolveCurrent: () => SkillTargetResolution,
): void {
  assertResolutionUnchanged(resolution, resolveCurrent());
  const existing = fs.lstatSync(ioTarget, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink()) throw new Error(`Refusing to overwrite symlink Skill target: ${resolution.path}`);
  if (existing && !existing.isFile()) throw new Error(`Skill target is not a regular file: ${resolution.path}`);
  assertResolutionUnchanged(resolution, resolveCurrent());
}

function readSkillSource(checkoutRootOption?: string): {
  checkoutRoot: string;
  sourcePath: string;
  content: string;
} {
  const checkoutRoot = path.resolve(checkoutRootOption ?? getSkillCheckoutRoot());
  const sourcePath = path.join(checkoutRoot, SKILL_RELATIVE_PATH);
  const stat = fs.lstatSync(sourcePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Skill source is not a regular file: ${sourcePath}`);
  }
  return { checkoutRoot, sourcePath, content: fs.readFileSync(sourcePath, "utf8") };
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function ensureSafeDirectory(directory: string): void {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  let current = root;
  for (const segment of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`Skill install path contains a symlink: ${current}`);
      if (!stat.isDirectory()) throw new Error(`Skill install path is not a directory: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      fs.mkdirSync(current, { mode: 0o700 });
      const created = fs.lstatSync(current);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new Error(`Skill install path is unsafe: ${current}`);
      }
    }
  }
  chmodOwnerOnly(absolute, 0o700);
}

function assertSafeDirectory(directory: string): boolean {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  let current = root;
  for (const segment of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`Skill install path contains a symlink: ${current}`);
      if (!stat.isDirectory()) throw new Error(`Skill install path is not a directory: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  return true;
}

function readSafeTarget(
  target: string,
  options: { allowMissing?: boolean } = {},
): { content: string } | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && options.allowMissing !== false) return null;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`Refusing to use symlink Skill target: ${target}`);
  if (!stat.isFile()) throw new Error(`Skill target is not a regular file: ${target}`);
  return { content: fs.readFileSync(target, "utf8") };
}

function restoreSnapshotFile(
  target: string,
  bytes: Buffer,
  mode: number,
  beforeRename: () => void,
): void {
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}.rollback`,
  );
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, bytes);
      fs.fchmodSync(fd, mode & 0o777);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    beforeRename();
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function writeAtomicSkill(target: string, content: string, beforeRename: () => void): void {
  beforeRename();
  const existing = readSafeTarget(target, { allowMissing: true });
  if (existing !== null && existing.content === content) {
    beforeRename();
    return;
  }

  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, content, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const current = readSafeTarget(target, { allowMissing: true });
    if (current !== null && current.content === content) {
      beforeRename();
      return;
    }
    beforeRename();
    fs.renameSync(temporary, target);
    chmodOwnerOnly(target, 0o600);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function chmodOwnerOnly(file: string, mode: number): void {
  try {
    fs.chmodSync(file, mode);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOTSUP" &&
        (error as NodeJS.ErrnoException).code !== "EPERM") {
      throw error;
    }
  }
}
