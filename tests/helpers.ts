import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { observeMachineRuntime } from "../src/gateway/runtime.js";
import type { MachineRuntimeState } from "../src/gateway/runtime.js";
import { observeMailboxPage, type MailboxIdentity } from "../src/gateway/control-client.js";
import { bindMachineConnector, connectorMachine } from "../src/gateway/connector-binding.js";
import { machineHttpPort } from "../src/process/machine-daemon.js";
import { vi } from "vitest";
import type { MachineGateway, MachineSurfaceIdentity } from "../src/gateway/machine-gateway.js";
import { submitControlResult } from "../src/control/mailbox.js";
import type { ControlResultCorrelation, ControlResultSubmission } from "../src/control/result-schema.js";
import { CONTROL_RESULT_FINAL_STABILITY_MS } from "../src/control/wait-policy.js";
import type { SurfaceLease } from "../src/session/surface-ownership.js";

export function projectSelection(projectUrl: string) {
  return { source: "user-confirmed" as const, projectUrl, observedTitle: "Explicit fixture Project", observedAt: new Date().toISOString() };
}

/** Create the authoritative BOOT receipt required before a gateway route commit. */
export function receiveBootResult(
  gateway: MachineGateway,
  identity: MachineSurfaceIdentity,
  lease: SurfaceLease,
): string {
  const taskId = `boot-${lease.generation}`;
  const { request } = gateway.openControlResultRequest(identity, {
    taskId,
    iteration: 0,
    phase: "BOOT",
  });
  if (gateway.resultTransport === "mailbox") {
    submitControlResult(identity.workspaceId, {
      requestId: request.requestId,
      localSessionId: identity.localSessionId,
      taskId,
      iteration: 0,
      phase: "BOOT",
      kind: "BOOT",
      payload: {},
    });
    return request.requestId;
  }

  const wasUsingFakeTimers = vi.isFakeTimers();
  if (!wasUsingFakeTimers) vi.useFakeTimers({ toFake: ["Date"] });
  const initialTime = Date.now();
  try {
    gateway.issueTurn({
      ...identity,
      taskId,
      iteration: 0,
      phase: "BOOT",
      requestId: request.requestId,
      scopes: ["c2c.result.write"],
      compactionEpoch: 0,
      generation: lease.generation,
    });
    const projectUrl = lease.projectUrl;
    const chatUrl = lease.chatUrl ?? projectUrl;
    const responseId = `boot-response-${lease.generation}`;
    const base = {
      tabId: lease.tabId,
      generation: lease.generation,
      responseToRequestId: request.requestId,
      observedAt: new Date().toISOString(),
    };
    gateway.observeControlPage(identity, request.requestId, { taskId, iteration: 0, phase: "BOOT" }, {
      ...base, observedUrl: projectUrl, observationSequence: 1, state: "send_attempted",
    });
    gateway.observeControlPage(identity, request.requestId, { taskId, iteration: 0, phase: "BOOT" }, {
      ...base, observedUrl: projectUrl, observationSequence: 2, state: "sent",
    });
    const responseBase = { ...base, observedUrl: chatUrl, responseId };
    gateway.observeControlPage(identity, request.requestId, { taskId, iteration: 0, phase: "BOOT" }, {
      ...responseBase, observationSequence: 3, state: "response_created",
    });
    const result = { kind: "BOOT" as const, payload: {} };
    const completionEvidence = { responseActionsVisible: true as const, stopControlAbsent: true as const };
    gateway.observeControlPage(identity, request.requestId, { taskId, iteration: 0, phase: "BOOT" }, {
      ...responseBase,
      observationSequence: 4,
      state: "result_candidate",
      responseIsFinal: true,
      delivery: "computer_use",
      terminalResult: result,
      completionEvidence,
    });
    vi.setSystemTime(initialTime + 1_500);
    gateway.observeControlPage(identity, request.requestId, { taskId, iteration: 0, phase: "BOOT" }, {
      ...responseBase,
      observedAt: new Date().toISOString(),
      observationSequence: 5,
      state: "final",
      responseIsFinal: true,
      delivery: "computer_use",
      terminalResult: result,
      completionEvidence,
    });
  } finally {
    vi.setSystemTime(initialTime);
    if (!wasUsingFakeTimers) vi.useRealTimers();
  }
  return request.requestId;
}

/** Submit a synthetic Computer Use response through the managed Gateway boundary. */
export async function observeComputerUseResultForTest(
  runtime: MachineRuntimeState,
  identity: MailboxIdentity,
  request: { requestId: string } & ControlResultCorrelation,
  page: { tabId: string; generation: number; projectUrl: string; chatUrl: string },
  result: ControlResultSubmission,
): Promise<void> {
  const responseId = `response-${request.requestId}`;
  const sendUrl = request.phase === "BOOT" ? page.projectUrl : page.chatUrl;
  const observe = (
    observationSequence: number,
    state: "send_attempted" | "sent" | "response_created" | "result_candidate" | "final",
    observedUrl: string,
    includeResult = false,
  ) => observeMailboxPage(runtime, identity, {
    requestId: request.requestId,
    taskId: request.taskId,
    iteration: request.iteration,
    phase: request.phase,
    observation: {
      tabId: page.tabId,
      generation: page.generation,
      observedUrl,
      observedAt: new Date().toISOString(),
      responseToRequestId: request.requestId,
      observationSequence,
      state,
      ...(observationSequence >= 3 ? { responseId } : {}),
      ...(includeResult ? {
        responseIsFinal: true,
        delivery: "computer_use",
        terminalResult: result,
        completionEvidence: { responseActionsVisible: true, stopControlAbsent: true },
      } : {}),
    },
  });

  await observe(1, "send_attempted", sendUrl);
  await observe(2, "sent", sendUrl);
  await observe(3, "response_created", page.chatUrl);
  await observe(4, "result_candidate", page.chatUrl, true);
  await new Promise((resolve) => setTimeout(resolve, CONTROL_RESULT_FINAL_STABILITY_MS));
  await observe(5, "final", page.chatUrl, true);
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testRoot = path.join(projectRoot, ".tooling", "test-tmp");

// Unversioned fixtures must not inherit the real checkout's Git identity or
// shared project state. Repositories initialized inside a fixture still work.
process.env.GIT_CEILING_DIRECTORIES = [testRoot, process.env.GIT_CEILING_DIRECTORIES]
  .filter(Boolean).join(path.delimiter);

/**
 * Temp dirs live inside the repo (.tooling/test-tmp) so tests also run in
 * sandboxed environments where the system temp dir is not writable.
 */
export function makeTmpDir(name: string): string {
  const dir = path.join(testRoot, `${name}-${randomBytes(4).toString("hex")}`);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync.native(dir);
}

export function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

export function write(dir: string, rel: string, content: string): string {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "c2c-test",
  GIT_AUTHOR_EMAIL: "test@c2c.local",
  GIT_COMMITTER_NAME: "c2c-test",
  GIT_COMMITTER_EMAIL: "test@c2c.local",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

export function git(dir: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: GIT_ENV });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

export function makeGitRepo(dir: string): void {
  git(dir, "init", "-b", "main");
  write(dir, "hello.txt", "Hello from Codex with ChatGPT!\n");
  write(dir, "src/index.ts", "export const answer = 42;\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "initial commit");
}

/** Point the persistent state dir at an isolated temp location. */
export function isolateStateDir(): string {
  const dir = makeTmpDir("state");
  process.env.C2C_STATE_DIR = dir;
  return dir;
}

/**
 * Start the machine gateway over HTTP on an isolated state dir.
 *
 * The fixture spawns `serve-http` directly. It used to fake an official
 * tunnel status command, which no longer exists now that the gateway owns its
 * own process and is reached through a public endpoint.
 */
/**
 * Ask the OS for a free loopback port and release it immediately. The
 * hand-off is not atomic, but the window is small and each fixture retries
 * through the normal health deadline if it loses the race.
 */
async function reservePort(): Promise<number> {
  const net = await import("node:net");
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("could not reserve a port"))));
    });
  });
}

export interface ManagedMachineFixture {
  child: ChildProcess;
  environment: NodeJS.ProcessEnv;
  close(): Promise<void>;
}

export async function startManagedMachineFixture(stateDir: string): Promise<ManagedMachineFixture> {
  // Each fixture needs its own port. A pid-derived value is not enough:
  // vitest runs several files per worker, so two files would compute the same
  // number and the second gateway would fail with EADDRINUSE. Production
  // always resolves the default the tunnel is configured against.
  const port = await reservePort();
  const environment: NodeJS.ProcessEnv = {
    NODE_NO_WARNINGS: "1",
    C2C_HTTP_PORT: String(port),
  };
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx/esm",
      path.join(projectRoot, "src", "cli", "index.ts"),
      "serve-http",
      "--port",
      String(port),
    ],
    {
      cwd: projectRoot,
      env: { ...process.env, ...environment, C2C_STATE_DIR: stateDir },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-4_096);
  });

  const deadline = Date.now() + 20_000;
  for (;;) {
    const observation = await observeMachineRuntime();
    if (observation.state === "healthy") break;
    if (child.exitCode !== null) {
      throw new Error(`managed machine fixture exited (${child.exitCode}): ${stderr}`);
    }
    if (Date.now() >= deadline) {
      child.kill("SIGTERM");
      throw new Error(`managed machine fixture did not become healthy: ${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  bindMachineConnector(connectorMachine(), { name: "Codex with ChatGPT" });
  return {
    child,
    environment,
    async close(): Promise<void> {
      if (child.exitCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      await exited;
    },
  };
}

  export function pkceVerifierAndChallenge(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}
