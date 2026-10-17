import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  cancelControlRequest,
  clearLegacyControlMailbox,
  getControlRequestsDir,
  getControlRequestStatus,
  inspectActiveControlRequestStatus,
  observeControlRequest,
  openControlRequest,
  pruneControlRequests,
  recordLateControlEvidence,
  waitForControlRequest,
} from "../src/control/requests.js";
import { canonicalJson, sha256Hex } from "../src/control/result-schema.js";
import { controlWaitPolicy } from "../src/control/wait-policy.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

const WORKSPACE_A = "migrationworkspacea";
const WORKSPACE_B = "migrationworkspaceb";
const CONTROL_REQUEST_DIRS = ["requests", "observations", "cancelled", "active", "renewals", "late-evidence"];
const LEGACY_DIRS = [...CONTROL_REQUEST_DIRS, "results", "progress", "acks", "locks"];
const TERMINAL_FILES = (requestId: string) => [
  `requests/${requestId}.json`,
  `observations/${requestId}.json`,
  `cancelled/${requestId}.json`,
];

let stateDir: string;

function correlation(iteration = 0) {
  return { taskId: "migration_task", iteration, phase: "PLAN" as const };
}

function observeCompletedComputerUseRequest(
  workspaceId: string,
  options: { localSessionId: string; taskId: string; iteration?: number; createdAt?: number },
) {
  const wasUsingFakeTimers = vi.isFakeTimers();
  if (!wasUsingFakeTimers) vi.useFakeTimers({ toFake: ["Date"] });
  const baseTime = options.createdAt ?? Date.now();
  vi.setSystemTime(baseTime);
  try {
    const currentCorrelation = { taskId: options.taskId, iteration: options.iteration ?? 0, phase: "PLAN" as const };
    const tabId = `tab-${options.localSessionId}`;
    const request = openControlRequest(workspaceId, {
      localSessionId: options.localSessionId,
      ...currentCorrelation,
      surfaceGeneration: 1,
      surfaceTabId: tabId,
    });
    const responseId = `response-${request.requestId}`;
    const observedUrl = "https://chatgpt.com/c/migration-fixture";
    const observe = (
      observationSequence: number,
      state: "send_attempted" | "sent" | "response_created" | "result_candidate" | "final",
      terminal = false,
    ) => observeControlRequest(workspaceId, request.requestId, options.localSessionId, currentCorrelation, {
      tabId,
      generation: 1,
      observedUrl,
      observedAt: new Date(baseTime + observationSequence * 100).toISOString(),
      responseToRequestId: request.requestId,
      observationSequence,
      state,
      ...(observationSequence >= 3 ? { responseId } : {}),
      ...(terminal ? {
        responseIsFinal: true,
        delivery: "computer_use",
        terminalResult: {
          kind: "PLAN",
          payload: {
            goal: "Retain verified Computer Use history",
            rationale: "Migration must preserve the sole valid terminal record.",
            actions: [{ change: "Copy verified request history", why: "Keep its audit trail." }],
            tests: [],
            successCriteria: ["The exact terminal response remains readable."],
          },
        },
        completionEvidence: { responseActionsVisible: true, stopControlAbsent: true },
      } : {}),
    });

    observe(1, "send_attempted");
    observe(2, "sent");
    observe(3, "response_created");
    observe(4, "result_candidate", true);
    vi.setSystemTime(baseTime + 1_500);
    observe(5, "final", true);
    return request;
  } finally {
    if (!wasUsingFakeTimers) vi.useRealTimers();
  }
}

function snapshots(workspaceId: string, relativeFiles: string[]): Map<string, Buffer> {
  const root = getControlRequestsDir(workspaceId);
  return new Map(relativeFiles.map((relative) => [
    relative,
    fs.readFileSync(path.join(root, ...relative.split("/"))),
  ]));
}

function treeSnapshot(root: string): Map<string, { size: number; mtimeMs: number; mode: number }> {
  const files = new Map<string, { size: number; mtimeMs: number; mode: number }>();
  const visit = (directory: string, prefix = "") => {
    for (const name of fs.readdirSync(directory).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      const absolute = path.join(directory, name);
      const stat = fs.lstatSync(absolute);
      files.set(relative, { size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode });
      if (stat.isDirectory()) visit(absolute, relative);
    }
  };
  visit(root);
  return files;
}

function installLegacyStore(workspaceId: string, files: Map<string, Buffer>): string {
  const currentRoot = getControlRequestsDir(workspaceId);
  const legacyRoot = path.join(stateDir, "control-mailbox", workspaceId);
  fs.mkdirSync(legacyRoot, { recursive: true });
  for (const directory of LEGACY_DIRS) fs.mkdirSync(path.join(legacyRoot, directory), { recursive: true });
  for (const [relative, contents] of files) {
    const destination = path.join(legacyRoot, ...relative.split("/"));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, contents);
  }
  fs.rmSync(currentRoot, { recursive: true, force: true });
  fs.rmSync(path.join(stateDir, "control-requests"), { recursive: true, force: true });
  return legacyRoot;
}

function writeLegacyJson(legacyRoot: string, relative: string, value: unknown): string {
  const file = path.join(legacyRoot, ...relative.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

function rehashObservation(observation: Record<string, unknown>): void {
  const state = {
    latest: observation.latest,
    lastDefinitive: observation.lastDefinitive,
    ...(observation.latestAcceptedAt !== undefined && observation.lastDefinitiveAcceptedAt !== undefined ? {
      latestAcceptedAt: observation.latestAcceptedAt,
      lastDefinitiveAcceptedAt: observation.lastDefinitiveAcceptedAt,
    } : {}),
  };
  observation.observationHash = sha256Hex(canonicalJson(state));
}

function installLegacyMixedFailure(
  workspaceId: string,
  localSessionId: string,
  taskId: string,
  markerVariant: "matching" | "failure-only" | "mismatched",
) {
  const request = observeCompletedComputerUseRequest(workspaceId, { localSessionId, taskId });
  const blockedResult = {
    kind: "BLOCKED" as const,
    payload: { reason: "Historical platform block", needs: ["Review the recorded response"] },
  };
  const observationPath = path.join(getControlRequestsDir(workspaceId), "observations", `${request.requestId}.json`);
  const observation = JSON.parse(fs.readFileSync(observationPath, "utf8")) as {
    latest: Record<string, unknown>;
    lastDefinitive: Record<string, unknown>;
    [key: string]: unknown;
  };
  const legacyFailure = { ...observation.lastDefinitive };
  delete legacyFailure.delivery;
  delete legacyFailure.completionEvidence;
  delete legacyFailure.terminalResult;
  legacyFailure.reason = "platform_blocked";
  legacyFailure.source = "platform_error";
  legacyFailure.terminalResult = blockedResult;
  observation.latest = legacyFailure;
  observation.lastDefinitive = legacyFailure;
  rehashObservation(observation);
  fs.writeFileSync(observationPath, JSON.stringify(observation));

  const cancelledPath = path.join(getControlRequestsDir(workspaceId), "cancelled", `${request.requestId}.json`);
  const cancelled = JSON.parse(fs.readFileSync(cancelledPath, "utf8")) as Record<string, unknown>;
  const hostFailure = { ...legacyFailure };
  delete hostFailure.terminalResult;
  cancelled.hostFailure = hostFailure;
  delete cancelled.hostObservedResult;
  if (markerVariant !== "failure-only") {
    cancelled.hostObservedResult = {
      provenance: "host_observed",
      observedAt: legacyFailure.observedAt,
      result: markerVariant === "matching"
        ? blockedResult
        : { kind: "BLOCKED", payload: { reason: "Different historical payload", needs: ["Reject mismatch"] } },
    };
  }
  fs.writeFileSync(cancelledPath, JSON.stringify(cancelled));

  const legacyRoot = installLegacyStore(workspaceId, snapshots(workspaceId, TERMINAL_FILES(request.requestId)));
  return { request, blockedResult, legacyFailure, legacyRoot };
}

beforeEach(() => {
  stateDir = isolateStateDir();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup(stateDir);
  delete process.env.C2C_STATE_DIR;
});

describe("legacy Computer Use request migration", () => {
  it("inspects a fresh state without creating the control request store", () => {
    const before = fs.readdirSync(stateDir).sort();
    expect(inspectActiveControlRequestStatus(WORKSPACE_A, "session-fresh-inspect")).toBeNull();
    expect(fs.readdirSync(stateDir).sort()).toEqual(before);
    expect(fs.existsSync(path.join(stateDir, "control-requests"))).toBe(false);
  });

  it("inspects a legacy pending Computer Use request read-only with exact session identity", () => {
    const request = openControlRequest(WORKSPACE_A, {
      localSessionId: "session-pending-inspect",
      taskId: "migration_pending_inspect",
      iteration: 2,
      phase: "REVIEW",
      surfaceGeneration: 4,
      surfaceTabId: "tab-pending-inspect",
    });
    const legacyRoot = installLegacyStore(WORKSPACE_A, snapshots(WORKSPACE_A, [
      `requests/${request.requestId}.json`,
      "active/session-pending-inspect.json",
    ]));
    const controlStoreParent = path.join(stateDir, "control-requests");
    expect(fs.existsSync(controlStoreParent)).toBe(false);
    const before = treeSnapshot(legacyRoot);
    const stateEntries = fs.readdirSync(stateDir).sort();

    expect(inspectActiveControlRequestStatus(WORKSPACE_A, "session-pending-inspect"))
      .toMatchObject({
        requestId: request.requestId,
        status: "pending",
        request: {
          requestId: request.requestId,
          localSessionId: "session-pending-inspect",
          taskId: "migration_pending_inspect",
          iteration: 2,
          phase: "REVIEW",
          surfaceGeneration: 4,
          surfaceTabId: "tab-pending-inspect",
        },
      });
    expect(inspectActiveControlRequestStatus(WORKSPACE_A, "session-another-inspect")).toBeNull();
    expect(treeSnapshot(legacyRoot)).toEqual(before);
    expect(fs.readdirSync(stateDir).sort()).toEqual(stateEntries);
    expect(fs.existsSync(controlStoreParent)).toBe(false);
  });

  it("preserves an expired legacy active request and late inspection guidance before and after migration", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const createdAt = Date.now();
    vi.setSystemTime(createdAt);
    const request = openControlRequest(WORKSPACE_A, {
      localSessionId: "session-expired-inspect",
      taskId: "migration_expired_inspect",
      iteration: 3,
      phase: "PLAN",
      surfaceGeneration: 7,
      surfaceTabId: "tab-expired-inspect",
      ttlMs: 1_000,
    });
    const expected = { taskId: "migration_expired_inspect", iteration: 3, phase: "PLAN" as const };
    vi.setSystemTime(createdAt + 1);
    observeControlRequest(WORKSPACE_A, request.requestId, "session-expired-inspect", expected, {
      tabId: "tab-expired-inspect",
      generation: 7,
      observedUrl: "https://chatgpt.com/c/migration-expired-inspect",
      observedAt: new Date().toISOString(),
      responseToRequestId: request.requestId,
      observationSequence: 1,
      state: "send_attempted",
    });
    vi.setSystemTime(createdAt + 2);
    observeControlRequest(WORKSPACE_A, request.requestId, "session-expired-inspect", expected, {
      tabId: "tab-expired-inspect",
      generation: 7,
      observedUrl: "https://chatgpt.com/c/migration-expired-inspect",
      observedAt: new Date().toISOString(),
      responseToRequestId: request.requestId,
      observationSequence: 2,
      state: "sent",
    });
    vi.setSystemTime(createdAt + 3);
    observeControlRequest(WORKSPACE_A, request.requestId, "session-expired-inspect", expected, {
      tabId: "tab-expired-inspect",
      generation: 7,
      observedUrl: "https://chatgpt.com/c/migration-expired-inspect",
      observedAt: new Date().toISOString(),
      responseToRequestId: request.requestId,
      observationSequence: 3,
      responseId: "response-expired-inspect",
      state: "response_created",
    });
    vi.setSystemTime(Date.parse(request.expiresAt) + 1);
    const lateObservation = {
      tabId: "tab-expired-inspect",
      generation: 7,
      observedUrl: "https://chatgpt.com/c/migration-expired-inspect",
      observedAt: new Date().toISOString(),
      responseToRequestId: request.requestId,
      observationSequence: 4,
      responseId: "response-expired-inspect",
      state: "final" as const,
      responseIsFinal: true as const,
      delivery: "computer_use" as const,
      terminalResult: {
        kind: "PLAN" as const,
        payload: {
          goal: "Inspect the late response",
          rationale: "The expired active pointer remains useful recovery evidence.",
          actions: [{ change: "Read the exact response", why: "Do not revive expired authority." }],
          tests: [],
          successCriteria: ["Keep the original request identity visible."],
        },
      },
      completionEvidence: { responseActionsVisible: true as const, stopControlAbsent: true as const },
    };
    expect(recordLateControlEvidence(
      WORKSPACE_A,
      request.requestId,
      "session-expired-inspect",
      expected,
      lateObservation,
    )).toMatchObject({ status: "expired", lateEvidence: lateObservation });

    const legacyRoot = installLegacyStore(WORKSPACE_A, snapshots(WORKSPACE_A, [
      `requests/${request.requestId}.json`,
      `observations/${request.requestId}.json`,
      "active/session-expired-inspect.json",
      `late-evidence/${request.requestId}.json`,
    ]));
    const before = treeSnapshot(legacyRoot);
    const stateEntries = fs.readdirSync(stateDir).sort();
    const inspectedBeforeMigration = inspectActiveControlRequestStatus(WORKSPACE_A, "session-expired-inspect");
    expect(inspectedBeforeMigration).toMatchObject({
      requestId: request.requestId,
      status: "expired",
      lateEvidence: lateObservation,
      request: { requestId: request.requestId, surfaceGeneration: 7, surfaceTabId: "tab-expired-inspect" },
    });
    expect(controlWaitPolicy(inspectedBeforeMigration!)).toMatchObject({
      state: "evidence_only",
      delivery: "none",
      nextAction: "review_late_evidence",
      result: null,
    });
    expect(inspectActiveControlRequestStatus(WORKSPACE_A, "session-expired-other")).toBeNull();
    expect(treeSnapshot(legacyRoot)).toEqual(before);
    expect(fs.readdirSync(stateDir).sort()).toEqual(stateEntries);
    expect(fs.existsSync(path.join(stateDir, "control-requests"))).toBe(false);

    const migrated = getControlRequestStatus(WORKSPACE_A, request.requestId, "session-expired-inspect", expected);
    expect(migrated).toMatchObject({ status: "expired", lateEvidence: lateObservation });
    expect(inspectActiveControlRequestStatus(WORKSPACE_A, "session-expired-inspect"))
      .toMatchObject({ requestId: request.requestId, status: "expired", lateEvidence: lateObservation });
    expect(controlWaitPolicy(migrated)).toMatchObject({ nextAction: "review_late_evidence", delivery: "none" });
    expect(fs.existsSync(legacyRoot)).toBe(true);
  });

  it("migrates complete Computer Use history and leaves callback-only requests not_found", () => {
    const computerUse = observeCompletedComputerUseRequest(WORKSPACE_A, {
      localSessionId: "session-computer-use",
      taskId: "migration_cu",
    });
    const callbackOnly = openControlRequest(WORKSPACE_A, {
      localSessionId: "session-callback",
      ...correlation(1),
    });
    const files = snapshots(WORKSPACE_A, [
      ...TERMINAL_FILES(computerUse.requestId),
      `requests/${callbackOnly.requestId}.json`,
    ]);
    const legacyRoot = installLegacyStore(WORKSPACE_A, files);
    for (const kind of ["results", "progress", "acks"]) {
      writeLegacyJson(legacyRoot, `${kind}/${callbackOnly.requestId}.json`, { legacy: kind });
    }

    expect(getControlRequestStatus(
      WORKSPACE_A,
      computerUse.requestId,
      "session-computer-use",
      { taskId: "migration_cu", iteration: 0, phase: "PLAN" },
    )).toMatchObject({
      status: "cancelled",
      request: {
        requestId: computerUse.requestId,
        surfaceGeneration: 1,
        surfaceTabId: "tab-session-computer-use",
      },
      hostObservedResult: { provenance: "host_observed", result: { kind: "PLAN" } },
      pageObservation: { lastDefinitive: { state: "final", delivery: "computer_use" } },
    });
    expect(getControlRequestStatus(
      WORKSPACE_A,
      callbackOnly.requestId,
      "session-callback",
      correlation(1),
    )).toMatchObject({ status: "not_found", request: null });
    expect(
      fs.existsSync(path.join(getControlRequestsDir(WORKSPACE_A), "cancelled", `${callbackOnly.requestId}.json`)),
    ).toBe(false);
    expect(clearLegacyControlMailbox(WORKSPACE_A)).toMatchObject({ removed: true });
    expect(fs.existsSync(legacyRoot)).toBe(false);
    expect(getControlRequestStatus(
      WORKSPACE_A,
      callbackOnly.requestId,
      "session-callback",
      correlation(1),
    )).toMatchObject({ status: "not_found", request: null });
  });

  it.each(["matching", "failure-only"] as const)(
    "migrates a historical mixed failure with a %s marker without treating it as delivered",
    async (markerVariant) => {
      const { request, blockedResult, legacyFailure, legacyRoot } = installLegacyMixedFailure(
        WORKSPACE_A,
        `session-legacy-mixed-${markerVariant}`,
        `migration_legacy_mixed_${markerVariant.replaceAll("-", "_")}`,
        markerVariant,
      );
      const expected = {
        taskId: request.taskId,
        iteration: request.iteration,
        phase: request.phase,
      };
      const status = getControlRequestStatus(WORKSPACE_A, request.requestId, request.localSessionId, expected);
      expect(status).toMatchObject({
        status: "cancelled",
        request: { requestId: request.requestId, surfaceGeneration: 1 },
        pageObservation: {
          latest: { state: "final", reason: "platform_blocked", terminalResult: blockedResult },
          lastDefinitive: { state: "final", reason: "platform_blocked", terminalResult: blockedResult },
        },
        hostFailure: { reason: "platform_blocked", source: "platform_error" },
      });
      expect(status.pageObservation?.lastDefinitive).not.toHaveProperty("delivery");
      expect(status.pageObservation?.lastDefinitive).not.toHaveProperty("completionEvidence");
      expect(status.hostObservedResult).toBeUndefined();

      const storeRoot = getControlRequestsDir(WORKSPACE_A);
      const storedMarker = JSON.parse(fs.readFileSync(
        path.join(storeRoot, "cancelled", `${request.requestId}.json`),
        "utf8",
      )) as Record<string, unknown>;
      if (markerVariant === "matching") {
        expect(storedMarker.hostObservedResult).toEqual({
          provenance: "host_observed",
          observedAt: legacyFailure.observedAt,
          result: blockedResult,
        });
      } else {
        expect(storedMarker.hostObservedResult).toBeUndefined();
      }
      const storedObservation = JSON.parse(fs.readFileSync(
        path.join(storeRoot, "observations", `${request.requestId}.json`),
        "utf8",
      )) as { latest: Record<string, unknown> };
      expect(storedObservation.latest.terminalResult).toEqual(blockedResult);

      const waited = await waitForControlRequest(
        WORKSPACE_A,
        request.requestId,
        1_000,
        request.localSessionId,
        expected,
      );
      expect(controlWaitPolicy(waited)).toMatchObject({
        outcome: "terminal",
        state: "failed",
        result: null,
        delivery: "none",
        nextAction: "stop",
      });
      expect(fs.existsSync(legacyRoot)).toBe(true);
    },
  );

  it("rejects a mismatched dual-record historical mixed failure", () => {
    const { legacyRoot } = installLegacyMixedFailure(
      WORKSPACE_A,
      "session-legacy-mixed-mismatch",
      "migration_legacy_mixed_mismatch",
      "mismatched",
    );
    expect(() => getControlRequestsDir(WORKSPACE_A))
      .toThrow(/legacy terminal marker does not match its Computer Use observation/);
    expect(fs.existsSync(legacyRoot)).toBe(true);
    expect(fs.existsSync(path.join(stateDir, "control-requests", WORKSPACE_A))).toBe(false);
  });

  it("excludes an unbound legacy BLOCKED record while migrating other valid Computer Use history", () => {
    const computerUse = observeCompletedComputerUseRequest(WORKSPACE_A, {
      localSessionId: "session-bound-history",
      taskId: "migration_bound_history",
    });
    const unbound = openControlRequest(WORKSPACE_A, {
      localSessionId: "session-legacy-unbound-blocked",
      taskId: "migration_unbound_blocked",
      iteration: 1,
      phase: "PLAN",
    });
    const legacyRequest: Record<string, unknown> = { ...unbound, schemaVersion: 1 };
    delete legacyRequest.surfaceTabId;
    delete legacyRequest.surfaceGeneration;
    const observedAt = new Date().toISOString();
    const oldBlockedFailure = {
      state: "blocked",
      reason: "platform_blocked",
      source: "platform_error",
      tabId: "tab-unbound-legacy-blocked",
      generation: 9,
      observedAt,
      observedUrl: "https://chatgpt.com/c/unbound-legacy-blocked",
      responseToRequestId: unbound.requestId,
      responseIsFinal: true,
    };
    const blockedResult = {
      kind: "BLOCKED",
      payload: { reason: "Unbound historical result", needs: ["Do not infer page identity"] },
    };
    const legacyCancelled = {
      schemaVersion: 1,
      requestId: unbound.requestId,
      workspaceId: WORKSPACE_A,
      localSessionId: unbound.localSessionId,
      taskId: unbound.taskId,
      iteration: unbound.iteration,
      phase: unbound.phase,
      cancelledAt: observedAt,
      hostFailure: oldBlockedFailure,
      hostObservedResult: { provenance: "host_observed", observedAt, result: blockedResult },
    };
    const files = snapshots(WORKSPACE_A, TERMINAL_FILES(computerUse.requestId));
    files.set(`requests/${unbound.requestId}.json`, Buffer.from(JSON.stringify(legacyRequest)));
    files.set(`cancelled/${unbound.requestId}.json`, Buffer.from(JSON.stringify(legacyCancelled)));
    const legacyRoot = installLegacyStore(WORKSPACE_A, files);
    expect(fs.existsSync(path.join(legacyRoot, "observations", `${unbound.requestId}.json`))).toBe(false);

    const expected = { taskId: "migration_bound_history", iteration: 0, phase: "PLAN" as const };
    expect(getControlRequestStatus(
      WORKSPACE_A,
      computerUse.requestId,
      computerUse.localSessionId,
      expected,
    )).toMatchObject({ status: "cancelled", request: { requestId: computerUse.requestId } });
    expect(getControlRequestStatus(
      WORKSPACE_A,
      unbound.requestId,
      unbound.localSessionId,
      { taskId: "migration_unbound_blocked", iteration: 1, phase: "PLAN" },
    )).toMatchObject({ status: "not_found", request: null });

    const storeRoot = getControlRequestsDir(WORKSPACE_A);
    expect(fs.existsSync(path.join(storeRoot, "requests", `${unbound.requestId}.json`))).toBe(false);
    const migration = JSON.parse(fs.readFileSync(path.join(storeRoot, "migration-v1.json"), "utf8")) as {
      sourceManifestSha256: string | null;
      migratedFiles: Array<{ path: string }>;
    };
    expect(migration.sourceManifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(migration.migratedFiles.map(({ path: relative }) => relative)).not.toContain(
      `requests/${unbound.requestId}.json`,
    );
    expect(fs.readFileSync(path.join(legacyRoot, "requests", `${unbound.requestId}.json`), "utf8"))
      .toBe(JSON.stringify(legacyRequest));

    const changedMarker = { ...legacyCancelled, cancelledAt: new Date(Date.parse(observedAt) + 1_000).toISOString() };
    fs.writeFileSync(
      path.join(legacyRoot, "cancelled", `${unbound.requestId}.json`),
      JSON.stringify(changedMarker),
    );
    expect(() => clearLegacyControlMailbox(WORKSPACE_A)).toThrow(/legacy control source changed/);
    expect(fs.existsSync(legacyRoot)).toBe(true);
  });

  it("still validates the schema of an unbound legacy request before excluding it", () => {
    const computerUse = observeCompletedComputerUseRequest(WORKSPACE_A, {
      localSessionId: "session-bound-schema-check",
      taskId: "migration_bound_schema_check",
    });
    const unbound = openControlRequest(WORKSPACE_A, {
      localSessionId: "session-unbound-schema-check",
      taskId: "migration_unbound_schema_check",
      iteration: 1,
      phase: "PLAN",
    });
    const invalidLegacyRequest: Record<string, unknown> = { ...unbound, schemaVersion: 1, unexpected: true };
    delete invalidLegacyRequest.surfaceTabId;
    delete invalidLegacyRequest.surfaceGeneration;
    const files = snapshots(WORKSPACE_A, TERMINAL_FILES(computerUse.requestId));
    files.set(`requests/${unbound.requestId}.json`, Buffer.from(JSON.stringify(invalidLegacyRequest)));
    const legacyRoot = installLegacyStore(WORKSPACE_A, files);

    expect(() => getControlRequestsDir(WORKSPACE_A)).toThrow(/stored request schema is invalid/);
    expect(fs.existsSync(legacyRoot)).toBe(true);
    expect(fs.existsSync(path.join(stateDir, "control-requests", WORKSPACE_A))).toBe(false);
  });

  it("keeps expired Computer Use terminal history through migration pruning and cleanup", () => {
    const thirtyDays = 30 * 24 * 60 * 60 * 1_000;
    const computerUse = observeCompletedComputerUseRequest(WORKSPACE_A, {
      localSessionId: "session-old-terminal",
      taskId: "migration_old",
      createdAt: Date.now() - thirtyDays,
    });
    const legacyRoot = installLegacyStore(WORKSPACE_A, snapshots(WORKSPACE_A, TERMINAL_FILES(computerUse.requestId)));
    const expected = { taskId: "migration_old", iteration: 0, phase: "PLAN" as const };

    expect(getControlRequestStatus(WORKSPACE_A, computerUse.requestId, "session-old-terminal", expected).status)
      .toBe("cancelled");
    expect(pruneControlRequests(WORKSPACE_A, Date.now())).toBe(0);
    expect(fs.existsSync(path.join(getControlRequestsDir(WORKSPACE_A), "cancelled", `${computerUse.requestId}.json`))).toBe(true);

    expect(clearLegacyControlMailbox(WORKSPACE_A)).toMatchObject({ removed: true, migratedRequestCount: 1 });
    expect(fs.existsSync(legacyRoot)).toBe(false);
    expect(getControlRequestStatus(WORKSPACE_A, computerUse.requestId, "session-old-terminal", expected).status)
      .toBe("cancelled");
  });

  it("allows open and prune after migration, then makes legacy cleanup idempotent", () => {
    const computerUse = observeCompletedComputerUseRequest(WORKSPACE_A, {
      localSessionId: "session-cleanup-history",
      taskId: "migration_cleanup",
    });
    const legacyRoot = installLegacyStore(WORKSPACE_A, snapshots(WORKSPACE_A, TERMINAL_FILES(computerUse.requestId)));
    const expected = { taskId: "migration_cleanup", iteration: 0, phase: "PLAN" as const };
    expect(getControlRequestStatus(WORKSPACE_A, computerUse.requestId, "session-cleanup-history", expected).status)
      .toBe("cancelled");

    const laterRequest = openControlRequest(WORKSPACE_A, {
      localSessionId: "session-after-migration",
      taskId: "migration_later",
      iteration: 1,
      phase: "PLAN",
    });
    cancelControlRequest(WORKSPACE_A, laterRequest.requestId, "session-after-migration", {
      taskId: "migration_later",
      iteration: 1,
      phase: "PLAN",
    });
    expect(pruneControlRequests(WORKSPACE_A, Date.now() + 8 * 24 * 60 * 60 * 1_000)).toBe(1);

    expect(clearLegacyControlMailbox(WORKSPACE_A)).toMatchObject({ removed: true, migratedRequestCount: 1 });
    expect(fs.existsSync(legacyRoot)).toBe(false);
    expect(clearLegacyControlMailbox(WORKSPACE_A)).toMatchObject({ removed: false, migratedRequestCount: 1 });
    expect(getControlRequestStatus(WORKSPACE_A, computerUse.requestId, "session-cleanup-history", expected).status)
      .toBe("cancelled");
  });

  it("resumes authorized cleanup after rename and partial deletion are interrupted", () => {
    const computerUse = observeCompletedComputerUseRequest(WORKSPACE_A, {
      localSessionId: "session-cleanup-resume",
      taskId: "migration_cleanup_resume",
    });
    const legacyRoot = installLegacyStore(WORKSPACE_A, snapshots(WORKSPACE_A, TERMINAL_FILES(computerUse.requestId)));
    const expected = { taskId: "migration_cleanup_resume", iteration: 0, phase: "PLAN" as const };
    expect(getControlRequestStatus(WORKSPACE_A, computerUse.requestId, "session-cleanup-resume", expected).status)
      .toBe("cancelled");

    const originalRemove = fs.rmSync.bind(fs);
    let interrupted = false;
    const removeSpy = vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
      const targetPath = path.resolve(String(target));
      if (
        !interrupted &&
        path.dirname(targetPath) === path.join(stateDir, "control-mailbox") &&
        /^\.migrationworkspacea\.retired-[a-f0-9]{32}$/.test(path.basename(targetPath))
      ) {
        interrupted = true;
        originalRemove(path.join(targetPath, "requests", `${computerUse.requestId}.json`));
        throw new Error("simulated interrupted recursive removal");
      }
      originalRemove(target, options);
    });
    try {
      expect(() => clearLegacyControlMailbox(WORKSPACE_A)).toThrow("simulated interrupted recursive removal");
    } finally {
      removeSpy.mockRestore();
    }

    const markerPath = path.join(getControlRequestsDir(WORKSPACE_A), "migration-v1.json");
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as {
      retirement: { id: string; phase: string } | null;
    };
    expect(interrupted).toBe(true);
    expect(fs.existsSync(legacyRoot)).toBe(false);
    expect(marker.retirement).toMatchObject({ phase: "deleting" });
    const retiredRoot = path.join(
      stateDir,
      "control-mailbox",
      `.${WORKSPACE_A}.retired-${marker.retirement!.id}`,
    );
    expect(fs.existsSync(path.join(retiredRoot, "requests", `${computerUse.requestId}.json`))).toBe(false);
    expect(fs.existsSync(path.join(retiredRoot, "observations", `${computerUse.requestId}.json`))).toBe(true);

    expect(clearLegacyControlMailbox(WORKSPACE_A)).toMatchObject({ removed: true, migratedRequestCount: 1 });
    expect(fs.existsSync(retiredRoot)).toBe(false);
    expect(getControlRequestStatus(WORKSPACE_A, computerUse.requestId, "session-cleanup-resume", expected).status)
      .toBe("cancelled");
  });

  it("refuses cleanup when the migrated legacy Computer Use terminal changes", () => {
    const computerUse = observeCompletedComputerUseRequest(WORKSPACE_A, {
      localSessionId: "session-terminal-change",
      taskId: "migration_changed",
    });
    const legacyRoot = installLegacyStore(WORKSPACE_A, snapshots(WORKSPACE_A, TERMINAL_FILES(computerUse.requestId)));
    const expected = { taskId: "migration_changed", iteration: 0, phase: "PLAN" as const };
    expect(getControlRequestStatus(WORKSPACE_A, computerUse.requestId, "session-terminal-change", expected).status)
      .toBe("cancelled");

    const terminalFile = path.join(legacyRoot, "cancelled", `${computerUse.requestId}.json`);
    const terminal = JSON.parse(fs.readFileSync(terminalFile, "utf8")) as { cancelledAt: string };
    terminal.cancelledAt = new Date(Date.parse(terminal.cancelledAt) + 1_000).toISOString();
    fs.writeFileSync(terminalFile, JSON.stringify(terminal));

    expect(() => clearLegacyControlMailbox(WORKSPACE_A)).toThrow(/legacy control source changed|migration manifest changed/);
    expect(fs.existsSync(legacyRoot)).toBe(true);
    expect(getControlRequestStatus(WORKSPACE_A, computerUse.requestId, "session-terminal-change", expected).status)
      .toBe("cancelled");
  });

  it("refuses cleanup if a new complete Computer Use terminal appears after migration", () => {
    const migrated = observeCompletedComputerUseRequest(WORKSPACE_A, {
      localSessionId: "session-first-terminal",
      taskId: "migration_first",
    });
    const added = observeCompletedComputerUseRequest(WORKSPACE_A, {
      localSessionId: "session-added-terminal",
      taskId: "migration_added",
      iteration: 1,
    });
    const addedFiles = snapshots(WORKSPACE_A, TERMINAL_FILES(added.requestId));
    const legacyRoot = installLegacyStore(WORKSPACE_A, snapshots(WORKSPACE_A, TERMINAL_FILES(migrated.requestId)));
    expect(getControlRequestStatus(
      WORKSPACE_A,
      migrated.requestId,
      "session-first-terminal",
      { taskId: "migration_first", iteration: 0, phase: "PLAN" },
    ).status).toBe("cancelled");

    for (const [relative, contents] of addedFiles) {
      const destination = path.join(legacyRoot, ...relative.split("/"));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, contents);
    }

    expect(() => clearLegacyControlMailbox(WORKSPACE_A)).toThrow(/legacy control source changed|migration manifest changed/);
    expect(fs.existsSync(path.join(legacyRoot, "requests", `${added.requestId}.json`))).toBe(true);
    expect(getControlRequestStatus(
      WORKSPACE_A,
      added.requestId,
      "session-added-terminal",
      { taskId: "migration_added", iteration: 1, phase: "PLAN" },
    )).toMatchObject({ status: "not_found", request: null });
  });

  it.each(["tabId", "generation"] as const)(
    "rejects a final Computer Use observation with mismatched %s despite a recomputed hash",
    (identityField) => {
      const valid = observeCompletedComputerUseRequest(WORKSPACE_B, {
        localSessionId: `session-valid-${identityField}`,
        taskId: `migration_valid_${identityField}`,
      });
      installLegacyStore(WORKSPACE_B, snapshots(WORKSPACE_B, TERMINAL_FILES(valid.requestId)));
      expect(getControlRequestStatus(
        WORKSPACE_B,
        valid.requestId,
        `session-valid-${identityField}`,
        { taskId: `migration_valid_${identityField}`, iteration: 0, phase: "PLAN" },
      )).toMatchObject({
        status: "cancelled",
        hostObservedResult: { provenance: "host_observed", result: { kind: "PLAN" } },
      });

      const request = observeCompletedComputerUseRequest(WORKSPACE_A, {
        localSessionId: `session-mismatched-${identityField}`,
        taskId: `migration_mismatched_${identityField}`,
      });
      const legacyRoot = installLegacyStore(WORKSPACE_A, snapshots(WORKSPACE_A, TERMINAL_FILES(request.requestId)));
      const observationFile = path.join(legacyRoot, "observations", `${request.requestId}.json`);
      const stored = JSON.parse(fs.readFileSync(observationFile, "utf8")) as {
        latest: Record<string, unknown>;
        lastDefinitive: Record<string, unknown>;
        observationHash: string;
        [key: string]: unknown;
      };
      const mismatchedValue = identityField === "tabId" ? "tab-another-request" : 2;
      stored.latest[identityField] = mismatchedValue;
      stored.lastDefinitive[identityField] = mismatchedValue;
      rehashObservation(stored);
      fs.writeFileSync(observationFile, JSON.stringify(stored));

      expect(() => getControlRequestsDir(WORKSPACE_A)).toThrow();
      expect(fs.existsSync(legacyRoot)).toBe(true);
      expect(fs.existsSync(path.join(stateDir, "control-requests", WORKSPACE_A))).toBe(false);
    },
  );

  it("keeps migration marker paths in codepoint order for punctuated session IDs", () => {
    const localSessionIds = ["session-a", "session.a", "session_a", "session_a1"];
    const requests = localSessionIds.map((localSessionId, index) => openControlRequest(WORKSPACE_A, {
      localSessionId,
      taskId: `migration_sorted_${index}`,
      iteration: index,
      phase: "PLAN",
      surfaceGeneration: 1,
      surfaceTabId: `tab-${index}`,
    }));
    const files = snapshots(WORKSPACE_A, requests.flatMap((request, index) => [
      `requests/${request.requestId}.json`,
      `active/${localSessionIds[index]}.json`,
    ]));
    installLegacyStore(WORKSPACE_A, files);

    const storeRoot = getControlRequestsDir(WORKSPACE_A);
    const marker = JSON.parse(fs.readFileSync(path.join(storeRoot, "migration-v1.json"), "utf8")) as {
      migratedFiles: Array<{ path: string }>;
    };
    const paths = marker.migratedFiles.map((file) => file.path);
    expect(paths).toEqual([...paths].sort());
    expect(() => getControlRequestsDir(WORKSPACE_A)).not.toThrow();
  });

  it("rejects cleanup while a migrated Computer Use request is live", () => {
    const request = openControlRequest(WORKSPACE_A, {
      localSessionId: "session-live-legacy",
      ...correlation(),
      surfaceGeneration: 1,
      surfaceTabId: "tab-session-live-legacy",
    });
    const legacyRoot = installLegacyStore(WORKSPACE_A, snapshots(WORKSPACE_A, [
      `requests/${request.requestId}.json`,
      "active/session-live-legacy.json",
    ]));

    expect(() => clearLegacyControlMailbox(WORKSPACE_A)).toThrow(/control request\(s\) are live/);
    expect(fs.existsSync(legacyRoot)).toBe(true);
    expect(getControlRequestStatus(WORKSPACE_A, request.requestId, "session-live-legacy", correlation()))
      .toMatchObject({ status: "pending", request: { requestId: request.requestId } });
  });

  it("clears only the exact workspace legacy root", () => {
    const a = observeCompletedComputerUseRequest(WORKSPACE_A, {
      localSessionId: "session-workspace-a",
      taskId: "migration_workspace_a",
    });
    const b = observeCompletedComputerUseRequest(WORKSPACE_B, {
      localSessionId: "session-workspace-b",
      taskId: "migration_workspace_b",
    });
    const filesA = snapshots(WORKSPACE_A, TERMINAL_FILES(a.requestId));
    const filesB = snapshots(WORKSPACE_B, TERMINAL_FILES(b.requestId));
    const legacyA = installLegacyStore(WORKSPACE_A, filesA);
    const legacyB = installLegacyStore(WORKSPACE_B, filesB);

    expect(clearLegacyControlMailbox(WORKSPACE_A).removed).toBe(true);
    expect(fs.existsSync(legacyA)).toBe(false);
    expect(fs.existsSync(legacyB)).toBe(true);
    expect(getControlRequestStatus(
      WORKSPACE_B,
      b.requestId,
      "session-workspace-b",
      { taskId: "migration_workspace_b", iteration: 0, phase: "PLAN" },
    ).status).toBe("cancelled");
  });

  it.each(["allowed kinds", "observation hash", "observation correlation"] as const)(
    "fails closed on an invalid legacy %s",
    (invalidPart) => {
      const request = observeCompletedComputerUseRequest(WORKSPACE_A, {
        localSessionId: `session-invalid-${invalidPart.replaceAll(" ", "-")}`,
        taskId: `migration_invalid_${invalidPart.replaceAll(" ", "_")}`,
      });
      const legacyRoot = installLegacyStore(WORKSPACE_A, snapshots(WORKSPACE_A, TERMINAL_FILES(request.requestId)));
      if (invalidPart === "allowed kinds") {
        const file = path.join(legacyRoot, "requests", `${request.requestId}.json`);
        const stored = JSON.parse(fs.readFileSync(file, "utf8")) as { allowedKinds: string[] };
        stored.allowedKinds = ["BLOCKED"];
        fs.writeFileSync(file, JSON.stringify(stored));
      } else {
        const file = path.join(legacyRoot, "observations", `${request.requestId}.json`);
        const stored = JSON.parse(fs.readFileSync(file, "utf8")) as {
          latest: Record<string, unknown>;
          observationHash: string;
        };
        if (invalidPart === "observation hash") {
          stored.observationHash = "0".repeat(64);
        } else {
          stored.latest = { ...stored.latest, responseToRequestId: "another_request" };
          const { observationHash: _oldHash, ...body } = stored;
          stored.observationHash = sha256Hex(canonicalJson({
            latest: body.latest,
            lastDefinitive: (body as { lastDefinitive?: unknown }).lastDefinitive,
            ...((body as { latestAcceptedAt?: unknown }).latestAcceptedAt !== undefined ? {
              latestAcceptedAt: (body as { latestAcceptedAt?: unknown }).latestAcceptedAt,
              lastDefinitiveAcceptedAt: (body as { lastDefinitiveAcceptedAt?: unknown }).lastDefinitiveAcceptedAt,
            } : {}),
          }));
        }
        fs.writeFileSync(file, JSON.stringify(stored));
      }

      expect(() => getControlRequestsDir(WORKSPACE_A)).toThrow(/allowed kinds|integrity hash|lifecycle/);
      expect(fs.existsSync(legacyRoot)).toBe(true);
      expect(fs.existsSync(path.join(stateDir, "control-requests", WORKSPACE_A))).toBe(false);
    },
  );

  it("rejects symlinks inside the legacy source without removing the target", () => {
    const request = observeCompletedComputerUseRequest(WORKSPACE_A, {
      localSessionId: "session-legacy-symlink",
      taskId: "migration_symlink",
    });
    const legacyRoot = installLegacyStore(WORKSPACE_A, snapshots(WORKSPACE_A, TERMINAL_FILES(request.requestId)));
    const outside = path.join(makeTmpDir("migration-outside"), "request.json");
    fs.writeFileSync(outside, fs.readFileSync(path.join(legacyRoot, "requests", `${request.requestId}.json`)));
    fs.rmSync(path.join(legacyRoot, "requests", `${request.requestId}.json`));
    fs.symlinkSync(outside, path.join(legacyRoot, "requests", `${request.requestId}.json`));

    expect(() => getControlRequestsDir(WORKSPACE_A)).toThrow(/symbolic link/);
    expect(fs.readFileSync(outside, "utf8")).toContain(request.requestId);
    expect(fs.existsSync(legacyRoot)).toBe(true);
  });
});

describe("control request state root paths", () => {
  it.each(["/tmp", "/var/tmp"])("accepts a system temporary-directory alias rooted at %s", (base) => {
    const aliasState = fs.mkdtempSync(path.join(base, "c2c-control-state-alias-"));
    try {
      process.env.C2C_STATE_DIR = aliasState;
      expect(openControlRequest(WORKSPACE_A, {
        localSessionId: "session-alias-root",
        ...correlation(),
      }).requestId).toMatch(/^[a-f0-9]{48}$/);
    } finally {
      cleanup(aliasState);
      process.env.C2C_STATE_DIR = stateDir;
    }
  });

  it("rejects symlinked control store and workspace roots", () => {
    const outsideRoot = makeTmpDir("control-root-symlink-target");
    const controlRoot = path.join(stateDir, "control-requests");
    fs.symlinkSync(outsideRoot, controlRoot, "dir");
    expect(() => getControlRequestsDir(WORKSPACE_A)).toThrow(/real directory|symbolic link/);
    expect(fs.readdirSync(outsideRoot)).toEqual([]);
    fs.rmSync(controlRoot);

    fs.mkdirSync(controlRoot);
    const outsideWorkspace = makeTmpDir("control-workspace-symlink-target");
    fs.symlinkSync(outsideWorkspace, path.join(controlRoot, WORKSPACE_A), "dir");
    expect(() => getControlRequestsDir(WORKSPACE_A)).toThrow(/real directory|symbolic link/);
    expect(fs.readdirSync(outsideWorkspace)).toEqual([]);
  });
});
