/**
 * Tool-capable retry-on-model-swap.
 *
 * THE GAP THIS CLOSES. `generateFinalAnswerWithFailover` (`final-answer-
 * failover.ts`) is deliberately TOOL-LESS — when the primary model fails, a
 * substitute gets one `generateText` call, no tools bound. When
 * `toolCallOccurred === false` (nothing executed yet this turn) and the task
 * genuinely needs a tool, the substitute is correctly instructed to honestly
 * refuse rather than fabricate (PM #119) — but the task is then never
 * actually completed, because tool-less recovery structurally cannot call
 * the tool the task needs. Live incident, 2026-09-02: a web-research request
 * hit exactly this — primary failed silently, recovery honestly refused,
 * the user never got their research.
 *
 * WHAT THIS DOES. Exactly ONE tool-capable retry candidate, gated on
 * `toolCallOccurred === false`, tried BEFORE the tool-less ladder. On
 * success, the task is genuinely completed (not summarized/refused) by a
 * different model, with real tool calls persisted. On failure, the caller
 * falls through to the existing tool-less ladder unchanged — the honest-
 * refusal safety net (PM #119) is never removed, only given one real chance
 * to be unnecessary first.
 *
 * WHY EXACTLY ONE CANDIDATE, NOT A CASCADE. An external 4-model council (4take)
 * reviewed a draft of this feature and converged on a CRITICAL concern: a
 * substitute reusing a turn's already-assembled tools could re-execute an
 * action an EARLIER attempt already took, unless guarded by a dedicated
 * cross-attempt dedup layer. That concern is real for 2+ tool-capable
 * attempts chained together — but verified from source (this repo's
 * `agent.ts` AND the installed AI SDK's own `runToolsTransformation`,
 * `node_modules/ai/dist/index.mjs`): the `tool-call` chunk that sets
 * `toolCallOccurred` fires only once the SDK has decided to call the tool,
 * and a tool's wrapped `execute()` only ever runs after that chunk — a
 * stream that dies mid-parse of a tool call's arguments produces neither.
 * So `toolCallOccurred === false` is provably "no tool's execute() ran this
 * stream," not an approximation. At a cap of exactly ONE candidate, that
 * single retry is therefore PROVABLY the first tool activity this turn —
 * there is nothing for it to have duplicated, so the dedup layer the council
 * flagged is structurally unnecessary here, not just lower-risk. Raising the
 * cap above 1 would reintroduce exactly that need; deliberately not done.
 *
 * WHY THE ALREADY-ASSEMBLED `tools` OBJECT IS REUSED, NOT REBUILT. MCP tool
 * discovery (`getProjectMcpToolsForContext`) runs once per turn, before any
 * gate here is evaluated, and is a read-only `tools/list` RPC — never routed
 * through the guarded `execute()`. Combined with the cap-of-one argument
 * above (no tool call — and so no MCP transport activity — happened before
 * this retry begins), reusing the turn's `tools` avoids uselessly opening a
 * second MCP session (stdio child process / HTTP session) for a connection
 * that was never touched.
 */
import { generateText, stepCountIs, hasToolCall, type ModelMessage, type ToolSet } from "ai";
import { createModel } from "@/lib/providers/llm-provider";
import { resolveMaxOutputTokens } from "@/lib/providers/model-output-limits";
import { resolveContextWindow } from "@/lib/providers/context-window";
import { createTokenGovernor, withStepBudgetNotice } from "@/lib/agent/token-governor";
import { callDeadlineSignal } from "@/lib/agent/stream-watchdog";
import { getFreeModelFamily } from "@/lib/agent/free-mode";

const DEFAULT_TOOL_RETRY_DEADLINE_MS = 60_000;
const DEFAULT_TOOL_RETRY_CANDIDATE_DEADLINE_MS = 20_000;

export function toolRetryDeadlineMs(): number {
  const raw = Number(process.env.ORCHESTRA_TOOL_RETRY_DEADLINE_MS ?? DEFAULT_TOOL_RETRY_DEADLINE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TOOL_RETRY_DEADLINE_MS;
}

/**
 * Smallest wall-clock one tool step can plausibly consume end to end: the
 * model's own generation, plus the tool's `execute`, plus the round trip that
 * feeds the result back. Deliberately an UNDER-estimate — it exists to reject
 * absurd step budgets, not to predict a real step.
 */
const MIN_PLAUSIBLE_STEP_MS = 2_000;

/**
 * Hard ceiling on the steps a RECOVERY retry may take, regardless of how much
 * time it is given. This path re-runs a failed turn to get *an answer out*, and
 * the tool-less ladder still runs behind it — so it is deliberately not a
 * second full agentic turn.
 */
const RECOVERY_MAX_TOOL_STEPS = 8;

/**
 * The step budget for ONE recovery attempt, DERIVED from that attempt's actual
 * wall-clock deadline.
 *
 * The turn's own `MAX_TOOL_STEPS_PER_TURN` is 100. Handing that to an attempt
 * bounded at 20s is not a generous budget, it is a mis-declared one: the
 * deadline aborts the call long before step 100, so the only thing the high cap
 * changes is WHERE the attempt dies — mid-tool, with the abort recorded against
 * the substitute endpoint — instead of at a stop condition it declared. It also
 * makes `withStepBudgetNotice` tell the model a step allowance it cannot spend.
 *
 * Deriving the cap from the deadline is what keeps the two from drifting apart:
 * shrink the deadline and the step budget shrinks with it, with no second
 * constant to remember and no pairing gate to enforce (the PM #123 / PM #134
 * lesson that a budget PAIR split in one direction is how these regress).
 */
export function recoveryToolStepBudget(requestedSteps: number, attemptDeadlineMs: number): number {
  const affordable = Math.floor(attemptDeadlineMs / MIN_PLAUSIBLE_STEP_MS);
  return Math.max(1, Math.min(requestedSteps, affordable, RECOVERY_MAX_TOOL_STEPS));
}

export function toolRetryCandidateDeadlineMs(): number {
  const raw = Number(
    process.env.ORCHESTRA_TOOL_RETRY_CANDIDATE_DEADLINE_MS ?? DEFAULT_TOOL_RETRY_CANDIDATE_DEADLINE_MS
  );
  const wanted = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TOOL_RETRY_CANDIDATE_DEADLINE_MS;
  const maxAllowed = Math.max(5000, toolRetryDeadlineMs() - 1500);
  return Math.min(wanted, maxAllowed);
}
import { estimateTokenCount } from "@/lib/agent/compressor";
import {
  turnHasDeliverableAnswer,
  getLastAssistantText,
  getLastResponseToolText,
  countTrailingLoopBlockSteps,
  LOOP_ABORT_CONSECUTIVE,
} from "@/lib/agent/agent-response";
import {
  unwrapSerializedResponseCall,
  stripThinkingTags,
} from "@/lib/agent/printed-tool-call";
import { convertModelMessageToChatMessages } from "@/lib/agent/agent-messages";
import {
  buildFinalAnswerPool,
  compareModelsByBenchmarkScoreDesc,
  type FinalAnswerAttemptArgs,
} from "@/lib/agent/final-answer-failover";
import { modelSupportsTools } from "@/lib/providers/tool-support";
import {
  classifyModelFailure,
  recordModelFailure,
  recordModelSuccess,
  isModelCircuitOpen,
} from "@/lib/agent/model-health";
import { foldTurnUsage } from "@/lib/cost/accumulator";
import { updateChat } from "@/lib/storage/chat-store";
import { publishChatErrorEvent, publishUiSyncEvent } from "@/lib/realtime/event-bus";
import { publishOrchestratorFinished } from "@/lib/agent/agent-dag-events";
import type { AppSettings, ModelConfig } from "@/lib/types";

/**
 * Local mirror of `agent.ts`'s own module-private `loopAbortStop` — same 2
 * exported primitives, same threshold. Not imported: `agent.ts` is this
 * repo's one recorded file-size exception and the function itself is not
 * exported. Zero drift risk — both bodies are one line over the same
 * `LOOP_ABORT_CONSECUTIVE` constant.
 */
const toolRetryLoopAbortStop = (opts: {
  steps: ReadonlyArray<{ toolResults?: ReadonlyArray<{ output?: unknown }> }>;
}): boolean => countTrailingLoopBlockSteps(opts.steps) >= LOOP_ABORT_CONSECUTIVE;

/**
 * The unit of CORRELATED failure for one candidate — what the diversity pass
 * must spread across.
 *
 * For OpenRouter every id shares one account, one key and one gateway, so the
 * thing that fails together is the upstream VENDOR, which only the id encodes
 * (`nvidia/…`, `google/…`). For every other provider the account and the
 * endpoint are the provider itself, so that is the unit — deriving a family
 * from the bare model name there reads `gpt-5.2` and `o4-mini` as two
 * different vendors and lets the "diverse" pass fill every slot with one
 * provider's models, which is precisely the outage this pass exists to avoid.
 */
function candidateFamily(c: ModelConfig): string {
  return c.provider === "openrouter" ? `openrouter:${getFreeModelFamily(c.model)}` : c.provider;
}

/**
 * Up to `limit` candidates for a tool-capable retry: best-scoring, tool-supporting,
 * healthy, distinct from the brain, prioritising vendor-family diversity.
 */
export function selectToolCapableRetryCandidates(
  settings: AppSettings,
  brainConfig: ModelConfig,
  limit = 3
): ModelConfig[] {
  const brainKey = `${brainConfig.provider}/${brainConfig.model}`;
  const seen = new Set<string>([brainKey]);
  const pool = buildFinalAnswerPool(settings)
    .filter((c) => {
      const key = `${c.provider}/${c.model}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .filter((c) => modelSupportsTools(c.provider, c.model))
    .filter((c) => !isModelCircuitOpen(c.provider, c.model))
    .sort(compareModelsByBenchmarkScoreDesc);

  if (pool.length <= limit) return pool;

  const selected: ModelConfig[] = [];
  const chosenFamilies = new Set<string>();

  // Pass 1: one candidate per vendor family, best-scoring first.
  for (const cand of pool) {
    const fam = candidateFamily(cand);
    if (!chosenFamilies.has(fam)) {
      selected.push(cand);
      chosenFamilies.add(fam);
      if (selected.length === limit) return selected;
    }
  }

  // Pass 2: fill the remaining slots with the next highest-scoring candidates.
  for (const cand of pool) {
    if (!selected.includes(cand)) {
      selected.push(cand);
      if (selected.length === limit) return selected;
    }
  }

  return selected;
}

/**
 * Backward-compatible single candidate selector — returns the best-scoring candidate.
 */
export function selectToolCapableRetryCandidate(
  settings: AppSettings,
  brainConfig: ModelConfig
): ModelConfig | null {
  return selectToolCapableRetryCandidates(settings, brainConfig, 1)[0] ?? null;
}

export interface ToolCapableRetryArgs {
  brainConfig: ModelConfig;
  systemPrompt: string;
  messages: ModelMessage[];
  /** This turn's already-assembled, already-guarded ToolSet — reused, never rebuilt. */
  tools: ToolSet;
  providerOptions: FinalAnswerAttemptArgs["providerOptions"];
  settings: AppSettings;
  abortSignal?: AbortSignal;
  chatId: string;
  projectId?: string;
  currentPath?: string;
  /** Gates the per-tool Swarm-Activity emit (PM #96 parity). */
  swarmEnabled: boolean;
  /** Caller's own step budget (agent.ts's `MAX_TOOL_STEPS_PER_TURN`) — matches
   *  the primary's own budget rather than a tighter one: a rescue that fails
   *  from running out of steps is worse than one that costs more and succeeds. */
  maxToolSteps: number;
}

export interface ToolCapableRetryResult {
  recovered: boolean;
  /**
   * True iff a tool's `execute()` actually ran during THIS cascade, win or
   * lose. On `recovered: false`, the caller must thread this into whichever
   * instruction the tool-less ladder falls back to next — real tool activity
   * on the retry means that ladder's substitute should summarize honestly,
   * not use the "no work was done" refusal wording (PM #119's premise would
   * otherwise be violated the same way the original incident violated it).
   */
  toolCallOccurred: boolean;
}

/**
 * Attempt a bounded, multi-candidate tool-capable recovery of a primary-stream failure —
 * the full task, with tools, cascading through up to 3 substitutes. Never throws.
 *
 * Council safety invariant (protake review):
 * If a candidate fails before executing any tool (toolCallOccurredThisAttempt === false),
 * we safely cascade to candidate #2 / #3. If a candidate actually executed tools and
 * then died mid-turn, we stop the cascade to prevent duplicate side effects or orphaned
 * tool-call messages, cleanly falling through to the tool-less ladder.
 */
export async function attemptToolCapableRetry(
  args: ToolCapableRetryArgs
): Promise<ToolCapableRetryResult> {
  if (!args.tools || Object.keys(args.tools).length === 0) {
    return { recovered: false, toolCallOccurred: false };
  }

  const candidates = selectToolCapableRetryCandidates(args.settings, args.brainConfig, 3);
  if (candidates.length === 0) {
    console.warn(
      `[Agent] Tool-capable retry — no tool-capable, healthy substitute available; ` +
        `falling through to the tool-less ladder.`
    );
    return { recovered: false, toolCallOccurred: false };
  }

  const cascadeTotalBudget = toolRetryDeadlineMs();
  const cascadeStartTime = Date.now();
  const candidateTimeout = toolRetryCandidateDeadlineMs();
  let anyToolCallOccurred = false;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const elapsed = Date.now() - cascadeStartTime;
    const remainingBudget = cascadeTotalBudget - elapsed;

    // Bounded deadline: if less than 8s remains, don't start an attempt doomed to time out
    if (remainingBudget < 8_000) {
      console.warn(
        `[Agent] Tool-capable retry cascade budget exhausted (${elapsed}ms elapsed); ` +
          `falling through to the tool-less ladder.`
      );
      break;
    }

    if (args.abortSignal?.aborted) {
      break;
    }

    // Re-check circuit breaker per attempt (protake council recommendation)
    if (isModelCircuitOpen(candidate.provider, candidate.model)) {
      console.warn(
        `[Agent] Tool-capable retry skipping candidate #${i + 1} (${candidate.provider}/${candidate.model}) — circuit is open.`
      );
      continue;
    }

    let substituteModel;
    try {
      substituteModel = createModel(candidate, {
        projectId: args.projectId,
        currentPath: args.currentPath,
      });
    } catch (error) {
      console.warn(
        `[Agent] Tool-capable retry — could not build candidate #${i + 1} (${candidate.provider}/${candidate.model}): ` +
          (error instanceof Error ? error.message : String(error))
      );
      continue;
    }

    console.warn(
      `[Agent] Tool-capable retry (attempt ${i + 1}/${candidates.length}) — retrying full task WITH tools on ${candidate.provider}/${candidate.model}.`
    );

    const contextWindow = await resolveContextWindow(candidate, { abortSignal: args.abortSignal });
    const systemPromptTokens = estimateTokenCount([{ role: "system", content: args.systemPrompt }]);
    const tokenGovernor = createTokenGovernor({
      contextWindow,
      reservedOutputTokens: resolveMaxOutputTokens(candidate),
      systemPromptTokens,
      modelHint: { provider: candidate.provider, model: candidate.model },
    });

    let toolCallOccurredThisAttempt = false;
    const messages: ModelMessage[] = [...args.messages];
    const isLastCandidate = i === candidates.length - 1;
    const candidateBudget = isLastCandidate
      ? remainingBudget - 1_500
      : Math.min(candidateTimeout, remainingBudget - 1_500);
    const attemptDeadline = Math.max(5_000, candidateBudget);
    // Steps and time are one budget — see `recoveryToolStepBudget`.
    const stepBudget = recoveryToolStepBudget(args.maxToolSteps, attemptDeadline);

    let generated;
    try {
      generated = await generateText({
        model: substituteModel,
        system: args.systemPrompt,
        messages,
        providerOptions: args.providerOptions,
        tools: args.tools,
        maxRetries: 1,
        prepareStep: withStepBudgetNotice(tokenGovernor, { maxSteps: stepBudget }),
        stopWhen: [stepCountIs(stepBudget), hasToolCall("response"), toolRetryLoopAbortStop],
        temperature: args.settings.chatModel.temperature ?? 0.7,
        maxOutputTokens: resolveMaxOutputTokens(candidate),
        abortSignal: callDeadlineSignal(args.abortSignal, attemptDeadline),
        onStepFinish: async (event) => {
          const stepToolCalls = (
            event as unknown as { toolCalls?: Array<{ toolName?: string }> }
          ).toolCalls;
          if (stepToolCalls && stepToolCalls.length > 0) {
            toolCallOccurredThisAttempt = true;
            anyToolCallOccurred = true;
          }

          if (event.usage) {
            try {
              await updateChat(args.chatId, (chat) => {
                chat.cumulativeUsage = foldTurnUsage(
                  chat.cumulativeUsage,
                  candidate.provider,
                  candidate.model,
                  { streamUsage: event.usage }
                );
                return chat;
              });
            } catch (err) {
              console.error("[Agent] Tool-capable retry — failed to persist step usage:", err);
            }
          }

          if (args.swarmEnabled) {
            try {
              for (const call of stepToolCalls ?? []) {
                publishUiSyncEvent({
                  topic: "chat",
                  chatId: args.chatId,
                  projectId: args.projectId ?? null,
                  reason: `[Agent] ${call.toolName ?? "tool"} (tool-capable retry)`,
                });
              }
            } catch (activityErr) {
              console.warn("[Agent] Tool-capable retry — step-activity emit error (non-fatal):", activityErr);
            }
          }
        },
      });
    } catch (error) {
      const kind = args.abortSignal?.aborted ? null : classifyModelFailure(error);
      if (kind) recordModelFailure(candidate.provider, candidate.model, kind);
      console.warn(
        `[Agent] Tool-capable retry attempt ${i + 1} failed on ${candidate.provider}/${candidate.model}: ` +
          (error instanceof Error ? error.message : String(error))
      );
      // Protake council safety invariant:
      // If tools already executed during THIS attempt before crashing, do NOT cascade to
      // the next candidate to avoid orphaned tool calls or duplicate destructive side effects.
      if (toolCallOccurredThisAttempt) {
        console.warn(
          `[Agent] Tool-capable retry — tools already executed before failure; stopping cascade to prevent duplicate side effects.`
        );
        return { recovered: false, toolCallOccurred: true };
      }
      continue;
    }

    const responseMessages = generated.response?.messages ?? [];
    if (!turnHasDeliverableAnswer(responseMessages)) {
      console.warn(
        `[Agent] Tool-capable retry attempt ${i + 1} on ${candidate.provider}/${candidate.model} produced no deliverable answer.`
      );
      if (toolCallOccurredThisAttempt) {
        return { recovered: false, toolCallOccurred: true };
      }
      continue;
    }
    recordModelSuccess(candidate.provider, candidate.model);

    const finalText = unwrapSerializedResponseCall(
      getLastResponseToolText(responseMessages) || getLastAssistantText(responseMessages)
    ).trim();

    let persisted = false;
    try {
      const updated = await updateChat(args.chatId, (chat) => {
        const now = new Date().toISOString();
        if (responseMessages.length > 0) {
          for (const msg of responseMessages) {
            chat.messages.push(...convertModelMessageToChatMessages(msg, now));
          }
        } else {
          chat.messages.push({
            id: crypto.randomUUID(),
            role: "assistant",
            content: stripThinkingTags(finalText),
            createdAt: now,
          });
        }
        chat.updatedAt = now;
        return chat;
      });
      persisted = updated !== null;
    } catch (saveErr) {
      console.error("[Agent] Tool-capable retry — failed to persist the recovered turn:", saveErr);
    }
    if (!persisted) {
      return { recovered: false, toolCallOccurred: anyToolCallOccurred };
    }

    publishChatErrorEvent({
      chatId: args.chatId,
      projectId: args.projectId,
      payload: {
        kind: "turn_recovered_with_tools",
        message:
          `[Agent] ${args.brainConfig.provider}/${args.brainConfig.model} failed before completing ` +
          `any work this turn — ${candidate.provider}/${candidate.model} retried the task with tools ` +
          `and completed it.`,
        recoverable: true,
      },
    });
    publishOrchestratorFinished(args.chatId, args.projectId, "completed", "agent_stream_recovered_with_tools");
    publishUiSyncEvent({ topic: "files", projectId: args.projectId ?? null, reason: "agent_turn_finished" });

    return { recovered: true, toolCallOccurred: anyToolCallOccurred };
  }

  return { recovered: false, toolCallOccurred: anyToolCallOccurred };
}
