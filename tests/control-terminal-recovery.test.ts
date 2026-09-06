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
        file.includes(`${path.sep}control-mailbox${path.sep}`) &&
        file.includes(`${path.sep}observations${path.sep}`)
      ) {
        observationWriteFault.failOnce = false;
        throw new Error("injected observation write failure");
      }
      actual.writeSecureJson(file, data);
    },
  };
});

import { getActiveControlResultStatus } from "../src/control/mailbox.js";
import { MachineGateway, requireCurrentTurnSurface } from "../src/gateway/machine-gateway.js";
import { cleanup, isolateStateDir, makeTmpDir, projectSelection, receiveBootResult } from "./helpers.js";

const cleanups: string[] = [];
const projectUrl = "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/project";

afterEach(() => {
  observationWriteFault.failOnce = false;
  while (cleanups.length > 0) cleanup(cleanups.pop()!);
  delete process.env.C2C_STATE_DIR;
});

describe("terminal observation recovery", () => {
  it("revokes authority immediately and repairs cleanup after a partial terminal write", () => {
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
    const { request } = gateway.openControlResultRequest(identity, turn);
    const grant = gateway.issueTurn({
      ...identity,
      ...turn,
      requestId: request.requestId,
      scopes: ["workspace.read", "c2c.result.write"],
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
    const terminal = {
      ...base,
      observationSequence: 4,
      responseId: "response-terminal-recovery",
      state: "final" as const,
      responseIsFinal: true as const,
      reason: "callback_missing" as const,
      source: "host_observed" as const,
    };

    observationWriteFault.failOnce = true;
    expect(() => gateway.observeControlPage(identity, request.requestId, turn, terminal))
      .toThrow(/injected observation write failure/);
    expect(gateway.turnStatus(grant.token).status).toBe("revoked");
    expect(() => gateway.claimTurn(grant.token, ["workspace.read"])).toThrow(/revoked/i);
    expect(getActiveControlResultStatus(identity.workspaceId, identity.localSessionId))
      .toMatchObject({ status: "cancelled", requestId: request.requestId });

    expect(gateway.observeControlPage(identity, request.requestId, turn, terminal))
      .toMatchObject({ status: "cancelled", pageObservation: { latest: terminal } });
    expect(getActiveControlResultStatus(identity.workspaceId, identity.localSessionId)).toBeNull();
  });
});
