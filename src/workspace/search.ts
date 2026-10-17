import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import os from "node:os";
import { Workspace, WorkspaceError } from "./manager.js";
import { openWorkspaceFile, SafeOpenError } from "./safe-open.js";
import { redact } from "../logger/index.js";

export interface SearchOptions {
  query: string;
  path?: string;
  glob?: string;
  limit?: number;
  regex?: boolean;
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface SearchResult {
  matches: SearchMatch[];
  matchCount: number;
  truncated: boolean;
  engine: "ripgrep" | "node";
}

export const MAX_SEARCH_QUERY_LENGTH = 1_024;
export const MAX_SEARCH_GLOB_LENGTH = 512;

const RG_CANDIDATES = [
  "rg",
  "/opt/homebrew/bin/rg",
  "/usr/local/bin/rg",
  "/usr/bin/rg",
  "/Applications/Cursor.app/Contents/Resources/app/node_modules/@vscode/ripgrep/bin/rg",
  "/Applications/Visual Studio Code.app/Contents/Resources/app/node_modules/@vscode/ripgrep/bin/rg",
];
const MAX_RG_STDERR_BYTES = 4096;
const MAX_RG_DIAGNOSTIC_CHARS = 512;
const MAX_NODE_SEARCH_FILE_BYTES = 2 * 1024 * 1024;

function safeDiagnostic(message: string, ws: Workspace, query: string): string {
  let diagnostic = redact(message);
  for (const [needle, replacement] of [
    [query, "<query>"], [ws.root, "<workspace>"], [os.homedir(), "<home>"],
  ] as const) {
    if (needle) diagnostic = diagnostic.split(needle).join(replacement);
  }
  return diagnostic.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, MAX_RG_DIAGNOSTIC_CHARS);
}

let cachedRg: string | null | undefined;

export function findRipgrep(): string | null {
  if (process.env.C2C_DISABLE_RG === "1") return null;
  if (cachedRg !== undefined) return cachedRg;
  if (process.env.C2C_RG_PATH) {
    cachedRg = process.env.C2C_RG_PATH;
    return cachedRg;
  }
  for (const candidate of RG_CANDIDATES) {
    try {
      const result = spawnSync(candidate, ["--version"], {
        stdio: "ignore",
        timeout: 3000,
        windowsHide: true,
      });
      if (result.status === 0) {
        cachedRg = candidate;
        return candidate;
      }
    } catch {
      // try next candidate
    }
  }
  cachedRg = null;
  return null;
}

/** For tests. */
export function resetRipgrepCache(): void {
  cachedRg = undefined;
}

async function searchWithRipgrep(
  ws: Workspace,
  rgBin: string,
  searchAbs: string,
  opts: SearchOptions,
  limit: number
): Promise<SearchResult> {
  const args = ["--json", "--max-filesize", "2M", "--max-count", String(limit + 1)];
  if (!opts.regex) args.push("-F");
  args.push("--smart-case");
  if (opts.glob) args.push("-g", opts.glob);
  args.push("--", opts.query, searchAbs);

  return new Promise((resolvePromise, reject) => {
    const child = spawn(rgBin, args, { cwd: ws.root, windowsHide: true });
    const matches: SearchMatch[] = [];
    let truncated = false;
    let terminatedForLimit = false;
    let outputError = false;
    let settled = false;
    let stderrBytes = 0;
    const stderrChunks: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer | string) => {
      if (stderrBytes >= MAX_RG_STDERR_BYTES) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const kept = bytes.subarray(0, MAX_RG_STDERR_BYTES - stderrBytes);
      stderrChunks.push(kept);
      stderrBytes += kept.length;
    });

    const settleError = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      if (terminatedForLimit) return;
      try {
        const event = JSON.parse(line) as {
          type: string;
          data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
        };
        if (event.type !== "match" || !event.data?.path?.text) return;
        const visiblePath = ws.resolveVisibleAfterIgnoreRefresh(event.data.path.text);
        if (!visiblePath) return;
        const { rel } = visiblePath;
        if (matches.length >= limit) {
          truncated = true;
          if (!terminatedForLimit) {
            terminatedForLimit = true;
            child.kill("SIGTERM");
          }
          return;
        }
        matches.push({
          path: rel,
          line: event.data.line_number ?? 0,
          text: (event.data.lines?.text ?? "").trimEnd().slice(0, 500),
        });
      } catch {
        outputError = true;
      }
    });
    child.stdout.on("error", settleError);
    child.on("error", (error) => {
      const diagnostic = safeDiagnostic(error.message, ws, opts.query);
      settleError(new WorkspaceError("SEARCH_FAILED", `ripgrep could not start${diagnostic ? `: ${diagnostic}` : ""}`));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      if (outputError) {
        settleError(new WorkspaceError("SEARCH_FAILED", "ripgrep returned malformed JSON output."));
        return;
      }
      if (code === 0 || (terminatedForLimit && code === null && signal === "SIGTERM")) {
        settled = true;
        resolvePromise({ matches, matchCount: matches.length, truncated, engine: "ripgrep" });
        return;
      }
      if (code === 1 && matches.length === 0 && !terminatedForLimit) {
        settled = true;
        resolvePromise({ matches: [], matchCount: 0, truncated: false, engine: "ripgrep" });
        return;
      }
      const diagnostic = safeDiagnostic(Buffer.concat(stderrChunks).toString("utf8").trim(), ws, opts.query);
      const status = signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`;
      const details = diagnostic ? `: ${diagnostic}` : "";
      settleError(new WorkspaceError("SEARCH_FAILED", `ripgrep failed (${status})${details}`));
    });
  });
}

async function searchWithNode(
  ws: Workspace,
  searchAbs: string,
  opts: SearchOptions,
  limit: number
): Promise<SearchResult> {
  const needle = opts.query.toLowerCase();
  const globRegex = opts.glob ? globToRegex(opts.glob) : null;
  const matches: SearchMatch[] = [];
  let truncated = false;

  const walk = async (dirAbs: string): Promise<void> => {
    if (truncated) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      const visiblePath = ws.resolveVisibleAfterIgnoreRefresh(path.join(dirAbs, entry.name));
      if (!visiblePath) continue;
      const { abs: childAbs, rel: childRel } = visiblePath;
      if (entry.isDirectory()) {
        await walk(childAbs);
      } else if (entry.isFile()) {
        if (globRegex && !globRegex.test(childRel)) continue;
        let handle: Awaited<ReturnType<typeof openWorkspaceFile>>;
        try {
          handle = await openWorkspaceFile(ws.root, childAbs);
        } catch (error) {
          if (error instanceof SafeOpenError) {
            throw new WorkspaceError("ACCESS_DENIED_SENSITIVE_FILE", "File identity changed while opening the workspace path.");
          }
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") {
            throw new WorkspaceError("SEARCH_FAILED", "Node search could not open a workspace file.");
          }
          continue;
        }
        try {
          const stat = await handle.stat();
          if (stat.size > MAX_NODE_SEARCH_FILE_BYTES) continue;
          const buffer = Buffer.alloc(MAX_NODE_SEARCH_FILE_BYTES + 1);
          let size = 0;
          while (size < buffer.length) {
            const { bytesRead } = await handle.read(buffer, size, Math.min(64 * 1024, buffer.length - size), size);
            if (bytesRead === 0) break;
            size += bytesRead;
          }
          if (size > MAX_NODE_SEARCH_FILE_BYTES || buffer.subarray(0, Math.min(size, 8192)).includes(0)) continue;
          const lines = buffer.toString("utf8", 0, size).split("\n");
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i].replace(/\r$/, "");
            const hit = line.toLowerCase().includes(needle);
            if (hit) {
              if (matches.length >= limit) {
                truncated = true;
                return;
              }
              matches.push({ path: childRel, line: i + 1, text: line.trimEnd().slice(0, 500) });
            }
          }
        } finally {
          await handle.close();
        }
      }
    }
  };

  await walk(searchAbs);
  return { matches, matchCount: matches.length, truncated, engine: "node" };
}

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]]/g, "\\$&")
    .replace(/\*\*\//g, "\u0000")
    .replace(/\*\*/g, "\u0001")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, "(?:.*/)?")
    .replace(/\u0001/g, ".*");
  return new RegExp(`(^|/)${escaped}$`, "i");
}

export async function searchWorkspace(ws: Workspace, opts: SearchOptions): Promise<SearchResult> {
  if (!opts.query || opts.query.length < 2) {
    return { matches: [], matchCount: 0, truncated: false, engine: "node" };
  }
  if (opts.query.length > MAX_SEARCH_QUERY_LENGTH) {
    throw new WorkspaceError(
      "SEARCH_QUERY_TOO_LARGE",
      `search query must not exceed ${MAX_SEARCH_QUERY_LENGTH} characters`
    );
  }
  if (opts.glob && opts.glob.length > MAX_SEARCH_GLOB_LENGTH) {
    throw new WorkspaceError(
      "SEARCH_QUERY_TOO_LARGE",
      `search glob must not exceed ${MAX_SEARCH_GLOB_LENGTH} characters`
    );
  }
  const limit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 50)));
  const { abs } = ws.resolve(opts.path ?? ".");
  const rg = findRipgrep();
  if (rg) {
    return searchWithRipgrep(ws, rg, abs, opts, limit);
  }
  if (opts.regex) {
    throw new WorkspaceError(
      "REGEX_ENGINE_UNAVAILABLE",
      "regular expression search requires ripgrep; the Node fallback supports literal search only"
    );
  }
  return searchWithNode(ws, abs, opts, limit);
}
