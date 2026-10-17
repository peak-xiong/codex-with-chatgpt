import { z } from "zod";
import { createHash } from "node:crypto";
import { browserTabIdSchema } from "../session/browser-tab-id.js";
import type { ControlRequestSnapshot } from "./requests.js";
import {
  canonicalJson,
  ControlRequestError,
  c2cIdSchema,
  parseControlResultSubmission,
  controlResultSubmissionSchema,
} from "./result-schema.js";

export const CONTROL_PAGE_CHECK_INTERVAL_MS = 30_000;
export const CONTROL_RESULT_FINAL_STABILITY_MS = 1_500;

const observationBase = {
  tabId: browserTabIdSchema,
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  observedAt: z.string().datetime(),
  responseToRequestId: c2cIdSchema,
  observationSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
};

const observedPageIdentity = z.object({
  ...observationBase,
  observedUrl: z.string().url().max(4_096),
}).strict();

const responseIdentity = observedPageIdentity.extend({
  // Browser locators are not necessarily C2C identifiers (e.g. contain ':' or '/').
  // Normalize once at the protocol boundary; a repeated locator has the same id.
  responseId: z.string().min(1).max(1024).refine((value) => !/[\u0000-\u001f\u007f]/.test(value))
    .transform((value) => c2cIdSchema.safeParse(value).success ? value
      : `response-${createHash("sha256").update(value).digest("hex")}`),
}).strict();

const failureReasonSchema = z.enum([
  "model_refusal",
  "tool_unavailable",
  "platform_blocked",
  "capability_invalid",
  "result_invalid",
  "response_start_failed",
  "page_lost",
]);
const legacyFailureReasonSchema = z.enum([
  "model_refusal",
  "tool_unavailable",
  "platform_blocked",
  "capability_invalid",
  "callback_missing",
  "result_invalid",
  "response_start_failed",
  "page_lost",
]);
const failureSourceSchema = z.enum([
  "model_reported",
  "platform_error",
  "mcp_error",
  "host_observed",
]);
const failureToolSchema = z.enum(["business_tool"]).optional();
const legacyFailureToolSchema = z.enum([
  "report_control_progress",
  "submit_control_result",
  "get_control_result_status",
  "business_tool",
]).optional();
const failureCodeSchema = z.enum([
  "TOKEN_REVOKED",
  "TOKEN_EXPIRED",
  "STALE_BINDING_EPOCH",
  "TOOL_UNAVAILABLE",
  "SAFETY_CHECK_BLOCKED",
  "APPROVAL_REQUIRED",
  "UNKNOWN",
]).optional();

const computerUseCompletionEvidenceSchema = z.object({
  responseActionsVisible: z.literal(true),
  stopControlAbsent: z.literal(true),
}).strict();

const computerUseResultFields = {
  responseIsFinal: z.literal(true),
  delivery: z.literal("computer_use"),
  terminalResult: controlResultSubmissionSchema,
  completionEvidence: computerUseCompletionEvidenceSchema,
};

const computerUseFailureFields = {
  responseIsFinal: z.literal(true),
  reason: failureReasonSchema.exclude(["response_start_failed", "page_lost"]),
  source: failureSourceSchema,
  tool: failureToolSchema,
  errorCode: failureCodeSchema,
  completionEvidence: computerUseCompletionEvidenceSchema,
};

const legacyComputerUseFailureFields = {
  responseIsFinal: z.literal(true),
  reason: legacyFailureReasonSchema.exclude(["response_start_failed", "page_lost"]),
  source: failureSourceSchema,
  tool: legacyFailureToolSchema,
  errorCode: failureCodeSchema,
  completionEvidence: computerUseCompletionEvidenceSchema.optional(),
};

function requireHostObservedResultInvalid(
  value: { reason: string; source: string },
  context: z.RefinementCtx,
): void {
  if (value.reason === "result_invalid" && value.source !== "host_observed") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["source"],
      message: "result_invalid is only valid for host-observed Computer Use failures",
    });
  }
}

const computerUseFailureCandidateSchema = responseIdentity.extend({
  state: z.literal("result_candidate"),
  ...computerUseFailureFields,
}).strict().superRefine(requireHostObservedResultInvalid);

const finalHostFailureSchema = responseIdentity.extend({
  state: z.literal("final"),
  ...computerUseFailureFields,
}).strict().superRefine(requireHostObservedResultInvalid);

/** Historical page failures remain readable, but are never accepted as new observations. */
export const legacyFinalHostFailureSchema = responseIdentity.extend({
  state: z.literal("final"),
  ...legacyComputerUseFailureFields,
}).strict().superRefine(requireHostObservedResultInvalid);

const computerUseResultCandidateSchema = responseIdentity.extend({
  state: z.literal("result_candidate"),
  ...computerUseResultFields,
}).strict();

const resultCandidateSchema = z.union([
  computerUseResultCandidateSchema,
  computerUseFailureCandidateSchema,
]);

const finalComputerUseResultSchema = responseIdentity.extend({
  state: z.literal("final"),
  ...computerUseResultFields,
}).strict();

const responseStartFailureSchema = observedPageIdentity.extend({
  state: z.literal("response_start_failed"),
  reason: z.literal("response_start_failed"),
  source: z.literal("host_observed"),
  evidence: z.enum(["explicit_send_error", "explicit_response_error"]),
}).strict();

const pageLostHostFailureSchema = z.object({
  ...observationBase,
  state: z.literal("page_lost"),
  reason: z.literal("page_lost"),
  source: z.literal("host_observed"),
}).strict();

const authorityInvalidHostFailureSchema = z.object({
  ...observationBase,
  observedUrl: z.string().url().max(4_096).optional(),
  state: z.literal("authority_invalid"),
  reason: z.literal("capability_invalid"),
  source: z.enum(["mcp_error", "host_observed"]),
  errorCode: z.enum(["TOKEN_REVOKED", "TOKEN_EXPIRED", "STALE_BINDING_EPOCH"]),
}).strict();

// No free-form page excerpts: these diagnostics must not persist credentials or business data.
export const controlHostFailureSchema = z.union([
  finalHostFailureSchema,
  responseStartFailureSchema,
  pageLostHostFailureSchema,
  authorityInvalidHostFailureSchema,
]);

export const storedControlHostFailureSchema = z.union([
  controlHostFailureSchema,
  legacyFinalHostFailureSchema,
]);

export const controlHostObservedResultSchema = z.object({
  provenance: z.literal("host_observed"),
  observedAt: z.string().datetime(),
  result: controlResultSubmissionSchema,
}).strict();

const finalFailedObservationSchema = finalHostFailureSchema;

// Historical stored observations used these terminal shapes before the stability
// barrier. They are read only and may be replayed only when they exactly match storage.
const legacyFinalComputerUseResultSchema = responseIdentity.extend({
  state: z.literal("final"),
  responseIsFinal: z.literal(true),
  delivery: z.literal("computer_use"),
  terminalResult: controlResultSubmissionSchema,
}).strict();

const legacyFinalFailedObservationSchema = responseIdentity.extend({
  state: z.literal("final"),
  ...legacyComputerUseFailureFields,
  terminalResult: controlResultSubmissionSchema.optional(),
}).strict().superRefine(requireHostObservedResultInvalid);

const legacyFailureCandidateSchema = responseIdentity.extend({
  state: z.literal("result_candidate"),
  ...legacyComputerUseFailureFields,
}).strict().superRefine(requireHostObservedResultInvalid);

const legacyTerminalObservationSchema = z.union([
  legacyFinalComputerUseResultSchema,
  legacyFinalFailedObservationSchema,
]);

const legacyStoredObservationSchema = z.union([
  legacyFailureCandidateSchema,
  legacyTerminalObservationSchema,
]);

export const controlTerminalObservationSchema = z.union([
  finalComputerUseResultSchema,
  finalFailedObservationSchema,
  responseStartFailureSchema,
  pageLostHostFailureSchema,
  authorityInvalidHostFailureSchema,
]);

export const controlPageObservationSchema = z.union([
  observedPageIdentity.extend({ state: z.literal("send_attempted") }).strict(),
  observedPageIdentity.extend({ state: z.literal("sent") }).strict(),
  observedPageIdentity.extend({ state: z.literal("unknown") }).strict(),
  responseIdentity.extend({ state: z.literal("response_created") }).strict(),
  responseIdentity.extend({ state: z.literal("generating") }).strict(),
  resultCandidateSchema,
  finalComputerUseResultSchema,
  finalFailedObservationSchema,
  responseStartFailureSchema,
  pageLostHostFailureSchema,
  authorityInvalidHostFailureSchema,
]);

export type ControlHostFailure = z.infer<typeof storedControlHostFailureSchema>;
export type ControlHostObservedResult = z.infer<typeof controlHostObservedResultSchema>;
export type ControlTerminalObservation = z.infer<typeof controlTerminalObservationSchema>;
export type ControlPageObservation = z.infer<typeof controlPageObservationSchema>;
type LegacyTerminalObservation = z.infer<typeof legacyTerminalObservationSchema>;
type LegacyStoredObservation = z.infer<typeof legacyStoredObservationSchema>;
export type StoredControlPageObservation = ControlPageObservation | LegacyStoredObservation;
export type DefinitiveControlPageObservation = Exclude<StoredControlPageObservation, { state: "unknown" }>;

type CompletionObservation =
  | Extract<ControlPageObservation, { state: "result_candidate" }>
  | Extract<ControlPageObservation, { state: "final" }>
  | Extract<LegacyStoredObservation, { state: "result_candidate" }>;

function completionPayload(observation: CompletionObservation): unknown {
  return "delivery" in observation
    ? {
        type: "result",
        delivery: observation.delivery,
        terminalResult: observation.terminalResult,
        completionEvidence: observation.completionEvidence,
      }
    : {
        type: "failure",
        reason: observation.reason,
        source: observation.source,
        tool: observation.tool,
        errorCode: observation.errorCode,
        completionEvidence: observation.completionEvidence,
      };
}

export interface ControlPageObservationState {
  latest: StoredControlPageObservation;
  lastDefinitive: DefinitiveControlPageObservation | null;
  /** Gateway acceptance time; host-supplied observedAt is never used for stability. */
  latestAcceptedAt?: string;
  lastDefinitiveAcceptedAt?: string | null;
}

export function parseControlPageObservation(value: unknown): ControlPageObservation {
  const parsed = controlPageObservationSchema.safeParse(value);
  if (!parsed.success) {
    throw new ControlRequestError(
      "INVALID_RESULT",
      "invalid control page observation; raw page text and unlisted diagnostic fields are not accepted",
    );
  }
  if (!("terminalResult" in parsed.data)) return parsed.data;
  return {
    ...parsed.data,
    terminalResult: parseControlResultSubmission(parsed.data.terminalResult),
  };
}
function normalizeStoredTerminalObservation(value: LegacyTerminalObservation): LegacyTerminalObservation {
  if (!("terminalResult" in value) || value.terminalResult === undefined) return value;
  return { ...value, terminalResult: parseControlResultSubmission(value.terminalResult) };
}

/** Parse historical terminal data for audit and exact replay only; never use for new writes. */
export function parseStoredControlPageObservation(value: unknown): StoredControlPageObservation {
  const current = controlPageObservationSchema.safeParse(value);
  if (current.success) {
    const observation = current.data;
    return "terminalResult" in observation
      ? { ...observation, terminalResult: parseControlResultSubmission(observation.terminalResult) }
      : observation;
  }
  const legacy = legacyStoredObservationSchema.safeParse(value);
  if (legacy.success) {
    if (legacy.data.state === "result_candidate") return legacy.data;
    return normalizeStoredTerminalObservation(legacyTerminalObservationSchema.parse(legacy.data));
  }
  throw new ControlRequestError("INVALID_RESULT", "stored page observation payload is invalid");
}

/** True only for a legacy terminal payload identical to the terminal already on disk. */
export function isExactLegacyControlPageObservationReplay(
  previous: ControlPageObservationState | null,
  value: unknown,
): boolean {
  if (!previous) return false;
  if (controlPageObservationSchema.safeParse(value).success) return false;
  const legacy = legacyTerminalObservationSchema.safeParse(value);
  if (!legacy.success) return false;
  return canonicalJson(previous.latest) === canonicalJson(normalizeStoredTerminalObservation(legacy.data));
}

/** Validate late evidence correlation without treating it as an authorized delivery. */
export function parseLateControlPageObservation(
  previous: ControlPageObservationState | null,
  value: unknown,
): Extract<ControlPageObservation, { state: "final" }> {
  const observation = parseControlPageObservation(value);
  const prior = previous?.lastDefinitive;
  if (!previous || !prior || observation.state !== "final" ||
      observation.responseToRequestId !== prior.responseToRequestId ||
      observation.tabId !== prior.tabId || observation.generation !== prior.generation ||
      !("observedUrl" in prior) || observation.observedUrl !== prior.observedUrl ||
      ("responseId" in prior && observation.responseId !== prior.responseId) ||
      observation.observationSequence <= previous.latest.observationSequence ||
      Date.parse(observation.observedAt) <= Date.parse(prior.observedAt)) {
    throw new ControlRequestError(
      "CONTROL_REQUEST_CORRELATION_MISMATCH",
      "late response does not match the exact prompt, page, response, and sequence",
    );
  }
  return observation;
}

function isTerminalObservation(
  observation: StoredControlPageObservation,
): observation is ControlTerminalObservation {
  return controlTerminalObservationSchema.safeParse(observation).success;
}

/** Validate one exact, monotonically ordered page event without trusting page text. */
export function advanceControlPageObservation(
  previous: ControlPageObservationState | null,
  input: unknown,
  acceptedAt = new Date().toISOString(),
): { state: ControlPageObservationState; idempotentReplay: boolean; terminal: ControlTerminalObservation | null } {
  const observation = parseControlPageObservation(input);
  if (!Number.isFinite(Date.parse(acceptedAt)) || new Date(acceptedAt).toISOString() !== acceptedAt) {
    throw new ControlRequestError("INVALID_RESULT", "page observation acceptance time is invalid");
  }
  if (previous && observation.observationSequence === previous.latest.observationSequence) {
    if (JSON.stringify(observation) === JSON.stringify(previous.latest)) {
      return {
        state: previous,
        idempotentReplay: true,
        terminal: isTerminalObservation(previous.latest) ? previous.latest : null,
      };
    }
    throw new ControlRequestError("CONTROL_REQUEST_OBSERVATION_OUT_OF_ORDER", "page observation sequence conflicts with an existing event");
  }
  if (previous && observation.observationSequence < previous.latest.observationSequence) {
    throw new ControlRequestError("CONTROL_REQUEST_OBSERVATION_OUT_OF_ORDER", "page observation is stale or out of order");
  }
  const prior = previous?.lastDefinitive ?? null;
  if (observation.state === "unknown") {
    return {
      state: {
        latest: observation,
        lastDefinitive: prior,
        latestAcceptedAt: acceptedAt,
        lastDefinitiveAcceptedAt: previous?.lastDefinitiveAcceptedAt ?? null,
      },
      idempotentReplay: false,
      terminal: null,
    };
  }

  if (previous) {
    const priorLatest = previous.latest;
    if (observation.responseToRequestId !== priorLatest.responseToRequestId ||
        observation.tabId !== priorLatest.tabId || observation.generation !== priorLatest.generation) {
      throw new ControlRequestError("CONTROL_REQUEST_CORRELATION_MISMATCH", "page observation belongs to another request or page generation");
    }
  }

  const transitionAllowed =
    (observation.state === "send_attempted" && prior === null) ||
    (observation.state === "sent" && prior?.state === "send_attempted") ||
    (observation.state === "response_start_failed" &&
      (prior?.state === "send_attempted" || prior?.state === "sent")) ||
    (observation.state === "response_created" && prior?.state === "sent") ||
    (observation.state === "generating" &&
      (prior?.state === "sent" || prior?.state === "response_created" || prior?.state === "generating" || prior?.state === "result_candidate")) ||
    (observation.state === "result_candidate" &&
      (prior?.state === "sent" || prior?.state === "response_created" || prior?.state === "generating" || prior?.state === "result_candidate")) ||
    (observation.state === "final" && prior?.state === "result_candidate") ||
    observation.state === "page_lost" ||
    observation.state === "authority_invalid";
  if (!transitionAllowed) {
    throw new ControlRequestError("CONTROL_REQUEST_OBSERVATION_OUT_OF_ORDER", "page observation does not follow the exact response lifecycle");
  }

  if (
    "responseId" in observation &&
    prior && "responseId" in prior &&
    (observation.responseId !== prior.responseId ||
      ("observedUrl" in observation && "observedUrl" in prior && observation.observedUrl !== prior.observedUrl))
  ) {
    throw new ControlRequestError("CONTROL_REQUEST_CORRELATION_MISMATCH", "page observation belongs to a replacement response or URL");
  }

  if (observation.state === "final") {
    if (prior?.state !== "result_candidate" ||
        canonicalJson(completionPayload(prior)) !== canonicalJson(completionPayload(observation))) {
      throw new ControlRequestError("CONTROL_REQUEST_CORRELATION_MISMATCH", "final observation requires its exact completion candidate");
    }
    if (Date.parse(observation.observedAt) <= Date.parse(prior.observedAt)) {
      throw new ControlRequestError("CONTROL_REQUEST_OBSERVATION_OUT_OF_ORDER", "final observation requires a newer UI observation");
    }
    const candidateAcceptedAt = previous?.lastDefinitiveAcceptedAt;
    if (candidateAcceptedAt == null ||
        Date.parse(acceptedAt) - Date.parse(candidateAcceptedAt) < CONTROL_RESULT_FINAL_STABILITY_MS) {
      throw new ControlRequestError("CONTROL_REQUEST_OBSERVATION_OUT_OF_ORDER", "final observation requires a fresh stability recheck");
    }
  }

  const sameCandidate = observation.state === "result_candidate" && prior?.state === "result_candidate" &&
    canonicalJson(completionPayload(prior)) === canonicalJson(completionPayload(observation));
  const state: ControlPageObservationState = {
    latest: observation,
    lastDefinitive: observation,
    latestAcceptedAt: acceptedAt,
    lastDefinitiveAcceptedAt: sameCandidate
      ? previous?.lastDefinitiveAcceptedAt ?? acceptedAt
      : acceptedAt,
  };
  return {
    state,
    idempotentReplay: false,
    terminal: isTerminalObservation(observation) ? observation : null,
  };
}

export function controlWaitPolicy(
  status: ControlRequestSnapshot,
  now = Date.now(),
) {
  const remainingMs = status.request ? Math.max(0, Date.parse(status.request.expiresAt) - now) : 0;
  const computerUseDelivered = status.status === "cancelled" && status.hostObservedResult !== undefined &&
    (!status.hostFailure || status.hostObservedResult.result.kind === "BLOCKED");
  const activeKind = status.hostObservedResult?.result.kind;
  const outcome = computerUseDelivered
    ? activeKind === "BLOCKED" ? "blocked" : "delivered"
    : status.status !== "pending" ? "terminal" : "pending";
  const observedState = status.pageObservation?.lastDefinitive?.state;
  const pendingAction = observedState === undefined
    ? "mark_send_attempted"
    : observedState === "send_attempted"
      ? "confirm_send"
      : observedState === "sent"
        ? "inspect_response_start"
        : observedState === "result_candidate"
          ? "confirm_response_final"
        : "inspect_exact_response";
  return {
    outcome,
    state: status.lateEvidence ? "evidence_only" : computerUseDelivered
      ? outcome === "blocked" ? "blocked" : "delivered"
      : status.hostFailure ? "failed" : status.status,
    result: computerUseDelivered ? status.hostObservedResult?.result ?? null : null,
    delivery: computerUseDelivered ? "computer_use" : "none",
    nextAction: status.lateEvidence ? "review_late_evidence"
      : outcome === "pending" ? pendingAction : "stop",
    leaseExpiresAt: status.request?.expiresAt ?? null,
    leaseRemainingMs: remainingMs,
    elapsedMs: status.request ? Math.max(0, now - Date.parse(status.request.createdAt)) : 0,
    checkPageAfterMs: outcome === "pending" && remainingMs > 0
      ? Math.min(
          observedState === "result_candidate" ? CONTROL_RESULT_FINAL_STABILITY_MS : CONTROL_PAGE_CHECK_INTERVAL_MS,
          Math.max(1, Math.floor(remainingMs / 2)),
        ) : 0,
  };
}
