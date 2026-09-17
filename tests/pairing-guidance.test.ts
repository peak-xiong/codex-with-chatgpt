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
 * Behaviour — the validation messages themselves, and lookups by `--request` alone — is
 * covered by tests/gateway-server.test.ts and tests/cli-control.test.ts. If those and
 * this file ever disagree, believe those.
 */
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string): string =>
  fs.readFileSync(path.join(projectRoot, relative), "utf8");

/** The fenced block that contains `anchor`, so prose mentions do not satisfy an assertion. */
function fencedBlockContaining(markdown: string, anchor: string): string {
  const blocks = [...markdown.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
  const found = blocks.find((block) => block.includes(anchor));
  if (found === undefined) throw new Error(`no fenced block contains ${JSON.stringify(anchor)}`);
  return found;
}

describe("first-pairing guidance", () => {
  const protocol = read("docs/protocol.md");
  const skill = read("skill/SKILL.md");

  it("ships a BOOT example whose TTL outlives the human-paced round trip", () => {
    const bootExample = fencedBlockContaining(protocol, "--phase BOOT");
    expect(bootExample).toContain("c2c control open");
    // The example must not carry a short TTL: typing the boot prompt, waiting for the
    // reply and posting the observation regularly outlive a 5-minute request.
    expect(bootExample).not.toContain("--ttl-ms");
    expect(protocol).toContain("Keep the request TTL at the 30-minute default.");
  });

  it("keeps the runbook for the failure modes that each cost a retry loop", () => {
    expect(skill).toContain("### First-pairing runbook (observed failure modes)");
    for (const trap of ["Stale selection evidence", "Short BOOT TTL", "Expired page lease"]) {
      expect(skill).toContain(trap);
    }
    // Validation failures must promise the offending field, not a bare "failed validation".
    expect(skill).toContain("returns the offending field");
  });

  it("does not send readers back to the superseded lookup contract", () => {
    // `control status|wait|observe` locate a request by `--request` alone; the triple is
    // an optional cross-check. The runbook previously claimed the opposite, which is the
    // exact advice that made a first-pairing `control status` fail on a missing `--task`.
    expect(skill).not.toMatch(/Lookup commands[^.]*need the full correlation/);
    expect(skill).toMatch(/`--request` alone/);
  });
});
