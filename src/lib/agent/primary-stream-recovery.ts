/**
 * Primary-stream failure recovery (post-`protake`-review Sprint 0).
 *
 * THE GAP THIS CLOSES. `agent.ts`'s single `streamText` call (the primary
 * single-agent turn, and — under the inline-synthesis collapse — the swarm's
 * final answer too) had NO failover on its own `onError`: `reportTurnError`
 * only logs, paints the red banner, and dumps a postmortem; `attemptModelFallback`
 * is fire-and-forget and only changes the DEFAULT model for FUTURE turns, never
 * rescues the current one. `final-answer-failover.ts`'s retry-then-substitute
 * ladder already exists and is well-tested, but it is wired only to `onFinish`
 * (PM #69's "the model answered with nothing" case) — `onFinish` and `onError`
 * are mutually exclusive per `streamText` call, so that ladder structurally
 * cannot fire when the stream errors instead of finishing empty.
 *
 * REUSE, NOT DUPLICATION. This module calls the SAME `generateFinalAnswerWithFailover`
 * ladder, from a second call site keyed on a DIFFERENT trigger. It is
 * deliberately NOT a new retry/substitution mechanism.
 *
 * SAFETY GATES, all required — a council review (protake, 4 models) flagged
 * real gaps in an earlier draft of this module before any of it shipped:
 *
 *  1. **Only recover a SILENT failure.** `onError` can fire AFTER the client
 *     already received `text-delta` chunks (confirmed: `onChunk` buffers them
 *     into `partialText` as they stream — real time, not server-buffered).
 *     Appending a second full "recovered" message on top of a partial one
 *     already on screen is a worse user experience than today's clean banner.
 *     Callers MUST pass the turn's accumulated `partialText`; a non-empty
 *     value short-circuits recovery and falls through to the existing
 *     error-banner path untouched.
 *  2. **`skipBrainRetry` is conditional, not a blanket skip.** A 429/5xx/
 *     network failure surfaced via `onError` can still resolve on a same-
 *     endpoint retry with real backoff (the AI SDK's own internal retries may
 *     have fired in rapid succession, not enough elapsed time for a rate
 *     limit to clear). Only a genuinely deterministic 4xx (not 429) — the
 *     caller's own request being rejected — has no such argument; retrying
 *     the identical request against the identical endpoint cannot succeed.
 *  3. **Turn-scoped in-flight guard.** A simple in-memory check-and-set
 *     (consistent with this repo's single-process invariant) prevents a
 *     double-fire or a race against a manual user retry landing two
 *     recovered messages into the same chat.
 *  4. **Breaker gets fed.** Today this path records nothing into
 *     `model-health.ts`'s circuit breaker at all — a hard failure here is
 *     exactly the kind of positive evidence the breaker exists to collect.
 *  5. **Gated on the SAME degradation policy every other substitution site
 *     respects.** `quality`/`ask` never substitute; this is the THIRD gated
 *     site (proposer fan-out, final-answer ladder, now this), never an
 *     ungated fourth.
 *
 * DROPPED FROM THE ORIGINAL DESIGN (same review): a symmetric hook in
 * `agent.ts`'s outer synchronous `catch`. Tracing showed that path is only
 * reachable by Orchestra's OWN setup-code bugs (`detectToolSupport`,
 * `buildTokenGovernor` throwing) — never a model failure — so routing those
 * through a model-substitution ladder would mask real bugs instead of
 * surfacing them. Not built.
 */
import type { ModelMessage, ToolSet } from "ai";
import { generateText } from "ai";
import {
  generateFinalAnswerWithFailover,
  finalAnswerInstruction,
  type FinalAnswerAttemptArgs,
} from "@/lib/agent/final-answer-failover";
import { attemptToolCapableRetry } from "@/lib/agent/tool-capable-retry";
import { classifyModelFailure, recordModelFailure } from "@/lib/agent/model-health";
import {
  resolveDegradationPolicy,
  allowsModelSubstitution,
} from "@/lib/agent/degradation-policy";
import { mergeConsecutiveSameRole } from "@/lib/agent/history";
import { stripThinkingTags } from "@/lib/agent/agent-response";
import { foldTurnUsage } from "@/lib/cost/accumulator";
import { updateChat } from "@/lib/storage/chat-store";
import { publishChatErrorEvent } from "@/lib/realtime/event-bus";
import { publishUiSyncEvent } from "@/lib/realtime/event-bus";
import { publishOrchestratorFinished } from "@/lib/agent/agent-dag-events";
import type { AppSettings, ModelConfig } from "@/lib/types";

/**
 * Turns with a recovery already in flight. Turn-scoped (keyed on `chatId`),
 * in-memory, single-process — matches the existing breaker/semaphore
 * invariant in this codebase (no cluster mode).
 */
const recoveryInFlight = new Set<string>();

/**
 * Duck-typed the same way `postmortem.ts`'s internal extractor reads an
 * `AI_APICallError` — including the PM #114 unwrap: `onError` usually receives
 * an `AI_RetryError` (the SDK's own retry loop exhausted), which carries no
 * `statusCode` of its own — the real one sits at `.lastError`. Without this,
 * `isDeterministicClientError` below always saw `status === undefined` and
 * could never return true, so a genuine deterministic 4xx wrapped in
 * `AI_RetryError` always kept the doomed same-endpoint retry instead of
 * skipping straight to a substitute.
 */
function extractStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const e = error as Record<string, unknown>;
  if (typeof e.statusCode === "number") return e.statusCode;
  if (typeof e.status === "number") return e.status;
  const lastError = e.lastError;
  if (lastError && typeof lastError === "object") {
    const le = lastError as Record<string, unknown>;
    if (typeof le.statusCode === "number") return le.statusCode;
    if (typeof le.status === "number") return le.status;
  }
  return undefined;
}

/**
 * A 4xx status (429 excluded) is the request itself being rejected — retrying
 * the identical request against the identical endpoint cannot change the
 * outcome. Everything else (429, 5xx, network errors, or no status code at
 * all) keeps the existing same-endpoint retry, because those CAN resolve
 * between attempts. Exported for direct unit testing.
 */
export function isDeterministicClientError(error: unknown): boolean {
  const status = extractStatusCode(error);
  return typeof status === "number" && status >= 400 && status < 500 && status !== 429;
}

export interface PrimaryStreamRecoveryArgs {
  error: unknown;
  model: Parameters<typeof generateText>[0]["model"];
  brainConfig: ModelConfig;
  systemPrompt: string;
  messages: ModelMessage[];
  providerOptions: FinalAnswerAttemptArgs["providerOptions"];
  settings: AppSettings;
  abortSignal?: AbortSignal;
  degradationPolicyOverride?: unknown;
  isBackground?: boolean;
  chatId: string;
  projectId?: string;
  currentPath?: string;
  /**
   * Text already streamed to the client before the failure (from the turn's
   * `partialText` buffer). A non-empty value means the client has visible
   * partial output — recovery must not run; see gate 1 above.
   */
  partialText: string;
  /**
   * PM #119 — did a tool call actually execute in THIS stream before it
   * errored? Set from `agent.ts`'s own `onChunk` (`chunk.type === "tool-call"`),
   * never inferred from `messages` — a long chat's message history almost
   * always contains tool activity from OLD, unrelated turns, which would make
   * that check true nearly always and tell the recovery prompt nothing about
   * whether THIS turn actually did anything. Selects which
   * `finalAnswerInstruction` variant the substitute gets: `true` lets it
   * summarize real work; `false` forces an honest non-completion instead of
   * letting it fabricate one (live incident, same date — see PM #119).
   */
  toolCallOccurred: boolean;
  /**
   * This turn's already-assembled, already-guarded ToolSet (`agent.ts`'s
   * `tools`, NOT `effectiveTools` — pass the full set even when the primary
   * itself ran tool-less, so a tool-capable SUBSTITUTE can still use it).
   * Optional so a hypothetical future tool-less-only caller keeps working
   * unchanged. When present and `toolCallOccurred` is false, gates ONE
   * tool-capable retry attempt (`tool-capable-retry.ts`) before the
   * tool-less ladder — see that module's own docstring for why exactly one.
   */
  tools?: ToolSet;
  /** Gates the tool-capable retry's per-tool Swarm-Activity emit (PM #96 parity). */
  swarmEnabled: boolean;
  /** `agent.ts`'s own `MAX_TOOL_STEPS_PER_TURN`, passed through — not re-declared here. */
  maxToolSteps: number;
}

export interface PrimaryStreamRecoveryResult {
  recovered: boolean;
}

/**
 * Attempt one bounded, tool-less recovery of a primary-stream failure. Never
 * throws. Returns `{recovered: false}` on any gate miss or failure to
 * deliver/persist — callers fall through to their existing error path
 * unchanged, byte-for-byte, in every `recovered: false` case.
 */
export async function recoverPrimaryStreamFailure(
  args: PrimaryStreamRecoveryArgs
): Promise<PrimaryStreamRecoveryResult> {
  // Gate: user cancelled. Not a failure to recover from, and must never be
  // recorded against the breaker (the endpoint did nothing wrong).
  if (args.abortSignal?.aborted) return { recovered: false };

  // Gate 1 — the client already has visible partial output for this turn.
  if (args.partialText.trim().length > 0) return { recovered: false };

  // Gate 3 — turn-scoped in-flight guard. Single-threaded per tick, so a
  // plain check-then-set is race-safe within this process.
  if (recoveryInFlight.has(args.chatId)) return { recovered: false };
  recoveryInFlight.add(args.chatId);

  try {
    // Gate 4 — feed the breaker. Positive-evidence only, same rule as every
    // other call site in this codebase.
    const failureKind = classifyModelFailure(args.error);
    if (failureKind) {
      recordModelFailure(args.brainConfig.provider, args.brainConfig.model, failureKind);
    }

    // Gate 5 — the degradation-policy chokepoint every substitution site shares.
    const policy = resolveDegradationPolicy(args.settings, args.degradationPolicyOverride, {
      background: args.isBackground,
    });
    if (!allowsModelSubstitution(policy)) return { recovered: false };

    // PM #122 — we're actually about to attempt recovery (every earlier gate
    // passed). The ladder below is tool-less `generateText`, never
    // `streamText`, so it emits zero chunks for its entire duration (measured
    // live: 73s–7+min on a degraded free tier) — the client's `useChat` status
    // already left `streaming`/`submitted` when the ORIGINAL stream errored,
    // so without this the loading indicator is long gone before the turn
    // actually finishes, and a real, working recovery looks identical to a
    // silent death for the whole gap. Superseded by `turn_recovered` or the
    // ordinary error path once this settles — fire-and-forget, never blocks.
    publishChatErrorEvent({
      chatId: args.chatId,
      projectId: args.projectId,
      payload: {
        kind: "recovering",
        message: `The configured model didn't answer — trying an alternate model. This can take a while on a degraded free tier.`,
        recoverable: true,
      },
    });

    // Tool-capable retry — exactly ONE candidate, gated on toolCallOccurred
    // being false (nothing to duplicate; see tool-capable-retry.ts's own
    // docstring for why cap=1 makes that provable, not just likely). Runs
    // BEFORE the tool-less ladder: a genuinely completed task beats an
    // honest refusal.
    let effectiveToolCallOccurred = args.toolCallOccurred;
    if (!args.toolCallOccurred && args.tools && Object.keys(args.tools).length > 0) {
      const toolRetry = await attemptToolCapableRetry({
        brainConfig: args.brainConfig,
        systemPrompt: args.systemPrompt,
        messages: args.messages,
        tools: args.tools,
        providerOptions: args.providerOptions,
        settings: args.settings,
        abortSignal: args.abortSignal,
        chatId: args.chatId,
        projectId: args.projectId,
        currentPath: args.currentPath,
        swarmEnabled: args.swarmEnabled,
        maxToolSteps: args.maxToolSteps,
      });
      if (toolRetry.recovered) return { recovered: true };
      // Falls through to the tool-less ladder below — but if the retry
      // itself touched a tool before ultimately failing, that ladder's
      // substitute must summarize honestly, not use the "no work was done"
      // refusal wording (PM #119's premise, now true of the retry instead
      // of the primary).
      effectiveToolCallOccurred = toolRetry.toolCallOccurred;
    }

    // Gate 2 — classify THIS error, don't blanket-skip the same-endpoint retry.
    const skipBrainRetry = isDeterministicClientError(args.error);

    const messages = mergeConsecutiveSameRole([
      ...args.messages,
      {
        role: "user" as const,
        content: finalAnswerInstruction(effectiveToolCallOccurred),
      },
    ]);

    const attempt = await generateFinalAnswerWithFailover({
      model: args.model,
      systemPrompt: args.systemPrompt,
      messages,
      providerOptions: args.providerOptions,
      settings: args.settings,
      abortSignal: args.abortSignal,
      brainConfig: args.brainConfig,
      projectId: args.projectId,
      currentPath: args.currentPath,
      degradationPolicy: policy,
      skipBrainRetry,
    });

    if (!attempt.text) return { recovered: false };
    // A cancel that landed mid-recovery — don't persist an unwanted message.
    if (args.abortSignal?.aborted) return { recovered: false };

    let persisted = false;
    try {
      await updateChat(args.chatId, (chat) => {
        const now = new Date().toISOString();
        chat.messages.push({
          id: crypto.randomUUID(),
          role: "assistant",
          content: stripThinkingTags(attempt.text),
          createdAt: now,
        });
        chat.updatedAt = now;
        chat.cumulativeUsage = foldTurnUsage(
          chat.cumulativeUsage,
          args.brainConfig.provider,
          args.brainConfig.model,
          { continuationUsage: attempt.usage }
        );
        return chat;
      });
      persisted = true;
    } catch (saveErr) {
      console.error(
        "[Agent] Primary-stream recovery: failed to persist the recovered message:",
        saveErr
      );
    }
    // Never claim a recovery the store didn't durably record.
    if (!persisted) return { recovered: false };

    publishChatErrorEvent({
      chatId: args.chatId,
      projectId: args.projectId,
      payload: {
        kind: "turn_recovered",
        message:
          attempt.notice ??
          `[Agent] The configured model failed to answer; this turn was answered by a substitute instead.`,
        recoverable: true,
      },
    });
    publishOrchestratorFinished(args.chatId, args.projectId, "completed", "agent_stream_recovered");
    publishUiSyncEvent({ topic: "files", projectId: args.projectId ?? null, reason: "agent_turn_finished" });

    return { recovered: true };
  } finally {
    recoveryInFlight.delete(args.chatId);
  }
}
