import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { readMany } from "../src/workspace/read-many.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

let state: string, root: string, workspace: Workspace;
beforeEach(() => {
  state = isolateStateDir(); root = makeTmpDir("read-many"); workspace = new Workspace(root);
});
afterEach(() => { cleanup(root); cleanup(state); delete process.env.C2C_STATE_DIR; });

it("returns independent file ranges and safe per-file failures without losing successful reads", async () => {
  write(root, "a.txt", "one\ntwo\nthree");
  write(root, ".env", "secret-value");
  const outside = makeTmpDir("read-many-outside");
  try {
    write(outside, "private.txt", "outside-secret");
    fs.symlinkSync(path.join(outside, "private.txt"), path.join(root, "escape.txt"));
    const result = await readMany(workspace, [{ path: "a.txt", start_line: 2, end_line: 2 },
      { path: ".env" }, { path: "absent.txt" }, { path: "escape.txt" }]);
    expect(result.items[0]).toMatchObject({ file: { content: "two", startLine: 2, endLine: 2 } });
    expect(result.items.slice(1)).toEqual([
      { index: 1, error: "ACCESS_DENIED_SENSITIVE_FILE" },
      { index: 2, error: "FILE_NOT_FOUND" },
      { index: 3, error: "PATH_OUTSIDE_WORKSPACE" },
    ]);
    expect(JSON.stringify(result)).not.toContain("secret");
  } finally { cleanup(outside); }
});

it("bounds escaped JSON and UTF-8 content and reports a first line larger than the budget", async () => {
  write(root, "large.txt", "中".repeat(40_000));
  write(root, "escaped.txt", Array.from({ length: 500 }, () => '\\"'.repeat(50)).join("\n"));
  const result = await readMany(workspace, [{ path: "large.txt" }, { path: "escaped.txt" }], 4096);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4096);
  expect(result.items[0]).toEqual({ index: 0, error: "FILE_TOO_LARGE" });
  await expect(readMany(workspace, Array.from({ length: 17 }, () => ({ path: "a.txt" })))).rejects.toThrow();
});
