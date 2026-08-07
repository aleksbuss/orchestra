import {
  streamText,
  generateText,
  stepCountIs,
  hasToolCall,
  type ModelMessage,
  type PrepareStepFunction,
} from "ai";
import { buildBoundedRecallBlock, resolveRecallBudgetChars } from "@/lib/agent/deep-recall";
import {
  resolveDegradationPolicy,
  type DegradationPolicy,
} from "@/lib/agent/degradation-policy";
import { resolveMaxOutputTokens } from "@/lib/providers/model-output-limits";
import { createModel } from "@/lib/providers/llm-provider";
import { detectToolSupport } from "@/lib/agent/agent-tool-capability";
import { createStreamWatchdog, callDeadlineSignal } from "@/lib/agent/stream-watchdog";
import { publishOrchestratorFinished } from "@/lib/agent/agent-dag-events";
import { handleStreamAbort, createPartialTextBuffer } from "@/lib/agent/agent-abort";
import { foldTurnUsage } from "@/lib/cost/accumulator";
import {
  buildSystemPrompt,
  PLAIN_CHAT_TOOL_OVERRIDE,
  loadSynthesisInlineDirective,
} from "@/lib/agent/prompts";
import { getChat, updateChat } from "@/lib/storage/chat-store";
import { assembleAgentToolSet, scopeSwarmRoleTools } from "@/lib/agent/agent-tools";
import { agentSemaphore } from "./semaphore";
import type { AgentContext } from "@/lib/agent/types";
import { History, mergeConsecutiveSameRole } from "@/lib/agent/history";
import type { AppSettings } from "@/lib/types";
import { publishUiSyncEvent } from "@/lib/realtime/event-bus";
import { createCallAgentTool } from "@/lib/swarm/tools";
import { getSwarmSystemPrompt } from "@/lib/swarm/prompts";
import type { SwarmRole } from "@/lib/swarm/types";
import {
  compressChatHistory,
  estimateTokenCount,
  partitionForCompaction,
  formatVerbatimArchive,
  shouldSummarizeEviction,
  AUTO_ARCHIVE_AREA,
  filterDeepRecall,
} from "@/lib/agent/compressor";
import { resolveContextWindow, compactionThresholdFor, effectiveContextWindow } from "@/lib/providers/context-window";
import { createTokenGovernor } from "@/lib/agent/token-governor";
import { getBrainConfig, type PresetTier } from "@/lib/agent/presets";
import {
  runMoAEnsemble,
  buildInlineSynthesisInjection,
  type MoAResult,
  type SkepticModelOverride,
} from "@/lib/agent/moa";
import { captureSuccessfulTrace } from "@/lib/agent/trace-memory";
import { insertMemory, searchMemory } from "@/lib/memory/memory";
import { resolveWorkDirForProject } from "@/lib/storage/project-store";

// §10 phase 1 — message/response helpers live in agent-response.ts.
import {
  stripThinkingTags,
  unwrapSerializedResponseCall,
  getLastAssistantText,
  getLastResponseToolText,
  turnHasDeliverableAnswer,
  resolveTurnContinuation,
  detectActionHallucination,
  isDroppedNativeToolCall,
  detectPrematureCompletion,
  stripHallucinatedTrailingText,
  neutralizeHallucinatedHistory,
  countTrailingLoopBlockSteps,
  LOOP_ABORT_CONSECUTIVE,
} from "@/lib/agent/agent-response";
import type { TurnContinuationResult } from "@/lib/agent/agent-response";
// PM #81 Sprint 2 — active self-heal for hallucinated (printed-as-text) tool calls.
import {
  attemptToolReissue,
  recordReissueAttempt,
  resetReissueBudget,
  recordChatDegradation,
  isChatDegraded,
  DROP_REISSUE_CORRECTION,
} from "@/lib/agent/agent-tool-reissue";

// §10 phase 2 — message conversion + request logging live in agent-messages.ts.
import {
  convertChatMessagesToModelMessages,
  convertModelMessageToChatMessages,
  logLLMRequest,
} from "@/lib/agent/agent-messages";
// §10 PR-1 — the model auto-fallback seam lives in agent-fallback.ts.
import { attemptModelFallback } from "@/lib/agent/agent-fallback";
// §10 — the shared turn-error reporting (onError ≡ fatal-catch) lives in agent-stream.ts.
import { reportTurnError } from "@/lib/agent/agent-stream";
// Re-export the public surface so existing importers keep resolving from "./agent".
export {
  unwrapSerializedResponseCall,
  turnHasDeliverableAnswer,
  resolveTurnContinuation,
};
export type { TurnContinuationResult };

// Per-turn tool-step budget. A SAFETY/cost bound on ONE generateText/streamText
// loop — NOT a task-sizing target (a heavy task spans several user "Continue"s).
// Raised 30→50 once the runaway protection got stronger (PM #76 loop guard, the
// per-file rewrite budget, the token governor): the cap can be more generous
// because identical/looping/oversized churn is now interrupted independently of
// it. When a turn EXHAUSTS this budget without delivering an answer, the agent
// emits a deterministic "reached step limit — press Continue" pause notice
// instead of forcing a model-authored completion summary (which masqueraded as
// "done"). See resolveTurnContinuation (agent-response.ts).
const MAX_TOOL_STEPS_PER_TURN = 50;
const MAX_TOOL_STEPS_SUBORDINATE = 25;

/**
 * stopWhen predicate (2026-07-28, DoubleTake-reviewed): abort the tool loop when
 * the model is STUCK repeating an identical (tool+args) call the loop guard keeps
 * blocking (≥ LOOP_ABORT_CONSECUTIVE consecutive pure loop-guard-block steps).
 *
 * A spiral is a FAILURE state, not a finish — so we bound it, we do NOT convert
 * it to "done". A WEAK model that compulsively re-runs one passing command now
 * aborts in ~3 steps instead of bleeding to the 50-step cap; a STRONG model never
 * repeats one BLOCKED call 3× in a row (it changes arguments), so this has ZERO
 * regression surface for strong models. onFinish re-derives the same signal
 * (`countTrailingLoopBlockSteps`) to drive the honest loop-abort PAUSE notice.
 */
const loopAbortStop = (opts: {
  steps: ReadonlyArray<{ toolResults?: ReadonlyArray<{ output?: unknown }> }>;
}): boolean => countTrailingLoopBlockSteps(opts.steps) >= LOOP_ABORT_CONSECUTIVE;

/**
 * Sprint A4 — number of most-recent messages kept VERBATIM in the live context
 * during pre-flight compaction (the sliding window). Everything older than this
 * (and not a leading system anchor) is evicted to RAG.
 */
const KEEP_RECENT_MESSAGES = 8;

/**
 * PM #82 — fraction of the normal compaction threshold used for a chat flagged
 * as degraded (it has printed a tool call as text). Halving the threshold forces
 * an earlier, tighter compaction to break the long-context hallucination loop.
 */
const DEGRADED_COMPACTION_RATIO = 0.5;

/**
 * Concise, human-readable hint for a tool call's arguments, for the Swarm
 * Activity terminal (e.g. `[Agent] write_text_file — src/index.css`). Pulls the
 * most identifying field (path / command / query / url) when present, else a
 * short serialized slice. Returns "" (no hint) for empty/unusable args, and is
 * prefixed with " — " so callers can append unconditionally.
 */
function summarizeToolArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  const pick =
    a.path ?? a.filePath ?? a.file_path ?? a.target_file ?? a.command ?? a.query ?? a.url ?? a.name;
  let hint: string;
  if (typeof pick === "string") {
    hint = pick;
  } else {
    try {
      hint = JSON.stringify(a);
    } catch {
      return "";
    }
  }
  hint = hint.replace(/\s+/g, " ").trim();
  if (!hint) return "";
  return ` — ${hint.length > 80 ? hint.slice(0, 80) + "…" : hint}`;
}

function resolveModelProviderOptions(provider: string) {
  if (provider === "codex-cli") {
    return {
      openai: {
        store: false as const,
        instructions: "You are Orchestra, an AI coding assistant.",
      },
    };
  }
  return undefined;
}

/**
 * Sprint A3 — assemble the in-flight token governor (`prepareStep`) for a
 * tool-loop callsite. Reserves headroom equal to the same `maxOutputTokens` the
 * call passes to the model, and reuses a pre-resolved window when the caller
 * already has one (the interactive path) to avoid a redundant Ollama probe.
 */
async function buildTokenGovernor(
  windowConfig: { provider: string; model?: string; baseUrl?: string },
  reservedOutputTokens: number,
  abortSignal?: AbortSignal,
  preResolvedWindow?: number,
  // Layer 0 — the SYSTEM prompt string for this call. Its estimated size is
  // subtracted from the message budget so `system + messages` stays under the
  // reliable window (see createTokenGovernor's systemPromptTokens doc). Omitted
  // → 0 → prior behaviour.
  systemPrompt?: string
): Promise<PrepareStepFunction> {
  const contextWindow =
    preResolvedWindow ?? (await resolveContextWindow(windowConfig, { abortSignal }));
  const systemPromptTokens = systemPrompt
    ? estimateTokenCount([{ role: "system", content: systemPrompt }])
    : 0;
  // PM #95 — pass the model hint so the reliable-window clamp is LIFTED for
  // known-reliable large-window families (Claude/Gemini/GPT-4o) instead of 120K.
  return createTokenGovernor({
    contextWindow,
    reservedOutputTokens,
    systemPromptTokens,
    modelHint: { provider: windowConfig.provider, model: windowConfig.model },
  });
}














/**
 * Executes a subsidiary agent with a specialized role (Swarm).
 */
async function runSubAgent(
  role: SwarmRole,
  taskDescription: string,
  extraContext: string | undefined,
  parentContext: AgentContext,
  settings: AppSettings,
  providerOptions: any,
  model: any, // Pass the actual resolved model instance from Orchestrator!
  abortSignal?: AbortSignal
): Promise<string> {
  const nodeId = crypto.randomUUID();

  const { tools, mcpDocs } = await assembleAgentToolSet(parentContext, settings, {
    mcpRole: role,
    // Sub-agents lack a resolved contextWindow prop — use a safe fixed limit.
    mcpDocsLimit: 4096,
    // Swarm read-only role scoping runs before the loop-guard wrap.
    scopeTools: (t) => scopeSwarmRoleTools(t, role),
    guardContext: { chatId: parentContext.chatId, parentNodeId: nodeId },
  });

  let systemPrompt = getSwarmSystemPrompt(role) + "\n\nYou must return a concise, accurate response when your work is completely done.";
  if (mcpDocs) systemPrompt += mcpDocs;
  const promptText = extraContext 
    ? `Task:\n${taskDescription}\n\nContext/Constraints:\n${extraContext}` 
    : `Task:\n${taskDescription}`;

  // DAG: publish agent_node start
  publishUiSyncEvent({
    topic: "chat",
    chatId: parentContext.chatId,
    reason: `[Swarm] Orchestrator delegated task to specialized agent "${role}": ${taskDescription}`,
    parentId: parentContext.chatId,
    nodeType: "agent_node",
    swarmNode: {
      nodeId,
      parentNodeId: parentContext.chatId,
      role,
      taskSummary: taskDescription.slice(0, 120),
      status: "running",
      startedAt: new Date().toISOString(),
    },
  });

  try {
    const tokenGovernor = await buildTokenGovernor(
      settings.chatModel,
      resolveMaxOutputTokens(settings.chatModel),
      abortSignal,
      undefined,
      systemPrompt // Layer 0 — subtract the system-prompt size from the msg budget
    );
    const result = await generateText({
      model,
      system: systemPrompt,
      providerOptions,
      messages: [{ role: "user", content: promptText }],
      tools,
      maxRetries: 3,
      prepareStep: tokenGovernor,
      stopWhen: [stepCountIs(MAX_TOOL_STEPS_SUBORDINATE), hasToolCall("response"), loopAbortStop],
      temperature: settings.chatModel.temperature ?? 0.7,
      maxOutputTokens: resolveMaxOutputTokens(settings.chatModel),
      // PM #98 — sub-agent delegation: no human is watching this one.
      abortSignal: callDeadlineSignal(abortSignal),
    });
    // PM #61 — unwrap a serialized `response` call if the model emitted it as
    // text (JSON/`<call:>`); no-op on clean text. Applies to the swarm-agent
    // result returned into the parent's context.
    const responseText = unwrapSerializedResponseCall(
      getLastResponseToolText(result.response.messages) || result.text
    );
    const outputText = responseText.trim() || "Agent finished but returned no text.";

    // DAG: publish agent_node completed
    publishUiSyncEvent({
      topic: "chat",
      chatId: parentContext.chatId,
      reason: `[Swarm] Agent "${role}" completed its task.`,
      parentId: parentContext.chatId,
      nodeType: "agent_node",
      swarmNode: {
        nodeId,
        role,
        taskSummary: taskDescription.slice(0, 120),
        status: "completed",
        completedAt: new Date().toISOString(),
      },
    });

    return outputText;
  } catch (err) {
    // DAG: publish agent_node error
    publishUiSyncEvent({
      topic: "chat",
      chatId: parentContext.chatId,
      nodeType: "agent_node",
      swarmNode: {
        nodeId,
        role,
        taskSummary: taskDescription.slice(0, 120),
        status: "error",
        completedAt: new Date().toISOString(),
      },
    });
    console.error(`[Swarm] Sub-agent "${role}" error:`, err instanceof Error ? err.message : err);
    return `[Swarm] Sub-agent Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Run the agent for a given chat context and return a streamable result.
 * Uses Vercel AI SDK's streamText with stopWhen for automatic tool loop.
 */
export interface RunAgentOptions {
  chatId: string;
  userMessage: string;
  projectId?: string;
  currentPath?: string;
  agentNumber?: number;
  swarmEnabled?: boolean;
  /**
   * Bypass the MoA Router's `requiresSwarm` classification. When `true`, the
   * full proposer fan-out runs regardless of the Router's verdict. Plumbed
   * straight through to `runMoAEnsemble`; has no effect when
   * `swarmEnabled === false`.
   */
  forceSwarm?: boolean;
  /**
   * DDD — per-request Skeptic model override (`{provider, model}` ONLY;
   * validated at the API boundary). Governs both skeptic surfaces in the
   * MoA run. PM #22: threaded through every dispatch path (interactive,
   * background, queue, daemon continuation).
   */
  skepticModelOverride?: SkepticModelOverride | null;
  /**
   * DDD — per-request "Deep Audit" (reflection) toggle. Overrides
   * `settings.reflection.enabled` for this run only. PM #22: same threading.
   */
  deepAudit?: boolean;
  /**
   * Sprint 4 (free-tier failover) — per-request degradation policy. Governs
   * whether Orchestra may substitute another configured model when the chosen
   * one will not answer. PM #22: same threading as `forceSwarm`/`deepAudit`
   * (interactive stream + background dispatch + queue persistence + daemon
   * continuation). Unattended runs are forced to `speed` via `isBackground`.
   */
  degradationPolicy?: DegradationPolicy;
  isBackground?: boolean;
  abortSignal?: AbortSignal;
  preset?: PresetTier;
}

// PM #47/#58 — Privacy Mode guards extracted to `agent-privacy.ts` (§8
// zero-net-growth offset, DDD Skeptic-override track). Re-exported here
// so existing callers/tests importing from `./agent` keep working.
export {
  assertPrivacyModeAllowsSettings,
  assertPrivacyModeAllowsSkepticOverride,
  resolveGuardedAgentSettings,
} from "@/lib/agent/agent-privacy";
import {
  assertPrivacyModeAllowsSkepticOverride,
  resolveGuardedAgentSettings,
} from "@/lib/agent/agent-privacy";

export async function runAgent(options: RunAgentOptions) {
  // Sprint 4 — acquire settings + the Privacy-Mode air-gap as ONE atomic step.
  // A bare getSettings() + a hand-copied guard line is exactly what two of the
  // three entry points forgot (PM #58 P0 egress leak). See
  // resolveGuardedAgentSettings.
  const settings = await resolveGuardedAgentSettings();
  // A5 — the per-request Skeptic override is NOT in settings; guard it
  // separately (route checks too — defense in depth, PM #58 posture).
  assertPrivacyModeAllowsSkepticOverride(settings, options.skepticModelOverride);

  // Resolve model config: if a preset is active, use its brain config;
  // otherwise fall back to the user's manual settings.
  const resolvedModelConfig = options.preset
    ? getBrainConfig(options.preset, settings.chatModel)
    : settings.chatModel;

  // Smart API key resolution for presets:
  // 1. If the preset itself has a key → use it (shouldn't happen, presets don't store keys)
  // 2. If there's a key in the provider-specific vault → use it
  // 3. If the user's chatModel uses the SAME provider → inherit its key
  // 4. Fall through to env vars (handled by createModel)
  if (options.preset && options.preset !== "custom" && !resolvedModelConfig.apiKey) {
    const provider = resolvedModelConfig.provider;
    const vaultKey = settings.providerApiKeys?.[provider];
    if (vaultKey) {
      resolvedModelConfig.apiKey = vaultKey;
      console.log(`[KeyResolver] ${provider}: using vault key`);
    } else if (settings.chatModel.provider === provider && settings.chatModel.apiKey) {
      resolvedModelConfig.apiKey = settings.chatModel.apiKey;
      console.log(`[KeyResolver] ${provider}: inherited from chatModel`);
    } else {
      console.warn(`[KeyResolver] ${provider}: no key found in vault or chatModel`);
    }
  }

  const providerOptions = resolveModelProviderOptions(resolvedModelConfig.provider);
  const model = createModel(resolvedModelConfig, {
    projectId: options.projectId,
    currentPath: options.currentPath,
  });

  console.log(`[Agent] provider=${resolvedModelConfig.provider} model=${resolvedModelConfig.model} preset=${options.preset ?? "custom"} hasKey=${!!resolvedModelConfig.apiKey}`);

  // Build context. workDir resolves the project's effective filesystem root
  // (linked projects honor `absoluteRoot`; sandbox projects fall back to
  // `data/projects/<id>/`). Pre-resolving here avoids an async lookup on
  // every tool call inside resolveContextCwd.
  const workDir = await resolveWorkDirForProject(options.projectId);
  const context: AgentContext = {
    chatId: options.chatId,
    projectId: options.projectId,
    currentPath: options.currentPath,
    workDir,
    memorySubdir: options.projectId
      ? `${options.projectId}`
      : "main",
    knowledgeSubdirs: options.projectId
      ? [`${options.projectId}`, "main"]
      : ["main"],
    history: [],
    agentNumber: options.agentNumber ?? 0,
    data: {
      currentUserMessage: options.userMessage,
    },
  };

  // Immediate Persistence: Save the user message BEFORE starting the LLM stream.
  // This ensures the chat history is consistent even if the network fails mid-turn.
  await updateChat(options.chatId, (c) => {
    const alreadyExists = c.messages.some(m => m.role === "user" && m.content === options.userMessage && (Date.now() - new Date(m.createdAt).getTime() < 5000));
    if (!alreadyExists) {
      c.messages.push({
        id: crypto.randomUUID(),
        role: "user",
        content: options.userMessage,
        createdAt: new Date().toISOString(),
      });
    }
    return c;
  });

  // Load existing chat history
  let chat = await getChat(options.chatId);

  // Sprint A2/A3: resolve the model's REAL context window ONCE — reused for
  // pre-flight compaction (below) AND the in-flight token governor (streamText).
  // Ollama is probed live (/api/ps → Modelfile num_ctx → env → default) because
  // its runtime num_ctx (e.g. 4096) is far below the trained context_length
  // (/api/show reports 32768 for qwen2.5); cloud uses a conservative per-family map.
  const contextWindow = await resolveContextWindow(resolvedModelConfig, {
    abortSignal: options.abortSignal,
  });

  if (chat) {
    const rawModelMessages = convertChatMessagesToModelMessages(chat.messages);
    const estimatedTokens = estimateTokenCount(rawModelMessages);

    // Compaction fires at 75% of the resolved (reliable-capped) window (Sprint
    // A2 + PM #82). A chat that has shown the printed-tool-call degradation
    // symptom compacts at HALF that — a behavior-triggered backstop (PM #82) that
    // escapes the long-context loop even when the model degrades BELOW the static
    // reliable-window cap.
    const contextLimit = compactionThresholdFor(contextWindow, resolvedModelConfig);
    const effectiveLimit = isChatDegraded(options.chatId)
      ? Math.floor(contextLimit * DEGRADED_COMPACTION_RATIO)
      : contextLimit;

    // Sprint A1: gate compaction on token pressure ONLY. The old
    // `&& chat.messages.length > 12` guard let a moderate (9–12 message) chat
    // that genuinely exceeds the limit sail past compaction.
    if (estimatedTokens > effectiveLimit) {
      // Sprint A4 — sliding-window + anchors. Keep leading SYSTEM anchors (task
      // framing) and the most-recent-K messages VERBATIM in the live context;
      // only the middle tail is evicted. That tail is archived to RAG TWICE:
      //   (1) VERBATIM — exact artifacts (stack traces, file contents, API keys)
      //       must stay byte-for-byte retrievable, never paraphrased away. This
      //       is the core A4 fix: LLM-summarization alone destroyed exact strings.
      //   (2) Dense LLM summary — cheap narrative continuity for the Router/RAG.
      // `partitionForCompaction` returns an EMPTY `evicted` for short histories
      // (≤ anchors + K), so the guard below also kills the old negative-slice
      // footgun that emitted bogus "Deep-archiving" events + empty RAG inserts.
      const { anchors, evicted, recent } = partitionForCompaction(
        chat.messages,
        KEEP_RECENT_MESSAGES
      );

      if (evicted.length > 0) {
        console.log(`[Memory] Context reached ${estimatedTokens} tokens (limit ${effectiveLimit}). Deep-archiving history...`);
        publishUiSyncEvent({
          topic: "chat",
          chatId: options.chatId,
          projectId: options.projectId ?? null,
          reason: "[System] Context was compacted to keep the conversation responsive — older messages were archived to memory and remain searchable.",
        });

        const memorySubdir = options.projectId ? `${options.projectId}` : "main";
        const archivedAt = new Date().toISOString();

        // (1) Verbatim archive — exact strings survive compaction unparaphrased.
        try {
          await insertMemory(
            `Archived Chat History (verbatim) [${archivedAt}]:\n${formatVerbatimArchive(evicted)}`,
            AUTO_ARCHIVE_AREA,
            memorySubdir,
            settings,
            // PM #85 — stamp the owning chat so deep-recall can chat-scope this
            // raw history and not leak it into unrelated chats sharing the pool.
            { chatId: options.chatId },
            options.abortSignal
          );
        } catch (err) {
          console.error(`[Memory] Failed to vector-archive verbatim history:`, err);
        }

        // (2) Dense summary — narrative continuity. GATED (audit fix #3): the
        // summary is an extra LLM call (compressChatHistory) + a second embed.
        // For a SMALL eviction the verbatim copy above already IS the summary,
        // so we skip it — a small-window model (Ollama 4096) compacts often and
        // shouldn't pay an LLM round-trip + duplicate RAG record each time. Only
        // a substantial tail (where a dense paraphrase actually compresses many
        // messages) earns the summary. Paraphrase is acceptable ONLY because the
        // verbatim copy is the source of truth for exact text.
        const evictedTokens = estimateTokenCount(convertChatMessagesToModelMessages(evicted));
        if (shouldSummarizeEviction(evictedTokens)) {
          const summary = await compressChatHistory(evicted, settings, options.projectId, options.abortSignal);
          try {
            await insertMemory(
              `Archived Chat History (summary) [${archivedAt}]:\n${summary}`,
              AUTO_ARCHIVE_AREA,
              memorySubdir,
              settings,
              { chatId: options.chatId }, // PM #85 — chat-scope (see verbatim insert)
              options.abortSignal
            );
            console.log(`[Memory] History successfully vector-archived (verbatim + summary).`);
          } catch (err) {
            console.error(`[Memory] Failed to vector-archive history summary:`, err);
          }
        } else {
          console.log(`[Memory] History vector-archived (verbatim only — evicted ${evictedTokens} tokens below summary threshold).`);
        }

        // Live context = anchors + recent window, both kept VERBATIM.
        const updated = await updateChat(options.chatId, (c) => {
          c.messages = [...anchors, ...recent];
          return c;
        });
        if (updated) chat = updated;
      }
    }

    const allMessages = neutralizeHallucinatedHistory(
      convertChatMessagesToModelMessages(chat.messages)
    );
    const history = new History(80);
    history.addMany(allMessages);
    context.history = history.getAll();
    console.log(`[Memory] Agent context loaded: ${context.history.length} messages (from ${chat.messages.length} stored).`);
  }

  // Build tools: base + optional MCP tools from project .meta/mcp, always
  // wrapped in the loop guard (assembleAgentToolSet — CLAUDE.md §4/§10).
  const orchestratorNodeId = options.chatId;
  const dagContext = options.swarmEnabled !== false
    ? { chatId: options.chatId, parentNodeId: orchestratorNodeId }
    : undefined;
  const { tools, mcpCleanup, mcpDocs } = await assembleAgentToolSet(context, settings, {
    mcpDocsLimit: contextWindow,
    guardContext: dagContext,
  });

  // Inject Swarm P2P call_agent tool if swarm is enabled
  if (options.swarmEnabled !== false) {
    // ── Swarm Reset: Clear stale UI nodes from previous turns ──────────
    publishUiSyncEvent({
      topic: "chat",
      chatId: options.chatId,
      projectId: options.projectId ?? null,
      reason: "swarm_reset",
    });

    // DAG: publish orchestrator node
    publishUiSyncEvent({
      topic: "chat",
      chatId: options.chatId,
      nodeType: "agent_node",
      swarmNode: {
        nodeId: orchestratorNodeId,
        role: "orchestrator",
        taskSummary: options.userMessage.slice(0, 120),
        status: "running",
        startedAt: new Date().toISOString(),
      },
    });

    tools.call_agent = createCallAgentTool((role, desc, extra) => {
      publishUiSyncEvent({
        topic: "chat",
        chatId: options.chatId,
        projectId: options.projectId ?? null,
        reason: `[Swarm] Queued delegation for specialized agent "${role}" (Waiting for GPU...)`,
        nodeType: "agent_node",
        swarmNode: {
          nodeId: crypto.randomUUID(),
          parentNodeId: orchestratorNodeId,
          role,
          taskSummary: desc.slice(0, 120),
          status: "queued",
        },
      });

      return agentSemaphore.run(() =>
        runSubAgent(role, desc, extra, context, settings, providerOptions, model, options.abortSignal)
      );
    });
  }

  const toolNames = Object.keys(tools);

  // Build system prompt
  let systemPrompt = await buildSystemPrompt({
    projectId: options.projectId,
    chatId: options.chatId,
    agentNumber: options.agentNumber,
    tools: toolNames,
  });

  if (mcpDocs) systemPrompt += mcpDocs;

  // Phase 3: "Deep Memory" System Prompt Injection
  try {
    const memorySubdir = options.projectId ? `${options.projectId}` : "main";
      const similarityThreshold = settings.memory?.similarityThreshold ?? 0.7;
      const deepRecallLimit = 3;
      // PM #85 — fetch a WIDER candidate set, then chat-scope auto-archived raw
      // history (drop other chats' archives) before capping to the injection
      // budget, so a relevant own-chat / curated hit isn't crowded out of the
      // top-N by a foreign archive that is about to be filtered away.
      const ragCandidates = await searchMemory(options.userMessage, deepRecallLimit * 4, similarityThreshold, memorySubdir, settings, undefined, options.abortSignal);
      const ragResults = filterDeepRecall(ragCandidates, options.chatId, deepRecallLimit);

      if (ragResults && ragResults.length > 0) {
        // PM #94-follow-up — BOUND the passive recall injection. deepRecallLimit
        // caps the chunk COUNT (3) but each chunk's text is unbounded, and
        // auto-archived VERBATIM history chunks (PM #85) run tens of thousands of
        // tokens; as a chat ages this injected 82K+ tokens into EVERY turn's system
        // prompt (measured live), blowing the model's window and
        // mode-collapsing it. buildBoundedRecallBlock caps per-chunk (head+tail) +
        // total so recall stays a continuity aid, not a context bomb; full verbatim
        // is still reachable via an explicit memory search. PM #95 — the budget is
        // WINDOW-RELATIVE (a fraction of the model's reliable window) so a
        // big-window model (Claude 200K / Gemini 1M) carries richer recall inline
        // instead of being pinned to the small-window char cap.
        const recallBudget = resolveRecallBudgetChars(
          effectiveContextWindow(contextWindow, resolvedModelConfig)
        );
        const ragFormatted = buildBoundedRecallBlock(
          ragResults,
          recallBudget.perChunkChars,
          recallBudget.totalChars
        );
        systemPrompt += `\n\n<deep_memory_recall>\nYou have subconscious access to past archived conversations and vectors matching the user's current query. Use this to maintain perfect context continuity:\n\n${ragFormatted}\n</deep_memory_recall>`;
        console.log(`[RAG] Deep Memory Recall injected (${ragResults.length} chunks, ${ragFormatted.length} chars after cap).`);
      }
    } catch (err) {
      console.warn(`[RAG] Failed to extract deep memory:`, err);
    }

  // Append user message to history.
  // mergeConsecutiveSameRole prevents POST_MORTEM #2 (Gemma 4 / strict-role
  // providers reject consecutive same-role messages — easy to trigger by a
  // double Send before the assistant has replied).
  const messages: ModelMessage[] = mergeConsecutiveSameRole([
    ...context.history,
    { role: "user", content: options.userMessage },
  ]);

  // ── MoA Ensemble: Collective Intelligence Layer ───────────────────────
  // The UI toggle (`swarmEnabled`) is the single source of truth here.
  // When the user enabled Swarm, we ALWAYS run the MoA flow — the Router
  // inside `runMoAEnsemble` decides whether to actually spin up 3–5 expert
  // proposers (`requiresSwarm: true`) or do a direct single-model answer
  // (`requiresSwarm: false`) based on the prompt complexity.
  //
  // Historical note: an earlier `queryNeedsMoA` regex acted as a second gate
  // here and silently overrode the UI for messages whose verbs weren't on a
  // hard-coded list ("ищи", "нашёл", "сделай", "помоги" — all rejected). It
  // defied the explicit user intent expressed by the toggle. Removed in the
  // 2026-05 fix tracked as PM #9. Routing decisions belong to the Router,
  // not to a brittle regex on the entry path.
  // PM #36 — track every LLM call's usage so the soft budget banner reflects
  // total tokens + cost across MoA + main stream. The MoA bundle bubbles up
  // its own running sum via `moaResult.cumulativeUsage`; we hold it here and
  // merge it with the streamText `onFinish` usage at save time.
  let turnExtraUsage: import("@/lib/types").ChatUsage | undefined = undefined;
  // Sprint 2 — set on the collapsed synthesis path (MoA handed drafts up instead
  // of a finished consensus). When present, this final stream IS the synthesizer;
  // the trace-memory capture relocates to onFinish, scored against the streamed
  // synthesis text using the signals plumbed up here.
  let synthesisHandoffForCapture: MoAResult["synthesisHandoff"] | undefined =
    undefined;

  if (options.swarmEnabled !== false) {
    try {
      console.log(`[MoA] Ensemble mode active — running parallel expert consultation...`);
      const moaResult = await runMoAEnsemble({
        chatId: options.chatId,
        userMessage: options.userMessage,
        projectId: options.projectId,
        currentPath: options.currentPath,
        preset: options.preset,
        history: context.history,
        settings,
        abortSignal: options.abortSignal,
        forceSwarm: options.forceSwarm,
        skepticModelOverride: options.skepticModelOverride,
        deepAudit: options.deepAudit,
        degradationPolicy: options.degradationPolicy,
        background: options.isBackground,
      });
      turnExtraUsage = moaResult.cumulativeUsage;

      // The ensemble's output is ADVISORY context for the final stream below,
      // never the terminal answer (the streamText further down always runs and
      // re-answers). Inject a consensus ONLY when the ensemble actually
      // produced one from real drafts. A `bypassed` result (Router judged the
      // prompt trivial) carries no consensus — the single-agent stream answers
      // it directly. The `drafts.length > 0` guard also stops the old latent
      // bug of injecting a "0 expert agents" consensus from the bypass path.
      if (moaResult.synthesisHandoff) {
        // Sprint 2 — COLLAPSED synthesis path (docs/moa-aggregator-collapse.md).
        // The aggregator generateText did NOT run; the ensemble handed the
        // proposer drafts UP. Inject them + the ported synthesis directive +
        // the PM #39 disagreement marker into the system prompt so THIS final
        // tool-capable stream synthesizes them inline — one brain generation.
        // Trace capture relocates to onFinish (the synthesized text only exists
        // once the stream finishes); we stash the handoff for it here.
        const handoff = moaResult.synthesisHandoff;
        const directive = await loadSynthesisInlineDirective();
        systemPrompt += buildInlineSynthesisInjection(
          directive,
          handoff.drafts,
          handoff.disagreementMarker
        );
        synthesisHandoffForCapture = handoff;
        console.log(
          `[MoA] Inline synthesis: injected ${handoff.drafts.length} expert drafts into the final stream's system prompt → 1 brain generation this turn.`
        );
      } else if (
        !moaResult.bypassed &&
        moaResult.drafts.length > 0 &&
        moaResult.text &&
        !moaResult.text.startsWith("All MoA proposer agents failed")
      ) {
        const truncatedConsensus = moaResult.text.length > 5000
          ? moaResult.text.substring(0, 5000) + "\n\n...[TRUNCATED FOR CONTEXT LIMITS]..."
          : moaResult.text;

        systemPrompt += `\n\n## Expert Consensus (MoA)
You have access to a pre-computed consensus from ${moaResult.drafts.length} expert agents who analyzed this request in parallel.
Use this as high-quality reference material. You may adopt, modify, or override their recommendations based on your own judgment and tool results.

<expert_consensus>
${truncatedConsensus}
</expert_consensus>

Total MoA latency: ${moaResult.totalLatencyMs}ms (proposers: ${moaResult.drafts.map(d => `${d.proposerId}=${d.latencyMs}ms`).join(', ')}; aggregation: ${moaResult.aggregationLatencyMs}ms)`;

        // Measurement (Sprint 1 — quantifies the Sprint 2 double-generation
        // target): the swarm path ran an aggregator generation AND a final
        // stream follows below. This line makes the "two generations per swarm
        // turn" visible in logs for before/after comparison.
        console.log(`[MoA] Consensus injected (${truncatedConsensus.length} chars, ${moaResult.totalLatencyMs}ms total). A final tool-capable stream follows → 2 brain generations this turn (aggregator + stream).`);
      } else if (moaResult.degradedToSingleAgent) {
        // Every proposer failed → the swarm produced no consensus and the
        // stream below answers as a plain single agent WITHOUT the Skeptic
        // audit. This is UNINTENDED (distinct from a Router bypass), and was
        // previously silent — the operator saw a normal answer with no hint
        // the swarm collapsed. Surface it like the sibling crash branch so a
        // degraded turn is visibly degraded. Root cause is almost always
        // unreliable proposer models (free-tier 429s — CLAUDE.md §1).
        console.warn(
          `[MoA] Swarm degraded: 0/${moaResult.drafts.length} proposers produced a usable draft — answering with a single agent, NO Skeptic audit this turn. Check proposer model reliability (free-tier models 429 under parallel load).`
        );
        publishUiSyncEvent({
          topic: "chat",
          chatId: options.chatId,
          projectId: options.projectId ?? null,
          reason: `[MoA] Swarm stopped: all ${moaResult.drafts.length} expert proposers failed. This answer is from a single agent with no Skeptic audit. Likely cause: unreliable proposer models (e.g. free-tier rate limits).`,
        });
      } else if (moaResult.bypassed) {
        console.log(`[MoA] Bypassed — single-agent stream answers directly (no consensus, no redundant pre-generation).`);
      }
    } catch (err) {
      console.warn(`[MoA] Ensemble failed, continuing with single-agent mode:`, err);
      // Tell the UI that the Swarm toggle was honored but the ensemble
      // crashed — without this event the user sees a single-agent answer
      // and assumes Swarm just decided to skip. This is observability for
      // a silent fallback path that was previously invisible.
      publishUiSyncEvent({
        topic: "chat",
        chatId: options.chatId,
        projectId: options.projectId ?? null,
        reason: `[MoA] Ensemble failed (${err instanceof Error ? err.message : "unknown error"}); continuing with single-agent mode.`,
      });
    }
  }

  logLLMRequest({
    model: `${settings.chatModel.provider}/${settings.chatModel.model}`,
    system: systemPrompt,
    messages,
    toolNames,
    temperature: settings.chatModel.temperature,
    maxTokens: settings.chatModel.maxTokens,
    label: "LLM Request (stream)",
  });

  // ── Tool Capability Detection ─────────────────────────────────────────
  // Some models (deepseek-r1, gemma3, phi4, etc.) don't support tool calling.
  // Detect this and fall back to plain chat mode gracefully. Full rationale
  // (PM #17, the Ollama probe, why it is not in `tool-support.ts`) lives in
  // `agent-tool-capability.ts`.
  const useTools = await detectToolSupport(resolvedModelConfig);
  const effectiveTools = useTools ? tools : {};

  if (!useTools) {
    console.log(`[Agent] ⚠ Model "${resolvedModelConfig.model}" does not support tools → running in plain chat mode`);
    // PM #61 — the system prompt is built for TOOL mode (it mandates the
    // `response` tool, describes tool usage, goal trees, self-healing loops).
    // In plain-chat mode NO tools are forwarded, but the model still receives
    // that prompt. Tool-trained models (e.g. google/gemma-4-31b-it) then emit
    // literal `<call:tool .../>` text instead of an answer — which Orchestra
    // has no parser for, so it ships to the chat as garbage and the user sees
    // "no answer". Override the tool mandate so the model replies in prose.
    systemPrompt += PLAIN_CHAT_TOOL_OVERRIDE;
  } else {
    console.log(`[Agent] Tools enabled: ${Object.keys(tools).length} tools registered`);
  }

  try {
    // Sprint A3 — in-flight token governor. Reuses the window resolved above
    // (preResolvedWindow) so the interactive path adds no extra Ollama probe.
    const tokenGovernor = await buildTokenGovernor(
      resolvedModelConfig,
      resolveMaxOutputTokens(settings.chatModel),
      options.abortSignal,
      contextWindow,
      systemPrompt // Layer 0 — subtract the system-prompt size from the msg budget
    );
    // PM #98 — the only time bound on this call. `options.abortSignal` covers a
    // user pressing cancel; nothing covered a provider that accepts the
    // connection and then goes silent. Full rationale, and why this is NOT a
    // total-duration cap, in `stream-watchdog.ts`.
    const watchdog = createStreamWatchdog(options.abortSignal, {
      label: `${resolvedModelConfig.provider}/${resolvedModelConfig.model}`,
    });
    // PM #98 — `onAbort`'s `steps` holds only COMPLETED steps, so the text the
    // user was actually watching is never in it. Buffer the deltas instead.
    const partialText = createPartialTextBuffer();
    // Run the agent with streaming
    const result = streamText({
    model,
    system: systemPrompt,
    messages,
    providerOptions,
    tools: effectiveTools,
    maxRetries: 3,
    prepareStep: tokenGovernor,
    ...(useTools
      ? {
          // PM #65 — AI SDK v5 removed `maxSteps` from streamText; it was a
          // silently-ignored no-op here. The tool loop is bounded by `stopWhen`.
          stopWhen: [stepCountIs(MAX_TOOL_STEPS_PER_TURN), hasToolCall("response"), loopAbortStop]
        }
      : {}),
    temperature: settings.chatModel.temperature ?? 0.7,
    maxOutputTokens: resolveMaxOutputTokens(settings.chatModel),
    abortSignal: watchdog.signal,
    onChunk: ({ chunk }) => {
      // A tool call means execution — which emits no chunks and carries its own
      // timeout (up to 10 minutes for `install-orchestrator`) — is about to
      // start. Counting that silence as a stall would abort healthy work.
      if (chunk.type === "tool-call") watchdog.pauseForToolExecution();
      else watchdog.noteActivity();
      if (chunk.type === "text-delta") partialText.append(chunk.text);
    },
    onStepFinish: async (event) => {
      // Each step opens a FRESH upstream request, which can hang exactly like
      // the first one did — so the time-to-first-token bound is re-armed here,
      // not just once at the top of the turn.
      watchdog.noteStepBoundary();
      // PM #81 — incremental billing. If a multi-step loop crashes on step 3
      // (e.g. Rate Limit or Context Exceeded), `onFinish` might not fire or
      // might drop usage. We accumulate per-step to ensure actual spend is
      // always captured.
      const stepUsage = event.usage;
      if (stepUsage) {
        try {
          await updateChat(options.chatId, (chat) => {
            chat.cumulativeUsage = foldTurnUsage(
              chat.cumulativeUsage,
              resolvedModelConfig.provider,
              resolvedModelConfig.model,
              { streamUsage: stepUsage }
            );
            return chat;
          });
        } catch (err) {
          console.error("[Agent] Failed to persist step usage:", err);
        }
      }

      // ── Swarm Activity: surface the MAIN stream's per-step tool calls ──────
      // Under the inline-synthesis collapse (default), the ensemble hands off and
      // the REAL work — the whole multi-step tool loop (write_text_file,
      // code_execution, update_task_status, …), often 30-40 steps over many
      // minutes — happens in THIS stream. It previously emitted NOTHING to the
      // UI, so the Swarm Activity panel showed only the (already-green) router /
      // proposer / aggregator nodes and looked "done" while the brain worked
      // invisibly. Emit one activity line per executed tool call so the operator
      // sees the live course of actions in the Deep Audit terminal. Gated to the
      // swarm path (the panel only renders when `swarmEnabled`); fully try/caught
      // so a telemetry emit can never break the run.
      if (options.swarmEnabled !== false) {
        try {
          const stepToolCalls = (event as unknown as {
            toolCalls?: Array<{ toolName?: string; input?: unknown; args?: unknown }>;
          }).toolCalls;
          for (const call of stepToolCalls ?? []) {
            const toolName = call.toolName ?? "tool";
            publishUiSyncEvent({
              topic: "chat",
              chatId: options.chatId,
              projectId: options.projectId ?? null,
              reason: `[Agent] ${toolName}${summarizeToolArgs(call.input ?? call.args)}`,
            });
          }
        } catch (activityErr) {
          console.warn("[Agent] step-activity emit error (non-fatal):", activityErr);
        }
      }
    },
    onFinish: async (event) => {
      // The stream is over — stop the clock before any of the persistence work
      // below, which can legitimately take longer than the idle budget.
      watchdog.settle();
      // ── Guaranteed DAG completion — even if this callback itself throws ──
      // This is the single source of truth for "agent turn done". All paths
      // (normal finish, tool-call finish, length truncation) converge here.
      let dagFinalized = false;
      const finalizeDag = (status: "completed" | "error") => {
        if (dagFinalized) return;
        dagFinalized = true;
        publishOrchestratorFinished(
          options.chatId,
          options.projectId,
          status,
          status === "completed" ? "agent_turn_finished" : "agent_turn_error"
        );
        publishUiSyncEvent({
          topic: "files",
          projectId: options.projectId ?? null,
          reason: "agent_turn_finished",
        });
      };

      try {
        const finishReason =
          typeof (event as unknown as { finishReason?: unknown }).finishReason === "string"
            ? ((event as unknown as { finishReason?: string }).finishReason as string)
            : undefined;

        // Did this turn END because it exhausted the per-turn step cap (vs
        // finishing)? streamText's onFinish exposes the full `steps` array;
        // reaching the cap with no delivered answer drives the deterministic
        // "press Continue" pause notice (resolveTurnContinuation) instead of a
        // forced completion summary that masquerades as "done".
        const stepCount = Array.isArray((event as unknown as { steps?: unknown[] }).steps)
          ? (event as unknown as { steps: unknown[] }).steps.length
          : undefined;
        const stepLimitReached =
          stepCount !== undefined && stepCount >= MAX_TOOL_STEPS_PER_TURN;

        // Loop-abort (2026-07-28): did the turn stop EARLY because the model was
        // stuck repeating an identical blocked call? Re-derive the same signal
        // the `loopAbortStop` stopWhen used, from the final steps, so the pause
        // notice can distinguish "stuck in a loop" from "hit the 50-step cap".
        const loopAbortReached =
          Array.isArray((event as unknown as { steps?: unknown[] }).steps) &&
          countTrailingLoopBlockSteps(
            (event as unknown as {
              steps: ReadonlyArray<{ toolResults?: ReadonlyArray<{ output?: unknown }> }>;
            }).steps
          ) >= LOOP_ABORT_CONSECUTIVE;

        const rawResponseMessages = event.response.messages;

        // PM #81 Sprint 2 — action-tool hallucination self-heal. A degraded model
        // (qwen3-coder under long context) PRINTS a tool call as raw text instead
        // of calling it natively; Orchestra never executed it and shipped XML to
        // the user. Re-prompt WITH tools so the model re-issues the call for real,
        // and SUPPRESS the raw markup so the user never sees it. Bounded by a
        // chat-scoped retry budget (circuit breaker). Skipped at a step-cap pause
        // and in plain-chat mode (no tools to re-issue with).
        const hallucinatedCall =
          useTools && !stepLimitReached
            ? detectActionHallucination(rawResponseMessages)
            : null;
        let reissueUsage: import("@/lib/cost/accumulator").RawUsage | undefined;
        let reissueMessages: ModelMessage[] = [];
        if (hallucinatedCall) {
          // PM #82 — printing a tool call as text is the degradation symptom.
          // Flag the chat so its NEXT pre-flight pass compacts aggressively and
          // escapes the long-context loop (behavior-triggered backstop).
          recordChatDegradation(options.chatId);
          const budget = recordReissueAttempt(options.chatId);
          console.warn(
            `[Agent] PM #81 — model printed "${hallucinatedCall.name}" as text instead of ` +
              `calling it (re-issue attempt ${budget.count}, allowed=${budget.allowed}).`
          );
          if (budget.allowed) {
            const reissue = await attemptToolReissue({
              model,
              systemPrompt,
              baseMessages: messages,
              priorMessages: rawResponseMessages,
              tools: effectiveTools,
              providerOptions,
              prepareStep: tokenGovernor,
              settings,
              abortSignal: options.abortSignal,
            });
            if (reissue) {
              reissueMessages = reissue.responseMessages;
              reissueUsage = reissue.usage;
              resetReissueBudget(options.chatId); // delivered → reset for later turns
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
            finishReason,
            useTools,
            // A loop-abort is a STOP REASON, not a dropped native call — treat it
            // like the step-cap so the dropped-call re-issue never fires on it.
            stepLimitReached: stepLimitReached || loopAbortReached,
            hallucinated: hallucinatedCall !== null,
            responseMessages: rawResponseMessages,
          })
        ) {
          const budget = recordReissueAttempt(options.chatId);
          console.warn(
            `[Agent] Layer 2 (PM #97) — native tool-call DROP detected ` +
              `(finishReason=tool-calls, no tool call parsed, no answer; likely an ` +
              `intermittent provider drop). Re-issue attempt ${budget.count}, allowed=${budget.allowed}.`
          );
          if (budget.allowed) {
            const reissue = await attemptToolReissue({
              model,
              systemPrompt,
              baseMessages: messages,
              priorMessages: rawResponseMessages,
              tools: effectiveTools,
              providerOptions,
              prepareStep: tokenGovernor,
              settings,
              abortSignal: options.abortSignal,
              correction: DROP_REISSUE_CORRECTION,
            });
            if (reissue) {
              reissueMessages = reissue.responseMessages;
              reissueUsage = reissue.usage;
              dropReissued = true;
              resetReissueBudget(options.chatId); // delivered → reset for later turns
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

        // PM #36 (truncation continuation) + PM #69 (forced final answer) +
        // step-cap pause are all decided by resolveTurnContinuation —
        // self-contained and unit-tested (final-answer-guard.test.ts). We publish
        // any non-fatal operator notice it returns and bill its usage alongside
        // streamUsage. A delivered re-issue makes responseMessages deliverable, so
        // this is a no-op then; a FAILED re-issue (markup stripped, nothing added)
        // is non-deliverable → it forces a plain final answer (the Sprint 1 path).
        const turnExtra = await resolveTurnContinuation({
          loopAbortReached,
          responseMessages,
          finishReason,
          model,
          systemPrompt,
          baseMessages: messages,
          providerOptions,
          settings,
          stepLimitReached,
          abortSignal: options.abortSignal,
          // Free-tier track Sprint 3 — the endpoint identity the forced
          // final-answer path needs to track health against and to substitute
          // away from when it delivers nothing.
          brainConfig: resolvedModelConfig,
          projectId: options.projectId,
          currentPath: options.currentPath,
          degradationPolicy: resolveDegradationPolicy(
            settings,
            options.degradationPolicy,
            { background: options.isBackground }
          ),
        });
        const continuationText = turnExtra.text;
        const continuationUsage = turnExtra.usage;
        if (turnExtra.uiNotice) {
          publishUiSyncEvent({
            topic: "chat",
            chatId: options.chatId,
            projectId: options.projectId ?? null,
            reason: turnExtra.uiNotice,
          });
        }

        // PM #84 — premature-completion visibility note. When the model delivered
        // a `response` answer this turn while the LAST whitelisted verification it
        // ran (tsc/test/build/lint) exited non-zero, surface a deterministic
        // operator note. ADVISORY only — never blocks the answer; false-negative-
        // biased (narrow whitelist, fires only on a delivered answer). The
        // behavioural lever is system.md hard_constraint #6; this is the backstop.
        if (useTools) {
          const prematureNotice = detectPrematureCompletion(responseMessages);
          if (prematureNotice) {
            console.warn(`[Agent] PM #84 — ${prematureNotice}`);
            publishUiSyncEvent({
              topic: "chat",
              chatId: options.chatId,
              projectId: options.projectId ?? null,
              reason: prematureNotice,
            });
          }
        }

        if (mcpCleanup) {
          try { await mcpCleanup(); } catch { /* non-critical */ }
        }

        // PM #36 / PM #81 — main stream usage is now tracked incrementally via
        // `onStepFinish` to prevent dropped billing on crashes. We no longer
        // extract it here to avoid double-counting.

        try {
          await updateChat(options.chatId, (chat) => {
            const now = new Date().toISOString();
            for (const msg of responseMessages) {
              chat.messages.push(...convertModelMessageToChatMessages(msg, now));
            }
            if (continuationText) {
              chat.messages.push({
                id: crypto.randomUUID(),
                role: "assistant",
                content: stripThinkingTags(continuationText),
                createdAt: now,
              });
            } else if (turnExtra.uiNotice) {
              chat.messages.push({
                id: crypto.randomUUID(),
                role: "assistant",
                content: `> ⚠️ **Notice:** ${turnExtra.uiNotice}\n\n*The stream was interrupted before a final text response could be generated.*`,
                createdAt: now,
              });
            }
            chat.updatedAt = now;
            const userMessageCount = chat.messages.filter(m => m.role === "user").length;
            if (userMessageCount === 1 && chat.title === "New Chat") {
              chat.title =
                options.userMessage.slice(0, 60) +
                (options.userMessage.length > 60 ? "..." : "");
            }
            // PM #36 — fold ALL of this turn's billing surfaces (main stream
            // + auto-continuation + MoA bundle + PM #81 re-issue) into the
            // running per-chat cumulative via the single accounting helper.
            // Resolved chat-model identity comes from `resolvedModelConfig`; the
            // continuation/re-issue reuse the same model handle, so the pricing
            // lookup is unambiguous.
            chat.cumulativeUsage = foldTurnUsage(
              chat.cumulativeUsage,
              resolvedModelConfig.provider,
              resolvedModelConfig.model,
              { continuationUsage, reissueUsage, turnExtraUsage }
            );
            return chat;
          });
        } catch (saveErr) {
          console.error("[Agent] Failed to save chat after turn:", saveErr);
          // Non-critical: don't block DAG finalization
        }

        // Sprint 2 — relocated trace-memory capture for the COLLAPSED synthesis
        // path. On the normal path MoA captures the trace itself (it has the
        // aggregator's finalText); collapsed, the synthesized text is THIS
        // stream's output, so capture moves here. Best-effort + fire-and-forget
        // (mirrors MoA's own capture): never blocks DAG finalization. The
        // PM #61 unwrap makes a serialized `response`-tool answer record as
        // prose rather than a JSON blob.
        if (synthesisHandoffForCapture) {
          const synthesizedText =
            unwrapSerializedResponseCall(
              getLastAssistantText(responseMessages)
            ).trim() || (continuationText ?? "").trim();
          if (synthesizedText) {
            void captureSuccessfulTrace({
              userPrompt: options.userMessage,
              finalText: synthesizedText,
              signals: synthesisHandoffForCapture.signals,
              // The stream's model IS the synthesizer on this path — more
              // accurate attribution than MoA's brainConfig would be.
              brainConfig: resolvedModelConfig,
              settings,
              projectId: options.projectId,
            })
              .then((r) => {
                if (r.captured) {
                  console.log(
                    `[MoA] Trace memory: captured inline-synthesis trace ${r.traceId} (score ${r.qualityScore.toFixed(3)}).`
                  );
                }
              })
              .catch((err) => {
                console.warn(
                  "[MoA] Trace-memory capture (inline synthesis) failed (non-fatal):",
                  err instanceof Error ? err.message : err
                );
              });
          }
        }

        finalizeDag("completed");
      } catch (onFinishErr) {
        // onFinish itself crashed — still must finalize the DAG
        console.error("[Agent] onFinish error:", onFinishErr);
        finalizeDag("error");
      }
    },
    onAbort: async () => {
      // PM #98 — `ai@6` treats an abort as a CLEAN CLOSE: neither `onFinish`
      // nor `onError` fires, so without this the watchdog would only shorten
      // the silence from 640s to 90s. See `agent-abort.ts`.
      await handleStreamAbort(watchdog, partialText.text(), {
        chatId: options.chatId,
        projectId: options.projectId,
        model: `${resolvedModelConfig.provider}/${resolvedModelConfig.model}`,
        request: {
          userMessage: options.userMessage,
          swarmEnabled: options.swarmEnabled !== false,
          preset: options.preset,
          currentPath: options.currentPath,
        },
        settings,
      });
    },
    onError: ({ error }) => {
      watchdog.settle();
      // Called when the stream itself errors (network cut, provider timeout,
      // upstream 404, etc.) — fires even when SSE disconnects mid-stream, so we
      // guarantee DAG cleanup here. The classify → structured log → chat-error
      // SSE event → forensic postmortem plumbing is shared with the fatal catch
      // via reportTurnError (agent-stream.ts); PM #17 lives in that shared path.
      //
      // PM #17 — publish the structured error FIRST (synchronously, inside
      // reportTurnError), THEN kick off the background model-fallback. Fallback
      // is fire-and-forget and async, so its own `model_fallback` event always
      // lands AFTER the error event the UI must render immediately. We do NOT
      // retry the current turn (double LLM cost + complex stream replay).
      void reportTurnError(
        error,
        {
          chatId: options.chatId,
          projectId: options.projectId,
          request: {
            userMessage: options.userMessage,
            swarmEnabled: options.swarmEnabled !== false,
            preset: options.preset,
            currentPath: options.currentPath,
          },
          settings,
        },
        { logEvent: "agent_stream_error", awaitPostmortem: false }
      );
      void attemptModelFallback(error, settings, options.chatId, options.projectId);
      publishOrchestratorFinished(
        options.chatId,
        options.projectId,
        "error",
        "agent_stream_error"
      );
      publishUiSyncEvent({
        topic: "files",
        projectId: options.projectId ?? null,
        reason: "agent_turn_finished",
      });
    },
  });

  return result;

  } catch (error) {
    // PM #17 / Sprint 3 — same surface contract as the streamText `onError`
    // path (shared via reportTurnError): structured log + chat-error event +
    // forensic postmortem. Here the postmortem is AWAITED — we're inside a
    // regular try/catch and the await can't prevent the rethrow — then DAG
    // cleanup + rethrow so the route handler returns a non-200.
    await reportTurnError(
      error,
      {
        chatId: options.chatId,
        projectId: options.projectId,
        request: {
          userMessage: options.userMessage,
          swarmEnabled: options.swarmEnabled !== false,
          preset: options.preset,
          currentPath: options.currentPath,
        },
        settings,
      },
      { logEvent: "agent_fatal_error", awaitPostmortem: true }
    );

    if (mcpCleanup) {
      try { await mcpCleanup(); } catch { /* non-critical */ }
    }

    if (options.swarmEnabled !== false) {
      publishUiSyncEvent({
        topic: "chat",
        chatId: options.chatId,
        nodeType: "agent_node",
        swarmNode: {
          nodeId: options.chatId,
          role: "orchestrator",
          status: "error",
          taskSummary: `Fatal error: ${error instanceof Error ? error.message : String(error)}`,
          completedAt: new Date().toISOString(),
        },
      });
    }

    throw error;
  }
}

/**
 * Non-streaming agent turn for background tasks (cron/scheduler).
 */
export async function runAgentText(options: {
  chatId: string;
  userMessage: string;
  projectId?: string;
  currentPath?: string;
  agentNumber?: number;
  runtimeData?: Record<string, unknown>;
  /**
   * PM #23 follow-up — non-interactive entry path. Caller (cron runtime, the
   * Telegram-relay external-message handler, etc.) owns the lifetime of the
   * AbortController. Pass `undefined` for fire-and-forget background jobs.
   * The signal is plumbed straight into the inner `generateText` call so a
   * cancelled cron tick or a disconnected Telegram webhook actually stops
   * the upstream LLM stream instead of completing and silently billing.
   */
  abortSignal?: AbortSignal;
  /**
   * SECURITY (PM #92) — set `true` by the external-message handler (Telegram /
   * external-API relay) so RCE-class tools (code_execution / install_packages /
   * process) are withheld from a non-operator trigger. Cron leaves it undefined
   * (operator-scheduled = trusted). Threaded into the AgentContext and, from
   * there, into every tool-family gate + propagated to subordinate agents.
   */
  untrustedTrigger?: boolean;
}): Promise<string> {
  // Sprint 4 — settings + the Privacy-Mode air-gap in ONE atomic step. This is
  // the cron + Telegram-relay path (the webhook is unauthenticated); it must
  // NOT ship user data to a cloud model with Privacy Mode ON. PM #58 was this
  // exact guard, forgotten here.
  const settings = await resolveGuardedAgentSettings();
  const providerOptions = resolveModelProviderOptions(settings.chatModel.provider);
  const model = createModel(settings.chatModel, {
    projectId: options.projectId,
    currentPath: options.currentPath,
  });

  const workDir = await resolveWorkDirForProject(options.projectId);
  const context: AgentContext = {
    chatId: options.chatId,
    projectId: options.projectId,
    currentPath: options.currentPath,
    workDir,
    memorySubdir: options.projectId ? `${options.projectId}` : "main",
    knowledgeSubdirs: options.projectId ? [`${options.projectId}`, "main"] : ["main"],
    history: [],
    agentNumber: options.agentNumber ?? 0,
    untrustedTrigger: options.untrustedTrigger,
    data: {
      ...(options.runtimeData ?? {}),
      currentUserMessage: options.userMessage,
    },
  };

  const chat = await getChat(options.chatId);
  if (chat) {
    const allMessages = neutralizeHallucinatedHistory(
      convertChatMessagesToModelMessages(chat.messages)
    );
    const history = new History(80);
    history.addMany(allMessages);
    context.history = history.getAll();
  }

  const contextWindow = 4096; // Conservative default for dry run since model is unknown
  const { tools, mcpCleanup, mcpDocs } = await assembleAgentToolSet(context, settings, {
    mcpDocsLimit: contextWindow,
  });
  const toolNames = Object.keys(tools);

  let systemPrompt = await buildSystemPrompt({
    projectId: options.projectId,
    chatId: options.chatId,
    agentNumber: options.agentNumber,
    tools: toolNames,
  });

  if (mcpDocs) systemPrompt += mcpDocs;

  const messages: ModelMessage[] = mergeConsecutiveSameRole([
    ...context.history,
    { role: "user", content: options.userMessage },
  ]);

  logLLMRequest({
    model: `${settings.chatModel.provider}/${settings.chatModel.model}`,
    system: systemPrompt,
    messages,
    toolNames,
    temperature: settings.chatModel.temperature,
    maxTokens: settings.chatModel.maxTokens,
    label: "LLM Request (non-stream)",
  });

  try {
    const tokenGovernor = await buildTokenGovernor(
      settings.chatModel,
      resolveMaxOutputTokens(settings.chatModel),
      options.abortSignal,
      undefined,
      systemPrompt // Layer 0 — subtract the system-prompt size from the msg budget
    );
    const generated = await generateText({
      model,
      system: systemPrompt,
      messages,
      providerOptions,
      tools,
      maxRetries: 3,
      prepareStep: tokenGovernor,
      stopWhen: [stepCountIs(MAX_TOOL_STEPS_PER_TURN), hasToolCall("response"), loopAbortStop],
      temperature: settings.chatModel.temperature ?? 0.7,
      maxOutputTokens: resolveMaxOutputTokens(settings.chatModel),
      // PM #98 — cron + the unauthenticated Telegram webhook run here. A
      // hang has no user to notice it, so the bound matters MORE, not less.
      abortSignal: callDeadlineSignal(options.abortSignal),
    });

    const responseMessages = (
      generated as unknown as { response?: { messages?: ModelMessage[] } }
    ).response?.messages;

    const text = generated.text ?? "";
    const fallbackReply =
      Array.isArray(responseMessages) && responseMessages.length > 0
        ? getLastResponseToolText(responseMessages) || getLastAssistantText(responseMessages)
        : "";
    // PM #61 — runAgentText powers cron + the Telegram reply; unwrap a
    // serialized `response` call so those channels never ship a raw JSON blob.
    const finalText = unwrapSerializedResponseCall(text.trim() ? text : fallbackReply);

    try {
      await updateChat(options.chatId, (latest) => {
        const now = new Date().toISOString();
        latest.messages.push({
          id: crypto.randomUUID(),
          role: "user",
          content: options.userMessage,
          createdAt: now,
        });

        if (Array.isArray(responseMessages) && responseMessages.length > 0) {
          for (const msg of responseMessages) {
            latest.messages.push(...convertModelMessageToChatMessages(msg, now));
          }
        } else {
          latest.messages.push({
            id: crypto.randomUUID(),
            role: "assistant",
            content: stripThinkingTags(finalText),
            createdAt: now,
          });
        }

        latest.updatedAt = now;
        return latest;
      });
    } catch {
      // Non-critical for background runs.
    }

    publishUiSyncEvent({
      topic: "files",
      projectId: options.projectId ?? null,
      reason: "agent_turn_finished",
    });

    return finalText;
  } finally {
    if (mcpCleanup) {
      try {
        await mcpCleanup();
      } catch {
        // non-critical
      }
    }
  }
}

/**
 * Run agent for subordinate delegation (non-streaming, returns result)
 */
export interface SubordinateResult {
  /** The trimmed text response to surface back to the parent agent. */
  text: string;
  /**
   * Sprint 8 — billing-correctness fix. Pre-Sprint-8 the subordinate's
   * generateText `usage` was THROWN AWAY, so subordinate token spend
   * never reached `parent.cumulativeUsage` and the per-chat USD cap was
   * blind to it. Returning it here lets `callSubordinate` accumulate
   * the spend back into the parent chat via `addUsageToCumulative`.
   *
   * `undefined` only on the rare path where `generateText` doesn't
   * surface a usage object (e.g. provider didn't include it).
   */
  usage?: import("@/lib/cost/accumulator").RawUsage;
  /**
   * Resolved model identity (provider + model) for the subordinate's
   * generateText call. Needed by the accumulator to look up per-token
   * pricing — different providers price the same token count differently.
   */
  provider: string;
  model: string;
}

export async function runSubordinateAgent(options: {
  task: string;
  projectId?: string;
  parentAgentNumber: number;
  parentHistory: ModelMessage[];
  /**
   * PM #23 — the parent agent's `req.signal`, plumbed through the
   * `call_subordinate` tool. When the user cancels the parent chat, the
   * subordinate's inner generateText call must abort too — otherwise the
   * subordinate keeps streaming tokens while no one's listening.
   */
  abortSignal?: AbortSignal;
  /**
   * Sprint 9 — the REAL parent chat id (top-level chat that originated
   * the agent run). Required for the recursive-subordinate path:
   *   - level 0 (top): runs in `context.chatId = realChatId`
   *   - level 1 (subordinate): if absent here, used to construct a
   *     synthetic `subordinate-${Date.now()}` for context.chatId →
   *     budget-check + spend bubble-up would target a phantom chat
   *     that doesn't exist on disk → `updateChat` silent no-op
   *     → REAL parent's `cumulativeUsage` never sees the spend.
   *   - level 2 (subordinate of subordinate): same problem, doubly so.
   *
   * Sprint 8 closed the LEVEL-1 leak by accumulating in
   * `callSubordinate`. Sprint 9 closes the LEVEL-2+ leak by propagating
   * the real parent id ALL THE WAY DOWN. Now every level's
   * `enforceChatBudget` + spend bubble-up targets the same real chat.
   *
   * Backwards-compat: optional + falls back to the synthetic id (the
   * pre-Sprint-9 behavior). Production callers (`callSubordinate`)
   * always pass it now.
   */
  parentChatId?: string;
  /**
   * SECURITY (PM #92) — the parent run's untrusted-trigger flag, propagated by
   * `call_subordinate`. Without this, an untrusted external run (denied
   * code_execution at level 0) could launder RCE by spawning a subordinate that
   * rebuilds its own toolset and gets the host-shell tools back. Propagate it.
   */
  untrustedTrigger?: boolean;
}): Promise<SubordinateResult> {
  // Sprint 4 — settings + the Privacy-Mode air-gap in ONE atomic step
  // (defense in depth: the recursive path and any future direct caller must
  // not reach a cloud provider with Privacy Mode ON). PM #58.
  const settings = await resolveGuardedAgentSettings();
  const providerOptions = resolveModelProviderOptions(settings.chatModel.provider);
  const model = createModel(settings.chatModel, {
    projectId: options.projectId,
  });

  const workDir = await resolveWorkDirForProject(options.projectId);
  const context: AgentContext = {
    // Sprint 9 — use the REAL parent chat id so deeper-level recursive
    // subordinates also see the real chat for budget + bubble-up.
    // Fallback synthetic id retained for the unusual case of a caller
    // that doesn't pass parentChatId (no production caller; defensive).
    chatId: options.parentChatId ?? `subordinate-${Date.now()}`,
    projectId: options.projectId,
    workDir,
    memorySubdir: options.projectId
      ? `projects/${options.projectId}`
      : "main",
    knowledgeSubdirs: options.projectId
      ? [`projects/${options.projectId}`, "main"]
      : ["main"],
    history: [],
    agentNumber: options.parentAgentNumber + 1,
    untrustedTrigger: options.untrustedTrigger,
    data: {},
  };

  const { tools, mcpCleanup: mcpCleanupSub } = await assembleAgentToolSet(context, settings);
  const toolNames = Object.keys(tools);

  const systemPrompt = await buildSystemPrompt({
    projectId: options.projectId,
    agentNumber: context.agentNumber,
    tools: toolNames,
  });

  // Include relevant parent history for context
  const relevantHistory = options.parentHistory.slice(-6);

  const messages: ModelMessage[] = mergeConsecutiveSameRole([
    ...relevantHistory,
    {
      role: "user",
      content: `You are a subordinate agent. Complete this task and report back:\n\n${options.task}`,
    },
  ]);

  logLLMRequest({
    model: `${settings.chatModel.provider}/${settings.chatModel.model}`,
    system: systemPrompt,
    messages,
    toolNames,
    temperature: settings.chatModel.temperature,
    maxTokens: settings.chatModel.maxTokens,
    label: "LLM Request (subordinate)",
  });

  try {
    const tokenGovernor = await buildTokenGovernor(
      settings.chatModel,
      resolveMaxOutputTokens(settings.chatModel),
      options.abortSignal,
      undefined,
      systemPrompt // Layer 0 — subtract the system-prompt size from the msg budget
    );
    const result = await generateText({
      model,
      system: systemPrompt,
      messages,
      providerOptions,
      tools,
      maxRetries: 3,
      prepareStep: tokenGovernor,
      stopWhen: [stepCountIs(MAX_TOOL_STEPS_SUBORDINATE), hasToolCall("response"), loopAbortStop],
      temperature: settings.chatModel.temperature ?? 0.7,
      maxOutputTokens: resolveMaxOutputTokens(settings.chatModel),
      // PM #98 — delegated subordinate run; same no-observer argument.
      abortSignal: callDeadlineSignal(options.abortSignal),
    });
    const responseMessages = (
      result as unknown as { response?: { messages?: ModelMessage[] } }
    ).response?.messages;

    // PM #61 — unwrap a text-serialized `response` call before the subordinate
    // result flows back into the parent agent's context.
    const responseText = unwrapSerializedResponseCall(
      (Array.isArray(responseMessages) && responseMessages.length > 0)
        ? getLastResponseToolText(responseMessages) || result.text
        : result.text
    );

    const text =
      responseText.trim() || "Subordinate agent finished but returned no text.";

    return {
      text,
      // Vercel AI SDK's GenerateTextResult exposes `usage` as the
      // top-level token tally; we forward it verbatim so the parent
      // chat's `addUsageToCumulative` can apply provider pricing.
      usage: (result as unknown as { usage?: import("@/lib/cost/accumulator").RawUsage }).usage,
      provider: settings.chatModel.provider,
      model: settings.chatModel.model,
    };
  } finally {
    if (mcpCleanupSub) {
      try {
        await mcpCleanupSub();
      } catch {
        // non-critical
      }
    }
  }
}
