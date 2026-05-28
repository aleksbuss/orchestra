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

import { generateText, generateObject, tool, type ModelMessage, type ToolSet } from "ai";
import { addUsageToCumulative } from "@/lib/cost/accumulator";
import type { ChatUsage } from "@/lib/types";
import { reflectOnResponse, reviseWithCritique } from "@/lib/agent/reflection";
import {
  buildDisagreementMarker,
  DEFAULT_DISAGREEMENT_THRESHOLD,
  detectDisagreement,
} from "@/lib/agent/disagreement";
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
    //
    // PM #45 — skeptic detection now goes through `detectProposerRole`
    // (the same helper PM #42's tool routing uses). Previously this site
    // had its own narrower SKEPTIC_PATTERN that missed "qa", "quality",
    // "review" — so a DPG-returned persona like "qa_engineer" would be
    // classified as a reviewer by PM #42 (gets search_web) but NOT seen
    // as a skeptic by PM #37 → critic was force-injected anyway, leaving
    // the swarm with two reviewer-shape personas competing for the same
    // role. Single source of truth fixes the inconsistency.
    const hasSkeptic = (object.personas as MoAProposer[]).some(
      (p) => detectProposerRole(p) === "reviewer"
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

// ── Proposer role + tool plumbing (PM #42) ──────────────────────────────
//
// Per-role tool assignment. Previously every proposer got `search_web` when
// search was enabled (blanket access) — a creative-brainstorming persona
// would have access to web search it never used, and the prompt didn't
// mandate verification, so fact-heavy personas often hallucinated library
// versions despite having the tool available.
//
// PM #42 splits this in two:
//   1. Role-aware tool selection — only reviewer/researcher personas get
//      `search_web`. Coder/tool/creative get no tools (focus on synthesis
//      from training data; cost stays bounded).
//   2. Prompt augmentation — personas that DO get search_web also get the
//      Fact-Check Mandate appended to their system prompt, telling them to
//      VERIFY library versions / API signatures / real-time facts BEFORE
//      drafting an answer.
//
// Code-execution-for-coder-personas is deliberately deferred to v2:
// process/session lifecycle from N parallel proposers spawning code is a
// new failure surface; we want eval data first.

export type ProposerRole = "coder" | "researcher" | "reviewer" | "tool" | "orchestrator";

export function detectProposerRole(proposer: MoAProposer): ProposerRole {
  // PM #45 — include `role` in the blob. Previously this helper looked
  // only at id + systemPrompt, but personas like `{ id: "beta", role:
  // "Code Reviewer", systemPrompt: "..." }` would slip through if the
  // role keyword appeared only in `role`. The pre-PM-45 SKEPTIC_PATTERN
  // (which this helper replaces in `generateDynamicSwarm`) explicitly
  // checked id || role, so the migration must too.
  const blob = (proposer.id + " " + proposer.role + " " + proposer.systemPrompt).toLowerCase();
  if (/review|critic|audit|qa|quality|skeptic|adversar|red.?team|fact.?check/.test(blob)) {
    return "reviewer";
  }
  if (/research|analys|architect|domain|expert|chameleon|first.?prin/.test(blob)) {
    return "researcher";
  }
  if (/tool|executor|pragmat|deploy|infra|devops|implement/.test(blob)) {
    return "tool";
  }
  return "coder";
}

/**
 * Returns the tool set for this proposer's role. Reviewer + researcher
 * personas get `search_web` (fact-checking / research workflows depend on
 * real-time external data). Everything else gets `undefined` — the
 * synthesizer's job is to ideate from existing knowledge, not browse.
 *
 * When the operator hasn't enabled search, this returns `undefined`
 * regardless of role.
 */
export function selectProposerTools(
  role: ProposerRole,
  searchEnabled: boolean,
  searchConfig: AppSettings["search"]
): ToolSet | undefined {
  if (!searchEnabled) return undefined;
  if (role !== "reviewer" && role !== "researcher") return undefined;
  return {
    search_web: tool({
      description: "Search the internet for real-time information, facts, and live data.",
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }, { abortSignal }) => {
        return searchWeb(query, 5, searchConfig, abortSignal);
      },
    }),
  };
}

/**
 * Fact-Check Mandate appended to a proposer's system prompt when it has
 * access to `search_web`. Without this, the LLM has the tool but no
 * instruction to use it for verification — proposers reliably hallucinated
 * library versions despite tool availability.
 */
export const FACT_CHECK_MANDATE = `

[FACT-CHECK MANDATE — you have access to search_web]
You MUST invoke the search_web tool BEFORE making any claim that depends on:
  - Library or framework versions (e.g., "Next.js 15", "React 19", "Tailwind v4")
  - API signatures, function names, or recent breaking changes
  - Real-time facts (news, prices, status, market data)
  - Specific URLs, package names, or model IDs the user provided

If you cannot verify a claim through search_web (rate-limited, no result, ambiguous), state that explicitly in your draft ("I could not verify X via search; this is my best understanding from training") rather than asserting it with false confidence.`;

export function augmentProposerPromptForTools(
  basePrompt: string,
  tools: ToolSet | undefined
): string {
  if (!tools || !("search_web" in tools)) return basePrompt;
  return basePrompt + FACT_CHECK_MANDATE;
}

// ── Aggregator Prompt ───────────────────────────────────────────────────
// PM #40 — synthesis prompt adapted from Together AI's MoA paper template
// (togethercomputer/MoA `prompts.py`), which was validated at 65.1% on
// AlpacaEval and beat GPT-4o (57.5%) using only open-source models.
//
// Key adaptations from the original:
//   - Orchestra-specific code-block preservation rule (genuinely useful
//     for the operator's primary workflows).
//   - "No meta-commentary" rule (cuts the "Based on the drafts above..."
//     preamble that bloats outputs).
//   - Cross-reference to the PM #39 disagreement marker — when present in
//     the user content, the synthesizer is reminded to follow its
//     instructions explicitly.
//
// The system role carries IDENTITY + RULES (stable across turns); the
// user content carries DATA (original request + numbered drafts). This
// is the cleaner split — previously the system was a one-liner and the
// rules were duplicated in the user content.

export const AGGREGATOR_SYSTEM_PROMPT = `You are the Aggregator at the final stage of a Mixture-of-Agents (MoA) pipeline. You have been provided with a set of responses from specialized expert agents who analyzed the user's request in parallel. Your task is to synthesize these responses into a single, high-quality reply.

It is crucial to critically evaluate the information in the expert responses, recognizing that some of it may be biased, incomplete, or incorrect. Your response should NOT simply replicate or vote-aggregate the drafts — it should offer a refined, accurate, and comprehensive reply that goes beyond any individual draft.

Strict rules:
1. PRESERVE TECHNICAL DETAIL. Specific version numbers, library names, API signatures, configuration values — keep them. Do NOT summarize them away.
2. CODE BLOCK INTEGRITY. Include all relevant code from the drafts. When drafts disagree on implementation, pick the most robust + production-ready version (or merge with explanatory comments). NEVER skip code to save space.
3. NO META-COMMENTARY. Start directly with the answer. Do NOT begin with "Based on the drafts" / "Here is the synthesis" / "Looking at the responses" / "After analyzing the experts".
4. CONFLICT RESOLUTION. If experts disagree on a factual claim (library version, API behavior, etc.), use your knowledge to pick the most accurate and modern choice. If you see a "<<DISAGREEMENT_DETECTED>>" marker in the user content, follow its additional instructions exactly — surface the conflict to the user, do not smooth it away.
5. MATCH USER'S FORMAT. Mirror the user's expected output structure (code-only, markdown with headers, JSON, plain prose) — don't add ceremony the user didn't ask for.
6. CORRECT SILENTLY. If you spot factual errors in the drafts, correct them in your synthesis without explicitly calling out the original mistake.

Adhere to the highest standards of accuracy and reliability.`;

function buildAggregatorPrompt(userMessage: string, drafts: { role: string; text: string }[]): string {
  // Numbered format matches Together MoA's reference template — empirically
  // tuned for LLM synthesis quality. Role label stays as a hint, not a
  // hierarchy ("expert N (role: ...)") so the synthesizer doesn't infer
  // implicit priority from order.
  const draftBlock = drafts
    .map((d, i) => `${i + 1}. [Expert role: ${d.role}]\n${d.text}`)
    .join("\n\n");

  return `Original user request:
${userMessage}

Responses from expert agents (treat each as a candidate, not as authority):

${draftBlock}

Now produce the final synthesized response.`;
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

        // PM #42 — extracted to a reusable helper so the role detection
        // (UI icon, tool assignment, prompt augmentation) goes through
        // one place and stays consistent. The exported `detectProposerRole`
        // is also used by tests and future eval cases.
        const standardRole = detectProposerRole(proposer);

        const messages: ModelMessage[] = [
          ...safeHistory.slice(-6), // Limit context to 6 text messages
          { role: "user", content: userMessage },
        ];

        // PM #42 — role-aware tool assignment. Only reviewer + researcher
        // personas get `search_web`; coder/tool/creative get no tools (the
        // aggregator stitches their training-data ideation with the
        // fact-checked claims from the research personas). When a persona
        // DOES get search_web, the Fact-Check Mandate is appended to its
        // system prompt — having the tool without the mandate was the
        // observed cause of hallucinated library versions.
        const proposerTools = selectProposerTools(
          standardRole,
          searchEnabled,
          settings.search
        );
        const augmentedSystemPrompt = augmentProposerPromptForTools(
          proposer.systemPrompt,
          proposerTools
        );

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
          // PM #42 — system prompt is augmented with the Fact-Check Mandate
          // when this proposer was assigned search_web (reviewer / researcher).
          // For other roles, augmentedSystemPrompt === proposer.systemPrompt
          // verbatim.
          system: augmentedSystemPrompt,
          messages,
          temperature: workerConfig.temperature ?? 0.5,
          maxOutputTokens: Math.min(workerConfig.maxTokens ?? 2048, 2048),
          tools: proposerTools,
          // PM #42 — maxSteps gates on whether THIS proposer has tools.
          // Previously `searchEnabled ? 3 : 1`, but a coder persona without
          // tools wasting two tool-call rounds was paying for nothing.
          // @ts-expect-error maxSteps is supported in newer versions but might not be in the local types for generateText
          maxSteps: proposerTools ? 3 : 1,
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

  // PM #39 — disagreement detection. Embed each draft, compute pairwise
  // cosine distance, and if the max exceeds the threshold, prepend a
  // marker to the aggregator prompt telling the synthesizer to surface
  // the conflict instead of smoothing it away. Non-fatal — embedding
  // failure falls through to the default aggregator behavior.
  const disagreement = await detectDisagreement(
    successfulDrafts.map((d) => ({ text: d.text, role: d.role })),
    settings,
    DEFAULT_DISAGREEMENT_THRESHOLD,
    abortSignal
  );
  if (disagreement.ranSuccessfully) {
    console.log(
      `[MoA] Disagreement check: max distance ${disagreement.maxDistance.toFixed(3)} (threshold ${disagreement.threshold}), avg ${disagreement.averageDistance.toFixed(3)} across ${disagreement.pairCount} pairs → ${disagreement.detected ? "DETECTED" : "consensus"}`
    );
    if (disagreement.detected) {
      publishUiSyncEvent({
        topic: "chat",
        chatId,
        projectId: projectId ?? null,
        reason: `[MoA] Expert proposers diverged (cosine distance ${disagreement.maxDistance.toFixed(2)} > ${disagreement.threshold}). Synthesizer will flag the conflict instead of smoothing it.`,
      });
    }
  }
  const disagreementMarker = buildDisagreementMarker(disagreement);
  const aggregatorPrompt = disagreementMarker + buildAggregatorPrompt(userMessage, successfulDrafts);

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
      // PM #40 — full identity + synthesis rules live in the system prompt.
      // User content carries only the data (original request + drafts +
      // optional <<DISAGREEMENT_DETECTED>> marker from PM #39).
      system: AGGREGATOR_SYSTEM_PROMPT,
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
    let finalText = aggResult.text?.trim() || "(aggregation produced empty output)";

    console.log(`[MoA] Aggregation completed in ${aggregationLatencyMs}ms (${finalText.length} chars)`);

    // PM #36 — fold the aggregator's tokens into the running total.
    moaUsage = addUsageToCumulative(
      moaUsage,
      brainConfig.provider,
      brainConfig.model,
      aggResult.usage
    );

    // PM #38 — generator-critic-revisor loop. Wires the previously-dead
    // reflection.ts module into the MoA flow. When the operator enables
    // `settings.reflection.enabled`, the aggregator output is reviewed by
    // a cheap utility-model critic; flagged issues trigger one revisor
    // pass on the brain model. Capped at ONE round — the cost is now
    // visible in the budget banner (PM #36), but two-round runaway is
    // architecturally easy and we don't want to ship that footgun yet.
    if (settings.reflection?.enabled) {
      try {
        const reflection = await reflectOnResponse({
          userMessage,
          agentResponse: finalText,
          settings,
          projectId,
          abortSignal,
        });
        if (reflection.usage && reflection.modelConfig) {
          moaUsage = addUsageToCumulative(
            moaUsage,
            reflection.modelConfig.provider,
            reflection.modelConfig.model,
            reflection.usage
          );
        }
        if (reflection.shouldRevise && reflection.critique) {
          console.log(
            `[MoA] Reflection flagged the aggregator output — revising. Critique: ${reflection.critique.slice(0, 120)}`
          );
          const revision = await reviseWithCritique({
            userMessage,
            originalResponse: finalText,
            critique: reflection.critique,
            suggestion: reflection.suggestion,
            settings,
            modelOverride: brainConfig,
            projectId,
            abortSignal,
          });
          if (revision.usage && revision.modelConfig) {
            moaUsage = addUsageToCumulative(
              moaUsage,
              revision.modelConfig.provider,
              revision.modelConfig.model,
              revision.usage
            );
          }
          finalText = revision.text;
          console.log(
            `[MoA] Reflection revision applied (${finalText.length} chars after revise)`
          );
        }
      } catch (reflectionErr) {
        // Reflection is a quality-improvement pass, never a blocker — log
        // and continue with the un-revised aggregator output.
        console.warn(
          "[MoA] Reflection loop failed (non-fatal, keeping original):",
          reflectionErr
        );
      }
    }

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
