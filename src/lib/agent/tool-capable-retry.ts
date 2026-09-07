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
import { turnDeadlineSignal } from "@/lib/agent/stream-watchdog";
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
 * The one candidate for a tool-capable retry: best-scoring, tool-supporting,
 * healthy, distinct from the brain. Exported for direct unit testing,
 * matching `buildFinalAnswerPool`'s own precedent in this codebase.
 */
export function selectToolCapableRetryCandidate(
  settings: AppSettings,
  brainConfig: ModelConfig
): ModelConfig | null {
  const brainKey = `${brainConfig.provider}/${brainConfig.model}`;
  const seen = new Set<string>([brainKey]);
  const candidates = buildFinalAnswerPool(settings)
    .filter((c) => {
      const key = `${c.provider}/${c.model}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .filter((c) => modelSupportsTools(c.provider, c.model))
    .filter((c) => !isModelCircuitOpen(c.provider, c.model))
    .sort(compareModelsByBenchmarkScoreDesc);
  return candidates[0] ?? null;
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
   * True iff a tool's `execute()` actually ran during THIS attempt, win or
   * lose. On `recovered: false`, the caller must thread this into whichever
   * instruction the tool-less ladder falls back to next — real tool activity
   * on the retry means that ladder's substitute should summarize honestly,
   * not use the "no work was done" refusal wording (PM #119's premise would
   * otherwise be violated the same way the original incident violated it).
   */
  toolCallOccurred: boolean;
}

/**
 * Attempt one bounded, tool-capable recovery of a primary-stream failure —
 * the full task, with tools, on a different model. Never throws. Every
 * failure path returns `{recovered: false, toolCallOccurred: <what actually
 * happened this attempt>}` so the caller can fall through to the tool-less
 * ladder with accurate information rather than the primary's stale flag.
 */
export async function attemptToolCapableRetry(
  args: ToolCapableRetryArgs
): Promise<ToolCapableRetryResult> {
  if (!args.tools || Object.keys(args.tools).length === 0) {
    return { recovered: false, toolCallOccurred: false };
  }

  const candidate = selectToolCapableRetryCandidate(args.settings, args.brainConfig);
  if (!candidate) {
    console.warn(
      `[Agent] Tool-capable retry — no tool-capable, healthy substitute available; ` +
        `falling through to the tool-less ladder.`
    );
    return { recovered: false, toolCallOccurred: false };
  }

  let substituteModel;
  try {
    substituteModel = createModel(candidate, {
      projectId: args.projectId,
      currentPath: args.currentPath,
    });
  } catch (error) {
    console.warn(
      `[Agent] Tool-capable retry — could not build ${candidate.provider}/${candidate.model}: ` +
        (error instanceof Error ? error.message : String(error))
    );
    return { recovered: false, toolCallOccurred: false };
  }

  console.warn(
    `[Agent] Tool-capable retry — ${args.brainConfig.provider}/${args.brainConfig.model} did no ` +
      `work before failing; retrying the full task WITH tools on ${candidate.provider}/${candidate.model}.`
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
  // Defensive shallow copy — this attempt must not observe (or cause) any
  // mutation shared with the primary attempt's own message handling.
  const messages: ModelMessage[] = [...args.messages];

  let generated;
  try {
    generated = await generateText({
      model: substituteModel,
      system: args.systemPrompt,
      messages,
      providerOptions: args.providerOptions,
      tools: args.tools,
      maxRetries: 3,
      prepareStep: withStepBudgetNotice(tokenGovernor, { maxSteps: args.maxToolSteps }),
      stopWhen: [stepCountIs(args.maxToolSteps), hasToolCall("response"), toolRetryLoopAbortStop],
      temperature: args.settings.chatModel.temperature ?? 0.7,
      maxOutputTokens: resolveMaxOutputTokens(candidate),
      // Sized for a full multi-step turn, not a utility call — same choice
      // `runAgentText` (agent.ts) already makes for its own tool-capable
      // generateText call. Nothing is listening for live chunks during
      // recovery, so `generateText` over `streamText` costs nothing here.
      abortSignal: turnDeadlineSignal(args.abortSignal),
      onStepFinish: async (event) => {
        const stepToolCalls = (
          event as unknown as { toolCalls?: Array<{ toolName?: string }> }
        ).toolCalls;
        if (stepToolCalls && stepToolCalls.length > 0) toolCallOccurredThisAttempt = true;

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
      `[Agent] Tool-capable retry failed on ${candidate.provider}/${candidate.model}: ` +
        (error instanceof Error ? error.message : String(error))
    );
    return { recovered: false, toolCallOccurred: toolCallOccurredThisAttempt };
  }

  const responseMessages = generated.response?.messages ?? [];
  if (!turnHasDeliverableAnswer(responseMessages)) {
    console.warn(
      `[Agent] Tool-capable retry on ${candidate.provider}/${candidate.model} produced no deliverable answer.`
    );
    return { recovered: false, toolCallOccurred: toolCallOccurredThisAttempt };
  }
  recordModelSuccess(candidate.provider, candidate.model);

  const finalText = unwrapSerializedResponseCall(
    getLastResponseToolText(responseMessages) || getLastAssistantText(responseMessages)
  ).trim();

  let persisted = false;
  try {
    await updateChat(args.chatId, (chat) => {
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
      // Usage already folded per-step above (onStepFinish) — do not fold
      // `generated.usage` again here, that would double-count the spend.
      return chat;
    });
    persisted = true;
  } catch (saveErr) {
    console.error("[Agent] Tool-capable retry — failed to persist the recovered turn:", saveErr);
  }
  // Never claim a recovery the store didn't durably record.
  if (!persisted) return { recovered: false, toolCallOccurred: toolCallOccurredThisAttempt };

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

  return { recovered: true, toolCallOccurred: toolCallOccurredThisAttempt };
}
