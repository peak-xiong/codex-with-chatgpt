import { describe, expect, it } from "vitest";
import { controlDeliveryPrompt, controlResultContract } from "../src/control/result-contract.js";
import {
  CONTROL_PHASES,
  MAX_CONTROL_RESULT_BYTES,
  allowedKindsForPhase,
  parseControlResultSubmission,
  researchPayloadSchema,
} from "../src/control/result-schema.js";

describe("control result prompt contract", () => {
  it.each(CONTROL_PHASES)("supplies schema-valid examples for every allowed %s result", (phase) => {
    const contract = controlResultContract(phase);
    expect(contract.requiredTools).toEqual(
      phase === "BOOT"
        ? ["workspace_info", "read_file"]
        : [],
    );
    expect(contract.examples.map((example) => example.kind)).toEqual(allowedKindsForPhase(phase));
    for (const example of contract.examples) {
      expect(parseControlResultSubmission(example)).toMatchObject(example);
      expect(allowedKindsForPhase(phase)).toContain(example.kind);
    }
    const wrongPhaseKind = phase === "RESEARCH" ? "PLAN" : "RESEARCH";
    expect(allowedKindsForPhase(phase)).not.toContain(wrongPhaseKind);
  });

  it("does not supply invented external evidence for local research", () => {
    const example = controlResultContract("RESEARCH").examples.find((item) => item.kind === "RESEARCH")!;
    expect(researchPayloadSchema.parse(example.payload).sources).toEqual([]);
    expect(researchPayloadSchema.safeParse({ ...example.payload, conclusions: [] }).success).toBe(false);
    expect(researchPayloadSchema.safeParse({ ...example.payload, sources: undefined }).success).toBe(false);
  });

  it.each(CONTROL_PHASES)("renders all %s delivery instructions with the exact runtime correlation", (phase) => {
    const request = {
      schemaVersion: 2 as const, requestId: "request-fixture", workspaceId: "workspace-fixture",
      localSessionId: "session-fixture", taskId: "task-fixture", iteration: 7, phase,
      allowedKinds: allowedKindsForPhase(phase),
      surfaceGeneration: 1,
      surfaceTabId: "tab-fixture",
      createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-01T00:30:00.000Z",
    };
    const contextId = "synthetic-context-for-test";
    const prompt = controlDeliveryPrompt(request, contextId);
    const fields = Object.fromEntries(prompt.split("\n").slice(1, 7).map((line) => line.split(": ")));
    expect(fields).toEqual({
      RESULT_REQUEST_ID: request.requestId, CONTEXT_ID: contextId, LOCAL_SESSION_ID: request.localSessionId,
      TASK_ID: request.taskId, ITERATION: "7", RESULT_PHASE: phase,
    });
    const contract = controlResultContract(phase);
    for (const instruction of contract.instructions) expect(prompt).toContain(instruction);
    expect(prompt).toContain(JSON.stringify(contract.examples[0]));
    expect(contract.examples.some((example) => example.kind === "BLOCKED")).toBe(true);
    expect(prompt).toContain("C2C_HOST_OBSERVED_RESULT");
    expect(prompt).not.toMatch(/mailbox|callback|submit_control_result|report_control_progress/i);
    expect(Buffer.byteLength(prompt)).toBeLessThan(2300);
    expect(prompt).toContain(request.requestId);
    expect(prompt).toContain(`RESULT_REQUEST_ID: ${request.requestId}`);
    expect(prompt).toContain("Emit exactly one allowed result object");
    expect(prompt).not.toContain(JSON.stringify(contract.examples));
    expect(prompt).toContain("No user interruption is needed.");
    expect(prompt).not.toContain("<the exact id above>");
    const success = contract.examples.find((example) => example.kind !== "BLOCKED");
    const blocked = contract.examples.find((example) => example.kind === "BLOCKED");
    expect(prompt).toContain(JSON.stringify(success));
    expect(prompt).toContain(JSON.stringify(blocked));
    expect(prompt.indexOf("C2C_HOST_OBSERVED_RESULT")).toBeLessThan(prompt.lastIndexOf(`RESULT_REQUEST_ID: ${request.requestId}`));
    if (phase === "BOOT") {
      expect(prompt).toContain("BOOT success is valid only after required identity and tool evidence is verified");
      expect(prompt).toContain('"kind":"BOOT","payload":{}');
    }
  });

  it("makes BOOT success depend on observed identity and bounded file evidence", () => {
    const contract = controlResultContract("BOOT");
    expect(contract.requiredTools).toEqual(["workspace_info", "read_file"]);
    expect(contract.instructions.join("\n")).toContain(
      "then return BOOT with payload {}",
    );
    expect(contract.instructions.join("\n")).toContain(
      "missing required evidence",
    );
  });

  it("bounds new submissions while retaining validation for larger stored results", () => {
    expect(MAX_CONTROL_RESULT_BYTES).toBe(16 * 1024);
    expect(() => parseControlResultSubmission({
      kind: "BLOCKED",
      payload: { reason: "x".repeat(601), needs: ["Stop this attempt"] },
    })).toThrow(/INVALID_RESULT|600|invalid/i);
    expect(() => parseControlResultSubmission({
      kind: "BLOCKED",
      payload: { reason: "Cannot finish", needs: Array.from({ length: 6 }, () => "Stop this attempt") },
    })).toThrow(/INVALID_RESULT|5|invalid/i);

    const withLegacyCorrelation = {
      ...controlResultContract("PLAN").examples[0]!,
      requestId: "request-stored",
      localSessionId: "session-stored",
      taskId: "task-stored",
      iteration: 0,
      phase: "PLAN",
    };
    expect(() => parseControlResultSubmission(withLegacyCorrelation)).toThrow(/unrecognized|unknown|strict/i);

    expect(() => parseControlResultSubmission({
      kind: "PLAN",
      payload: {
        goal: "Bound aggregate output",
        rationale: "r".repeat(1_900),
        actions: Array.from({ length: 12 }, (_, index) => ({
          change: `change-${index} ${"c".repeat(500)}`,
          why: `why-${index} ${"w".repeat(500)}`,
          risks: Array.from({ length: 4 }, () => "risk ".padEnd(280, "x")),
        })),
        tests: [],
        successCriteria: ["Reject oversized aggregate output"],
      },
    })).toThrow(/exceeds 16384 bytes/);
  });
});
