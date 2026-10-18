import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  getActiveControlRequestStatus, getControlRequestStatus, getControlRequestsDir,
  pruneControlRequests,
  observeControlRequest, openControlRequest, waitForControlRequest,
} from "../src/control/requests.js";
import {
  advanceControlPageObservation,
  CONTROL_PAGE_CHECK_INTERVAL_MS,
  controlWaitPolicy, parseControlPageObservation, parseStoredControlPageObservation, type ControlHostFailure,
} from "../src/control/wait-policy.js";
import {
  canonicalJson, MAX_CONTROL_RESULT_BYTES, sha256Hex, type ControlResultSubmission,
} from "../src/control/result-schema.js";
import { MachineGateway, requireCurrentTurnSurface } from "../src/gateway/machine-gateway.js";
import { readSession, updateSession } from "../src/session/state.js";
import { cleanup, isolateStateDir, makeTmpDir, projectSelection, receiveBootResult } from "./helpers.js";

const cleanups: string[] = [];
const correlation = { taskId: "terminal-test", iteration: 0, phase: "RESEARCH" as const };
const projectUrl = "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/project";

function fixture(
  session = "session-a",
  gateway = new MachineGateway({ surfaceValidator: requireCurrentTurnSurface }),
  turnCorrelation = correlation,
  createResponse = true,
) {
  const root = makeTmpDir("control-wait");
  cleanups.push(root);
  const identity = { ...gateway.registerWorkspace(root), localSessionId: session };
  const url = projectUrl.replace("/project", `/c/${session}`);
  const page = gateway.surfaceClaim(identity, {
    browserId: "iab", surfaceId: "chatgpt", tabId: `tab-${session}`, projectUrl,
    projectSelection: projectSelection(projectUrl), chatUrl: url,
  });
  gateway.surfaceCommit(identity, page, { bootRequestId: receiveBootResult(gateway, identity, page) });
  const { request } = gateway.openControlRequest(identity, turnCorrelation);
  const grant = gateway.issueTurn({
    ...identity, ...turnCorrelation, requestId: request.requestId, generation: page.generation,
    scopes: ["workspace.read"], compactionEpoch: 0,
  });
  const pageIdentity = {
    tabId: page.tabId,
    generation: page.generation,
    observedUrl: url,
    observedAt: new Date().toISOString(),
    responseToRequestId: request.requestId,
  };
  gateway.observeControlPage(identity, request.requestId, turnCorrelation, {
    ...pageIdentity, observationSequence: 1, state: "send_attempted",
  });
  gateway.observeControlPage(identity, request.requestId, turnCorrelation, {
    ...pageIdentity, observationSequence: 2, state: "sent",
  });
  if (createResponse) {
    gateway.observeControlPage(identity, request.requestId, turnCorrelation, {
      ...pageIdentity, observationSequence: 3, responseId: `response-${request.requestId}`,
      state: "response_created",
    });
  }
  const observation: ControlHostFailure = {
    ...pageIdentity, observationSequence: createResponse ? 4 : 3, responseId: `response-${request.requestId}`,
    state: "final", responseIsFinal: true, reason: "platform_blocked",
    source: "model_reported", errorCode: "SAFETY_CHECK_BLOCKED",
    completionEvidence,
  };
  return { gateway, identity, request, grant, observation, page, turnCorrelation };
}

function planSubmissionAtBytes(targetBytes: number): ControlResultSubmission {
  const submission = {
    kind: "PLAN" as const,
    payload: {
      goal: "g",
      rationale: "r",
      actions: Array.from({ length: 12 }, () => ({
        change: "c",
        why: "w",
        risks: ["r", "r", "r", "r"],
      })),
      tests: Array.from({ length: 12 }, () => "t"),
      successCriteria: Array.from({ length: 8 }, () => "s"),
    },
  };
  const slots: Array<{ get: () => string; set: (value: string) => void; max: number }> = [
    { get: () => submission.payload.goal, set: (value) => { submission.payload.goal = value; }, max: 600 },
    { get: () => submission.payload.rationale, set: (value) => { submission.payload.rationale = value; }, max: 2_000 },
  ];
  for (const action of submission.payload.actions) {
    slots.push(
      { get: () => action.change, set: (value) => { action.change = value; }, max: 600 },
      { get: () => action.why, set: (value) => { action.why = value; }, max: 600 },
    );
    action.risks.forEach((_, index) => slots.push({
      get: () => action.risks[index]!,
      set: (value) => { action.risks[index] = value; },
      max: 300,
    }));
  }
  submission.payload.tests.forEach((_, index) => slots.push({
    get: () => submission.payload.tests[index]!,
    set: (value) => { submission.payload.tests[index] = value; },
    max: 300,
  }));
  submission.payload.successCriteria.forEach((_, index) => slots.push({
    get: () => submission.payload.successCriteria[index]!,
    set: (value) => { submission.payload.successCriteria[index] = value; },
    max: 300,
  }));

  let remaining = targetBytes - Buffer.byteLength(canonicalJson(submission), "utf8");
  for (const slot of slots) {
    if (remaining <= 0) break;
    const added = Math.min(remaining, slot.max - slot.get().length);
    slot.set(`${slot.get()}${"x".repeat(added)}`);
    remaining -= added;
  }
  if (remaining !== 0) throw new Error(`unable to build a ${targetBytes}-byte PLAN result`);
  return submission;
}

function generatingObservation(f: ReturnType<typeof fixture>) {
  const { tabId, generation, observedUrl, responseToRequestId } = f.observation;
  const sequence = (f.gateway.getControlRequestStatus(
    f.identity,
    f.request.requestId,
    { taskId: f.request.taskId, iteration: f.request.iteration, phase: f.request.phase },
  ).pageObservation?.latest.observationSequence ?? 0) + 1;
  return {
    tabId, generation, observedUrl, responseToRequestId,
    observedAt: new Date().toISOString(), observationSequence: sequence,
    responseId: `response-${f.request.requestId}`, state: "generating" as const,
  };
}

const completionEvidence = { responseActionsVisible: true as const, stopControlAbsent: true as const };

function computerUseCandidate(f: ReturnType<typeof fixture>, terminalResult: ControlResultSubmission) {
  const status = f.gateway.getControlRequestStatus(f.identity, f.request.requestId, f.turnCorrelation);
  return {
    tabId: f.observation.tabId,
    generation: f.observation.generation,
    observedUrl: f.observation.observedUrl,
    observedAt: new Date().toISOString(),
    responseToRequestId: f.request.requestId,
    observationSequence: (status.pageObservation?.latest.observationSequence ?? 0) + 1,
    responseId: `response-${f.request.requestId}`,
    state: "result_candidate" as const,
    responseIsFinal: true as const,
    delivery: "computer_use" as const,
    terminalResult,
    completionEvidence,
  };
}

type HostFailureCompletionFields = Pick<Extract<ControlHostFailure, { state: "final" }>,
  "reason" | "source" | "tool" | "errorCode">;

function hostFailureCandidate(
  f: ReturnType<typeof fixture>,
  overrides: Partial<HostFailureCompletionFields> = {},
) {
  const status = f.gateway.getControlRequestStatus(f.identity, f.request.requestId, f.turnCorrelation);
  return {
    ...f.observation,
    ...overrides,
    observedAt: new Date().toISOString(),
    observationSequence: (status.pageObservation?.latest.observationSequence ?? 0) + 1,
    state: "result_candidate" as const,
    completionEvidence,
  };
}

function finalForHostFailureCandidate(candidate: ReturnType<typeof hostFailureCandidate>) {
  return {
    ...candidate,
    observedAt: new Date().toISOString(),
    observationSequence: candidate.observationSequence + 1,
    state: "final" as const,
  };
}

function completeHostFailure(
  f: ReturnType<typeof fixture>,
  overrides: Partial<HostFailureCompletionFields> = {},
) {
  if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ["Date"] });
  const acceptedAt = Date.now();
  const candidate = hostFailureCandidate(f, overrides);
  f.gateway.observeControlPage(f.identity, f.request.requestId, f.turnCorrelation, candidate);
  vi.setSystemTime(acceptedAt + 1_500);
  const final = finalForHostFailureCandidate(candidate);
  const status = f.gateway.observeControlPage(f.identity, f.request.requestId, f.turnCorrelation, final);
  return { candidate, final, status };
}

function finalForCandidate(candidate: ReturnType<typeof computerUseCandidate>) {
  return {
    ...candidate,
    observedAt: new Date().toISOString(),
    observationSequence: candidate.observationSequence + 1,
    state: "final" as const,
  };
}

function completeComputerUse(f: ReturnType<typeof fixture>, terminalResult: ControlResultSubmission) {
  if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ["Date"] });
  const acceptedAt = Date.now();
  const candidate = computerUseCandidate(f, terminalResult);
  f.gateway.observeControlPage(f.identity, f.request.requestId, f.turnCorrelation, candidate);
  vi.setSystemTime(acceptedAt + 1_500);
  const final = finalForCandidate(candidate);
  return {
    candidate,
    final,
    status: f.gateway.observeControlPage(
      f.identity,
      f.request.requestId,
      f.turnCorrelation,
      final,
    ),
  };
}

function writeLegacyPageObservation(f: ReturnType<typeof fixture>, observation: unknown) {
  const state = { latest: observation, lastDefinitive: observation };
  const stored = {
    schemaVersion: 1,
    requestId: f.request.requestId,
    workspaceId: f.identity.workspaceId,
    localSessionId: f.identity.localSessionId,
    ...state,
    observationHash: sha256Hex(canonicalJson(state)),
  };
  const file = path.join(getControlRequestsDir(f.identity.workspaceId), "observations", `${f.request.requestId}.json`);
  fs.writeFileSync(file, JSON.stringify(stored));
  return file;
}

beforeEach(() => { cleanups.push(isolateStateDir()); });
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  while (cleanups.length) cleanup(cleanups.pop()!);
  delete process.env.C2C_STATE_DIR;
});

describe("state-driven Computer Use request lifecycle", () => {
  it("does not leave a newly opened orphan request when page renewal fails", () => {
    const f = fixture();
    completeHostFailure(f);
    vi.spyOn(f.gateway, "surfaceRenew").mockImplementation(() => { throw new Error("injected renewal failure"); });
    expect(() => f.gateway.openControlRequest(f.identity, { ...correlation, iteration: 1 })).toThrow(/injected renewal failure/);
    expect(getActiveControlRequestStatus(f.identity.workspaceId, f.identity.localSessionId)).toBeNull();
  });

  it("normalizes opaque browser response locators consistently and rejects control characters", () => {
    const f = fixture("opaque-response", undefined, correlation, false);
    const first = parseControlPageObservation({ ...generatingObservation(f), responseId: "message:turn/123" });
    expect("responseId" in first && first.responseId).toMatch(/^response-[a-f0-9]{64}$/);
    expect(parseControlPageObservation(first)).toEqual(first);
    expect(() => parseControlPageObservation({ ...first, responseId: "bad\nlocator" })).toThrow(/invalid/);

    const rawCandidate = {
      ...generatingObservation(f),
      state: "result_candidate" as const,
      responseIsFinal: true as const,
      delivery: "computer_use" as const,
      terminalResult: { kind: "BLOCKED" as const, payload: { reason: "  normalized reason  ", needs: [" A need "] } },
      completionEvidence,
    };
    const candidate = parseControlPageObservation(rawCandidate);
    const final = parseControlPageObservation({
      ...rawCandidate,
      state: "final",
      observationSequence: rawCandidate.observationSequence + 1,
      observedAt: new Date(Date.parse(rawCandidate.observedAt) + 1).toISOString(),
    });
    expect(candidate.state).toBe("result_candidate");
    expect(final.state).toBe("final");
    if (candidate.state === "result_candidate" && final.state === "final" && "delivery" in final) {
      expect(final.terminalResult).toEqual(candidate.terminalResult);
      expect(candidate.terminalResult.payload).toMatchObject({ reason: "normalized reason", needs: ["A need"] });
    }
    expect(() => parseControlPageObservation({ ...rawCandidate, completionEvidence: { ...completionEvidence, stopControlAbsent: false } }))
      .toThrow(/invalid control page observation/);
  });
  it("rejects a direct final and accepts an already-completed paired response through the stability barrier", () => {
    const f = fixture("direct-final", undefined, correlation, false);
    const result = { kind: "BLOCKED" as const, payload: { reason: "Required evidence missing", needs: ["Supply the evidence"] } };
    const candidate = computerUseCandidate(f, result);
    expect(() => f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, finalForCandidate(candidate)))
      .toThrow(/exact response lifecycle/);
    const { status } = completeComputerUse(f, result);
    expect(controlWaitPolicy(status)).toMatchObject({ state: "blocked", delivery: "computer_use", result: { kind: "BLOCKED" } });
  });

  it("requires a fresh final UI sample and a gateway-measured 1500ms candidate window", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = fixture("stable-sample");
    const result = { kind: "BLOCKED" as const, payload: { reason: "Evidence missing", needs: ["Provide evidence"] } };
    const acceptedAt = new Date().toISOString();
    const first = advanceControlPageObservation(
      f.gateway.getControlRequestStatus(f.identity, f.request.requestId, correlation).pageObservation ?? null,
      computerUseCandidate(f, result),
      acceptedAt,
    );
    const candidate = first.state.latest;
    if (candidate.state !== "result_candidate") throw new Error("expected a result candidate");

    const sameUiSample = {
      ...candidate,
      state: "final" as const,
      observationSequence: candidate.observationSequence + 1,
    };
    expect(() => advanceControlPageObservation(first.state, sameUiSample,
      new Date(Date.parse(acceptedAt) + 1_500).toISOString())).toThrow(/newer UI observation/);

    const freshFinal = {
      ...sameUiSample,
      observedAt: new Date(Date.parse(candidate.observedAt) + 1).toISOString(),
    };
    expect(() => advanceControlPageObservation(first.state, freshFinal,
      new Date(Date.parse(acceptedAt) + 1_499).toISOString())).toThrow(/fresh stability recheck/);
    expect(advanceControlPageObservation(first.state, freshFinal,
      new Date(Date.parse(acceptedAt) + 1_500).toISOString()).terminal).toEqual(freshFinal);
  });

  it("requires candidate/final identity and result agreement, and resets the gate when generation resumes", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = fixture("candidate-identity");
    const result = { kind: "BLOCKED" as const, payload: { reason: "Missing evidence", needs: ["Provide it"] } };
    const acceptedAt = Date.now();
    const candidate = computerUseCandidate(f, result);
    const initial = f.gateway.getControlRequestStatus(f.identity, f.request.requestId, correlation).pageObservation ?? null;
    const candidateState = advanceControlPageObservation(initial, candidate, new Date(acceptedAt).toISOString()).state;
    const final = {
      ...candidate,
      state: "final" as const,
      observationSequence: candidate.observationSequence + 1,
      observedAt: new Date(acceptedAt + 1).toISOString(),
    };
    const changedResult = {
      ...final,
      terminalResult: { kind: "BLOCKED" as const, payload: { reason: "Different result", needs: ["Provide it"] } },
    };
    expect(() => advanceControlPageObservation(candidateState, changedResult, new Date(acceptedAt + 1_500).toISOString()))
      .toThrow(/exact completion candidate/);
    expect(() => advanceControlPageObservation(candidateState, { ...final, responseId: "replacement" },
      new Date(acceptedAt + 1_500).toISOString())).toThrow(/replacement response or URL/);
    expect(() => advanceControlPageObservation(candidateState, { ...final, observedUrl: `${projectUrl}/other` },
      new Date(acceptedAt + 1_500).toISOString())).toThrow(/replacement response or URL/);

    const { responseIsFinal: _responseIsFinal, delivery: _delivery, terminalResult: _terminalResult,
      completionEvidence: _completionEvidence, state: _candidateState, ...response } = candidate;
    const generating = {
      ...response,
      state: "generating" as const,
      observationSequence: candidate.observationSequence + 1,
      observedAt: new Date(acceptedAt + 100).toISOString(),
    };
    const generatingState = advanceControlPageObservation(candidateState, generating,
      new Date(acceptedAt + 100).toISOString()).state;
    expect(() => advanceControlPageObservation(generatingState, {
      ...final,
      observationSequence: generating.observationSequence + 1,
    }, new Date(acceptedAt + 1_700).toISOString())).toThrow(/exact response lifecycle/);
    const resumedCandidate = {
      ...candidate,
      observedAt: new Date(acceptedAt + 200).toISOString(),
      observationSequence: generating.observationSequence + 1,
    };
    const resumedState = advanceControlPageObservation(generatingState, resumedCandidate,
      new Date(acceptedAt + 200).toISOString()).state;
    const resumedFinal = {
      ...resumedCandidate,
      state: "final" as const,
      observedAt: new Date(acceptedAt + 1_701).toISOString(),
      observationSequence: resumedCandidate.observationSequence + 1,
    };
    expect(advanceControlPageObservation(resumedState, resumedFinal,
      new Date(acceptedAt + 1_700).toISOString()).terminal).toEqual(resumedFinal);
  });

  it("keeps candidate evidence isolated to its exact local session", () => {
    const f = fixture("candidate-session-a");
    const candidate = computerUseCandidate(f, {
      kind: "BLOCKED", payload: { reason: "Missing input", needs: ["Provide input"] },
    });
    f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, candidate);
    expect(() => f.gateway.getControlRequestStatus(
      { ...f.identity, localSessionId: "candidate-session-b" }, f.request.requestId, correlation,
    )).toThrow(/another local session/);
    expect(getActiveControlRequestStatus(f.identity.workspaceId, "candidate-session-b")).toBeNull();
  });

  it("renews an idle page before opening work, preserving its generation beyond the old expiry", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = fixture();
    completeHostFailure(f);
    vi.setSystemTime(Date.parse(f.page.leaseExpiresAt) - 10_000);
    const next = { ...correlation, iteration: 1 };
    const { request } = f.gateway.openControlRequest(f.identity, next);
    f.gateway.issueTurn({ ...f.identity, ...next, requestId: request.requestId, generation: f.page.generation,
      scopes: ["workspace.read"], compactionEpoch: 0 });
    const base = { tabId: f.page.tabId, generation: f.page.generation, observedUrl: f.page.chatUrl!,
      responseToRequestId: request.requestId, observedAt: new Date().toISOString() };
    f.gateway.observeControlPage(f.identity, request.requestId, next, { ...base, observationSequence: 1, state: "send_attempted" });
    f.gateway.observeControlPage(f.identity, request.requestId, next, { ...base, observationSequence: 2, state: "sent" });
    vi.setSystemTime(Date.now() + 11_000);
    const result = { kind: "BLOCKED" as const, payload: { reason: "Missing input", needs: ["Supply input"] } };
    const candidate = {
      ...base, observationSequence: 3, state: "result_candidate" as const, responseId: "idle-result",
      responseIsFinal: true as const, delivery: "computer_use" as const,
      terminalResult: result, completionEvidence,
    };
    f.gateway.observeControlPage(f.identity, request.requestId, next, candidate);
    vi.setSystemTime(Date.now() + 1_500);
    const status = f.gateway.observeControlPage(f.identity, request.requestId, next, {
      ...candidate, observedAt: new Date().toISOString(), observationSequence: 4, state: "final",
    });
    expect(controlWaitPolicy(status).delivery).toBe("computer_use");
    expect(f.gateway.surfaceGet(f.identity).lease?.generation).toBe(f.page.generation);
  });

  it("recovers an expired lease only on the same live request and exact saved route", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = fixture();
    f.gateway.surfaceRenew(f.identity, f.page, 1_000);
    vi.setSystemTime(Date.now() + 1_001);
    expect(() => f.gateway.surfaceClaim(f.identity, { ...f.page, tabId: "wrong-tab" })).toThrow(/Resolve the active/);
    const recovered = f.gateway.surfaceClaim(f.identity, { ...f.page });
    expect(recovered.generation).toBe(f.page.generation);
    expect(f.gateway.turnStatus(f.grant.token).status).not.toBe("revoked");
    expect(f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, generatingObservation(f)).status).toBe("pending");
  });

  it("keeps a late exact response as evidence without reviving its expired capability or delivering BOOT", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = fixture();
    const result = { kind: "BLOCKED" as const, payload: { reason: "Missing evidence", needs: ["Supply evidence"] } };
    const candidate = computerUseCandidate(f, result);
    f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, candidate);
    vi.setSystemTime(Date.parse(f.request.expiresAt) + 1);
    const observation = finalForCandidate(candidate);
    expect(() => f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, { ...observation, tabId: "wrong-tab" }))
      .toThrow(/exact prompt, page, response, and sequence/);
    const status = f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, observation);
    expect(status).toMatchObject({ status: "expired", lateEvidence: observation });
    expect(status.hostObservedResult).toBeUndefined();
    expect(controlWaitPolicy(status)).toMatchObject({ state: "evidence_only", delivery: "none", nextAction: "review_late_evidence", result: null });
    expect(f.gateway.turnStatus(f.grant.token).status).toBe("expired");
    vi.setSystemTime(Date.now() + 120_000);
    expect(f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, observation)).toEqual(status);
  });

  it("retains a first-seen late final as evidence without requiring a candidate or stable delivery window", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = fixture("late-first-seen");
    vi.setSystemTime(Date.parse(f.request.expiresAt) + 1);
    const candidateShape = computerUseCandidate(f, {
      kind: "BLOCKED", payload: { reason: "Missing evidence", needs: ["Supply evidence"] },
    });
    const final = {
      ...candidateShape,
      state: "final" as const,
      observedAt: new Date().toISOString(),
    };
    const status = f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, final);
    expect(status).toMatchObject({ status: "expired", lateEvidence: final });
    expect(status.hostObservedResult).toBeUndefined();
    expect(controlWaitPolicy(status)).toMatchObject({
      state: "evidence_only", delivery: "none", result: null, nextAction: "review_late_evidence",
    });
  });

  it("records a revoked request's late result without treating it as delivery or blocking the next task", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = fixture();
    const result = { kind: "BLOCKED" as const, payload: { reason: "Evidence missing", needs: ["Supply it"] } };
    const candidate = computerUseCandidate(f, result);
    f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, candidate);
    f.gateway.cancelTurn(f.grant.token);
    vi.setSystemTime(Date.now() + 1_500);
    const observation = finalForCandidate(candidate);
    const status = f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, observation);
    expect(status).toMatchObject({ status: "cancelled", hostFailure: { reason: "capability_invalid" }, lateEvidence: observation });
    expect(controlWaitPolicy(status)).toMatchObject({ state: "evidence_only", delivery: "none" });
    expect(f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, observation)).toEqual(status);
    expect(f.gateway.openControlRequest(f.identity, { ...correlation, iteration: 1 }).created).toBe(true);
  });

  it("returns before a short activity lease expires so the host can renew automatically", async () => {
    vi.useFakeTimers();
    const request = openControlRequest("workspace-a", { localSessionId: "session-a", ...correlation, ttlMs: 2_000 });
    const wait = waitForControlRequest("workspace-a", request.requestId, 30_000, "session-a", correlation);
    await vi.advanceTimersByTimeAsync(1_000);
    const status = await wait;
    expect(status.status).toBe("pending");
    expect(controlWaitPolicy(status)).toMatchObject({ leaseRemainingMs: 1_000, checkPageAfterMs: 500 });
  });

  it("bounds each wait slice without imposing a five-minute task deadline", async () => {
    vi.useFakeTimers();
    const request = openControlRequest("workspace-a", { localSessionId: "session-a", ...correlation });
    const read = () => getControlRequestStatus("workspace-a", request.requestId, "session-a", correlation);
    const first = controlWaitPolicy(read());
    const wait = waitForControlRequest("workspace-a", request.requestId, 600_000, "session-a", correlation);
    await vi.advanceTimersByTimeAsync(CONTROL_PAGE_CHECK_INTERVAL_MS);
    expect((await wait).status).toBe("pending");
    expect(controlWaitPolicy(read())).toMatchObject({
      leaseExpiresAt: first.leaseExpiresAt, leaseRemainingMs: 30 * 60_000 - CONTROL_PAGE_CHECK_INTERVAL_MS,
      nextAction: "mark_send_attempted",
    });
    vi.setSystemTime(Date.parse(request.createdAt) + 6 * 60_000);
    const nextWait = waitForControlRequest("workspace-a", request.requestId, 600_000, "session-a", correlation);
    await vi.advanceTimersByTimeAsync(CONTROL_PAGE_CHECK_INTERVAL_MS);
    const status = await nextWait;
    expect(status).toMatchObject({ status: "pending" });
    expect(controlWaitPolicy(status)).toMatchObject({ outcome: "pending", nextAction: "mark_send_attempted", elapsedMs: 6 * 60_000 + CONTROL_PAGE_CHECK_INTERVAL_MS });
    expect(getActiveControlRequestStatus("workspace-a", "session-a")?.requestId).toBe(request.requestId);
  });

  it("records a Computer Use refusal after more than five minutes", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = fixture();
    vi.setSystemTime(Date.parse(f.request.createdAt) + 6 * 60_000);
    const { status } = completeComputerUse(f, {
      kind: "BLOCKED",
      payload: { reason: "Cannot complete this request", needs: ["Clarify the permitted task"] },
    });
    expect(controlWaitPolicy(status)).toMatchObject({
      outcome: "blocked", delivery: "computer_use", nextAction: "stop",
    });
  });

  it("keeps the same request, capability and page alive for 90 minutes through observed activity", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = fixture();
    const otherIdentity = { ...f.identity, localSessionId: "session-b" };
    const other = f.gateway.openControlRequest(otherIdentity, correlation);
    const start = Date.parse(f.request.createdAt);
    for (let minute = 1; minute <= 90; minute++) {
      vi.setSystemTime(start + minute * 60_000);
      const status = f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, generatingObservation(f));
      expect(status).toMatchObject({ status: "pending", requestId: f.request.requestId, request: { createdAt: f.request.createdAt } });
      expect(controlWaitPolicy(status)).toMatchObject({ outcome: "pending", nextAction: "inspect_exact_response" });
    }
    expect(f.gateway.turnStatus(f.grant.token).binding).toEqual(f.grant.binding);
    expect(() => requireCurrentTurnSurface(f.grant.binding)).not.toThrow();
    expect(f.gateway.openControlRequest(f.identity, correlation)).toMatchObject({ created: false, request: { requestId: f.request.requestId } });
    expect(f.gateway.getControlRequestStatus(otherIdentity, other.request.requestId, correlation))
      .toMatchObject({ status: "expired", request: { expiresAt: other.request.expiresAt } });

    const completed = completeComputerUse(f, {
      kind: "BLOCKED",
      payload: { reason: "Unable to complete the research", needs: ["End this attempt and preserve completed work"] },
    });
    expect(completed.status).toMatchObject({
      status: "cancelled",
      requestId: f.request.requestId,
      hostObservedResult: { provenance: "host_observed", result: { kind: "BLOCKED" } },
    });
    expect(controlWaitPolicy(completed.status)).toMatchObject({ outcome: "blocked", delivery: "computer_use" });
  }, 120_000);

  it("does not extend authorization for unknown state or revive an expired request", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = fixture();
    vi.setSystemTime(Date.parse(f.request.createdAt) + 60_000);
    const { responseId: _responseId, ...unknownObservation } = generatingObservation(f);
    const unknown = f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, {
      ...unknownObservation,
      state: "unknown",
    });
    expect(unknown.request?.expiresAt).toBe(f.request.expiresAt);
    expect(f.gateway.turnStatus(f.grant.token).expiresAt).toBe(f.grant.expiresAt);
    vi.setSystemTime(Date.parse(f.request.createdAt) + 31 * 60_000);
    const expired = f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, generatingObservation(f));
    expect(expired.status).toBe("expired");
    expect(controlWaitPolicy(expired).nextAction).toBe("stop");
    expect(f.gateway.turnStatus(f.grant.token).status).toBe("expired");
  });

  it("uses the last definitive phase after an unknown observation", () => {
    const request = openControlRequest("workspace-a", {
      localSessionId: "session-unknown-stage",
      ...correlation,
    });
    const status = getControlRequestStatus(
      "workspace-a",
      request.requestId,
      "session-unknown-stage",
      correlation,
    );
    const base = {
      tabId: "tab-unknown-stage",
      generation: 1,
      observedUrl: "https://chatgpt.com/g/g-p-example/c/chat-example",
      observedAt: new Date().toISOString(),
      responseToRequestId: request.requestId,
    };
    const initialUnknown = advanceControlPageObservation(null, {
      ...base,
      observationSequence: 1,
      state: "unknown",
    }).state;
    expect(controlWaitPolicy({ ...status, pageObservation: initialUnknown }).nextAction)
      .toBe("mark_send_attempted");

    const sendAttempted = advanceControlPageObservation(null, {
      ...base,
      observationSequence: 1,
      state: "send_attempted",
    }).state;
    const unknownAfterAttempt = advanceControlPageObservation(sendAttempted, {
      ...base,
      observationSequence: 2,
      state: "unknown",
    }).state;
    expect(controlWaitPolicy({ ...status, pageObservation: unknownAfterAttempt }).nextAction)
      .toBe("confirm_send");

    const sent = advanceControlPageObservation(unknownAfterAttempt, {
      ...base,
      observationSequence: 3,
      state: "sent",
    }).state;
    const unknownAfterSent = advanceControlPageObservation(sent, {
      ...base,
      observationSequence: 4,
      state: "unknown",
    }).state;
    expect(controlWaitPolicy({ ...status, pageObservation: unknownAfterSent }).nextAction)
      .toBe("inspect_response_start");

    const responseCreated = advanceControlPageObservation(unknownAfterSent, {
      ...base,
      observationSequence: 5,
      responseId: "response-unknown-stage",
      state: "response_created",
    }).state;
    const unknownAfterResponse = advanceControlPageObservation(responseCreated, {
      ...base,
      observationSequence: 6,
      state: "unknown",
    }).state;
    expect(controlWaitPolicy({ ...status, pageObservation: unknownAfterResponse }).nextAction)
      .toBe("inspect_exact_response");
  });

  it("does not renew a revoked capability even when the page still generates", () => {
    const f = fixture();
    f.gateway.revokeTurn(f.grant.token);
    expect(() => f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, generatingObservation(f))).toThrow(/no unique live capability/);
    expect(f.gateway.getControlRequestStatus(f.identity, f.request.requestId, correlation).request?.expiresAt).toBe(f.request.expiresAt);
    expect(f.gateway.turnStatus(f.grant.token).status).toBe("revoked");
  });

  it("retains immutable request identity through renewal and prunes its sidecar with the request", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = fixture();
    const root = getControlRequestsDir(f.identity.workspaceId);
    const original = fs.readFileSync(path.join(root, "requests", `${f.request.requestId}.json`), "utf8");
    vi.setSystemTime(Date.parse(f.request.createdAt) + 60_000);
    f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, generatingObservation(f));
    expect(fs.readFileSync(path.join(root, "requests", `${f.request.requestId}.json`), "utf8")).toBe(original);
    const renewalPath = path.join(root, "renewals", `${f.request.requestId}.json`);
    const observationPath = path.join(root, "observations", `${f.request.requestId}.json`);
    expect(fs.existsSync(renewalPath)).toBe(true);
    expect(fs.existsSync(observationPath)).toBe(true);
    vi.setSystemTime(Date.parse(f.request.createdAt) + 8 * 24 * 60 * 60_000);
    expect(pruneControlRequests(f.identity.workspaceId)).toBe(2);
    expect(fs.existsSync(renewalPath)).toBe(false);
    expect(fs.existsSync(observationPath)).toBe(false);
  });

  it("rejects replay conflicts, out-of-order events, and replacement response identities", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = fixture();
    vi.setSystemTime(Date.parse(f.request.createdAt) + 1_000);
    const generating = generatingObservation(f);
    const first = f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, generating);
    const firstExpiry = first.request?.expiresAt;

    const replay = f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, generating);
    expect(replay.pageObservation?.latest).toEqual(generating);
    expect(replay.request?.expiresAt).toBe(firstExpiry);

    expect(() => f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, {
      ...generating,
      state: "final",
      responseIsFinal: true,
      reason: "result_invalid",
      source: "host_observed",
      completionEvidence,
    })).toThrow(/sequence conflicts/);
    expect(() => f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, {
      ...generating,
      observationSequence: generating.observationSequence - 1,
    })).toThrow(/stale or out of order/);
    expect(() => f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, {
      ...generating,
      observationSequence: generating.observationSequence + 1,
      responseId: "response-replacement",
    })).toThrow(/replacement response or URL/);
    expect(f.gateway.getControlRequestStatus(f.identity, f.request.requestId, correlation))
      .toMatchObject({ status: "pending", request: { expiresAt: firstExpiry } });
  });

  it("detects stored observation tampering", () => {
    const f = fixture();
    const observationPath = path.join(
      getControlRequestsDir(f.identity.workspaceId),
      "observations",
      `${f.request.requestId}.json`,
    );
    const stored = JSON.parse(fs.readFileSync(observationPath, "utf8")) as {
      latest: { observedAt: string };
      lastDefinitive: { observedAt: string };
    };
    const changedAt = new Date(Date.parse(stored.latest.observedAt) + 1).toISOString();
    stored.latest.observedAt = changedAt;
    stored.lastDefinitive.observedAt = changedAt;
    fs.writeFileSync(observationPath, JSON.stringify(stored));
    expect(() => f.gateway.getControlRequestStatus(f.identity, f.request.requestId, correlation))
      .toThrow(/observation integrity hash/);
  });

  it("reads and exactly replays historical final observations without completionEvidence", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = fixture("legacy-final-read");
    const { final } = completeComputerUse(f, {
      kind: "BLOCKED", payload: { reason: "Evidence missing", needs: ["Provide evidence"] },
    });
    const { completionEvidence: _completionEvidence, ...legacyFinal } = final;
    const file = writeLegacyPageObservation(f, legacyFinal);
    const activePath = path.join(getControlRequestsDir(f.identity.workspaceId), "active", `${f.identity.localSessionId}.json`);
    fs.mkdirSync(path.dirname(activePath), { recursive: true });
    fs.writeFileSync(activePath, JSON.stringify(f.request));

    expect(f.gateway.getControlRequestStatus(f.identity, f.request.requestId, correlation).pageObservation?.latest)
      .toEqual(legacyFinal);
    expect(parseStoredControlPageObservation(legacyFinal)).toEqual(legacyFinal);
    expect(() => parseControlPageObservation(legacyFinal)).toThrow(/invalid control page observation/);
    const replay = f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, legacyFinal);
    expect(replay.status).toBe("cancelled");
    expect(replay.hostObservedResult).toBeUndefined();
    expect(fs.existsSync(activePath)).toBe(false);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("keeps historical failure observations with terminalResult readable for audit", () => {
    const f = fixture("legacy-mixed-failure");
    const failure = completeHostFailure(f).status;
    const final = f.gateway.getControlRequestStatus(f.identity, f.request.requestId, correlation)
      .pageObservation?.lastDefinitive;
    if (!final || final.state !== "final") throw new Error("expected a stored failure final");
    const { completionEvidence: _completionEvidence, ...legacyFinal } = final;
    const mixed = {
      ...legacyFinal,
      terminalResult: {
        kind: "BLOCKED" as const,
        payload: { reason: "Historical mixed record", needs: ["Review the old record"] },
      },
    };
    writeLegacyPageObservation(f, mixed);
    const stored = f.gateway.getControlRequestStatus(f.identity, f.request.requestId, correlation);
    expect(stored.pageObservation?.latest).toMatchObject({
      state: "final", reason: "platform_blocked", terminalResult: { kind: "BLOCKED" },
    });
    expect(stored.hostFailure).toEqual(failure.hostFailure);
    expect(stored.hostObservedResult).toBeUndefined();
    expect(() => parseControlPageObservation(mixed)).toThrow(/invalid control page observation/);
    expect(f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, mixed).status).toBe("cancelled");
  });

  it("does not let a renewal mask tampering with the original request", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = fixture();
    vi.setSystemTime(Date.parse(f.request.createdAt) + 60_000);
    f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, generatingObservation(f));
    const originalPath = path.join(getControlRequestsDir(f.identity.workspaceId), "requests", `${f.request.requestId}.json`);
    fs.writeFileSync(originalPath, JSON.stringify({ ...f.request, expiresAt: new Date(Date.parse(f.request.expiresAt) - 1_000).toISOString() }));
    expect(() => f.gateway.getControlRequestStatus(f.identity, f.request.requestId, correlation)).toThrow(/renewal does not match/);
  });
});

describe("exact response terminal observations", () => {
  it("keeps a sent request pending until an explicit response-start failure is observed", () => {
    const f = fixture("session-no-response", new MachineGateway({ surfaceValidator: requireCurrentTurnSurface }), correlation, false);
    const otherIdentity = { ...f.identity, localSessionId: "session-no-response-other" };
    const other = f.gateway.openControlRequest(otherIdentity, correlation);
    const { tabId, generation, observedUrl, responseToRequestId } = f.observation;
    expect(controlWaitPolicy(
      f.gateway.getControlRequestStatus(f.identity, f.request.requestId, correlation),
    ).nextAction).toBe("inspect_response_start");
    const status = f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, {
      tabId,
      generation,
      observedUrl,
      observedAt: new Date().toISOString(),
      responseToRequestId,
      observationSequence: 3,
      state: "response_start_failed",
      reason: "response_start_failed",
      source: "host_observed",
      evidence: "explicit_response_error",
    });
    expect(status).toMatchObject({
      status: "cancelled",
      hostFailure: {
        state: "response_start_failed",
        reason: "response_start_failed",
        evidence: "explicit_response_error",
      },
    });
    expect(controlWaitPolicy(status)).toMatchObject({ outcome: "terminal", nextAction: "stop" });
    expect(f.gateway.turnStatus(f.grant.token).status).toBe("revoked");
    expect(f.gateway.getControlRequestStatus(otherIdentity, other.request.requestId, correlation).status).toBe("pending");
  });

  it.each(["page_lost", "authority_invalid"] as const)("automatically ends only the affected session for %s", (state) => {
    const f = fixture(`session-${state}`);
    const otherIdentity = { ...f.identity, localSessionId: `session-${state}-other` };
    const other = f.gateway.openControlRequest(otherIdentity, correlation);
    expect(f.gateway.surfaceRelease(f.identity, f.page)).toBe(true);
    if (state === "authority_invalid") f.gateway.revokeTurn(f.grant.token);
    const { tabId, generation, responseToRequestId } = f.observation;
    const terminal = state === "page_lost"
      ? {
          tabId,
          generation,
          observedAt: new Date().toISOString(),
          responseToRequestId,
          observationSequence: 4,
          state,
          reason: "page_lost" as const,
          source: "host_observed" as const,
        }
      : {
          tabId,
          generation,
          observedUrl: f.observation.observedUrl,
          observedAt: new Date().toISOString(),
          responseToRequestId,
          observationSequence: 4,
          state,
          reason: "capability_invalid" as const,
          source: "host_observed" as const,
          errorCode: "TOKEN_REVOKED" as const,
        };
    const status = f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, terminal);
    expect(status).toMatchObject({ status: "cancelled", hostFailure: { state } });
    expect(controlWaitPolicy(status)).toMatchObject({ outcome: "terminal", nextAction: "stop" });
    expect(f.gateway.turnStatus(f.grant.token).status).toBe("revoked");
    expect(f.gateway.getControlRequestStatus(otherIdentity, other.request.requestId, correlation).status).toBe("pending");
  });

  it("rejects authority-invalid evidence while the exact request still has live authority", () => {
    const f = fixture("session-authority-still-live");
    const { tabId, generation, observedUrl, responseToRequestId } = f.observation;
    expect(() => f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, {
      tabId,
      generation,
      observedUrl,
      observedAt: new Date().toISOString(),
      responseToRequestId,
      observationSequence: 4,
      state: "authority_invalid",
      reason: "capability_invalid",
      source: "host_observed",
      errorCode: "TOKEN_REVOKED",
    })).toThrow(/conflicts with a live capability/);
    expect(f.gateway.getControlRequestStatus(f.identity, f.request.requestId, correlation).status)
      .toBe("pending");
    expect(f.gateway.turnStatus(f.grant.token).status).toBe("issued");
  });

  it("ends a pending request on host-observed failure, preserving other sessions and checkpoints", async () => {
    const f = fixture();
    const otherIdentity = { ...f.identity, localSessionId: "session-b" };
    const other = f.gateway.openControlRequest(otherIdentity, correlation);
    updateSession(f.identity.workspaceId, f.identity.localSessionId, {
      taskId: correlation.taskId, iteration: 0,
      checkpoint: { protocolState: "EXECUTED_LOCAL", completedSubtasks: "Keep completed work" },
    });
    const waiter = f.gateway.waitForControlRequest(f.identity, f.request.requestId, 1_000, correlation);
    const { final, status } = completeHostFailure(f, { source: "host_observed" });
    expect(status).toMatchObject({ status: "cancelled", hostFailure: { source: "host_observed", reason: "platform_blocked" } });
    expect((await waiter).status).toBe("cancelled");
    expect(f.gateway.turnStatus(f.grant.token).status).toBe("revoked");
    expect(f.gateway.getControlRequestStatus(otherIdentity, other.request.requestId, correlation).status).toBe("pending");
    expect(readSession(f.identity.workspaceId, f.identity.localSessionId)?.checkpoint?.completedSubtasks).toBe("Keep completed work");
    expect(f.gateway.getControlRequestStatus(f.identity, f.request.requestId, correlation).hostFailure).toEqual(final);
  });

  it("rejects generating samples after an accepted host-observed result without changing it", () => {
    const f = fixture();
    const result = {
      kind: "BLOCKED" as const,
      payload: { reason: "Business request refused", needs: ["Change the request"] },
    };
    const { status } = completeComputerUse(f, result);
    expect(status).toMatchObject({
      status: "cancelled",
      hostObservedResult: { provenance: "host_observed", result },
    });
    expect(() => f.gateway.observeControlPage(
      f.identity, f.request.requestId, correlation, generatingObservation(f),
    )).toThrow(/exact response lifecycle/);
    expect(f.gateway.getControlRequestStatus(f.identity, f.request.requestId, correlation)).toEqual(status);
    expect(status.hostFailure).toBeUndefined();
  });

  it("requires page-dependent failure finals to pass the exact candidate barrier", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = fixture();
    const generating = generatingObservation(f);
    f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, generating);
    const candidate = hostFailureCandidate(f, {
      reason: "platform_blocked",
      source: "host_observed",
      errorCode: "UNKNOWN",
    });
    expect(() => parseControlPageObservation({
      ...candidate,
      reason: "callback_missing",
      tool: "submit_control_result",
    })).toThrow(/invalid control page observation/);
    const directFinal = finalForHostFailureCandidate(candidate);
    expect(() => f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, directFinal))
      .toThrow(/exact response lifecycle/);
    expect(f.gateway.getControlRequestStatus(f.identity, f.request.requestId, correlation).status).toBe("pending");

    const mixed = {
      ...candidate,
      terminalResult: {
        kind: "BLOCKED" as const,
        payload: { reason: "The final callback was unavailable", needs: ["End this attempt"] },
      },
    };
    expect(() => parseControlPageObservation(mixed)).toThrow(/invalid control page observation/);
    const acceptedCandidate = f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, candidate);
    expect(acceptedCandidate).toMatchObject({ status: "pending", pageObservation: { lastDefinitive: { state: "result_candidate" } } });
    expect(controlWaitPolicy(acceptedCandidate)).toMatchObject({ outcome: "pending", nextAction: "confirm_response_final" });

    const wrongResponse = { ...finalForHostFailureCandidate(candidate), responseId: "replacement-response" };
    expect(() => observeControlRequest(
      f.identity.workspaceId, f.request.requestId, f.identity.localSessionId, correlation, wrongResponse,
    )).toThrow(/replacement response or URL/);
    const earlyFinal = {
      ...finalForHostFailureCandidate(candidate),
      observedAt: new Date(Date.parse(candidate.observedAt) + 1).toISOString(),
    };
    expect(() => observeControlRequest(
      f.identity.workspaceId, f.request.requestId, f.identity.localSessionId, correlation, earlyFinal,
    )).toThrow(/fresh stability recheck/);
    expect(f.gateway.getControlRequestStatus(f.identity, f.request.requestId, correlation).status).toBe("pending");

    vi.setSystemTime(Date.now() + 1_500);
    const resumed = generatingObservation(f);
    f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, resumed);
    const oldCandidateFinal = {
      ...earlyFinal,
      observationSequence: resumed.observationSequence + 1,
      observedAt: new Date(Date.parse(resumed.observedAt) + 1).toISOString(),
    };
    expect(() => observeControlRequest(
      f.identity.workspaceId, f.request.requestId, f.identity.localSessionId, correlation, oldCandidateFinal,
    )).toThrow(/exact response lifecycle/);
    expect(f.gateway.getControlRequestStatus(f.identity, f.request.requestId, correlation).status).toBe("pending");

    const resumedCandidate = hostFailureCandidate(f, {
      reason: "platform_blocked",
      source: "host_observed",
      errorCode: "UNKNOWN",
    });
    f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, resumedCandidate);
    vi.setSystemTime(Date.now() + 1_500);
    const final = finalForHostFailureCandidate(resumedCandidate);
    const status = observeControlRequest(
      f.identity.workspaceId, f.request.requestId, f.identity.localSessionId, correlation, final,
    );
    expect(status).toMatchObject({
      status: "cancelled",
      hostFailure: { reason: "platform_blocked", source: "host_observed" },
    });
    expect(status.hostObservedResult).toBeUndefined();
    expect(controlWaitPolicy(status)).toMatchObject({ outcome: "terminal", nextAction: "stop", delivery: "none" });
  });

  it("accepts a verified Computer Use result as the active delivery path", () => {
    const planCorrelation = { taskId: "computer-use-plan", iteration: 0, phase: "PLAN" as const };
    const f = fixture(
      "session-computer-use",
      new MachineGateway({ surfaceValidator: requireCurrentTurnSurface }),
      planCorrelation,
    );
    const { status } = completeComputerUse(f, {
        kind: "PLAN",
        payload: {
          goal: "Compare Computer Use delivery",
          rationale: "The exact owned response contains a schema-valid result marker.",
          actions: [{ change: "Observe the bound response", why: "Avoid the MCP callback" }],
          tests: ["Verify exact response correlation"],
          successCriteria: ["The host reports Computer Use delivery"],
        },
    });
    expect(status).toMatchObject({
      status: "cancelled",
      hostObservedResult: { provenance: "host_observed", result: { kind: "PLAN" } },
    });
    expect(status.hostFailure).toBeUndefined();
    expect(controlWaitPolicy(status)).toMatchObject({
      outcome: "delivered",
      delivery: "computer_use",
      nextAction: "stop",
    });
    expect(f.gateway.turnStatus(f.grant.token).status).toBe("revoked");
  });

  it("accepts a host-observed result at the aggregate byte boundary", () => {
    const planCorrelation = { taskId: "terminal-size-test", iteration: 0, phase: "PLAN" as const };
    const boundary = fixture("session-boundary", new MachineGateway({ surfaceValidator: requireCurrentTurnSurface }), planCorrelation);
    const accepted = planSubmissionAtBytes(MAX_CONTROL_RESULT_BYTES);
    expect(Buffer.byteLength(canonicalJson(accepted), "utf8")).toBe(MAX_CONTROL_RESULT_BYTES);
    expect(completeComputerUse(boundary, accepted).status).toMatchObject({
      status: "cancelled",
      hostObservedResult: { result: { kind: "PLAN" } },
    });
  });

  it("rejects oversized host observations before changing request state", () => {
    const planCorrelation = { taskId: "terminal-size-test", iteration: 0, phase: "PLAN" as const };
    const f = fixture("session-oversized", new MachineGateway({ surfaceValidator: requireCurrentTurnSurface }), planCorrelation);
    const oversized = planSubmissionAtBytes(MAX_CONTROL_RESULT_BYTES + 1);
    const oversizedObservation = computerUseCandidate(f, oversized);
    expect(Buffer.byteLength(canonicalJson(oversized), "utf8")).toBe(MAX_CONTROL_RESULT_BYTES + 1);
    expect(() => parseControlPageObservation(oversizedObservation)).toThrow(/exceeds 16384 bytes/);
    expect(() => f.gateway.observeControlPage(
      f.identity, f.request.requestId, planCorrelation, oversizedObservation,
    )).toThrow(/exceeds 16384 bytes/);

    const multibyte = planSubmissionAtBytes(MAX_CONTROL_RESULT_BYTES);
    if (multibyte.kind !== "PLAN") throw new Error("expected PLAN fixture");
    multibyte.payload.goal = `${multibyte.payload.goal.slice(0, -1)}界`;
    expect(Buffer.byteLength(canonicalJson(multibyte), "utf8")).toBe(MAX_CONTROL_RESULT_BYTES + 2);
    expect(() => parseControlPageObservation(computerUseCandidate(f, multibyte)))
      .toThrow(/exceeds 16384 bytes/);

    const pending = f.gateway.getControlRequestStatus(f.identity, f.request.requestId, planCorrelation);
    expect(pending).toMatchObject({ status: "pending" });
    expect(pending.hostObservedResult).toBeUndefined();
    expect(getActiveControlRequestStatus(f.identity.workspaceId, f.identity.localSessionId)?.requestId)
      .toBe(f.request.requestId);
    expect(f.gateway.turnStatus(f.grant.token).status).toBe("issued");

    const completed = completeComputerUse(f, {
      kind: "PLAN",
      payload: {
        goal: "Complete after rejecting oversized host evidence",
        rationale: "The request and capability remained live",
        actions: [{ change: "Continue the original turn", why: "No lifecycle state was mutated" }],
        tests: ["Read the exact Computer Use response"],
        successCriteria: ["The real completion is received"],
      },
    });
    expect(completed.status).toMatchObject({
      status: "cancelled",
      hostObservedResult: { provenance: "host_observed", result: { kind: "PLAN" } },
    });
  });

  it("rejects a host-observed kind that the request phase does not allow", () => {
    const f = fixture();
    expect(() => f.gateway.observeControlPage(f.identity, f.request.requestId, correlation,
      computerUseCandidate(f, {
        kind: "PLAN",
        payload: {
          goal: "Wrong phase", rationale: "RESEARCH cannot accept PLAN",
          actions: [{ change: "Do nothing", why: "The phase is wrong" }], tests: [],
          successCriteria: ["The observation is rejected"],
        },
      }))).toThrow(/not allowed/i);
    expect(f.gateway.getControlRequestStatus(f.identity, f.request.requestId, correlation))
      .toMatchObject({ status: "pending" });
  });

  it("does not allow a late generating observation to replace a verified Computer Use final", () => {
    const f = fixture();
    const { status } = completeComputerUse(f, {
      kind: "BLOCKED",
      payload: { reason: "The business task was refused", needs: ["End this attempt"] },
    });
    expect(() => f.gateway.observeControlPage(
      f.identity, f.request.requestId, correlation, generatingObservation(f),
    )).toThrow(/exact response lifecycle/);
    expect(f.gateway.getControlRequestStatus(f.identity, f.request.requestId, correlation)).toEqual(status);
  });

  it.each(["generating", "unknown"] as const)("does not infer refusal from %s or a quotation of historical BLOCKED text", (state) => {
    const f = fixture();
    const generated = generatingObservation(f);
    const { responseId, ...withoutResponse } = generated;
    const observation = state === "generating"
      ? generated
      : { ...withoutResponse, state: "unknown" as const };
    expect(f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, observation).status).toBe("pending");
    expect(() => parseControlPageObservation({ ...observation, excerpt: "The previous answer said BLOCKED" })).toThrow(/raw page text/);
  });

  it.each([
    { tabId: "another-tab" }, { generation: 99 }, { responseToRequestId: "old-request" },
    { observedUrl: projectUrl.replace("/project", "/c/another-chat") },
    { observedAt: "2000-01-01T00:00:00.000Z" }, { observedAt: "2099-01-01T00:00:00.000Z" },
  ])("rejects stale or unrelated evidence %j", (change) => {
    const f = fixture();
    expect(() => f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, { ...f.observation, ...change })).toThrow(/observation does not match/);
    expect(f.gateway.getControlRequestStatus(f.identity, f.request.requestId, correlation).status).toBe("pending");
  });

  it("does not accept unfinished response evidence or leak arbitrary diagnostic text", () => {
    const f = fixture();
    for (const change of [
      { responseIsFinal: false }, { errorCode: "sk-secret-fixture" }, { excerpt: "c2c_ctx_secret_fixture" },
    ]) {
      try { parseControlPageObservation({ ...f.observation, ...change }); throw new Error("expected rejection"); }
      catch (error) {
        expect(String(error)).toContain("invalid control page observation");
        expect(String(error)).not.toMatch(/sk-secret|c2c_ctx_secret/);
      }
    }
    expect(() => f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, {
      ...f.observation, observedUrl: `${f.observation.observedUrl}?token=sk-secret-fixture`,
    })).toThrow(/observation does not match/);
    expect(f.gateway.getControlRequestStatus(f.identity, f.request.requestId, correlation).hostFailure).toBeUndefined();
  });
});
