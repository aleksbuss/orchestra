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
 * WHAT THIS DOES — three bounded attempts, in order:
 *   1. the brain model (PM #69's existing forced answer);
 *   2. ONE retry on the brain after a jittered, abort-aware backoff — unless the
 *      breaker says the endpoint is dead, in which case skip straight to 3;
 *   3. ONE attempt on a healthy substitute model from the operator's own
 *      settings, announced LOUDLY (a substituted answer must never look like a
 *      normal one).
 * If all three come back empty, the caller gets an explicit operator notice
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
import { createModel } from "@/lib/providers/llm-provider";
import { resolveMaxOutputTokens } from "@/lib/providers/model-output-limits";
import { estimateTokenCount } from "@/lib/agent/compressor";
import { governMessages } from "@/lib/agent/token-governor";
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
const FORCED_ANSWER_MAX_OUTPUT_TOKENS = 1500;

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
}

export interface FinalAnswerResult {
  text: string;
  usage?: RawUsage;
  /** Operator-facing note: a substitution happened, or nothing could be delivered. */
  notice?: string;
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

function readUsage(result: unknown): RawUsage | undefined {
  return (result as { usage?: RawUsage }).usage ?? undefined;
}

/**
 * Run ONE tool-less final-answer generation on `model`.
 * Returns `null` when the endpoint produced nothing (or threw).
 */
async function attemptOnce(
  model: Parameters<typeof generateText>[0]["model"],
  args: Omit<FinalAnswerAttemptArgs, "model">,
  endpoint?: ModelConfig
): Promise<{ text: string; usage?: RawUsage } | null> {
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
      abortSignal: callDeadlineSignal(args.abortSignal),
    });
    const text = (result.text || "").trim();
    if (text) {
      if (endpoint) recordModelSuccess(endpoint.provider, endpoint.model);
      return { text, usage: readUsage(result) };
    }
    // HTTP 200 with an empty body — the free-tier throttle signature.
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
 * Produce the turn's final answer with bounded retry + cross-model failover.
 *
 * Returns `text: ""` ONLY when every attempt failed — and then always with a
 * `notice`, so an undeliverable turn is explained rather than silent.
 */
export async function generateFinalAnswerWithFailover(
  args: FinalAnswerAttemptArgs
): Promise<FinalAnswerResult> {
  const { brainConfig, abortSignal } = args;
  // PM #109 follow-up — bound the context ONCE, up front, and reuse it for every
  // attempt. Prune-once (not per-attempt) is right for THIS pool: in Free Mode
  // every substitute is itself a free model, so there is no larger-window
  // candidate being starved; a stronger install rarely reaches this path because
  // its brain does not degrade. Pruning the transcript that CAUSED the degraded
  // forced answer is the point — the substitute must not inherit the full 68K.
  args = { ...args, messages: boundForcedAnswerContext(args.messages) };
  let usage: RawUsage | undefined;

  const fold = (u: RawUsage | undefined) => {
    // Attempts are sequential and each one's tokens are billable, so keep the
    // LAST attempt's usage rather than dropping it (the cost banner would
    // otherwise under-report a turn that took three generations).
    if (u) usage = u;
  };

  // ── Attempt 1 — the brain, unless its breaker already says it is dead ──────
  const brainTripped = brainConfig
    ? isModelCircuitOpen(brainConfig.provider, brainConfig.model)
    : false;

  if (!brainTripped) {
    const first = await attemptOnce(args.model, args, brainConfig);
    fold(first?.usage);
    if (first?.text) return { text: first.text, usage };
    if (abortSignal?.aborted) return { text: "", usage };

    // ── Attempt 2 — one retry on the brain after a backoff ──────────────────
    // Skipped when attempt 1 just tripped the breaker: retrying a known-dead
    // endpoint only delays the substitution that will actually deliver.
    const nowTripped = brainConfig
      ? isModelCircuitOpen(brainConfig.provider, brainConfig.model)
      : false;
    if (!nowTripped) {
      await abortableSleep(retryBackoffMs(), abortSignal);
      if (abortSignal?.aborted) return { text: "", usage };
      const second = await attemptOnce(args.model, args, brainConfig);
      fold(second?.usage);
      if (second?.text) return { text: second.text, usage };
      if (abortSignal?.aborted) return { text: "", usage };
    }
  } else {
    console.warn(
      `[Agent] Final answer — circuit OPEN on ${brainConfig!.provider}/${brainConfig!.model}; ` +
        `going straight to a substitute model.`
    );
  }

  // ── Attempt 3 — a healthy substitute from the operator's own settings ──────
  const policy: DegradationPolicy = args.degradationPolicy ?? "speed";
  const endpointLabel = brainConfig
    ? `${brainConfig.provider}/${brainConfig.model}`
    : "the configured model";
  if (!brainConfig) {
    return { text: "", usage, notice: undeliverableNotice(policy, endpointLabel, false) };
  }

  // Pick the first pool model that is not itself tripped and is not the brain.
  //
  // Deliberately NOT gated on the brain's breaker: the breaker's threshold
  // governs CROSS-TURN skipping, but here we have direct first-hand evidence
  // that this endpoint just failed to answer twice in a row, THIS turn. Waiting
  // for the global threshold before substituting would mean shipping a blank
  // turn to the user while a healthy model sits unused.
  const brainKey = `${brainConfig.provider}/${brainConfig.model}`;
  const substitute = buildFinalAnswerPool(args.settings).find(
    (c) =>
      `${c.provider}/${c.model}` !== brainKey && !isModelCircuitOpen(c.provider, c.model)
  );
  if (!substitute) {
    // Nothing healthier to try (empty pool, or everything tripped).
    return { text: "", usage, notice: undeliverableNotice(policy, endpointLabel, false) };
  }

  // Sprint 4 — the user may have chosen NOT to be silently switched. A
  // substituted model is a DIFFERENT model, so its answer is different work;
  // under `quality`/`ask` we stop here and say so rather than deciding for them.
  if (!allowsModelSubstitution(policy)) {
    console.warn(
      `[Agent] Final answer — ${endpointLabel} delivered nothing and degradation policy is ` +
        `"${policy}"; NOT substituting ${substitute.provider}/${substitute.model}.`
    );
    return { text: "", usage, notice: undeliverableNotice(policy, endpointLabel, true) };
  }
  console.warn(
    `[Agent] Final answer — ${brainConfig.provider}/${brainConfig.model} delivered nothing; ` +
      `substituting ${substitute.provider}/${substitute.model} to answer this turn.`
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
    return { text: "", usage, notice: undeliverableNotice(policy, endpointLabel, false) };
  }

  const third = await attemptOnce(substituteModel, args, substitute);
  fold(third?.usage);
  if (third?.text) {
    return {
      text: third.text,
      usage,
      notice:
        `[Agent] ${brainConfig.provider}/${brainConfig.model} returned an empty response — ` +
        `this answer was written by ${substitute.provider}/${substitute.model} instead.`,
    };
  }

  return { text: "", usage, notice: undeliverableNotice(policy, endpointLabel, false) };
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
