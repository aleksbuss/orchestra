/**
 * PM #81 Sprint 2 + PM #97 — active self-heal for a tool call that never ran.
 *
 * Two ways a turn loses a tool call, one recovery each, both entered through
 * `recoverMissingToolCall` at the bottom of this file:
 *   - PM #81, the model PRINTED the call as text instead of calling it, and
 *   - PM #97, the model emitted a VALID native call the provider DROPPED.
 * They share one chat-scoped budget and are mutually exclusive by construction.
 * Both lived inside `runAgent`'s `onFinish` closure until 2026-09-12; they were
 * moved here verbatim so they can be tested without the streamText harness.
 *
 * When a degraded model (qwen3-coder via OpenRouter under long context) PRINTS a
 * tool call as raw text instead of calling it natively, Sprint 1 detects it and
 * stops the XML reaching the user. This module recovers the INTENT: re-prompt
 * the model WITH tools + a deterministic correction so it re-issues the call as
 * a real native call and the action actually runs.
 *
 * Bounded by design (the correction itself can degrade again):
 *   - one bounded tool loop per re-issue (`stopWhen` stepCountIs cap), and
 *   - a chat-scoped retry budget (circuit breaker) so a model that keeps
 *     printing markup falls back to a plain answer instead of looping forever.
 *
 * The decision to RE-PROMPT rather than blind-execute the parsed markup is
 * deliberate (operator-chosen): a model degrades because something is off, and
 * the parsed args may be mangled (quote-heavy content — see PM #80). Executing
 * the model's own re-issued NATIVE call keeps the SDK's validation + the
 * loop-guard in the path; we never hand-execute a string we scraped from prose.
 *
 * Budget state is in-memory + per-process (chatId → attempt count), evaporating
 * on restart like the daemon's `autoPilotIterations` and the write-rewrite
 * budget. It is read/written entirely on the agent path (NOT boot-warmed /
 * route-read), so the PM #71 `globalThis` requirement does not apply.
 */
import { callDeadlineSignal } from "@/lib/agent/stream-watchdog";
import {
  generateText,
  stepCountIs,
  hasToolCall,
  type ModelMessage,
  type ToolSet,
} from "ai";
import { resolveMaxOutputTokens } from "@/lib/providers/model-output-limits";
import { mergeConsecutiveSameRole } from "@/lib/agent/history";
import { estimateTokenCount } from "@/lib/agent/compressor";
import { governMessages } from "@/lib/agent/token-governor";
import {
  argumentByteSize,
  readUpstreamProvider,
  recordToolChannelDegradation,
} from "@/lib/agent/degradation-telemetry";
import {
  detectActionHallucination,
  getLastAssistantText,
  getLastResponseToolText,
  isDroppedNativeToolCall,
  stripHallucinatedTrailingText,
} from "@/lib/agent/agent-response";
import {
  extractHallucinatedToolCall,
  stripThinkingTags,
} from "@/lib/agent/printed-tool-call";
import type { AppSettings } from "@/lib/types";
import type { RawUsage } from "@/lib/cost/accumulator";

/** Max re-issue attempts per chat before falling back to a plain forced answer. */
const REISSUE_MAX_RETRIES = 2;
/** Step bound for the single re-issue tool loop (native call → result → answer). */
const REISSUE_STEP_CAP = 8;
/** FIFO bound on tracked chats. */
const MAX_TRACKED_CHATS = 500;

/**
 * PM #109 — token budget the re-issue runs at, independent of the brain's
 * advertised window.
 *
 * The re-issue used to replay the FULL failing context to the SAME model, which
 * is a retry under the exact conditions that just failed — measured live as a
 * guaranteed repeat (three turns, ~77 s each, zero progress). Context length is
 * one of the two variables driving the collapse, so the retry must change it.
 *
 * The value is deliberately far below any observed collapse point (the live
 * incident degraded at ≈53 K sent tokens) rather than a fraction of the window:
 * a re-issue does not need the whole conversation, only the recent tool results
 * plus the correction. Pruning is pair-safe (`governMessages` → the SDK's own
 * `pruneMessages`), so a dropped tool result never orphans its call.
 */
const REISSUE_CONTEXT_TOKEN_BUDGET = 16000;

const attemptsByChat = new Map<string, number>();

function pruneTrackedChats(): void {
  while (attemptsByChat.size > MAX_TRACKED_CHATS) {
    const oldest = attemptsByChat.keys().next().value;
    if (oldest === undefined) break;
    attemptsByChat.delete(oldest);
  }
}

/**
 * Record a re-issue attempt for `chatId`; returns whether it is still within the
 * per-chat budget. Missing chatId ⇒ always allowed (best-effort tracking).
 */
export function recordReissueAttempt(chatId?: string): {
  allowed: boolean;
  count: number;
} {
  if (!chatId) return { allowed: true, count: 1 };
  const count = (attemptsByChat.get(chatId) ?? 0) + 1;
  attemptsByChat.set(chatId, count);
  pruneTrackedChats();
  return { allowed: count <= REISSUE_MAX_RETRIES, count };
}

/** Clear the budget — one chat, or all when no id is given (success / tests). */
export function resetReissueBudget(chatId?: string): void {
  if (chatId) attemptsByChat.delete(chatId);
  else attemptsByChat.clear();
}

/**
 * PM #109 — the degraded-chat flag moved to `degradation-telemetry.ts`, which
 * now owns BOTH the flag and the structured event that records the conditions.
 * Re-exported here so the existing importers keep their import path.
 */
export {
  recordChatDegradation,
  isChatDegraded,
  resetChatDegradation,
} from "@/lib/agent/degradation-telemetry";

/**
 * Deterministic, Orchestra-authored correction injected for the re-issue.
 *
 * PM #109 — the last two sentences are load-bearing, not politeness. The
 * measured trigger for the channel collapse is ARGUMENT SIZE × context, so a
 * re-issue that repeats the SAME 16 KB `write_text_file` argument degrades
 * again by construction (observed: three consecutive turns on chat 9891bb43).
 * Steering the retry to a small targeted edit changes the causal variable
 * instead of just asking the model to try harder.
 */
export const REISSUE_CORRECTION =
  "SYSTEM CORRECTION: Your previous message PRINTED a tool call as plain text " +
  "(e.g. a tool_call block, a function= block, an invoke/dots_function_call " +
  "block, or a raw JSON blob). That text was NOT executed — it never reaches the " +
  "tools. Re-issue the SAME action now as a NATIVE tool/function call through the " +
  "proper tool-calling channel. Do NOT print tool-call markup again. " +
  "IMPORTANT: keep the tool ARGUMENTS SMALL — a large argument is what made the " +
  "call fail to go through. If you were rewriting a whole existing file, do NOT " +
  "repeat that; use `replace_in_file` on the smallest span that achieves the " +
  "change, one call at a time. If you genuinely cannot call the tool, explain " +
  "the situation to the user in plain prose instead.";

/**
 * PM #97 (Layer 2) — correction for an intermittently-DROPPED native tool call.
 * Unlike REISSUE_CORRECTION, the model did NOT print markup here — it emitted a
 * valid native tool call that the provider (e.g. OpenRouter's deepseek→OpenAI
 * mapping) dropped in transit, so nothing executed. Ask it to simply re-issue.
 */
export const DROP_REISSUE_CORRECTION =
  "SYSTEM CORRECTION: Your previous turn ended intending to call a tool, but the " +
  "tool call did not go through — it was lost in transit and never executed, so " +
  "no action happened. This is a transient delivery failure, not your mistake. " +
  "Re-issue the SAME tool/function call now through the native tool-calling " +
  "channel. If you genuinely have nothing left to do, deliver your final answer " +
  "to the user in plain prose instead.";

export interface ToolReissueResult {
  /** The re-issue's response messages (native tool call + result + final text). */
  responseMessages: ModelMessage[];
  /**
   * The delivered answer text. May be "" when the re-issue EXECUTED a tool but
   * produced no final text — the caller still persists `responseMessages` and
   * lets resolveTurnContinuation force the answer. A null return (not this) is
   * the "nothing useful happened" signal.
   */
  text: string;
  usage?: RawUsage;
}

/**
 * Run ONE bounded, tool-capable generation that asks the model to re-issue a
 * hallucinated tool call natively. Returns the result when it DELIVERED (a real
 * answer that is not itself another hallucination), else null — caller then
 * falls back to the plain forced answer. Never throws (returns null on error).
 */
/**
 * PM #109 — build the re-issue payload at a SHORT context.
 *
 * Exported for direct unit testing: the correction MUST survive pruning (it is
 * the whole point of the call) and the result must stay pair-safe.
 */
export function buildReissueMessages(
  baseMessages: ModelMessage[],
  priorMessages: ModelMessage[],
  correction: string,
  budget: number = REISSUE_CONTEXT_TOKEN_BUDGET
): { messages: ModelMessage[]; compactedFrom?: number } {
  const merged = mergeConsecutiveSameRole([
    ...baseMessages,
    ...priorMessages,
    { role: "user", content: correction },
  ]);
  const before = estimateTokenCount(merged);
  if (before <= budget) return { messages: merged };
  // `governMessages` keeps the most recent suffix, so the correction (last
  // message) always survives; it is also what the in-flight governor uses, so
  // the re-issue prunes exactly the way a normal step would.
  return { messages: governMessages(merged, budget), compactedFrom: before };
}

export async function attemptToolReissue(args: {
  model: Parameters<typeof generateText>[0]["model"];
  systemPrompt: string;
  baseMessages: ModelMessage[];
  priorMessages: ModelMessage[];
  tools: ToolSet;
  providerOptions: Parameters<typeof generateText>[0]["providerOptions"];
  prepareStep: Parameters<typeof generateText>[0]["prepareStep"];
  settings: AppSettings;
  abortSignal?: AbortSignal;
  /**
   * PM #97 — the correction text to inject. Defaults to `REISSUE_CORRECTION`
   * (printed-markup case, PM #81); pass `DROP_REISSUE_CORRECTION` for the
   * dropped-native-call case (Layer 2). The rest of the re-issue machinery
   * (budget, pairing-safe merge, executed-tool detection) is identical.
   */
  correction?: string;
  /**
   * PM #109 — identity for the degradation event emitted when the re-issue
   * ITSELF degrades into markup. Optional: omitting it costs the measurement,
   * never the retry.
   */
  telemetry?: { chatId?: string; provider?: string; model?: string };
}): Promise<ToolReissueResult | null> {
  try {
    const { messages: reissueMessages, compactedFrom } = buildReissueMessages(
      args.baseMessages,
      args.priorMessages,
      args.correction ?? REISSUE_CORRECTION
    );
    if (compactedFrom !== undefined) {
      console.warn(
        `[Agent] PM #109 — re-issuing at a SHORT context: ${compactedFrom} → ` +
          `${estimateTokenCount(reissueMessages)} tokens (budget ${REISSUE_CONTEXT_TOKEN_BUDGET}). ` +
          `Replaying the full failing context to the same model is a guaranteed repeat.`
      );
    }
    const result = await generateText({
      model: args.model,
      system: args.systemPrompt,
      messages: reissueMessages,
      providerOptions: args.providerOptions,
      tools: args.tools,
      prepareStep: args.prepareStep,
      stopWhen: [stepCountIs(REISSUE_STEP_CAP), hasToolCall("response")],
      temperature: args.settings.chatModel.temperature ?? 0.7,
      maxOutputTokens: resolveMaxOutputTokens(args.settings.chatModel),
      abortSignal: callDeadlineSignal(args.abortSignal),
    });

    const responseMessages = (
      (result as { response?: { messages?: ModelMessage[] } }).response?.messages ?? []
    ) as ModelMessage[];
    const responseToolText = getLastResponseToolText(responseMessages).trim();
    const text =
      responseToolText || stripThinkingTags(getLastAssistantText(responseMessages)).trim();
    // A re-issue that EXECUTED a native tool (call → tool-result message) is real
    // progress worth persisting even if it produced no final text — the caller
    // persists these messages and resolveTurnContinuation then forces the answer.
    // Without this, the executed write would be discarded (lost from history AND
    // unbilled) and a redundant forced generation would run. A tool message
    // (role "tool") only exists when a native call actually ran.
    const executedTool = responseMessages.some((m) => m.role === "tool");

    // Nothing useful happened: empty output, OR degraded into markup again with
    // no tool executed. Either way the caller falls back to a plain answer.
    if (!text && !executedTool) return null;
    if (!responseToolText && !executedTool) {
      const residual = extractHallucinatedToolCall(text);
      if (residual) {
        // PM #109 — the retry reproduced the failure. Record it: this is the
        // sample that tells us whether the SHORT-context retry helped, which is
        // the input to any future per-model boundary.
        const usage = (result as { usage?: RawUsage }).usage;
        recordToolChannelDegradation({
          stage: "reissue",
          chatId: args.telemetry?.chatId,
          provider: args.telemetry?.provider,
          model: args.telemetry?.model,
          toolName: residual.name,
          argBytes: argumentByteSize(residual.args),
          markupChars: text.length,
          contextTokensEstimate: estimateTokenCount(reissueMessages),
          promptTokens: usage?.inputTokens ?? usage?.promptTokens,
        });
        return null;
      }
    }

    return {
      responseMessages,
      text,
      usage: (result as { usage?: RawUsage }).usage,
    };
  } catch (err) {
    console.warn(
      "[Agent] PM #81 tool re-issue failed (non-fatal, falling back to forced answer):",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/**
 * The narrow slice of streamText's `onFinish` event that the recovery below
 * reads for telemetry. Declared structurally rather than importing the SDK's
 * own event type: both fields are read defensively because `steps` is absent on
 * a one-step turn and `providerMetadata` appears only when the gateway names an
 * upstream.
 *
 * Inside the closure this shape was two inline `as unknown as` casts. It is
 * NOT one here — `OnFinishEvent` satisfies this interface structurally, so the
 * call site passes `event` with no cast at all and `steps[].usage` is really
 * type-checked against `RawUsage`. Keep it that way: re-introducing a cast here
 * would hide an SDK shape change instead of failing the build on it.
 */
export interface ReissueTelemetrySource {
  steps?: ReadonlyArray<{ usage?: RawUsage }>;
  providerMetadata?: unknown;
}

/** What a streamed turn persists once both tool-call recovery layers have run. */
export interface ToolCallRecoveryResult {
  /**
   * The messages to persist: markup stripped on the PM #81 path, the re-issue's
   * real messages appended on both. Identical to the input when neither layer
   * fired, which is the overwhelmingly common case.
   */
  responseMessages: ModelMessage[];
  /** Billing for the re-issue generation, when one ran AND delivered. */
  reissueUsage?: RawUsage;
}

/**
 * Both tool-call recovery layers of a streamed turn, in the order they must run.
 *
 *   Layer 1 (PM #81) — the model PRINTED a tool call as text instead of calling
 *     it natively. Re-prompt WITH tools so it re-issues for real, and suppress
 *     the raw markup so the user never sees XML.
 *   Layer 2 (PM #97) — the model emitted a VALID native call that the provider
 *     DROPPED in transit. The drop is intermittent, so one bounded re-issue
 *     usually lands.
 *
 * The two share one chat-scoped budget (`recordReissueAttempt`) and are mutually
 * exclusive by construction: layer 2's gate requires `hallucinated: false`.
 *
 * Moved out of `runAgent`'s `onFinish` closure verbatim. The point of the move
 * is testability, not line count: inside a closure the only way to reach either
 * layer was the full streamText integration harness.
 */
export async function recoverMissingToolCall(args: {
  /** `event.response.messages` — what the stream actually produced. */
  rawResponseMessages: ModelMessage[];
  /** `event.finishReason`, already narrowed to a string or undefined. */
  finishReason: string | undefined;
  /** False in plain-chat mode: there are no tools to re-issue with. */
  useTools: boolean;
  /** The turn stopped at the per-turn step cap — a pause, not a lost call. */
  stepLimitReached: boolean;
  /** The turn stopped on repeated identical blocked calls — also not a drop. */
  loopAbortReached: boolean;
  telemetrySource: ReissueTelemetrySource;
  /** The turn's input messages, replayed (short) as the re-issue's base. */
  baseMessages: ModelMessage[];
  model: Parameters<typeof generateText>[0]["model"];
  systemPrompt: string;
  tools: ToolSet;
  providerOptions: Parameters<typeof generateText>[0]["providerOptions"];
  prepareStep: Parameters<typeof generateText>[0]["prepareStep"];
  settings: AppSettings;
  abortSignal?: AbortSignal;
  chatId: string;
  /** Endpoint identity for the degradation record — NOT the model handle. */
  provider: string;
  modelId: string;
}): Promise<ToolCallRecoveryResult> {
  const { rawResponseMessages } = args;

  // PM #81 Sprint 2 — action-tool hallucination self-heal. A degraded model
  // (qwen3-coder under long context) PRINTS a tool call as raw text instead
  // of calling it natively; Orchestra never executed it and shipped XML to
  // the user. Re-prompt WITH tools so the model re-issues the call for real,
  // and SUPPRESS the raw markup so the user never sees it. Bounded by a
  // chat-scoped retry budget (circuit breaker). Skipped at a step-cap pause
  // and in plain-chat mode (no tools to re-issue with).
  const hallucinatedCall =
    args.useTools && !args.stepLimitReached
      ? detectActionHallucination(rawResponseMessages)
      : null;
  let reissueUsage: RawUsage | undefined;
  let reissueMessages: ModelMessage[] = [];
  if (hallucinatedCall) {
    // PM #82 — printing a tool call as text is the degradation symptom.
    // Flag the chat so its NEXT pre-flight pass compacts aggressively and
    // escapes the long-context loop (behavior-triggered backstop).
    // PM #109 — and RECORD the conditions (argument size, context size,
    // provider-reported prompt tokens, upstream) so the boundary can be
    // learned from data instead of guessed at.
    const lastStepUsage = (args.telemetrySource.steps ?? []).at(-1)?.usage;
    recordToolChannelDegradation({
      stage: "main-turn",
      chatId: args.chatId,
      provider: args.provider,
      model: args.modelId,
      toolName: hallucinatedCall.name,
      argBytes: argumentByteSize(hallucinatedCall.args),
      markupChars: hallucinatedCall.raw.length,
      contextTokensEstimate: estimateTokenCount([
        ...args.baseMessages,
        ...rawResponseMessages,
      ]),
      promptTokens: lastStepUsage?.inputTokens ?? lastStepUsage?.promptTokens,
      upstreamProvider: readUpstreamProvider(args.telemetrySource),
    });
    const budget = recordReissueAttempt(args.chatId);
    console.warn(
      `[Agent] PM #81 — model printed "${hallucinatedCall.name}" as text instead of ` +
        `calling it (re-issue attempt ${budget.count}, allowed=${budget.allowed}).`
    );
    if (budget.allowed) {
      const reissue = await attemptToolReissue({
        model: args.model,
        systemPrompt: args.systemPrompt,
        baseMessages: args.baseMessages,
        priorMessages: rawResponseMessages,
        tools: args.tools,
        providerOptions: args.providerOptions,
        prepareStep: args.prepareStep,
        settings: args.settings,
        abortSignal: args.abortSignal,
        telemetry: {
          chatId: args.chatId,
          provider: args.provider,
          model: args.modelId,
        },
      });
      if (reissue) {
        reissueMessages = reissue.responseMessages;
        reissueUsage = reissue.usage;
        resetReissueBudget(args.chatId); // delivered → reset for later turns
      }
    }
  }

  // ── Layer 2 (PM #97) — intermittent NATIVE tool-call DROP recovery ──
  // Problem C: the model emitted a VALID native tool call that the provider
  // (OpenRouter's deepseek→OpenAI mapping) intermittently DROPPED in transit
  // — the SDK sees finishReason="tool-calls" but ZERO tool calls parsed, no
  // printed markup (so PM #81 didn't fire), and no delivered answer. The
  // action silently never ran. Since the drop is intermittent, ONE bounded
  // re-issue usually lands. NARROW gate — distinct from every other
  // no-delivery case: NOT a hallucination (handled above), NOT a step-cap
  // pause, tools ON, finishReason EXACTLY "tool-calls" (a real answer is
  // "stop"), and nothing deliverable came through. Shares the PM #81 reissue
  // budget (circuit breaker). Reads turnHasDeliverableAnswer, never mutates it.
  let dropReissued = false;
  if (
    isDroppedNativeToolCall({
      finishReason: args.finishReason,
      useTools: args.useTools,
      // A loop-abort is a STOP REASON, not a dropped native call — treat it
      // like the step-cap so the dropped-call re-issue never fires on it.
      stepLimitReached: args.stepLimitReached || args.loopAbortReached,
      hallucinated: hallucinatedCall !== null,
      responseMessages: rawResponseMessages,
    })
  ) {
    const budget = recordReissueAttempt(args.chatId);
    console.warn(
      `[Agent] Layer 2 (PM #97) — native tool-call DROP detected ` +
        `(finishReason=tool-calls, no tool call parsed, no answer; likely an ` +
        `intermittent provider drop). Re-issue attempt ${budget.count}, allowed=${budget.allowed}.`
    );
    if (budget.allowed) {
      const reissue = await attemptToolReissue({
        model: args.model,
        systemPrompt: args.systemPrompt,
        baseMessages: args.baseMessages,
        priorMessages: rawResponseMessages,
        tools: args.tools,
        providerOptions: args.providerOptions,
        prepareStep: args.prepareStep,
        settings: args.settings,
        abortSignal: args.abortSignal,
        correction: DROP_REISSUE_CORRECTION,
        telemetry: {
          chatId: args.chatId,
          provider: args.provider,
          model: args.modelId,
        },
      });
      if (reissue) {
        reissueMessages = reissue.responseMessages;
        reissueUsage = reissue.usage;
        dropReissued = true;
        resetReissueBudget(args.chatId); // delivered → reset for later turns
      }
    }
  }

  // When a hallucination was detected, drop its raw markup message (the
  // user must not see XML) and append the re-issue's real messages, if any.
  // On a Layer-2 drop the prior text is legit (a short preamble, no markup),
  // so KEEP it and append the re-issue's real messages.
  const responseMessages = hallucinatedCall
    ? [
        ...stripHallucinatedTrailingText(rawResponseMessages),
        ...reissueMessages,
      ]
    : dropReissued
      ? [...rawResponseMessages, ...reissueMessages]
      : rawResponseMessages;

  return { responseMessages, reissueUsage };
}
