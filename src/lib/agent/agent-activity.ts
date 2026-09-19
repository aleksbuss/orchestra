/**
 * Operator-facing activity feed for the single-agent recovery path.
 *
 * WHY THIS EXISTS. The delivery ladder (`final-answer-failover.ts`) narrates
 * every decision it makes — fourteen `console.warn` calls — and publishes
 * NOTHING to the UI. Measured on a real production turn (2026-09-13): the brain
 * timed out, the cascade walked two substitutes, the second delivered, the chat
 * persisted correctly — and the whole story went to the server terminal while
 * the browser showed an apparently empty turn. That is the mechanical cause of
 * the recurring operator report "why didn't failover run?". It ran every time.
 * It was invisible.
 *
 * WHY A CLOSED VOCABULARY INSTEAD OF FREE-FORM STRINGS. The obvious cut is to
 * mirror each `console.warn` into `publishUiSyncEvent({ reason })`. Rejected on
 * a security read: those strings interpolate upstream text — `error.message`
 * from a failed `createModel`, a tool name the MODEL printed — and the one
 * existing precedent for free-form activity, `summarizeToolArgs` in `agent.ts`,
 * falls back to `JSON.stringify(args)` and ships 80 characters of arbitrary
 * tool input over SSE to every connected tab.
 *
 * So the public surface here accepts NO caller-supplied string at all. It takes
 * a code from a fixed union plus numbers, enums, and `ModelConfig`s whose labels
 * are derived in this file from our OWN configuration. Display text is a
 * template over exactly those. A caller cannot route model output through this
 * module — that is enforced by the parameter types, not by review vigilance.
 * If you find yourself wanting to add `detail?: string`, don't: add a code.
 *
 * NOT a logging replacement. The `console.warn` lines stay where they are. They
 * carry the long-form rationale that makes a postmortem readable and several
 * POST_MORTEMS.md entries quote their wording. This is the short, operator-
 * legible sibling that reaches the UI, not a second copy of the forensics.
 *
 * WHY TIMING IS STAMPED HERE AND NOT AT THE CALL SITE. The ladder's signature
 * failure is budget exhaustion — "attempt one burned 43s of a 50s aggregate
 * budget" — and a flat activity line with no timing structurally cannot answer
 * it (the protake council's strongest objection to this design, 2026-09-13).
 * `activityReporter` closes over the instant recovery began and stamps every
 * event it emits, so a call site cannot forget the one field that makes the
 * feed diagnostic rather than decorative.
 */
import { publishUiSyncEvent } from "@/lib/realtime/event-bus";
import type { DegradationPolicy } from "@/lib/agent/degradation-policy";
import type { ModelConfig } from "@/lib/types";

/**
 * Every activity this path can report. Add a member rather than smuggling
 * detail through an existing one — the union IS the redaction boundary.
 */
export type AgentActivityCode =
  | "cascade_started"
  | "cascade_started_markup"
  | "brain_circuit_open"
  | "brain_retry_skipped_markup"
  | "brain_retry_skipped_nontransient"
  | "brain_retry_skipped_deadline"
  | "substitute_trying"
  | "substitute_build_failed"
  | "substitute_delivered"
  | "cascade_budget_exhausted"
  | "cascade_all_breakers_open"
  | "cascade_substitution_not_allowed"
  | "cascade_exhausted"
  | "recovery_aborted";

/**
 * Where in the ladder an abort landed. An enum rather than the free-form
 * `phase` string `logRecoveryAborted` takes, for the reason in the docblock.
 */
export type RecoveryAbortPhase =
  | "brain_attempt_1"
  | "brain_retry_backoff"
  | "brain_attempt_2"
  | "before_substitute"
  | "after_substitute";

export interface AgentActivityFields {
  /** The endpoint that failed to deliver — rendered as `provider/model`. */
  endpoint?: ModelConfig;
  /** The candidate being tried instead. */
  substitute?: ModelConfig;
  /** 1-based position of `substitute` in the cascade. */
  attempt?: number;
  /** Total candidates in the pool after dedup and sorting. */
  candidateCount?: number;
  /** Candidates the budget cut off before they were tried. */
  remainingCount?: number;
  /** Aggregate cascade budget in force for this run. */
  budgetMs?: number;
  /** Per-attempt deadline in force for this run. */
  attemptDeadlineMs?: number;
  /** Operator's degradation policy, when it is what decided the branch. */
  policy?: DegradationPolicy;
  /** Size of the printed markup that triggered recovery. A count, never text. */
  markupChars?: number;
  /** Where an abort landed. */
  phase?: RecoveryAbortPhase;
  /**
   * Milliseconds since recovery began. Stamped by `activityReporter`; passing
   * it by hand is possible but means one call site can drift from the rest.
   */
  elapsedMs?: number;
}

/** `provider/model`, or a neutral noun when the slot was never configured. */
function label(model: ModelConfig | undefined): string {
  return model ? `${model.provider}/${model.model}` : "the configured model";
}

/** Human durations — an operator reads "43.2s", not "43217ms". */
function duration(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "unknown time";
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

/** Whole-number counts; guards against a `NaN` reaching the pane. */
function count(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value as number)) : 0;
}

const ABORT_PHASE_TEXT: Record<RecoveryAbortPhase, string> = {
  brain_attempt_1: "after the first attempt on the configured model",
  brain_retry_backoff: "during the retry backoff",
  brain_attempt_2: "after the retry on the configured model",
  before_substitute: "before starting a substitute",
  after_substitute: "after a substitute attempt",
};

/**
 * The code-to-text map. Pure and exported so the wording is directly testable
 * without a bus, and so a reviewer can audit every string that can reach a
 * browser in one place.
 */
export function renderAgentActivity(
  code: AgentActivityCode,
  fields: AgentActivityFields = {}
): string {
  const endpoint = label(fields.endpoint);
  const substitute = label(fields.substitute);
  const elapsed = duration(fields.elapsedMs);

  switch (code) {
    case "cascade_started":
      return (
        `[Failover] ${endpoint} delivered nothing — starting the substitute cascade ` +
        `(${duration(fields.budgetMs)} aggregate budget, ${duration(fields.attemptDeadlineMs)} per attempt).`
      );
    case "cascade_started_markup":
      return (
        `[Failover] ${endpoint} printed ${count(fields.markupChars)} characters of tool markup ` +
        `instead of calling a tool — starting the cascade on the short budget ` +
        `(${duration(fields.budgetMs)} aggregate, ${duration(fields.attemptDeadlineMs)} per attempt).`
      );
    case "brain_circuit_open":
      return `[Failover] ${endpoint} has an open circuit — going straight to a substitute.`;
    case "brain_retry_skipped_markup":
      return (
        `[Failover] ${endpoint} printed a tool call as text — skipping the same-endpoint retry, ` +
        `which would re-send the context that caused it.`
      );
    case "brain_retry_skipped_nontransient":
      return (
        `[Failover] ${endpoint} failed in a way a retry cannot fix — skipping the same-endpoint ` +
        `retry and going straight to a substitute.`
      );
    case "brain_retry_skipped_deadline":
      return (
        `[Failover] ${endpoint} ran out of our attempt budget rather than failing — skipping the ` +
        `same-endpoint retry, which would hand it the same budget, and going straight to a substitute.`
      );
    case "substitute_trying":
      return (
        `[Failover] Trying substitute ${substitute} ` +
        `(candidate ${count(fields.attempt)} of ${count(fields.candidateCount)}, ${elapsed} elapsed).`
      );
    case "substitute_build_failed":
      return (
        `[Failover] Could not build ${substitute} — missing API key or invalid configuration. ` +
        `Skipping to the next candidate.`
      );
    case "substitute_delivered":
      return `[Failover] ${substitute} delivered the answer after ${elapsed}.`;
    case "cascade_budget_exhausted":
      return (
        `[Failover] Cascade budget of ${duration(fields.budgetMs)} ran out after ${elapsed} — ` +
        `${count(fields.remainingCount)} candidate(s) left untried.`
      );
    case "cascade_all_breakers_open":
      return (
        `[Failover] ${endpoint} delivered nothing and all ${count(fields.candidateCount)} ` +
        `substitute candidate(s) have an open circuit. Nothing healthy left to try.`
      );
    case "cascade_substitution_not_allowed":
      return (
        `[Failover] ${endpoint} delivered nothing, and the "${fields.policy ?? "speed"}" degradation ` +
        `policy keeps your chosen model. Not substituting.`
      );
    case "cascade_exhausted":
      return `[Failover] Every candidate was tried over ${elapsed}; none delivered an answer.`;
    case "recovery_aborted":
      return (
        `[Failover] Recovery stopped ${ABORT_PHASE_TEXT[fields.phase ?? "before_substitute"]} ` +
        `after ${elapsed} — the request was cancelled.`
      );
  }
}

export interface AgentActivityTarget {
  /** Without a chat to attach to, the UI has no scope to match — see below. */
  chatId?: string;
  projectId?: string | null;
}

/**
 * Publish one activity line. A no-op without a `chatId`: `matchesScope` in
 * `use-background-sync.ts` filters chat events by id, so an unscoped event
 * could not reach a pane anyway, and emitting it would only add bus traffic
 * during unit tests that construct the ladder without a chat.
 */
export function publishAgentActivity(
  target: AgentActivityTarget,
  code: AgentActivityCode,
  fields: AgentActivityFields = {}
): void {
  if (!target.chatId) return;
  try {
    publishUiSyncEvent({
      topic: "chat",
      chatId: target.chatId,
      projectId: target.projectId ?? null,
      reason: renderAgentActivity(code, fields),
    });
  } catch {
    // Telemetry must never break a recovery that is already degraded. The bus
    // itself swallows listener faults; this guards the publish call.
  }
}

/**
 * Bind a target and a start instant once, so every call site is one argument
 * shorter and `elapsedMs` cannot be forgotten.
 */
export function activityReporter(
  target: AgentActivityTarget,
  startedAt: number
): (code: AgentActivityCode, fields?: AgentActivityFields) => void {
  return (code, fields = {}) =>
    publishAgentActivity(target, code, {
      ...fields,
      elapsedMs: fields.elapsedMs ?? Date.now() - startedAt,
    });
}
