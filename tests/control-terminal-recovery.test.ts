import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const observationWriteFault = vi.hoisted(() => ({ failOnce: false }));

vi.mock("../src/config/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config/paths.js")>();
  return {
    ...actual,
    writeSecureJson(file: string, data: unknown): void {
      if (
        observationWriteFault.failOnce &&
        file.includes(`${path.sep}control-requests${path.sep}`) &&
        file.includes(`${path.sep}observations${path.sep}`)
      ) {
        observationWriteFault.failOnce = false;
        throw new Error("injected observation write failure");
      }
      actual.writeSecureJson(file, data);
    },
  };
});

import { getActiveControlRequestStatus, getControlRequestsDir } from "../src/control/requests.js";
import { controlWaitPolicy } from "../src/control/wait-policy.js";
import { MachineGateway, requireCurrentTurnSurface } from "../src/gateway/machine-gateway.js";
import { cleanup, isolateStateDir, makeTmpDir, projectSelection, receiveBootResult } from "./helpers.js";

const cleanups: string[] = [];
const projectUrl = "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/project";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  observationWriteFault.failOnce = false;
  while (cleanups.length > 0) cleanup(cleanups.pop()!);
  delete process.env.C2C_STATE_DIR;
});

describe("terminal observation recovery", () => {
  it.each([
    {
      kind: "REVIEW",
      payload: {
        summary: "Review complete",
        findings: [{ severity: "low", issue: "No blocking findings", recommendation: "Keep the verified behavior" }],
        actions: [{ change: "Keep the verified behavior", why: "The focused review found no blocker" }],
        successCriteria: ["The final response is stable"],
      },
    },
    {
      kind: "DONE",
      payload: {
        summary: "Task complete",
        verification: ["Focused checks passed"],
      },
    },
  ] as const)("continues to deliver normal $kind Computer Use results", ({ kind, payload }) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    cleanups.push(isolateStateDir());
    const root = makeTmpDir(`normal-${kind.toLowerCase()}-terminal`);
    cleanups.push(root);
    const gateway = new MachineGateway({ surfaceValidator: requireCurrentTurnSurface });
    const identity = { ...gateway.registerWorkspace(root), localSessionId: `session-normal-${kind.toLowerCase()}` };
    const chatUrl = projectUrl.replace("/project", `/c/normal-${kind.toLowerCase()}`);
    const page = gateway.surfaceClaim(identity, {
      browserId: "iab",
      surfaceId: "chatgpt",
      tabId: `tab-normal-${kind.toLowerCase()}`,
      projectUrl,
      chatUrl,
      projectSelection: projectSelection(projectUrl),
    });
    gateway.surfaceCommit(identity, page, {
      bootRequestId: receiveBootResult(gateway, identity, page),
      connectorName: "Codex with ChatGPT",
    });

    const turn = { taskId: `normal-${kind.toLowerCase()}`, iteration: 0, phase: "REVIEW" as const };
    const { request } = gateway.openControlRequest(identity, turn);
    const grant = gateway.issueTurn({
      ...identity,
      ...turn,
      requestId: request.requestId,
      scopes: ["workspace.read"],
      compactionEpoch: 0,
      generation: page.generation,
    });
    const base = {
      tabId: page.tabId,
      generation: page.generation,
      observedUrl: chatUrl,
      observedAt: new Date().toISOString(),
      responseToRequestId: request.requestId,
    };
    const observe = (input: Record<string, unknown>) =>
      gateway.observeControlPage(identity, request.requestId, turn, input);
    observe({ ...base, observationSequence: 1, state: "send_attempted" });
    observe({ ...base, observationSequence: 2, state: "sent" });
    const responseBase = { ...base, responseId: `response-normal-${kind.toLowerCase()}` };
    observe({ ...responseBase, observationSequence: 3, state: "response_created" });
    const result = { kind, payload };
    const completionEvidence = { responseActionsVisible: true, stopControlAbsent: true };
    const candidate = {
      ...responseBase,
      observationSequence: 4,
      state: "result_candidate",
      responseIsFinal: true,
      delivery: "computer_use",
      terminalResult: result,
      completionEvidence,
    };
    observe(candidate);
    vi.setSystemTime(Date.now() + 1_500);
    const final = observe({
      ...candidate,
      observedAt: new Date().toISOString(),
      observationSequence: 5,
      state: "final",
    });

    expect(final).toMatchObject({
      status: "cancelled",
      hostObservedResult: { provenance: "host_observed", result },
      pageObservation: { lastDefinitive: { state: "final", terminalResult: result } },
    });
    expect(controlWaitPolicy(final)).toMatchObject({ outcome: "delivered", result, delivery: "computer_use" });
    expect(gateway.turnStatus(grant.token).status).toBe("revoked");
  });

  it("recovers a BOOT success marker only after its exact final observation is persisted", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    cleanups.push(isolateStateDir());
    const root = makeTmpDir("boot-success-marker-recovery");
    cleanups.push(root);
    const gateway = new MachineGateway({ surfaceValidator: requireCurrentTurnSurface });
    const identity = { ...gateway.registerWorkspace(root), localSessionId: "session-boot-success-recovery" };
    const page = gateway.surfaceClaim(identity, {
      browserId: "iab",
      surfaceId: "chatgpt",
      tabId: "tab-boot-success-recovery",
      projectUrl,
      chatUrl: projectUrl.replace("/project", "/c/boot-success-recovery"),
      projectSelection: projectSelection(projectUrl),
    });
    const otherIdentity = { ...identity, localSessionId: "session-boot-success-recovery-other" };
    const otherRequest = gateway.openControlRequest(otherIdentity, {
      taskId: "other-session-boot-recovery",
      iteration: 0,
      phase: "RESEARCH",
    });
    const turn = { taskId: `boot-${page.generation}`, iteration: 0, phase: "BOOT" as const };
    const { request } = gateway.openControlRequest(identity, turn);
    const grant = gateway.issueTurn({
      ...identity,
      ...turn,
      requestId: request.requestId,
      scopes: ["workspace.read"],
      compactionEpoch: 0,
      generation: page.generation,
    });
    const chatUrl = projectUrl.replace("/project", "/c/boot-success-recovery");
    const base = {
      tabId: page.tabId,
      generation: page.generation,
      observedAt: new Date().toISOString(),
      responseToRequestId: request.requestId,
    };
    const observe = (input: Record<string, unknown>) =>
      gateway.observeControlPage(identity, request.requestId, turn, input);
    observe({ ...base, observedUrl: projectUrl, observationSequence: 1, state: "send_attempted" });
    observe({ ...base, observedUrl: projectUrl, observationSequence: 2, state: "sent" });
    const responseBase = {
      ...base,
      observedUrl: chatUrl,
      responseId: "response-boot-success-recovery",
    };
    observe({ ...responseBase, observationSequence: 3, state: "response_created" });
    const result = { kind: "BOOT" as const, payload: {} };
    const completionEvidence = { responseActionsVisible: true as const, stopControlAbsent: true as const };
    const candidate = {
      ...responseBase,
      observationSequence: 4,
      state: "result_candidate" as const,
      responseIsFinal: true as const,
      delivery: "computer_use" as const,
      terminalResult: result,
      completionEvidence,
    };
    observe(candidate);
    vi.setSystemTime(Date.now() + 1_500);
    const final = {
      ...candidate,
      observedAt: new Date().toISOString(),
      observationSequence: 5,
      state: "final" as const,
    };

    observationWriteFault.failOnce = true;
    expect(() => observe(final)).toThrow(/injected observation write failure/);
    expect(gateway.turnStatus(grant.token).status).toBe("revoked");
    expect(() => gateway.claimTurn(grant.token, ["workspace.read"])).toThrow(/revoked/i);
    const interrupted = getActiveControlRequestStatus(identity.workspaceId, identity.localSessionId);
    expect(interrupted).toMatchObject({
      status: "cancelled",
      requestId: request.requestId,
      pageObservation: { lastDefinitive: { state: "result_candidate" } },
    });
    expect(interrupted?.hostObservedResult).toBeUndefined();

    const oldFinal = { ...final } as Record<string, unknown>;
    delete oldFinal.completionEvidence;
    expect(() => observe(oldFinal)).toThrow(/invalid control page observation/);
    expect(gateway.getControlRequestStatus(identity, request.requestId, turn).hostObservedResult).toBeUndefined();
    expect(() => observe({ ...final, responseToRequestId: "another-request" }))
      .toThrow(/does not match the interrupted Computer Use request/);
    expect(() => observe({ ...final, responseId: "another-response" }))
      .toThrow(/replacement response/);
    expect(() => observe({
      ...final,
      terminalResult: { kind: "BLOCKED", payload: { reason: "Different result", needs: ["Reject mismatch"] } },
    })).toThrow(/exact completion candidate/);
    expect(() => observe({
      ...final,
      observedAt: new Date(Date.parse(final.observedAt) + 1).toISOString(),
    })).toThrow(/does not match the interrupted Computer Use result/);
    expect(gateway.getControlRequestStatus(identity, request.requestId, turn).hostObservedResult).toBeUndefined();
    expect(() => gateway.observeControlPage(otherIdentity, request.requestId, turn, final))
      .toThrow(/another local session/);

    const restartedGateway = new MachineGateway({ surfaceValidator: requireCurrentTurnSurface });
    const restartedIdentity = {
      ...restartedGateway.registerWorkspace(root),
      localSessionId: identity.localSessionId,
    };
    const recovered = restartedGateway.observeControlPage(restartedIdentity, request.requestId, turn, final);
    expect(recovered).toMatchObject({
      status: "cancelled",
      requestId: request.requestId,
      hostObservedResult: { provenance: "host_observed", observedAt: final.observedAt, result },
      pageObservation: { lastDefinitive: final },
    });
    expect(controlWaitPolicy(recovered)).toMatchObject({ outcome: "delivered", result, delivery: "computer_use" });
    expect(getActiveControlRequestStatus(identity.workspaceId, identity.localSessionId)).toBeNull();
    expect(getActiveControlRequestStatus(identity.workspaceId, otherIdentity.localSessionId))
      .toMatchObject({ status: "pending", requestId: otherRequest.request.requestId });
    expect(restartedGateway.surfaceCommit(restartedIdentity, page, {
      bootRequestId: request.requestId,
      connectorName: "Codex with ChatGPT",
    })).toMatchObject({ binding: { chatUrl } });
  });

  it("revokes authority immediately and repairs cleanup after partial terminal writes", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    cleanups.push(isolateStateDir());
    const root = makeTmpDir("terminal-observation-recovery");
    cleanups.push(root);
    const gateway = new MachineGateway({ surfaceValidator: requireCurrentTurnSurface });
    const identity = { ...gateway.registerWorkspace(root), localSessionId: "session-terminal-recovery" };
    const chatUrl = projectUrl.replace("/project", "/c/terminal-recovery");
    const page = gateway.surfaceClaim(identity, {
      browserId: "iab",
      surfaceId: "chatgpt",
      tabId: "tab-terminal-recovery",
      projectUrl,
      chatUrl,
      projectSelection: projectSelection(projectUrl),
    });
    gateway.surfaceCommit(identity, page, {
      bootRequestId: receiveBootResult(gateway, identity, page),
      connectorName: "Codex with ChatGPT",
    });

    const turn = { taskId: "terminal-recovery", iteration: 0, phase: "REVIEW" as const };
    const { request } = gateway.openControlRequest(identity, turn);
    const grant = gateway.issueTurn({
      ...identity,
      ...turn,
      requestId: request.requestId,
      scopes: ["workspace.read"],
      compactionEpoch: 0,
      generation: page.generation,
    });
    const base = {
      tabId: page.tabId,
      generation: page.generation,
      observedUrl: chatUrl,
      observedAt: new Date().toISOString(),
      responseToRequestId: request.requestId,
    };
    gateway.observeControlPage(identity, request.requestId, turn, {
      ...base,
      observationSequence: 1,
      state: "send_attempted",
    });
    gateway.observeControlPage(identity, request.requestId, turn, {
      ...base,
      observationSequence: 2,
      state: "sent",
    });
    gateway.observeControlPage(identity, request.requestId, turn, {
      ...base,
      observationSequence: 3,
      responseId: "response-terminal-recovery",
      state: "response_created",
    });
    const failureCandidate = {
      ...base,
      observationSequence: 4,
      responseId: "response-terminal-recovery",
      state: "result_candidate" as const,
      responseIsFinal: true as const,
      reason: "platform_blocked" as const,
      source: "host_observed" as const,
      errorCode: "UNKNOWN" as const,
      completionEvidence: { responseActionsVisible: true as const, stopControlAbsent: true as const },
    };
    expect(gateway.observeControlPage(identity, request.requestId, turn, failureCandidate))
      .toMatchObject({ status: "pending" });
    vi.setSystemTime(Date.now() + 1_500);
    const terminal = {
      ...failureCandidate,
      observedAt: new Date().toISOString(),
      observationSequence: 5,
      state: "final" as const,
    };

    observationWriteFault.failOnce = true;
    expect(() => gateway.observeControlPage(identity, request.requestId, turn, terminal))
      .toThrow(/injected observation write failure/);
    expect(gateway.turnStatus(grant.token).status).toBe("revoked");
    expect(() => gateway.claimTurn(grant.token, ["workspace.read"])).toThrow(/revoked/i);
    expect(getActiveControlRequestStatus(identity.workspaceId, identity.localSessionId))
      .toMatchObject({ status: "cancelled", requestId: request.requestId });

    const delayedNow = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    const restartedGateway = new MachineGateway({ surfaceValidator: requireCurrentTurnSurface });
    const restartedIdentity = {
      ...restartedGateway.registerWorkspace(root),
      localSessionId: identity.localSessionId,
    };
    expect(restartedGateway.observeControlPage(restartedIdentity, request.requestId, turn, terminal))
      .toMatchObject({ status: "cancelled", pageObservation: { latest: terminal } });
    delayedNow.mockRestore();
    expect(getActiveControlRequestStatus(identity.workspaceId, identity.localSessionId)).toBeNull();

    expect(restartedGateway.observeControlPage(restartedIdentity, request.requestId, turn, terminal))
      .toMatchObject({ status: "cancelled", pageObservation: { latest: terminal } });

    const nextTurn = { ...turn, iteration: 1 };
    const { request: nextRequest } = gateway.openControlRequest(identity, nextTurn);
    const nextGrant = gateway.issueTurn({
      ...identity,
      ...nextTurn,
      requestId: nextRequest.requestId,
      scopes: ["workspace.read"],
      compactionEpoch: 0,
      generation: page.generation,
    });
    const nextBase = {
      ...base,
      observedAt: new Date().toISOString(),
      responseToRequestId: nextRequest.requestId,
    };
    gateway.observeControlPage(identity, nextRequest.requestId, nextTurn, {
      ...nextBase,
      observationSequence: 1,
      state: "send_attempted",
    });
    gateway.observeControlPage(identity, nextRequest.requestId, nextTurn, {
      ...nextBase,
      observationSequence: 2,
      state: "sent",
    });
    gateway.observeControlPage(identity, nextRequest.requestId, nextTurn, {
      ...nextBase,
      observationSequence: 3,
      responseId: "response-terminal-active-cleanup",
      state: "response_created",
    });
    const nextFailureCandidate = {
      ...nextBase,
      observationSequence: 4,
      responseId: "response-terminal-active-cleanup",
      state: "result_candidate" as const,
      responseIsFinal: true as const,
      reason: "platform_blocked" as const,
      source: "host_observed" as const,
      errorCode: "UNKNOWN" as const,
      completionEvidence: { responseActionsVisible: true as const, stopControlAbsent: true as const },
    };
    expect(gateway.observeControlPage(identity, nextRequest.requestId, nextTurn, nextFailureCandidate))
      .toMatchObject({ status: "pending" });
    vi.setSystemTime(Date.now() + 1_500);
    const nextTerminal = {
      ...nextFailureCandidate,
      observedAt: new Date().toISOString(),
      observationSequence: 5,
      state: "final" as const,
    };

    const originalRemove = fs.rmSync.bind(fs);
    let failActiveRemoval = true;
    const removeSpy = vi.spyOn(fs, "rmSync").mockImplementation(((...args: any[]) => {
      const target = String(args[0]);
      if (
        failActiveRemoval &&
        target.includes(`${path.sep}control-requests${path.sep}`) &&
        target.includes(`${path.sep}active${path.sep}`)
      ) {
        failActiveRemoval = false;
        throw new Error("injected active pointer cleanup failure");
      }
      return originalRemove(...args);
    }) as typeof fs.rmSync);
    expect(() => gateway.observeControlPage(identity, nextRequest.requestId, nextTurn, nextTerminal))
      .toThrow(/injected active pointer cleanup failure/);
    removeSpy.mockRestore();

    expect(gateway.turnStatus(nextGrant.token).status).toBe("revoked");
    expect(getActiveControlRequestStatus(identity.workspaceId, identity.localSessionId))
      .toMatchObject({ status: "cancelled", requestId: nextRequest.requestId });
    expect(gateway.observeControlPage(identity, nextRequest.requestId, nextTurn, nextTerminal))
      .toMatchObject({ status: "cancelled", pageObservation: { latest: nextTerminal } });
    expect(getActiveControlRequestStatus(identity.workspaceId, identity.localSessionId)).toBeNull();
  });

  it("revokes a cancelled request when active pointer cleanup fails", () => {
    cleanups.push(isolateStateDir());
    const root = makeTmpDir("cancel-active-cleanup-recovery");
    cleanups.push(root);
    const gateway = new MachineGateway({ surfaceValidator: requireCurrentTurnSurface });
    const identity = { ...gateway.registerWorkspace(root), localSessionId: "session-cancel-cleanup" };
    const chatUrl = projectUrl.replace("/project", "/c/cancel-cleanup");
    const page = gateway.surfaceClaim(identity, {
      browserId: "iab",
      surfaceId: "chatgpt",
      tabId: "tab-cancel-cleanup",
      projectUrl,
      chatUrl,
      projectSelection: projectSelection(projectUrl),
    });
    gateway.surfaceCommit(identity, page, {
      bootRequestId: receiveBootResult(gateway, identity, page),
      connectorName: "Codex with ChatGPT",
    });

    const turn = { taskId: "cancel-cleanup", iteration: 0, phase: "PLAN" as const };
    const { request } = gateway.openControlRequest(identity, turn);
    const grant = gateway.issueTurn({
      ...identity,
      ...turn,
      requestId: request.requestId,
      scopes: ["workspace.read"],
      compactionEpoch: 0,
      generation: page.generation,
    });

    const originalRemove = fs.rmSync.bind(fs);
    let failActiveRemoval = true;
    const removeSpy = vi.spyOn(fs, "rmSync").mockImplementation(((...args: any[]) => {
      const target = String(args[0]);
      if (
        failActiveRemoval &&
        target.includes(`${path.sep}control-requests${path.sep}`) &&
        target.includes(`${path.sep}active${path.sep}`)
      ) {
        failActiveRemoval = false;
        throw new Error("injected cancel active pointer cleanup failure");
      }
      return originalRemove(...args);
    }) as typeof fs.rmSync);
    expect(() => gateway.cancelControlRequest(identity, request.requestId, turn))
      .toThrow(/injected cancel active pointer cleanup failure/);
    removeSpy.mockRestore();

    expect(gateway.turnStatus(grant.token).status).toBe("revoked");
    expect(() => gateway.claimTurn(grant.token, ["workspace.read"])).toThrow(/revoked/i);
    expect(getActiveControlRequestStatus(identity.workspaceId, identity.localSessionId))
      .toMatchObject({ status: "cancelled", requestId: request.requestId });
    expect(gateway.cancelControlRequest(identity, request.requestId, turn))
      .toMatchObject({ status: "cancelled" });
    expect(getActiveControlRequestStatus(identity.workspaceId, identity.localSessionId)).toBeNull();
  });

  it("repairs active pointer cleanup after BOOT final observation without affecting another session", () => {
    cleanups.push(isolateStateDir());
    const root = makeTmpDir("boot-observation-cleanup-recovery");
    cleanups.push(root);
    const gateway = new MachineGateway({ surfaceValidator: requireCurrentTurnSurface });
    const identity = { ...gateway.registerWorkspace(root), localSessionId: "session-boot-cleanup" };
    const chatUrl = projectUrl.replace("/project", "/c/boot-cleanup");
    const page = gateway.surfaceClaim(identity, {
      browserId: "iab",
      surfaceId: "chatgpt",
      tabId: "tab-boot-cleanup",
      projectUrl,
      chatUrl,
      projectSelection: projectSelection(projectUrl),
    });
    const otherIdentity = { ...identity, localSessionId: "session-boot-cleanup-other" };
    const otherRequest = gateway.openControlRequest(otherIdentity, {
      taskId: "other-session-work",
      iteration: 0,
      phase: "RESEARCH",
    });

    const originalRemove = fs.rmSync.bind(fs);
    let failActiveRemoval = true;
    const activePath = path.join(
      getControlRequestsDir(identity.workspaceId),
      "active",
      `${identity.localSessionId}.json`,
    );
    const removeSpy = vi.spyOn(fs, "rmSync").mockImplementation(((...args: any[]) => {
      const target = String(args[0]);
      if (failActiveRemoval && target === activePath) {
        failActiveRemoval = false;
        throw new Error("injected BOOT active pointer cleanup failure");
      }
      return originalRemove(...args);
    }) as typeof fs.rmSync);
    expect(() => receiveBootResult(gateway, identity, page))
      .toThrow(/injected BOOT active pointer cleanup failure/);
    expect(failActiveRemoval).toBe(false);
    removeSpy.mockRestore();

    const interrupted = getActiveControlRequestStatus(identity.workspaceId, identity.localSessionId);
    expect(interrupted)
      .toMatchObject({
        status: "cancelled",
        requestId: expect.any(String),
        hostObservedResult: { provenance: "host_observed", result: { kind: "BOOT" } },
      });
    const bootRequestId = interrupted?.requestId;
    const finalObservation = interrupted?.pageObservation?.latest;
    if (!bootRequestId || finalObservation?.state !== "final") {
      throw new Error("expected the failed cleanup to leave the exact BOOT final observable");
    }
    const bootCorrelation = { taskId: `boot-${page.generation}`, iteration: 0, phase: "BOOT" as const };
    expect(gateway.observeControlPage(identity, bootRequestId, bootCorrelation, finalObservation))
      .toMatchObject({ status: "cancelled", pageObservation: { latest: finalObservation } });
    expect(getActiveControlRequestStatus(identity.workspaceId, identity.localSessionId)).toBeNull();
    expect(getActiveControlRequestStatus(identity.workspaceId, otherIdentity.localSessionId))
      .toMatchObject({ status: "pending", requestId: otherRequest.request.requestId });

    expect(gateway.surfaceCommit(identity, page, {
      bootRequestId,
      connectorName: "Codex with ChatGPT",
    })).toMatchObject({ binding: { chatUrl } });
    expect(getActiveControlRequestStatus(identity.workspaceId, otherIdentity.localSessionId))
      .toMatchObject({ status: "pending", requestId: otherRequest.request.requestId });
  });
});
