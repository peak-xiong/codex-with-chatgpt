import { spawnSync } from "node:child_process";
import path from "node:path";
import { IgnoreRules } from "./ignore.js";

export interface GitCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

const REPOSITORY_SELECTING_ENV = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_DIR",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NAMESPACE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
] as const;

function workspaceGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of REPOSITORY_SELECTING_ENV) delete env[name];
  return env;
}

export function runGit(root: string, args: string[]): GitCommandResult {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000,
    env: workspaceGitEnv(),
    windowsHide: true,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    code: result.status,
  };
}

export interface GitInfo {
  isRepo: boolean;
  branch: string | null;
  commit: string | null;
  dirty: boolean;
}

export function gitInfo(root: string): GitInfo {
  const check = runGit(root, ["rev-parse", "--is-inside-work-tree"]);
  if (!check.ok || check.stdout.trim() !== "true") {
    return { isRepo: false, branch: null, commit: null, dirty: false };
  }
  const branch = runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const commit = runGit(root, ["rev-parse", "--short", "HEAD"]);
  // Pathspec confines the result to the workspace subtree even when the
  // workspace root sits inside a larger repository.
  const status = runGit(root, ["status", "--porcelain", "--", "."]);
  return {
    isRepo: true,
    branch: branch.ok ? branch.stdout.trim() : null,
    commit: commit.ok ? commit.stdout.trim() : null,
    dirty: status.ok ? status.stdout.trim().length > 0 : false,
  };
}

export interface GitStatusResult {
  isRepo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: { path: string; change: string }[];
  unstaged: { path: string; change: string }[];
  untracked: string[];
  conflicted: string[];
  hidden: { changes: number; conflicts: number };
}

interface WorkspaceGitContext {
  repoRoot: string | null;
  workspacePrefix: string;
  ignoreRules: IgnoreRules;
}

function workspaceGitContext(target: GitTarget): WorkspaceGitContext {
  const root = typeof target === "string" ? target : target.root;
  const existingRules = typeof target === "object" ? target.ignoreRules : undefined;
  const ignoreRules = existingRules ?? new IgnoreRules(root);
  if (existingRules) ignoreRules.refresh();

  const topLevel = runGit(root, ["rev-parse", "--show-toplevel"]);
  const prefix = runGit(root, ["rev-parse", "--show-prefix"]);
  return {
    repoRoot: topLevel.ok ? topLevel.stdout.trim() : null,
    workspacePrefix: prefix.ok ? prefix.stdout.trim().replace(/\/+$/, "") : "",
    ignoreRules,
  };
}

function toWorkspacePath(repositoryPath: string, workspacePrefix: string): string | null {
  if (!workspacePrefix) return repositoryPath;
  const prefix = `${workspacePrefix}/`;
  return repositoryPath.startsWith(prefix) ? repositoryPath.slice(prefix.length) : null;
}

function normalizeWorkspaceScope(scope: string | undefined): string | undefined | null {
  if (scope === undefined || scope === "") return undefined;
  const normalized = path.posix.normalize(scope.replace(/\\/g, "/"));
  if (normalized === ".") return undefined;
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized) ||
    normalized.includes("\0")
  ) {
    return null;
  }
  return normalized;
}

export function gitStatus(target: GitTarget): GitStatusResult {
  const context = workspaceGitContext(target);
  const empty: GitStatusResult = {
    isRepo: false,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
    hidden: { changes: 0, conflicts: 0 },
  };
  if (!context.repoRoot) return empty;
  const result = runGit(context.repoRoot, [
    "status", "--porcelain=v2", "--branch", "-z",
  ]);
  if (!result.ok) return empty;
  const out: GitStatusResult = { ...empty, isRepo: true };
  const records = result.stdout.split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.startsWith("# branch.head ")) {
      out.branch = record.slice("# branch.head ".length).trim();
    } else if (record.startsWith("# branch.upstream ")) {
      out.upstream = record.slice("# branch.upstream ".length).trim();
    } else if (record.startsWith("# branch.ab ")) {
      const m = record.match(/\+(\d+) -(\d+)/);
      if (m) {
        out.ahead = parseInt(m[1], 10);
        out.behind = parseInt(m[2], 10);
      }
    } else if (record.startsWith("1 ") || record.startsWith("2 ")) {
      const isRename = record.startsWith("2 ");
      const parts = record.split(" ");
      const xy = parts[1];
      const repositoryPath = parts.slice(isRename ? 9 : 8).join(" ");
      const originalRepositoryPath = isRename ? records[++i] ?? "" : "";
      const filePath = toWorkspacePath(repositoryPath, context.workspacePrefix);
      const originalPath = isRename
        ? toWorkspacePath(originalRepositoryPath, context.workspacePrefix)
        : "";
      if (filePath === null || (isRename && originalPath === null)) {
        if (filePath !== null || (isRename && originalPath !== null)) out.hidden.changes++;
        continue;
      }
      const displayPath = isRename ? `${filePath} -> ${originalPath}` : filePath;
      if (
        context.ignoreRules.isSensitive(filePath) ||
        (isRename && context.ignoreRules.isSensitive(originalPath!))
      ) {
        out.hidden.changes++;
        continue;
      }
      const x = xy[0];
      const y = xy[1];
      if (x !== ".") out.staged.push({ path: displayPath, change: x });
      if (y !== ".") out.unstaged.push({ path: displayPath, change: y });
    } else if (record.startsWith("? ")) {
      const filePath = toWorkspacePath(record.slice(2), context.workspacePrefix);
      if (filePath === null) continue;
      if (context.ignoreRules.isSensitive(filePath)) out.hidden.changes++;
      else out.untracked.push(filePath);
    } else if (record.startsWith("u ")) {
      const parts = record.split(" ");
      const filePath = toWorkspacePath(parts.slice(10).join(" "), context.workspacePrefix);
      if (filePath === null) continue;
      if (context.ignoreRules.isSensitive(filePath)) out.hidden.conflicts++;
      else out.conflicted.push(filePath);
    }
  }
  return out;
}

export type DiffMode = "unstaged" | "staged" | "head";

export interface GitDiffOptions {
  mode?: DiffMode;
  path?: string;
  offset?: number;
  maxBytes?: number;
}

export interface GitDiffResult {
  isRepo: boolean;
  mode: DiffMode;
  totalBytes: number;
  offset: number;
  returnedBytes: number;
  hasMore: boolean;
  nextOffset: number | null;
  diff: string;
}

export interface WorkspaceLike {
  root: string;
  ignoreRules?: IgnoreRules;
}

export type GitTarget = string | WorkspaceLike;

function getDiffModeArgs(mode: DiffMode): string[] {
  if (mode === "staged") return ["--cached"];
  if (mode === "head") return ["HEAD"];
  return [];
}

const MAX_DIFF_PATHSPEC_COUNT = 50;
const MAX_DIFF_PATHSPEC_BYTES = 32 * 1024;

function pathspecsFitBudget(pathspecs: string[]): boolean {
  return pathspecs.length <= MAX_DIFF_PATHSPEC_COUNT &&
    pathspecs.reduce((total, spec) => total + Buffer.byteLength(spec, "utf8") + 1, 0) <=
      MAX_DIFF_PATHSPEC_BYTES;
}

function chunkSafePaths(
  paths: string[],
  rejectedPathGroups: string[][],
  outOfScopePaths: string[],
): string[][] | null {
  const batches: string[][] = [];
  let positivePathspecs: string[] = [];
  let excludedPathspecs = new Set<string>();

  for (const filePath of paths) {
    // Literal pathspecs can include descendants, but cannot include ancestors.
    const exclusions = new Set(
      outOfScopePaths.filter((excludedPath) => isPathInScope(excludedPath, filePath)),
    );
    for (const group of rejectedPathGroups) {
      if (group.some((excludedPath) => isPathInScope(excludedPath, filePath))) {
        // Keep both endpoints of a safety-rejected rename out of the diff.
        for (const excludedPath of group) exclusions.add(excludedPath);
      }
    }
    const positivePathspec = `:(top,literal)${filePath}`;
    const requiredExclusions = [...exclusions].map(
      (excludedPath) => `:(top,exclude,literal)${excludedPath}`,
    );
    let nextExclusions = new Set([...excludedPathspecs, ...requiredExclusions]);
    if (!pathspecsFitBudget([...positivePathspecs, positivePathspec, ...nextExclusions])) {
      if (!pathspecsFitBudget([positivePathspec, ...requiredExclusions])) return null;
      batches.push([...positivePathspecs, ...excludedPathspecs]);
      positivePathspecs = [];
      nextExclusions = new Set(requiredExclusions);
    }
    positivePathspecs.push(positivePathspec);
    excludedPathspecs = nextExclusions;
  }
  if (positivePathspecs.length > 0) {
    batches.push([...positivePathspecs, ...excludedPathspecs]);
  }
  return batches;
}

function isPathInScope(filePath: string, scope?: string): boolean {
  if (!scope || scope === ".") return true;
  return filePath === scope || filePath.startsWith(scope + "/");
}

export function gitDiff(
  target: GitTarget,
  opts: GitDiffOptions = {},
  relPath?: string
): GitDiffResult {
  const context = workspaceGitContext(target);

  const mode = opts.mode ?? "unstaged";
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const maxBytes = Math.min(256 * 1024, Math.max(1024, Math.floor(opts.maxBytes ?? 64 * 1024)));
  const modeArgs = getDiffModeArgs(mode);
  const requestedScope = normalizeWorkspaceScope(opts.path ?? relPath);
  if (!context.repoRoot || requestedScope === null) {
    return {
      isRepo: context.repoRoot !== null,
      mode,
      totalBytes: 0,
      offset: 0,
      returnedBytes: 0,
      hasMore: false,
      nextOffset: null,
      diff: "",
    };
  }

  // Keep rename provenance across workspace and requested-path boundaries.
  const listArgs = [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--name-status",
    "-z",
    "--find-renames=1%",
    ...modeArgs,
  ];
  const listResult = runGit(context.repoRoot, listArgs);
  if (!listResult.ok) {
    return {
      isRepo: false,
      mode,
      totalBytes: 0,
      offset: 0,
      returnedBytes: 0,
      hasMore: false,
      nextOffset: null,
      diff: "",
    };
  }

  const tokens = listResult.stdout.split("\0");
  const safePaths = new Set<string>();
  const rejectedPathGroups: string[][] = [];
  const outOfScopePaths = new Set<string>();
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i++];
    if (!status) break;
    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = tokens[i++];
      const newPath = tokens[i++];
      if (oldPath && newPath) {
        const oldWorkspacePath = toWorkspacePath(oldPath, context.workspacePrefix);
        const newWorkspacePath = toWorkspacePath(newPath, context.workspacePrefix);
        const isSafe = oldWorkspacePath !== null && newWorkspacePath !== null &&
          !context.ignoreRules.isSensitive(oldWorkspacePath) &&
          !context.ignoreRules.isSensitive(newWorkspacePath);
        const isRelevant = requestedScope === undefined ||
          (oldWorkspacePath !== null && isPathInScope(oldWorkspacePath, requestedScope)) ||
          (newWorkspacePath !== null && isPathInScope(newWorkspacePath, requestedScope));
        if (!isSafe) {
          rejectedPathGroups.push([oldPath, newPath]);
        } else if (isRelevant) {
          safePaths.add(oldPath);
          safePaths.add(newPath);
        } else {
          outOfScopePaths.add(oldPath);
          outOfScopePaths.add(newPath);
        }
      }
    } else {
      const filePath = tokens[i++];
      if (filePath) {
        const workspacePath = toWorkspacePath(filePath, context.workspacePrefix);
        const isSafe = workspacePath !== null && !context.ignoreRules.isSensitive(workspacePath);
        const isRelevant = requestedScope === undefined ||
          (workspacePath !== null && isPathInScope(workspacePath, requestedScope));
        if (!isSafe) {
          rejectedPathGroups.push([filePath]);
        } else if (isRelevant) {
          safePaths.add(filePath);
        } else {
          outOfScopePaths.add(filePath);
        }
      }
    }
  }

  if (safePaths.size === 0) {
    return {
      isRepo: true,
      mode,
      totalBytes: 0,
      offset: 0,
      returnedBytes: 0,
      hasMore: false,
      nextOffset: null,
      diff: "",
    };
  }

  // 2. Fetch diffs for safe paths in bounded batches (path count + argv bytes)
  const rejectedPaths = new Set(rejectedPathGroups.flat());
  const batches = chunkSafePaths(
    [...safePaths].filter((filePath) => !rejectedPaths.has(filePath)),
    rejectedPathGroups,
    [...outOfScopePaths],
  );
  if (!batches) {
    return {
      isRepo: false,
      mode,
      totalBytes: 0,
      offset: 0,
      returnedBytes: 0,
      hasMore: false,
      nextOffset: null,
      diff: "",
    };
  }
  let combinedDiff = "";
  let totalAggregateBytes = 0;
  const MAX_AGGREGATE_DIFF_BYTES = 64 * 1024 * 1024;

  for (const pathspecs of batches) {
    const diffArgs = [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--find-renames=1%",
      ...modeArgs,
      "--",
      ...pathspecs,
    ];
    const diffResult = runGit(context.repoRoot, diffArgs);
    if (!diffResult.ok) {
      // Fail closed on any batch error: never return partial silent success
      return {
        isRepo: false,
        mode,
        totalBytes: 0,
        offset: 0,
        returnedBytes: 0,
        hasMore: false,
        nextOffset: null,
        diff: "",
      };
    }
    if (diffResult.stdout) {
      const chunkBytes = Buffer.byteLength(diffResult.stdout, "utf8");
      if (totalAggregateBytes + chunkBytes > MAX_AGGREGATE_DIFF_BYTES) {
        // Fail closed on aggregate cap: do not fake a partial successful diff
        return {
          isRepo: false,
          mode,
          totalBytes: 0,
          offset: 0,
          returnedBytes: 0,
          hasMore: false,
          nextOffset: null,
          diff: "",
        };
      }
      combinedDiff += diffResult.stdout;
      totalAggregateBytes += chunkBytes;
    }
  }

  const full = Buffer.from(combinedDiff, "utf8");
  const slice = full.subarray(offset, offset + maxBytes);
  let text = slice.toString("utf8");
  let sliceLen = slice.length;
  // Avoid cutting mid-line when more content follows.
  if (offset + sliceLen < full.length) {
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline > 0) {
      text = text.slice(0, lastNewline + 1);
      sliceLen = Buffer.byteLength(text, "utf8");
    }
  }
  const hasMore = offset + sliceLen < full.length;
  return {
    isRepo: true,
    mode,
    totalBytes: full.length,
    offset,
    returnedBytes: sliceLen,
    hasMore,
    nextOffset: hasMore ? offset + sliceLen : null,
    diff: text,
  };
}
