import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards the operator-facing guidance that the first pairing depends on.
 *
 * These assertions read the shipped text instead of exercising behaviour. That is a
 * deliberate, limited choice: what they protect against is not a wrong return value but
 * a *deleted or reverted instruction*. The 2026-09-16 first pairing lost roughly 40
 * minutes to messages that named a symptom without its fix, and to a documented BOOT
 * example whose `--ttl-ms` expired mid-round-trip; nothing else in the suite would
 * notice if that came back.
 *
 * Behaviour — validation messages and request lookup using `--request` with the
 * resolved `--local-session` — is covered by tests/gateway-server.test.ts and
 * tests/cli-control.test.ts. Correlation flags remain optional complete cross-checks.
 */
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string): string =>
  fs.readFileSync(path.join(projectRoot, relative), "utf8");
const normalizeWhitespace = (text: string): string => text.replace(/\s+/g, " ").trim();

/** The fenced block that contains `anchor`, so prose mentions do not satisfy an assertion. */
function fencedBlockContaining(markdown: string, anchor: string): string {
  const blocks = [...markdown.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
  const found = blocks.find((block) => block.includes(anchor));
  if (found === undefined) throw new Error(`no fenced block contains ${JSON.stringify(anchor)}`);
  return found;
}

describe("first-pairing guidance", () => {
  const protocolSource = read("docs/protocol.md");
  const skillSource = read("skill/SKILL.md");
  const protocol = normalizeWhitespace(protocolSource);
  const skill = normalizeWhitespace(skillSource);
  const pairingGuidance = normalizeWhitespace(`${skillSource} ${protocolSource}`);

  it("ships a BOOT example whose TTL outlives the human-paced round trip", () => {
    const bootExample = fencedBlockContaining(protocolSource, "--phase BOOT");
    expect(bootExample).toContain("c2c control open");
    // The example must not carry a short TTL: typing the boot prompt, waiting for the
    // reply and posting the observation regularly outlive a 5-minute request.
    expect(bootExample).not.toContain("--ttl-ms");
    expect(protocol).toContain("Keep the request TTL at the 30-minute default.");
  });

  it("keeps the runbook for the failure modes that each cost a retry loop", () => {
    expect(skill).toContain("while selection evidence is fresh");
    expect(skill).toContain("Use default BOOT TTL");
    expect(skill).toContain("surface claim restores an expired page lease");
    // Validation failures must promise the offending field, not a bare "failed validation".
    expect(skill).toContain("returns the offending field");
  });

  it("reconciles ambiguous browser creation and reads before claiming a Project", () => {
    expect(pairingGuidance).toContain("listTabs before creating");
    expect(pairingGuidance).toMatch(/after a `?createBrowserTab`? timeout,? reconcile with `?listTabs`? before another attempt/);
    expect(pairingGuidance).toMatch(/exact identity returned from creation or a clear before\/after inventory difference/);
    expect(pairingGuidance).toContain("keep its complete providerTabId");
    expect(pairingGuidance).toContain("continue reading that exact tab");
    expect(pairingGuidance).toContain("URL/title similarity alone is not ownership evidence");
    expect(pairingGuidance).toContain("diagnostic candidate");
    expect(pairingGuidance).toMatch(/ambiguous[^.]*do not claim it or create another/);
    expect(pairingGuidance).toMatch(/do not blindly retry creation/);
    expect(pairingGuidance).toMatch(/DOM snapshot or screenshot timeout.*?Back off and read the same tab again/);
    expect(pairingGuidance).toContain("verifiable Project URL");
    expect(pairingGuidance).toContain("fresh creation evidence");
    expect(protocol).toContain("only for an already claimed exact tab and generation");
    expect(skill).toContain("only after that exact tab and generation have been claimed");
  });

  it("gates first-time browser steps and records network policy errors as host limits", () => {
    for (const guidance of [skill, protocol]) {
      expect(guidance).toContain("nextStep");
      expect(guidance).toContain("workspace registration");
      expect(guidance).toContain("network-error");
      expect(guidance).toContain("data:");
      expect(guidance).toContain("BOOT");
    }
    expect(pairingGuidance).toMatch(/do not (blindly )?retry creation/);
    expect(protocol).toContain("nextAction: claim_saved_page");
    expect(protocol).toContain("targetUrl: null");
    expect(skill).toContain("nextAction: claim_saved_page");
    expect(protocol).toContain("host policy limitation");
    expect(skill).toContain("host policy limitation");
  });

  it("does not send readers back to the superseded lookup contract", () => {
    // Status, wait and observe require request plus local-session identity; a complete
    // task/iteration/phase triple is an optional cross-check.
    expect(skill).not.toMatch(/Lookup commands[^.]*need the full correlation/);
    expect(skill).toContain("Use `--request` with the resolved `--local-session` for status, wait, and observe");
    expect(skill).toContain("task/iteration/phase triple is an optional complete cross-check");
  });
});
