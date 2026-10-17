import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { gitDiff, gitInfo, gitStatus } from "../src/workspace/git.js";
import { IgnoreRules } from "../src/workspace/ignore.js";
import { makeTmpDir, cleanup, write, makeGitRepo, git } from "./helpers.js";

let repo: string;
let plain: string;

beforeAll(() => {
  repo = makeTmpDir("git-repo");
  makeGitRepo(repo);
  plain = makeTmpDir("not-a-repo");
  // The test-tmp dir lives inside this project's own git repo; stop git from
  // walking up so `plain` is genuinely outside any repository.
  process.env.GIT_CEILING_DIRECTORIES = path.dirname(plain);
});

afterAll(() => {
  delete process.env.GIT_CEILING_DIRECTORIES;
  cleanup(repo);
  cleanup(plain);
});

describe("gitInfo", () => {
  it("reports branch, commit and dirty state", () => {
    const clean = gitInfo(repo);
    expect(clean.isRepo).toBe(true);
    expect(clean.branch).toBe("main");
    expect(clean.commit).toMatch(/^[a-f0-9]{7,}$/);
    expect(clean.dirty).toBe(false);

    write(repo, "hello.txt", "changed\n");
    expect(gitInfo(repo).dirty).toBe(true);
    git(repo, "checkout", "--", "hello.txt");
  });

  it("handles non-repos gracefully", () => {
    expect(gitInfo(plain).isRepo).toBe(false);
  });
});

describe("gitStatus", () => {
  it("categorizes staged, unstaged and untracked files", () => {
    write(repo, "hello.txt", "modified content\n");
    write(repo, "staged.txt", "new staged file\n");
    write(repo, "untracked.txt", "new file\n");
    git(repo, "add", "staged.txt");

    const status = gitStatus(repo);
    expect(status.isRepo).toBe(true);
    expect(status.branch).toBe("main");
    expect(status.unstaged.map((entry) => entry.path)).toContain("hello.txt");
    expect(status.staged.map((entry) => entry.path)).toContain("staged.txt");
    expect(status.untracked).toContain("untracked.txt");

    git(repo, "reset", "staged.txt");
    git(repo, "checkout", "--", "hello.txt");
  });

  it("filters sensitive status entries, counts them, and parses NUL paths", () => {
    const isolatedRepo = makeTmpDir("git-status-sensitive");
    try {
      makeGitRepo(isolatedRepo);
      write(
        isolatedRepo,
        ".c2cignore",
        "conflict secret.txt\nrename secret old.txt\nrename secret new.txt\n",
      );
      write(isolatedRepo, ".env", "base\n");
      write(isolatedRepo, "secrets.json", "base\n");
      write(isolatedRepo, "conflict secret.txt", "base\n");
      write(isolatedRepo, "rename secret old.txt", "sensitive origin\n");
      write(isolatedRepo, "rename-to-secret old.txt", "safe origin\n");
      write(isolatedRepo, "rename visible old.txt", "safe rename\n");
      write(isolatedRepo, "ordinary modified.txt", "base ordinary\n");
      git(isolatedRepo, "add", "-f", ".c2cignore", ".env", "secrets.json", "conflict secret.txt", "rename secret old.txt", "rename-to-secret old.txt", "rename visible old.txt", "ordinary modified.txt");
      git(isolatedRepo, "commit", "-m", "status fixtures");

      git(isolatedRepo, "checkout", "-b", "conflict-side");
      write(isolatedRepo, ".env", "side\n");
      write(isolatedRepo, "conflict secret.txt", "side\n");
      git(isolatedRepo, "add", "-f", ".env", "conflict secret.txt");
      git(isolatedRepo, "commit", "-m", "side secret change");
      git(isolatedRepo, "checkout", "main");
      write(isolatedRepo, ".env", "main\n");
      write(isolatedRepo, "conflict secret.txt", "main\n");
      git(isolatedRepo, "add", "-f", ".env", "conflict secret.txt");
      git(isolatedRepo, "commit", "-m", "main secret change");
      expect(() => git(isolatedRepo, "merge", "conflict-side")).toThrow();

      write(isolatedRepo, "secrets.json", "staged secret\n");
      git(isolatedRepo, "add", "secrets.json");
      write(isolatedRepo, "secrets.json", "unstaged secret\n");
      write(isolatedRepo, "credentials.json", "untracked secret\n");
      git(isolatedRepo, "mv", "rename secret old.txt", "renamed public.txt");
      git(isolatedRepo, "mv", "rename-to-secret old.txt", "rename secret new.txt");
      git(isolatedRepo, "mv", "rename visible old.txt", "renamed visible new.txt");
      write(isolatedRepo, "ordinary modified.txt", "modified ordinary\n");
      write(isolatedRepo, "line\nbreak.txt", "ordinary\n");
      write(isolatedRepo, "ordinary file.txt", "ordinary\n");

      const status = gitStatus({ root: isolatedRepo, ignoreRules: new IgnoreRules(isolatedRepo) });
      expect(status.isRepo).toBe(true);
      expect(status.hidden).toEqual({ changes: 4, conflicts: 2 });
      expect(status.staged.map((entry) => entry.path)).not.toContain("secrets.json");
      expect(status.unstaged.map((entry) => entry.path)).not.toContain("secrets.json");
      expect(status.untracked).not.toContain("credentials.json");
      expect(status.conflicted).toEqual([]);
      expect(status.staged.map((entry) => entry.path)).not.toContain("renamed public.txt -> rename secret old.txt");
      expect(status.staged.map((entry) => entry.path)).not.toContain("rename secret new.txt -> rename-to-secret old.txt");
      expect(status.staged.map((entry) => entry.path)).toContain("renamed visible new.txt -> rename visible old.txt");
      expect(status.unstaged.map((entry) => entry.path)).toContain("ordinary modified.txt");
      expect(status.untracked).toContain("line\nbreak.txt");
      expect(status.untracked).toContain("ordinary file.txt");

      const stringTargetStatus = gitStatus(isolatedRepo);
      expect(stringTargetStatus.hidden).toEqual({ changes: 4, conflicts: 2 });
      expect(stringTargetStatus.untracked).toContain("ordinary file.txt");
    } finally {
      cleanup(isolatedRepo);
    }
  });
});

describe("workspace-aware Git reads", () => {
  it("uses workspace-relative status, diff modes, and GitDiffOptions.path in a nested workspace", () => {
    const isolatedRepo = makeTmpDir("git-nested-workspace");
    try {
      makeGitRepo(isolatedRepo);
      write(isolatedRepo, "app/change.txt", "baseline\n");
      write(isolatedRepo, "app/app/deep.txt", "deep baseline\n");
      write(isolatedRepo, "outside.txt", "outside baseline\n");
      git(isolatedRepo, "add", "app", "outside.txt");
      git(isolatedRepo, "commit", "-m", "nested workspace baseline");

      write(isolatedRepo, "app/change.txt", "staged marker\n");
      git(isolatedRepo, "add", "app/change.txt");
      write(isolatedRepo, "app/change.txt", "unstaged marker\n");
      write(isolatedRepo, "app/app/deep.txt", "deep marker\n");
      write(isolatedRepo, "outside.txt", "outside marker\n");

      const workspaceRoot = path.join(isolatedRepo, "app");
      const target = { root: workspaceRoot, ignoreRules: new IgnoreRules(workspaceRoot) };
      const status = gitStatus(target);
      expect(status.isRepo).toBe(true);
      expect(status.staged.map((entry) => entry.path)).toContain("change.txt");
      expect(status.unstaged.map((entry) => entry.path)).toEqual(
        expect.arrayContaining(["change.txt", "app/deep.txt"]),
      );
      expect(status.staged.map((entry) => entry.path)).not.toContain("outside.txt");
      expect(status.unstaged.map((entry) => entry.path)).not.toContain("outside.txt");

      const staged = gitDiff(target, { mode: "staged" });
      expect(staged.diff).toContain("staged marker");
      expect(staged.diff).not.toContain("unstaged marker");
      expect(staged.diff).not.toContain("outside marker");

      const unstaged = gitDiff(target, { mode: "unstaged" });
      expect(unstaged.diff).toContain("unstaged marker");
      expect(unstaged.diff).toContain("deep marker");
      expect(unstaged.diff).not.toContain("outside marker");

      const head = gitDiff(target, { mode: "head" });
      expect(head.diff).toContain("staged marker");
      expect(head.diff).toContain("unstaged marker");
      expect(head.diff).toContain("deep marker");
      expect(head.diff).not.toContain("outside marker");

      const scoped = gitDiff(target, { mode: "head", path: "app/deep.txt" });
      expect(scoped.diff).toContain("deep marker");
      expect(scoped.diff).not.toContain("staged marker");

      const invalidScope = gitDiff(target, { mode: "head", path: "../outside.txt" });
      expect(invalidScope.isRepo).toBe(true);
      expect(invalidScope.diff).toBe("");
    } finally {
      cleanup(isolatedRepo);
    }
  });

  it("maps nested workspace paths before refreshed ignore checks exactly once per operation", () => {
    const isolatedRepo = makeTmpDir("git-nested-ignore-refresh");
    try {
      makeGitRepo(isolatedRepo);
      write(isolatedRepo, "app/app/hidden.txt", "baseline hidden payload\n");
      git(isolatedRepo, "add", "app");
      git(isolatedRepo, "commit", "-m", "nested ignore baseline");

      const workspaceRoot = path.join(isolatedRepo, "app");
      const ignoreRules = new IgnoreRules(workspaceRoot);
      const refresh = vi.spyOn(ignoreRules, "refresh");
      write(workspaceRoot, ".c2cignore", "app/hidden.txt\n");
      write(isolatedRepo, "app/app/hidden.txt", "NESTED_SECRET_PAYLOAD\n");
      const target = { root: workspaceRoot, ignoreRules };

      const status = gitStatus(target);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(status.hidden.changes).toBe(1);
      expect(status.unstaged.map((entry) => entry.path)).not.toContain("app/hidden.txt");

      const diff = gitDiff(target, { mode: "head" });
      expect(refresh).toHaveBeenCalledTimes(2);
      expect(diff.diff).not.toContain("NESTED_SECRET_PAYLOAD");
    } finally {
      cleanup(isolatedRepo);
    }
  });

  it("rejects renames with sensitive or out-of-workspace endpoints", () => {
    const isolatedRepo = makeTmpDir("git-nested-renames");
    try {
      makeGitRepo(isolatedRepo);
      write(isolatedRepo, "outside-secret.txt", "OUTSIDE_SECRET_PAYLOAD\n");
      write(isolatedRepo, "app/.npmrc", "NPM_SECRET_PAYLOAD\n");
      write(isolatedRepo, "app/safe.txt", "safe rename payload\n");
      write(isolatedRepo, "app/inside.txt", "inside rename payload\n");
      git(isolatedRepo, "add", "outside-secret.txt", "app");
      git(isolatedRepo, "commit", "-m", "rename boundary baseline");

      git(isolatedRepo, "mv", "outside-secret.txt", "app/public.txt");
      git(isolatedRepo, "mv", "app/safe.txt", "escaped-safe.txt");
      git(isolatedRepo, "mv", "app/.npmrc", "app/renamed-public.txt");
      git(isolatedRepo, "mv", "app/inside.txt", "app/renamed-inside.txt");

      const workspaceRoot = path.join(isolatedRepo, "app");
      const target = { root: workspaceRoot, ignoreRules: new IgnoreRules(workspaceRoot) };
      const diff = gitDiff(target, { mode: "staged" });
      expect(diff.diff).toContain("renamed-inside.txt");
      for (const leaked of [
        "OUTSIDE_SECRET_PAYLOAD",
        "NPM_SECRET_PAYLOAD",
        "outside-secret.txt",
        "app/public.txt",
        "escaped-safe.txt",
        ".npmrc",
        "renamed-public.txt",
      ]) {
        expect(diff.diff).not.toContain(leaked);
      }

      const status = gitStatus(target);
      expect(status.staged.map((entry) => entry.path)).toContain(
        "renamed-inside.txt -> inside.txt",
      );
      expect(status.staged.map((entry) => entry.path).join("\n")).not.toMatch(
        /outside-secret|public\.txt|escaped-safe|npmrc|renamed-public/,
      );
    } finally {
      cleanup(isolatedRepo);
    }
  });

  it("uses linked-worktree Git roots while keeping status and diffs workspace-scoped", () => {
    const mainRepo = makeTmpDir("git-linked-main");
    const linkedRepo = makeTmpDir("git-linked-checkout");
    try {
      makeGitRepo(mainRepo);
      write(mainRepo, "app/linked.txt", "linked baseline\n");
      git(mainRepo, "add", "app/linked.txt");
      git(mainRepo, "commit", "-m", "linked worktree fixture");
      git(mainRepo, "worktree", "add", "--detach", linkedRepo, "HEAD");
      write(linkedRepo, "app/linked.txt", "linked workspace change\n");
      write(linkedRepo, "outside.txt", "linked outside change\n");

      const workspaceRoot = path.join(linkedRepo, "app");
      const target = { root: workspaceRoot, ignoreRules: new IgnoreRules(workspaceRoot) };
      const status = gitStatus(target);
      expect(status.unstaged.map((entry) => entry.path)).toContain("linked.txt");
      expect(status.unstaged.map((entry) => entry.path)).not.toContain("outside.txt");
      const diff = gitDiff(target, { mode: "unstaged" });
      expect(diff.diff).toContain("linked workspace change");
      expect(diff.diff).not.toContain("linked outside change");
      expect(fs.readFileSync(path.join(mainRepo, "app/linked.txt"), "utf8")).toBe(
        "linked baseline\n",
      );
    } finally {
      try {
        git(mainRepo, "worktree", "remove", "--force", linkedRepo);
      } catch {
        // The worktree may not have been registered if setup failed.
      }
      cleanup(linkedRepo);
      cleanup(mainRepo);
    }
  });

  it("disables configured external diff and textconv programs for read-only diffs", () => {
    const isolatedRepo = makeTmpDir("git-disabled-diff-drivers");
    try {
      makeGitRepo(isolatedRepo);
      write(isolatedRepo, ".gitattributes", "*.txt diff=marker\n");
      write(isolatedRepo, "driver.txt", "baseline driver text\n");
      git(isolatedRepo, "add", ".gitattributes", "driver.txt");
      git(isolatedRepo, "commit", "-m", "diff driver fixture");

      const externalMarker = path.join(isolatedRepo, "external.marker");
      const textconvMarker = path.join(isolatedRepo, "textconv.marker");
      const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
      const script = write(
        isolatedRepo,
        "driver.sh",
        `#!/bin/sh\nif [ "$#" -gt 1 ]; then printf x >> ${quote(externalMarker)}; else printf x >> ${quote(textconvMarker)}; fi\ncat "$1" 2>/dev/null || true\n`,
      );
      fs.chmodSync(script, 0o755);
      git(isolatedRepo, "config", "diff.external", script);
      git(isolatedRepo, "config", "diff.marker.textconv", script);
      write(isolatedRepo, "driver.txt", "changed driver text\n");

      git(isolatedRepo, "diff", "--", "driver.txt");
      expect(fs.existsSync(externalMarker)).toBe(true);
      fs.rmSync(externalMarker);
      git(isolatedRepo, "config", "--unset", "diff.external");
      git(isolatedRepo, "diff", "--", "driver.txt");
      expect(fs.existsSync(textconvMarker)).toBe(true);
      fs.rmSync(textconvMarker);

      git(isolatedRepo, "config", "diff.external", script);
      const protectedDiff = gitDiff(isolatedRepo, { mode: "unstaged" });
      expect(protectedDiff.diff).toContain("changed driver text");
      expect(fs.existsSync(externalMarker)).toBe(false);
      expect(fs.existsSync(textconvMarker)).toBe(false);

      git(isolatedRepo, "config", "--unset", "diff.external");
      const protectedTextconv = gitDiff(isolatedRepo, { mode: "unstaged" });
      expect(protectedTextconv.diff).toContain("changed driver text");
      expect(fs.existsSync(textconvMarker)).toBe(false);
    } finally {
      cleanup(isolatedRepo);
    }
  });
});

describe("gitDiff pagination", () => {
  it("returns the full diff when small", () => {
    write(repo, "hello.txt", "a different greeting\n");
    const diff = gitDiff(repo, { mode: "unstaged" });
    expect(diff.isRepo).toBe(true);
    expect(diff.diff).toContain("a different greeting");
    expect(diff.hasMore).toBe(false);
    expect(diff.nextOffset).toBeNull();
    git(repo, "checkout", "--", "hello.txt");
  });

  it("paginates on byte offsets and never splits lines", () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line-${i}-${"x".repeat(40)}`).join("\n");
    write(repo, "hello.txt", lines);
    const first = gitDiff(repo, { mode: "unstaged", maxBytes: 8192 });
    expect(first.hasMore).toBe(true);
    expect(first.diff.endsWith("\n")).toBe(true);
    expect(first.nextOffset).toBe(first.returnedBytes);

    const second = gitDiff(repo, { mode: "unstaged", offset: first.nextOffset!, maxBytes: 8192 });
    expect(second.offset).toBe(first.nextOffset);
    expect(second.diff.length).toBeGreaterThan(0);

    // walk to the end
    let offset = 0;
    let assembled = "";
    for (let hop = 0; hop < 1000; hop++) {
      const page = gitDiff(repo, { mode: "unstaged", offset, maxBytes: 65536 });
      assembled += page.diff;
      if (!page.hasMore) break;
      offset = page.nextOffset!;
    }
    expect(assembled.length).toBe(first.totalBytes);
    git(repo, "checkout", "--", "hello.txt");
  });

  it("excludes sensitive files from full-repo diffs", () => {
    write(repo, ".env", "SECRET=1\n");
    git(repo, "add", "-f", ".env");
    write(repo, ".env", "SECRET=leaked-value\n");
    const diff = gitDiff(repo, { mode: "unstaged" });
    expect(diff.diff).not.toContain("leaked-value");
    git(repo, "rm", "-f", "--cached", ".env");
  });

  it("excludes sensitive files from directory-scoped diffs", () => {
    write(repo, "private/.env", "SECRET=1\n");
    git(repo, "add", "-f", "private/.env");
    const diff = gitDiff(repo, { mode: "staged" }, "private");
    expect(diff.diff).not.toContain("SECRET=1");
    git(repo, "rm", "-f", "--cached", "private/.env");
  });

  it("handles non-repos gracefully", () => {
    const diff = gitDiff(plain, { mode: "unstaged" });
    expect(diff.isRepo).toBe(false);
  });

  it("excludes all IgnoreRules sensitive patterns across unstaged, staged, and head modes", () => {
    const sensitiveFiles = [
      { path: ".env", content: "SECRET_KEY=leaked-env\n", sentinel: "leaked-env" },
      { path: ".npmrc", content: "//registry.npmjs.org/:_authToken=leaked-npm\n", sentinel: "leaked-npm" },
      { path: ".netrc", content: "machine github.com password leaked-netrc\n", sentinel: "leaked-netrc" },
      { path: ".aws/credentials", content: "aws_secret_access_key=leaked-aws\n", sentinel: "leaked-aws" },
      { path: "nested/.ssh/config", content: "IdentityFile leaked-ssh\n", sentinel: "leaked-ssh" },
      { path: "credentials.json", content: '{"client_secret": "leaked-creds"}\n', sentinel: "leaked-creds" },
      { path: "service-account-prod.json", content: '{"private_key": "leaked-sa"}\n', sentinel: "leaked-sa" },
      { path: "secrets.json", content: '{"db_pass": "leaked-secrets"}\n', sentinel: "leaked-secrets" },
      { path: "id_ed25519", content: "-----BEGIN OPENSSH PRIVATE KEY-----\nleaked-key\n", sentinel: "leaked-key" },
    ];

    // Also include a safe file to confirm normal diffs are returned alongside excluded secrets
    write(repo, "src/safe.ts", "export const safe = 1;\n");
    git(repo, "add", "src/safe.ts");
    git(repo, "commit", "-m", "add safe file");

    for (const item of sensitiveFiles) {
      write(repo, item.path, item.content);
      git(repo, "add", "-f", item.path);
    }

    // 1. Staged mode
    const stagedDiff = gitDiff(repo, { mode: "staged" });
    for (const item of sensitiveFiles) {
      expect(stagedDiff.diff).not.toContain(item.sentinel);
    }

    // Commit them so we can test unstaged changes and HEAD diffs
    git(repo, "commit", "-m", "tracked sensitive files");

    // 2. Unstaged modifications to tracked sensitive files + normal file
    for (const item of sensitiveFiles) {
      write(repo, item.path, item.content + "# modified-unstaged\n");
    }
    write(repo, "src/safe.ts", "export const safe = 2; // modified-safe\n");

    const unstagedDiff = gitDiff(repo, { mode: "unstaged" });
    expect(unstagedDiff.diff).toContain("modified-safe");
    for (const item of sensitiveFiles) {
      expect(unstagedDiff.diff).not.toContain(item.sentinel);
      expect(unstagedDiff.diff).not.toContain("modified-unstaged");
    }

    // 3. Head mode
    const headDiff = gitDiff(repo, { mode: "head" });
    expect(headDiff.diff).toContain("modified-safe");
    for (const item of sensitiveFiles) {
      expect(headDiff.diff).not.toContain(item.sentinel);
    }

    // Clean up
    git(repo, "checkout", "--", "src/safe.ts", ...sensitiveFiles.map((s) => s.path));
  });

  it("allows .env.example while blocking .env", () => {
    write(repo, ".env.example", "API_URL=https://example.com\n");
    write(repo, ".env", "API_KEY=supersecret-123\n");
    git(repo, "add", "-f", ".env.example", ".env");

    const diff = gitDiff(repo, { mode: "staged" });
    expect(diff.diff).toContain(".env.example");
    expect(diff.diff).toContain("https://example.com");
    expect(diff.diff).not.toContain("supersecret-123");

    git(repo, "rm", "-f", "--cached", ".env.example", ".env");
  });

  it("respects custom rules in .c2cignore for git diff", () => {
    write(repo, ".c2cignore", "private-notes/\ncustom-secret.txt\n");
    write(repo, "private-notes/secret.md", "CONFIDENTIAL DATA\n");
    write(repo, "custom-secret.txt", "TOP_SECRET_FLAG=1\n");
    write(repo, "public.txt", "PUBLIC CONTENT\n");
    git(repo, "add", "-f", ".c2cignore", "private-notes/secret.md", "custom-secret.txt", "public.txt");

    const diff = gitDiff(repo, { mode: "staged" });
    expect(diff.diff).toContain("public.txt");
    expect(diff.diff).toContain("PUBLIC CONTENT");
    expect(diff.diff).not.toContain("CONFIDENTIAL DATA");
    expect(diff.diff).not.toContain("TOP_SECRET_FLAG");

    git(repo, "rm", "-f", "--cached", ".c2cignore", "private-notes/secret.md", "custom-secret.txt", "public.txt");
  });

  it("handles rename provenance: sensitive->safe, safe->sensitive, safe->safe", () => {
    // 1. Commit baseline files
    write(repo, "old_safe.ts", "export const value = 'old-safe-data';\n");
    write(repo, ".npmrc", "//registry.npmjs.org/:_authToken=npm-secret-token\n");
    write(repo, "public_to_secret.txt", "harmless text\n");
    git(repo, "add", "-f", "old_safe.ts", ".npmrc", "public_to_secret.txt");
    git(repo, "commit", "-m", "init rename baseline");

    // Case A: Safe -> Safe rename
    git(repo, "mv", "old_safe.ts", "new_safe.ts");
    // Case B: Sensitive -> Safe rename (Must be excluded!)
    git(repo, "mv", ".npmrc", "renamed_public.txt");
    // Case C: Safe -> Sensitive rename (Must be excluded!)
    git(repo, "mv", "public_to_secret.txt", ".env.secret");

    const stagedDiff = gitDiff(repo, { mode: "staged" });

    // Safe->safe rename should appear
    expect(stagedDiff.diff).toContain("old_safe.ts");
    expect(stagedDiff.diff).toContain("new_safe.ts");

    // Sensitive->safe must NOT leak
    expect(stagedDiff.diff).not.toContain("npm-secret-token");
    expect(stagedDiff.diff).not.toContain(".npmrc");
    expect(stagedDiff.diff).not.toContain("renamed_public.txt");

    // Safe->sensitive must NOT appear as sensitive patch
    expect(stagedDiff.diff).not.toContain(".env.secret");

    // Reset repo
    git(repo, "reset", "--hard", "HEAD");
  });

  it("prevents cross-boundary scoped rename provenance leaks with path= scoping", () => {
    // Baseline files
    write(repo, ".npmrc", "//registry.npmjs.org/:_authToken=cross-scope-secret\n");
    write(repo, "src/.npmrc", "//registry.npmjs.org/:_authToken=src-secret\n");
    write(repo, "root_safe.ts", "export const rootSafe = 1;\n");
    write(repo, "public.txt", "public content\n");
    git(repo, "add", "-f", ".npmrc", "src/.npmrc", "root_safe.ts", "public.txt");
    git(repo, "commit", "-m", "baseline for cross-scope rename");

    // 1. Root .npmrc renamed to src/public.txt -> scoped git_diff(path="src")
    git(repo, "mv", ".npmrc", "src/public.txt");

    // 2. public.txt renamed to src/.env -> scoped git_diff(path="src")
    git(repo, "mv", "public.txt", "src/.env");

    // 3. Safe root_safe.ts renamed to src/new_safe.ts -> scoped git_diff(path="src")
    git(repo, "mv", "root_safe.ts", "src/new_safe.ts");

    // 4. src/.npmrc renamed to root_secret_leak.txt -> scoped git_diff(path="src")
    git(repo, "mv", "src/.npmrc", "root_secret_leak.txt");

    const srcDiff = gitDiff(repo, { mode: "staged" }, "src");

    // Safe cross-scope rename is visible
    expect(srcDiff.diff).toContain("root_safe.ts");
    expect(srcDiff.diff).toContain("src/new_safe.ts");

    // Sensitive->safe cross-scope rename MUST NOT leak
    expect(srcDiff.diff).not.toContain("cross-scope-secret");
    expect(srcDiff.diff).not.toContain("src/public.txt");

    // Safe->sensitive cross-scope rename MUST NOT appear
    expect(srcDiff.diff).not.toContain("src/.env");

    // Sensitive deletion from src MUST NOT appear
    expect(srcDiff.diff).not.toContain("src-secret");
    expect(srcDiff.diff).not.toContain("root_secret_leak.txt");

    git(repo, "reset", "--hard", "HEAD");
  });

  it("excludes sensitive descendants when a tracked file becomes a directory", () => {
    const isolatedRepo = makeTmpDir("git-file-to-directory-collision");
    try {
      makeGitRepo(isolatedRepo);
      write(isolatedRepo, "app/public", "safe original file content\n");
      write(isolatedRepo, "src/positive.ts", "export const state = 'baseline';\n");
      git(isolatedRepo, "add", "app/public", "src/positive.ts");
      git(isolatedRepo, "commit", "-m", "file to directory baseline");

      git(isolatedRepo, "rm", "app/public");
      write(isolatedRepo, "app/public/.env", "FILE_TO_DIRECTORY_SECRET=not-a-rename\n");
      write(isolatedRepo, "src/positive.ts", "export const state = 'src-positive-file-to-directory';\n");
      git(isolatedRepo, "add", "-f", "app/public/.env");
      git(isolatedRepo, "add", "src/positive.ts");

      const inventory = git(isolatedRepo, "diff", "--cached", "--name-status", "-z", "--find-renames=1%");
      expect(inventory.split("\0")).toEqual(
        expect.arrayContaining(["D", "app/public", "A", "app/public/.env"]),
      );
      const diff = gitDiff(isolatedRepo, { mode: "staged" });
      expect(diff.diff).toContain("src-positive-file-to-directory");
      expect(diff.diff).not.toContain("FILE_TO_DIRECTORY_SECRET");
    } finally {
      cleanup(isolatedRepo);
    }
  });

  it("excludes deleted sensitive descendants when a directory becomes a tracked file", () => {
    const isolatedRepo = makeTmpDir("git-directory-to-file-collision");
    try {
      makeGitRepo(isolatedRepo);
      write(isolatedRepo, "app/public/.env", "DIRECTORY_TO_FILE_SECRET=not-a-rename\n");
      write(isolatedRepo, "src/positive.ts", "export const state = 'baseline';\n");
      git(isolatedRepo, "add", "-f", "app/public/.env", "src/positive.ts");
      git(isolatedRepo, "commit", "-m", "directory to file baseline");

      git(isolatedRepo, "rm", "app/public/.env");
      write(isolatedRepo, "app/public", "safe replacement file with unrelated content\n");
      write(isolatedRepo, "src/positive.ts", "export const state = 'src-positive-directory-to-file';\n");
      git(isolatedRepo, "add", "app/public", "src/positive.ts");

      const inventory = git(isolatedRepo, "diff", "--cached", "--name-status", "-z", "--find-renames=1%");
      expect(inventory.split("\0")).toEqual(
        expect.arrayContaining(["A", "app/public", "D", "app/public/.env"]),
      );
      const diff = gitDiff(isolatedRepo, { mode: "staged" });
      expect(diff.diff).toContain("src-positive-directory-to-file");
      expect(diff.diff).not.toContain("DIRECTORY_TO_FILE_SECRET");
    } finally {
      cleanup(isolatedRepo);
    }
  });

  it("keeps an allowed scoped child when its deleted ancestor is outside the requested scope", () => {
    const isolatedRepo = makeTmpDir("git-scoped-allowed-child");
    try {
      makeGitRepo(isolatedRepo);
      write(isolatedRepo, "app/public", "old ancestor outside the requested scope\n");
      git(isolatedRepo, "add", "app/public");
      git(isolatedRepo, "commit", "-m", "scoped child baseline");

      git(isolatedRepo, "rm", "app/public");
      write(isolatedRepo, "app/public/allowed.ts", "export const allowed = 'SCOPED_ALLOWED_CHILD';\n");
      git(isolatedRepo, "add", "app/public/allowed.ts");

      const inventory = git(isolatedRepo, "diff", "--cached", "--name-status", "-z", "--find-renames=1%");
      expect(inventory.split("\0")).toEqual(
        expect.arrayContaining(["D", "app/public", "A", "app/public/allowed.ts"]),
      );
      const diff = gitDiff(isolatedRepo, { mode: "staged", path: "app/public/allowed.ts" });
      expect(diff.isRepo).toBe(true);
      expect(diff.diff).toContain("SCOPED_ALLOWED_CHILD");
      expect(diff.diff).not.toContain("old ancestor outside the requested scope");
    } finally {
      cleanup(isolatedRepo);
    }
  });

  it("keeps nested workspace diffs when fifty unrelated repository paths change", () => {
    const isolatedRepo = makeTmpDir("git-unrelated-exclusion-budget");
    try {
      makeGitRepo(isolatedRepo);
      write(isolatedRepo, "app/allowed.ts", "export const allowed = 'baseline';\n");
      for (let i = 0; i < 50; i++) {
        write(isolatedRepo, `outside/file-${i}.txt`, `outside baseline ${i}\n`);
      }
      git(isolatedRepo, "add", "app", "outside");
      git(isolatedRepo, "commit", "-m", "unrelated paths baseline");

      write(isolatedRepo, "app/allowed.ts", "export const allowed = 'NESTED_ALLOWED_CHANGE';\n");
      for (let i = 0; i < 50; i++) {
        write(isolatedRepo, `outside/file-${i}.txt`, `OUTSIDE_UNRELATED_CHANGE_${i}\n`);
      }
      git(isolatedRepo, "add", "app", "outside");

      const inventory = git(isolatedRepo, "diff", "--cached", "--name-only", "-z");
      expect(inventory.split("\0").filter(Boolean)).toHaveLength(51);
      const diff = gitDiff(path.join(isolatedRepo, "app"), { mode: "staged" });
      expect(diff.isRepo).toBe(true);
      expect(diff.diff).toContain("NESTED_ALLOWED_CHANGE");
      expect(diff.diff).not.toContain("OUTSIDE_UNRELATED_CHANGE");
      expect(diff.diff).not.toContain("outside/file-");
    } finally {
      cleanup(isolatedRepo);
    }
  });

  it("fails closed when one positive path requires fifty sensitive descendant exclusions", () => {
    const isolatedRepo = makeTmpDir("git-required-exclusion-budget");
    try {
      makeGitRepo(isolatedRepo);
      write(isolatedRepo, "app/public", "safe original file content\n");
      git(isolatedRepo, "add", "app/public");
      git(isolatedRepo, "commit", "-m", "required exclusions baseline");

      git(isolatedRepo, "rm", "app/public");
      for (let i = 0; i < 50; i++) {
        write(isolatedRepo, `app/public/.env.${i}`, `REQUIRED_EXCLUSION_SECRET_${i}=private\n`);
      }
      git(isolatedRepo, "add", "-f", "app/public");

      const diff = gitDiff(isolatedRepo, { mode: "staged" });
      expect(diff.diff).toBe("");
      expect(diff.totalBytes).toBe(0);
      expect(diff.returnedBytes).toBe(0);
      expect(diff.hasMore).toBe(false);
    } finally {
      cleanup(isolatedRepo);
    }
  });
});
