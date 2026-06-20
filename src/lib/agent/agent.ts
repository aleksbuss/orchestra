import {
  streamText,
  generateText,
  stepCountIs,
  hasToolCall,
  type ModelMessage,
  type PrepareStepFunction,
} from "ai";
import { resolveMaxOutputTokens } from "@/lib/providers/model-output-limits";
import { createModel, isLocalProvider } from "@/lib/providers/llm-provider";
import { modelSupportsTools } from "@/lib/providers/tool-support";
import { foldTurnUsage } from "@/lib/cost/accumulator";
import type { ModelConfig } from "@/lib/types";
import { buildSystemPrompt, PLAIN_CHAT_TOOL_OVERRIDE } from "@/lib/agent/prompts";
import { getSettings } from "@/lib/storage/settings-store";
import { getChat, updateChat } from "@/lib/storage/chat-store";
import { createAgentTools } from "@/lib/tools/tool";
import { getProjectMcpTools } from "@/lib/mcp/client";
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
} from "@/lib/agent/compressor";
import { resolveContextWindow, compactionThresholdFor } from "@/lib/providers/context-window";
import { createTokenGovernor } from "@/lib/agent/token-governor";
import { applyGlobalToolLoopGuard } from "@/lib/agent/tool-guard";
import { getBrainConfig, type PresetTier } from "@/lib/agent/presets";
import { runMoAEnsemble } from "@/lib/agent/moa";
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
} from "@/lib/agent/agent-response";
import type { TurnContinuationResult } from "@/lib/agent/agent-response";

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

const MAX_TOOL_STEPS_PER_TURN = 30;
const MAX_TOOL_STEPS_SUBORDINATE = 15;

/**
 * Sprint A4 — number of most-recent messages kept VERBATIM in the live context
 * during pre-flight compaction (the sliding window). Everything older than this
 * (and not a leading system anchor) is evicted to RAG.
 */
const KEEP_RECENT_MESSAGES = 8;

// ── Swarm DAG Completion Guard ────────────────────────────────────────────────
// Guarantees that the orchestrator node always transitions out of "running"
// even when the SSE stream disconnects mid-response or onFinish throws.
function publishOrchestratorFinished(
  chatId: string,
  projectId: string | null | undefined,
  status: "completed" | "error",
  reason?: string
) {
  publishUiSyncEvent({
    topic: "chat",
    projectId: projectId ?? null,
    chatId,
    reason: reason ?? "agent_turn_finished",
  });
  publishUiSyncEvent({
    topic: "chat",
    projectId: projectId ?? null,
    chatId,
    nodeType: "agent_node",
    swarmNode: {
      nodeId: chatId,
      role: "orchestrator",
      taskSummary: status === "completed" ? "Finished." : "Error.",
      status,
      completedAt: new Date().toISOString(),
    },
  });
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
  preResolvedWindow?: number
): Promise<PrepareStepFunction> {
  const contextWindow =
    preResolvedWindow ?? (await resolveContextWindow(windowConfig, { abortSignal }));
  return createTokenGovernor({ contextWindow, reservedOutputTokens });
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

  const baseTools = createAgentTools(parentContext, settings);
  let tools = baseTools;
  if (parentContext.projectId) {
    const mcp = await getProjectMcpTools(parentContext.projectId);
    if (mcp) {
      tools = { ...baseTools, ...mcp.tools };
    }
  }

  // --- Swarm Tool Pruning (Scoping) ---
  // Read-only tools safe for all sub-agent roles
  const readOnlyMatch = (key: string) =>
    key.includes("search") || key.includes("read") || key.includes("list") ||
    key.includes("view") || key.includes("blackboard") || key === "knowledge_query" ||
    key === "memory_load" || key === "response";

  if (role === "researcher") {
    const filteredTools: Record<string, any> = {};
    for (const key of Object.keys(tools)) {
      if (readOnlyMatch(key)) {
        filteredTools[key] = tools[key];
      }
    }
    tools = filteredTools;
  } else if (role === "reviewer") {
    const filteredTools: Record<string, any> = {};
    for (const key of Object.keys(tools)) {
      if (readOnlyMatch(key) || key.includes("grep")) {
        filteredTools[key] = tools[key];
      }
    }
    tools = filteredTools;
  }
  // "coder" retains all structural and OS execution tools.
  // ------------------------------------
  tools = applyGlobalToolLoopGuard(tools, { chatId: parentContext.chatId, parentNodeId: nodeId });

  const systemPrompt = getSwarmSystemPrompt(role) + "\n\nYou must return a concise, accurate response when your work is completely done.";
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
      abortSignal
    );
    const result = await generateText({
      model,
      system: systemPrompt,
      providerOptions,
      messages: [{ role: "user", content: promptText }],
      tools,
      maxRetries: 3,
      prepareStep: tokenGovernor,
      stopWhen: [stepCountIs(MAX_TOOL_STEPS_SUBORDINATE), hasToolCall("response")],
      temperature: settings.chatModel.temperature ?? 0.7,
      maxOutputTokens: resolveMaxOutputTokens(settings.chatModel),
      abortSignal,
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
  isBackground?: boolean;
  abortSignal?: AbortSignal;
  preset?: PresetTier;
}

/**
 * PM #47 — Privacy Mode runtime guard. Throws when the operator has
 * enabled `settings.privacyMode.enabled` but any of `chatModel`,
 * `utilityModel`, or `embeddingsModel` resolves to a non-local backend.
 * Exported so the runtime check has its own focused test suite
 * (`agent-privacy.test.ts`) without booting the full runAgent path.
 */
export function assertPrivacyModeAllowsSettings(
  settings: AppSettings
): void {
  if (!settings.privacyMode?.enabled) return;
  const violations: string[] = [];
  if (!isLocalProvider(settings.chatModel)) {
    violations.push(
      `chatModel = ${settings.chatModel.provider}/${settings.chatModel.model}`
    );
  }
  // utilityModel is used by the Router + reflection critic. If it's
  // not local, the swarm leaks the user prompt to a vendor regardless
  // of whether the chatModel is local.
  if (
    settings.utilityModel?.model &&
    !isLocalProvider(settings.utilityModel)
  ) {
    violations.push(
      `utilityModel = ${settings.utilityModel.provider}/${settings.utilityModel.model}`
    );
  }
  // embeddingsModel is used by Blackboard + PM #39 disagreement
  // detection + PM #46 convergence. Same threat — text leaves the box.
  // Note: the embeddingsModel union includes "mock", which is non-network.
  if (
    settings.embeddingsModel?.provider &&
    settings.embeddingsModel.provider !== "mock" &&
    !isLocalProvider({
      provider: settings.embeddingsModel.provider as ModelConfig["provider"],
      model: settings.embeddingsModel.model,
      baseUrl: settings.embeddingsModel.baseUrl,
    })
  ) {
    violations.push(
      `embeddingsModel = ${settings.embeddingsModel.provider}/${settings.embeddingsModel.model}`
    );
  }
  // PM #48 — proposerTiers also leak the user prompt if any configured
  // tier resolves to a non-local backend. The MoA dispatch path uses
  // `resolveProposerModelConfig` which falls back to `chatModel`/worker
  // when a tier is unset, so we only check tiers the operator actually
  // configured (has a `model` set).
  const tiers = settings.proposerTiers;
  if (tiers) {
    for (const tierName of ["fast", "balanced", "frontier"] as const) {
      const tierCfg = tiers[tierName];
      if (tierCfg?.model && !isLocalProvider(tierCfg)) {
        violations.push(
          `proposerTiers.${tierName} = ${tierCfg.provider}/${tierCfg.model}`
        );
      }
    }
  }
  // PM #54 — `settings.aggregator.tournamentJudgeModel` (PM #52) was the
  // last LLM call path that bypassed the Privacy Mode guard. When the
  // operator picks tournament mode + a cloud judge model, every MoA call
  // shipped the user prompt + every draft to that judge provider — the
  // exact air-gap violation PM #47 was supposed to prevent. Closing the
  // hole here makes the threat model honest: ALL LLM call paths reachable
  // from runAgent are now gated by this single guard.
  const judgeCfg = settings.aggregator?.tournamentJudgeModel;
  if (judgeCfg?.model && !isLocalProvider(judgeCfg)) {
    violations.push(
      `aggregator.tournamentJudgeModel = ${judgeCfg.provider}/${judgeCfg.model}`
    );
  }
  if (violations.length > 0) {
    throw new Error(
      `Privacy Mode is enabled, but these models target a non-local backend:\n  ` +
        violations.map((v) => `• ${v}`).join("\n  ") +
        `\n\nTo proceed, either: (a) disable Privacy Mode in Settings, or ` +
        `(b) switch the violating models to a local backend (ollama, ` +
        `sglang, vllm, or custom with a loopback baseUrl).`
    );
  }
}

export async function runAgent(options: RunAgentOptions) {
  const settings = await getSettings();

  // PM #47 — Privacy Mode enforcement. Fail fast before any LLM call so
  // the operator/sharing-friends see the error in the chat UI rather
  // than a partial run with cloud telemetry already in flight.
  assertPrivacyModeAllowsSettings(settings);

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

    // Compaction fires at 75% of the resolved window (Sprint A2).
    const contextLimit = compactionThresholdFor(contextWindow);

    // Sprint A1: gate compaction on token pressure ONLY. The old
    // `&& chat.messages.length > 12` guard let a moderate (9–12 message) chat
    // that genuinely exceeds the limit sail past compaction.
    if (estimatedTokens > contextLimit) {
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
        console.log(`[Memory] Context reached ${estimatedTokens} tokens (limit ${contextLimit}). Deep-archiving history...`);
        publishUiSyncEvent({
          topic: "chat",
          chatId: options.chatId,
          projectId: options.projectId ?? null,
          reason: "[System] Context memory reached dynamic limit. Deep-archiving history into RAG...",
        });

        const memorySubdir = options.projectId ? `${options.projectId}` : "main";
        const archivedAt = new Date().toISOString();

        // (1) Verbatim archive — exact strings survive compaction unparaphrased.
        try {
          await insertMemory(
            `Archived Chat History (verbatim) [${archivedAt}]:\n${formatVerbatimArchive(evicted)}`,
            "Auto-Archive",
            memorySubdir,
            settings,
            undefined,
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
              "Auto-Archive",
              memorySubdir,
              settings,
              undefined,
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

    const allMessages = convertChatMessagesToModelMessages(chat.messages);
    const history = new History(80);
    history.addMany(allMessages);
    context.history = history.getAll();
    console.log(`[Memory] Agent context loaded: ${context.history.length} messages (from ${chat.messages.length} stored).`);
  }

  // Build tools: base + optional MCP tools from project .meta/mcp
  const baseTools = createAgentTools(context, settings);
  let mcpCleanup: (() => Promise<void>) | undefined;
  let tools = baseTools;
  if (options.projectId) {
    const mcp = await getProjectMcpTools(options.projectId);
    if (mcp) {
      tools = { ...baseTools, ...mcp.tools };
      mcpCleanup = mcp.cleanup;
    }
  }
  const orchestratorNodeId = options.chatId;
  const dagContext = options.swarmEnabled !== false
    ? { chatId: options.chatId, parentNodeId: orchestratorNodeId }
    : undefined;
  tools = applyGlobalToolLoopGuard(tools, dagContext);

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

  // Phase 3: "Deep Memory" System Prompt Injection
  try {
    const memorySubdir = options.projectId ? `${options.projectId}` : "main";
      const similarityThreshold = settings.memory?.similarityThreshold ?? 0.7;
      const ragResults = await searchMemory(options.userMessage, 3, similarityThreshold, memorySubdir, settings, undefined, options.abortSignal);
      
      if (ragResults && ragResults.length > 0) {
        const ragFormatted = ragResults.map((r) => `[Relevance Score: ${r.score.toFixed(2)}] (Area: ${r.metadata.area})\n${r.text}`).join("\n\n");
        systemPrompt += `\n\n<deep_memory_recall>\nYou have subconscious access to past archived conversations and vectors matching the user's current query. Use this to maintain perfect context continuity:\n\n${ragFormatted}\n</deep_memory_recall>`;
        console.log(`[RAG] Deep Memory Recall injected (${ragResults.length} chunks).`);
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
      });
      turnExtraUsage = moaResult.cumulativeUsage;

      if (moaResult.text && !moaResult.text.startsWith("All MoA proposer agents failed")) {
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

        console.log(`[MoA] Consensus injected (${truncatedConsensus.length} chars, ${moaResult.totalLatencyMs}ms total)`);
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
  // Detect this and fall back to plain chat mode gracefully.
  //
  // PM #17 — Before the audit, the OpenRouter branch only checked for
  // `deepseek-r1` while the Ollama branch consulted the broader pattern
  // list. A user picking `google/gemma-4-31b-it` via OpenRouter got 63
  // tools forwarded → 404 from OpenRouter → agent died silently after MoA
  // had already succeeded. The shared `modelSupportsTools` helper
  // (`@/lib/providers/tool-support`) is now the single source of truth for
  // every non-Ollama provider; the Ollama branch keeps its live `/api/show`
  // probe and falls back to the same helper on probe failure.
  const isOllamaProvider = resolvedModelConfig.provider === "ollama";

  let supportsTools: boolean;
  if (isOllamaProvider) {
    let detectedFromTemplate: boolean | null = null;
    try {
      const ollamaBase = (resolvedModelConfig.baseUrl || "http://localhost:11434").replace(/\/v1\/?$/, "");
      const showRes = await fetch(`${ollamaBase}/api/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: resolvedModelConfig.model }),
        signal: AbortSignal.timeout(3000),
      });
      if (showRes.ok) {
        const showData = await showRes.json() as { template?: string };
        const template = showData.template || "";
        detectedFromTemplate = template.toLowerCase().includes("tools") || template.includes(".Tools");
      }
    } catch {
      // probe failed — fall through to the shared pattern list below.
    }
    supportsTools = detectedFromTemplate ?? modelSupportsTools(
      resolvedModelConfig.provider,
      resolvedModelConfig.model ?? ""
    );
  } else {
    supportsTools = modelSupportsTools(
      resolvedModelConfig.provider,
      resolvedModelConfig.model ?? ""
    );
  }

  // Apply tool mode decision
  const useTools = supportsTools;
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
      contextWindow
    );
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
          stopWhen: [stepCountIs(MAX_TOOL_STEPS_PER_TURN), hasToolCall("response")]
        }
      : {}),
    temperature: settings.chatModel.temperature ?? 0.7,
    maxOutputTokens: resolveMaxOutputTokens(settings.chatModel),
    abortSignal: options.abortSignal,
    onStepFinish: async (event) => {
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
    },
    onFinish: async (event) => {
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

        const responseMessages = event.response.messages;
        // PM #36 (truncation continuation) + PM #69 (forced final answer) are
        // both decided by resolveTurnContinuation — self-contained and
        // unit-tested (final-answer-guard.test.ts). We publish any non-fatal
        // operator notice it returns and bill its usage alongside streamUsage.
        const turnExtra = await resolveTurnContinuation({
          responseMessages,
          finishReason,
          model,
          systemPrompt,
          baseMessages: messages,
          providerOptions,
          settings,
          abortSignal: options.abortSignal,
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
            // + auto-continuation + MoA bundle) into the running per-chat
            // cumulative via the single accounting helper. Resolved chat-model
            // identity comes from `resolvedModelConfig`; the continuation reuses
            // the same model handle, so the pricing lookup is unambiguous.
            chat.cumulativeUsage = foldTurnUsage(
              chat.cumulativeUsage,
              resolvedModelConfig.provider,
              resolvedModelConfig.model,
              { continuationUsage, turnExtraUsage }
            );
            return chat;
          });
        } catch (saveErr) {
          console.error("[Agent] Failed to save chat after turn:", saveErr);
          // Non-critical: don't block DAG finalization
        }

        finalizeDag("completed");
      } catch (onFinishErr) {
        // onFinish itself crashed — still must finalize the DAG
        console.error("[Agent] onFinish error:", onFinishErr);
        finalizeDag("error");
      }
    },
    onError: ({ error }) => {
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
}): Promise<string> {
  const settings = await getSettings();
  // PM #47 — Privacy Mode air-gap must hold on EVERY LLM entry point, not
  // just the interactive `runAgent`. This is the cron + Telegram-relay path
  // (the Telegram webhook is unauthenticated); without the guard a cloud
  // `chatModel` would silently ship user data off-box while the UI shows
  // Privacy Mode ON.
  assertPrivacyModeAllowsSettings(settings);
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
    data: {
      ...(options.runtimeData ?? {}),
      currentUserMessage: options.userMessage,
    },
  };

  const chat = await getChat(options.chatId);
  if (chat) {
    const allMessages = convertChatMessagesToModelMessages(chat.messages);
    const history = new History(80);
    history.addMany(allMessages);
    context.history = history.getAll();
  }

  const baseTools = createAgentTools(context, settings);
  let mcpCleanup: (() => Promise<void>) | undefined;
  let tools = baseTools;
  if (options.projectId) {
    const mcp = await getProjectMcpTools(options.projectId);
    if (mcp) {
      tools = { ...baseTools, ...mcp.tools };
      mcpCleanup = mcp.cleanup;
    }
  }
  tools = applyGlobalToolLoopGuard(tools);
  const toolNames = Object.keys(tools);

  const systemPrompt = await buildSystemPrompt({
    projectId: options.projectId,
    chatId: options.chatId,
    agentNumber: options.agentNumber,
    tools: toolNames,
  });

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
      options.abortSignal
    );
    const generated = await generateText({
      model,
      system: systemPrompt,
      messages,
      providerOptions,
      tools,
      maxRetries: 3,
      prepareStep: tokenGovernor,
      stopWhen: [stepCountIs(MAX_TOOL_STEPS_PER_TURN), hasToolCall("response")],
      temperature: settings.chatModel.temperature ?? 0.7,
      maxOutputTokens: resolveMaxOutputTokens(settings.chatModel),
      abortSignal: options.abortSignal,
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
}): Promise<SubordinateResult> {
  const settings = await getSettings();
  // PM #47 — defense-in-depth: the subordinate is normally entered via a
  // parent `runAgent` that already enforced the air-gap, but the recursive
  // path (Sprint 9) and any future direct caller must not be able to reach
  // a cloud provider with Privacy Mode ON. One line, settings already in scope.
  assertPrivacyModeAllowsSettings(settings);
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
    data: {},
  };

  let tools = createAgentTools(context, settings);
  let mcpCleanupSub: (() => Promise<void>) | undefined;
  if (options.projectId) {
    const mcp = await getProjectMcpTools(options.projectId);
    if (mcp) {
      tools = { ...tools, ...mcp.tools };
      mcpCleanupSub = mcp.cleanup;
    }
  }
  tools = applyGlobalToolLoopGuard(tools);
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
      options.abortSignal
    );
    const result = await generateText({
      model,
      system: systemPrompt,
      messages,
      providerOptions,
      tools,
      maxRetries: 3,
      prepareStep: tokenGovernor,
      stopWhen: [stepCountIs(MAX_TOOL_STEPS_SUBORDINATE), hasToolCall("response")],
      temperature: settings.chatModel.temperature ?? 0.7,
      maxOutputTokens: resolveMaxOutputTokens(settings.chatModel),
      abortSignal: options.abortSignal,
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
