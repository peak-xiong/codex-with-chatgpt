import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  openControlRequest,
} from "../src/control/requests.js";
import { appendExecutionRecord } from "../src/execution/records.js";
import { MachineGateway, requireCurrentTurnSurface } from "../src/gateway/machine-gateway.js";
import { nullLogger } from "../src/logger/index.js";
import { createMcpServer } from "../src/mcp/server.js";
import { readManyOutputSchema } from "../src/mcp/server.js";
import { Workspace } from "../src/workspace/manager.js";
import { projectDataDirectory } from "../src/workspace/identity.js";
import { cleanup, isolateStateDir, makeGitRepo, makeTmpDir, projectSelection, write } from "./helpers.js";

const cleanups: string[] = [];

function correlation() {
  return {
    localSessionId: "session-mcp",
    taskId: "task-mcp",
    iteration: 1,
    phase: "PLAN" as const,
  };
}

async function connectedClient(
  gateway: MachineGateway,
  machine?: { machineId: string; associationId: string },
): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const server = createMcpServer({ gateway, logger: nullLogger, machine });
  const client = new Client({ name: "machine-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  while (cleanups.length > 0) cleanup(cleanups.pop()!);
  delete process.env.C2C_STATE_DIR;
});

describe("machine MCP capability correlation", () => {
  it("publishes output schemas for all twelve read-only tools and validates mixed read_many results", async () => {
    cleanups.push(isolateStateDir());
    const root = makeTmpDir("mcp-read-many-output-schema");
    cleanups.push(root);
    write(root, "first.txt", "a".repeat(300));
    write(root, "last.txt", "b".repeat(950));
    const gateway = new MachineGateway();
    const registration = gateway.registerWorkspace(root);
    const turn = correlation();
    const request = openControlRequest(registration.workspaceId, turn);
    const grant = gateway.issueTurn({ ...registration, ...turn, requestId: request.requestId,
      scopes: ["workspace.read", "workspace.search", "git.read", "execution.read"],
      compactionEpoch: 0, generation: 1 });
    const connection = await connectedClient(gateway);
    try {
      const { tools } = await connection.client.listTools();
      const readOnlyTools = [
        "workspace_info", "list_directory", "read_file", "read_image", "search_workspace", "git_status",
        "read_many", "review_context", "git_diff", "test_status", "execution_summary", "execution_output",
      ];
      for (const name of readOnlyTools) {
        const tool = tools.find((candidate) => candidate.name === name);
        expect(tool?.outputSchema, `${name} outputSchema`).toBeDefined();
      }

      const result = await connection.client.callTool({ name: "read_many", arguments: {
        context_id: grant.token,
        files: [{ path: "first.txt" }, { path: "missing.txt" }, { path: "last.txt" }],
        max_bytes: 2048,
      } });
      expect(result.isError).not.toBe(true);
      expect(readManyOutputSchema.parse(result.structuredContent)).toMatchObject({
        atomicSnapshot: false,
        items: [
          { index: 0, file: { path: "first.txt", content: "a".repeat(300) } },
          { index: 1, error: "FILE_NOT_FOUND" },
          { index: 2, error: "BATCH_LIMIT_REACHED" },
        ],
      });
    } finally {
      await connection.close();
    }
  });

  it("review_context includes only the capability's exact execution iteration", async () => {
    cleanups.push(isolateStateDir());
    const root = makeTmpDir("mcp-review-context"); cleanups.push(root);
    const gateway = new MachineGateway();
    const registration = gateway.registerWorkspace(root);
    const request = openControlRequest(registration.workspaceId, correlation());
    const grant = gateway.issueTurn({ ...registration, ...correlation(), requestId: request.requestId,
      scopes: ["git.read", "execution.read"], compactionEpoch: 0, generation: 1 });
    for (const iteration of [1, 2]) {
      appendExecutionRecord(registration.workspaceId, {
        localSessionId: correlation().localSessionId, taskId: correlation().taskId, iteration,
        changedFiles: [], tests: null, exitStatus: iteration === 1 ? "failed" : "ok", timestamp: new Date().toISOString(),
        ...(iteration === 1 ? { executor: "Codex" } : {}),
      });
    }
    const connection = await connectedClient(gateway);
    try {
      const result = await connection.client.callTool({ name: "review_context", arguments: { context_id: grant.token, include_execution: true } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        execution: { iteration: 1, exitStatus: "failed", executor: "Codex" },
        gitStatus: { hidden: { changes: 0, conflicts: 0 } },
      });
      const status = await connection.client.callTool({
        name: "git_status", arguments: { context_id: grant.token },
      });
      expect(status.isError).not.toBe(true);
      expect(status.structuredContent).toMatchObject({
        isRepo: false,
        hidden: { changes: 0, conflicts: 0 },
      });
      expect(status.structuredContent).toHaveProperty("hidden.changes", 0);
      expect(status.structuredContent).toHaveProperty("hidden.conflicts", 0);
    } finally { await connection.close(); }
  });

  it("gates aggregate reads by capability and derives execution correlation from the exact turn", async () => {
    cleanups.push(isolateStateDir());
    const root = makeTmpDir("mcp-batch"); cleanups.push(root); write(root, "a.txt", "bounded content");
    const gateway = new MachineGateway();
    const registration = gateway.registerWorkspace(root);
    const request = openControlRequest(registration.workspaceId, correlation());
    const grant = gateway.issueTurn({ ...registration, ...correlation(), requestId: request.requestId,
      scopes: ["workspace.read", "git.read"], compactionEpoch: 0, generation: 1 });
    const connection = await connectedClient(gateway);
    try {
      const read = await connection.client.callTool({ name: "read_many", arguments: { context_id: grant.token, files: [{ path: "a.txt" }] } });
      expect(read.isError).not.toBe(true);
      expect(read.structuredContent).toMatchObject({ items: [{ file: { content: "bounded content" } }] });
      const denied = await connection.client.callTool({ name: "review_context", arguments: { context_id: grant.token, include_execution: true } });
      expect(denied.isError).toBe(true);
      const diff = await connection.client.callTool({ name: "review_context", arguments: { context_id: grant.token } });
      expect(diff.isError).not.toBe(true);
      expect(diff.structuredContent).toMatchObject({ atomicSnapshot: false, execution: null, diff: { isRepo: false } });
    } finally { await connection.close(); }
  });

  it("scopes read_file/read_many and rejects Git state while allowing source reads", async () => {
    cleanups.push(isolateStateDir());
    const root = makeTmpDir("mcp-workspace-read-boundary");
    cleanups.push(root);
    makeGitRepo(root);
    write(root, "src/allowed.ts", "export const safe = true;\n");
    const gateway = new MachineGateway();
    const registration = gateway.registerWorkspace(root);
    const stateFile = path.join(
      projectDataDirectory(root), "workspaces", registration.workspaceId, "execution-record.json",
    );
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, "private execution record");
    const statePath = path.relative(root, stateFile).split(path.sep).join("/");

    const readTurn = correlation();
    const readRequest = openControlRequest(registration.workspaceId, readTurn);
    const readGrant = gateway.issueTurn({ ...registration, ...readTurn, requestId: readRequest.requestId,
      scopes: ["workspace.read"], compactionEpoch: 0, generation: 1 });
    const executionTurn = { ...correlation(), localSessionId: "session-execution-only", taskId: "task-execution-only" };
    const executionRequest = openControlRequest(registration.workspaceId, executionTurn);
    const executionGrant = gateway.issueTurn({ ...registration, ...executionTurn, requestId: executionRequest.requestId,
      scopes: ["execution.read"], compactionEpoch: 0, generation: 1 });
    const connection = await connectedClient(gateway);
    try {
      const source = await connection.client.callTool({
        name: "read_file", arguments: { context_id: readGrant.token, path: "src/allowed.ts" },
      });
      expect(source.isError).not.toBe(true);
      expect(source.structuredContent).toMatchObject({ content: "export const safe = true;" });

      const gitMetadata = await connection.client.callTool({
        name: "read_file", arguments: { context_id: readGrant.token, path: ".git/HEAD" },
      });
      expect(gitMetadata.isError).toBe(true);
      expect(JSON.stringify(gitMetadata)).toContain("ACCESS_DENIED_SENSITIVE_FILE");

      const batch = await connection.client.callTool({
        name: "read_many", arguments: { context_id: readGrant.token, files: [
          { path: statePath }, { path: "src/allowed.ts" },
        ] },
      });
      expect(batch.isError).not.toBe(true);
      expect(readManyOutputSchema.parse(batch.structuredContent)).toMatchObject({ items: [
        { index: 0, error: "ACCESS_DENIED_SENSITIVE_FILE" },
        { index: 1, file: { content: "export const safe = true;" } },
      ] });

      for (const name of ["read_file", "read_many"] as const) {
        const args = name === "read_file"
          ? { context_id: executionGrant.token, path: "src/allowed.ts" }
          : { context_id: executionGrant.token, files: [{ path: "src/allowed.ts" }] };
        const denied = await connection.client.callTool({ name, arguments: args });
        expect(denied.isError).toBe(true);
        expect(JSON.stringify(denied)).toContain("SCOPE_DENIED");
      }
    } finally {
      await connection.close();
    }
  });

  it("reads bounded image content under the workspace capability and rejects unsafe paths and sizes", async () => {
    cleanups.push(isolateStateDir());
    const root = makeTmpDir("mcp-read-image"); cleanups.push(root);
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
      "base64",
    );
    fs.writeFileSync(path.join(root, "pixel.png"), png);
    fs.writeFileSync(path.join(root, ".env"), png);
    fs.writeFileSync(path.join(root, "not-an-image.bin"), Buffer.from("not an image"));
    fs.writeFileSync(path.join(root, "oversized.png"), Buffer.concat([
      png,
      Buffer.alloc(10 * 1024 * 1024 + 1 - png.length),
    ]));

    const gateway = new MachineGateway();
    const registration = gateway.registerWorkspace(root);
    const request = openControlRequest(registration.workspaceId, correlation());
    const grant = gateway.issueTurn({
      ...registration, ...correlation(), requestId: request.requestId,
      scopes: ["workspace.read"], compactionEpoch: 0, generation: 1,
    });
    const deniedCorrelation = {
      ...correlation(), localSessionId: "session-image-denied", taskId: "task-image-denied",
    };
    const deniedRequest = openControlRequest(registration.workspaceId, deniedCorrelation);
    const deniedGrant = gateway.issueTurn({
      ...registration, ...deniedCorrelation, requestId: deniedRequest.requestId,
      scopes: ["execution.read"], compactionEpoch: 0, generation: 1,
    });
    const connection = await connectedClient(gateway);
    try {
      const read = await connection.client.callTool({
        name: "read_image", arguments: { context_id: grant.token, path: "pixel.png" },
      });
      expect(read.isError).not.toBe(true);
      expect(read.structuredContent).toEqual({ path: "pixel.png", format: "png", mediaType: "image/png", sizeBytes: png.length });
      const image = read.content.find((item) => item.type === "image");
      expect(image).toMatchObject({ type: "image", mimeType: "image/png", data: png.toString("base64") });

      const wrongCapability = await connection.client.callTool({
        name: "read_image", arguments: { context_id: deniedGrant.token, path: "pixel.png" },
      });
      expect(wrongCapability.isError).toBe(true);
      expect(JSON.stringify(wrongCapability)).toContain("SCOPE_DENIED");

      for (const [requested, code] of [
        ["../pixel.png", "PATH_OUTSIDE_WORKSPACE"],
        [".env", "ACCESS_DENIED_SENSITIVE_FILE"],
        ["oversized.png", "FILE_TOO_LARGE"],
        ["not-an-image.bin", "UNSUPPORTED_IMAGE_FORMAT"],
      ] as const) {
        const rejected = await connection.client.callTool({
          name: "read_image", arguments: { context_id: grant.token, path: requested },
        });
        expect(rejected.isError).toBe(true);
        expect(JSON.stringify(rejected)).toContain(code);
      }
    } finally {
      await connection.close();
    }
  });

  it("reports the serving device and rejects another device's context before a workspace read", async () => {
    cleanups.push(isolateStateDir());
    const root = makeTmpDir("mcp-two-devices"); cleanups.push(root);
    const a = new MachineGateway(), b = new MachineGateway();
    const registration = a.registerWorkspace(root);
    b.registerWorkspace(root);
    const request = openControlRequest(registration.workspaceId, { ...correlation(), ttlMs: 60_000 });
    const grant = a.issueTurn({ ...registration, ...correlation(), requestId: request.requestId, scopes: ["workspace.read"], compactionEpoch: 0, generation: 1 });
    const machineA = { machineId: `machine-${"a".repeat(32)}`, associationId: `assoc-${"a".repeat(32)}` };
    const machineB = { machineId: `machine-${"b".repeat(32)}`, associationId: `assoc-${"b".repeat(32)}` };
    const ca = await connectedClient(a, machineA);
    const cb = await connectedClient(b, machineB);
    try {
      const wrong = await cb.client.callTool({ name: "workspace_info", arguments: { context_id: grant.token } });
      expect(wrong.isError).toBe(true);
      expect(JSON.stringify(wrong)).toContain("TOKEN_NOT_FOUND");
      expect(wrong.structuredContent).toBeUndefined();
      const correct = await ca.client.callTool({ name: "workspace_info", arguments: { context_id: grant.token } });
      expect(correct.isError).not.toBe(true);
      expect(correct.structuredContent).toMatchObject({ ...machineA, workspaceId: registration.workspaceId });
    } finally { await ca.close(); await cb.close(); }
  });

  it("exposes only the twelve read-only host tools and no result callbacks", async () => {
    cleanups.push(isolateStateDir());
    const connection = await connectedClient(new MachineGateway());
    try {
      const { tools } = await connection.client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        "execution_output", "execution_summary", "git_diff", "git_status", "list_directory",
        "read_file", "read_image", "read_many", "review_context", "search_workspace", "test_status", "workspace_info",
      ]);
      expect(tools.map((tool) => tool.name)).not.toEqual(expect.arrayContaining([
        "get_control_result_status",
        "report_control_progress",
        "submit_control_result",
      ]));
      expect(tools.some((tool) => tool.name === "workspace_info")).toBe(true);
      const removedCallback = await connection.client.callTool({ name: "submit_control_result", arguments: {} });
      expect(removedCallback.isError).toBe(true);
      expect(removedCallback.content[0]?.text).toMatch(/unknown tool|not found|does not exist/i);
      expect(removedCallback.structuredContent).toBeUndefined();
    } finally {
      await connection.close();
    }
  });

  it("commits an exact candidate after a verified Computer Use BOOT result", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    cleanups.push(isolateStateDir());
    const root = makeTmpDir("computer-use-boot");
    cleanups.push(root);
    const gateway = new MachineGateway({ surfaceValidator: requireCurrentTurnSurface });
    const identity = { ...gateway.registerWorkspace(root), localSessionId: "session-computer-use-boot" };
    const projectUrl = "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/project";
    const chatUrl = projectUrl.replace("/project", "/c/computer-use-boot");
    const lease = gateway.surfaceClaim(identity, {
      browserId: "iab", surfaceId: "chatgpt", tabId: "tab-computer-use-boot",
      projectUrl, chatUrl, projectSelection: projectSelection(projectUrl),
    });
    const turn = { taskId: "boot-computer-use", iteration: 0, phase: "BOOT" as const };
    const { request } = gateway.openControlRequest(identity, turn);
    gateway.issueTurn({ ...identity, ...turn, requestId: request.requestId, generation: lease.generation,
      scopes: ["workspace.read"], compactionEpoch: 0 });
    const page = {
      tabId: lease.tabId,
      generation: lease.generation,
      observedUrl: chatUrl,
      observedAt: new Date().toISOString(),
      responseToRequestId: request.requestId,
    };
    gateway.observeControlPage(identity, request.requestId, turn, {
      ...page, observationSequence: 1, state: "send_attempted",
    });
    gateway.observeControlPage(identity, request.requestId, turn, {
      ...page, observationSequence: 2, state: "sent",
    });
    gateway.observeControlPage(identity, request.requestId, turn, {
      ...page, observationSequence: 3, state: "response_created", responseId: "response-computer-use-boot",
    });
    const terminalResult = { kind: "BOOT" as const, payload: {} };
    const completionEvidence = { responseActionsVisible: true as const, stopControlAbsent: true as const };
    gateway.observeControlPage(identity, request.requestId, turn, {
      ...page, observationSequence: 4, state: "result_candidate", responseId: "response-computer-use-boot",
      responseIsFinal: true, delivery: "computer_use", terminalResult, completionEvidence,
    });
    vi.setSystemTime(Date.now() + 1_500);
    expect(gateway.observeControlPage(identity, request.requestId, turn, {
      ...page, observedAt: new Date().toISOString(), observationSequence: 5, state: "final",
      responseId: "response-computer-use-boot", responseIsFinal: true, delivery: "computer_use",
      terminalResult, completionEvidence,
    })).toMatchObject({
      status: "cancelled",
      hostObservedResult: { result: { kind: "BOOT" } },
    });
    expect(gateway.surfaceCommit(identity, lease, {
      bootRequestId: request.requestId,
      connectorName: "Codex with ChatGPT",
    })).toMatchObject({ binding: { tabId: lease.tabId, chatUrl } });
  });


  it("documents git_diff pagination with its output field names", async () => {
    cleanups.push(isolateStateDir());
    const gateway = new MachineGateway();
    const connection = await connectedClient(gateway);
    try {
      const { tools } = await connection.client.listTools();
      const description = tools.find((tool) => tool.name === "git_diff")?.description;
      expect(description).toContain("hasMore");
      expect(description).toContain("nextOffset");
      expect(description).not.toContain("has_more");
      expect(description).not.toContain("next_offset");
    } finally {
      await connection.close();
    }
  });

  it("returns a schema-valid execution summary for the exact session and task", async () => {
    cleanups.push(isolateStateDir());
    const root = makeTmpDir("mcp-execution-summary");
    cleanups.push(root);
    const gateway = new MachineGateway();
    const registration = gateway.registerWorkspace(root);
    const request = openControlRequest(registration.workspaceId, {
      ...correlation(),
      ttlMs: 60_000,
    });
    const grant = gateway.issueTurn({
      ...registration,
      ...correlation(),
      requestId: request.requestId,
      scopes: ["execution.read"],
      compactionEpoch: 0,
      generation: 1,
      ttlMs: 60_000,
    });
    appendExecutionRecord(registration.workspaceId, {
      localSessionId: correlation().localSessionId,
      taskId: correlation().taskId,
      iteration: correlation().iteration,
      changedFiles: ["src/index.ts"],
      tests: "436 passed",
      executor: "Codex",
      exitStatus: "ok",
      timestamp: new Date().toISOString(),
      outputAvailable: false,
    });

    const connection = await connectedClient(gateway);
    try {
      const result = await connection.client.callTool({
        name: "execution_summary",
        arguments: {
          context_id: grant.token,
          local_session_id: correlation().localSessionId,
          task_id: correlation().taskId,
          limit: 1,
        },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({
        records: [expect.objectContaining({
          workspaceId: registration.workspaceId,
          localSessionId: correlation().localSessionId,
          taskId: correlation().taskId,
          iteration: correlation().iteration,
          changedFiles: ["src/index.ts"],
          executor: "Codex",
          exitStatus: "ok",
        })],
      });

      const status = await connection.client.callTool({
        name: "test_status",
        arguments: {
          context_id: grant.token,
          local_session_id: correlation().localSessionId,
          task_id: correlation().taskId,
          iteration: correlation().iteration,
        },
      });
      expect(status.structuredContent).toMatchObject({ available: true, executor: "Codex" });
    } finally {
      await connection.close();
    }
  });

  it("does not return an in-flight read after its capability is cancelled", async () => {
    cleanups.push(isolateStateDir());
    const root = makeTmpDir("mcp-cancel-inflight");
    cleanups.push(root);
    write(root, "marker.txt", "private workspace data\n");
    const gateway = new MachineGateway();
    const registration = gateway.registerWorkspace(root);
    const request = openControlRequest(registration.workspaceId, {
      ...correlation(),
      ttlMs: 60_000,
    });
    const grant = gateway.issueTurn({
      ...registration,
      ...correlation(),
      requestId: request.requestId,
      scopes: ["workspace.read"],
      compactionEpoch: 0,
      generation: 1,
      ttlMs: 60_000,
    });
    let entered!: () => void;
    let resume!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const originalRead = Workspace.prototype.readFile;
    vi.spyOn(Workspace.prototype, "readFile").mockImplementation(async function (...args) {
      entered();
      await gate;
      return originalRead.apply(this, args);
    });
    const connection = await connectedClient(gateway);
    try {
      const pending = connection.client.callTool({
        name: "read_file",
        arguments: { context_id: grant.token, path: "marker.txt" },
      });
      await started;
      gateway.cancelTurn(grant.token, {
        workspaceId: registration.workspaceId,
        projectId: registration.projectId,
        ...correlation(),
        requestId: request.requestId,
      });
      resume();
      const result = await pending;
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("TOKEN_CANCELLED");
      expect(JSON.stringify(result)).not.toContain("private workspace data");
    } finally {
      resume();
      await connection.close();
    }
  });
});
