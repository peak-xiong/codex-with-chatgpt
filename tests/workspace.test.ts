import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Workspace, WorkspaceError } from "../src/workspace/manager.js";
import { IgnoreRulesError } from "../src/workspace/ignore.js";
import { makeTmpDir, cleanup, write, git, makeGitRepo, isolateStateDir } from "./helpers.js";
import { getProjectDataDir, getWorkspaceDataDir } from "../src/config/paths.js";
import { projectDataDirectory, projectIdMetadataPath } from "../src/workspace/identity.js";
import { readMany } from "../src/workspace/read-many.js";
import { openControlRequest } from "../src/control/requests.js";
import { saveExecutionOutput, listExecutionOutputs } from "../src/execution/output.js";
import { appendExecutionRecord, readExecutionRecords } from "../src/execution/records.js";
import { commitSessionRoute, readSession } from "../src/session/state.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function resolveProjectIdInChild(
  root: string,
  extraEnv: Record<string, string> = {}
): Promise<string> {
  const identityUrl = pathToFileURL(path.join(projectRoot, "src", "workspace", "identity.ts")).href;
  const script = `import { resolveProjectId } from ${JSON.stringify(identityUrl)}; process.stdout.write(resolveProjectId(process.env.C2C_PROJECT_ROOT));`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: projectRoot,
      env: { ...process.env, ...extraEnv, C2C_PROJECT_ROOT: root },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let error = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      error += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(output.trim());
      else reject(new Error(`project identity child exited ${code}: ${error}`));
    });
  });
}

let root: string;
let outside: string;
let ws: Workspace;
let symlinksReady: boolean;

beforeAll(() => {
  root = makeTmpDir("ws");
  outside = makeTmpDir("outside");
  write(root, "hello.txt", "hello world\n");
  write(root, "src/app.ts", "const x = 1;\n");
  write(root, ".env", "SECRET=topsecret\n");
  write(root, ".env.production", "SECRET=prod\n");
  write(root, ".env.example", "SECRET=changeme\n");
  write(root, "certs/server.pem", "PRIVATE KEY\n");
  write(root, "keys/id_rsa", "PRIVATE KEY\n");
  write(root, "nested/.ssh/config", "Host *\n");
  write(outside, "secret.txt", "outside data\n");
  write(root, ".c2cignore", "private-notes/\n");
  write(root, "private-notes/todo.md", "secret notes\n");
  // symlink pointing outside the workspace (needs symlink privileges, e.g.
  // absent for unprivileged Windows runners — the escape tests then skip)
  symlinksReady = true;
  try {
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link-out.txt"));
    fs.symlinkSync(outside, path.join(root, "dir-out"));
  } catch {
    symlinksReady = false;
  }
  ws = new Workspace(root);
});

afterAll(() => {
  cleanup(root);
  cleanup(outside);
});

describe("path containment", () => {
  it("reads a normal relative path", async () => {
    const result = await ws.readFile("hello.txt");
    expect(result.content).toContain("hello world");
  });

  it("rejects ../ traversal", () => {
    expect(() => ws.resolve("../outside-file")).toThrowError(WorkspaceError);
    expect(() => ws.resolve("../../etc/passwd")).toThrow(/PATH_OUTSIDE|outside/i);
    try {
      ws.resolve("a/../../b");
    } catch (error) {
      expect((error as WorkspaceError).code).toBe("PATH_OUTSIDE_WORKSPACE");
    }
  });

  it("rejects absolute paths outside the workspace", () => {
    expect(() => ws.resolve("/etc/passwd")).toThrowError(WorkspaceError);
    expect(() => ws.resolve(outside)).toThrowError(WorkspaceError);
  });

  it("allows absolute paths inside the workspace", () => {
    const resolved = ws.resolve(path.join(root, "hello.txt"));
    expect(resolved.rel).toBe("hello.txt");
  });

  it("rejects windows-style traversal", () => {
    expect(() => ws.resolve("..\\..\\etc\\passwd")).toThrowError(WorkspaceError);
  });

  it("rejects null bytes", () => {
    expect(() => ws.resolve("hello.txt\0.png")).toThrowError(WorkspaceError);
  });

  it("rejects symlinked file escaping the workspace", () => {
    if (!symlinksReady) return; // symlink privilege unavailable
    try {
      ws.resolve("link-out.txt");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as WorkspaceError).code).toBe("PATH_OUTSIDE_WORKSPACE");
    }
  });

  it("rejects paths through a symlinked directory escaping the workspace", () => {
    if (!symlinksReady) return; // symlink privilege unavailable
    try {
      ws.resolve("dir-out/secret.txt");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as WorkspaceError).code).toBe("PATH_OUTSIDE_WORKSPACE");
    }
  });
});

describe("sensitive files", () => {
  const expectDenied = (p: string): void => {
    try {
      ws.resolve(p);
      expect.unreachable(`expected ${p} to be denied`);
    } catch (error) {
      expect((error as WorkspaceError).code).toBe("ACCESS_DENIED_SENSITIVE_FILE");
    }
  };

  it("denies .env and variants", () => {
    expectDenied(".env");
    expectDenied(".env.production");
  });

  it("allows .env.example", () => {
    expect(ws.resolve(".env.example").rel).toBe(".env.example");
  });

  it("denies keys and certificates", () => {
    expectDenied("certs/server.pem");
    expectDenied("keys/id_rsa");
  });

  it("denies .ssh directories anywhere", () => {
    expectDenied("nested/.ssh/config");
  });

  it("honors .c2cignore custom rules", () => {
    expectDenied("private-notes/todo.md");
  });

  it("hides sensitive files from directory listing", async () => {
    const listing = await ws.listDirectory(".", { limit: 500, depth: 2 });
    const paths = listing.entries.map((entry) => entry.path);
    expect(paths).toContain("hello.txt");
    expect(paths).not.toContain(".env");
    expect(paths.some((p) => p.includes("private-notes"))).toBe(false);
  });
});

describe("read_file pagination", () => {
  it("caps unbounded reads at 400 lines and reports the remainder", async () => {
    const big = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    write(root, "big.txt", big);
    const result = await ws.readFile("big.txt");
    expect(result.totalLines).toBe(1000);
    expect(result.endLine).toBe(400);
    expect(result.truncated).toBe(true);
    expect(result.remainingLines).toBe(600);
    expect(result.nextStartLine).toBe(401);
  });

  it("returns an explicit range", async () => {
    const result = await ws.readFile("big.txt", { startLine: 500, endLine: 502 });
    expect(result.content).toBe("line 500\nline 501\nline 502");
    expect(result.startLine).toBe(500);
    expect(result.endLine).toBe(502);
  });

  it("denies binary files", async () => {
    fs.writeFileSync(path.join(root, "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
    await expect(ws.readFile("blob.bin")).rejects.toMatchObject({ code: "BINARY_FILE" });
  });

  it("reports FILE_NOT_FOUND for missing files", async () => {
    await expect(ws.readFile("nope.txt")).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
  });

  it("preserves readline CRLF and bare-CR line semantics across chunk boundaries", async () => {
    const boundaryLine = "a".repeat(65_535);
    write(root, "newline-separators.txt", `${boundaryLine}\r\nsecond\rthird\nfourth`);
    const bareCrLine = "b".repeat(65_535);
    write(root, "bare-cr-boundary.txt", `${bareCrLine}\rnext`);
    const utf8BoundaryLine = "c".repeat(65_535) + "中";
    write(root, "utf8-boundary.txt", `${utf8BoundaryLine}\r\nlast`);

    const whole = await ws.readFile("newline-separators.txt", { maxBytes: 100_000 });
    expect(whole.totalLines).toBe(4);
    expect(whole.content).toBe(`${boundaryLine}\nsecond\nthird\nfourth`);
    const page = await ws.readFile("newline-separators.txt", {
      startLine: 2,
      endLine: 3,
      maxBytes: 1024,
    });
    expect(page.totalLines).toBe(4);
    expect(page.content).toBe("second\nthird");
    expect(page.startLine).toBe(2);
    expect(page.endLine).toBe(3);
    expect(page.remainingLines).toBe(1);

    const bareCr = await ws.readFile("bare-cr-boundary.txt", { maxBytes: 70_000 });
    expect(bareCr.totalLines).toBe(2);
    expect(bareCr.content).toBe(`${bareCrLine}\nnext`);
    const utf8 = await ws.readFile("utf8-boundary.txt", { maxBytes: 70_000 });
    expect(utf8.totalLines).toBe(2);
    expect(utf8.content).toBe(`${utf8BoundaryLine}\nlast`);
  });

  it("stops scanning a first requested line once its chunk exceeds the byte budget", async () => {
    const longLine = write(root, "oversized-line.txt", "x".repeat(2 * 1024 * 1024));
    const originalOpen = fs.promises.open.bind(fs.promises);
    let bytesRead = 0;
    const openSpy = vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      return new Proxy(handle, {
        get(target, property) {
          const value = Reflect.get(target, property, target) as unknown;
          if (property === "read") {
            return async (...readArgs: unknown[]) => {
              const result = await Reflect.apply(value as (...values: unknown[]) => Promise<{ bytesRead: number }>, target, readArgs);
              bytesRead += result.bytesRead;
              return result;
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Awaited<ReturnType<typeof fs.promises.open>>;
    });
    try {
      await expect(ws.readFile("oversized-line.txt", { maxBytes: 1024 })).rejects.toMatchObject({
        code: "FILE_TOO_LARGE",
      });
      expect(bytesRead).toBeLessThanOrEqual(8 * 1024 + 64 * 1024);
      expect(fs.statSync(longLine).size).toBe(2 * 1024 * 1024);
    } finally {
      openSpy.mockRestore();
    }
  });

  it("rejects text scans above the fixed 8 MiB cap", async () => {
    write(root, "scan-cap.txt", "x".repeat(8 * 1024 * 1024 + 1));
    await expect(ws.readFile("scan-cap.txt")).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
  });
});

describe("workspace state read isolation", () => {
  it("denies Git metadata and project state for Git, linked, and non-Git workspaces", async () => {
    const previousStateDir = process.env.C2C_STATE_DIR;
    const stateDir = isolateStateDir();
    const repo = makeTmpDir("internal-state-repo");
    const linked = `${repo}-linked`;
    const plain = makeTmpDir("internal-state-plain");
    try {
      makeGitRepo(repo);
      git(repo, "worktree", "add", "-b", "internal-state-linked", linked);
      const primaryWorkspace = new Workspace(repo);
      const linkedWorkspace = new Workspace(linked);
      const plainWorkspace = new Workspace(plain);
      expect(projectDataDirectory(linked)).toBe(projectDataDirectory(repo));

      const assertDenied = (workspace: Workspace, file: string): void => {
        const aliases = [file, path.join(workspace.root, file)];
        if (!path.isAbsolute(file)) {
          aliases.push(`workspace:/${file}`, file.replace(/\\/g, "/").replace(/\//g, "\\"));
        }
        for (const requested of aliases) {
          expect(() => workspace.resolve(requested, { allowSensitive: true })).toThrowError(
            expect.objectContaining<Partial<WorkspaceError>>({ code: "ACCESS_DENIED_SENSITIVE_FILE" }),
          );
        }
      };
      const primaryData = path.join(projectDataDirectory(repo), "workspaces", primaryWorkspace.id, "execution.json");
      const linkedData = path.join(projectDataDirectory(linked), "workspaces", linkedWorkspace.id, "execution.json");
      const plainData = path.join(projectDataDirectory(plain), "workspaces", plainWorkspace.id, "execution.json");
      fs.mkdirSync(path.dirname(primaryData), { recursive: true });
      fs.mkdirSync(path.dirname(linkedData), { recursive: true });
      fs.mkdirSync(path.dirname(plainData), { recursive: true });
      fs.writeFileSync(primaryData, "private execution record");
      fs.writeFileSync(linkedData, "private linked execution record");
      fs.writeFileSync(plainData, "private plain execution record");

      assertDenied(primaryWorkspace, path.relative(repo, primaryData));
      assertDenied(primaryWorkspace, ".git/HEAD");
      assertDenied(linkedWorkspace, linkedData);
      assertDenied(plainWorkspace, path.relative(plain, plainData));
      expect(() => primaryWorkspace.resolve("..notes.ts")).not.toThrow();
      write(repo, "src/allowed.ts", "export const safe = true;\n");
      await expect(primaryWorkspace.readFile("src/allowed.ts")).resolves.toMatchObject({
        content: "export const safe = true;",
      });
    } finally {
      cleanup(repo);
      cleanup(linked);
      cleanup(plain);
      cleanup(stateDir);
      if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
      else process.env.C2C_STATE_DIR = previousStateDir;
    }
  });

  it("denies the full separate Git metadata directory through reads and hides it from listings", async () => {
    const previousStateDir = process.env.C2C_STATE_DIR;
    const stateDir = isolateStateDir();
    const repo = makeTmpDir("separate-git-dir");
    try {
      const gitMetadata = path.join(repo, "gitmeta");
      git(repo, "init", "--separate-git-dir", gitMetadata, "-b", "main");
      write(repo, "src/allowed.ts", "export const allowed = true;\n");
      const workspace = new Workspace(repo);
      expect(path.dirname(projectIdMetadataPath(repo)!)).toBe(gitMetadata);

      const sentinel = path.join(
        projectDataDirectory(repo), "workspaces", workspace.id, "execution-record.json",
      );
      write(repo, path.relative(repo, sentinel), "separate-git-execution-sentinel");
      const relativeSentinel = path.relative(repo, sentinel);

      await expect(workspace.readFile(relativeSentinel)).rejects.toMatchObject({
        code: "ACCESS_DENIED_SENSITIVE_FILE",
      });
      expect(() => workspace.resolve("gitmeta/c2c-project-id", { allowSensitive: true })).toThrowError(
        expect.objectContaining<Partial<WorkspaceError>>({ code: "ACCESS_DENIED_SENSITIVE_FILE" }),
      );
      const batch = await readMany(workspace, [
        { path: relativeSentinel },
        { path: "src/allowed.ts" },
      ], 4096);
      expect(batch.items).toMatchObject([
        { index: 0, error: "ACCESS_DENIED_SENSITIVE_FILE" },
        { index: 1, file: { path: "src/allowed.ts", content: "export const allowed = true;" } },
      ]);

      const listing = await workspace.listDirectory(".", { depth: 4, limit: 500 });
      expect(listing.entries.map((entry) => entry.path)).toContain("src/allowed.ts");
      expect(listing.entries.some((entry) => entry.path === "gitmeta/" || entry.path.startsWith("gitmeta/"))).toBe(false);
      await expect(workspace.readFile("src/allowed.ts")).resolves.toMatchObject({
        content: "export const allowed = true;",
      });
    } finally {
      cleanup(repo);
      cleanup(stateDir);
      if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
      else process.env.C2C_STATE_DIR = previousStateDir;
    }
  });

  it("refreshes ignore rules per operation and preserves them when refresh fails", () => {
    const root = makeTmpDir("ignore-refresh");
    const previousStateDir = process.env.C2C_STATE_DIR;
    const stateDir = isolateStateDir();
    try {
      write(root, ".c2cignore", "private/\n");
      write(root, "private/notes.txt", "private");
      write(root, "new-private.txt", "private");
      const workspace = new Workspace(root);
      expect(() => workspace.resolve("private/notes.txt")).toThrow();

      write(root, ".c2cignore", "new-private.txt\n");
      expect(() => workspace.resolve("private/notes.txt")).not.toThrow();
      expect(() => workspace.resolve("new-private.txt")).toThrow();

      const originalOpen = fs.openSync.bind(fs);
      const openSpy = vi.spyOn(fs, "openSync").mockImplementation((filePath, flags, mode) => {
        if (path.resolve(String(filePath)) === path.join(root, ".c2cignore")) {
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        }
        return originalOpen(filePath, flags, mode);
      });
      try {
        expect(() => workspace.resolve("private/notes.txt")).toThrow(IgnoreRulesError);
        expect(workspace.ignoreRules.isSensitive("new-private.txt")).toBe(true);
      } finally {
        openSpy.mockRestore();
      }
    } finally {
      cleanup(root);
      cleanup(stateDir);
      if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
      else process.env.C2C_STATE_DIR = previousStateDir;
    }
  });

  it("keeps existing rules when .c2cignore becomes a dangling symlink", () => {
    const root = makeTmpDir("ignore-dangling-link");
    const previousStateDir = process.env.C2C_STATE_DIR;
    const stateDir = isolateStateDir();
    try {
      write(root, ".c2cignore", "private/\n");
      write(root, "private/notes.txt", "private");
      const workspace = new Workspace(root);
      fs.unlinkSync(path.join(root, ".c2cignore"));
      fs.symlinkSync("missing-rules", path.join(root, ".c2cignore"));

      expect(() => workspace.resolve("private/notes.txt")).toThrow(IgnoreRulesError);
      expect(workspace.ignoreRules.isSensitive("private/notes.txt")).toBe(true);
    } finally {
      cleanup(root);
      cleanup(stateDir);
      if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
      else process.env.C2C_STATE_DIR = previousStateDir;
    }
  });

  it("clears custom rules when .c2cignore is actually deleted", () => {
    const root = makeTmpDir("ignore-deleted");
    const previousStateDir = process.env.C2C_STATE_DIR;
    const stateDir = isolateStateDir();
    try {
      write(root, ".c2cignore", "private/\n");
      write(root, "private/notes.txt", "private");
      const workspace = new Workspace(root);
      fs.unlinkSync(path.join(root, ".c2cignore"));

      expect(() => workspace.resolve("private/notes.txt")).not.toThrow();
      expect(workspace.ignoreRules.isSensitive("private/notes.txt")).toBe(false);
    } finally {
      cleanup(root);
      cleanup(stateDir);
      if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
      else process.env.C2C_STATE_DIR = previousStateDir;
    }
  });

  it("does not expose package metadata ignored by detectProject", () => {
    const root = makeTmpDir("detect-project-ignore");
    const previousStateDir = process.env.C2C_STATE_DIR;
    const stateDir = isolateStateDir();
    try {
      write(root, ".c2cignore", "package.json\n");
      write(root, "package.json", JSON.stringify({ scripts: { secret: "private command" } }));
      const project = new Workspace(root).detectProject();
      expect(project.projectType).toBe("node");
      expect(project.scripts).toEqual({});
    } finally {
      cleanup(root);
      cleanup(stateDir);
      if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
      else process.env.C2C_STATE_DIR = previousStateDir;
    }
  });
});

describe("workspace identity", () => {
  it("has a stable id and name", () => {
    const again = new Workspace(root);
    expect(again.id).toBe(ws.id);
    expect(ws.id).toMatch(/^[a-f0-9]{12}$/);
    expect(ws.name).toBe(path.basename(root));
  });

  it("persists a high-entropy project id in the git common dir", () => {
    const repo = makeTmpDir("project-id");
    try {
      makeGitRepo(repo);
      const first = new Workspace(repo);
      const second = new Workspace(repo);
      expect(first.projectId).toBe(second.projectId);
      expect(first.projectId).toMatch(/^git-[a-f0-9]{32}$/);
      const metadata = projectIdMetadataPath(repo);
      expect(metadata).not.toBeNull();
      expect(fs.statSync(metadata!).mode & 0o777).toBe(0o600);
      expect(fs.lstatSync(metadata!).isFile()).toBe(true);
      expect(getProjectDataDir(first.projectId)).toBe(projectDataDirectory(repo));
      expect(getWorkspaceDataDir(first.id)).toBe(
        path.join(projectDataDirectory(repo), "workspaces", first.id),
      );
      expect(getWorkspaceDataDir(first.id)).not.toBe(getProjectDataDir(first.projectId));
      expect(projectDataDirectory(repo)).toBe(path.join(path.dirname(metadata!), "codex-with-chatgpt"));
    } finally {
      cleanup(repo);
    }
  });

  it("does not derive project ids from a shared remote URL", () => {
    const firstRepo = makeTmpDir("project-clone-a");
    const secondRepo = makeTmpDir("project-clone-b");
    try {
      makeGitRepo(firstRepo);
      makeGitRepo(secondRepo);
      const remote = "https://github.com/example/shared.git";
      git(firstRepo, "remote", "add", "origin", remote);
      git(secondRepo, "remote", "add", "origin", remote);
      const first = new Workspace(firstRepo);
      const second = new Workspace(secondRepo);
      expect(first.projectId).not.toBe(second.projectId);
    } finally {
      cleanup(firstRepo);
      cleanup(secondRepo);
    }
  });

  it("ignores inherited Git repository selectors when resolving identity", async () => {
    const target = makeTmpDir("project-env-target");
    const decoy = makeTmpDir("project-env-decoy");
    try {
      makeGitRepo(target);
      makeGitRepo(decoy);
      const decoyId = new Workspace(decoy).projectId;
      const targetId = await resolveProjectIdInChild(target, {
        GIT_DIR: path.join(decoy, ".git"),
        GIT_COMMON_DIR: path.join(decoy, ".git"),
        GIT_WORK_TREE: decoy,
      });

      expect(targetId).toMatch(/^git-[a-f0-9]{32}$/);
      expect(targetId).not.toBe(decoyId);
      expect(fs.existsSync(projectIdMetadataPath(target)!)).toBe(true);
    } finally {
      cleanup(target);
      cleanup(decoy);
    }
  });

  it("fails closed to path identity when Git metadata is malformed", () => {
    const repo = makeTmpDir("project-malformed");
    try {
      makeGitRepo(repo);
      const metadata = projectIdMetadataPath(repo);
      expect(metadata).not.toBeNull();
      fs.writeFileSync(metadata!, "not-json", { mode: 0o600 });

      expect(new Workspace(repo).projectId).toMatch(/^path-[a-f0-9]{32}$/);
      expect(fs.readFileSync(metadata!, "utf8")).toBe("not-json");
    } finally {
      cleanup(repo);
    }
  });

  it("degrades to path identity when atomic Git metadata publication is unavailable", () => {
    const repo = makeTmpDir("project-no-hardlink");
    try {
      makeGitRepo(repo);
      const link = vi.spyOn(fs, "linkSync").mockImplementationOnce(() => {
        throw Object.assign(new Error("hard links unavailable"), { code: "ENOTSUP" });
      });
      try {
        expect(new Workspace(repo).projectId).toMatch(/^path-[a-f0-9]{32}$/);
      } finally {
        link.mockRestore();
      }
      expect(fs.existsSync(projectIdMetadataPath(repo)!)).toBe(false);
    } finally {
      cleanup(repo);
    }
  });

  it("atomically initializes one project id across concurrent processes", async () => {
    const repo = makeTmpDir("project-concurrent");
    try {
      makeGitRepo(repo);
      const ids = await Promise.all(Array.from({ length: 8 }, () => resolveProjectIdInChild(repo)));
      expect(new Set(ids)).toHaveLength(1);
      expect(ids[0]).toMatch(/^git-[a-f0-9]{32}$/);
    } finally {
      cleanup(repo);
    }
  });

  it("keeps the project id across a directory move", () => {
    const original = makeTmpDir("project-move");
    const moved = `${original}-renamed`;
    try {
      makeGitRepo(original);
      const before = new Workspace(original);
      fs.renameSync(original, moved);
      const after = new Workspace(moved);
      expect(after.id).not.toBe(before.id);
      expect(after.projectId).toBe(before.projectId);
    } finally {
      cleanup(original);
      cleanup(moved);
    }
  });

  it("shares the project id across linked worktrees", () => {
    const repo = makeTmpDir("project-worktree");
    const linked = `${repo}-linked`;
    try {
      makeGitRepo(repo);
      git(repo, "worktree", "add", "-b", "linked", linked);
      expect(new Workspace(linked).projectId).toBe(new Workspace(repo).projectId);
    } finally {
      try {
        git(repo, "worktree", "remove", "--force", linked);
      } catch {
        // Cleanup below is sufficient if git worktree bookkeeping is unavailable.
      }
      cleanup(repo);
      cleanup(linked);
    }
  });

  it("isolates checkout state for linked worktrees under the shared project root", () => {
    const repo = makeTmpDir("project-worktree-state");
    const linked = `${repo}-linked`;
    const previousStateDir = process.env.C2C_STATE_DIR;
    const stateDir = isolateStateDir();
    try {
      makeGitRepo(repo);
      git(repo, "worktree", "add", "-b", "linked-state", linked);
      const primary = new Workspace(repo);
      const linkedWorkspace = new Workspace(linked);

      expect(linkedWorkspace.projectId).toBe(primary.projectId);
      expect(linkedWorkspace.id).not.toBe(primary.id);
      expect(getProjectDataDir(primary.projectId)).toBe(projectDataDirectory(repo));
      expect(getWorkspaceDataDir(primary.id)).toBe(
        path.join(projectDataDirectory(repo), "workspaces", primary.id),
      );
      expect(getWorkspaceDataDir(linkedWorkspace.id)).toBe(
        path.join(projectDataDirectory(repo), "workspaces", linkedWorkspace.id),
      );
      expect(getWorkspaceDataDir(primary.id)).not.toBe(getWorkspaceDataDir(linkedWorkspace.id));

      appendExecutionRecord(primary.id, {
        localSessionId: "session-shared",
        taskId: "task-primary",
        iteration: 0,
        changedFiles: ["src/primary.ts"],
        tests: "primary",
        exitStatus: "ok",
        timestamp: "2026-01-01T00:00:00.000Z",
      });
      appendExecutionRecord(linkedWorkspace.id, {
        localSessionId: "session-shared",
        taskId: "task-linked",
        iteration: 0,
        changedFiles: ["src/linked.ts"],
        tests: "linked",
        exitStatus: "ok",
        timestamp: "2026-01-01T00:00:01.000Z",
      });
      expect(readExecutionRecords(primary.id).map((record) => record.tests)).toEqual(["primary"]);
      expect(readExecutionRecords(linkedWorkspace.id).map((record) => record.tests)).toEqual(["linked"]);

      expect(saveExecutionOutput(primary.id, {
        command: "pnpm test",
        raw: "primary output",
        localSessionId: "session-shared",
        taskId: "task-primary",
        iteration: 0,
      }).id).toBe(1);
      expect(saveExecutionOutput(linkedWorkspace.id, {
        command: "pnpm test",
        raw: "linked output",
        localSessionId: "session-shared",
        taskId: "task-linked",
        iteration: 0,
      }).id).toBe(1);
      expect(listExecutionOutputs(primary.id).map((item) => item.taskId)).toEqual(["task-primary"]);
      expect(listExecutionOutputs(linkedWorkspace.id).map((item) => item.taskId)).toEqual(["task-linked"]);

      const projectUrl = "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/project";
      commitSessionRoute(primary.id, "session-shared", {
        projectUrl,
        chatUrl: `${projectUrl.slice(0, -"project".length)}c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`,
      });
      commitSessionRoute(linkedWorkspace.id, "session-shared", {
        projectUrl,
        chatUrl: `${projectUrl.slice(0, -"project".length)}c/bbbbbbbb-cccc-dddd-eeee-ffffffffffff`,
      });
      expect(readSession(primary.id, "session-shared")?.url).toContain("aaaaaaaa");
      expect(readSession(linkedWorkspace.id, "session-shared")?.url).toContain("bbbbbbbb");

      const primaryRequest = openControlRequest(primary.id, {
        localSessionId: "session-shared",
        taskId: "task-primary",
        iteration: 0,
        phase: "PLAN",
      });
      const linkedRequest = openControlRequest(linkedWorkspace.id, {
        localSessionId: "session-shared",
        taskId: "task-linked",
        iteration: 0,
        phase: "PLAN",
      });
      expect(linkedRequest.requestId).not.toBe(primaryRequest.requestId);
      for (const request of [primaryRequest, linkedRequest]) {
        const requestFile = path.join(
          stateDir, "control-requests", request.workspaceId, "requests", `${request.requestId}.json`,
        );
        expect(JSON.parse(fs.readFileSync(requestFile, "utf8"))).toEqual(request);
      }
    } finally {
      try {
        git(repo, "worktree", "remove", "--force", linked);
      } catch {
        // Cleanup below is sufficient if git worktree bookkeeping is unavailable.
      }
      cleanup(repo);
      cleanup(linked);
      cleanup(stateDir);
      if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
      else process.env.C2C_STATE_DIR = previousStateDir;
    }
  });

  it("uses a path fallback for non-Git workspaces", () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-project-fallback-"));
    try {
      const plainWorkspace = new Workspace(plain);
      expect(plainWorkspace.projectId).toMatch(/^path-[a-f0-9]{32}$/);
      expect(getProjectDataDir(plainWorkspace.projectId)).toBe(
        path.join(fs.realpathSync.native(plain), ".codex-with-chatgpt"),
      );
      expect(() => plainWorkspace.resolve(".codex-with-chatgpt/state.json")).toThrowError(
        expect.objectContaining<Partial<WorkspaceError>>({ code: "ACCESS_DENIED_SENSITIVE_FILE" }),
      );
    } finally {
      cleanup(plain);
    }
  });

  it("rejects a symlinked non-Git workspace data directory", () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-project-state-symlink-"));
    const outsideState = makeTmpDir("project-state-outside");
    try {
      fs.symlinkSync(outsideState, path.join(plain, ".codex-with-chatgpt"), "dir");
      expect(() => new Workspace(plain)).toThrow(/workspace data directory must be a real directory/);
    } finally {
      cleanup(plain);
      cleanup(outsideState);
    }
  });

  it("reads .c2c.json project name", () => {
    const named = makeTmpDir("named");
    write(
      named,
      ".c2c.json",
      JSON.stringify({
        name: "Remi",
        maxIterations: 12,
      })
    );
    const namedWs = new Workspace(named);
    expect(namedWs.name).toBe("Remi");
    expect(namedWs.projectConfig.maxIterations).toBe(12);
    cleanup(named);
  });

  it("falls back to the directory name when .c2c.json has invalid types", () => {
    const invalid = makeTmpDir("invalid-project-config");
    write(invalid, ".c2c.json", JSON.stringify({ name: 42, maxIterations: "many" }));

    const invalidWs = new Workspace(invalid);

    expect(invalidWs.name).toBe(path.basename(invalid));
    expect(invalidWs.projectConfig).toEqual({});
    cleanup(invalid);
  });

  it("filters invalid package script values during project detection", () => {
    const projectRoot = makeTmpDir("invalid-package-scripts");
    write(
      projectRoot,
      "package.json",
      JSON.stringify({
        name: "demo",
        scripts: { test: "vitest run", invalid: 42 },
        dependencies: { react: "^19.0.0" },
      })
    );

    const project = new Workspace(projectRoot).detectProject();

    expect(project.scripts).toEqual({ test: "vitest run" });
    expect(project.frameworks).toContain("React");
    cleanup(projectRoot);
  });
});
