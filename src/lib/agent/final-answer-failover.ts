/**
 * Final-answer delivery failover (free-tier track, Sprint 3).
 *
 * WHERE THIS SITS. Sprints 1–2 harden the PROPOSER fan-out. The brain — the
 * final `streamText` that actually answers the user — had no such protection:
 * when a throttled free endpoint answers HTTP 200 with an empty body, the turn
 * ends with nothing delivered, PM #69's forced final answer runs ONCE on the
 * SAME (still throttled) endpoint, gets another empty body, and
 * `resolveTurnContinuation` returned `{ text: "" }` **silently**. The user saw
 * an empty turn with no explanation. That is the single worst delivery failure
 * in the stack, because unlike a dropped proposer it has no survivors.
 *
 * WHAT THIS DOES — a bounded ladder, in order:
 *   1. the brain model (PM #69's existing forced answer);
 *   2. ONE retry on the brain after a jittered, abort-aware backoff — unless the
 *      breaker says the endpoint is dead, in which case skip straight to 3;
 *   3. a CASCADE through the substitute pool (`buildFinalAnswerPool` — the
 *      operator's `utilityModel` + the 3 proposer tiers, ≤4 candidates, deduped
 *      against each other and the brain), trying each in order until one
 *      succeeds, skipping circuit-open endpoints, bounded by
 *      `ORCHESTRA_FALLBACK_CASCADE_BUDGET_MS` (default 600s) so a string of dead
 *      free endpoints cannot stack unboundedly. Every substitution is announced
 *      LOUDLY (a substituted answer must never look like a normal one).
 * PM #113 — step 3 used to try exactly ONE substitute and stop; in Free Mode,
 * once the pool is ranked by capability (`free-mode.ts`'s `sortFreeModelsByScore`),
 * this is what makes "if the strong model errors, fall to the next" true for the
 * whole pool rather than for one candidate.
 * If nothing in the ladder answers, the caller gets an explicit operator notice
 * instead of silence.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It never re-runs the tool-capable stream.
 * "Zero output reached the client" does NOT prove the remote side executed
 * nothing — a tool may have run before the stream dropped, so replaying that
 * request risks a DOUBLE side effect (a second file write, a second command).
 * Every attempt here is TOOL-LESS by construction, which sidesteps the hazard
 * entirely: the worst case is a wasted generation, never a repeated action.
 *
 * Cost: zero on a healthy turn. This code only runs on a turn that already
 * delivered nothing.
 */

import { callDeadlineSignal } from "@/lib/agent/stream-watchdog";
import { generateText, type ModelMessage } from "ai";
import type { RawUsage } from "@/lib/cost/accumulator";
import { getOpenRouterBenchmarkScore } from "@/lib/cost/openrouter-pricing";
import { createModel } from "@/lib/providers/llm-provider";
import { resolveMaxOutputTokens } from "@/lib/providers/model-output-limits";
import { estimateTokenCount } from "@/lib/agent/compressor";
import { governMessages } from "@/lib/agent/token-governor";
import { FORCED_ANSWER_TOOL_OVERRIDE } from "@/lib/agent/prompts";
import { gateForcedAnswer } from "@/lib/agent/printed-tool-call";
import type { AppSettings, ModelConfig } from "@/lib/types";
import {
  classifyModelFailure,
  isModelCircuitOpen,
  recordModelFailure,
  recordModelSuccess,
} from "@/lib/agent/model-health";
import { abortableSleep } from "@/lib/agent/proposer-pacing";
import { resolveWorkerKey } from "@/lib/agent/moa-personas";
import {
  allowsModelSubstitution,
  undeliverableNotice,
  type DegradationPolicy,
} from "@/lib/agent/degradation-policy";

/**
 * PM #109 follow-up — the forced answer runs at a SHORT context AND a small
 * output cap.
 *
 * MEASURED (live, chat 9891bb43): the forced answer ITSELF degraded into a
 * printed `write_text_file` markup blob — provider-reported 68 317 prompt tokens,
 * a 14 881-byte argument. The main-turn re-issue (PM #109, already short-context)
 * never ran because the main turn ended with NO delivery, not printed markup, so
 * the whole failure travelled through this path — which was passing the full
 * transcript verbatim.
 *
 * A tool-less call has no native channel to "collapse"; a council review
 * (protake, 4 frontier models) corrected the causal model: the forced answer
 * degrades because (a) a weak model loses instruction-following at long context
 * and (b) the transcript CONTAINS in-context examples of the failure (printed
 * markup, giant tool-result payloads) that the model imitates. Two levers, both
 * council-endorsed and neither risking a confidently-wrong summary:
 *
 *  - CONTEXT: prune once, via `governMessages`, which the token governor already
 *    uses — it is pair-safe (SDK `pruneMessages` by `toolCallId`) AND pins the
 *    leading system run + first user turn (the ORIGINAL TASK) as anchors, so the
 *    forced answer can still say what it was doing. The "write your final answer"
 *    instruction is the LAST message, so the recency slide always keeps it. This
 *    is NOT naive recency pruning (which would drop the task and keep the poison).
 *  - OUTPUT: cap `maxOutputTokens` so a 15 KB markup blob physically cannot form;
 *    a plain-prose fallback reply never needs more.
 *
 * Council levers NOT taken here (recorded, not built): a synthetic
 * task+execution-digest prompt replacing the transcript, and substituting a
 * tool-robust model. The latter is unavailable in Free Mode anyway — the whole
 * substitution pool (`utilityModel`, `proposerTiers.*`) is itself free-tier — so
 * for the case that actually fails, pruning + the output cap is the fix.
 */
const FORCED_ANSWER_CONTEXT_BUDGET = 24000;
const FORCED_ANSWER_MAX_OUTPUT_TOKENS = 8192;

/**
 * Prune the forced-answer transcript to the weak-model-safe budget. Exported for
 * direct unit testing — the property that matters is "task pinned, instruction
 * last, under budget", and it must never return empty.
 */
export function boundForcedAnswerContext(messages: ModelMessage[]): ModelMessage[] {
  if (estimateTokenCount(messages) <= FORCED_ANSWER_CONTEXT_BUDGET) return messages;
  return governMessages(messages, FORCED_ANSWER_CONTEXT_BUDGET);
}

/** Backoff before the single brain retry (jittered — see `emptyBackoffMs` in moa.ts). */
function retryBackoffMs(): number {
  const base = Number(process.env.ORCHESTRA_FINAL_ANSWER_BACKOFF_MS ?? 2000);
  return Math.round(base * (1 + Math.random() * 0.4));
}

/**
 * PM #113 — aggregate wall-clock budget for the substitute CASCADE (attempt 3+).
 *
 * Nothing bounded the ladder's total elapsed time before this — each
 * `attemptOnce` gets its own ~120s call deadline (`callDeadlineSignal`), but
 * nothing capped how many of those could stack. Read fresh per call, same
 * posture as `retryBackoffMs` above, so a test (or an operator) can change it
 * without a restart.
 */
function cascadeBudgetMs(): number {
  // PM #123 — was 90_000, then 300_000. `attemptOnce` bounds EACH candidate
  // with its own call deadline (`callDeadlineSignal`, `stream-watchdog.ts`, default 240s),
  // so the aggregate cascade budget must be sized to survive multiple full-length attempts.
  // 600s allows at least two full 240s slow attempts plus starting a third candidate.
  return Number(process.env.ORCHESTRA_FALLBACK_CASCADE_BUDGET_MS ?? 600_000);
}

/**
 * PM #134 — the cascade's budget when the brain failed by PRINTING A TOOL CALL
 * rather than by going silent.
 *
 * Before PM #134 the cascade practically never ran (reaching it required both
 * brain attempts to return falsy text), so the 300s budget above was paid on a
 * rare path. Markup is common on free models, so that same 300s is now spent on
 * a routine interactive turn — the operator waits minutes for a chat reply.
 *
 * ⚠️ 90s is EXACTLY the number PM #123 raised to 300s, and re-introducing it
 * naively re-introduces that defect: a 90s aggregate that is smaller than one
 * candidate's own 120s call deadline lets a single hung candidate eat the whole
 * budget and silently truncate a pool with healthy, untried models left in it.
 * So the per-attempt deadline is tightened ALONGSIDE it (below) — 90s only
 * makes sense as a bound once no single attempt can consume it. The two numbers
 * are a pair, and `markupAttemptDeadlineMs` CLAMPS to keep them one.
 *
 * What this bounds, precisely: the CASCADE, not the turn. Brain attempt 1 runs
 * before `cascadeStartedAt` on the default 120s call deadline, and the aggregate
 * is checked before STARTING an attempt, so an attempt already in flight runs
 * its own deadline out. Worst case on a markup-triggered turn is therefore about
 * 120s (brain) + 90s (cascade) + 30s (last attempt overshoot) ≈ 240s, not 90s.
 * Attempt 2 is skipped on markup, which is what keeps it from being 360s.
 */
function markupCascadeBudgetMs(): number {
  const raw = Number(process.env.ORCHESTRA_MARKUP_CASCADE_BUDGET_MS ?? 90_000);
  // A typo must not silently disable the bound. `NaN > x` is false, so an
  // unparseable value would make the budget check never fire — an UNBOUNDED
  // cascade, which is the opposite of what this function exists for.
  return Number.isFinite(raw) && raw > 0 ? raw : 90_000;
}

/**
 * Per-attempt deadline inside a markup-triggered cascade — the other half of
 * the pair above. The forced answer is short prose (already capped by
 * `FORCED_ANSWER_MAX_OUTPUT_TOKENS`), so a candidate that has not produced one
 * in 30s is not about to; waiting the full 120s only spends the aggregate
 * budget that the remaining candidates need. Three full-length attempts fit
 * inside the 90s budget, which is the whole pool minus the brain.
 */
function markupAttemptDeadlineMs(): number {
  const raw = Number(process.env.ORCHESTRA_MARKUP_ATTEMPT_DEADLINE_MS ?? 30_000);
  const wanted = Number.isFinite(raw) && raw > 0 ? raw : 30_000;
  // CLAMP, do not merely document (council review, 2026-09-07). The pair
  // invariant was asserted only in a test, which means it held for the DEFAULTS
  // and for nothing else: `ORCHESTRA_MARKUP_ATTEMPT_DEADLINE_MS=120000` against
  // the 90s budget re-creates PM #123 exactly — one hung candidate eats the
  // whole aggregate and the healthy untried candidates are dropped. A third of
  // the budget keeps room for the whole pool minus the brain.
  return Math.min(wanted, Math.floor(markupCascadeBudgetMs() / 3));
}

export interface FinalAnswerAttemptArgs {
  model: Parameters<typeof generateText>[0]["model"];
  systemPrompt: string;
  messages: ModelMessage[];
  providerOptions: Parameters<typeof generateText>[0]["providerOptions"];
  settings: AppSettings;
  abortSignal?: AbortSignal;
  /**
   * The brain's ModelConfig. Optional so existing callers keep working: without
   * it there is no endpoint identity to track health against and no pool to
   * substitute from, so the helper degrades to "one attempt", i.e. exactly the
   * pre-Sprint-3 behaviour.
   */
  brainConfig?: ModelConfig;
  projectId?: string;
  currentPath?: string;
  /**
   * Sprint 4 — what this run may do when the brain will not answer. `speed`
   * (default) substitutes a healthy configured model; `quality`/`ask` keep the
   * user's model and report honestly. Resolved by the caller (background runs
   * are forced to `speed`).
   */
  degradationPolicy?: DegradationPolicy;
  /**
   * Post-review addition (primary-stream recovery, `primary-stream-recovery.ts`).
   * Skip attempt 1/2 (the brain, plus its one same-endpoint retry) and go
   * straight to attempt 3 (substitute). Default `undefined` — every existing
   * caller (PM #69's onFinish path) is unaffected byte-for-byte.
   *
   * Set this ONLY when the caller already has fresh, same-turn, POSITIVE
   * evidence a same-endpoint retry cannot help (a deterministic 4xx, not a
   * 429/5xx/network blip — those CAN resolve between attempts and should
   * still get the retry). The caller decides this, not this function — it
   * has no access to the triggering error, only to the fact that recovery
   * was requested.
   */
  skipBrainRetry?: boolean;
}

export interface FinalAnswerResult {
  text: string;
  usage?: RawUsage;
  /** Operator-facing note: a substitution happened, or nothing could be delivered. */
  notice?: string;
  /**
   * PM #132 — which endpoint actually PRODUCED `text`. Absent when nothing was
   * delivered. Callers fold `usage` against this, not against the brain: on the
   * substitute path the tokens were burned by a different provider/model, and
   * pricing them as the brain's mis-bills the turn (free-tier substitutes make
   * the error invisible at 0 USD, paid ones do not).
   */
  endpoint?: ModelConfig;
  /**
   * PM #134 — set when the ladder ran out of candidates and the LAST thing any
   * of them produced was un-executed printed tool markup rather than an answer.
   *
   * Carried so the call site can still deliver the SPECIFIC "the model printed
   * the call as text" notice (which names Free Mode and the concrete way out)
   * instead of degrading to the generic undeliverable notice, and so the
   * degradation telemetry names the endpoint that actually emitted the markup.
   * Never carries the markup TEXT: it is never shown, and passing it around is
   * how it ends up persisted by accident.
   */
  markupDegradation?: {
    toolName: string;
    /**
     * Absent when the caller supplied no `brainConfig` — the degradation is
     * still real and must still be reported. Tying the SIGNAL to knowing the
     * endpoint dropped the honest notice entirely on that path and shipped an
     * empty turn (caught by `final-answer-guard.test.ts` while building this).
     */
    endpoint?: ModelConfig;
    markupChars: number;
  };
}

/**
 * The candidate models a substituted final answer may use.
 *
 * Drawn ONLY from the operator's own settings, which is what keeps Privacy Mode
 * intact: `assertPrivacyModeAllowsSettings` has already validated every one of
 * these, so a substitution can never route an air-gapped chat to a cloud model.
 *
 * Each candidate goes through `resolveWorkerKey`. These slots are routinely
 * stored as `{ provider, model }` with no key — that is the shape Free Mode's
 * overlay produces and the shape the model wizard writes — so without this the
 * substitute `createModel` throws "API Key is missing" for any operator whose
 * key lives in the vault rather than the environment. It is caught, so the
 * symptom is not a crash: the failover simply never substitutes, which is the
 * failure mode it exists to prevent.
 */
/**
 * The tail instruction for a tool-less "write your final answer now" attempt
 * — shared by BOTH call sites (`agent-response.ts`'s PM #69 path and
 * `primary-stream-recovery.ts`'s onError path) so they cannot drift apart the
 * way they just did (PM #119).
 *
 * `didWork` must reflect whether a REAL tool call executed in THIS turn
 * before the caller ended up here — not whether the conversation's history
 * happens to contain tool activity from an earlier, unrelated turn.
 *
 *  - `true` (PM #69's original case: a full tool loop ran this turn, the
 *    stream just didn't wrap it in a final response) — "you have everything
 *    you need from the steps above" is a TRUE premise; the model may
 *    summarize the real results it can see.
 *  - `false` (PM #119, 2026-08-31 live incident: the primary stream errored
 *    before ANY tool call executed this turn) — that premise is FALSE. A
 *    substitute model handed the unconditional version of this instruction
 *    confidently fabricated a completed task — specific file edits, specific
 *    test output — none of which happened. Council-reviewed (4take) rewrite:
 *    short, imperative, an exact required string for the failure case (no
 *    "what's still needed" slot — independently flagged by two reviewers as
 *    itself a fabrication vector: an invented-sounding "next step" is the
 *    same failure shape as the original incident, one level down).
 */
export function finalAnswerInstruction(didWork: boolean): string {
  if (didWork) {
    return (
      "You have everything you need from the steps above. Write your final " +
      "answer to the user now, in plain prose. Do not call any tools."
    );
  }
  return (
    "Do not call any tools. You have NOT performed any actions this turn — " +
    "no files were read or edited, no code was run, no web page was fetched. " +
    "If the user's request requires any of those, you MUST NOT claim to have " +
    'done them — respond with exactly: "I could not complete this — a ' +
    'technical failure occurred before any work was done." You may instead ' +
    "answer directly from your own knowledge ONLY if the request does not " +
    "need file access, code execution, or a web lookup to answer correctly " +
    "— never claim an action you did not take."
  );
}

export function buildFinalAnswerPool(settings: AppSettings): ModelConfig[] {
  return [
    settings.utilityModel,
    settings.proposerTiers?.frontier,
    settings.proposerTiers?.balanced,
    settings.proposerTiers?.fast,
  ]
    .filter((c): c is ModelConfig => Boolean(c?.model))
    .map((c) => resolveWorkerKey(c, settings));
}

/**
 * Strongest-first comparator for a `ModelConfig[]` pool — intelligence, then
 * agentic, then coding index as tiebreaks; unscored ids sort last, stable
 * among themselves. Extracted (tool-capable-retry work) so the tool-less
 * cascade below and `tool-capable-retry.ts`'s own candidate selection share
 * ONE comparator instead of two copies that could drift — see the cascade's
 * own 4take-review comment on exactly that drift risk.
 */
export function compareModelsByBenchmarkScoreDesc(a: ModelConfig, b: ModelConfig): number {
  const sa = getOpenRouterBenchmarkScore(a.model);
  const sb = getOpenRouterBenchmarkScore(b.model);
  const intelligenceDiff = (sb?.intelligence ?? -1) - (sa?.intelligence ?? -1);
  if (intelligenceDiff !== 0) return intelligenceDiff;
  const agenticDiff = (sb?.agentic ?? -1) - (sa?.agentic ?? -1);
  if (agenticDiff !== 0) return agenticDiff;
  const codingDiff = (sb?.coding ?? -1) - (sa?.coding ?? -1);
  if (codingDiff !== 0) return codingDiff;
  return 0; // stable sort — no score data on either side, keep assembly order
}

function readUsage(result: unknown): RawUsage | undefined {
  return (result as { usage?: RawUsage }).usage ?? undefined;
}

/** `provider/model`, or a stable placeholder when the slot is unknown. */
function endpointLabelFor(endpoint: ModelConfig | undefined): string {
  return endpoint ? `${endpoint.provider}/${endpoint.model}` : "the brain model";
}

/**
 * One attempt's outcome. `text` is non-empty ONLY when the endpoint delivered a
 * usable answer — `markup` says the attempt produced un-executed printed tool
 * markup instead, which is a failure wearing an answer's clothes.
 */
interface AttemptOutcome {
  text: string;
  usage?: RawUsage;
  markup?: { toolName: string; chars: number };
}

/**
 * Run ONE tool-less final-answer generation on `model`.
 * Returns `null` when the endpoint produced nothing (or threw).
 */
async function attemptOnce(
  model: Parameters<typeof generateText>[0]["model"],
  args: Omit<FinalAnswerAttemptArgs, "model">,
  endpoint?: ModelConfig,
  /** Override the per-call deadline — see `markupAttemptDeadlineMs`. */
  deadlineMs?: number
): Promise<AttemptOutcome | null> {
  try {
    const result = await generateText({
      model,
      system: args.systemPrompt,
      messages: args.messages,
      providerOptions: args.providerOptions,
      temperature: args.settings.chatModel.temperature ?? 0.7,
      // PM #109 follow-up — cap the forced answer's output. It is a plain-prose
      // fallback reply, so it never needs the full configured budget, and the
      // cap means the model cannot emit a 15 KB markup blob even if it starts to.
      maxOutputTokens: Math.min(
        resolveMaxOutputTokens(args.settings.chatModel),
        FORCED_ANSWER_MAX_OUTPUT_TOKENS
      ),
      // PM #98 — the RECOVERY ladder. It runs precisely when the brain has
      // already failed, so an unbounded call here turns a recoverable turn
      // into a total silent failure.
      abortSignal: callDeadlineSignal(args.abortSignal, deadlineMs),
    });
    const text = (result.text || "").trim();
    // PM #134 — a non-empty string is NOT proof of an answer. This ladder is
    // tool-less by construction, so a model that decides the request needs a
    // tool has no channel to call one and PRINTS the call as text instead. That
    // text is un-executed work; shipping it is the failure the call-site gate
    // exists to contain, and returning it HERE ends the ladder at this endpoint
    // — the substitute cascade below is never entered, and (worse) the endpoint
    // that just failed gets its breaker healed. Live incident 2026-09-07 (chat
    // 560896d7): attempt 1 threw, attempt 2 returned 289 chars of printed
    // `call_mcp_tool`, four healthy substitutes were never tried.
    //
    // `gateForcedAnswer` is used as a PREDICATE only. The success path returns
    // the RAW `text`, byte-identical to what this function has always returned,
    // so the call sites keep judging and persisting the exact same string.
    const gate = gateForcedAnswer(text);
    if (text && gate.degraded) {
      console.warn(
        `[Agent] Final-answer attempt on ${endpoint ? `${endpoint.provider}/${endpoint.model}` : "the brain model"} ` +
          `printed a '${gate.toolName}' tool call as TEXT instead of answering — ` +
          `not an answer, not a success; trying the next candidate.`
      );
      if (endpoint) recordModelFailure(endpoint.provider, endpoint.model, "markup");
      return {
        text: "",
        usage: readUsage(result),
        markup: { toolName: gate.toolName, chars: gate.text.length },
      };
    }
    if (text) {
      if (endpoint) recordModelSuccess(endpoint.provider, endpoint.model);
      return { text, usage: readUsage(result) };
    }
    // HTTP 200 with an empty body — the free-tier throttle signature. Was the
    // ONE unlogged failure path in this function (2026-08-31 live incident —
    // a cascade that visibly tried one candidate and stopped could not be
    // told apart from a genuine loop bug, because 2-3 silently-empty
    // candidates in between look IDENTICAL to "never attempted" in the logs).
    // Every other failure branch here already warns; this one now does too.
    console.warn(
      `[Agent] Final-answer attempt on ${endpoint ? `${endpoint.provider}/${endpoint.model}` : "the brain model"} ` +
        `returned an empty response (finishReason=${result.finishReason ?? "unknown"}) — trying the next candidate.`
    );
    if (endpoint) recordModelFailure(endpoint.provider, endpoint.model, "empty");
    return { text: "", usage: readUsage(result) };
  } catch (error) {
    // Same evidence rule as the proposer path: only endpoint-side signatures
    // count against the breaker, and a user abort never does.
    const kind = args.abortSignal?.aborted ? null : classifyModelFailure(error);
    if (endpoint && kind) recordModelFailure(endpoint.provider, endpoint.model, kind);
    console.warn(
      `[Agent] Final-answer attempt failed on ${endpoint ? `${endpoint.provider}/${endpoint.model}` : "the brain model"}: ` +
        (error instanceof Error ? error.message : String(error))
    );
    return null;
  }
}

/**
 * PM #120 — the LAST of the five silent-return classes found in this file
 * tonight (protake council, unanimous 4/4): `if (abortSignal?.aborted) return
 * { text: "", usage }` appears FIVE times in this function and none of them
 * logged. Same defect shape as PM #118's empty-response branch — a cascade
 * that stops here because the caller's HTTP request disconnected is
 * indistinguishable in the logs from one that tried every candidate and
 * failed, or from a genuine code bug that never entered the loop at all.
 * `req.signal` (the source of this signal — `src/app/api/chat/route.ts`)
 * reports aborted on more than deliberate user navigation: a proxy/platform
 * idle timeout, or (unconfirmed, worth instrumenting for) the primary
 * stream's own teardown closing a shared controller. Logging, not a
 * behavior change — a user abort correctly must not count as an endpoint
 * failure or force a substitute the client is no longer waiting for; this
 * only makes that decision visible instead of guessed-at after the fact.
 */
function logRecoveryAborted(phase: string, startedAt: number): void {
  console.warn(
    `[Agent] Final answer — recovery aborted (${phase}, ${Date.now() - startedAt}ms since ` +
      `recovery started). The caller's request signal is aborted — client disconnect, a ` +
      `proxy/platform timeout, or (unconfirmed) primary-stream teardown. Stopping rather than ` +
      `substituting for a request nobody is waiting on.`
  );
}

/**
 * Produce the turn's final answer with bounded retry + cross-model failover.
 *
 * Returns `text: ""` ONLY when every attempt failed — and then always with a
 * `notice`, so an undeliverable turn is explained rather than silent.
 */
export async function generateFinalAnswerWithFailover(
  args: FinalAnswerAttemptArgs
): Promise<FinalAnswerResult> {
  const { brainConfig, abortSignal } = args;
  const recoveryStartedAt = Date.now();
  // PM #109 follow-up — bound the context ONCE, up front, and reuse it for every
  // attempt. Prune-once (not per-attempt) is right for THIS pool: in Free Mode
  // every substitute is itself a free model, so there is no larger-window
  // candidate being starved; a stronger install rarely reaches this path because
  // its brain does not degrade. Pruning the transcript that CAUSED the degraded
  // forced answer is the point — the substitute must not inherit the full 68K.
  args = { ...args, messages: boundForcedAnswerContext(args.messages) };
  // PM #132 — every attempt below is tool-less, yet `args.systemPrompt` is the
  // FULL tool-capable prompt (it mandates `search_web`, the `response` tool,
  // goal trees). Countermand it ONCE here, for the brain retry and every
  // substitute alike, rather than leaving the "do not call tools" line alone in
  // a user message that the system prompt outranks. Prevention for the class the
  // residual gate at each call site only CONTAINS.
  args = { ...args, systemPrompt: args.systemPrompt + FORCED_ANSWER_TOOL_OVERRIDE };
  let usage: RawUsage | undefined;
  // PM #134 — the printed-markup degradation that TRIGGERED this recovery, so an
  // exhausted ladder can still report WHY nothing was delivered specifically
  // rather than falling back to the generic undeliverable notice.
  //
  // FIRST writer wins, not last (council review, 2026-09-07). The first cut kept
  // the last markup seen on any rung, which is incoherent with the budget being
  // decided once from the trigger, and misattributes the two consumers that
  // matter. Concretely: the brain prints 289 chars of `call_mcp_tool`, a
  // substitute then prints 40 chars of `search_web`, the ladder exhausts — and
  // last-wins reports `search_web` on the SUBSTITUTE. The PM #82 compaction
  // backstop then reads a degradation blamed on an endpoint whose context is not
  // the one that needs compacting, and the operator notice attaches its
  // Free-Mode steer to a model that may not even be the free one. The trigger is
  // the causal answer to "why did failover run?", so it is the one to keep.
  let markupDegradation: FinalAnswerResult["markupDegradation"];
  const noteMarkup = (attempt: AttemptOutcome | null, endpoint: ModelConfig | undefined) => {
    if (markupDegradation) return; // first wins — see above
    if (attempt?.markup) {
      markupDegradation = {
        toolName: attempt.markup.toolName,
        endpoint,
        markupChars: attempt.markup.chars,
      };
    }
  };

  const fold = (u: RawUsage | undefined) => {
    // Attempts are sequential and each one's tokens are billable, so keep the
    // LAST attempt's usage rather than dropping it (the cost banner would
    // otherwise under-report a turn that took three generations).
    if (u) usage = u;
  };

  // ── Attempt 1 — the brain, unless its breaker already says it is dead, or ──
  // the caller already has fresh evidence a same-endpoint retry cannot help.
  const brainTripped = brainConfig
    ? isModelCircuitOpen(brainConfig.provider, brainConfig.model)
    : false;

  if (!brainTripped && !args.skipBrainRetry) {
    const first = await attemptOnce(args.model, args, brainConfig);
    fold(first?.usage);
    noteMarkup(first, brainConfig);
    if (first?.text) return { text: first.text, usage, endpoint: brainConfig };
    if (abortSignal?.aborted) {
      logRecoveryAborted("after brain attempt 1", recoveryStartedAt);
      return { text: "", usage, markupDegradation };
    }

    // ── Attempt 2 — one retry on the brain after a backoff ──────────────────
    // Skipped when attempt 1 just tripped the breaker: retrying a known-dead
    // endpoint only delays the substitution that will actually deliver.
    const nowTripped = brainConfig
      ? isModelCircuitOpen(brainConfig.provider, brainConfig.model)
      : false;
    // PM #134 — also skipped when attempt 1 PRINTED a tool call. That is the
    // same class of evidence `skipBrainRetry` exists for: not a transient blip
    // this endpoint may shake off in 2.5s, but a model that has lost the
    // tool-calling channel under this exact context, which attempt 2 hands it
    // again unchanged. Spending a backoff plus a second full generation to
    // watch it fail identically only delays the substitute that can deliver.
    if (first?.markup) {
      console.warn(
        `[Agent] Final answer — skipping the same-endpoint retry on ${endpointLabelFor(brainConfig)}: ` +
          `attempt 1 printed a '${first.markup.toolName}' tool call as text, and the retry would ` +
          `re-send the same context that caused it. Going straight to a substitute model.`
      );
    }
    if (!nowTripped && !first?.markup) {
      await abortableSleep(retryBackoffMs(), abortSignal);
      if (abortSignal?.aborted) {
        logRecoveryAborted("during brain retry backoff", recoveryStartedAt);
        return { text: "", usage, markupDegradation };
      }
      const second = await attemptOnce(args.model, args, brainConfig);
      fold(second?.usage);
      noteMarkup(second, brainConfig);
      if (second?.text) return { text: second.text, usage, endpoint: brainConfig };
      if (abortSignal?.aborted) {
        logRecoveryAborted("after brain attempt 2", recoveryStartedAt);
        return { text: "", usage, markupDegradation };
      }
    }
  } else if (brainTripped) {
    console.warn(
      `[Agent] Final answer — circuit OPEN on ${brainConfig!.provider}/${brainConfig!.model}; ` +
        `going straight to a substitute model.`
    );
  } else if (brainConfig) {
    console.warn(
      `[Agent] Final answer — skipping the same-endpoint retry on ${brainConfig.provider}/${brainConfig.model} ` +
        `(the triggering error was not evidence of a transient condition); going straight to a substitute model.`
    );
  }

  // ── Attempt 3+ — cascade through the substitute pool ────────────────────────
  // PM #113 — this used to try exactly ONE substitute (a `.find()`) and give up.
  // Walks the pool in order instead (still ≤4 entries: `utilityModel` + the 3
  // proposer tiers — NOT the full free catalogue), skipping circuit-open and
  // duplicate candidates, stopping at the first success or a bounded aggregate
  // budget. "If the strong one errors, fall to the next" is only true
  // end-to-end once this doesn't stop after one.
  const policy: DegradationPolicy = args.degradationPolicy ?? "speed";
  const endpointLabel = brainConfig
    ? `${brainConfig.provider}/${brainConfig.model}`
    : "the configured model";
  if (!brainConfig) {
    return { text: "", usage, notice: undeliverableNotice(policy, endpointLabel, false), markupDegradation };
  }

  // Dedup by endpoint identity — `buildFinalAnswerPool` has none, so a slot
  // that happens to coincide with another (or with the brain) would otherwise
  // waste a cascade step repeating an id already known to fail.
  const brainKey = `${brainConfig.provider}/${brainConfig.model}`;
  const seen = new Set<string>([brainKey]);
  const candidates = buildFinalAnswerPool(args.settings)
    .filter((c) => {
      const key = `${c.provider}/${c.model}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    // 4take council review, 2026-08-31 — `buildFinalAnswerPool` returns
    // `[utilityModel, frontier, balanced, fast]` in FIXED slot order.
    // `frontier`/`balanced`/`fast` are already strength-ordered against each
    // other (PM #113 — they're `spread()` off the same score-sorted pool),
    // but `utilityModel` is picked from a DIFFERENT, narrower pool
    // (`structured_outputs`-capable ids only — a JSON-reliability property,
    // not a proxy for raw capability) and was never reconciled against the
    // others when this list was assembled. Live-measured: `utilityModel` at
    // intelligence 25.7 landed at index 0, ahead of a 45.4-scored candidate —
    // the "try smarter models first" cascade tried the WEAKEST one first.
    // Same comparator as `sortFreeModelsByScore` (free-mode.ts) — same SHAPE,
    // but this one is shared with `tool-capable-retry.ts` via the named
    // export above (`compareModelsByBenchmarkScoreDesc`), not inlined twice.
    .sort(compareModelsByBenchmarkScoreDesc);

  // Deliberately NOT gated on the brain's breaker threshold: the breaker
  // governs CROSS-TURN skipping, but here we have direct first-hand evidence
  // that this endpoint just failed to answer (twice, unless skipBrainRetry)
  // THIS turn. Waiting for the global threshold before substituting would
  // mean shipping a blank turn while a healthy model sits unused.
  const hasHealthyCandidate = candidates.some((c) => !isModelCircuitOpen(c.provider, c.model));
  if (!hasHealthyCandidate) {
    // Nothing healthier to try (empty pool, or everything tripped). Every OTHER
    // early-return branch in this function logs; this one silently didn't —
    // cost real disambiguation time chasing a "swarm never invokes subagents"
    // report that was actually every candidate's breaker open at once during a
    // broad free-tier outage (protake council review, 2026-08-31).
    console.warn(
      `[Agent] Final answer — ${endpointLabel} delivered nothing and every ` +
        `substitute candidate's circuit is OPEN (${candidates.length} candidate(s): ` +
        `${candidates.map((c) => `${c.provider}/${c.model}`).join(", ") || "none configured"}).`
    );
    return { text: "", usage, notice: undeliverableNotice(policy, endpointLabel, false), markupDegradation };
  }

  // Sprint 4 — the user may have chosen NOT to be silently switched. A
  // substituted model is a DIFFERENT model, so its answer is different work;
  // under `quality`/`ask` we stop here and say so rather than deciding for them.
  if (!allowsModelSubstitution(policy)) {
    console.warn(
      `[Agent] Final answer — ${endpointLabel} delivered nothing and degradation policy is ` +
        `"${policy}"; NOT substituting (${candidates.length} candidate(s) available).`
    );
    return { text: "", usage, notice: undeliverableNotice(policy, endpointLabel, true), markupDegradation };
  }

  // PM #134 — the trigger is decided ONCE, here, from what the brain rungs
  // actually produced, and never re-decided mid-cascade. A substitute that
  // prints markup later must not retroactively shorten a cascade that started
  // because the brain went silent: the budget a loop is running under has to be
  // a constant, or "why did it stop early?" stops being answerable from a log.
  const markupTriggered = markupDegradation !== undefined;
  const budgetMs = markupTriggered ? markupCascadeBudgetMs() : cascadeBudgetMs();
  const attemptDeadlineMs = markupTriggered ? markupAttemptDeadlineMs() : undefined;
  if (markupTriggered) {
    console.warn(
      `[Agent] Final answer — cascade triggered by PRINTED MARKUP on ${endpointLabel}; ` +
        `running on the short budget (${budgetMs}ms aggregate, ${attemptDeadlineMs}ms per attempt) ` +
        `so the substitute pool is not walked at full length on a degraded free tier.`
    );
  }
  const cascadeStartedAt = Date.now();

  for (const substitute of candidates) {
    if (abortSignal?.aborted) {
      logRecoveryAborted(`before trying substitute ${substitute.provider}/${substitute.model}`, recoveryStartedAt);
      return { text: "", usage };
    }
    if (isModelCircuitOpen(substitute.provider, substitute.model)) continue;
    // Don't START a new attempt past budget — one already in flight (inside
    // attemptOnce) keeps its own ~120s call deadline regardless of this check.
    if (Date.now() - cascadeStartedAt > budgetMs) {
      // PM #123 — this used to be a silent `break`: the cascade reported
      // total failure and nothing recorded WHY it stopped short of trying
      // every candidate. Same defect shape as PM #118/#120 — log the branch.
      const remaining = candidates
        .slice(candidates.indexOf(substitute))
        .map((c) => `${c.provider}/${c.model}`);
      console.warn(
        `[Agent] Final answer — cascade budget (${budgetMs}ms) exceeded after ` +
          `${Date.now() - cascadeStartedAt}ms; NOT trying ${remaining.length} remaining ` +
          `candidate(s): ${remaining.join(", ")}.`
      );
      break;
    }

    console.warn(
      `[Agent] Final answer — ${brainConfig.provider}/${brainConfig.model} delivered nothing; ` +
        `trying substitute ${substitute.provider}/${substitute.model}.`
    );

    let substituteModel;
    try {
      substituteModel = createModel(substitute, {
        projectId: args.projectId,
        currentPath: args.currentPath,
      });
    } catch (error) {
      console.warn(
        `[Agent] Could not build the substitute model ${substitute.provider}/${substitute.model}: ` +
          (error instanceof Error ? error.message : String(error))
      );
      continue; // e.g. vault key missing for THIS candidate — try the next one.
    }

    const attempt = await attemptOnce(substituteModel, args, substitute, attemptDeadlineMs);
    fold(attempt?.usage);
    noteMarkup(attempt, substitute);
    if (attempt?.text) {
      return {
        text: attempt.text,
        usage,
        endpoint: substitute,
        notice:
          `[Agent] ${brainConfig.provider}/${brainConfig.model} returned an empty response — ` +
          `this answer was written by ${substitute.provider}/${substitute.model} instead.`,
      };
    }
    if (abortSignal?.aborted) {
      logRecoveryAborted(`after substitute ${substitute.provider}/${substitute.model}`, recoveryStartedAt);
      return { text: "", usage, markupDegradation };
    }
  }

  return {
    text: "",
    usage,
    notice: undeliverableNotice(policy, endpointLabel, false),
    markupDegradation,
  };
}

/**
 * Deterministic, system-authored notice for a turn no model could answer.
 *
 * Re-exported from `degradation-policy.ts`, which owns the wording per policy —
 * this is the "nothing left to try" case, identical for every policy. Says WHAT
 * happened and WHAT to do; the alternative (pre-Sprint-3) was an empty string,
 * which renders as a blank turn indistinguishable from an Orchestra bug.
 */
export const UNDELIVERABLE_NOTICE = undeliverableNotice("speed", "", false);
