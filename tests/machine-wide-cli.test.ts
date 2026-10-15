import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, makeTmpDir } from "./helpers.js";
import { toTomlPath } from "../src/config/sandbox-allow.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "src", "cli", "index.ts");
const dirs: string[] = [];

function runCli(root: string, args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx/esm", cliEntry, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000,
    env: {
      ...process.env,
      C2C_STATE_DIR: path.join(root, "state"),
      CODEX_HOME: path.join(root, "codex-home"),
    },
  });
}

afterEach(() => {
  while (dirs.length > 0) cleanup(dirs.pop()!);
});

describe("machine-wide CLI compatibility options", () => {
  it("accepts and ignores -w for prefs get/set", () => {
    const root = makeTmpDir("machine-wide-prefs"); dirs.push(root);
    const got = runCli(root, ["prefs", "get", "-w", path.join(root, "unrelated-workspace"), "--json"]);
    expect(got.status).toBe(0);
    expect(JSON.parse(got.stdout)).toMatchObject({ ok: true, developerModeEnabled: false });

    const saved = runCli(root, ["prefs", "set", "-w", path.join(root, "unrelated-workspace"), "--setup-mode", "manual", "--json"]);
    expect(saved.status).toBe(0);
    expect(JSON.parse(saved.stdout)).toMatchObject({ ok: true, setupMode: "manual" });
  });

  it("accepts and ignores -w for sandbox-clean while changing machine config only", () => {
    const root = makeTmpDir("machine-wide-sandbox"); dirs.push(root);
    const stateRoot = path.join(root, "state");
    const configPath = path.join(root, "codex-home", "config.toml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(toTomlPath(stateRoot))}]\n`);

    const result = runCli(root, ["sandbox-clean", "-w", path.join(root, "unrelated-workspace"), "--json"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, removedRoots: 1, configPath });
    expect(fs.readFileSync(configPath, "utf8")).not.toContain(toTomlPath(stateRoot));
  });
});
