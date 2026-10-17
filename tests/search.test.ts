import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspace } from "../src/workspace/manager.js";
import { searchWorkspace, resetRipgrepCache, findRipgrep } from "../src/workspace/search.js";
import { makeTmpDir, cleanup, write, git } from "./helpers.js";
import { projectDataDirectory } from "../src/workspace/identity.js";

let root: string;
let ws: Workspace;
const temporaryDirectories: string[] = [];
const globMarker = "C2C_GLOB_MARKER";

beforeAll(() => {
  root = makeTmpDir("search-ws");
  write(root, "src/auth.ts", "export function login() { return 'needle-alpha'; }\n");
  write(root, "src/deep/nested.ts", `// needle-alpha appears here too\n${globMarker}\n`);
  write(root, "src/root.ts", `${globMarker}\n`);
  write(root, "root.ts", `${globMarker}\n`);
  write(root, "README.md", "This project contains needle-alpha documentation.\n");
  write(root, ".env", "NEEDLE-ALPHA=secret\n");
  write(root, "node_modules/pkg/index.js", "needle-alpha in dependencies\n");
  for (let i = 0; i < 30; i++) {
    write(root, `many/file-${i}.txt`, "needle-beta\nneedle-beta\n");
  }
  ws = new Workspace(root);
});

afterAll(() => {
  cleanup(root);
});

afterEach(() => {
  delete process.env.C2C_DISABLE_RG;
  delete process.env.C2C_RG_PATH;
  resetRipgrepCache();
  while (temporaryDirectories.length > 0) cleanup(temporaryDirectories.pop()!);
});

function fakeRipgrep(source: string): string {
  const directory = makeTmpDir("fake-rg");
  temporaryDirectories.push(directory);
  const executable = write(directory, "rg", `#!/usr/bin/env node\n${source}\n`);
  fs.chmodSync(executable, 0o700);
  process.env.C2C_RG_PATH = executable;
  resetRipgrepCache();
  return executable;
}

function engines(): ("ripgrep" | "node")[] {
  return findRipgrep() ? ["ripgrep", "node"] : ["node"];
}

describe.each(engines())("search engine: %s", (engine) => {
  const configure = (): void => {
    if (engine === "node") process.env.C2C_DISABLE_RG = "1";
    resetRipgrepCache();
  };

  it("finds matches with paths and line numbers", async () => {
    configure();
    const result = await searchWorkspace(ws, { query: "needle-alpha" });
    expect(result.engine).toBe(engine);
    const paths = result.matches.map((match) => match.path);
    expect(paths).toContain("src/auth.ts");
    expect(paths).toContain("src/deep/nested.ts");
    expect(paths).toContain("README.md");
    const authMatch = result.matches.find((match) => match.path === "src/auth.ts");
    expect(authMatch?.line).toBe(1);
  });

  it("never returns sensitive or noise files", async () => {
    configure();
    const result = await searchWorkspace(ws, { query: "needle-alpha" });
    const paths = result.matches.map((match) => match.path);
    expect(paths.some((p) => p.includes(".env"))).toBe(false);
    expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
  });

  it("respects the limit", async () => {
    configure();
    const result = await searchWorkspace(ws, { query: "needle-beta", limit: 10 });
    expect(result.matches.length).toBeLessThanOrEqual(10);
    expect(result.truncated).toBe(true);
  });

  it("detects truncation after the limit inside one dense file", async () => {
    configure();
    const denseRoot = makeTmpDir("search-dense");
    try {
      write(denseRoot, "dense.txt", Array.from({ length: 45 }, () => "dense-needle").join("\n"));
      const result = await searchWorkspace(new Workspace(denseRoot), {
        query: "dense-needle",
        limit: 35,
      });
      expect(result.matches).toHaveLength(35);
      expect(result.truncated).toBe(true);
    } finally {
      cleanup(denseRoot);
    }
  });

  it("does not mark an exact visible-match limit as truncated", async () => {
    configure();
    const exactRoot = makeTmpDir("search-exact-cap");
    try {
      write(exactRoot, "exact.txt", Array.from({ length: 5 }, () => "exact-needle").join("\n"));
      const result = await searchWorkspace(new Workspace(exactRoot), {
        query: "exact-needle",
        limit: 5,
      });
      expect(result.matches).toHaveLength(5);
      expect(result.truncated).toBe(false);
    } finally {
      cleanup(exactRoot);
    }
  });

  it("does not let hidden matches trigger visible-result truncation", async () => {
    configure();
    const hiddenRoot = makeTmpDir("search-hidden-cap");
    try {
      write(hiddenRoot, ".c2cignore", "z-hidden.txt\n");
      write(hiddenRoot, "a-visible.txt", "hidden-needle\n");
      write(hiddenRoot, "z-hidden.txt", Array.from({ length: 12 }, () => "hidden-needle").join("\n"));
      const result = await searchWorkspace(new Workspace(hiddenRoot), {
        query: "hidden-needle",
        limit: 1,
      });
      expect(result.matches.map((match) => match.path)).toEqual(["a-visible.txt"]);
      expect(result.truncated).toBe(false);
    } finally {
      cleanup(hiddenRoot);
    }
  });

  it("supports glob filters", async () => {
    configure();
    const result = await searchWorkspace(ws, { query: "needle-alpha", glob: "*.md" });
    const paths = result.matches.map((match) => match.path);
    expect(paths).toContain("README.md");
    expect(paths.some((p) => p.endsWith(".ts"))).toBe(false);
  });

  it("matches root and nested files for recursive globs", async () => {
    configure();
    const result = await searchWorkspace(ws, { query: globMarker, glob: "**/*.ts" });
    const paths = result.matches.map((match) => match.path).sort();
    expect(paths).toEqual(["root.ts", "src/deep/nested.ts", "src/root.ts"]);
  });

  it("restricts search to a subdirectory", async () => {
    configure();
    const result = await searchWorkspace(ws, { query: "needle-alpha", path: "src" });
    const paths = result.matches.map((match) => match.path);
    expect(paths).toContain("src/auth.ts");
    expect(paths).not.toContain("README.md");
  });

  it("filters separate Git metadata from Node traversal and ripgrep results", async () => {
    const separateRoot = makeTmpDir("search-separate-git-dir");
    try {
      const gitMetadata = path.join(separateRoot, "gitmeta");
      git(separateRoot, "init", "--separate-git-dir", gitMetadata, "-b", "main");
      const separateWorkspace = new Workspace(separateRoot);
      const source = write(separateRoot, "src/allowed.ts", "separate-git-sentinel\n");
      const sentinel = path.join(
        projectDataDirectory(separateRoot), "workspaces", separateWorkspace.id, "execution-record.json",
      );
      write(separateRoot, path.relative(separateRoot, sentinel), "separate-git-sentinel\n");

      process.env.C2C_DISABLE_RG = "1";
      resetRipgrepCache();
      const nodeResult = await searchWorkspace(separateWorkspace, { query: "separate-git-sentinel" });
      expect(nodeResult.engine).toBe("node");
      expect(nodeResult.matches.map((match) => match.path)).toEqual(["src/allowed.ts"]);

      fakeRipgrep([
        `for (const file of ${JSON.stringify([sentinel, source])}) {`,
        `process.stdout.write(JSON.stringify({type:"match",data:{path:{text:file},line_number:1,lines:{text:"separate-git-sentinel\\n"}}})+"\\n");`,
        "}",
      ].join("\n"));
      delete process.env.C2C_DISABLE_RG;
      const rgResult = await searchWorkspace(separateWorkspace, { query: "separate-git-sentinel" });
      expect(rgResult.engine).toBe("ripgrep");
      expect(rgResult.matches.map((match) => match.path)).toEqual(["src/allowed.ts"]);
    } finally {
      cleanup(separateRoot);
    }
  });
});

describe("search input safety", () => {
  it("never evaluates model-provided regular expressions in the Node fallback", async () => {
    process.env.C2C_DISABLE_RG = "1";
    resetRipgrepCache();

    await expect(
      searchWorkspace(ws, { query: "^(a+)+$", regex: true })
    ).rejects.toMatchObject({ code: "REGEX_ENGINE_UNAVAILABLE" });
  });

  it("rejects oversized queries before selecting a search engine", async () => {
    await expect(
      searchWorkspace(ws, { query: "a".repeat(1_025) })
    ).rejects.toMatchObject({ code: "SEARCH_QUERY_TOO_LARGE" });
  });

  it("reports ripgrep regex errors and redacts bounded diagnostics", async () => {
    const query = "sensitive-query-marker";
    const token = "c2c_mcp_abcdefghijklmnopqrstuvwxyz123456";
    const diagnostic = `invalid regex ${query} at ${ws.root} under ${os.homedir()} ${token}\u0001`;
    fakeRipgrep(`process.stderr.write(${JSON.stringify(diagnostic)}); process.exit(2);`);

    const error = await searchWorkspace(ws, { query, regex: true }).then(
      () => null,
      (reason: Error) => reason,
    );
    expect(error).toMatchObject({ code: "SEARCH_FAILED" });
    expect(error?.message).not.toContain(query);
    expect(error?.message).not.toContain(ws.root);
    expect(error?.message).not.toContain(os.homedir());
    expect(error?.message).not.toContain(token);
    expect(error?.message).not.toContain("\u0001");
    expect(error?.message.length).toBeLessThan(700);
  });

  it.skipIf(process.platform === "win32")("ignores malformed stdout after limit-triggered SIGTERM", async () => {
    const target = path.join(ws.root, "README.md");
    fakeRipgrep([
      "let stopping = false;",
      "process.on('SIGTERM', () => {",
      "  if (stopping) return;",
      "  stopping = true;",
      "  process.stdout.write('{\\\"type\\\":\\n', () => {",
      "    process.removeAllListeners('SIGTERM');",
      "    process.kill(process.pid, 'SIGTERM');",
      "  });",
      "});",
      `const event = (line) => JSON.stringify({ type: 'match', data: { path: { text: ${JSON.stringify(target)} }, line_number: line, lines: { text: 'needle\\n' } } }) + '\\n';`,
      "process.stdout.write(event(1) + event(2));",
      "setInterval(() => {}, 1000);",
    ].join("\n"));

    const result = await searchWorkspace(ws, { query: "needle", limit: 1 });
    expect(result.matches).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(result.engine).toBe("ripgrep");
  });
});
