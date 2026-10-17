import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimSurface,
  commitSurface,
  getControlRequestStatus,
  issueTurn,
  observeControlRequest,
  openControlRequest,
  registerWorkspace,
  releaseSurface,
} from "../src/gateway/control-client.js";
import { startMachineGatewayServer, type MachineGatewayServer } from "../src/gateway/server.js";
import { cleanup, isolateStateDir, makeTmpDir, projectSelection } from "./helpers.js";

const PROJECT_URL = "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/project";
const SESSION_COUNT = 100;
const FLOW_TTL_MS = 10 * 60 * 1_000;
const ADMIN_REQUEST_CONCURRENCY = 4;

type Registration = Awaited<ReturnType<typeof registerWorkspace>>;
type SessionIdentity = Pick<Registration, "workspaceId" | "projectId" | "registrationId"> & {
  localSessionId: string;
};
type Session = {
  localSessionId: string;
  tabId: string;
  chatUrl: string;
  identity: SessionIdentity;
};

async function mapWithConcurrency<R>(
  items: readonly Session[],
  concurrency: number,
  step: string,
  mapper: (item: Session, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        try {
          results[index] = await mapper(items[index], index);
        } catch (error) {
          throw new Error(`${step} failed for ${items[index].localSessionId}`, { cause: error });
        }
      }
    }),
  );
  return results;
}

async function withRequestContext<T>(
  step: string,
  session: Session,
  request: () => Promise<T>,
): Promise<T> {
  try {
    return await request();
  } catch (error) {
    throw new Error(`${step} HTTP request failed for ${session.localSessionId}`, { cause: error });
  }
}

function planResult(session: Session) {
  return {
    kind: "PLAN" as const,
    payload: {
      goal: `Verify independent session ${session.localSessionId}`,
      rationale: "Each local session must retain its own request and browser page identity.",
      actions: [{ change: "complete the observed page response", why: "prove concurrent request routing" }],
      tests: ["machine-gateway-concurrency"],
      successCriteria: [`Only ${session.localSessionId} receives this terminal response`],
    },
  };
}

describe("machine gateway session concurrency", () => {
  let server: MachineGatewayServer | null = null;
  const cleanups: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    await server?.close();
    server = null;
    for (const target of cleanups.splice(0)) cleanup(target);
    delete process.env.C2C_STATE_DIR;
  });

  it("runs 100 isolated Computer Use request flows through one HTTP gateway", async () => {
    cleanups.push(isolateStateDir());
    const root = makeTmpDir("machine-gateway-concurrency");
    cleanups.push(root);
    server = await startMachineGatewayServer({
      port: 0,
      connectStdio: false,
      persistRuntime: false,
    });

    const registration = await registerWorkspace(server.runtime, root);
    const sessions: Session[] = Array.from({ length: SESSION_COUNT }, (_, index) => {
      const localSessionId = `session-concurrent-${index}`;
      return {
        localSessionId,
        tabId: `tab-concurrent-${index}`,
        chatUrl: `${PROJECT_URL.replace("/project", "")}/c/chat-concurrent-${index}`,
        identity: {
          workspaceId: registration.workspaceId,
          projectId: registration.projectId,
          registrationId: registration.registrationId,
          localSessionId,
        },
      };
    });

    const claims = await mapWithConcurrency(sessions, ADMIN_REQUEST_CONCURRENCY, "surface claim", (session) =>
      claimSurface(server!.runtime, session.identity, {
        tabId: session.tabId,
        projectUrl: PROJECT_URL,
        projectSelection: projectSelection(PROJECT_URL),
        chatUrl: session.chatUrl,
        ownerProcessEpoch: `owner-${session.localSessionId}`,
        leaseTtlMs: FLOW_TTL_MS,
      }));
    expect(claims).toHaveLength(SESSION_COUNT);
    expect(new Set(claims.map(({ lease }) => lease.localSessionId)).size).toBe(SESSION_COUNT);
    expect(new Set(claims.map(({ lease }) => lease.tabId)).size).toBe(SESSION_COUNT);
    expect(new Set(claims.map(({ lease }) => lease.generation)).size).toBe(SESSION_COUNT);

    const bootRequests = await mapWithConcurrency(sessions, ADMIN_REQUEST_CONCURRENCY, "BOOT request open", (session) =>
      openControlRequest(server!.runtime, session.identity, {
        taskId: `boot-${session.localSessionId}`,
        iteration: 0,
        phase: "BOOT",
        ttlMs: FLOW_TTL_MS,
      }));
    expect(bootRequests.every(({ created }) => created)).toBe(true);

    const bootGrants = await mapWithConcurrency(sessions, ADMIN_REQUEST_CONCURRENCY, "BOOT authority issue", (session, index) =>
      issueTurn(server!.runtime, {
        ...session.identity,
        taskId: `boot-${session.localSessionId}`,
        iteration: 0,
        phase: "BOOT",
        requestId: bootRequests[index].request.requestId,
        scopes: ["workspace.read"],
        compactionEpoch: 0,
        generation: claims[index].lease.generation,
        ttlMs: FLOW_TTL_MS,
      }));
    expect(new Set(bootGrants.map(({ token }) => token)).size).toBe(SESSION_COUNT);
    expect(bootGrants.map(({ binding }) => ({
      workspaceId: binding.workspaceId,
      projectId: binding.projectId,
      registrationId: binding.registrationId,
      localSessionId: binding.localSessionId,
      requestId: binding.requestId,
      taskId: binding.taskId,
      iteration: binding.iteration,
      phase: binding.phase,
      generation: binding.generation,
      scopes: binding.scopes,
    }))).toEqual(sessions.map((session, index) => ({
      workspaceId: session.identity.workspaceId,
      projectId: session.identity.projectId,
      registrationId: session.identity.registrationId,
      localSessionId: session.localSessionId,
      requestId: bootRequests[index].request.requestId,
      taskId: `boot-${session.localSessionId}`,
      iteration: 0,
      phase: "BOOT",
      generation: claims[index].lease.generation,
      scopes: ["workspace.read"],
    })));
    expect(bootGrants.map(({ token }) => server!.gateway.turnStatus(token).status))
      .toEqual(Array(SESSION_COUNT).fill("issued"));

    const completeBoot = async (session: Session, index: number): Promise<void> => {
      const request = bootRequests[index].request;
      const common = {
        requestId: request.requestId,
        taskId: request.taskId,
        iteration: request.iteration,
        phase: request.phase,
      };
      const responseId = `boot-response-${request.requestId}`;
      const observe = (observationSequence: number, state: string, terminal = false) =>
        withRequestContext(`BOOT ${state}`, session, () => observeControlRequest(
          server!.runtime,
          session.identity,
          {
            ...common,
            observation: {
              tabId: session.tabId,
              generation: claims[index].lease.generation,
              observedUrl: observationSequence < 3 ? PROJECT_URL : session.chatUrl,
              observedAt: new Date().toISOString(),
              responseToRequestId: request.requestId,
              observationSequence,
              state,
              ...(observationSequence >= 3 ? { responseId } : {}),
              ...(terminal ? {
                responseIsFinal: true,
                delivery: "computer_use",
                terminalResult: { kind: "BOOT", payload: {} },
                completionEvidence: { responseActionsVisible: true, stopControlAbsent: true },
              } : {}),
            },
          },
        ));
      await observe(1, "send_attempted");
      await observe(2, "sent");
      await observe(3, "response_created");
      await observe(4, "result_candidate", true);
    };

    vi.useFakeTimers({ toFake: ["Date"] });
    await mapWithConcurrency(sessions, ADMIN_REQUEST_CONCURRENCY, "BOOT observation flow", completeBoot);
    expect(bootGrants.map(({ token }) => server!.gateway.turnStatus(token).status))
      .toEqual(Array(SESSION_COUNT).fill("issued"));
    vi.setSystemTime(Date.now() + 1_500);
    const bootStatuses = await mapWithConcurrency(sessions, ADMIN_REQUEST_CONCURRENCY, "BOOT final observation", (session, index) => {
      const request = bootRequests[index].request;
      return withRequestContext("BOOT final", session, () => observeControlRequest(server!.runtime, session.identity, {
        requestId: request.requestId,
        taskId: request.taskId,
        iteration: request.iteration,
        phase: request.phase,
        observation: {
          tabId: session.tabId,
          generation: claims[index].lease.generation,
          observedUrl: session.chatUrl,
          observedAt: new Date().toISOString(),
          responseToRequestId: request.requestId,
          observationSequence: 5,
          responseId: `boot-response-${request.requestId}`,
          state: "final",
          responseIsFinal: true,
          delivery: "computer_use",
          terminalResult: { kind: "BOOT", payload: {} },
          completionEvidence: { responseActionsVisible: true, stopControlAbsent: true },
        },
      }));
    });
    const incompleteBoots = bootStatuses.flatMap((status, index) =>
      status.hostObservedResult?.result.kind === "BOOT"
        ? []
        : [{
          index,
          requestId: bootRequests[index].request.requestId,
          status: status.status,
          hostFailure: status.hostFailure,
          latestObservation: status.pageObservation?.latest,
        }],
    );
    expect(incompleteBoots).toEqual([]);

    const commits = await mapWithConcurrency(sessions, ADMIN_REQUEST_CONCURRENCY, "surface commit", (session, index) =>
      commitSurface(server!.runtime, session.identity, claims[index].lease, {
        bootRequestId: bootRequests[index].request.requestId,
        chatUrl: session.chatUrl,
        connectorName: "Codex with ChatGPT",
      }));
    expect(commits.every(({ binding }) => binding?.chatUrl !== undefined)).toBe(true);

    const requests = await mapWithConcurrency(sessions, ADMIN_REQUEST_CONCURRENCY, "work request open", (session) =>
      openControlRequest(server!.runtime, session.identity, {
        taskId: `task-${session.localSessionId}`,
        iteration: 0,
        phase: "PLAN",
        ttlMs: FLOW_TTL_MS,
      }));
    expect(requests.every(({ created }) => created)).toBe(true);
    expect(new Set(requests.map(({ request }) => request.requestId)).size).toBe(SESSION_COUNT);

    const grants = await mapWithConcurrency(sessions, ADMIN_REQUEST_CONCURRENCY, "work authority issue", (session, index) =>
      issueTurn(server!.runtime, {
        ...session.identity,
        taskId: `task-${session.localSessionId}`,
        iteration: 0,
        phase: "PLAN",
        requestId: requests[index].request.requestId,
        scopes: ["workspace.read"],
        compactionEpoch: 0,
        generation: claims[index].lease.generation,
        ttlMs: FLOW_TTL_MS,
      }));
    expect(new Set(grants.map(({ token }) => token)).size).toBe(SESSION_COUNT);

    const completeCandidate = async (session: Session, index: number): Promise<void> => {
      const request = requests[index].request;
      const result = planResult(session);
      const responseId = `plan-response-${request.requestId}`;
      const correlation = {
        requestId: request.requestId,
        taskId: request.taskId,
        iteration: request.iteration,
        phase: request.phase,
      };
      const observe = (observationSequence: number, state: string, terminal = false) =>
        withRequestContext(`work ${state}`, session, () => observeControlRequest(
          server!.runtime,
          session.identity,
          {
            ...correlation,
            observation: {
              tabId: session.tabId,
              generation: claims[index].lease.generation,
              observedUrl: session.chatUrl,
              observedAt: new Date().toISOString(),
              responseToRequestId: request.requestId,
              observationSequence,
              state,
              ...(observationSequence >= 3 ? { responseId } : {}),
              ...(terminal ? {
                responseIsFinal: true,
                delivery: "computer_use",
                terminalResult: result,
                completionEvidence: { responseActionsVisible: true, stopControlAbsent: true },
              } : {}),
            },
          },
        ));
      await observe(1, "send_attempted");
      await observe(2, "sent");
      await observe(3, "response_created");
      await observe(4, "result_candidate", true);
    };
    await mapWithConcurrency(sessions, ADMIN_REQUEST_CONCURRENCY, "work candidate observation flow", completeCandidate);
    vi.setSystemTime(Date.now() + 1_500);
    const statuses = await mapWithConcurrency(sessions, ADMIN_REQUEST_CONCURRENCY, "work final observation", (session, index) => {
      const request = requests[index].request;
      return withRequestContext("work final", session, () => observeControlRequest(server!.runtime, session.identity, {
        requestId: request.requestId,
        taskId: request.taskId,
        iteration: request.iteration,
        phase: request.phase,
        observation: {
          tabId: session.tabId,
          generation: claims[index].lease.generation,
          observedUrl: session.chatUrl,
          observedAt: new Date().toISOString(),
          responseToRequestId: request.requestId,
          observationSequence: 5,
          responseId: `plan-response-${request.requestId}`,
          state: "final",
          responseIsFinal: true,
          delivery: "computer_use",
          terminalResult: planResult(session),
          completionEvidence: { responseActionsVisible: true, stopControlAbsent: true },
        },
      }));
    });
    expect(statuses).toHaveLength(SESSION_COUNT);
    sessions.forEach((session, index) => {
      expect(statuses[index]).toMatchObject({
        status: "cancelled",
        request: {
          requestId: requests[index].request.requestId,
          localSessionId: session.localSessionId,
          taskId: `task-${session.localSessionId}`,
          surfaceGeneration: claims[index].lease.generation,
          surfaceTabId: session.tabId,
        },
        hostObservedResult: {
          result: {
            kind: "PLAN",
            payload: {
              successCriteria: [`Only ${session.localSessionId} receives this terminal response`],
            },
          },
        },
      });
      expect(grants[index].binding).toMatchObject({
        localSessionId: session.localSessionId,
        requestId: requests[index].request.requestId,
        taskId: `task-${session.localSessionId}`,
      });
    });

    const lookups = await mapWithConcurrency(sessions, ADMIN_REQUEST_CONCURRENCY, "request status lookup", (session, index) =>
      getControlRequestStatus(server!.runtime, session.identity, {
        requestId: requests[index].request.requestId,
        taskId: `task-${session.localSessionId}`,
        iteration: 0,
        phase: "PLAN",
      }));
    expect(lookups.map(({ request }) => request?.localSessionId)).toEqual(sessions.map(({ localSessionId }) => localSessionId));

    const released = await mapWithConcurrency(sessions, ADMIN_REQUEST_CONCURRENCY, "surface release", (session, index) =>
      releaseSurface(server!.runtime, session.identity, claims[index].lease));
    expect(released.every(({ released: didRelease }) => didRelease)).toBe(true);
    expect(server.gateway.stats().activeTurnCount).toBe(0);
  }, 300_000);
});
