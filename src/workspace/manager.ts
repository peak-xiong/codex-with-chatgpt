import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { IgnoreRules } from "./ignore.js";
import {
  registerProjectDataDir,
  registerWorkspaceDataDir,
} from "../config/paths.js";
import { projectDataDirectory, projectIdMetadataPath, resolveProjectId } from "./identity.js";
import { openWorkspaceFile, openWorkspaceFileSync, readDescriptorBoundedSync, SafeOpenError } from "./safe-open.js";

export type WorkspaceErrorCode =
  | "INVALID_CONFIG"
  | "INVALID_PATH"
  | "PATH_OUTSIDE_WORKSPACE"
  | "ACCESS_DENIED_SENSITIVE_FILE"
  | "FILE_NOT_FOUND"
  | "NOT_A_FILE"
  | "NOT_A_DIRECTORY"
  | "BINARY_FILE"
  | "UNSUPPORTED_IMAGE_FORMAT"
  | "FILE_TOO_LARGE"
  | "SEARCH_QUERY_TOO_LARGE"
  | "SEARCH_FAILED"
  | "REGEX_ENGINE_UNAVAILABLE";

export class WorkspaceError extends Error {
  constructor(
    public code: WorkspaceErrorCode,
    message: string
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

export interface ReadFileResult {
  path: string;
  sizeBytes: number;
  totalLines: number;
  startLine: number;
  endLine: number;
  truncated: boolean;
  remainingLines: number;
  nextStartLine: number | null;
  content: string;
}

export interface DirEntry {
  path: string;
  type: "file" | "dir";
  sizeBytes?: number;
}

export interface ListDirectoryResult {
  path: string;
  entries: DirEntry[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export interface ProjectConfig {
  name?: string;
  maxIterations?: number;
}

function parseProjectConfig(value: unknown): ProjectConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const config: ProjectConfig = {};
  if (typeof raw.name === "string") config.name = raw.name;
  if (typeof raw.maxIterations === "number") config.maxIterations = raw.maxIterations;
  return config;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string"
  );
  return Object.fromEntries(entries);
}

const DEFAULT_MAX_LINES = 400;
const HARD_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 256 * 1024;
export const MAX_TEXT_SCAN_BYTES = 8 * 1024 * 1024;
const TEXT_READ_CHUNK_BYTES = 64 * 1024;
const PROJECT_METADATA_MAX_BYTES = 1024 * 1024;

function readWorkspaceJson(root: string, file: string): unknown {
  let fd: number;
  try {
    fd = openWorkspaceFileSync(root, file);
  } catch {
    return undefined;
  }
  try {
    if (fs.fstatSync(fd).size > PROJECT_METADATA_MAX_BYTES) return undefined;
    return JSON.parse(readDescriptorBoundedSync(fd, PROJECT_METADATA_MAX_BYTES).toString("utf8")) as unknown;
  } catch {
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
}

function isMissingPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || !(relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));
}

export class Workspace {
  readonly root: string;
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly ignoreRules: IgnoreRules;
  readonly projectConfig: ProjectConfig;
  private readonly internalProjectDataDirectory: string;
  private readonly gitMetadataDirectory: string | null;

  constructor(rootInput: string) {
    const resolved = path.resolve(rootInput);
    let real: string;
    try {
      real = fs.realpathSync.native(resolved);
    } catch {
      throw new WorkspaceError("FILE_NOT_FOUND", `Workspace root does not exist: ${rootInput}`);
    }
    if (!fs.statSync(real).isDirectory()) {
      throw new WorkspaceError("NOT_A_DIRECTORY", `Workspace root is not a directory: ${rootInput}`);
    }
    this.root = real;
    this.id = createHash("sha256").update(real).digest("hex").slice(0, 12);
    this.projectId = resolveProjectId(real);
    const metadataPath = projectIdMetadataPath(real);
    this.gitMetadataDirectory = metadataPath
      ? fs.realpathSync.native(path.dirname(metadataPath))
      : null;
    const dataDir = projectDataDirectory(real);
    registerProjectDataDir(this.projectId, dataDir);
    registerWorkspaceDataDir(this.id, path.join(dataDir, "workspaces", this.id));
    this.internalProjectDataDirectory = fs.realpathSync.native(dataDir);
    this.ignoreRules = new IgnoreRules(real);
    this.projectConfig = parseProjectConfig(readWorkspaceJson(real, path.join(real, ".c2c.json")));
    this.name = this.projectConfig.name ?? path.basename(real);
  }

  private contains(candidate: string): boolean {
    return isPathWithin(this.root, candidate);
  }

  /**
   * Canonicalize a path by realpath-ing its deepest existing ancestor.
   * Defends against symlink escapes even for not-yet-existing leaf segments.
   */
  private canonicalize(abs: string): string {
    let current = abs;
    const suffix: string[] = [];
    for (;;) {
      try {
        const real = fs.realpathSync.native(current);
        return suffix.length > 0 ? path.join(real, ...suffix) : real;
      } catch {
        const parent = path.dirname(current);
        if (parent === current) return abs;
        suffix.unshift(path.basename(current));
        current = parent;
      }
    }
  }

  /**
   * Resolve an untrusted path to a canonical absolute path inside the workspace.
   * Throws PATH_OUTSIDE_WORKSPACE or ACCESS_DENIED_SENSITIVE_FILE.
   */
  resolveAfterIgnoreRefresh(
    requested: string,
    opts: { allowSensitive?: boolean } = {}
  ): { abs: string; rel: string } {
    if (typeof requested !== "string" || requested.includes("\0")) {
      throw new WorkspaceError("INVALID_PATH", "Invalid path");
    }
    let p = requested.trim();
    if (p === "" || p === "/") p = ".";
    // Normalize separators so Windows-style input behaves identically everywhere.
    p = p.replace(/\\/g, "/");
    // Strip a "workspace:/" alias prefix if the model echoes it back.
    p = p.replace(/^workspace:\/*/i, "");
    if (p === "") p = ".";

    const abs = path.resolve(this.root, p);
    const canonical = this.canonicalize(abs);
    const inGitMetadata = this.gitMetadataDirectory !== null && isPathWithin(this.gitMetadataDirectory, canonical);
    if (inGitMetadata || isPathWithin(this.internalProjectDataDirectory, canonical)) {
      throw new WorkspaceError(
        "ACCESS_DENIED_SENSITIVE_FILE",
        inGitMetadata
          ? "ACCESS_DENIED_SENSITIVE_FILE: Git metadata cannot be read."
          : "ACCESS_DENIED_SENSITIVE_FILE: internal workspace state cannot be read."
      );
    }
    if (!this.contains(canonical)) {
      throw new WorkspaceError(
        "PATH_OUTSIDE_WORKSPACE",
        `Path resolves outside the connected workspace: ${requested}`
      );
    }
    const relative = path.relative(this.root, canonical);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new WorkspaceError("PATH_OUTSIDE_WORKSPACE", `Path resolves outside the connected workspace: ${requested}`);
    }
    const rel = relative.split(path.sep).join("/");
    if (
      rel.split("/").includes(".git") ||
      (!opts.allowSensitive && rel !== "" && this.ignoreRules.isSensitive(rel))
    ) {
      throw new WorkspaceError(
        "ACCESS_DENIED_SENSITIVE_FILE",
        rel.split("/").includes(".git")
          ? "ACCESS_DENIED_SENSITIVE_FILE: Git metadata cannot be read."
          : `ACCESS_DENIED_SENSITIVE_FILE: '${rel}' matches the sensitive-file policy and cannot be read.`
      );
    }
    return { abs: canonical, rel };
  }

  resolve(requested: string, opts: { allowSensitive?: boolean } = {}): { abs: string; rel: string } {
    this.ignoreRules.refresh();
    return this.resolveAfterIgnoreRefresh(requested, opts);
  }

  /** Resolve a path after the caller refreshed rules once for its whole operation. */
  resolveVisibleAfterIgnoreRefresh(requested: string): { abs: string; rel: string } | null {
    try {
      const resolved = this.resolveAfterIgnoreRefresh(requested);
      if (
        this.ignoreRules.isHidden(resolved.rel) ||
        (resolved.rel !== "" && this.ignoreRules.isHidden(`${resolved.rel}/`))
      ) return null;
      return resolved;
    } catch (error) {
      if (error instanceof WorkspaceError) return null;
      throw error;
    }
  }

  async readFile(
    requested: string,
    opts: { startLine?: number; endLine?: number; maxLines?: number; maxBytes?: number } = {}
  ): Promise<ReadFileResult> {
    this.ignoreRules.refresh();
    return this.readFileAfterIgnoreRefresh(requested, opts);
  }

  /** @internal Used by read_many after refreshing rules once for the whole batch. */
  async readFileAfterIgnoreRefresh(
    requested: string,
    opts: { startLine?: number; endLine?: number; maxLines?: number; maxBytes?: number } = {}
  ): Promise<ReadFileResult> {
    const { abs, rel } = this.resolveAfterIgnoreRefresh(requested);
    let handle: Awaited<ReturnType<typeof openWorkspaceFile>>;
    try {
      handle = await openWorkspaceFile(this.root, abs);
    } catch (error) {
      if (isMissingPath(error)) throw new WorkspaceError("FILE_NOT_FOUND", `File not found: ${rel}`);
      if (error instanceof SafeOpenError) {
        if (error.reason === "NOT_A_FILE") throw new WorkspaceError("NOT_A_FILE", `Not a regular file: ${rel}`);
        throw new WorkspaceError("ACCESS_DENIED_SENSITIVE_FILE", "File identity changed while opening the workspace path.");
      }
      throw error;
    }
    try {
      const stat = await handle.stat();
      const probe = Buffer.alloc(8192);
      const { bytesRead: probeBytes } = await handle.read(probe, 0, probe.length, 0);
      if (probe.subarray(0, probeBytes).includes(0)) {
        throw new WorkspaceError("BINARY_FILE", `Binary file (${stat.size} bytes): ${rel}. Content is not returned.`);
      }
      if (stat.size > MAX_TEXT_SCAN_BYTES) {
        throw new WorkspaceError("FILE_TOO_LARGE", `Text file exceeds the ${MAX_TEXT_SCAN_BYTES}-byte scan limit: ${rel}`);
      }

      const startLine = Math.max(1, Math.floor(opts.startLine ?? 1));
      const maxLines = Math.min(HARD_MAX_LINES, Math.max(1, Math.floor(opts.maxLines ?? DEFAULT_MAX_LINES)));
      const endLimit = opts.endLine
        ? Math.min(Math.floor(opts.endLine), startLine + HARD_MAX_LINES - 1)
        : startLine + maxLines - 1;
      const maxBytes = Math.min(1024 * 1024, Math.max(1024, Math.floor(opts.maxBytes ?? DEFAULT_MAX_BYTES)));

      const lines: string[] = [];
      let totalLines = 0;
      let collectedBytes = 0;
      let byteTruncated = false;
      let actualEnd = startLine - 1;
      let lineParts: string[] = [];
      let lineBytes = 0;
      let lineOverflow = false;
      let lineHasData = false;
      let pendingCarriageReturn = false;
      const decoder = new StringDecoder("utf8");

      const collectCurrentLine = (): boolean => {
        totalLines++;
        if (totalLines >= startLine && totalLines <= endLimit && !byteTruncated) {
          let line = lineOverflow ? "" : lineParts.join("");
          if (line.endsWith("\r")) line = line.slice(0, -1);
          const cost = Buffer.byteLength(line, "utf8") + 1;
          if (lineOverflow || collectedBytes + cost > maxBytes) {
            if (lines.length === 0) return false;
            byteTruncated = true;
          } else {
            lines.push(line);
            collectedBytes += cost;
            actualEnd = totalLines;
          }
        }
        lineParts = [];
        lineBytes = 0;
        lineOverflow = false;
        lineHasData = false;
        return true;
      };

      const appendLineText = (piece: string): boolean => {
        if (piece.length === 0) return true;
        lineHasData = true;
        const isRequested = totalLines + 1 >= startLine && totalLines + 1 <= endLimit && !byteTruncated;
        if (!isRequested || lineOverflow) return true;
        const pieceBytes = Buffer.byteLength(piece, "utf8");
        const assemblyLimit = maxBytes - collectedBytes - 1;
        if (lineBytes + pieceBytes > assemblyLimit) {
          lineParts = [];
          lineOverflow = true;
          return lines.length > 0;
        }
        lineParts.push(piece);
        lineBytes += pieceBytes;
        return true;
      };

      const feedText = (text: string): boolean => {
        if (text.length === 0) return true;
        let offset = 0;
        if (pendingCarriageReturn) {
          pendingCarriageReturn = false;
          if (text[0] === "\n") offset = 1;
          if (!collectCurrentLine()) return false;
        }

        let segmentStart = offset;
        for (let index = offset; index < text.length; index++) {
          const character = text[index];
          if (character !== "\r" && character !== "\n") continue;
          if (!appendLineText(text.slice(segmentStart, index))) return false;
          if (character === "\r" && index === text.length - 1) {
            pendingCarriageReturn = true;
            segmentStart = index + 1;
            break;
          }
          if (character === "\r" && text[index + 1] === "\n") index++;
          if (!collectCurrentLine()) return false;
          segmentStart = index + 1;
        }
        return appendLineText(text.slice(segmentStart));
      };

      const chunk = Buffer.alloc(TEXT_READ_CHUNK_BYTES);
      let position = 0;
      while (position <= MAX_TEXT_SCAN_BYTES) {
        const length = Math.min(chunk.length, MAX_TEXT_SCAN_BYTES + 1 - position);
        const { bytesRead } = await handle.read(chunk, 0, length, position);
        if (bytesRead === 0) break;
        position += bytesRead;
        if (position > MAX_TEXT_SCAN_BYTES) {
          throw new WorkspaceError("FILE_TOO_LARGE", `Text file exceeds the ${MAX_TEXT_SCAN_BYTES}-byte scan limit: ${rel}`);
        }
        if (!feedText(decoder.write(chunk.subarray(0, bytesRead)))) {
          throw new WorkspaceError("FILE_TOO_LARGE", "First requested line exceeds the read byte budget; use a bounded local artifact.");
        }
      }
      if (!feedText(decoder.end())) {
        throw new WorkspaceError("FILE_TOO_LARGE", "First requested line exceeds the read byte budget; use a bounded local artifact.");
      }
      if (pendingCarriageReturn) {
        pendingCarriageReturn = false;
        if (!collectCurrentLine()) {
          throw new WorkspaceError("FILE_TOO_LARGE", "First requested line exceeds the read byte budget; use a bounded local artifact.");
        }
      } else if (lineHasData && !collectCurrentLine()) {
        throw new WorkspaceError("FILE_TOO_LARGE", "First requested line exceeds the read byte budget; use a bounded local artifact.");
      }
      const finalStat = await handle.stat();
      if (finalStat.size > MAX_TEXT_SCAN_BYTES) {
        throw new WorkspaceError("FILE_TOO_LARGE", `Text file exceeds the ${MAX_TEXT_SCAN_BYTES}-byte scan limit: ${rel}`);
      }

      const remaining = Math.max(0, totalLines - actualEnd);
      return {
        path: rel,
        sizeBytes: finalStat.size,
        totalLines,
        startLine: Math.min(startLine, Math.max(totalLines, 1)),
        endLine: actualEnd,
        truncated: remaining > 0,
        remainingLines: remaining,
        nextStartLine: remaining > 0 ? actualEnd + 1 : null,
        content: lines.join("\n"),
      };
    } finally {
      await handle.close();
    }
  }

  async listDirectory(
    requested: string,
    opts: { depth?: number; limit?: number; offset?: number } = {}
  ): Promise<ListDirectoryResult> {
    const { abs, rel } = this.resolve(requested);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(abs);
    } catch {
      throw new WorkspaceError("FILE_NOT_FOUND", `Directory not found: ${rel || "."}`);
    }
    if (!stat.isDirectory()) {
      throw new WorkspaceError("NOT_A_DIRECTORY", `Not a directory: ${rel}`);
    }
    const depth = Math.min(4, Math.max(1, Math.floor(opts.depth ?? 1)));
    const limit = Math.min(1000, Math.max(1, Math.floor(opts.limit ?? 200)));
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));

    const all: DirEntry[] = [];
    const walk = async (dirAbs: string, level: number): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dirAbs, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => {
        const ad = a.isDirectory() ? 0 : 1;
        const bd = b.isDirectory() ? 0 : 1;
        return ad !== bd ? ad - bd : a.name.localeCompare(b.name);
      });
      for (const entry of entries) {
        const childPath = this.resolveVisibleAfterIgnoreRefresh(path.join(dirAbs, entry.name));
        if (!childPath) continue;
        const { abs: childAbs, rel: childRel } = childPath;
        if (entry.isDirectory()) {
          all.push({ path: childRel + "/", type: "dir" });
          if (level < depth) await walk(childAbs, level + 1);
        } else if (entry.isFile()) {
          let size: number | undefined;
          try {
            size = (await fs.promises.stat(childAbs)).size;
          } catch {
            size = undefined;
          }
          all.push({ path: childRel, type: "file", sizeBytes: size });
        }
        if (all.length >= offset + limit + 2000) return; // hard cap for huge trees
      }
    };
    await walk(abs, 1);

    const page = all.slice(offset, offset + limit);
    return {
      path: rel || ".",
      entries: page,
      total: all.length,
      offset,
      limit,
      hasMore: offset + page.length < all.length,
    };
  }

  /** Lightweight project detection for workspace_info. */
  detectProject(): {
    projectType: string;
    languages: string[];
    frameworks: string[];
    packageManager: string | null;
    scripts: Record<string, string>;
  } {
    this.ignoreRules.refresh();
    const has = (f: string): boolean => fs.existsSync(path.join(this.root, f));
    const languages = new Set<string>();
    const frameworks = new Set<string>();
    let projectType = "unknown";
    let packageManager: string | null = null;
    let scripts: Record<string, string> = {};

    if (has("package.json")) {
      projectType = "node";
      languages.add("JavaScript");
      let rawPackage: unknown;
      try {
        this.resolveAfterIgnoreRefresh("package.json");
        rawPackage = readWorkspaceJson(this.root, path.join(this.root, "package.json"));
      } catch {
        rawPackage = undefined;
      }
      const pkg = rawPackage && typeof rawPackage === "object" && !Array.isArray(rawPackage)
        ? rawPackage as Record<string, unknown>
        : {};
      scripts = stringRecord(pkg.scripts);
      const deps = { ...stringRecord(pkg.dependencies), ...stringRecord(pkg.devDependencies) };
      const known: Record<string, string> = {
        next: "Next.js",
        react: "React",
        vue: "Vue",
        svelte: "Svelte",
        express: "Express",
        fastify: "Fastify",
        "@nestjs/core": "NestJS",
        electron: "Electron",
        vitest: "Vitest",
        jest: "Jest",
      };
      for (const [dep, label] of Object.entries(known)) {
        if (deps[dep]) frameworks.add(label);
      }
      if (has("pnpm-lock.yaml")) packageManager = "pnpm";
      else if (has("yarn.lock")) packageManager = "yarn";
      else if (has("bun.lockb") || has("bun.lock")) packageManager = "bun";
      else if (has("package-lock.json")) packageManager = "npm";
    }
    if (has("tsconfig.json")) languages.add("TypeScript");
    if (has("pyproject.toml") || has("requirements.txt") || has("setup.py")) {
      languages.add("Python");
      if (projectType === "unknown") projectType = "python";
    }
    if (has("Cargo.toml")) {
      languages.add("Rust");
      if (projectType === "unknown") projectType = "rust";
    }
    if (has("go.mod")) {
      languages.add("Go");
      if (projectType === "unknown") projectType = "go";
    }
    if (has("Package.swift")) {
      languages.add("Swift");
      if (projectType === "unknown") projectType = "swift";
    }
    return {
      projectType,
      languages: [...languages],
      frameworks: [...frameworks],
      packageManager,
      scripts,
    };
  }
}
