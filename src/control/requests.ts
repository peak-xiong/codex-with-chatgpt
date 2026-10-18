import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  advanceControlPageObservation,
  controlHostFailureSchema,
  controlHostObservedResultSchema,
  controlTerminalObservationSchema,
  controlWaitPolicy,
  CONTROL_PAGE_CHECK_INTERVAL_MS,
  isExactLegacyControlPageObservationReplay,
  legacyFinalHostFailureSchema,
  parseLateControlPageObservation,
  parseControlPageObservation,
  parseStoredControlPageObservation,
  storedControlHostFailureSchema,
  type ControlHostFailure,
  type ControlHostObservedResult,
  type ControlPageObservation,
  type ControlPageObservationState,
  type StoredControlPageObservation,
  type ControlTerminalObservation,
} from "./wait-policy.js";
import {
  ensureDir,
  getStateDir,
  readJsonIfExists,
  withFileLock,
  writeSecureJson,
  writeSecureJsonExclusive,
} from "../config/paths.js";
import {
  allowedKindsForPhase,
  canonicalJson,
  ControlRequestError,
  MAX_C2C_ITERATION,
  type ControlPhase,
  type ControlResultCorrelation,
  type ControlResultRequest,
  parseControlResultSubmission,
  sha256Hex,
  validateControlId,
  validateBrowserTabId,
  validateLocalSessionId,
} from "./result-schema.js";

const REQUEST_TTL_MS = 30 * 60 * 1000;
const MIN_REQUEST_TTL_MS = 1_000;
const MAX_REQUEST_TTL_MS = 60 * 60_000;
const RETAIN_TERMINAL_MS = 7 * 24 * 60 * 60 * 1000;
const STORE_MIGRATION_VERSION = 1;

export type ControlRequestStatus =
  | "pending"
  | "expired"
  | "cancelled"
  | "not_found";

export interface OpenControlRequestInput extends ControlResultCorrelation {
  localSessionId: string;
  surfaceGeneration?: number;
  surfaceTabId?: string;
  ttlMs?: number;
}

export interface ControlRequestSnapshot {
  requestId: string;
  status: ControlRequestStatus;
  request: ControlResultRequest | null;
  hostFailure?: ControlHostFailure;
  hostObservedResult?: ControlHostObservedResult;
  pageObservation?: ControlPageObservationState;
  /** Correlated page evidence after authority ended; never an authorized delivery. */
  lateEvidence?: StoredControlPageObservation;
}

/**
 * Resolve the machine-owned control request root.
 *
 * Control results are security-sensitive coordination state. They must not be
 * stored below a checkout or any other workspace-writable directory: a local
 * process in that workspace could otherwise forge a request, result, or
 * terminal marker. The machine gateway is the production owner of this path.
 */
export function getControlRequestsDir(workspaceId: string): string {
  const resolvedWorkspaceId = validateControlId(workspaceId, "workspace id");
  ensureControlRequestStore(resolvedWorkspaceId);
  return workspaceDir(resolvedWorkspaceId);
}

function workspaceDir(workspaceId: string): string {
  return path.join(getStateDir(), "control-requests", validateControlId(workspaceId, "workspace id"));
}

function requestStoreRoot(workspaceId: string, root?: string): string {
  if (root !== undefined) return root;
  const resolvedWorkspaceId = validateControlId(workspaceId, "workspace id");
  ensureControlRequestStore(resolvedWorkspaceId);
  return workspaceDir(resolvedWorkspaceId);
}

function legacyWorkspaceDir(workspaceId: string): string {
  return path.join(getStateDir(), "control-mailbox", validateControlId(workspaceId, "workspace id"));
}

function requestsDir(workspaceId: string, root?: string): string {
  return path.join(requestStoreRoot(workspaceId, root), "requests");
}

function observationsDir(workspaceId: string, root?: string): string {
  return path.join(requestStoreRoot(workspaceId, root), "observations");
}

function cancelledDir(workspaceId: string, root?: string): string {
  return path.join(requestStoreRoot(workspaceId, root), "cancelled");
}

function activeDir(workspaceId: string, root?: string): string {
  return path.join(requestStoreRoot(workspaceId, root), "active");
}

function locksDir(workspaceId: string, root?: string): string {
  return path.join(requestStoreRoot(workspaceId, root), "locks");
}

function requestFile(workspaceId: string, requestId: string, root?: string): string {
  return path.join(requestsDir(workspaceId, root), `${validateControlId(requestId, "request id")}.json`);
}

function renewalFile(workspaceId: string, requestId: string, root?: string): string {
  return path.join(requestStoreRoot(workspaceId, root), "renewals", `${validateControlId(requestId, "request id")}.json`);
}

function observationFile(workspaceId: string, requestId: string, root?: string): string {
  return path.join(observationsDir(workspaceId, root), `${validateControlId(requestId, "request id")}.json`);
}

function cancelledFile(workspaceId: string, requestId: string, root?: string): string {
  return path.join(cancelledDir(workspaceId, root), `${validateControlId(requestId, "request id")}.json`);
}

function activeFile(workspaceId: string, localSessionId: string, root?: string): string {
  return path.join(activeDir(workspaceId, root), `${validateLocalSessionId(localSessionId)}.json`);
}

function requestLockFile(workspaceId: string, requestId: string): string {
  return path.join(locksDir(workspaceId), `${validateControlId(requestId, "request id")}.lock`);
}

function sessionLifecycleLockFile(workspaceId: string, localSessionId: string): string {
  const sessions = path.join(locksDir(workspaceId), "sessions");
  ensureDir(sessions);
  if (!safeRealDirectory(sessions, "control request session lock directory")) {
    integrityError("control request session lock directory is missing");
  }
  return path.join(
    sessions,
    `${validateLocalSessionId(localSessionId)}.lock`
  );
}

function pruneLockFile(workspaceId: string): string {
  return path.join(locksDir(workspaceId), "prune.lock");
}

function migrationFile(workspaceId: string): string {
  return path.join(workspaceDir(workspaceId), "migration-v1.json");
}

function maintenanceLockFile(workspaceId: string): string {
  ensureMigrationLockRoot();
  return path.join(getStateDir(), "control-requests", ".migration-locks", `${workspaceId}.maintenance.lock`);
}

function migrationLockFile(workspaceId: string): string {
  return path.join(getStateDir(), "control-requests", ".migration-locks", `${workspaceId}.lock`);
}

function ensureControlRequestRoot(): string {
  const stateRoot = path.resolve(getStateDir());
  ensureDir(stateRoot);
  if (!safeRealDirectory(stateRoot, "machine state root")) integrityError("machine state root is missing");
  const root = path.join(stateRoot, "control-requests");
  ensureDir(root);
  if (!safeRealDirectory(root, "control request store root")) integrityError("control request store root is invalid");
  return root;
}

function ensureMigrationLockRoot(): void {
  const root = ensureControlRequestRoot();
  const lockRoot = path.join(root, ".migration-locks");
  ensureDir(lockRoot);
  if (!safeRealDirectory(lockRoot, "control request migration lock root")) integrityError("control request migration lock root is invalid");
}

function validateControlRequestStoreDirectories(root: string): void {
  for (const directory of [...CONTROL_REQUEST_STORE_DIRECTORIES, "locks", "migration-source"]) {
    if (!safeRealDirectory(path.join(root, directory), `control request ${directory}`)) {
      integrityError(`control request ${directory} directory is missing`);
    }
  }
}

function integrityError(message: string): never {
  throw new ControlRequestError("CONTROL_REQUEST_INTEGRITY_ERROR", message);
}

function readStoredJson(file: string, label: string): unknown | null {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (stat && (stat.isSymbolicLink() || !stat.isFile())) {
    integrityError(`${label} must be a regular file`);
  }
  const value = readJsonIfExists<unknown>(file);
  if (value === null && fs.existsSync(file)) {
    integrityError(`${label} is unreadable or malformed`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function isCanonicalTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function observationMatchesRequestSurface(
  observation: StoredControlPageObservation,
  request: ControlResultRequest,
): boolean {
  return request.surfaceTabId !== null && request.surfaceGeneration !== null &&
    observation.tabId === request.surfaceTabId &&
    observation.generation === request.surfaceGeneration;
}

function storedId(value: unknown, label: string, validate = validateControlId): string {
  if (typeof value !== "string") integrityError(`${label} is missing`);
  try {
    const normalized = validate(value, label);
    if (normalized !== value) integrityError(`${label} is not canonical`);
    return normalized;
  } catch (error) {
    if (error instanceof ControlRequestError && error.code === "CONTROL_REQUEST_INTEGRITY_ERROR") throw error;
    return integrityError(`${label} is invalid`);
  }
}

type TerminalMarkerKind = "cancelled";

function terminalMarkerFile(
  workspaceId: string,
  requestId: string,
  kind: TerminalMarkerKind,
  root?: string,
): string {
  return cancelledFile(workspaceId, requestId, root);
}

function terminalMarkerTimestampField(_kind: TerminalMarkerKind): "cancelledAt" { return "cancelledAt"; }

function parseStoredHostFailure(
  value: unknown,
  requestId: string,
): ControlHostFailure | null {
  const current = storedControlHostFailureSchema.safeParse(value);
  if (current.success) return current.data;
  if (!isRecord(value) || value.state !== "blocked") return null;

  // Older terminal records predate ordered response observations. Normalize
  // them only for retained terminal-state reads; the synthetic identity never
  // participates in routing, renewal, or BOOT authorization.
  const legacy = legacyFinalHostFailureSchema.safeParse({
    ...value,
    state: "final",
    responseId: `legacy-${requestId}`,
    observationSequence: 1,
  });
  return legacy.success ? legacy.data : null;
}

function readTerminalMarker(
  workspaceId: string,
  request: ControlResultRequest,
  kind: TerminalMarkerKind,
  root?: string,
): { timestamp: string; hostFailure?: ControlHostFailure; hostObservedResult?: ControlHostObservedResult } | null {
  const value = readStoredJson(
    terminalMarkerFile(workspaceId, request.requestId, kind, root),
    `${kind} request marker`
  );
  if (value === null) return null;
  const timestampField = terminalMarkerTimestampField(kind);
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !hasExactKeys(value, [
      "schemaVersion",
      "requestId",
      "workspaceId",
      "localSessionId",
      "taskId",
      "iteration",
      "phase",
      timestampField,
      ...(kind === "cancelled" && value.hostFailure !== undefined ? ["hostFailure"] : []),
      ...(kind === "cancelled" && value.hostObservedResult !== undefined ? ["hostObservedResult"] : []),
    ])
  ) {
    integrityError(`${kind} request marker schema is invalid`);
  }
  const timestamp = value[timestampField];
  if (
    storedId(value.requestId, `${kind} marker request id`) !== request.requestId ||
    storedId(value.workspaceId, `${kind} marker workspace id`) !== workspaceId ||
    storedId(value.localSessionId, `${kind} marker local session id`) !== request.localSessionId ||
    storedId(value.taskId, `${kind} marker task id`) !== request.taskId ||
    value.iteration !== request.iteration ||
    value.phase !== request.phase ||
    !isCanonicalTimestamp(timestamp)
  ) {
    integrityError(`${kind} request marker does not match the exact control request`);
  }
  let hostFailure: ControlHostFailure | undefined;
  if (value.hostFailure !== undefined) {
    const parsed = parseStoredHostFailure(value.hostFailure, request.requestId);
    if (
      !parsed ||
      parsed.responseToRequestId !== request.requestId ||
      request.surfaceTabId === null ||
      request.surfaceGeneration === null ||
      parsed.tabId !== request.surfaceTabId ||
      parsed.generation !== request.surfaceGeneration
    ) {
      integrityError("cancelled request observation is invalid");
    }
    hostFailure = parsed;
  }
  let hostObservedResult: ControlHostObservedResult | undefined;
  if (value.hostObservedResult !== undefined) {
    const parsed = controlHostObservedResultSchema.safeParse(value.hostObservedResult);
    if (
      !parsed.success ||
      (hostFailure !== undefined && parsed.data.observedAt !== hostFailure.observedAt) ||
      !request.allowedKinds.includes(parsed.data.result.kind)
    ) {
      integrityError("cancelled request host-observed result is invalid");
    }
    hostObservedResult = parsed.data;
  }
  return {
    timestamp,
    ...(hostFailure ? { hostFailure } : {}),
    ...(hostObservedResult ? { hostObservedResult } : {}),
  };
}

function writeTerminalMarker(
  workspaceId: string,
  request: ControlResultRequest,
  kind: TerminalMarkerKind,
  hostFailure?: ControlHostFailure,
  hostObservedResult?: ControlHostObservedResult,
): void {
  const timestampField = terminalMarkerTimestampField(kind);
  const marker = {
    schemaVersion: 1,
    requestId: request.requestId,
    workspaceId,
    localSessionId: request.localSessionId,
    taskId: request.taskId,
    iteration: request.iteration,
    phase: request.phase,
    [timestampField]: new Date().toISOString(),
    ...(hostFailure ? { hostFailure } : {}),
    ...(hostObservedResult ? { hostObservedResult } : {}),
  };
  const file = terminalMarkerFile(workspaceId, request.requestId, kind);
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      writeSecureJsonExclusive(file, marker);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (readTerminalMarker(workspaceId, request, kind) !== null) return;
    }
  }
  throw new ControlRequestError(
    "CONTROL_REQUEST_INTEGRITY_ERROR",
    `${kind} request marker changed concurrently; retry`
  );
}

function normalizeCorrelation(correlation: ControlResultCorrelation): ControlResultCorrelation {
  const taskId = validateControlId(correlation.taskId, "task id");
  if (
    !Number.isInteger(correlation.iteration) ||
    correlation.iteration < 0 ||
    correlation.iteration > MAX_C2C_ITERATION
  ) {
    throw new ControlRequestError("INVALID_RESULT", "iteration must be an integer between 0 and 10000");
  }
  if (!(["BOOT", "RESEARCH", "PLAN", "REVIEW"] as const).includes(correlation.phase)) {
    throw new ControlRequestError("INVALID_RESULT", "phase must be BOOT, RESEARCH, PLAN, or REVIEW");
  }
  return { taskId, iteration: correlation.iteration, phase: correlation.phase };
}

function parseStoredRequest(
  value: unknown,
  workspaceId: string,
  requestId: string
): ControlResultRequest {
  const legacyKeys = [
    "schemaVersion",
    "requestId",
    "workspaceId",
    "localSessionId",
    "taskId",
    "iteration",
    "phase",
    "allowedKinds",
    "createdAt",
    "expiresAt",
  ] as const;
  const transitionalKeys = [...legacyKeys, "surfaceGeneration"] as const;
  const currentKeys = [...transitionalKeys, "surfaceTabId"] as const;
  const legacy = isRecord(value) && value.schemaVersion === 1 && hasExactKeys(value, legacyKeys);
  const transitional = isRecord(value) && value.schemaVersion === 1 && hasExactKeys(value, transitionalKeys);
  const current = isRecord(value) && value.schemaVersion === 2 && hasExactKeys(value, currentKeys);
  if (
    !isRecord(value) ||
    (!legacy && !transitional && !current)
  ) {
    integrityError("stored request schema is invalid");
  }
  const storedRequestId = storedId(value.requestId, "stored request id");
  const storedWorkspaceId = storedId(value.workspaceId, "stored workspace id");
  const localSessionId = storedId(value.localSessionId, "stored local session id");
  const taskId = storedId(value.taskId, "stored task id");
  const iteration = value.iteration;
  const phase = value.phase;
  if (
    !Number.isInteger(iteration) ||
    (iteration as number) < 0 ||
    (iteration as number) > MAX_C2C_ITERATION
  ) {
    integrityError("stored request iteration is invalid");
  }
  if (
    phase !== "BOOT" &&
    phase !== "RESEARCH" &&
    phase !== "PLAN" &&
    phase !== "REVIEW"
  ) {
    integrityError("stored request phase is invalid");
  }
  const surfaceGeneration = legacy ? null : value.surfaceGeneration;
  const surfaceTabId = current ? value.surfaceTabId : null;
  if (
    surfaceGeneration !== null &&
    (!Number.isSafeInteger(surfaceGeneration) || (surfaceGeneration as number) < 1)
  ) {
    integrityError("stored request surface generation is invalid");
  }
  if (surfaceTabId !== null) {
    storedId(surfaceTabId, "stored request surface tab id", validateBrowserTabId);
  }
  if ((surfaceGeneration === null) !== (surfaceTabId === null) && current) {
    integrityError("stored request surface identity is incomplete");
  }
  const expectedKinds = allowedKindsForPhase(phase);
  if (!Array.isArray(value.allowedKinds) || canonicalJson(value.allowedKinds) !== canonicalJson(expectedKinds)) {
    integrityError("stored request allowed kinds do not match its phase");
  }
  if (
    !isCanonicalTimestamp(value.createdAt) ||
    !isCanonicalTimestamp(value.expiresAt) ||
    Date.parse(value.expiresAt) <= Date.parse(value.createdAt)
  ) {
    integrityError("stored request timestamps are invalid");
  }
  if (storedRequestId !== requestId || storedWorkspaceId !== workspaceId) {
    integrityError("stored request does not match its control request path");
  }
  return {
    schemaVersion: 2,
    requestId: storedRequestId,
    workspaceId: storedWorkspaceId,
    localSessionId,
    taskId,
    iteration: iteration as number,
    phase,
    allowedKinds: expectedKinds,
    surfaceGeneration: surfaceGeneration as number | null,
    surfaceTabId: surfaceTabId as string | null,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
  };
}

function readRequest(workspaceId: string, requestId: string, root?: string): ControlResultRequest | null {
  const resolvedWorkspaceId = validateControlId(workspaceId, "workspace id");
  const resolvedRequestId = validateControlId(requestId, "request id");
  const resolvedRoot = requestStoreRoot(resolvedWorkspaceId, root);
  const value = readStoredJson(requestFile(resolvedWorkspaceId, resolvedRequestId, resolvedRoot), "stored request");
  return value === null ? null : applyRequestRenewal(parseStoredRequest(value, resolvedWorkspaceId, resolvedRequestId), resolvedRoot);
}

// A single atomic renewal record extends both immutable request copies without a two-file update.
function applyRequestRenewal(
  request: ControlResultRequest,
  root?: string,
): ControlResultRequest {
  const resolvedRoot = requestStoreRoot(request.workspaceId, root);
  const value = readStoredJson(renewalFile(request.workspaceId, request.requestId, resolvedRoot), "request renewal");
  if (value === null) return request;
  if (!isRecord(value) || !hasExactKeys(value, ["request", "expiresAt"])) {
    integrityError("request renewal schema is invalid");
  }
  const original = parseStoredRequest(value.request, request.workspaceId, request.requestId);
  if (
    canonicalJson(original) !== canonicalJson(request) ||
    !isCanonicalTimestamp(value.expiresAt) || Date.parse(value.expiresAt) < Date.parse(request.expiresAt)
  ) integrityError("request renewal does not match the original request");
  return { ...request, expiresAt: value.expiresAt };
}

function ensureRequestFile(workspaceId: string, request: ControlResultRequest): void {
  try {
    writeSecureJsonExclusive(requestFile(workspaceId, request.requestId), request);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = readRequest(workspaceId, request.requestId);
    if (!existing || canonicalJson(existing) !== canonicalJson(request)) {
      integrityError("stored request conflicts with the active request pointer");
    }
  }
}

function readActiveRequest(
  workspaceId: string,
  localSessionId: string,
  root?: string,
): ControlResultRequest | null {
  const resolvedRoot = requestStoreRoot(workspaceId, root);
  const value = readStoredJson(activeFile(workspaceId, localSessionId, resolvedRoot), "active request pointer");
  if (value === null) return null;
  if (!isRecord(value)) integrityError("active request pointer schema is invalid");
  const requestId = storedId(value.requestId, "active pointer request id");
  const request = parseStoredRequest(value, workspaceId, requestId);
  if (request.localSessionId !== localSessionId) {
    integrityError("active request pointer belongs to another local session");
  }
  return applyRequestRenewal(request, resolvedRoot);
}

function claimActiveRequest(workspaceId: string, request: ControlResultRequest): boolean {
  try {
    writeSecureJsonExclusive(activeFile(workspaceId, request.localSessionId), request);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

function clearActiveRequest(workspaceId: string, localSessionId: string, requestId: string): void {
  if (readActiveRequest(workspaceId, localSessionId)?.requestId === requestId) {
    fs.rmSync(activeFile(workspaceId, localSessionId), { force: true });
  }
}

function readPageObservation(
  workspaceId: string,
  request: ControlResultRequest,
  root?: string,
): ControlPageObservationState | null {
  const resolvedRoot = requestStoreRoot(workspaceId, root);
  const value = readStoredJson(
    observationFile(workspaceId, request.requestId, resolvedRoot),
    "stored page observation",
  );
  if (value === null) return null;
  const observationKeys = [
    "schemaVersion", "requestId", "workspaceId", "localSessionId", "latest", "lastDefinitive",
  ];
  const hasGatewayTimes = isRecord(value) &&
    value.latestAcceptedAt !== undefined && value.lastDefinitiveAcceptedAt !== undefined;
  if (
    !isRecord(value) || value.schemaVersion !== 1 ||
    (hasGatewayTimes
      ? !hasExactKeys(value, [...observationKeys, "latestAcceptedAt", "lastDefinitiveAcceptedAt", "observationHash"])
      : !hasExactKeys(value, [...observationKeys, "observationHash"]))
  ) {
    integrityError("stored page observation schema is invalid");
  }
  const requestId = storedId(value.requestId, "stored page observation request id");
  const storedWorkspaceId = storedId(value.workspaceId, "stored page observation workspace id");
  const localSessionId = storedId(value.localSessionId, "stored page observation local session id");
  if (
    requestId !== request.requestId ||
    storedWorkspaceId !== workspaceId ||
    localSessionId !== request.localSessionId
  ) {
    integrityError("stored page observation does not match the exact control request");
  }
  let latest: StoredControlPageObservation;
  let lastDefinitive: ControlPageObservationState["lastDefinitive"];
  try {
    latest = parseStoredControlPageObservation(value.latest);
    lastDefinitive = value.lastDefinitive === null
      ? null
      : parseStoredControlPageObservation(value.lastDefinitive) as ControlPageObservationState["lastDefinitive"];
  } catch {
    return integrityError("stored page observation payload is invalid");
  }
  if (
    latest.responseToRequestId !== request.requestId ||
    (lastDefinitive !== null && lastDefinitive.responseToRequestId !== request.requestId) ||
    !observationMatchesRequestSurface(latest, request) ||
    (lastDefinitive !== null && !observationMatchesRequestSurface(lastDefinitive, request)) ||
    (latest.state !== "unknown" && canonicalJson(latest) !== canonicalJson(lastDefinitive))
  ) {
    integrityError("stored page observation lifecycle is invalid");
  }
  if (hasGatewayTimes && (
    !isCanonicalTimestamp(value.latestAcceptedAt) ||
    (value.lastDefinitiveAcceptedAt !== null && !isCanonicalTimestamp(value.lastDefinitiveAcceptedAt))
  )) {
    integrityError("stored page observation gateway acceptance time is invalid");
  }
  const state: ControlPageObservationState = {
    latest,
    lastDefinitive,
    ...(hasGatewayTimes ? {
      latestAcceptedAt: value.latestAcceptedAt as string,
      lastDefinitiveAcceptedAt: value.lastDefinitiveAcceptedAt as string | null,
    } : {}),
  };
  const observationHash = sha256Hex(canonicalJson(state));
  if (value.observationHash !== observationHash) {
    integrityError("stored page observation integrity hash does not match its content");
  }
  return state;
}

function readLateEvidence(
  workspaceId: string,
  request: ControlResultRequest,
  root?: string,
): StoredControlPageObservation | undefined {
  const resolvedRoot = requestStoreRoot(workspaceId, root);
  const value = readStoredJson(
    lateEvidenceFile(workspaceId, request.requestId, resolvedRoot),
    "late page evidence",
  );
  if (value === null) return undefined;
  let lateEvidence: StoredControlPageObservation;
  try {
    lateEvidence = parseStoredControlPageObservation(value);
  } catch {
    return integrityError("late page evidence payload is invalid");
  }
  if (
    lateEvidence.state !== "final" ||
    lateEvidence.responseToRequestId !== request.requestId ||
    lateEvidence.tabId !== request.surfaceTabId ||
    lateEvidence.generation !== request.surfaceGeneration ||
    ("terminalResult" in lateEvidence && lateEvidence.terminalResult !== undefined &&
      !request.allowedKinds.includes(lateEvidence.terminalResult.kind))
  ) {
    integrityError("late evidence does not match the original request");
  }
  return lateEvidence;
}

function writePageObservation(
  workspaceId: string,
  request: ControlResultRequest,
  state: ControlPageObservationState,
): void {
  writeSecureJson(observationFile(workspaceId, request.requestId), {
    schemaVersion: 1,
    requestId: request.requestId,
    workspaceId,
    localSessionId: request.localSessionId,
    ...state,
    observationHash: sha256Hex(canonicalJson(state)),
  });
}

function isExpired(request: ControlResultRequest, now = Date.now()): boolean {
  return now > Date.parse(request.expiresAt);
}

function readTerminalState(
  workspaceId: string,
  request: ControlResultRequest,
  root?: string,
): {
  kind: TerminalMarkerKind;
  timestamp: string;
  hostFailure?: ControlHostFailure;
  hostObservedResult?: ControlHostObservedResult;
} | null {
  const resolvedRoot = requestStoreRoot(workspaceId, root);
  const cancelledAt = readTerminalMarker(workspaceId, request, "cancelled", resolvedRoot);
  if (cancelledAt) return { kind: "cancelled", ...cancelledAt };
  return null;
}

function isUnfinished(workspaceId: string, request: ControlResultRequest): boolean {
  if (readTerminalState(workspaceId, request) !== null) return false;
  return !isExpired(request);
}

function listRequests(workspaceId: string): ControlResultRequest[] {
  const dir = requestsDir(workspaceId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readRequest(workspaceId, name.slice(0, -".json".length)))
    .filter((request): request is ControlResultRequest => Boolean(request));
}

function matchesCorrelation(request: ControlResultRequest, expected: ControlResultCorrelation): boolean {
  return (
    request.taskId === expected.taskId &&
    request.iteration === expected.iteration &&
    request.phase === expected.phase
  );
}

function assertCorrelation(request: ControlResultRequest, expected: ControlResultCorrelation): void {
  const normalized = normalizeCorrelation(expected);
  if (!matchesCorrelation(request, normalized)) {
    throw new ControlRequestError(
      "CONTROL_REQUEST_CORRELATION_MISMATCH",
      "control result request does not match the expected task, iteration, and phase"
    );
  }
}

function turnInProgress(request: ControlResultRequest): never {
  throw new ControlRequestError(
    "CONTROL_REQUEST_TURN_IN_PROGRESS",
    `local session already has unfinished request ${request.requestId} ` +
      `(${request.taskId}/${request.iteration}/${request.phase}); resume or cancel it before asking another question`
  );
}

export function openControlRequest(
  workspaceId: string,
  input: OpenControlRequestInput
): ControlResultRequest {
  return openControlRequestWithStatus(workspaceId, input).request;
}

export interface OpenControlRequestStatus {
  request: ControlResultRequest;
  created: boolean;
}

/** Open a request and report whether this call created it or recovered it. */
export function openControlRequestWithStatus(
  workspaceId: string,
  input: OpenControlRequestInput
): OpenControlRequestStatus {
  const resolvedWorkspaceId = validateControlId(workspaceId, "workspace id");
  const localSessionId = validateLocalSessionId(input.localSessionId);
  const correlation = normalizeCorrelation(input);
  const ttlMs = input.ttlMs ?? REQUEST_TTL_MS;
  if (
    input.surfaceGeneration !== undefined &&
    (!Number.isSafeInteger(input.surfaceGeneration) || input.surfaceGeneration < 1)
  ) {
    throw new ControlRequestError("INVALID_RESULT", "surface generation must be a positive safe integer");
  }
  const surfaceTabId = input.surfaceTabId === undefined
    ? null
    : validateBrowserTabId(input.surfaceTabId, "surface tab id");
  if ((input.surfaceGeneration === undefined) !== (surfaceTabId === null)) {
    throw new ControlRequestError(
      "INVALID_RESULT",
      "surface generation and surface tab id must be supplied together",
    );
  }
  if (!Number.isInteger(ttlMs) || ttlMs < MIN_REQUEST_TTL_MS || ttlMs > MAX_REQUEST_TTL_MS) {
    throw new ControlRequestError(
      "INVALID_RESULT",
      `request lifetime must be an integer between ${MIN_REQUEST_TTL_MS} and ${MAX_REQUEST_TTL_MS} milliseconds`
    );
  }
  return withFileLock(maintenanceLockFile(resolvedWorkspaceId), () =>
    withFileLock(sessionLifecycleLockFile(resolvedWorkspaceId, localSessionId), () => {
    const activeRequest = readActiveRequest(resolvedWorkspaceId, localSessionId);
    if (activeRequest) {
      const unfinished = withFileLock(
        requestLockFile(resolvedWorkspaceId, activeRequest.requestId),
        () => isUnfinished(resolvedWorkspaceId, activeRequest),
      );
      if (unfinished) {
        if (!matchesCorrelation(activeRequest, correlation)) turnInProgress(activeRequest);
        ensureRequestFile(resolvedWorkspaceId, activeRequest);
        return { request: activeRequest, created: false };
      }
      clearActiveRequest(resolvedWorkspaceId, localSessionId, activeRequest.requestId);
    }

    const now = Date.now();
    const request: ControlResultRequest = {
      schemaVersion: 2,
      requestId: randomBytes(24).toString("hex"),
      workspaceId: resolvedWorkspaceId,
      localSessionId,
      taskId: correlation.taskId,
      iteration: correlation.iteration,
      phase: correlation.phase,
      allowedKinds: allowedKindsForPhase(correlation.phase),
      surfaceGeneration: input.surfaceGeneration ?? null,
      surfaceTabId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
    };
    if (!claimActiveRequest(resolvedWorkspaceId, request)) {
      integrityError("local session active request changed while its lifecycle lock was held");
    }
    try {
      ensureRequestFile(resolvedWorkspaceId, request);
      return { request, created: true };
    } catch (error) {
      clearActiveRequest(resolvedWorkspaceId, localSessionId, request.requestId);
      throw error;
    }
    }),
  );
}

function existingControlRequestStoreRoot(workspaceId: string): string | null {
  const stateRoot = path.resolve(getStateDir());
  if (!safeRealDirectory(stateRoot, "machine state root")) return null;
  const controlRoot = path.join(stateRoot, "control-requests");
  if (!safeRealDirectory(controlRoot, "control request store root")) return null;
  const root = workspaceDir(workspaceId);
  if (!safeRealDirectory(root, "control request workspace root")) {
    if (fs.lstatSync(root, { throwIfNoEntry: false })) {
      integrityError("control request workspace root is not a real directory");
    }
    return null;
  }
  validateMigrationMarker(workspaceId);
  validateControlRequestStoreDirectories(root);
  return root;
}

function hostObservedResultMatchesPageObservation(
  hostObservedResult: ControlHostObservedResult,
  pageObservation: ControlPageObservationState | null,
): boolean {
  const final = pageObservation?.lastDefinitive;
  if (!final) return false;
  const currentFinal = controlTerminalObservationSchema.safeParse(final);
  if (
    !currentFinal.success ||
    currentFinal.data.state !== "final" ||
    !("delivery" in currentFinal.data) ||
    currentFinal.data.delivery !== "computer_use"
  ) return false;
  return currentFinal.data.observedAt === hostObservedResult.observedAt &&
    canonicalJson(parseControlResultSubmission(currentFinal.data.terminalResult)) ===
      canonicalJson(hostObservedResult.result);
}

function controlRequestSnapshot(
  workspaceId: string,
  request: ControlResultRequest,
  localSessionId: string,
  expected?: ControlResultCorrelation,
  root?: string,
): ControlRequestSnapshot {
  if (request.localSessionId !== localSessionId) {
    throw new ControlRequestError("CONTROL_REQUEST_SESSION_MISMATCH", "control result request belongs to another local session");
  }
  if (expected) assertCorrelation(request, expected);
  const pageObservation = readPageObservation(workspaceId, request, root);
  const lateEvidence = readLateEvidence(workspaceId, request, root);
  const observed = { ...(pageObservation ? { pageObservation } : {}), ...(lateEvidence ? { lateEvidence } : {}) };
  const terminal = readTerminalState(workspaceId, request, root);
  const hostObservedResult = terminal?.hostObservedResult &&
    hostObservedResultMatchesPageObservation(terminal.hostObservedResult, pageObservation)
    ? terminal.hostObservedResult
    : undefined;
  if (terminal?.kind === "cancelled") {
    return { requestId: request.requestId, status: "cancelled", request, ...observed,
      ...(terminal.hostFailure ? { hostFailure: terminal.hostFailure } : {}),
      ...(hostObservedResult ? { hostObservedResult } : {}) };
  }
  if (isExpired(request)) {
    return { requestId: request.requestId, status: "expired", request, ...observed };
  }
  return { requestId: request.requestId, status: "pending", request, ...observed };
}

/** Read-only snapshot; the gateway serializes its synchronous state mutations. */
export function inspectActiveControlRequestStatus(workspaceId: string, localSessionId: string): ControlRequestSnapshot | null {
  const resolvedWorkspaceId = validateControlId(workspaceId, "workspace id");
  const resolvedLocalSessionId = validateLocalSessionId(localSessionId);
  if (!safeRealDirectory(path.resolve(getStateDir()), "machine state root")) return null;

  const root = existingControlRequestStoreRoot(resolvedWorkspaceId);
  if (root) {
    const request = readActiveRequest(resolvedWorkspaceId, resolvedLocalSessionId, root);
    return request
      ? controlRequestSnapshot(resolvedWorkspaceId, request, resolvedLocalSessionId, undefined, root)
      : null;
  }

  const legacyRoot = safeLegacyRoot(resolvedWorkspaceId);
  if (!legacyRoot) return null;
  const legacy = scanLegacyStore(resolvedWorkspaceId, legacyRoot);
  const requestId = legacy.active.get(resolvedLocalSessionId);
  if (!requestId) return null;
  const request = legacy.requests.get(requestId);
  if (!request) integrityError("legacy active request pointer has no matching Computer Use request");
  const terminal = legacy.terminal.get(requestId);
  const pageObservation = legacy.observations.get(requestId) ?? null;
  const hostObservedResult = terminal?.hostObservedResult &&
    hostObservedResultMatchesPageObservation(terminal.hostObservedResult, pageObservation)
    ? terminal.hostObservedResult
    : undefined;
  return {
    requestId,
    status: isExpired(request) ? "expired" : "pending",
    request,
    ...(pageObservation ? { pageObservation } : {}),
    ...(legacy.lateEvidence.has(requestId) ? { lateEvidence: legacy.lateEvidence.get(requestId)! } : {}),
    ...(terminal?.hostFailure ? { hostFailure: terminal.hostFailure } : {}),
    ...(hostObservedResult ? { hostObservedResult } : {}),
  };
}

/** Locate recovery work even when the checkout checkpoint was never written. */
export function getActiveControlRequestStatus(workspaceId: string, localSessionId: string): ControlRequestSnapshot | null {
  const resolvedWorkspaceId = validateControlId(workspaceId, "workspace id");
  const resolvedLocalSessionId = validateLocalSessionId(localSessionId);
  ensureControlRequestStore(resolvedWorkspaceId);
  return withFileLock(sessionLifecycleLockFile(resolvedWorkspaceId, resolvedLocalSessionId), () => {
    return inspectActiveControlRequestStatus(resolvedWorkspaceId, resolvedLocalSessionId);
  });
}

export function getControlRequestStatus(
  workspaceId: string,
  requestId: string,
  localSessionId: string,
  /**
   * Optional by design. The stored request already carries this triple, and
   * ownership is enforced by `localSessionId` above — so it is a redundant
   * cross-check, not an authorization input. Callers that supply it keep the
   * exact-match guarantee; callers that only know the request id can omit it
   * instead of having to guess the task/iteration/phase from memory.
   * `cancel` deliberately keeps passing it as a tripwire.
   */
  expected?: ControlResultCorrelation
): ControlRequestSnapshot {
  const resolvedWorkspaceId = validateControlId(workspaceId, "workspace id");
  const resolvedRequestId = validateControlId(requestId, "request id");
  const resolvedLocalSessionId = validateLocalSessionId(localSessionId);
  const request = readRequest(resolvedWorkspaceId, resolvedRequestId);
  if (!request) {
    return { requestId: resolvedRequestId, status: "not_found", request: null };
  }
  return controlRequestSnapshot(resolvedWorkspaceId, request, resolvedLocalSessionId, expected);
}

/** Require an authoritative successful BOOT result for one exact candidate generation. */
export function requireBootControlResult(
  workspaceId: string,
  requestId: string,
  localSessionId: string,
  surfaceGeneration: number,
  surfaceTabId: string,
): ControlRequestSnapshot {
  const resolvedWorkspaceId = validateControlId(workspaceId, "workspace id");
  const resolvedRequestId = validateControlId(requestId, "request id");
  const resolvedLocalSessionId = validateLocalSessionId(localSessionId);
  const request = readRequest(resolvedWorkspaceId, resolvedRequestId);
  if (!request) {
    throw new ControlRequestError("CONTROL_REQUEST_NOT_FOUND", "BOOT result request was not found");
  }
  if (
    request.localSessionId !== resolvedLocalSessionId ||
    request.phase !== "BOOT" ||
    request.surfaceGeneration !== surfaceGeneration ||
    request.surfaceTabId !== validateBrowserTabId(surfaceTabId, "surface tab id")
  ) {
    throw new ControlRequestError(
      "CONTROL_REQUEST_CORRELATION_MISMATCH",
      "BOOT result does not match this candidate surface generation",
    );
  }
  const expected = { taskId: request.taskId, iteration: request.iteration, phase: request.phase };
  const status = getControlRequestStatus(
    resolvedWorkspaceId,
    resolvedRequestId,
    resolvedLocalSessionId,
    expected,
  );
  const wait = controlWaitPolicy(status);
  if ((wait.outcome !== "delivered" && wait.outcome !== "blocked") || wait.result?.kind !== "BOOT") {
    throw new ControlRequestError(
      "CONTROL_REQUEST_RESULT_NOT_READY",
      "surface commit requires a successful BOOT result from the active result transport",
    );
  }
  return status;
}

function lateEvidenceFile(workspaceId: string, requestId: string, root?: string): string {
  return path.join(requestStoreRoot(workspaceId, root), "late-evidence", `${validateControlId(requestId, "request id")}.json`);
}

/** Preserve a verified exact response after authority ends; it remains evidence only. */
export function recordLateControlEvidence(
  workspaceId: string, requestId: string, localSessionId: string,
  expected: ControlResultCorrelation, input: unknown,
): ControlRequestSnapshot {
  return withFileLock(requestLockFile(workspaceId, requestId), () => {
    const status = getControlRequestStatus(workspaceId, requestId, localSessionId, expected);
    // An existing terminal outcome remains authoritative.
    if (status.status !== "pending" && status.status !== "expired" &&
        !(status.status === "cancelled" && status.hostFailure && !status.hostObservedResult)) return status;
    if (status.lateEvidence?.state === "final" && isExactLegacyControlPageObservationReplay({
      latest: status.lateEvidence,
      lastDefinitive: status.lateEvidence,
    }, input)) return status;
    const observation = parseLateControlPageObservation(status.pageObservation ?? null, input);
    if (!status.request || observation.state !== "final" ||
        observation.responseToRequestId !== requestId || observation.tabId !== status.request.surfaceTabId ||
        observation.generation !== status.request.surfaceGeneration) {
      throw new ControlRequestError("CONTROL_REQUEST_CORRELATION_MISMATCH", "late response does not match its original request");
    }
    const observedAt = Date.parse(observation.observedAt);
    if (observedAt < Date.now() - 60_000 || observedAt > Date.now() + 5_000 ||
        observedAt < Date.parse(status.request.createdAt)) {
      throw new ControlRequestError("CONTROL_REQUEST_CORRELATION_MISMATCH", "late response observation is stale");
    }
    if ("terminalResult" in observation && !status.request.allowedKinds.includes(observation.terminalResult.kind)) {
      throw new ControlRequestError("CONTROL_REQUEST_CORRELATION_MISMATCH", "late result kind is not allowed by the original phase");
    }
    if (status.lateEvidence) {
      if (canonicalJson(status.lateEvidence) !== canonicalJson(observation)) {
        throw new ControlRequestError("CONTROL_REQUEST_CORRELATION_MISMATCH", "late evidence already exists");
      }
      return status;
    }
    writeSecureJson(lateEvidenceFile(workspaceId, requestId), observation);
    return getControlRequestStatus(workspaceId, requestId, localSessionId, expected);
  });
}

export async function waitForControlRequest(
  workspaceId: string,
  requestId: string,
  timeoutMs: number,
  localSessionId: string,
  expected?: ControlResultCorrelation,
  signal?: AbortSignal,
  pollIntervalMs = 250,
): Promise<ControlRequestSnapshot> {
  const throwIfAborted = (): void => {
    if (signal?.aborted) {
      throw signal.reason ?? Object.assign(new Error("control result wait aborted"), { name: "AbortError" });
    }
  };
  const waitForPoll = (delayMs: number): Promise<void> => {
    throwIfAborted();
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const cleanup = (): void => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        signal?.removeEventListener("abort", onAbort);
      };
      const onTimer = (): void => {
        cleanup();
        resolve();
      };
      const onAbort = (): void => {
        cleanup();
        reject(signal?.reason ?? Object.assign(new Error("control result wait aborted"), { name: "AbortError" }));
      };
      timer = setTimeout(onTimer, delayMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  };
  let deadline: number | undefined;
  for (;;) {
    throwIfAborted();
    const status = getControlRequestStatus(workspaceId, requestId, localSessionId, expected);
    if (status.status !== "pending") return status;
    deadline ??= Date.now() + Math.min(
      CONTROL_PAGE_CHECK_INTERVAL_MS,
      Math.max(0, timeoutMs),
      controlWaitPolicy(status).checkPageAfterMs,
    );
    const remaining = Math.min(deadline, Date.parse(status.request!.expiresAt)) - Date.now();
    if (remaining <= 0) return status;
    await waitForPoll(Math.min(pollIntervalMs, remaining));
  }
}

export function cancelControlRequest(
  workspaceId: string,
  requestId: string,
  localSessionId: string,
  expected: ControlResultCorrelation
): ControlRequestSnapshot {
  const resolvedWorkspaceId = validateControlId(workspaceId, "workspace id");
  const resolvedRequestId = validateControlId(requestId, "request id");
  const resolvedLocalSessionId = validateLocalSessionId(localSessionId);
  return withFileLock(sessionLifecycleLockFile(resolvedWorkspaceId, resolvedLocalSessionId), () =>
    withFileLock(requestLockFile(resolvedWorkspaceId, resolvedRequestId), () => {
      const status = getControlRequestStatus(
        resolvedWorkspaceId,
        resolvedRequestId,
        resolvedLocalSessionId,
        expected
      );
      if (status.status === "not_found") {
        throw new ControlRequestError("CONTROL_REQUEST_NOT_FOUND", "control result request was not found");
      }
      if (status.status === "cancelled") {
        clearActiveRequest(resolvedWorkspaceId, status.request!.localSessionId, resolvedRequestId);
        return getControlRequestStatus(
          resolvedWorkspaceId,
          resolvedRequestId,
          resolvedLocalSessionId,
          expected,
        );
      }
      if (status.status !== "pending") {
        throw new ControlRequestError("CONTROL_REQUEST_NOT_PENDING", "only a pending control result request can be cancelled");
      }
      writeTerminalMarker(resolvedWorkspaceId, status.request!, "cancelled");
      clearActiveRequest(resolvedWorkspaceId, status.request!.localSessionId, resolvedRequestId);
      return getControlRequestStatus(
        resolvedWorkspaceId,
        resolvedRequestId,
        resolvedLocalSessionId,
        expected
      );
    })
  );
}

function terminalObservationRecords(observation: ControlTerminalObservation): {
  failure?: ControlHostFailure;
  hostObservedResult?: ControlHostObservedResult;
} {
  if (observation.state === "final" && "delivery" in observation) {
    return {
      hostObservedResult: controlHostObservedResultSchema.parse({
        provenance: "host_observed",
        observedAt: observation.observedAt,
        result: parseControlResultSubmission(observation.terminalResult),
      }),
    };
  }
  return { failure: controlHostFailureSchema.parse(observation) };
}

function storedTerminalObservationRecords(
  observation: StoredControlPageObservation,
  requestId: string,
): { failure?: ControlHostFailure; hostObservedResult?: ControlHostObservedResult } {
  if (observation.state === "final" && "delivery" in observation) {
    return {
      hostObservedResult: controlHostObservedResultSchema.parse({
        provenance: "host_observed",
        observedAt: observation.observedAt,
        result: parseControlResultSubmission(observation.terminalResult),
      }),
    };
  }
  const failureObservation = { ...observation } as Record<string, unknown>;
  delete failureObservation.terminalResult;
  const failure = parseStoredHostFailure(failureObservation, requestId);
  if (!failure) integrityError("legacy terminal Computer Use failure is invalid");
  if (
    observation.state === "final" &&
    "terminalResult" in observation &&
    observation.terminalResult !== undefined
  ) {
    return {
      failure,
      hostObservedResult: controlHostObservedResultSchema.parse({
        provenance: "host_observed",
        observedAt: observation.observedAt,
        result: parseControlResultSubmission(observation.terminalResult),
      }),
    };
  }
  return { failure };
}

function recoverMarkedControlRequestObservation(
  workspaceId: string,
  requestId: string,
  localSessionId: string,
  expected: ControlResultCorrelation | undefined,
  observation: ControlPageObservation,
  status: ControlRequestSnapshot,
): ControlRequestSnapshot | null {
  if (status.status !== "cancelled" || status.hostFailure || status.hostObservedResult || !status.request) return null;
  const marker = readTerminalState(workspaceId, status.request);
  if (!marker?.hostObservedResult || marker.hostFailure) return null;

  if (
    observation.responseToRequestId !== requestId ||
    !observationMatchesRequestSurface(observation, status.request)
  ) {
    throw new ControlRequestError(
      "CONTROL_REQUEST_CORRELATION_MISMATCH",
      "final observation does not match the interrupted Computer Use request",
    );
  }
  const replay = advanceControlPageObservation(status.pageObservation ?? null, observation, new Date().toISOString());
  if (
    !replay.terminal || replay.terminal.state !== "final" || !("delivery" in replay.terminal) ||
    replay.terminal.delivery !== "computer_use" || !("completionEvidence" in replay.terminal)
  ) {
    throw new ControlRequestError(
      "CONTROL_REQUEST_CORRELATION_MISMATCH",
      "final observation does not complete the exact stored Computer Use candidate",
    );
  }
  const records = terminalObservationRecords(replay.terminal);
  if (
    records.failure !== undefined ||
    canonicalJson(records.hostObservedResult ?? null) !== canonicalJson(marker.hostObservedResult)
  ) {
    throw new ControlRequestError(
      "CONTROL_REQUEST_CORRELATION_MISMATCH",
      "final observation does not match the interrupted Computer Use result",
    );
  }

  if (!replay.idempotentReplay) writePageObservation(workspaceId, status.request, replay.state);
  clearActiveRequest(workspaceId, localSessionId, requestId);
  return getControlRequestStatus(workspaceId, requestId, localSessionId, expected);
}

/** Recover a marker-first success only by persisting its exact, validated final observation. */
export function recoverControlRequestObservation(
  workspaceId: string,
  requestId: string,
  localSessionId: string,
  expected: ControlResultCorrelation | undefined,
  observation: ControlPageObservation,
): ControlRequestSnapshot | null {
  const resolvedWorkspaceId = validateControlId(workspaceId, "workspace id");
  const resolvedRequestId = validateControlId(requestId, "request id");
  const resolvedLocalSessionId = validateLocalSessionId(localSessionId);
  return withFileLock(sessionLifecycleLockFile(resolvedWorkspaceId, resolvedLocalSessionId), () =>
    withFileLock(requestLockFile(resolvedWorkspaceId, resolvedRequestId), () => {
      const status = getControlRequestStatus(
        resolvedWorkspaceId,
        resolvedRequestId,
        resolvedLocalSessionId,
        expected,
      );
      return recoverMarkedControlRequestObservation(
        resolvedWorkspaceId,
        resolvedRequestId,
        resolvedLocalSessionId,
        expected,
        observation,
        status,
      );
    }),
  );
}

/**
 * Persist one exact page lifecycle event and apply its control effect under the
 * same request/session locks used by observation and cancellation.
 */
export function observeControlRequest(
  workspaceId: string,
  requestId: string,
  localSessionId: string,
  // Typed `| undefined` rather than `?` so the parameter order stays as it was:
  // `observation` is required and must not jump ahead of an optional argument.
  expected: ControlResultCorrelation | undefined,
  observation: unknown,
  renewAuthorization?: () => string,
): ControlRequestSnapshot {
  const resolvedWorkspaceId = validateControlId(workspaceId, "workspace id");
  const resolvedRequestId = validateControlId(requestId, "request id");
  const resolvedLocalSessionId = validateLocalSessionId(localSessionId);
  return withFileLock(sessionLifecycleLockFile(resolvedWorkspaceId, resolvedLocalSessionId), () =>
    withFileLock(requestLockFile(resolvedWorkspaceId, resolvedRequestId), () => {
      const status = getControlRequestStatus(
        resolvedWorkspaceId,
        resolvedRequestId,
        resolvedLocalSessionId,
        expected,
      );
      if (status.status === "cancelled" && status.pageObservation &&
          isExactLegacyControlPageObservationReplay(status.pageObservation, observation)) {
        clearActiveRequest(resolvedWorkspaceId, resolvedLocalSessionId, resolvedRequestId);
        return getControlRequestStatus(
          resolvedWorkspaceId,
          resolvedRequestId,
          resolvedLocalSessionId,
          expected,
        );
      }
      const parsed = parseControlPageObservation(observation);
      if (parsed.responseToRequestId !== resolvedRequestId) {
        throw new ControlRequestError("CONTROL_REQUEST_CORRELATION_MISMATCH", "page observation belongs to another response");
      }
      if ("terminalResult" in parsed && !status.request?.allowedKinds.includes(parsed.terminalResult.kind)) {
        throw new ControlRequestError("CONTROL_REQUEST_KIND_NOT_ALLOWED", "result kind is not allowed for this request phase");
      }
      if (status.status === "cancelled") {
        const recovered = recoverMarkedControlRequestObservation(
          resolvedWorkspaceId,
          resolvedRequestId,
          resolvedLocalSessionId,
          expected,
          parsed,
          status,
        );
        if (recovered) return recovered;
        if (!status.hostFailure && !status.hostObservedResult) {
          clearActiveRequest(resolvedWorkspaceId, resolvedLocalSessionId, resolvedRequestId);
          return getControlRequestStatus(
            resolvedWorkspaceId,
            resolvedRequestId,
            resolvedLocalSessionId,
            expected,
          );
        }
        const replay = advanceControlPageObservation(status.pageObservation ?? null, parsed, new Date().toISOString());
        if (!replay.terminal) {
          throw new ControlRequestError(
            "CONTROL_REQUEST_CORRELATION_MISMATCH",
            "cancelled request can only replay its exact terminal observation",
          );
        }
        const records = terminalObservationRecords(replay.terminal);
        if (
          canonicalJson(records.failure) !== canonicalJson(status.hostFailure) ||
          canonicalJson(records.hostObservedResult ?? null) !== canonicalJson(status.hostObservedResult ?? null)
        ) {
          throw new ControlRequestError(
            "CONTROL_REQUEST_CORRELATION_MISMATCH",
            "terminal observation does not match the cancelled request",
          );
        }
        if (!replay.idempotentReplay) {
          writePageObservation(resolvedWorkspaceId, status.request!, replay.state);
        }
        clearActiveRequest(resolvedWorkspaceId, resolvedLocalSessionId, resolvedRequestId);
        return getControlRequestStatus(
          resolvedWorkspaceId,
          resolvedRequestId,
          resolvedLocalSessionId,
          expected,
        );
      }
      if (status.status !== "pending") return status;
      const advanced = advanceControlPageObservation(status.pageObservation ?? null, parsed, new Date().toISOString());
      if (advanced.idempotentReplay) return status;

      if (parsed.state === "generating") {
        if (!renewAuthorization) {
          throw new ControlRequestError("INVALID_RESULT", "generating observation requires live authorization renewal");
        }
        const expiresAt = renewAuthorization();
        const expiry = Date.parse(expiresAt);
        if (!isCanonicalTimestamp(expiresAt) || expiry <= Date.now() || expiry > Date.now() + MAX_REQUEST_TTL_MS) {
          throw new ControlRequestError("INVALID_RESULT", "invalid request renewal lifetime");
        }
        if (expiry > Date.parse(status.request!.expiresAt)) {
          const original = parseStoredRequest(
            readStoredJson(requestFile(resolvedWorkspaceId, resolvedRequestId), "stored request"),
            resolvedWorkspaceId,
            resolvedRequestId,
          );
          writeSecureJson(renewalFile(resolvedWorkspaceId, resolvedRequestId), { request: original, expiresAt });
        }
        writePageObservation(resolvedWorkspaceId, status.request!, advanced.state);
        return getControlRequestStatus(
          resolvedWorkspaceId,
          resolvedRequestId,
          resolvedLocalSessionId,
          expected,
        );
      }

      if (!advanced.terminal) {
        writePageObservation(resolvedWorkspaceId, status.request!, advanced.state);
        return getControlRequestStatus(
          resolvedWorkspaceId,
          resolvedRequestId,
          resolvedLocalSessionId,
          expected,
        );
      }

      const { failure, hostObservedResult } = terminalObservationRecords(advanced.terminal);
      if (hostObservedResult && !status.request!.allowedKinds.includes(hostObservedResult.result.kind)) {
        throw new ControlRequestError(
          "CONTROL_REQUEST_KIND_NOT_ALLOWED",
          `${hostObservedResult.result.kind} is not allowed for ${status.request!.phase}`,
        );
      }
      writeTerminalMarker(
        resolvedWorkspaceId,
        status.request!,
        "cancelled",
        failure,
        hostObservedResult,
      );
      writePageObservation(resolvedWorkspaceId, status.request!, advanced.state);
      clearActiveRequest(resolvedWorkspaceId, resolvedLocalSessionId, resolvedRequestId);
      return getControlRequestStatus(
        resolvedWorkspaceId,
        resolvedRequestId,
        resolvedLocalSessionId,
        expected,
      );
    }),
  );
}

/** Extend only pending work under the same locks used by page observations and cancellation. */
export function renewControlRequest(
  workspaceId: string,
  requestId: string,
  localSessionId: string,
  expected: ControlResultCorrelation,
  renewAuthorization: () => string,
): ControlRequestSnapshot {
  return withFileLock(sessionLifecycleLockFile(workspaceId, localSessionId), () =>
    withFileLock(requestLockFile(workspaceId, requestId), () => {
      const status = getControlRequestStatus(workspaceId, requestId, localSessionId, expected);
      if (status.status !== "pending") return status;
      const expiresAt = renewAuthorization();
      const expiry = Date.parse(expiresAt);
      if (!isCanonicalTimestamp(expiresAt) || expiry <= Date.now() || expiry > Date.now() + MAX_REQUEST_TTL_MS) {
        throw new ControlRequestError("INVALID_RESULT", "invalid request renewal lifetime");
      }
      if (expiry > Date.parse(status.request!.expiresAt)) {
        const original = parseStoredRequest(readStoredJson(requestFile(workspaceId, requestId), "stored request"), workspaceId, requestId);
        writeSecureJson(renewalFile(workspaceId, requestId), { request: original, expiresAt });
      }
      return getControlRequestStatus(workspaceId, requestId, localSessionId, expected);
    }),
  );
}

export interface RetireControlRequestSessionSummary {
  localSessionId: string;
  pendingCancelled: number;
  activeRequestCleared: boolean;
}

/** Retire requests owned by one local session under the established lock order. */
export function retireControlRequestSession(
  workspaceId: string,
  localSessionId: string,
): RetireControlRequestSessionSummary {
  const resolvedWorkspaceId = validateControlId(workspaceId, "workspace id");
  const resolvedLocalSessionId = validateLocalSessionId(localSessionId);
  return withFileLock(sessionLifecycleLockFile(resolvedWorkspaceId, resolvedLocalSessionId), () => {
    let pendingCancelled = 0;

    for (const listedRequest of listRequests(resolvedWorkspaceId)) {
      if (listedRequest.localSessionId !== resolvedLocalSessionId) continue;
      withFileLock(requestLockFile(resolvedWorkspaceId, listedRequest.requestId), () => {
        const request = readRequest(resolvedWorkspaceId, listedRequest.requestId);
        if (!request || request.localSessionId !== resolvedLocalSessionId) return;
        const status = getControlRequestStatus(
          resolvedWorkspaceId,
          request.requestId,
          resolvedLocalSessionId,
          {
            taskId: request.taskId,
            iteration: request.iteration,
            phase: request.phase,
          },
        );
        if (status.status === "pending") {
          writeTerminalMarker(resolvedWorkspaceId, request, "cancelled");
          pendingCancelled += 1;
        }
      });
    }

    const activeRequestCleared = readActiveRequest(resolvedWorkspaceId, resolvedLocalSessionId) !== null;
    if (activeRequestCleared) {
      const activeRequest = readActiveRequest(resolvedWorkspaceId, resolvedLocalSessionId);
      if (activeRequest) clearActiveRequest(resolvedWorkspaceId, resolvedLocalSessionId, activeRequest.requestId);
    }
    return {
      localSessionId: resolvedLocalSessionId,
      pendingCancelled,
      activeRequestCleared,
    };
  });
}

function pruneControlRequestsUnlocked(resolvedWorkspaceId: string, now: number): number {
  let removed = 0;
  const markerPath = migrationFile(resolvedWorkspaceId);
  const migrationMarkerValue = fs.existsSync(markerPath)
    ? validateMigrationMarker(resolvedWorkspaceId)
    : null;
  const cleanupPending = Boolean(
    migrationMarkerValue?.sourceManifestSha256 &&
    (!migrationMarkerValue.cleanupAuthorizedAt || fs.existsSync(legacyWorkspaceDir(resolvedWorkspaceId)) ||
      migrationMarkerValue.retirement !== null)
  );
  const protectedRequestIds = cleanupPending
    ? new Set(migrationMarkerValue!.migratedFiles
      .filter((file) => file.path.startsWith("requests/"))
      .map((file) => file.path.slice("requests/".length, -".json".length)))
    : new Set<string>();
  for (const listedRequest of listRequests(resolvedWorkspaceId)) {
    if (protectedRequestIds.has(listedRequest.requestId)) continue;
    removed += withFileLock(
      sessionLifecycleLockFile(resolvedWorkspaceId, listedRequest.localSessionId),
      () =>
        withFileLock(requestLockFile(resolvedWorkspaceId, listedRequest.requestId), () => {
          const request = readRequest(resolvedWorkspaceId, listedRequest.requestId);
          if (!request) return 0;
          const terminal = readTerminalState(resolvedWorkspaceId, request);
          const expiredAt = isExpired(request, now) ? Date.parse(request.expiresAt) : null;
          const terminalAt = terminal ? Date.parse(terminal.timestamp) : expiredAt;
          if (
            terminalAt === null ||
            !Number.isFinite(terminalAt) ||
            now - terminalAt <= RETAIN_TERMINAL_MS
          ) {
            return 0;
          }
          if (migrationMarkerValue?.cleanupAuthorizedAt && !cleanupPending) {
            const requestPaths = new Set([
              `requests/${request.requestId}.json`,
              `observations/${request.requestId}.json`,
              `cancelled/${request.requestId}.json`,
              `renewals/${request.requestId}.json`,
              `late-evidence/${request.requestId}.json`,
              `active/${request.localSessionId}.json`,
            ]);
            const retainedFiles = migrationMarkerValue.migratedFiles.filter((file) => !requestPaths.has(file.path));
            if (retainedFiles.length !== migrationMarkerValue.migratedFiles.length) {
              migrationMarkerValue.migratedFiles = retainedFiles;
              writeSecureJson(markerPath, migrationMarkerValue);
            }
          }
          clearActiveRequest(resolvedWorkspaceId, request.localSessionId, request.requestId);
          for (const file of [
            requestFile(resolvedWorkspaceId, request.requestId),
            observationFile(resolvedWorkspaceId, request.requestId),
            lateEvidenceFile(resolvedWorkspaceId, request.requestId),
            cancelledFile(resolvedWorkspaceId, request.requestId),
            renewalFile(resolvedWorkspaceId, request.requestId),
          ]) {
            fs.rmSync(file, { force: true });
          }
          return 1;
        })
    );
  }
  return removed;
}

export function pruneControlRequests(workspaceId: string, now = Date.now()): number {
  const resolvedWorkspaceId = validateControlId(workspaceId, "workspace id");
  return withFileLock(maintenanceLockFile(resolvedWorkspaceId), () =>
    withFileLock(pruneLockFile(resolvedWorkspaceId), () =>
      pruneControlRequestsUnlocked(resolvedWorkspaceId, now)
    )
  );
}

const LEGACY_STORE_DIRECTORIES = [
  "requests", "observations", "cancelled", "active", "renewals", "late-evidence",
  "results", "progress", "acks", "locks",
] as const;
const CONTROL_REQUEST_STORE_DIRECTORIES = [
  "requests", "observations", "cancelled", "active", "renewals", "late-evidence",
] as const;
const MAX_STORE_ENTRIES = 20_000;
const MAX_STORE_FILE_BYTES = 2 * 1024 * 1024;

interface LegacyStoreScan {
  requests: Map<string, ControlResultRequest>;
  baseRequests: Map<string, ControlResultRequest>;
  observations: Map<string, ControlPageObservationState>;
  terminal: Map<string, ReturnType<typeof readTerminalState>>;
  lateEvidence: Map<string, StoredControlPageObservation>;
  active: Map<string, string>;
  callbackArtifacts: Set<string>;
  resultArtifacts: Set<string>;
  progressArtifacts: Set<string>;
  acknowledgedArtifacts: Set<string>;
  migrationRequestIds: Set<string>;
  liveRequestCount: number;
}

function safeRealDirectory(directory: string, label: string): boolean {
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    integrityError(`${label} must be a real directory`);
  }
  const canonical = fs.realpathSync.native(directory);
  const canonicalStat = fs.statSync(canonical);
  if (!canonicalStat.isDirectory()) integrityError(`${label} does not resolve to a directory`);
  let expected = path.resolve(directory);
  if (process.platform === "darwin") {
    for (const alias of ["/tmp", "/var"]) {
      if (expected === alias || expected.startsWith(`${alias}${path.sep}`)) {
        expected = path.join(fs.realpathSync.native(alias), path.relative(alias, expected));
        break;
      }
    }
  }
  if (canonical !== expected) integrityError(`${label} must not traverse symbolic links`);
  return true;
}

function safeJsonEntries(
  directory: string,
  label: string,
  idValidator: (value: string, label?: string) => string = validateControlId,
): Map<string, string> {
  const entries = new Map<string, string>();
  if (!safeRealDirectory(directory, `${label} directory`)) return entries;
  const names = fs.readdirSync(directory);
  if (names.length > MAX_STORE_ENTRIES) integrityError(`${label} directory contains too many entries`);
  for (const name of names) {
    if (!name.endsWith(".json")) integrityError(`${label} directory contains an unexpected file`);
    const id = name.slice(0, -5);
    const normalized = storedId(id, `${label} file id`, idValidator);
    if (`${normalized}.json` !== name) integrityError(`${label} file name is not canonical`);
    const file = path.join(directory, name);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_STORE_FILE_BYTES) {
      integrityError(`${label} entry is not a bounded regular file`);
    }
    entries.set(normalized, file);
  }
  return entries;
}

function assertSafeTree(directory: string, label: string, depth = 0, count = { value: 0 }): void {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
    integrityError(`${label} contains a symbolic link or special file`);
  }
  if (stat.isFile()) {
    if (stat.size > MAX_STORE_FILE_BYTES) integrityError(`${label} contains an oversized file`);
    return;
  }
  if (depth > 8) integrityError(`${label} nesting is too deep`);
  for (const name of fs.readdirSync(directory)) {
    count.value += 1;
    if (count.value > MAX_STORE_ENTRIES) integrityError(`${label} contains too many entries`);
    assertSafeTree(path.join(directory, name), label, depth + 1, count);
  }
}

function safeLegacyRoot(workspaceId: string): string | null {
  const stateRoot = path.resolve(getStateDir());
  if (!safeRealDirectory(stateRoot, "machine state root")) {
    integrityError("machine state root is missing");
  }
  const parent = path.join(stateRoot, "control-mailbox");
  if (!safeRealDirectory(parent, "legacy control root")) return null;
  const root = legacyWorkspaceDir(workspaceId);
  if (!safeRealDirectory(root, "legacy workspace root")) return null;
  assertSafeTree(root, "legacy workspace root");
  return root;
}

function scanLegacyStore(workspaceId: string, root: string): LegacyStoreScan {
  const rootEntries = fs.readdirSync(root);
  if (rootEntries.some((entry) => !LEGACY_STORE_DIRECTORIES.includes(entry as (typeof LEGACY_STORE_DIRECTORIES)[number]))) {
    integrityError("legacy workspace root contains an unknown entry");
  }
  for (const name of rootEntries) {
    if (!safeRealDirectory(path.join(root, name), `legacy ${name}`)) {
      integrityError(`legacy ${name} path is missing`);
    }
  }

  const requests = safeJsonEntries(path.join(root, "requests"), "legacy request");
  const observationFiles = safeJsonEntries(path.join(root, "observations"), "legacy observation");
  const cancelledFiles = safeJsonEntries(path.join(root, "cancelled"), "legacy cancellation");
  const activeFiles = safeJsonEntries(path.join(root, "active"), "legacy active pointer", validateLocalSessionId);
  const renewalFiles = safeJsonEntries(path.join(root, "renewals"), "legacy renewal");
  const lateEvidenceFiles = safeJsonEntries(path.join(root, "late-evidence"), "legacy late evidence");
  const callbackArtifacts = new Set<string>();
  const resultArtifacts = new Set<string>();
  const progressArtifacts = new Set<string>();
  const acknowledgedArtifacts = new Set<string>();
  for (const directory of ["results", "progress", "acks"] as const) {
    for (const requestId of safeJsonEntries(path.join(root, directory), `legacy ${directory}`).keys()) {
      callbackArtifacts.add(requestId);
      if (directory === "results") resultArtifacts.add(requestId);
      if (directory === "progress") progressArtifacts.add(requestId);
      if (directory === "acks") acknowledgedArtifacts.add(requestId);
    }
  }

  const requestIds = new Set(requests.keys());
  for (const [label, files] of [
    ["observation", observationFiles], ["cancellation", cancelledFiles],
    ["renewal", renewalFiles], ["late evidence", lateEvidenceFiles],
  ] as const) {
    for (const requestId of files.keys()) {
      if (!requestIds.has(requestId)) integrityError(`legacy ${label} has no matching request`);
    }
  }

  const baseRequests = new Map<string, ControlResultRequest>();
  const effectiveRequests = new Map<string, ControlResultRequest>();
  const observations = new Map<string, ControlPageObservationState>();
  const terminal = new Map<string, ReturnType<typeof readTerminalState>>();
  const lateEvidence = new Map<string, StoredControlPageObservation>();
  const migrationRequestIds = new Set<string>();
  let liveRequestCount = 0;

  for (const [requestId, file] of requests) {
    const raw = readStoredJson(file, "legacy stored request");
    const base = parseStoredRequest(raw, workspaceId, requestId);
    const effective = applyRequestRenewal(base, root);
    const isComputerUseBound = effective.surfaceGeneration !== null && effective.surfaceTabId !== null;
    baseRequests.set(requestId, base);
    effectiveRequests.set(requestId, effective);
    if (!isComputerUseBound) continue;

    const pageObservation = readPageObservation(workspaceId, effective, root) ?? undefined;
    const terminalState = readTerminalState(workspaceId, effective, root);
    const evidence = readLateEvidence(workspaceId, effective, root);
    if (pageObservation?.lastDefinitive?.state === "final") {
      if (!terminalState) integrityError("legacy final Computer Use observation has no terminal marker");
      const finalObservation = pageObservation.lastDefinitive;
      const terminalRecords = storedTerminalObservationRecords(finalObservation, requestId);
      const hasLegacyMixedFailureResult = !("delivery" in finalObservation) &&
        "terminalResult" in finalObservation && finalObservation.terminalResult !== undefined;
      const hostObservedResultMatches =
        (hasLegacyMixedFailureResult && terminalState.hostObservedResult === undefined) ||
        canonicalJson(terminalRecords.hostObservedResult ?? null) ===
          canonicalJson(terminalState.hostObservedResult ?? null);
      if (
        canonicalJson(terminalRecords.failure ?? null) !== canonicalJson(terminalState.hostFailure ?? null) ||
        !hostObservedResultMatches
      ) integrityError("legacy terminal marker does not match its Computer Use observation");
    }
    if (terminalState?.hostFailure && isComputerUseBound && (
      terminalState.hostFailure.tabId !== effective.surfaceTabId ||
      terminalState.hostFailure.generation !== effective.surfaceGeneration
    )) integrityError("legacy host failure does not match its Computer Use page identity");
    if (pageObservation) observations.set(requestId, pageObservation);
    if (terminalState) terminal.set(requestId, terminalState);
    if (evidence) lateEvidence.set(requestId, evidence);

    const hasComputerUseEvidence = Boolean(
      pageObservation || evidence || terminalState?.hostFailure || terminalState?.hostObservedResult
    );
    const hasCallbackDelivery = resultArtifacts.has(requestId) || acknowledgedArtifacts.has(requestId);
    if (hasCallbackDelivery && terminalState?.hostObservedResult) {
      integrityError("legacy callback delivery conflicts with a Computer Use host-observed result");
    }
    if (callbackArtifacts.has(requestId) && !hasComputerUseEvidence) continue;
    migrationRequestIds.add(requestId);

    const isLive = !terminalState && !isExpired(effective);
    if (isLive) liveRequestCount += 1;
  }

  const active = new Map<string, string>();
  for (const [localSessionId, file] of activeFiles) {
    const value = readStoredJson(file, "legacy active request pointer");
    if (!isRecord(value)) integrityError("legacy active request pointer schema is invalid");
    const requestId = storedId(value.requestId, "legacy active request id");
    const request = baseRequests.get(requestId);
    if (!request || !effectiveRequests.has(requestId)) integrityError("legacy active pointer has no matching request");
    const activeRequest = parseStoredRequest(value, workspaceId, requestId);
    if (
      activeRequest.localSessionId !== localSessionId ||
      activeRequest.localSessionId !== request.localSessionId ||
      canonicalJson(activeRequest) !== canonicalJson(request)
    ) integrityError("legacy active pointer does not match its request and session");
    const effective = effectiveRequests.get(requestId)!;
    if (
      effective.surfaceGeneration !== null && effective.surfaceTabId !== null &&
      migrationRequestIds.has(requestId) && !terminal.has(requestId)
    ) active.set(localSessionId, requestId);
  }

  return {
    requests: effectiveRequests,
    baseRequests,
    observations,
    terminal,
    lateEvidence,
    active,
    callbackArtifacts,
    resultArtifacts,
    progressArtifacts,
    acknowledgedArtifacts,
    migrationRequestIds,
    liveRequestCount,
  };
}

interface MigratedFileDigest {
  path: string;
  sha256: string;
}

interface ControlRequestMigrationMarker {
  schemaVersion: number;
  workspaceId: string;
  completedAt: string;
  sourceManifestSha256: string | null;
  migratedFiles: MigratedFileDigest[];
  cleanupAuthorizedAt: string | null;
  retirement: LegacyRetirementState | null;
}

interface LegacyRetirementState {
  id: string;
  device: string;
  inode: string;
  phase: "reserved" | "deleting";
}

function migrationMarker(
  workspaceId: string,
  sourceManifestSha256: string | null,
  migratedFiles: MigratedFileDigest[],
): ControlRequestMigrationMarker {
  return {
    schemaVersion: STORE_MIGRATION_VERSION,
    workspaceId,
    completedAt: new Date().toISOString(),
    sourceManifestSha256,
    migratedFiles,
    cleanupAuthorizedAt: null,
    retirement: null,
  };
}

function validateMigrationMarker(workspaceId: string): ControlRequestMigrationMarker {
  const marker = readStoredJson(migrationFile(workspaceId), "control request store migration marker");
  if (!isRecord(marker)) integrityError("control request store has no valid completed migration marker");
  const markerKeys = ["schemaVersion", "workspaceId", "completedAt", "sourceManifestSha256", "migratedFiles", "cleanupAuthorizedAt"];
  if (
    !hasExactKeys(marker, marker.retirement === undefined ? markerKeys : [...markerKeys, "retirement"]) ||
    marker.schemaVersion !== STORE_MIGRATION_VERSION ||
    marker.workspaceId !== workspaceId ||
    !isCanonicalTimestamp(marker.completedAt) ||
    (marker.sourceManifestSha256 !== null &&
      (typeof marker.sourceManifestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(marker.sourceManifestSha256))) ||
    !Array.isArray(marker.migratedFiles) ||
    (marker.cleanupAuthorizedAt !== null && !isCanonicalTimestamp(marker.cleanupAuthorizedAt))
  ) integrityError("control request store has no valid completed migration marker");
  let retirement: LegacyRetirementState | null = null;
  if (marker.retirement !== undefined && marker.retirement !== null) {
    const value = marker.retirement;
    if (
      !isRecord(value) || !hasExactKeys(value, ["id", "device", "inode", "phase"]) ||
      typeof value.id !== "string" || !/^[a-f0-9]{32}$/.test(value.id) ||
      typeof value.device !== "string" || !/^\d+$/.test(value.device) ||
      typeof value.inode !== "string" || !/^\d+$/.test(value.inode) ||
      (value.phase !== "reserved" && value.phase !== "deleting") ||
      marker.sourceManifestSha256 === null || marker.cleanupAuthorizedAt === null
    ) integrityError("control request legacy retirement marker is invalid");
    retirement = {
      id: value.id,
      device: value.device,
      inode: value.inode,
      phase: value.phase,
    };
  }
  const migratedFiles: MigratedFileDigest[] = [];
  let previousPath = "";
  for (const file of marker.migratedFiles) {
    if (
      !isRecord(file) || !hasExactKeys(file, ["path", "sha256"]) ||
      typeof file.path !== "string" || typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.sha256) || file.path <= previousPath
    ) integrityError("control request migration file manifest is invalid");
    const [directory, name, ...extra] = file.path.split("/");
    if (
      extra.length !== 0 || !CONTROL_REQUEST_STORE_DIRECTORIES.includes(directory as (typeof CONTROL_REQUEST_STORE_DIRECTORIES)[number]) ||
      !name?.endsWith(".json") || name.length <= 5
    ) integrityError("control request migration file path is invalid");
    const id = name.slice(0, -5);
    storedId(id, "control request migration file id", directory === "active" ? validateLocalSessionId : validateControlId);
    migratedFiles.push({ path: file.path, sha256: file.sha256 });
    previousPath = file.path;
  }
  return {
    schemaVersion: STORE_MIGRATION_VERSION,
    workspaceId,
    completedAt: marker.completedAt,
    sourceManifestSha256: marker.sourceManifestSha256 as string | null,
    migratedFiles,
    cleanupAuthorizedAt: marker.cleanupAuthorizedAt as string | null,
    retirement,
  };
}

function legacyTreeManifest(root: string): string {
  const entries: Array<{ path: string; type: "directory" | "file"; sha256?: string }> = [];
  const visit = (directory: string, relative: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      const childRelative = relative ? `${relative}/${name}` : name;
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        integrityError("legacy workspace root contains a symbolic link or special file");
      }
      if (stat.isDirectory()) {
        entries.push({ path: childRelative, type: "directory" });
        visit(file, childRelative);
      } else {
        if (stat.size > MAX_STORE_FILE_BYTES) integrityError("legacy workspace root contains an oversized file");
        entries.push({
          path: childRelative,
          type: "file",
          sha256: sha256Hex(fs.readFileSync(file).toString("base64")),
        });
      }
    }
  };
  visit(root, "");
  return sha256Hex(canonicalJson(entries));
}

function migratedFileDigests(files: Map<string, unknown>): MigratedFileDigest[] {
  return [...files.entries()]
    .map(([file, value]) => ({ path: file, sha256: sha256Hex(canonicalJson(value)) }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function observationRetainsMigrationEvidence(
  current: StoredControlPageObservation,
  original: StoredControlPageObservation,
): boolean {
  const originalResponseId = "responseId" in original ? original.responseId : undefined;
  return current.responseToRequestId === original.responseToRequestId &&
    current.tabId === original.tabId &&
    current.generation === original.generation &&
    current.observationSequence >= original.observationSequence &&
    (originalResponseId === undefined || ("responseId" in current && current.responseId === originalResponseId)) &&
    (original.state !== "final" || canonicalJson(current) === canonicalJson(original));
}

function validateMigratedFiles(
  workspaceId: string,
  root: string,
  files: readonly MigratedFileDigest[],
): void {
  for (const file of files) {
    const relative = file.path.split("/");
    const snapshot = readStoredJson(path.join(root, "migration-source", ...relative), "migrated Computer Use source snapshot");
    if (snapshot === null || sha256Hex(canonicalJson(snapshot)) !== file.sha256) {
      integrityError(`migrated Computer Use source snapshot is missing or changed: ${file.path}`);
    }
    const [directory, name] = relative;
    const id = name.slice(0, -5);
    if (directory === "active") {
      const localSessionId = storedId(id, "migrated active session id", validateLocalSessionId);
      readActiveRequest(workspaceId, localSessionId, root);
      continue;
    }
    const request = readRequest(workspaceId, id, root);
    if (!request) integrityError(`migrated Computer Use request is missing: ${id}`);
    if (directory === "requests") {
      const baseValue = readStoredJson(requestFile(workspaceId, id, root), "migrated Computer Use request");
      const baseRequest = baseValue === null ? null : parseStoredRequest(baseValue, workspaceId, id);
      if (!baseRequest || sha256Hex(canonicalJson(baseRequest)) !== file.sha256) {
        integrityError(`migrated Computer Use request changed: ${id}`);
      }
    } else if (directory === "observations") {
      const observation = readPageObservation(workspaceId, request, root);
      if (!observation) integrityError(`migrated Computer Use observation is missing: ${id}`);
      if (!isRecord(snapshot)) integrityError(`migrated Computer Use observation snapshot is invalid: ${id}`);
      let originalLatest: StoredControlPageObservation;
      let originalLastDefinitive: StoredControlPageObservation | null;
      try {
        originalLatest = parseStoredControlPageObservation(snapshot.latest);
        originalLastDefinitive = snapshot.lastDefinitive === null
          ? null
          : parseStoredControlPageObservation(snapshot.lastDefinitive);
      } catch {
        integrityError(`migrated Computer Use observation snapshot is invalid: ${id}`);
      }
      const latestRetained = observationRetainsMigrationEvidence(observation.latest, originalLatest);
      const definitiveRetained = originalLastDefinitive === null
        ? true
        : observation.lastDefinitive !== null &&
          observationRetainsMigrationEvidence(observation.lastDefinitive, originalLastDefinitive);
      if (
        !latestRetained || !definitiveRetained
      ) integrityError(`migrated Computer Use observation no longer contains its original evidence: ${id}`);
    } else if (directory === "cancelled") {
      const terminal = readTerminalState(workspaceId, request, root);
      if (!terminal || canonicalJson(terminal) !== canonicalJson(snapshotTerminal(snapshot))) {
        integrityError(`migrated Computer Use terminal state changed: ${id}`);
      }
    } else if (directory === "late-evidence") {
      const evidence = readLateEvidence(workspaceId, request, root);
      if (!evidence || canonicalJson(evidence) !== canonicalJson(snapshot)) {
        integrityError(`migrated Computer Use late evidence changed: ${id}`);
      }
    } else if (directory === "renewals") {
      if (!isRecord(snapshot) || !hasExactKeys(snapshot, ["request", "expiresAt"])) {
        integrityError(`migrated Computer Use renewal snapshot is invalid: ${id}`);
      }
      const originalRequest = parseStoredRequest(snapshot.request, workspaceId, id);
      const baseValue = readStoredJson(requestFile(workspaceId, id, root), "migrated Computer Use request");
      const baseRequest = baseValue === null ? null : parseStoredRequest(baseValue, workspaceId, id);
      if (
        !baseRequest || canonicalJson(baseRequest) !== canonicalJson(originalRequest) ||
        !isCanonicalTimestamp(snapshot.expiresAt) ||
        Date.parse(snapshot.expiresAt) < Date.parse(originalRequest.expiresAt) ||
        Date.parse(request.expiresAt) < Date.parse(snapshot.expiresAt)
      ) {
        integrityError(`migrated Computer Use renewal is missing: ${id}`);
      }
    }
  }
}

function snapshotTerminal(value: unknown): ReturnType<typeof readTerminalState> {
  if (!isRecord(value)) return null;
  return {
    kind: "cancelled",
    timestamp: value.cancelledAt as string,
    ...(value.hostFailure ? { hostFailure: value.hostFailure as ControlHostFailure } : {}),
    ...(value.hostObservedResult ? { hostObservedResult: value.hostObservedResult as ControlHostObservedResult } : {}),
  };
}

function migrationFilesForScan(
  workspaceId: string,
  scan: LegacyStoreScan,
  legacyRoot: string,
): Map<string, unknown> {
  const files = new Map<string, unknown>();
  const add = (file: string, value: unknown): void => { files.set(file, value); };
  for (const requestId of [...scan.migrationRequestIds].sort()) {
    const base = scan.baseRequests.get(requestId)!;
    add(`requests/${requestId}.json`, base);
    const effective = scan.requests.get(requestId)!;
    const renewalValue = readStoredJson(renewalFile(workspaceId, requestId, legacyRoot), "legacy request renewal");
    if (renewalValue !== null && Date.parse(effective.expiresAt) > Date.parse(base.expiresAt)) {
      add(`renewals/${requestId}.json`, { request: base, expiresAt: effective.expiresAt });
    }
    const pageObservation = scan.observations.get(requestId);
    if (pageObservation) {
      add(`observations/${requestId}.json`, {
        schemaVersion: 1,
        requestId,
        workspaceId,
        localSessionId: base.localSessionId,
        ...pageObservation,
        observationHash: sha256Hex(canonicalJson(pageObservation)),
      });
    }
    const priorTerminal = scan.terminal.get(requestId);
    if (priorTerminal) {
      add(`cancelled/${requestId}.json`, {
        schemaVersion: 1,
        requestId,
        workspaceId,
        localSessionId: base.localSessionId,
        taskId: base.taskId,
        iteration: base.iteration,
        phase: base.phase,
        cancelledAt: priorTerminal.timestamp,
        ...(priorTerminal.hostFailure ? { hostFailure: priorTerminal.hostFailure } : {}),
        ...(priorTerminal.hostObservedResult ? { hostObservedResult: priorTerminal.hostObservedResult } : {}),
      });
    }
    const evidence = scan.lateEvidence.get(requestId);
    if (evidence) add(`late-evidence/${requestId}.json`, evidence);
  }
  for (const [localSessionId, requestId] of scan.active) {
    const base = scan.baseRequests.get(requestId)!;
    add(`active/${localSessionId}.json`, base);
  }
  return files;
}

function assertSourceMatchesMigration(
  workspaceId: string,
  marker: ControlRequestMigrationMarker,
  legacyRoot: string | null,
): LegacyStoreScan | null {
  if (!legacyRoot) {
    if (marker.sourceManifestSha256 !== null && marker.cleanupAuthorizedAt === null) {
      integrityError("legacy Computer Use source disappeared before cleanup");
    }
    validateMigratedFiles(workspaceId, workspaceDir(workspaceId), marker.migratedFiles);
    return null;
  }
  const sourceManifestSha256 = legacyTreeManifest(legacyRoot);
  if (marker.sourceManifestSha256 !== sourceManifestSha256) {
    integrityError("legacy control source changed after migration; cleanup refused");
  }
  const scan = scanLegacyStore(workspaceId, legacyRoot);
  const expected = migratedFileDigests(migrationFilesForScan(workspaceId, scan, legacyRoot));
  if (canonicalJson(expected) !== canonicalJson(marker.migratedFiles)) {
    integrityError("legacy Computer Use migration manifest changed; cleanup refused");
  }
  validateMigratedFiles(workspaceId, workspaceDir(workspaceId), expected);
  return scan;
}

function ensureControlRequestStoreUnlocked(workspaceId: string): void {
  const controlRoot = ensureControlRequestRoot();

  const finalRoot = workspaceDir(workspaceId);
  if (safeRealDirectory(finalRoot, "control request workspace root")) {
    validateMigrationMarker(workspaceId);
    validateControlRequestStoreDirectories(finalRoot);
    return;
  }
  if (fs.lstatSync(finalRoot, { throwIfNoEntry: false })) {
    integrityError("control request workspace root is not a real directory");
  }

  const legacyRoot = safeLegacyRoot(workspaceId);
  const sourceManifestSha256 = legacyRoot ? legacyTreeManifest(legacyRoot) : null;
  const scan = legacyRoot ? scanLegacyStore(workspaceId, legacyRoot) : null;
  const stagePrefix = `.${workspaceId}.stage-`;
  for (const name of fs.readdirSync(controlRoot)) {
    if (!name.startsWith(stagePrefix)) continue;
    const staleStage = path.join(controlRoot, name);
    if (!safeRealDirectory(staleStage, "incomplete control request staging root")) {
      integrityError("incomplete control request staging root is unsafe");
    }
    fs.rmSync(staleStage, { recursive: true, force: false });
  }

  const stage = path.join(controlRoot, `${stagePrefix}${process.pid}-${randomBytes(8).toString("hex")}`);
  fs.mkdirSync(stage, { mode: 0o700 });
  try {
    for (const directory of [...CONTROL_REQUEST_STORE_DIRECTORIES, "locks"]) ensureDir(path.join(stage, directory));
    ensureDir(path.join(stage, "migration-source"));
    if (scan && legacyRoot) {
      const migrationFiles = migrationFilesForScan(workspaceId, scan, legacyRoot);
      for (const [relativeFile, value] of migrationFiles) {
        writeSecureJsonExclusive(path.join(stage, ...relativeFile.split("/")), value);
        writeSecureJsonExclusive(path.join(stage, "migration-source", ...relativeFile.split("/")), value);
      }
      const allIds = [...scan.migrationRequestIds].sort();
      for (const requestId of allIds) {
        const base = scan.baseRequests.get(requestId)!;
        if (base.surfaceGeneration === null || base.surfaceTabId === null) integrityError("migration selected a request without complete Computer Use identity");
      }
    }
    const files = scan && legacyRoot
      ? migratedFileDigests(migrationFilesForScan(workspaceId, scan, legacyRoot))
      : [];
    if (legacyRoot && legacyTreeManifest(legacyRoot) !== sourceManifestSha256) {
      integrityError("legacy control source changed while migration was being staged");
    }
    validateMigratedFiles(workspaceId, stage, files);
    writeSecureJsonExclusive(
      path.join(stage, "migration-v1.json"),
      migrationMarker(workspaceId, sourceManifestSha256, files),
    );
    fs.renameSync(stage, finalRoot);
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

function ensureControlRequestStore(workspaceId: string): void {
  const resolvedWorkspaceId = validateControlId(workspaceId, "workspace id");
  ensureControlRequestRoot();
  const finalRoot = workspaceDir(resolvedWorkspaceId);
  if (safeRealDirectory(finalRoot, "control request workspace root")) {
    validateMigrationMarker(resolvedWorkspaceId);
    validateControlRequestStoreDirectories(finalRoot);
    return;
  }
  ensureMigrationLockRoot();
  withFileLock(migrationLockFile(resolvedWorkspaceId), () => {
    ensureControlRequestStoreUnlocked(resolvedWorkspaceId);
  });
}

function legacyRetirementDirectory(workspaceId: string, retirementId: string): string {
  if (!/^[a-f0-9]{32}$/.test(retirementId)) integrityError("legacy retirement id is invalid");
  const parent = path.dirname(legacyWorkspaceDir(workspaceId));
  if (!safeRealDirectory(parent, "legacy control root")) integrityError("legacy control root is missing");
  return path.join(parent, `.${validateControlId(workspaceId, "workspace id")}.retired-${retirementId}`);
}

function matchesRetirementIdentity(stat: fs.Stats, retirement: LegacyRetirementState): boolean {
  return String(stat.dev) === retirement.device && String(stat.ino) === retirement.inode;
}

function removeRetiredLegacyRoot(
  workspaceId: string,
  marker: ControlRequestMigrationMarker,
  legacyRoot: string | null,
): boolean {
  const retirement = marker.retirement;
  if (!retirement) return false;
  const retiredRoot = legacyRetirementDirectory(workspaceId, retirement.id);
  let retiredStat = fs.lstatSync(retiredRoot, { throwIfNoEntry: false });
  if (retiredStat && (retiredStat.isSymbolicLink() || !retiredStat.isDirectory())) {
    integrityError("retired legacy workspace root is unsafe");
  }
  const legacyStat = legacyRoot ? fs.lstatSync(legacyRoot, { throwIfNoEntry: false }) : null;

  if (retirement.phase === "reserved") {
    if (legacyStat && retiredStat) integrityError("legacy source exists at both original and retirement paths");
    if (legacyStat) {
      if (
        legacyStat.isSymbolicLink() || !legacyStat.isDirectory() ||
        !matchesRetirementIdentity(legacyStat, retirement) ||
        legacyTreeManifest(legacyRoot!) !== marker.sourceManifestSha256
      ) integrityError("legacy source changed after retirement was authorized");
      if (fs.lstatSync(retiredRoot, { throwIfNoEntry: false })) {
        integrityError("legacy retirement destination already exists");
      }
      fs.renameSync(legacyRoot!, retiredRoot);
      retiredStat = fs.lstatSync(retiredRoot);
      if (!matchesRetirementIdentity(retiredStat, retirement)) {
        integrityError("retired legacy workspace root identity changed during rename");
      }
    } else if (!retiredStat) {
      integrityError("authorized legacy source is missing from both original and retirement paths");
    }

    if (!matchesRetirementIdentity(retiredStat!, retirement)) {
      integrityError("retired legacy workspace root identity changed");
    }
    assertSafeTree(retiredRoot, "retired legacy workspace root");
    if (legacyTreeManifest(retiredRoot) !== marker.sourceManifestSha256) {
      integrityError("retired legacy source changed before deletion was authorized");
    }
    retirement.phase = "deleting";
    writeSecureJson(migrationFile(workspaceId), marker);
  } else if (legacyStat) {
    integrityError("legacy source reappeared after retirement deletion began");
  }

  retiredStat = fs.lstatSync(retiredRoot, { throwIfNoEntry: false });
  if (retiredStat) {
    if (
      retiredStat.isSymbolicLink() || !retiredStat.isDirectory() ||
      !matchesRetirementIdentity(retiredStat, retirement)
    ) integrityError("retired legacy workspace root identity changed during cleanup");
    assertSafeTree(retiredRoot, "retired legacy workspace root");
    fs.rmSync(retiredRoot, { recursive: true, force: false });
  }

  marker.retirement = null;
  writeSecureJson(migrationFile(workspaceId), marker);
  return retiredStat !== null;
}

export interface LegacyControlMailboxCleanupResult {
  workspaceId: string;
  removed: boolean;
  migratedRequestCount: number;
  liveRequestCount: number;
}

/** Migrate and remove only one workspace's verified legacy mailbox root. */
export function clearLegacyControlMailbox(workspaceId: string): LegacyControlMailboxCleanupResult {
  const resolvedWorkspaceId = validateControlId(workspaceId, "workspace id");
  ensureControlRequestStore(resolvedWorkspaceId);
  ensureMigrationLockRoot();
  return withFileLock(maintenanceLockFile(resolvedWorkspaceId), () =>
    withFileLock(migrationLockFile(resolvedWorkspaceId), () => {
      const marker = validateMigrationMarker(resolvedWorkspaceId);
      const newRequests = listRequests(resolvedWorkspaceId);
      const newLiveRequests = newRequests.filter((request) => isUnfinished(resolvedWorkspaceId, request)).length;
      const legacyRoot = safeLegacyRoot(resolvedWorkspaceId);
      const legacy = assertSourceMatchesMigration(resolvedWorkspaceId, marker, legacyRoot);
      const liveRequestCount = Math.max(newLiveRequests, legacy?.liveRequestCount ?? 0);
      if (liveRequestCount > 0) {
        throw new ControlRequestError(
          "CONTROL_REQUEST_TURN_IN_PROGRESS",
          `legacy mailbox cleanup refused while ${liveRequestCount} control request(s) are live`,
        );
      }
      let removed = false;
      if (legacyRoot) {
        if (!safeRealDirectory(legacyRoot, "legacy workspace root")) integrityError("legacy workspace root changed during cleanup");
        if (legacyTreeManifest(legacyRoot) !== marker.sourceManifestSha256) {
          integrityError("legacy control source changed during cleanup; retry migration before removal");
        }
        validateMigratedFiles(resolvedWorkspaceId, workspaceDir(resolvedWorkspaceId), marker.migratedFiles);
        if (marker.retirement === null) {
          if (marker.sourceManifestSha256 === null) integrityError("legacy source has no migration manifest");
          const sourceStat = fs.lstatSync(legacyRoot);
          marker.cleanupAuthorizedAt = new Date().toISOString();
          marker.retirement = {
            id: randomBytes(16).toString("hex"),
            device: String(sourceStat.dev),
            inode: String(sourceStat.ino),
            phase: "reserved",
          };
          writeSecureJson(migrationFile(resolvedWorkspaceId), marker);
        }
      }
      if (marker.retirement !== null) {
        removed = removeRetiredLegacyRoot(resolvedWorkspaceId, marker, legacyRoot);
      }
      return {
        workspaceId: resolvedWorkspaceId,
        removed,
        migratedRequestCount: marker.migratedFiles.filter((file) => file.path.startsWith("requests/")).length,
        liveRequestCount,
      };
    }),
  );
}
