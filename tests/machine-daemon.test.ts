import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearMachineRuntime,
  machineRuntimeFile,
  readMachineRuntime,
  writeMachineRuntime,
  type MachineRuntimeState,
} from "../src/gateway/runtime.js";
import {
  ensureMachineGateway,
  DEFAULT_MACHINE_HTTP_PORT,
  machineHttpCommand,
  machineHttpPort,
  observeManagedMachine,
  stopMachineGateway,
  withMachineSetupLock,
  withMachineStartLock,
} from "../src/process/machine-daemon.js";
import { runtimeEntryPath } from "../src/config/runtime-install.js";
import { SERVICE_NAME, VERSION } from "../src/version.js";
import { cleanup, isolateStateDir } from "./helpers.js";

const cleanupDirs: string[] = [];
const ASSOCIATION_ID = `assoc-${"c".repeat(32)}`;
const ASSOCIATION_NONCE = "n".repeat(43);

function runtime(overrides: Partial<MachineRuntimeState> = {}): MachineRuntimeState {
  return {
    service: SERVICE_NAME,
    version: VERSION,
    machineId: `machine-${"a".repeat(32)}`,
    associationId: ASSOCIATION_ID,
    associationNonce: ASSOCIATION_NONCE,
    bootEpoch: "b".repeat(32),
    pid: process.pid,
    port: DEFAULT_MACHINE_HTTP_PORT,
    adminToken: `c2c_admin_${"x".repeat(32)}`,
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

function healthFor(machine: MachineRuntimeState): Response {
  return new Response(
    JSON.stringify({
      service: machine.service,
      version: machine.version,
      machineId: machine.machineId,
      associationId: machine.associationId,
      bootEpoch: machine.bootEpoch,
      status: "ok",
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearMachineRuntime();
  for (const dir of cleanupDirs.splice(0)) cleanup(dir);
  delete process.env.C2C_STATE_DIR;
});

describe("machine gateway lifecycle", () => {
  it("supervises serve-http on the fixed port a tunnel forwards to", () => {
    const stateRoot = isolateStateDir();
    cleanupDirs.push(stateRoot);
    const command = machineHttpCommand();

    expect(command.command).toBe(process.execPath);
    expect(command.args).toContain("serve-http");
    expect(command.args).toContain(runtimeEntryPath(stateRoot));
    // The port must be the recorded one: an ephemeral port would silently
    // break the tunnel that forwards to it.
    expect(command.args).toContain(String(DEFAULT_MACHINE_HTTP_PORT));
    expect(command.args[command.args.indexOf("--port") + 1]).toBe(String(DEFAULT_MACHINE_HTTP_PORT));
  });

  it("reuses a healthy gateway instead of starting a second one", async () => {
    cleanupDirs.push(isolateStateDir());
    const machine = runtime();
    writeMachineRuntime(machine);
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(healthFor(machine))));
    const spawnImpl = vi.fn();

    const result = await ensureMachineGateway({ spawnImpl: spawnImpl as never });

    expect(result.spawned).toBe(false);
    expect(result.runtime.pid).toBe(machine.pid);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("spawns the gateway when no healthy runtime exists", async () => {
    cleanupDirs.push(isolateStateDir());
    const machine = runtime();
    const spawnImpl = vi.fn(() => {
      writeMachineRuntime(machine);
      return { pid: machine.pid, unref: () => undefined } as never;
    });
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(healthFor(machine))));

    const result = await ensureMachineGateway({ spawnImpl: spawnImpl as never, pollIntervalMs: 1 });

    expect(result.spawned).toBe(true);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const [command, args] = spawnImpl.mock.calls[0] as unknown as [string, string[]];
    expect(command).toBe(process.execPath);
    expect(args).toContain("serve-http");
  });

  it("refuses to reuse a healthy gateway when a fresh transport epoch is required", async () => {
    cleanupDirs.push(isolateStateDir());
    const machine = runtime();
    writeMachineRuntime(machine);
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(healthFor(machine))));

    await expect(
      ensureMachineGateway({ requireFreshRuntime: true, spawnImpl: vi.fn() as never })
    ).rejects.toThrow(/already healthy/);
  });

  it("fails when the spawned gateway never becomes healthy", async () => {
    cleanupDirs.push(isolateStateDir());
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(new Response("nope", { status: 503 }))));
    const kill = vi.fn();
    const spawnImpl = vi.fn(() => ({ pid: 999_999, unref: () => undefined, kill }) as never);

    await expect(
      ensureMachineGateway({ spawnImpl: spawnImpl as never, startTimeoutMs: 40, pollIntervalMs: 5 })
    ).rejects.toThrow(/did not become healthy/);
  });

  it("refuses to stop a gateway whose ownership record does not match the live process", async () => {
    cleanupDirs.push(isolateStateDir());
    const machine = runtime();
    writeMachineRuntime(machine);
    // The record is ours, but the live process answers with a different identity.
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ service: SERVICE_NAME, status: "ok" }), { status: 200 }))
    ));

    await expect(stopMachineGateway({ pollIntervalMs: 1, stopTimeoutMs: 30 })).rejects.toThrow(
      /does not match this machine's ownership record/
    );
  });

  it("is idempotent when no gateway is running", async () => {
    cleanupDirs.push(isolateStateDir());
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(new Response("stopped", { status: 503 }))));

    await expect(stopMachineGateway()).resolves.toBe(false);
  });

  it("clears a stale runtime record whose process is gone", async () => {
    cleanupDirs.push(isolateStateDir());
    const machine = runtime({ pid: 999_999 });
    writeMachineRuntime(machine);
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(new Response("stopped", { status: 503 }))));

    await expect(stopMachineGateway()).resolves.toBe(false);
    expect(readMachineRuntime()).toBeNull();
  });

  it("serializes machine startup attempts with one machine-wide lock", async () => {
    const stateDir = isolateStateDir();
    cleanupDirs.push(stateDir);
    const order: string[] = [];
    let release: (() => void) | null = null;
    const first = withMachineStartLock(async () => {
      order.push("first-enter");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      order.push("first-exit");
    });
    const second = withMachineStartLock(async () => {
      order.push("second-enter");
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(["first-enter"]);
    release?.();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-enter", "first-exit", "second-enter"]);
  });

  it("serializes complete setup transactions with a machine-wide lock", async () => {
    const stateDir = isolateStateDir();
    cleanupDirs.push(stateDir);
    const order: string[] = [];
    let release: (() => void) | null = null;
    const first = withMachineSetupLock(async () => {
      order.push("first-enter");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      order.push("first-exit");
    });
    const second = withMachineSetupLock(async () => {
      order.push("second-enter");
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(["first-enter"]);
    release?.();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-enter", "first-exit", "second-enter"]);
  });

  it("reports readiness only when the gateway is healthy and an endpoint is recorded", async () => {
    const stateDir = isolateStateDir();
    cleanupDirs.push(stateDir);
    const machine = runtime();
    writeMachineRuntime(machine);
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(healthFor(machine))));

    const observation = await observeManagedMachine();
    expect(observation.gateway.state).toBe("healthy");
    // A healthy gateway alone is not reachable: the public URL must exist too.
    expect(observation.ready).toBe(false);
    expect(observation.endpoint).toBeNull();
  });

  it("keeps the runtime file inside the isolated state dir", () => {
    const stateDir = isolateStateDir();
    cleanupDirs.push(stateDir);
    expect(machineRuntimeFile().startsWith(path.resolve(stateDir))).toBe(true);
  });

  it("resolves the tunnel port from the environment, defaulting in production", () => {
    // Production must use the port the tunnel was configured against.
    expect(machineHttpPort({})).toBe(DEFAULT_MACHINE_HTTP_PORT);
    // Tests isolate themselves on their own port.
    expect(machineHttpPort({ C2C_HTTP_PORT: "23456" })).toBe(23_456);
    expect(() => machineHttpPort({ C2C_HTTP_PORT: "0" })).toThrow(/valid TCP port/);
    expect(() => machineHttpPort({ C2C_HTTP_PORT: "abc" })).toThrow(/valid TCP port/);
  });

  it("exposes the runtime record a tunnel forwards to", () => {
    cleanupDirs.push(isolateStateDir());
    const machine = runtime();
    writeMachineRuntime(machine);
    expect(fs.existsSync(machineRuntimeFile())).toBe(true);
    expect(readMachineRuntime()?.port).toBe(DEFAULT_MACHINE_HTTP_PORT);
  });
});
