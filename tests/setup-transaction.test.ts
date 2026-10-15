import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveMachineSetupOptions,
  runRollbackSteps,
  shouldRestorePreviousGateway,
} from "../src/config/setup-transaction.js";
import { installGlobalSkill, restoreGlobalSkill, snapshotGlobalSkill } from "../src/config/skill-install.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

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

describe("machine setup rollback", () => {
  it("requires complete first-time credentials", () => {
    expect(() => resolveMachineSetupOptions({ reuseExisting: false }, null)).toThrow(
      /provide both --tunnel-id and --runtime-key-file/i,
    );
    expect(() => resolveMachineSetupOptions({
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      reuseExisting: false,
    }, null)).toThrow(/provide both/i);
    expect(resolveMachineSetupOptions({
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeKeyFile: "/private/runtime.key",
      reuseExisting: false,
    }, null)).toEqual({
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeKeySourceFile: "/private/runtime.key",
      reuseExisting: false,
    });
  });

  it("reuses an existing tunnel only when explicitly requested", () => {
    const existing = { tunnelId: "tunnel_0123456789abcdef0123456789abcdef" };
    expect(resolveMachineSetupOptions({ reuseExisting: true }, existing)).toEqual({
      tunnelId: existing.tunnelId,
      runtimeKeySourceFile: null,
      reuseExisting: true,
    });
    expect(() => resolveMachineSetupOptions({ reuseExisting: true }, null)).toThrow(
      /no existing OpenAI Secure MCP Tunnel configuration/i,
    );
    expect(() => resolveMachineSetupOptions({
      reuseExisting: true,
      tunnelId: existing.tunnelId,
    }, existing)).toThrow(/cannot be combined/i);
  });

  it("keeps a previously stopped Gateway stopped when its running supervisor is stopped", () => {
    expect(shouldRestorePreviousGateway("stopped", true)).toBe(false);
    expect(shouldRestorePreviousGateway("unknown", true)).toBe(false);
  });

  it("restores a previously healthy Gateway only after a successful stop", () => {
    expect(shouldRestorePreviousGateway("healthy", true)).toBe(true);
    expect(shouldRestorePreviousGateway("healthy", false)).toBe(false);
  });

  it("runs every rollback step and aggregates failures in order", async () => {
    const calls: string[] = [];
    const finalStep = vi.fn(() => {
      calls.push("third");
    });

    const errors = await runRollbackSteps([
      {
        label: "first restore",
        run: () => {
          calls.push("first");
          throw new Error("first failed");
        },
      },
      {
        label: "second restore",
        run: async () => {
          calls.push("second");
          throw "second failed";
        },
      },
      { label: "third restore", run: finalStep },
    ]);

    expect(calls).toEqual(["first", "second", "third"]);
    expect(finalStep).toHaveBeenCalledOnce();
    expect(errors).toEqual([
      "first restore: first failed",
      "second restore: second failed",
    ]);
  });

  it("returns no errors after a complete rollback", async () => {
    await expect(runRollbackSteps([
      { label: "sync", run: () => undefined },
      { label: "async", run: async () => undefined },
    ])).resolves.toEqual([]);
  });

  it("restores the shared Skill through its preserved CC Switch link during setup rollback", async () => {
    const userHome = tempDir("setup-rollback-home");
    vi.spyOn(os, "homedir").mockReturnValue(userHome);
    const codexHome = tempDir("setup-rollback-codex");
    const nextCheckout = tempDir("setup-rollback-second");
    const sharedSkillDir = path.join(userHome, ".agents", "skills", "codex-with-chatgpt");
    const linkParent = path.join(codexHome, "skills");
    const linkPath = path.join(linkParent, "codex-with-chatgpt");
    const skillFile = path.join(sharedSkillDir, "SKILL.md");
    const originalBytes = Buffer.from("pre-setup Skill bytes\n");
    write(nextCheckout, "skill/SKILL.md", "next=<ACTUAL_CHECKOUT_PATH>\n");
    fs.mkdirSync(sharedSkillDir, { recursive: true });
    fs.mkdirSync(linkParent, { recursive: true });
    fs.writeFileSync(skillFile, originalBytes, { mode: 0o640 });
    fs.chmodSync(skillFile, 0o640);
    const originalMode = fs.statSync(skillFile).mode & 0o777;
    fs.symlinkSync(sharedSkillDir, linkPath, "dir");

    const snapshot = snapshotGlobalSkill({ codexHome });
    installGlobalSkill({ checkoutRoot: nextCheckout, codexHome });
    const errors = await runRollbackSteps([
      { label: "restore global Skill", run: () => restoreGlobalSkill(snapshot) },
    ]);

    expect(errors).toEqual([]);
    expect(fs.readFileSync(skillFile)).toEqual(originalBytes);
    expect(fs.statSync(skillFile).mode & 0o777).toBe(originalMode);
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(linkPath)).toBe(sharedSkillDir);
  });
});
