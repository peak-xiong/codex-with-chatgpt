import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acknowledgeControlResult,
  getControlResultStatus,
  submitControlResult,
} from "../src/control/mailbox.js";
import { controlWaitPolicy } from "../src/control/wait-policy.js";
import { MachineGateway, requireCurrentTurnSurface } from "../src/gateway/machine-gateway.js";
import { Workspace } from "../src/workspace/manager.js";
import {
  cleanup,
  isolateStateDir,
  makeTmpDir,
  projectSelection,
  startManagedMachineFixture,
  type ManagedMachineFixture,
} from "./helpers.js";

const projectUrl = "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/project";
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "src", "cli", "index.ts");
const localSessionId = "session-transport-regression";
const taskId = "transport-boot-task";
const mailboxMarker = "legacy-mailbox-payload-marker";

let stateDir: string;
let workspaceRoot: string;
let machine: ManagedMachineFixture | undefined;
let cleanups: string[];

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): CliResult {
  const result = spawnSync(process.execPath, ["--import", "tsx/esm", cliEntry, ...args], {
    cwd: workspaceRoot,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, ...machine!.environment, C2C_STATE_DIR: stateDir },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function runJson(args: string[]): { command: CliResult; body: Record<string, unknown> } {
  const command = runCli([...args, "--json"]);
  const lines = command.stdout.trim().split("\n").filter(Boolean);
  return { command, body: JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown> };
}

function openBootRequest(gateway: MachineGateway, identity: ReturnType<MachineGateway["registerWorkspace"]> & { localSessionId: string }, page: ReturnType<MachineGateway["surfaceClaim"]>) {
  const { request } = gateway.openControlResultRequest(identity, { taskId, iteration: 0, phase: "BOOT" });
  submitControlResult(identity.workspaceId, {
    requestId: request.requestId,
    localSessionId: identity.localSessionId,
    taskId,
    iteration: 0,
    phase: "BOOT",
    kind: "BOOT",
    payload: {},
  });
  return { request, page, correlation: { taskId, iteration: 0, phase: "BOOT" as const } };
}

beforeEach(() => {
  cleanups = [];
  stateDir = isolateStateDir();
  cleanups.push(stateDir);
});

afterEach(async () => {
  await machine?.close();
  machine = undefined;
  while (cleanups.length) cleanup(cleanups.pop()!);
  delete process.env.C2C_STATE_DIR;
});

describe("active control result transport", () => {
  it("treats received and acknowledged mailbox BOOT results as transport mismatches", () => {
    const root = makeTmpDir("control-transport-policy");
    cleanups.push(root);
    const gateway = new MachineGateway({ surfaceValidator: requireCurrentTurnSurface });
    expect(gateway.resultTransport).toBe("computer_use");
    const registration = gateway.registerWorkspace(root);
    const identity = { ...registration, localSessionId };
    const page = gateway.surfaceClaim(identity, {
      browserId: "iab",
      surfaceId: "chatgpt",
      tabId: "tab-transport-policy",
      projectUrl,
      projectSelection: projectSelection(projectUrl),
      chatUrl: `${projectUrl.replace("/project", "")}/c/transport-policy`,
      ownerProcessEpoch: "owner-transport-policy",
      leaseTtlMs: 60_000,
    });
    const { request, correlation } = openBootRequest(gateway, identity, page);

    const received = getControlResultStatus(registration.workspaceId, request.requestId, localSessionId, correlation);
    expect(controlWaitPolicy(received)).toMatchObject({
      outcome: "transport_mismatch",
      state: "transport_mismatch",
      result: null,
    });

    acknowledgeControlResult(registration.workspaceId, request.requestId, localSessionId, correlation);
    const acknowledged = getControlResultStatus(registration.workspaceId, request.requestId, localSessionId, correlation);
    expect(controlWaitPolicy(acknowledged)).toMatchObject({
      outcome: "transport_mismatch",
      state: "transport_mismatch",
      result: null,
    });
  });

  it("rejects dormant mailbox BOOT at default gateway commit and ack, while explicit mailbox mode consumes it", () => {
    const root = makeTmpDir("control-transport-gateway");
    cleanups.push(root);
    const gateway = new MachineGateway({ surfaceValidator: requireCurrentTurnSurface });
    const registration = gateway.registerWorkspace(root);
    const identity = { ...registration, localSessionId };
    const page = gateway.surfaceClaim(identity, {
      browserId: "iab",
      surfaceId: "chatgpt",
      tabId: "tab-transport-gateway",
      projectUrl,
      projectSelection: projectSelection(projectUrl),
      chatUrl: `${projectUrl.replace("/project", "")}/c/transport-gateway`,
      ownerProcessEpoch: "owner-transport-gateway",
      leaseTtlMs: 60_000,
    });
    const { request, correlation } = openBootRequest(gateway, identity, page);

    expect(() => gateway.surfaceCommit(identity, page, { bootRequestId: request.requestId }))
      .toThrow(/active result transport/);
    expect(() => gateway.acknowledgeControlResult(identity, request.requestId, correlation))
      .toThrow(/inactive transport/);
    expect(getControlResultStatus(registration.workspaceId, request.requestId, localSessionId, correlation).status)
      .toBe("received");

    const mailboxGateway = new MachineGateway({
      surfaceValidator: requireCurrentTurnSurface,
      resultTransport: "mailbox",
    });
    const mailboxRegistration = mailboxGateway.registerWorkspace(root);
    const mailboxIdentity = { ...mailboxRegistration, localSessionId: "session-explicit-mailbox" };
    const mailboxPage = mailboxGateway.surfaceClaim(mailboxIdentity, {
      browserId: "iab",
      surfaceId: "chatgpt",
      tabId: "tab-explicit-mailbox",
      projectUrl,
      projectSelection: projectSelection(projectUrl),
      chatUrl: `${projectUrl.replace("/project", "")}/c/explicit-mailbox`,
      ownerProcessEpoch: "owner-explicit-mailbox",
      leaseTtlMs: 60_000,
    });
    const mailboxBoot = openBootRequest(mailboxGateway, mailboxIdentity, mailboxPage);
    const commit = mailboxGateway.surfaceCommit(mailboxIdentity, mailboxPage, {
      bootRequestId: mailboxBoot.request.requestId,
    });
    expect(commit).toBeDefined();
    expect(getControlResultStatus(
      mailboxRegistration.workspaceId,
      mailboxBoot.request.requestId,
      mailboxIdentity.localSessionId,
      mailboxBoot.correlation,
    ).status).toBe("acknowledged");
  });

  it("redacts inactive mailbox results in CLI control and surface projections", async () => {
    workspaceRoot = makeTmpDir("control-transport-cli");
    cleanups.push(workspaceRoot);
    machine = await startManagedMachineFixture(stateDir);

    const claim = runJson([
      "surface", "claim",
      "--project-selection", JSON.stringify(projectSelection(projectUrl)),
      "-w", workspaceRoot,
      "--local-session", localSessionId,
      "--tab-id", "tab-transport-cli",
      "--project-url", projectUrl,
      "--chat-url", `${projectUrl.replace("/project", "")}/c/transport-cli`,
    ]);
    expect(claim.command.status).toBe(0);
    const lease = claim.body.lease as { tabId: string; generation: number };

    const opened = runJson([
      "control", "open", "-w", workspaceRoot,
      "--local-session", localSessionId,
      "--task", taskId,
      "--iteration", "0",
      "--phase", "BOOT",
    ]);
    expect(opened.command.status).toBe(0);
    const request = opened.body.request as { requestId: string };
    const workspaceId = new Workspace(workspaceRoot).id;
    const correlation = { taskId, iteration: 0, phase: "BOOT" as const };
    submitControlResult(workspaceId, {
      requestId: request.requestId,
      localSessionId,
      ...correlation,
      kind: "BLOCKED",
      payload: { reason: mailboxMarker, needs: ["resume with the active result transport"] },
    });

    const lookup = ["-w", workspaceRoot, "--local-session", localSessionId, "--request", request.requestId];
    const assertMismatch = (body: Record<string, unknown>, status: "received" | "acknowledged") => {
      expect(body).toMatchObject({
        ok: false,
        status,
        result: null,
        wait: { outcome: "transport_mismatch", state: "transport_mismatch", result: null },
      });
    };

    for (const status of ["received", "acknowledged"] as const) {
      const statusResult = runJson(["control", "status", ...lookup]);
      expect(statusResult.command.status).not.toBe(0);
      assertMismatch(statusResult.body, status);

      const waitResult = runJson(["control", "wait", ...lookup, "--timeout-ms", "0"]);
      expect(waitResult.command.status).not.toBe(0);
      assertMismatch(waitResult.body, status);

      if (status === "received") {
        const surfaceLookup = ["-w", workspaceRoot, "--local-session", localSessionId];
        for (const args of [
          ["surface", "get", ...surfaceLookup],
          ["surface", "check", ...surfaceLookup,
            "--tab-id", lease.tabId, "--generation", String(lease.generation),
            "--page-state", "ready", "--observed-url", `${projectUrl.replace("/project", "")}/c/transport-cli`],
        ]) {
          const surface = runJson(args);
          expect(surface.command.status).toBe(0);
          expect(surface.body).toMatchObject({
            ok: true,
            control: { status: "received", result: null },
            wait: { outcome: "transport_mismatch", state: "transport_mismatch", result: null },
          });
          expect(surface.command.stdout + surface.command.stderr).not.toContain(mailboxMarker);
        }
        const plainWait = runCli(["control", "wait", ...lookup, "--timeout-ms", "0"]);
        expect(plainWait.status).not.toBe(0);
        expect(plainWait.stdout + plainWait.stderr).not.toContain(mailboxMarker);
        acknowledgeControlResult(workspaceId, request.requestId, localSessionId, correlation);
      }
    }
  }, 60_000);
});
