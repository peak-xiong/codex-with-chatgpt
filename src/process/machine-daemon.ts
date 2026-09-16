import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { ensureDir, getStateDir, withFileLockAsync } from "../config/paths.js";
import { runtimeEntryPath } from "../config/runtime-install.js";
import {
  clearMachineRuntime,
  observeMachineRuntime,
  probeMachineRuntime,
  readMachineRuntime,
  type MachineRuntimeObservation,
  type MachineRuntimeState,
} from "../gateway/runtime.js";
import { publicEndpointStatus, type PublicEndpoint } from "../config/public-endpoint.js";

/**
 * Supervises the one machine-wide MCP gateway.
 *
 * Previously the official OpenAI Secure MCP Tunnel owned this process as its
 * stdio child, and the tunnel runtime key authenticated the transport. That
 * transport cannot connect on a network that resets the OpenAI endpoint at the
 * TLS SNI layer, so the gateway is now started directly and reached through a
 * public tunnel that forwards to a fixed loopback port. Because the transport
 * no longer authenticates anything, `POST /mcp` requires a bearer token.
 */

const MACHINE_START_LOCK_TIMEOUT_MS = 25_000;
const MACHINE_START_LOCK_STALE_MS = 3 * 60_000;
const MACHINE_SETUP_LOCK_TIMEOUT_MS = 5 * 60_000;
const MACHINE_SETUP_LOCK_STALE_MS = 10 * 60_000;
const DEFAULT_START_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 20_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const MACHINE_OPERATION_LOCK_FILE = "machine-gateway.lock";

/**
 * The loopback port a tunnel forwards to. It is a recorded value rather than
 * an ephemeral one: the tunnel configuration points at it, so a port that
 * changes between starts would silently break the public endpoint.
 */
export const DEFAULT_MACHINE_HTTP_PORT = 48_765;
export const MACHINE_HTTP_HOST = "127.0.0.1";

/**
 * Resolve the port. `C2C_HTTP_PORT` exists so parallel tests can each own a
 * distinct port; production always uses the default, which is the value the
 * tunnel is configured against.
 */
export function machineHttpPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.C2C_HTTP_PORT?.trim();
  if (!raw) return DEFAULT_MACHINE_HTTP_PORT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("C2C_HTTP_PORT must be a valid TCP port");
  }
  return parsed;
}

export interface EnsureMachineGatewayOptions {
  startTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Require a gateway with a new ownership epoch. */
  requireFreshRuntime?: boolean;
  /** Internal setup path: the caller already owns the machine operation lock. */
  machineLockHeld?: boolean;
  /** Test seam: launch the gateway in-process instead of spawning a child. */
  spawnImpl?: typeof spawn;
}

export interface EnsureMachineGatewayResult {
  runtime: MachineRuntimeState;
  spawned: boolean;
  endpoint: PublicEndpoint | null;
}

export interface StopMachineGatewayOptions {
  stopTimeoutMs?: number;
  pollIntervalMs?: number;
  machineLockHeld?: boolean;
}

export interface ManagedMachineObservation {
  endpoint: PublicEndpoint | null;
  ready: boolean;
  gateway: MachineRuntimeObservation;
}

/** One startup lock for the whole machine, independent of any workspace. */
export function withMachineStartLock<T>(action: () => Promise<T>): Promise<T> {
  const lockFile = path.join(ensureDir(path.join(getStateDir(), "locks")), MACHINE_OPERATION_LOCK_FILE);
  return withFileLockAsync(lockFile, action, {
    timeoutMs: MACHINE_START_LOCK_TIMEOUT_MS,
    staleMs: MACHINE_START_LOCK_STALE_MS,
  });
}

/** Serialize the complete machine setup transaction. */
export function withMachineSetupLock<T>(action: () => Promise<T>): Promise<T> {
  const lockFile = path.join(ensureDir(path.join(getStateDir(), "locks")), MACHINE_OPERATION_LOCK_FILE);
  return withFileLockAsync(lockFile, action, {
    timeoutMs: MACHINE_SETUP_LOCK_TIMEOUT_MS,
    staleMs: MACHINE_SETUP_LOCK_STALE_MS,
  });
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`${label} must be a positive integer`);
  return result;
}

function sameRuntimeIdentity(left: MachineRuntimeState, right: MachineRuntimeState): boolean {
  return left.machineId === right.machineId && left.bootEpoch === right.bootEpoch && left.pid === right.pid;
}

function clearRuntimeIfMatches(expected: MachineRuntimeState): void {
  try {
    const current = readMachineRuntime();
    if (current && sameRuntimeIdentity(current, expected)) clearMachineRuntime();
  } catch {
    // An unreadable or replaced runtime is never removed by this process.
  }
}

function uncertain(observation: Extract<MachineRuntimeObservation, { state: "unknown" }>): Error {
  return new Error(`Machine gateway state is uncertain (${observation.reason}); refusing to start another gateway.`);
}

/**
 * The exact command a spawned gateway runs. Resolved from the installed
 * runtime rather than the caller's checkout so a CLI run from a source tree
 * still supervises the deployed gateway.
 */
export function machineHttpCommand(stateRoot: string = getStateDir()): {
  command: string;
  args: string[];
} {
  return {
    command: process.execPath,
    args: [runtimeEntryPath(stateRoot), "serve-http", "--port", String(machineHttpPort())],
  };
}

/** Observe the gateway and the recorded public endpoint without starting anything. */
export async function observeManagedMachine(): Promise<ManagedMachineObservation> {
  const gateway = await observeMachineRuntime();
  const endpoint = publicEndpointStatus();
  return { endpoint, ready: gateway.state === "healthy" && endpoint !== null, gateway };
}

/**
 * Reuse a healthy gateway or start one. The gateway is spawned directly, so
 * this no longer depends on a third-party supervisor being reachable.
 */
export async function ensureMachineGateway(
  options: EnsureMachineGatewayOptions = {}
): Promise<EnsureMachineGatewayResult> {
  const startTimeoutMs = positiveInteger(options.startTimeoutMs, DEFAULT_START_TIMEOUT_MS, "machine start timeout");
  const pollIntervalMs = positiveInteger(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, "machine poll interval");

  const start = async (): Promise<EnsureMachineGatewayResult> => {
    const current = await observeMachineRuntime();
    if (current.state === "unknown" && current.reason !== "probe_failed") throw uncertain(current);
    if (options.requireFreshRuntime) {
      if (current.state === "healthy") {
        throw new Error("A gateway is already healthy; refusing to reuse it while replacing the transport.");
      }
    } else if (current.state === "healthy") {
      return { runtime: current.runtime, spawned: false, endpoint: publicEndpointStatus() };
    }
    if (current.state === "stopped" && current.runtime) clearRuntimeIfMatches(current.runtime);

    const { command, args } = machineHttpCommand();
    const spawnImpl = options.spawnImpl ?? spawn;
    const child: ChildProcess = spawnImpl(command, args, {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, C2C_STATE_DIR: getStateDir() },
    });
    const childPid = child.pid;
    if (!childPid) throw new Error("The machine gateway process could not be started");
    child.unref();

    const deadline = Date.now() + startTimeoutMs;
    for (;;) {
      const gateway = await observeMachineRuntime();
      if (gateway.state === "healthy") {
        return { runtime: gateway.runtime, spawned: true, endpoint: publicEndpointStatus() };
      }
      if (gateway.state === "unknown" && gateway.reason !== "probe_failed") throw uncertain(gateway);
      if (Date.now() >= deadline) {
        try {
          process.kill(childPid, "SIGTERM");
        } catch {
          // The child may already be gone.
        }
        throw new Error("The machine gateway did not become healthy before the startup deadline.");
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  };

  const initial = await observeMachineRuntime();
  if (!options.requireFreshRuntime && initial.state === "healthy") {
    return { runtime: initial.runtime, spawned: false, endpoint: publicEndpointStatus() };
  }
  return options.machineLockHeld ? start() : withMachineStartLock(start);
}

/** Stop the gateway this machine owns. */
export async function stopMachineGateway(options: StopMachineGatewayOptions = {}): Promise<boolean> {
  const stop = async (): Promise<boolean> => {
    const before = await observeMachineRuntime();
    if (before.state === "unknown" && before.reason !== "probe_failed") throw uncertain(before);
    if (before.state === "stopped") {
      if (before.runtime) clearRuntimeIfMatches(before.runtime);
      return false;
    }
    const runtime = before.runtime;
    if (!runtime) {
      throw new Error("The machine gateway is healthy but has no ownership record; refusing to stop it.");
    }
    // A runtime record outlives a crash, and a recycled PID would otherwise be
    // killed. The gateway's own health payload is the only proof the live
    // process is ours.
    if ((await probeMachineRuntime(runtime)) === null) {
      throw new Error("The running machine gateway does not match this machine's ownership record; refusing to stop it.");
    }
    try {
      process.kill(runtime.pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    const stopTimeoutMs = positiveInteger(options.stopTimeoutMs, DEFAULT_STOP_TIMEOUT_MS, "machine stop timeout");
    const pollIntervalMs = positiveInteger(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, "machine poll interval");
    const deadline = Date.now() + stopTimeoutMs;
    for (;;) {
      const gateway = await observeMachineRuntime();
      if (gateway.state === "stopped") {
        if (gateway.runtime) clearRuntimeIfMatches(gateway.runtime);
        return true;
      }
      if (gateway.state === "unknown" && gateway.reason !== "probe_failed") throw uncertain(gateway);
      if (Date.now() >= deadline) {
        throw new Error("The machine gateway did not exit before the shutdown deadline.");
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  };
  return options.machineLockHeld ? stop() : withMachineStartLock(stop);
}

/** Restart the gateway so a transport change takes effect on a fresh epoch. */
export async function restartMachineGateway(
  options: EnsureMachineGatewayOptions = {}
): Promise<EnsureMachineGatewayResult> {
  await stopMachineGateway({ machineLockHeld: options.machineLockHeld }).catch(() => undefined);
  return ensureMachineGateway({ ...options, requireFreshRuntime: true });
}
