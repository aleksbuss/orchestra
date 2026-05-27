/**
 * Mixture-of-Agents (MoA) Engine
 *
 * Runs N parallel "Proposer" agents with diverse perspectives,
 * then feeds their drafts to an "Aggregator" agent that synthesizes
 * the final, high-quality response.
 *
 * Architecture:
 *   User Message ──▶ [Proposer₁ (Architect)]
 *                ──▶ [Proposer₂ (Debugger)]    ──▶ Aggregator ──▶ Final Response
 *                ──▶ [Proposer₃ (Minimalist)]
 */

import { generateText, generateObject, tool, type ModelMessage } from "ai";
import { addUsageToCumulative } from "@/lib/cost/accumulator";
import type { ChatUsage } from "@/lib/types";
import { z } from "zod";
import { createModel } from "@/lib/providers/llm-provider";
import type { ModelConfig, AppSettings } from "@/lib/types";
import { getBrainConfig, getWorkerConfig, type PresetTier } from "@/lib/agent/presets";
import { agentSemaphore } from "./semaphore";
import { publishUiSyncEvent } from "@/lib/realtime/event-bus";

import { searchWeb } from "@/lib/tools/search-engine";

// ── MoA Proposer Perspectives ───────────────────────────────────────────

export interface MoAProposer {
  id: string;
  role: string;
  systemPrompt: string;
  /** Color accent for UI (tailwind) */
  color: string;
}

export const MOA_PROPOSERS: MoAProposer[] = [
  {
    id: "analyst",
    role: "First-Principles Analyst",
    color: "violet",
    systemPrompt: `You are a First-Principles Analyst. Your approach is structured, logical, and deeply truth-seeking.

RULES:
- Break down the user's request into its fundamental truths and constraints.
- Strip away assumptions and focus only on verified facts and core logic.
- Do NOT jump to the simplest solution; instead, dissect the problem space thoroughly.
- Define clearly what is known, what is unknown, and what is required to solve the task.

Respond directly to the user's request. Keep your output highly structured, analytical, and devoid of emotional language.`,
  },
  {
    id: "creative",
    role: "Lateral-Thinking Creative",
    color: "amber",
    systemPrompt: `You are a Lateral-Thinking Creative. Your approach is unorthodox, brainstorm-heavy, and paradigm-shifting.

RULES:
- Do NOT settle for the obvious, standard answer.
- Connect the user's request to seemingly unrelated fields or metaphors to find non-obvious solutions.
- Brainstorm multiple outside-the-box approaches.
- If writing code or designing a system, propose bleeding-edge, highly innovative, or extremely elegant patterns.

Respond directly to the user's request. Be bold, visionary, and expansive in your thinking.`,
  },
  {
    id: "pragmatist",
    role: "Pragmatic Executor",
    color: "emerald",
    systemPrompt: `You are a Pragmatic Executor. Your philosophy is "Occam's Razor" and "You Aren't Gonna Need It" (YAGNI).

RULES:
- Find the absolute maximum-leverage, lowest-complexity path to the user's goal.
- Ruthlessly eliminate boilerplate, over-engineering, and unnecessary steps.
- Explain the simplest, most direct way to get the job done right now.
- If providing code or a plan, make it concise, stupidly simple, and immediately actionable.

Respond directly to the user's request. Cut the fluff. Show the fastest working path.`,
  },
  {
    id: "critic",
    role: "Adversarial Critic",
    color: "rose",
    systemPrompt: `You are an Adversarial Critic and Red-Teamer. Your approach is deeply skeptical, paranoid, and detail-oriented.

RULES:
- Assume the premise might be flawed. Hunt for edge cases, logical fallacies, biases, and potential breaking points.
- If reviewing code or a system, look for security vulnerabilities, race conditions, or unhandled exceptions.
- If evaluating a plan, emphasize what could go wrong and why it might fail.
- Challenge optimistic assumptions forcefully. Provide strict mitigations.

Respond directly to the user's request. Keep your analysis relentless and bulletproof.`,
  },
  {
    id: "chameleon",
    role: "Domain Expert Chameleon",
    color: "blue",
    systemPrompt: `You are a Domain Expert Chameleon. You dynamically adapt to become the world's leading authority internally on the specific topic requested.

RULES:
- Instantly identify the specific professional domain of the user's request (e.g., Marketing, Corporate Law, Advanced React Architecture, Behavioral Psychology).
- Adopt the terminology, best practices, and historical context of that exact domain.
- Provide a response that would impress a 10-year veteran of that specific industry.
- Ground your advice in the established "Gold Standards" of that particular field.

Respond directly to the user's request with the supreme confidence of an apex expert in that exact domain.`,
  },
];

// ── Dynamic Persona Generation (DPG) ────────────────────────────────────

export interface DPGResult {
  requiresSwarm: boolean;
  personas: MoAProposer[];
  /** Router LLM usage so the caller can fold it into the chat cumulative (PM #36). */
  usage?: import("@/lib/cost/accumulator").RawUsage;
}

/**
 * Dynamically generates 3-5 hyper-specialized expert personas tailored to the user's prompt.
 * Includes Intelligent Bypass: evaluates if the task actually needs a swarm.
 */
async function generateDynamicSwarm(
  userMessage: string,
  history: ModelMessage[],
  modelConfig: ModelConfig,
  searchEnabled: boolean,
  abortSignal?: AbortSignal
): Promise<DPGResult> {
  try {
    // Format the last 5 messages for context — content can be string or array (tool-calls)
    const recentContext = history.slice(-5).map(m => {
      const text = typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map(p => (typeof p === "object" && p !== null && "text" in p ? (p as {text: string}).text : "")).join(" ")
          : String(m.content);
      return `[${m.role.toUpperCase()}]: ${text.slice(0, 500)}`;
    }).join("\n");

    const routerModel = createModel(modelConfig, {});
    const { object, usage } = await generateObject({
      model: routerModel,
      schema: z.object({
        requiresSwarm: z.boolean().describe("Set to false ONLY IF the user's message is a simple conversational reply (e.g. 'thanks', 'hello') or a trivial task that a single AI agent can handle easily without needing a committee of diverse experts."),
        personas: z.array(z.object({
          id: z.string().describe("A short snake_case id (e.g. 'tax_lawyer')"),
          role: z.string().describe("The human-readable Title/Role of the expert (e.g. 'Senior Tax Attorney')"),
          systemPrompt: z.string().describe("The specific system prompt Rules and Guidelines for this expert. MUST follow structure: [GOAL] ... [RULES] ... [FORMAT]"),
          color: z.enum(["slate", "gray", "zinc", "neutral", "stone", "red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal", "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink", "rose"]).describe("A distinct tailwind color for UI representation")
        })).min(3).max(5).describe("List of exactly 3 to 5 highly specialized experts required to answer the user request. Only used if requiresSwarm is true.")
      }),
      prompt: `You are the Orchestra Auto-Swarm Router. 
The user has submitted a request. Your job is to determine if a "Dream Team" of experts is needed.

RECENT CONTEXT:
${recentContext}

CURRENT USER REQUEST (truncated if too long):
${userMessage.slice(0, 2000)}

INSTRUCTIONS:
1. If the request is trivial, conversational, or a simple code edit, set requiresSwarm to false.
2. If the request requires multi-faceted analysis, deep architecture, creative brainstorming, or complex problem solving, set requiresSwarm to true.
3. If true, assemble 3 to 5 hyper-specialized domain experts. Do NOT use generic roles.
4. For each expert, provide a highly specific systemPrompt using this exact structure:
   [GOAL] What they are trying to achieve from their narrow perspective.
   [RULES] 2-3 strict guidelines they must follow (e.g., "Always hunt for edge cases", "Never propose complex solutions").
   [FORMAT] How they should format their answer.
5. VERY IMPORTANT: One of your 3-5 experts MUST ALWAYS be a "QA Auditor / Fact-Checker" (e.g., \`skeptic_auditor\`). Their [GOAL] is to doubt the user's premise, search for potential pitfalls, verify library compatibilities via \`search_web\` (if available), and actively try to find edge cases where the proposed solution would fail.
${searchEnabled ? `6. VERY IMPORTANT: You have access to the 'search_web' tool. If an expert requires real-time facts, news, documentation, or live data to solve the request, you MUST explicitly instruct them in their [RULES] to call the 'search_web' tool first before answering.` : ""}`,
      abortSignal,
    });

    // PM #37 — guarantee the QA Auditor / Skeptic. CLAUDE.md §1 promises
    // "one DPG role is ALWAYS forced to be a QA Auditor / Skeptic", but
    // the previous implementation relied entirely on a prompt instruction.
    // A weak utility-model can ignore the instruction and produce 3-5
    // personas without a critic, leaving the swarm without the
    // zero-latency fact-checking mandate. We post-validate the LLM's
    // output and inject the canonical Adversarial Critic if missing.
    const SKEPTIC_PATTERN = /skeptic|auditor|critic|red.?team|fact.?check|adversari/i;
    const hasSkeptic = object.personas.some(
      (p) => SKEPTIC_PATTERN.test(p.id) || SKEPTIC_PATTERN.test(p.role)
    );
    let personas = object.personas as MoAProposer[];
    if (object.requiresSwarm && !hasSkeptic) {
      console.warn(
        `[MoA] DPG output missing a Skeptic persona — force-injecting canonical 'critic' (PM #37). Roles received: ${object.personas.map((p) => p.id).join(", ")}`
      );
      const canonicalCritic = MOA_PROPOSERS.find((p) => p.id === "critic")!;
      // Cap at 5 personas total to keep the cost envelope predictable.
      // If the LLM already returned 5, evict the LAST one (heuristic:
      // the LLM's tail picks are usually the weakest).
      personas = [...object.personas];
      if (personas.length >= 5) personas.pop();
      personas.push({
        id: canonicalCritic.id,
        role: canonicalCritic.role,
        systemPrompt: canonicalCritic.systemPrompt,
        color: canonicalCritic.color,
      });
    }
    return {
      requiresSwarm: object.requiresSwarm,
      personas,
      usage,
    };
  } catch (err) {
    console.error("[MoA] Dynamic Persona Generation failed. Falling back to universal presets.", err);
    return {
      requiresSwarm: true,
      personas: MOA_PROPOSERS,
      // Usage is unknown when the Router crashes; the chat banner just
      // misses the Router's tokens for this turn (a small undercount).
    };
  }
}

// ── Aggregator Prompt ───────────────────────────────────────────────────

function buildAggregatorPrompt(userMessage: string, drafts: { role: string; text: string }[]): string {
  const draftBlock = drafts
    .map((d, i) => `═══ DRAFT ${i + 1} — ${d.role} ═══\n${d.text}`)
    .join("\n\n");

  return `You are an expert Technical Aggregator. Your goal is to synthesize a final response from multiple expert drafts.

STRICT RULES FOR SYNTHESIS:
1. **Preserve All Technical Details**: Do NOT summarize or omit specific version numbers, library names, or configuration values.
2. **Code Block Integrity**: You MUST include all relevant code blocks provided by the experts. If multiple experts provide different code solutions, evaluate them and provide the most robust version, or list alternatives if they serve different purposes. NEVER skip code to save space.
3. **Structured Format**: Use tables, lists, and markdown headers to keep the response highly readable.
4. **No Meta-Commentary**: Do not start with "Here is the synthesis..." or "Based on the experts...". Start directly with the answer.
5. **Conflict Resolution**: If experts disagree (e.g., on a library version), use your internal knowledge to pick the most stable and modern choice.

═══ EXPERT DRAFTS TO SYNTHESIZE ═══
${draftBlock}

═══ ORIGINAL USER REQUEST ═══
${userMessage}

Now, produce the final, unified, and technically rich response (include ALL code examples):`;
}

// ── MoA Ensemble Runner ─────────────────────────────────────────────────

export interface MoAOptions {
  chatId: string;
  userMessage: string;
  projectId?: string;
  currentPath?: string;
  preset?: PresetTier;
  history: ModelMessage[];
  settings: AppSettings;
  abortSignal?: AbortSignal;
  /**
   * If true, the Router's `requiresSwarm` decision is ignored — the full
   * ensemble (Dynamic Persona Generation → N proposers → aggregator) runs
   * unconditionally. Use this when the user has explicitly demanded the
   * Swarm and an unreliable `utilityModel` would otherwise mis-classify the
   * prompt as trivial. Wired through from the UI's "Force Swarm" toggle.
   */
  forceSwarm?: boolean;
}

export interface MoAResult {
  /** Final aggregated text */
  text: string;
  /** Individual proposer drafts for debugging/logging */
  drafts: { proposerId: string; role: string; text: string; latencyMs: number }[];
  /** Aggregation latency */
  aggregationLatencyMs: number;
  /** Total wall-clock time */
  totalLatencyMs: number;
  /**
   * Aggregated usage across Router + every proposer + aggregator (PM #36).
   * The caller adds this to the chat's `cumulativeUsage` to keep the soft
   * budget banner accurate even when Swarm-mode fans out 5+ LLM calls
   * behind a single user turn.
   */
  cumulativeUsage?: import("@/lib/types").ChatUsage;
}

/**
 * Resolve the API key for a given model config.
 * Mirrors the key resolution logic from runAgent.
 */
function resolveWorkerKey(config: ModelConfig, settings: AppSettings): ModelConfig {
  if (config.apiKey) return config;

  const provider = config.provider;
  const vaultKey = settings.providerApiKeys?.[provider];
  if (vaultKey) {
    return { ...config, apiKey: vaultKey };
  }
  if (settings.chatModel.provider === provider && settings.chatModel.apiKey) {
    return { ...config, apiKey: settings.chatModel.apiKey };
  }
  // Fall through to env vars (handled by createModel)
  return config;
}

/**
 * Execute the full Mixture-of-Agents pipeline:
 *   1. Fan-out: Run N proposers in parallel
 *   2. Fan-in:  Aggregate results with a brain model
 */
export async function runMoAEnsemble(options: MoAOptions): Promise<MoAResult> {
  const totalStart = Date.now();
  const {
    chatId,
    userMessage,
    projectId,
    currentPath,
    preset,
    history,
    settings,
    abortSignal,
    forceSwarm,
  } = options;

  // ── Step 1: Resolve model configs ──────────────────────────────────
  const workerConfig = resolveWorkerKey(
    preset && preset !== "custom" ? getWorkerConfig(preset, settings.chatModel) : settings.utilityModel,
    settings
  );

  // Brain model = the main resolved config (already resolved in runAgent)
  // We'll use the same chatModel for aggregation since runAgent handles it.

  // ── Step 1.5: Prepare safe history ─────────────────────────────────
  // We cannot simply slice(-N) because it might break tool-call sequences.
  // Instead, extract only text-based interactions for the proposers to read.
  const safeHistory = history.filter((msg) => 
    msg.role === "user" || 
    (msg.role === "assistant" && typeof msg.content === "string")
  );

  // ── Step 1.8: Generate Dynamic Personas ────────────────────────────
  const routerNodeId = crypto.randomUUID();
  publishUiSyncEvent({
    topic: "chat",
    chatId,
    projectId: projectId ?? null,
    reason: `[MoA] Auto-Routing: Analyzing request to assemble dream team...`,
    nodeType: "system_node",
    swarmNode: {
      nodeId: routerNodeId,
      role: "orchestrator",
      taskSummary: "Auto-Routing Request",
      status: "running",
      startedAt: new Date().toISOString(),
    },
  });

  // Use the cheaper utility model for routing decisions (not the expensive brain model).
  // Fall back to chatModel if utilityModel is not properly configured (e.g., missing model string).
  const routingModelConfig = settings.utilityModel?.model
    ? settings.utilityModel
    : settings.chatModel;
  const routerConfig = resolveWorkerKey(routingModelConfig, settings);
  
  const searchEnabled = settings.search?.enabled && settings.search.provider !== "none";
  const dpgResult = await generateDynamicSwarm(userMessage, history, routerConfig, searchEnabled, abortSignal);

  publishUiSyncEvent({
    topic: "chat",
    chatId,
    nodeType: "system_node",
    swarmNode: {
      nodeId: routerNodeId,
      role: "orchestrator",
      taskSummary: dpgResult.requiresSwarm ? "Assembled Expert Team" : "Bypassed Swarm",
      status: "completed",
      completedAt: new Date().toISOString(),
    },
  });

  // ── Step 1.9: Bypass Check ─────────────────────────────────────────
  // The Router (running on `utilityModel`) may decide `requiresSwarm: false`
  // for prompts it deems trivial. When the user has explicitly pinned the
  // Force-Swarm toggle, we ignore that decision — the UI invariant is "if
  // the user demands the swarm, the swarm runs."
  if (!dpgResult.requiresSwarm && !forceSwarm) {
    publishUiSyncEvent({
      topic: "chat",
      chatId,
      projectId: projectId ?? null,
      reason: `[MoA] Auto-Routing: Task is direct. Swarm bypassed to save latency.`,
    });

    console.log(`[MoA] Swarm bypassed for direct query.`);
    const brainConfig = resolveWorkerKey(
      getBrainConfig(preset ?? "custom", settings.chatModel),
      settings
    );
    const brainModel = createModel(brainConfig, { projectId, currentPath });
    
    try {
      const aggStart = Date.now();
      const directResult = await generateText({
        model: brainModel,
        system: "You are an AI assistant. Answer the user's query directly and efficiently.",
        messages: [
          ...safeHistory.slice(-6),
          { role: "user", content: userMessage },
        ],
        temperature: brainConfig.temperature ?? 0.5,
        maxOutputTokens: brainConfig.maxTokens ?? 2048,
        abortSignal,
      });
      // PM #36 — fold Router + direct-answer usage into the per-chat banner.
      let bypassUsage = addUsageToCumulative(
        undefined,
        routerConfig.provider,
        routerConfig.model,
        dpgResult.usage
      );
      bypassUsage = addUsageToCumulative(
        bypassUsage,
        brainConfig.provider,
        brainConfig.model,
        directResult.usage
      );
      return {
        text: directResult.text?.trim() || "(empty response)",
        drafts: [],
        aggregationLatencyMs: Date.now() - aggStart,
        totalLatencyMs: Date.now() - totalStart,
        cumulativeUsage: bypassUsage,
      };
    } catch (err) {
      console.error("[MoA] Direct bypass failed:", err);
      // Let it fall through to standard swarm on failure, or return error? We'll return error.
      return {
        text: `[Error: ${err instanceof Error ? err.message : String(err)}]`,
        drafts: [],
        aggregationLatencyMs: 0,
        totalLatencyMs: Date.now() - totalStart,
      };
    }
  }

  const dynamicProposers = dpgResult.personas;

  // PM #36 — accumulate usage across the entire ensemble run. The Router's
  // tokens land here; each proposer and the aggregator add to it as they
  // complete. The final number bubbles up via MoAResult.cumulativeUsage.
  let moaUsage: ChatUsage | undefined = addUsageToCumulative(
    undefined,
    routerConfig.provider,
    routerConfig.model,
    dpgResult.usage
  );

  console.log(`[MoA] Starting ensemble: ${dynamicProposers.length} proposers using ${workerConfig.provider}/${workerConfig.model}`);

  // Publish UI event: MoA starting
  publishUiSyncEvent({
    topic: "chat",
    chatId,
    projectId: projectId ?? null,
    reason: `[MoA] Consulting ${dynamicProposers.length} highly-specialized domains...`,
  });

  // ── Step 2: Fan-out — Run proposers in parallel ────────────────────
  const proposerStart = Date.now();

  const proposerPromises = dynamicProposers.map(async (proposer, index) => {
    const nodeId = crypto.randomUUID();

    // 1. Publish UI: proposer queued (so they all appear in the UI immediately)
    publishUiSyncEvent({
      topic: "chat",
      chatId,
      nodeType: "agent_node",
      swarmNode: {
        nodeId,
        parentNodeId: routerNodeId,
        role: proposer.id as "coder",
        taskSummary: `${proposer.role}: Queued...`,
        status: "queued",
      },
    });

    // 2. Stagger starts to prevent 429 Too Many Requests on free/cheap tiers (e.g. OpenRouter)
    if (index > 0) {
      await new Promise((resolve) => setTimeout(resolve, index * 1000));
    }

    return agentSemaphore.run(async () => {
      const pStart = Date.now();

      // 3. Publish UI: proposer running
      publishUiSyncEvent({
        topic: "chat",
        chatId,
        nodeType: "agent_node",
        swarmNode: {
          nodeId,
          parentNodeId: routerNodeId,
          role: proposer.id as "coder",
          taskSummary: `${proposer.role}: analyzing request`,
          status: "running",
          startedAt: new Date().toISOString(),
        },
      });

      try {
        const workerModel = createModel(workerConfig, { projectId, currentPath });

        // Derive UI icon role from persona keywords — works for both static and DPG-generated personas
        let standardRole: "coder" | "researcher" | "reviewer" | "tool" | "orchestrator" = "coder";
        const systemPromptLower = proposer.systemPrompt.toLowerCase();
        const idLower = proposer.id.toLowerCase();
        if (/review|critic|audit|qa|quality|skeptic|adversar|red.?team|fact.?check/.test(idLower + " " + systemPromptLower)) {
          standardRole = "reviewer";
        } else if (/research|analys|architect|domain|expert|chameleon|first.?prin/.test(idLower + " " + systemPromptLower)) {
          standardRole = "researcher";
        } else if (/tool|executor|pragmat|deploy|infra|devops|implement/.test(idLower + " " + systemPromptLower)) {
          standardRole = "tool";
        }

        const messages: ModelMessage[] = [
          ...safeHistory.slice(-6), // Limit context to 6 text messages
          { role: "user", content: userMessage },
        ];

        // Inject Web Search tool if enabled
        const proposerTools = searchEnabled 
          ? {
              search_web: tool({
                description: "Search the internet for real-time information, facts, and live data.",
                inputSchema: z.object({ query: z.string() }),
                execute: async ({ query }, { abortSignal }) => {
                  return searchWeb(query, 5, settings.search, abortSignal);
                },
              })
            }
          : undefined;

        const PROPOSER_TIMEOUT_MS = 120_000; // 2 minutes — generous for free/slow models
        // AbortSignal.any() requires Node 20.3+. Fall back gracefully on older runtimes.
        let proposerSignal: AbortSignal;
        if (typeof AbortSignal.any === "function" && abortSignal) {
          proposerSignal = AbortSignal.any([abortSignal, AbortSignal.timeout(PROPOSER_TIMEOUT_MS)]);
        } else {
          proposerSignal = AbortSignal.timeout(PROPOSER_TIMEOUT_MS);
        }

        const result = await generateText({
          model: workerModel,
          system: proposer.systemPrompt,
          messages,
          temperature: workerConfig.temperature ?? 0.5,
          maxOutputTokens: Math.min(workerConfig.maxTokens ?? 2048, 2048),
          tools: proposerTools,
          // @ts-expect-error maxSteps is supported in newer versions but might not be in the local types for generateText
          maxSteps: searchEnabled ? 3 : 1,
          abortSignal: proposerSignal,
        });

        const text = result.text?.trim() || "(empty draft)";
        const latencyMs = Date.now() - pStart;

        console.log(`[MoA] Proposer "${proposer.id}" completed in ${latencyMs}ms (${text.length} chars)`);

        // Publish UI: proposer completed
        publishUiSyncEvent({
          topic: "chat",
          chatId,
          nodeType: "agent_node",
          swarmNode: {
            nodeId,
            role: standardRole, // Use mapped standard role for icons
            taskSummary: `${proposer.role}: Analysis complete.`,
            status: "completed",
            completedAt: new Date().toISOString(),
          },
        });

        return {
          proposerId: proposer.id,
          role: proposer.role,
          text,
          latencyMs,
          rawUsage: result.usage,
        };
      } catch (err) {
        const latencyMs = Date.now() - pStart;
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[MoA] Proposer "${proposer.id}" failed: ${errMsg}`);

        publishUiSyncEvent({
          topic: "chat",
          chatId,
          nodeType: "agent_node",
          swarmNode: {
            nodeId,
            role: "reviewer", // Fallback role for error reporting
            taskSummary: `${proposer.role}: Failed (${errMsg})`,
            status: "error",
            completedAt: new Date().toISOString(),
          },
        });

        return {
          proposerId: proposer.id,
          role: proposer.role,
          text: `[Error: ${errMsg}]`,
          latencyMs,
        };
      }
    });

  });

  const draftsWithUsage = await Promise.all(proposerPromises);
  const proposerLatency = Date.now() - proposerStart;

  // PM #36 — fold each successful proposer's usage into the running total.
  // Reduce runs single-threaded after Promise.all settles, so no race here.
  for (const d of draftsWithUsage) {
    if ("rawUsage" in d && d.rawUsage) {
      moaUsage = addUsageToCumulative(
        moaUsage,
        workerConfig.provider,
        workerConfig.model,
        d.rawUsage
      );
    }
  }
  // Strip the internal-only rawUsage field before exposing drafts.
  const drafts = draftsWithUsage.map(({ proposerId, role, text, latencyMs }) => ({
    proposerId,
    role,
    text,
    latencyMs,
  }));

  const successfulDrafts = drafts.filter((d) => !d.text.startsWith("[Error:"));
  console.log(`[MoA] All proposers done in ${proposerLatency}ms. ${successfulDrafts.length}/${drafts.length} succeeded.`);

  // If zero drafts succeeded, return a fallback
  if (successfulDrafts.length === 0) {
    return {
      text: "All MoA proposer agents failed. Please check your model configuration and API keys.",
      drafts,
      aggregationLatencyMs: 0,
      totalLatencyMs: Date.now() - totalStart,
      cumulativeUsage: moaUsage,
    };
  }

  // If only one draft succeeded, skip aggregation
  if (successfulDrafts.length === 1) {
    console.log(`[MoA] Only 1 draft succeeded, skipping aggregation.`);
    return {
      text: successfulDrafts[0].text,
      drafts,
      aggregationLatencyMs: 0,
      totalLatencyMs: Date.now() - totalStart,
      cumulativeUsage: moaUsage,
    };
  }

  // ── Step 3: Fan-in — Aggregate with brain model ────────────────────
  const aggregatorNodeId = crypto.randomUUID();
  publishUiSyncEvent({
    topic: "chat",
    chatId,
    projectId: projectId ?? null,
    reason: `[MoA] Synthesizing ${successfulDrafts.length} expert drafts into final response...`,
    nodeType: "system_node",
    swarmNode: {
      nodeId: aggregatorNodeId,
      parentNodeId: routerNodeId,
      role: "orchestrator",
      taskSummary: "Synthesizing Drafts",
      status: "running",
      startedAt: new Date().toISOString(),
    },
  });

  const aggStart = Date.now();
  const aggregatorPrompt = buildAggregatorPrompt(userMessage, successfulDrafts);

  // Use the brain model for aggregation (the main chatModel with full context)
  const brainConfig = resolveWorkerKey(
    getBrainConfig(preset ?? "custom", settings.chatModel),
    settings
  );

  console.log(`[MoA] Starting aggregation with model: ${brainConfig.provider}/${brainConfig.model} (${aggregatorPrompt.length} chars)`);
  const brainModel = createModel(brainConfig, { projectId, currentPath });

  try {
    const aggResult = await generateText({
      model: brainModel,
      system: "You are an expert technical synthesizer. You NEVER omit code blocks. You provide complete, production-ready answers based on expert drafts.",
      messages: [
        // Do NOT include safeHistory here to avoid consecutive User/User roles which crashes models like Gemma.
        // The aggregatorPrompt already contains the original userMessage.
        { role: "user", content: aggregatorPrompt },
      ],
      temperature: 0.3,
      maxOutputTokens: Math.max(brainConfig.maxTokens ?? 4096, 2048),
      abortSignal,
    });

    const aggregationLatencyMs = Date.now() - aggStart;
    const finalText = aggResult.text?.trim() || "(aggregation produced empty output)";

    console.log(`[MoA] Aggregation completed in ${aggregationLatencyMs}ms (${finalText.length} chars)`);

    // PM #36 — fold the aggregator's tokens into the running total.
    moaUsage = addUsageToCumulative(
      moaUsage,
      brainConfig.provider,
      brainConfig.model,
      aggResult.usage
    );

    publishUiSyncEvent({
      topic: "chat",
      chatId,
      nodeType: "system_node",
      swarmNode: {
        nodeId: aggregatorNodeId,
        parentNodeId: routerNodeId,
        role: "orchestrator",
        taskSummary: "Synthesis Complete",
        status: "completed",
        completedAt: new Date().toISOString(),
      },
    });

    return {
      text: finalText,
      drafts,
      aggregationLatencyMs,
      totalLatencyMs: Date.now() - totalStart,
      cumulativeUsage: moaUsage,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[MoA] Fatal Aggregation Error: ${errMsg}`);

    // Fallback: return the longest successful draft so the user doesn't get an empty screen
    const bestDraft = successfulDrafts.reduce((a, b) =>
      a.text.length > b.text.length ? a : b
    );

    publishUiSyncEvent({
      topic: "chat",
      chatId,
      nodeType: "system_node",
      swarmNode: {
        nodeId: aggregatorNodeId,
        parentNodeId: routerNodeId,
        role: "orchestrator",
        taskSummary: `Synthesis Failed: ${errMsg}`,
        status: "error",
        completedAt: new Date().toISOString(),
      },
    });

    return {
      text: bestDraft.text + `\n\n---\n_Note: MoA aggregation failed (${errMsg}), showing best individual draft._`,
      drafts,
      aggregationLatencyMs: Date.now() - aggStart,
      totalLatencyMs: Date.now() - totalStart,
      cumulativeUsage: moaUsage,
    };
  }
}
