import type {
  IssueTurnCapabilityInput,
  TurnCapabilityGrant,
} from "./turn-capability.js";
import type {
  MachineSurfaceIdentity,
  MachineSurfaceCommitOptions,
  TurnCancellationBinding,
} from "./machine-gateway.js";
import type { MachineRuntimeState } from "./runtime.js";
import type {
  ClaimSurfaceOptions,
  SurfaceBinding,
  SurfaceLease,
  SurfaceLeaseRef,
  RetireSurfaceSessionResult,
  VerifiedSurfaceRouteCommit,
} from "../session/surface-ownership.js";
import type {
  ControlResultCorrelation,
} from "../control/result-schema.js";
import type {
  ControlRequestSnapshot,
  LegacyControlMailboxCleanupResult,
  OpenControlRequestStatus,
  RetireControlRequestSessionSummary,
} from "../control/requests.js";
import {
  assertChatGPTSurfaceIdentity,
  CHATGPT_BROWSER_ID,
  CHATGPT_SURFACE_ID,
} from "../session/surface-ownership.js";

const DEFAULT_ADMIN_TIMEOUT_MS = 60_000;

export class MachineAdminError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "MachineAdminError";
  }
}

export interface MachineRegistrationIdentity {
  workspaceId: string;
  projectId: string;
  registrationId: string;
}

export interface RegisterWorkspaceResponse extends MachineRegistrationIdentity {
  workspaceName: string;
}

export interface UnregisterWorkspaceResponse {
  unregistered: boolean;
}

export interface CancelTurnResponse {
  cancelled: boolean;
}

export interface RevokeRequestResponse {
  revoked: number;
}

export interface SurfaceViewResponse {
  projectUrl: string | null;
  lease: SurfaceLease | null;
  binding: SurfaceBinding | null;
  control: ControlRequestSnapshot | null;
}

export type SurfaceRetireResponse = RetireSurfaceSessionResult & {
  revokedContexts: number;
  controlRequests: RetireControlRequestSessionSummary;
};

export interface SurfaceIdentity extends MachineSurfaceIdentity {}

export interface ControlIdentity extends MachineSurfaceIdentity {}

export interface OpenControlRequestInput extends ControlResultCorrelation {
  ttlMs?: number;
}

export interface ControlLookupInput extends ControlResultCorrelation {
  requestId: string;
}

/**
 * Input for the *inspection* endpoints (`status`, `wait`, `observe`).
 *
 * The triple is optional: the gateway already stores it on the request, and ownership
 * is enforced by the local session, so `requestId` alone identifies the request.
 * Supply the triple to add a cross-check. A partial triple is rejected by the gateway
 * — pass all three or none.
 *
 * `cancel` requires the full correlation as a tripwire against settling the wrong request.
 */
export interface ControlInspectionInput
  extends Partial<Pick<ControlResultCorrelation, "taskId" | "iteration" | "phase">> {
  requestId: string;
}

export type ClearLegacyControlMailboxResponse = LegacyControlMailboxCleanupResult & {
  checkpointReferencesCleared: number;
};

function surfaceLeaseRef(lease: SurfaceLeaseRef): SurfaceLeaseRef {
  assertChatGPTSurfaceIdentity(lease.browserId, lease.surfaceId);
  return {
    projectId: lease.projectId,
    localSessionId: lease.localSessionId,
    browserId: lease.browserId,
    surfaceId: lease.surfaceId,
    tabId: lease.tabId,
    generation: lease.generation,
    ownerProcessEpoch: lease.ownerProcessEpoch,
  };
}

/**
 * Make an authenticated JSON request to the loopback machine gateway.
 * The admin token is read from the validated runtime record and is never
 * included in an error message or returned response.
 *
 * The fourth argument is the optional JSON body. For callers that only need a
 * custom timeout, a number may be passed there as a shorthand.
 */
export async function adminFetch<T = unknown>(
  runtime: MachineRuntimeState,
  method: "GET" | "POST",
  route: string,
  body?: unknown,
  timeoutMs = DEFAULT_ADMIN_TIMEOUT_MS
): Promise<T> {
  const requestBody = typeof body === "number" ? undefined : body;
  const requestTimeoutMs = typeof body === "number" ? body : timeoutMs;
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
    throw new Error("machine admin timeout must be a positive integer");
  }
  if (
    !Number.isInteger(runtime.port) ||
    runtime.port < 1 ||
    runtime.port > 65_535 ||
    typeof route !== "string" ||
    !route.startsWith("/") ||
    /[\r\n]/.test(route)
  ) {
    throw new Error("machine admin request target is invalid");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${runtime.adminToken}`,
    };
    if (requestBody !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`http://127.0.0.1:${runtime.port}${route}`, {
      method,
      headers,
      body: requestBody === undefined ? undefined : JSON.stringify(requestBody),
      signal: controller.signal,
    });
    const parsed = (await response.json().catch(() => undefined)) as
      | { error?: unknown; message?: unknown }
      | undefined;
    if (!response.ok) {
      const code = typeof parsed?.error === "string" ? parsed.error : undefined;
      const message = route === "/admin/preflight" && response.status === 404
        ? "Machine Gateway preflight endpoint is unavailable (HTTP 404). The installed CLI and Gateway may be from different versions; verify they match. A 404 can also hide an invalid admin token, so confirm the machine credentials before concluding there is a version mismatch."
        : typeof parsed?.message === "string" ? parsed.message : `Admin request failed (${response.status})`;
      throw new MachineAdminError(message, response.status, code);
    }
    return parsed as T;
  } finally {
    clearTimeout(timer);
  }
}

export function registerWorkspace(
  runtime: MachineRuntimeState,
  root: string,
  timeoutMs = DEFAULT_ADMIN_TIMEOUT_MS
): Promise<RegisterWorkspaceResponse> {
  return adminFetch(runtime, "POST", "/admin/workspaces/register", { root }, timeoutMs);
}

export function preflight(runtime: MachineRuntimeState, root: string, localSessionId: string) {
  return adminFetch<{
    registration: RegisterWorkspaceResponse | null;
    surface: SurfaceViewResponse | null;
  }>(runtime, "POST", "/admin/preflight", { root, localSessionId });
}

export function issueTurn(
  runtime: MachineRuntimeState,
  input: IssueTurnCapabilityInput,
  timeoutMs = DEFAULT_ADMIN_TIMEOUT_MS
): Promise<TurnCapabilityGrant> {
  return adminFetch(runtime, "POST", "/admin/turns/issue", input, timeoutMs);
}

export function cancelTurn(
  runtime: MachineRuntimeState,
  contextId: string,
  expected?: TurnCancellationBinding,
  timeoutMs = DEFAULT_ADMIN_TIMEOUT_MS
): Promise<CancelTurnResponse> {
  return adminFetch(
    runtime,
    "POST",
    "/admin/turns/cancel",
    { contextId, ...(expected ? { expected } : {}) },
    timeoutMs,
  );
}

export function revokeRequest(
  runtime: MachineRuntimeState,
  binding: TurnCancellationBinding,
  timeoutMs = DEFAULT_ADMIN_TIMEOUT_MS,
): Promise<RevokeRequestResponse> {
  return adminFetch(runtime, "POST", "/admin/turns/revoke-request", binding, timeoutMs);
}

export function unregisterWorkspace(
  runtime: MachineRuntimeState,
  identity: MachineRegistrationIdentity,
  timeoutMs = DEFAULT_ADMIN_TIMEOUT_MS
): Promise<UnregisterWorkspaceResponse> {
  return adminFetch(runtime, "POST", "/admin/workspaces/unregister", identity, timeoutMs);
}

export function getSurface(
  runtime: MachineRuntimeState,
  identity: SurfaceIdentity,
  timeoutMs = DEFAULT_ADMIN_TIMEOUT_MS,
): Promise<SurfaceViewResponse> {
  return adminFetch(runtime, "POST", "/admin/surfaces/get", identity, timeoutMs);
}

export function claimSurface(
  runtime: MachineRuntimeState,
  identity: SurfaceIdentity,
  input: Omit<ClaimSurfaceOptions, "projectId" | "localSessionId" | "browserId" | "surfaceId">,
  timeoutMs = DEFAULT_ADMIN_TIMEOUT_MS,
): Promise<{ lease: SurfaceLease }> {
  return adminFetch(runtime, "POST", "/admin/surfaces/claim", {
    ...identity,
    ...input,
    browserId: CHATGPT_BROWSER_ID,
    surfaceId: CHATGPT_SURFACE_ID,
    ...(input.replaces ? { replaces: surfaceLeaseRef(input.replaces) } : {}),
  }, timeoutMs);
}

export function commitSurface(
  runtime: MachineRuntimeState,
  identity: SurfaceIdentity,
  lease: SurfaceLeaseRef,
  options: MachineSurfaceCommitOptions,
  timeoutMs = DEFAULT_ADMIN_TIMEOUT_MS,
): Promise<VerifiedSurfaceRouteCommit> {
  return adminFetch(runtime, "POST", "/admin/surfaces/commit", {
    ...identity,
    lease: surfaceLeaseRef(lease),
    ...options,
  }, timeoutMs);
}

export function renewSurface(
  runtime: MachineRuntimeState,
  identity: SurfaceIdentity,
  lease: SurfaceLeaseRef,
  leaseTtlMs?: number,
  timeoutMs = DEFAULT_ADMIN_TIMEOUT_MS,
): Promise<{ lease: SurfaceLease }> {
  return adminFetch(
    runtime,
    "POST",
    "/admin/surfaces/renew",
    { ...identity, lease: surfaceLeaseRef(lease), ...(leaseTtlMs === undefined ? {} : { leaseTtlMs }) },
    timeoutMs,
  );
}

export function releaseSurface(
  runtime: MachineRuntimeState,
  identity: SurfaceIdentity,
  lease: SurfaceLeaseRef,
  timeoutMs = DEFAULT_ADMIN_TIMEOUT_MS,
): Promise<{ released: boolean }> {
  return adminFetch(runtime, "POST", "/admin/surfaces/release", {
    ...identity,
    lease: surfaceLeaseRef(lease),
  }, timeoutMs);
}

export function retireSurface(
  runtime: MachineRuntimeState,
  identity: SurfaceIdentity,
  timeoutMs = DEFAULT_ADMIN_TIMEOUT_MS,
): Promise<SurfaceRetireResponse> {
  return adminFetch(runtime, "POST", "/admin/surfaces/retire", identity, timeoutMs);
}

export function clearLegacyControlMailbox(
  runtime: MachineRuntimeState,
  identity: MachineRegistrationIdentity,
  timeoutMs = DEFAULT_ADMIN_TIMEOUT_MS,
): Promise<ClearLegacyControlMailboxResponse> {
  return adminFetch(runtime, "POST", "/admin/control/clear-legacy-mailbox", identity, timeoutMs);
}

function controlIdentityBody(identity: ControlIdentity): ControlIdentity {
  return {
    workspaceId: identity.workspaceId,
    projectId: identity.projectId,
    registrationId: identity.registrationId,
    localSessionId: identity.localSessionId,
  };
}

export function openControlRequest(
  runtime: MachineRuntimeState,
  identity: ControlIdentity,
  input: OpenControlRequestInput,
  timeoutMs = DEFAULT_ADMIN_TIMEOUT_MS,
): Promise<OpenControlRequestStatus> {
  return adminFetch(runtime, "POST", "/admin/control/open", {
    ...controlIdentityBody(identity),
    ...input,
  }, timeoutMs);
}

export function getControlRequestStatus(
  runtime: MachineRuntimeState,
  identity: ControlIdentity,
  input: ControlInspectionInput,
  timeoutMs = DEFAULT_ADMIN_TIMEOUT_MS,
): Promise<ControlRequestSnapshot> {
  return adminFetch(runtime, "POST", "/admin/control/status", {
    ...controlIdentityBody(identity),
    ...input,
  }, timeoutMs);
}

export function waitForControlRequest(
  runtime: MachineRuntimeState,
  identity: ControlIdentity,
  input: ControlInspectionInput & { timeoutMs: number },
  timeoutMs = Math.max(DEFAULT_ADMIN_TIMEOUT_MS, input.timeoutMs + 5_000),
): Promise<ControlRequestSnapshot> {
  return adminFetch(runtime, "POST", "/admin/control/wait", {
    ...controlIdentityBody(identity),
    ...input,
  }, timeoutMs);
}

export function cancelControlRequest(
  runtime: MachineRuntimeState,
  identity: ControlIdentity,
  input: ControlLookupInput,
  timeoutMs = DEFAULT_ADMIN_TIMEOUT_MS,
): Promise<ControlRequestSnapshot> {
  return adminFetch(runtime, "POST", "/admin/control/cancel", {
    ...controlIdentityBody(identity),
    ...input,
  }, timeoutMs);
}

export function observeControlRequest(
  runtime: MachineRuntimeState,
  identity: ControlIdentity,
  input: ControlInspectionInput & { observation: unknown },
  timeoutMs = DEFAULT_ADMIN_TIMEOUT_MS,
): Promise<ControlRequestSnapshot> {
  return adminFetch(runtime, "POST", "/admin/control/observe", {
    ...controlIdentityBody(identity), ...input,
  }, timeoutMs);
}
