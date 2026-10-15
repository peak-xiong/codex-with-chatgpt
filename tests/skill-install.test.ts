import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installGlobalSkill,
  restoreGlobalSkill,
  renderSkill,
  snapshotGlobalSkill,
  statusGlobalSkill,
} from "../src/config/skill-install.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const cliEntry = path.join(projectRoot, "src", "cli", "index.ts");
const temporaryDirectories: string[] = [];

function tempDir(name: string): string {
  const dir = makeTmpDir(name);
  temporaryDirectories.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  while (temporaryDirectories.length > 0) cleanup(temporaryDirectories.pop()!);
});

describe("global Skill installation", () => {
  it("renders the checkout path and installs idempotently with owner-only permissions", () => {
    const checkoutRoot = tempDir("skill-source");
    const codexHome = tempDir("skill-codex-home");
    const source = write(checkoutRoot, "skill/SKILL.md", "root=<ACTUAL_CHECKOUT_PATH>\n");

    const first = installGlobalSkill({ checkoutRoot, codexHome });
    const target = path.join(codexHome, "skills", "codex-with-chatgpt", "SKILL.md");
    expect(first).toMatchObject({ installed: true, changed: true, path: target });
    expect(fs.readFileSync(target, "utf8")).toBe(`root=${checkoutRoot}\n`);
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);

    const second = installGlobalSkill({ checkoutRoot, codexHome });
    expect(second).toMatchObject({ installed: true, changed: false, contentHash: first.contentHash });
    expect(statusGlobalSkill({ checkoutRoot, codexHome })).toMatchObject({
      installed: true,
      matches: true,
      contentHash: first.contentHash,
      expectedContentHash: first.contentHash,
    });
    expect(source).toBe(path.join(checkoutRoot, "skill", "SKILL.md"));
  });

  it("rejects missing or duplicate checkout placeholders", () => {
    expect(() => renderSkill("no placeholder", "/checkout")).toThrow(/exactly one/);
    expect(() => renderSkill("<ACTUAL_CHECKOUT_PATH> <ACTUAL_CHECKOUT_PATH>", "/checkout")).toThrow(
      /2 .*placeholders/,
    );
  });

  it("rejects a symlink target instead of replacing it", () => {
    const checkoutRoot = tempDir("skill-symlink-source");
    const codexHome = tempDir("skill-symlink-home");
    write(checkoutRoot, "skill/SKILL.md", "<ACTUAL_CHECKOUT_PATH>\n");
    const targetDir = path.join(codexHome, "skills", "codex-with-chatgpt");
    fs.mkdirSync(targetDir, { recursive: true });
    const outside = write(tempDir("skill-symlink-outside"), "SKILL.md", "outside\n");
    fs.symlinkSync(outside, path.join(targetDir, "SKILL.md"));

    expect(() => installGlobalSkill({ checkoutRoot, codexHome })).toThrow(/symlink/);
    expect(fs.readFileSync(outside, "utf8")).toBe("outside\n");
  });

  it("installs through the supported CC Switch directory link and preserves the link", () => {
    const userHome = tempDir("skill-shared-home");
    vi.spyOn(os, "homedir").mockReturnValue(userHome);
    const checkoutRoot = tempDir("skill-shared-source");
    const codexHome = tempDir("skill-shared-codex");
    const sharedSkillDir = path.join(userHome, ".agents", "skills", "codex-with-chatgpt");
    const linkParent = path.join(codexHome, "skills");
    write(checkoutRoot, "skill/SKILL.md", "root=<ACTUAL_CHECKOUT_PATH>\n");
    fs.mkdirSync(sharedSkillDir, { recursive: true });
    fs.mkdirSync(linkParent, { recursive: true });
    const linkPath = path.join(linkParent, "codex-with-chatgpt");
    fs.symlinkSync(sharedSkillDir, linkPath, "dir");
    const skillFile = path.join(sharedSkillDir, "SKILL.md");
    const originalBytes = Buffer.from("original shared Skill bytes\n");
    fs.writeFileSync(skillFile, originalBytes, { mode: 0o640 });
    fs.chmodSync(skillFile, 0o640);
    const originalMode = fs.statSync(skillFile).mode & 0o777;
    const snapshot = snapshotGlobalSkill({ codexHome });

    const result = installGlobalSkill({ checkoutRoot, codexHome });

    expect(result.path).toBe(path.join(linkPath, "SKILL.md"));
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(linkPath)).toBe(sharedSkillDir);
    expect(fs.readFileSync(skillFile, "utf8")).toBe(`root=${checkoutRoot}\n`);
    expect(statusGlobalSkill({ checkoutRoot, codexHome })).toMatchObject({ installed: true, matches: true });

    expect(snapshot.directory.kind).toBe("supported-symlink");
    restoreGlobalSkill(snapshot);
    expect(fs.readFileSync(skillFile)).toEqual(originalBytes);
    expect(fs.statSync(skillFile).mode & 0o777).toBe(originalMode);
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(linkPath)).toBe(sharedSkillDir);
  });

  it("rejects an unsupported Skill directory symlink without changing its target", () => {
    const userHome = tempDir("skill-untrusted-home");
    vi.spyOn(os, "homedir").mockReturnValue(userHome);
    const checkoutRoot = tempDir("skill-untrusted-source");
    const codexHome = tempDir("skill-untrusted-codex");
    write(checkoutRoot, "skill/SKILL.md", "root=<ACTUAL_CHECKOUT_PATH>\n");
    const outside = path.join(tempDir("skill-untrusted-outside"), "codex-with-chatgpt");
    fs.mkdirSync(outside, { recursive: true });
    const linkParent = path.join(codexHome, "skills");
    fs.mkdirSync(linkParent, { recursive: true });
    const linkPath = path.join(linkParent, "codex-with-chatgpt");
    fs.symlinkSync(outside, linkPath, "dir");

    expect(() => installGlobalSkill({ checkoutRoot, codexHome })).toThrow(/Unsupported Skill directory symlink/);
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("refuses rollback after the supported directory link is switched", () => {
    const userHome = tempDir("skill-switched-home");
    vi.spyOn(os, "homedir").mockReturnValue(userHome);
    const originalCheckout = tempDir("skill-switched-first");
    const nextCheckout = tempDir("skill-switched-second");
    const codexHome = tempDir("skill-switched-codex");
    const originalDir = path.join(userHome, ".agents", "skills", "codex-with-chatgpt");
    const replacementDir = path.join(tempDir("skill-switched-replacement"), "codex-with-chatgpt");
    write(originalCheckout, "skill/SKILL.md", "first=<ACTUAL_CHECKOUT_PATH>\n");
    write(nextCheckout, "skill/SKILL.md", "second=<ACTUAL_CHECKOUT_PATH>\n");
    fs.mkdirSync(originalDir, { recursive: true });
    fs.mkdirSync(replacementDir, { recursive: true });
    write(replacementDir, "SKILL.md", "replacement\n");
    const linkParent = path.join(codexHome, "skills");
    fs.mkdirSync(linkParent, { recursive: true });
    const linkPath = path.join(linkParent, "codex-with-chatgpt");
    fs.symlinkSync(originalDir, linkPath, "dir");
    installGlobalSkill({ checkoutRoot: originalCheckout, codexHome });
    const snapshot = snapshotGlobalSkill({ codexHome });
    installGlobalSkill({ checkoutRoot: nextCheckout, codexHome });

    fs.unlinkSync(linkPath);
    fs.symlinkSync(replacementDir, linkPath, "dir");
    expect(() => restoreGlobalSkill(snapshot)).toThrow(/Unsupported Skill directory symlink target/);
    expect(fs.readlinkSync(linkPath)).toBe(replacementDir);
    expect(fs.readFileSync(path.join(replacementDir, "SKILL.md"), "utf8")).toBe("replacement\n");
    expect(fs.readFileSync(path.join(originalDir, "SKILL.md"), "utf8")).toContain("second=");
  });

  it("rejects restoring a missing target after its skills parent is replaced", () => {
    const codexHome = tempDir("skill-parent-switch-home");
    const skillsDir = path.join(codexHome, "skills");
    const movedSkillsDir = path.join(codexHome, "skills-before-switch");
    const targetDir = path.join(skillsDir, "codex-with-chatgpt");
    fs.mkdirSync(skillsDir);
    const snapshot = snapshotGlobalSkill({ codexHome });

    fs.renameSync(skillsDir, movedSkillsDir);
    fs.mkdirSync(targetDir, { recursive: true });
    const sentinel = write(targetDir, "SKILL.md", "replacement parent content\n");

    expect(() => restoreGlobalSkill(snapshot)).toThrow(/parent directory changed/);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("replacement parent content\n");
  });

  it("keeps the installed Skill intact when atomic snapshot restoration fails", () => {
    const firstCheckout = tempDir("skill-restore-failure-first");
    const secondCheckout = tempDir("skill-restore-failure-second");
    const codexHome = tempDir("skill-restore-failure-home");
    write(firstCheckout, "skill/SKILL.md", "first=<ACTUAL_CHECKOUT_PATH>\n");
    write(secondCheckout, "skill/SKILL.md", "second=<ACTUAL_CHECKOUT_PATH>\n");
    installGlobalSkill({ checkoutRoot: firstCheckout, codexHome });
    const snapshot = snapshotGlobalSkill({ codexHome });
    installGlobalSkill({ checkoutRoot: secondCheckout, codexHome });

    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("injected restore rename failure");
    });
    try {
      expect(() => restoreGlobalSkill(snapshot)).toThrow("injected restore rename failure");
      expect(fs.readFileSync(snapshot.path, "utf8")).toBe("second=" + secondCheckout + "\n");
    } finally {
      renameSpy.mockRestore();
    }
  });

  it("rejects a Skill.md symlink inside an approved directory link", () => {
    const userHome = tempDir("skill-linked-file-home");
    vi.spyOn(os, "homedir").mockReturnValue(userHome);
    const checkoutRoot = tempDir("skill-linked-file-source");
    const codexHome = tempDir("skill-linked-file-codex");
    const sharedSkillDir = path.join(userHome, ".agents", "skills", "codex-with-chatgpt");
    const outside = write(tempDir("skill-linked-file-outside"), "SKILL.md", "outside\n");
    write(checkoutRoot, "skill/SKILL.md", "root=<ACTUAL_CHECKOUT_PATH>\n");
    fs.mkdirSync(sharedSkillDir, { recursive: true });
    fs.mkdirSync(path.join(codexHome, "skills"), { recursive: true });
    fs.symlinkSync(sharedSkillDir, path.join(codexHome, "skills", "codex-with-chatgpt"), "dir");
    fs.symlinkSync(outside, path.join(sharedSkillDir, "SKILL.md"));

    expect(() => installGlobalSkill({ checkoutRoot, codexHome })).toThrow(/symlink Skill target/);
    expect(fs.readFileSync(outside, "utf8")).toBe("outside\n");
  });

  it("reports an absent target without creating the global directory", () => {
    const checkoutRoot = tempDir("skill-status-source");
    const codexHome = path.join(tempDir("skill-status-parent"), "missing-codex-home");
    write(checkoutRoot, "skill/SKILL.md", "<ACTUAL_CHECKOUT_PATH>\n");

    const status = statusGlobalSkill({ checkoutRoot, codexHome });
    expect(status).toMatchObject({ installed: false, matches: false, contentHash: null });
    expect(fs.existsSync(codexHome)).toBe(false);
  });

  it("restores the previous global Skill after a setup rollback", () => {
    const firstCheckout = tempDir("skill-transaction-first");
    const secondCheckout = tempDir("skill-transaction-second");
    const codexHome = tempDir("skill-transaction-home");
    write(firstCheckout, "skill/SKILL.md", "first=<ACTUAL_CHECKOUT_PATH>\n");
    write(secondCheckout, "skill/SKILL.md", "second=<ACTUAL_CHECKOUT_PATH>\n");

    installGlobalSkill({ checkoutRoot: firstCheckout, codexHome });
    const snapshot = snapshotGlobalSkill({ codexHome });
    installGlobalSkill({ checkoutRoot: secondCheckout, codexHome });
    expect(fs.readFileSync(snapshot.path, "utf8")).toContain("second=");

    restoreGlobalSkill(snapshot);
    expect(fs.readFileSync(snapshot.path, "utf8")).toBe(`first=${firstCheckout}\n`);
  });

  it("installs through the CLI under an isolated CODEX_HOME", () => {
    const codexHome = tempDir("skill-cli-home");
    const stateDir = tempDir("skill-cli-state");
    const runtimeRoot = tempDir("skill-cli-runtime");
    fs.mkdirSync(path.join(runtimeRoot, "skill"), { recursive: true });
    fs.copyFileSync(path.join(projectRoot, "skill", "SKILL.md"), path.join(runtimeRoot, "skill", "SKILL.md"));
    const loader = pathToFileURL(path.join(projectRoot, "tests", "fixtures", "runtime-install-loader.mjs")).href;
    const result = spawnSync(process.execPath, ["--import", "tsx/esm", cliEntry, "skill", "install", "--json"], {
      cwd: projectRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: codexHome,
        CODEX_HOME: codexHome,
        C2C_STATE_DIR: stateDir,
        C2C_TEST_RUNTIME_PATH: runtimeRoot,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--experimental-loader=${loader}`].filter(Boolean).join(" "),
        NODE_NO_WARNINGS: "1",
      },
      timeout: 20_000,
    });
    expect(result.status, result.error?.message ?? result.stderr).toBe(0);
    const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(payload).toMatchObject({ ok: true, installed: true, changed: true });
    expect(String(payload.path)).toContain(path.join(codexHome, "skills", "codex-with-chatgpt"));
    expect(JSON.stringify(payload)).not.toContain("runtimeKey");

    const installedSkill = fs.readFileSync(String(payload.path), "utf8");
    expect(installedSkill).toBe(
      renderSkill(fs.readFileSync(path.join(projectRoot, "skill", "SKILL.md"), "utf8"), runtimeRoot),
    );
  });
});
