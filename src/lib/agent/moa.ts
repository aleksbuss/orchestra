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

import { generateText, stepCountIs, type ModelMessage } from "ai";
import { addUsageToCumulative, mergeUsage } from "@/lib/cost/accumulator";
import type { ChatUsage } from "@/lib/types";
import { reflectOnResponse, reviseWithCritique } from "@/lib/agent/reflection";
import { embedTexts } from "@/lib/memory/embeddings";
import {
  buildDisagreementMarker,
  DEFAULT_DISAGREEMENT_THRESHOLD,
  detectDisagreement,
} from "@/lib/agent/disagreement";
import { createModel } from "@/lib/providers/llm-provider";
import type { AppSettings } from "@/lib/types";
import { getBrainConfig, getWorkerConfig, type PresetTier } from "@/lib/agent/presets";
import { agentSemaphore } from "./semaphore";
import { publishUiSyncEvent } from "@/lib/realtime/event-bus";

import { getWorkDir } from "@/lib/storage/project-store";
import {
  captureSuccessfulTrace,
  formatTracesAsFewShots,
  retrieveRelevantTraces,
  type TraceSignals,
} from "@/lib/agent/trace-memory";
import { runTournamentAggregation } from "@/lib/agent/tournament-aggregator";

// ── MoA Proposer Perspectives ───────────────────────────────────────────
//
// PM #57 — extracted to `moa-personas.ts` to bring this file back under
// the 1500-line hard cap. All symbols re-exported below for callers
// and tests that import from `./moa`.

export {
  type ProposerTier,
  type MoAProposer,
  type ProposerRole,
  MOA_PROPOSERS,
  deriveTierFromRole,
  detectProposerRole,
  resolveWorkerKey,
  resolveProposerModelConfig,
} from "@/lib/agent/moa-personas";

import {
  detectProposerRole,
  resolveProposerModelConfig,
  resolveWorkerKey,
} from "@/lib/agent/moa-personas";


// ── Dynamic Persona Generation (DPG) ────────────────────────────────────
//
// PM #57 — extracted to `moa-router.ts`. Re-export for callers/tests.

export {
  generateDynamicSwarm,
  type DPGResult,
} from "@/lib/agent/moa-router";

import { generateDynamicSwarm } from "@/lib/agent/moa-router";
import { isSearchUsable } from "@/lib/tools/search-engine";


/**
 * PM #66 — per-proposer start stagger (ms × proposer index). Small by design:
 * just enough to break the simultaneous request burst on rate-limited free
 * tiers. The semaphore + the SDK's 429 backoff do the heavy lifting; this only
 * avoids the initial thundering herd.
 */
const PROPOSER_STAGGER_MS = 250;

// ── Local cosine similarity (PM #46 convergence check) ─────────────────
// Same algorithm as in `disagreement.ts` and `blackboard.ts`. Inlined here
// to keep the import surface tight; if a fourth caller materialises,
// extract to `src/lib/memory/embeddings.ts`.
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ── Proposer role + tool plumbing (PM #42 + #50) ────────────────────────
//
// PM #57 — extracted to `moa-proposer-tools.ts`. Symbols re-exported
// below for backward compatibility with callers and tests.

export {
  selectProposerTools,
  augmentProposerPromptForTools,
  isSuccessfulDraft,
  FACT_CHECK_MANDATE,
  CODE_EXECUTION_MANDATE,
} from "@/lib/agent/moa-proposer-tools";

import {
  selectProposerTools,
  augmentProposerPromptForTools,
  isSuccessfulDraft,
} from "@/lib/agent/moa-proposer-tools";


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

// PM #57 — `resolveWorkerKey` moved to moa-personas.ts (imported at top).

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
  
  // PM #68 — gate proposer search tools on search being USABLE (key present),
  // not merely enabled, so the Skeptic/researcher aren't handed a search_web
  // that can only return "key not configured".
  const searchEnabled = isSearchUsable(settings.search);

  // PM #51 — fetch past successful traces similar to this prompt and
  // render them as few-shots for the Router. When trace memory is off
  // or no relevant traces exist, this resolves to an empty string and
  // the Router runs exactly as before (pre-PM-51 behavior, exact
  // backward compat). Retrieval errors degrade silently to empty.
  let fewShotsBlock = "";
  try {
    // PM #55 — pass projectId for per-project scoping. Global chats
    // (projectId undefined) retrieve from the global pool, project
    // chats from their own pool. No cross-project contamination.
    const retrieved = await retrieveRelevantTraces(userMessage, settings, {
      projectId,
    });
    if (retrieved.length > 0) {
      fewShotsBlock = formatTracesAsFewShots(retrieved);
      console.log(
        `[MoA] Trace memory: injected ${retrieved.length} past-run fewshot${retrieved.length === 1 ? "" : "s"} (top similarity ${retrieved[0].similarity.toFixed(3)}).`
      );
    }
  } catch (err) {
    console.warn(
      "[MoA] Trace-memory retrieval failed (non-fatal):",
      err instanceof Error ? err.message : err
    );
  }

  const dpgResult = await generateDynamicSwarm(userMessage, history, routerConfig, searchEnabled, abortSignal, fewShotsBlock);

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

    // 2. Small staggered start to break the simultaneous request burst on
    // free/cheap tiers (e.g. OpenRouter). PM #66 — was `index * 1000` (up to
    // ~4s of added latency for 5 proposers). The `agentSemaphore` already
    // bounds concurrent in-flight requests and the AI SDK's `maxRetries` (=2)
    // already backs off on 429, so a much smaller jittered stagger suffices to
    // avoid the initial thundering herd without the linear latency pile-up.
    if (index > 0) {
      const stagger = index * PROPOSER_STAGGER_MS + Math.floor(Math.random() * 150);
      await new Promise((resolve) => setTimeout(resolve, stagger));
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

      // PM #48 — resolve the per-proposer ModelConfig. When the operator
      // hasn't configured `settings.proposerTiers`, this returns
      // `workerConfig` for every proposer (exact pre-PM-48 behavior). When
      // they have, each proposer lands on the tier matching its picked-or-
      // derived tier (Skeptic → fast, Coder → frontier, etc.). Resolved
      // outside the try/catch so the error branch can attribute its (zero)
      // usage to the same provider/model that would have run.
      const { config: proposerConfig, tier: proposerTier } =
        resolveProposerModelConfig(proposer, workerConfig, settings);
      const resolvedProvider = proposerConfig.provider;
      const resolvedModel = proposerConfig.model;

      try {
        const workerModel = createModel(proposerConfig, { projectId, currentPath });

        // PM #42 — extracted to a reusable helper so the role detection
        // (UI icon, tool assignment, prompt augmentation) goes through
        // one place and stays consistent. The exported `detectProposerRole`
        // is also used by tests and future eval cases.
        const standardRole = detectProposerRole(proposer);

        const messages: ModelMessage[] = [
          ...safeHistory.slice(-6), // Limit context to 6 text messages
          { role: "user", content: userMessage },
        ];

        // PM #42 — role-aware tool assignment. Reviewer + researcher get
        // `search_web` (with the Fact-Check Mandate). PM #50 extends this
        // to give coder personas `code_execution` when the operator has
        // opted in via `settings.codeExecution.proposerAccess === true`
        // (off by default — child-process-per-proposer is a heavier
        // failure surface than search_web and warrants explicit consent).
        const proposerTools = selectProposerTools(
          standardRole,
          searchEnabled,
          settings.search,
          {
            settings,
            // Proposers run in the project root (or sandbox root for
            // global chats). Sub-paths aren't supported on the proposer
            // surface — they're synthesizers, not navigators.
            cwd: getWorkDir(projectId),
          }
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
          // PM #48 — temperature/maxTokens read from the RESOLVED config
          // (proposerConfig), not workerConfig. A tier slot can override
          // both alongside the model id.
          temperature: proposerConfig.temperature ?? workerConfig.temperature ?? 0.5,
          // PM #66 — proposers are INTERMEDIATE "draft" outputs that feed the
          // aggregator and run N-way PARALLEL, so they keep a bounded ceiling
          // (like the codebase's other intermediate calls — critic=256,
          // title-gen=Math.min(…,1200)). A re-audit found that removing the cap
          // entirely risked an ~Nx cost blow-up when an operator sets a high
          // utility maxTokens. We respect a configured maxTokens UP TO a ceiling
          // (raised 2048 → 4096 so genuinely long drafts aren't truncated),
          // defaulting to 2048 when unset. The final-answer paths (aggregator,
          // bypass, revisor) are uncapped — they're 1×, not N×.
          maxOutputTokens: Math.min(proposerConfig.maxTokens ?? workerConfig.maxTokens ?? 2048, 4096),
          tools: proposerTools,
          // PM #65 — proposer tool-loop bound. AI SDK v5+ REMOVED `maxSteps`
          // from generateText; the old `maxSteps: …` here was silently ignored
          // (it is not a CallSettings field), so generateText fell back to its
          // default `stepCountIs(1)`. A tool-using proposer (the Skeptic /
          // researcher with `search_web`) therefore stopped right after emitting
          // the tool call — no follow-up generation, empty `text`, "(empty
          // draft)" → dropped by `isSuccessfulDraft`. Use `stopWhen` like the
          // agent path: tool proposers get up to 3 steps (call → result →
          // answer); tool-less proposers do a single generation (was the
          // PM #42 intent — a coder without tools shouldn't pay for tool rounds).
          stopWhen: stepCountIs(proposerTools ? 3 : 1),
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
          // PM #48 — carry the resolved provider/model so the post-reduce
          // usage attribution lands on the actual model that ran, not the
          // uniform workerConfig. Without this, PM #36's per-call cost
          // banner mis-attributes spend whenever tiers route proposers to
          // different providers.
          resolvedProvider,
          resolvedModel,
          resolvedTier: proposerTier,
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
          resolvedProvider,
          resolvedModel,
          resolvedTier: proposerTier,
        };
      }
    });

  });

  const draftsWithUsage = await Promise.all(proposerPromises);
  const proposerLatency = Date.now() - proposerStart;

  // PM #36 — fold each successful proposer's usage into the running total.
  // Reduce runs single-threaded after Promise.all settles, so no race here.
  // PM #48 — attribute usage to the RESOLVED provider/model (the tier the
  // proposer actually used), not the uniform workerConfig. With per-role
  // tiers a single MoA call can hit 3 different providers; uniform
  // attribution would mis-bill all of them to whichever model happens to
  // be in workerConfig.
  for (const d of draftsWithUsage) {
    if ("rawUsage" in d && d.rawUsage) {
      moaUsage = addUsageToCumulative(
        moaUsage,
        d.resolvedProvider,
        d.resolvedModel,
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

  const successfulDrafts = drafts.filter((d) => isSuccessfulDraft(d.text));
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

  // PM #52 — tournament mode branch. When the operator picks
  // `settings.aggregator.mode === "tournament"`, K judges rank the
  // drafts and Borda count picks the winner. The winning draft IS the
  // final answer (no synthesis). Falls back to synthesis if every
  // judge fails — better degraded output than no output.
  const aggregatorMode = settings.aggregator?.mode ?? "synthesis";
  const brainModel = createModel(brainConfig, { projectId, currentPath });

  if (aggregatorMode === "tournament") {
    console.log(
      `[MoA] Starting TOURNAMENT aggregation: ${settings.aggregator?.tournamentJudgeCount ?? 1} judge(s), ${successfulDrafts.length} drafts.`
    );
    try {
      const judgeConfig = settings.aggregator?.tournamentJudgeModel
        ? resolveWorkerKey(settings.aggregator.tournamentJudgeModel, settings)
        : brainConfig;
      const tournament = await runTournamentAggregation({
        drafts: successfulDrafts.map((d) => ({
          proposerId: d.proposerId,
          role: d.role,
          text: d.text,
        })),
        userMessage,
        judgeConfig,
        judgeCount: settings.aggregator?.tournamentJudgeCount ?? 1,
        abortSignal,
      });
      // PM #36 — fold the tournament judges' usage into the running
      // total. The tournament module already pre-aggregates across K
      // judges via addUsageToCumulative, so we merge the final.
      if (tournament.cumulativeUsage) {
        moaUsage = mergeUsage(moaUsage, tournament.cumulativeUsage);
      }

      if (tournament.winnerProposerId && tournament.winningText) {
        const aggregationLatencyMs = tournament.latencyMs;
        const finalText = tournament.winningText;
        console.log(
          `[MoA] Tournament winner: ${tournament.winnerProposerId} (Borda points: ${tournament.borda.scores[0]?.points ?? 0}, ${tournament.successfulJudgeCount}/${settings.aggregator?.tournamentJudgeCount ?? 1} judges succeeded).`
        );

        publishUiSyncEvent({
          topic: "chat",
          chatId,
          nodeType: "system_node",
          swarmNode: {
            nodeId: aggregatorNodeId,
            parentNodeId: routerNodeId,
            role: "orchestrator",
            taskSummary: `Tournament Winner: ${tournament.winnerProposerId}`,
            status: "completed",
            completedAt: new Date().toISOString(),
          },
        });

        // PM #52 — tournament mode skips reflection. The winning draft
        // is one of the proposer drafts verbatim; running reflection
        // against it would re-judge what was just judged. Trace memory
        // still captures the run (reflectionRounds=0 in signals).
        const totalLatencyMs = Date.now() - totalStart;
        try {
          const traceSignals: TraceSignals = {
            proposerSuccessRatio:
              drafts.length === 0
                ? 0
                : successfulDrafts.length / drafts.length,
            disagreementDetected: disagreement.detected,
            disagreementMaxDistance: disagreement.maxDistance,
            reflectionRounds: 0,
            reflectionHitCap: false,
            totalLatencyMs,
            // PM #55 — record mode so retrieval can later filter or
            // weight traces by aggregator path.
            aggregatorMode: "tournament",
          };
          const captureResult = await captureSuccessfulTrace({
            userPrompt: userMessage,
            finalText,
            signals: traceSignals,
            brainConfig,
            settings,
            projectId,
          });
          if (captureResult.captured) {
            console.log(
              `[MoA] Trace memory: captured tournament trace ${captureResult.traceId} (score ${captureResult.qualityScore.toFixed(3)}).`
            );
          }
        } catch (captureErr) {
          console.warn(
            "[MoA] Trace-memory capture (tournament) failed (non-fatal):",
            captureErr instanceof Error ? captureErr.message : captureErr
          );
        }

        return {
          text: finalText,
          drafts,
          aggregationLatencyMs,
          totalLatencyMs,
          cumulativeUsage: moaUsage,
        };
      }

      // All judges failed → fall through to synthesis as last resort.
      console.warn(
        `[MoA] Tournament produced no winner (all ${settings.aggregator?.tournamentJudgeCount ?? 1} judges failed). Falling back to synthesis aggregator.`
      );
    } catch (tournErr) {
      console.warn(
        "[MoA] Tournament aggregation failed (non-fatal). Falling back to synthesis:",
        tournErr instanceof Error ? tournErr.message : tournErr
      );
    }
  }

  console.log(`[MoA] Starting aggregation with model: ${brainConfig.provider}/${brainConfig.model} (${aggregatorPrompt.length} chars)`);

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

    // PM #38 (single round) + PM #46 (multi-round) — generator-critic-
    // revisor loop. When the operator enables settings.reflection.enabled,
    // the aggregator output is reviewed by the utility-model critic; when
    // the critic flags issues, the brain-model revisor produces a fixed
    // version, the critic re-examines, etc.
    //
    // Two stopping conditions:
    //   1. Critic returns shouldRevise=false → answer is good, exit.
    //   2. Successive revisions are nearly identical (cosine similarity
    //      over embeddings > convergenceThreshold) → the model is
    //      oscillating between rephrasings; exit to avoid waste.
    //
    // Plus a code-level hard cap (`ABSOLUTE_MAX_REFLECTION_ROUNDS = 50`)
    // protects against accidental runaway when the operator sets a
    // maxRounds higher than they meant to. Cost is visible per-turn via
    // PM #36 budget banner.
    //
    // PM #51 — three locals track behavior for trace-memory capture:
    //   - reflectionRevisionsExecuted: number of times reviseWithCritique
    //     ran (== "rounds where something needed fixing"). Zero means the
    //     critic was clean from round 1 — strongest quality signal.
    //   - reflectionCriticCleanedUp: true when the loop exited because
    //     the critic said `shouldRevise=false` (not because of cap).
    //   - reflectionHitCap: derived after the loop. True means we ran
    //     out of rounds without the critic ever cleaning up.
    let reflectionRevisionsExecuted = 0;
    let reflectionCriticCleanedUp = false;
    let reflectionHitCap = false;
    if (settings.reflection?.enabled) {
      const ABSOLUTE_MAX_REFLECTION_ROUNDS = 50;
      const requestedMaxRounds = Math.max(
        1,
        Math.floor(settings.reflection.maxRounds ?? 1)
      );
      const effectiveMaxRounds = Math.min(
        requestedMaxRounds,
        ABSOLUTE_MAX_REFLECTION_ROUNDS
      );
      const convergenceThreshold = Math.min(
        1,
        Math.max(0, settings.reflection.convergenceThreshold ?? 0.97)
      );

      try {
        let previousText: string | null = null;
        let round = 0;
        while (round < effectiveMaxRounds) {
          round += 1;
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

          // Stopping condition 1: critic says we're done.
          if (!reflection.shouldRevise || !reflection.critique) {
            console.log(
              `[MoA] Reflection round ${round}/${effectiveMaxRounds}: critic clean, stopping.`
            );
            reflectionCriticCleanedUp = true;
            break;
          }

          console.log(
            `[MoA] Reflection round ${round}/${effectiveMaxRounds}: revising. Critique: ${reflection.critique.slice(0, 120)}`
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

          previousText = finalText;
          finalText = revision.text;
          reflectionRevisionsExecuted += 1;

          // Stopping condition 2: convergence (successive revisions are
          // nearly identical). Skip the convergence check entirely when
          // maxRounds === 1 (no chance for oscillation; saves an embed).
          if (effectiveMaxRounds > 1 && previousText) {
            try {
              const [embA, embB] = await embedTexts(
                [
                  previousText.slice(0, 4000),
                  finalText.slice(0, 4000),
                ],
                {
                  provider: settings.embeddingsModel.provider,
                  model: settings.embeddingsModel.model,
                  apiKey: settings.embeddingsModel.apiKey,
                  baseUrl: settings.embeddingsModel.baseUrl,
                  dimensions: settings.embeddingsModel.dimensions,
                }
              );
              const similarity = cosineSimilarity(embA, embB);
              if (similarity >= convergenceThreshold) {
                console.log(
                  `[MoA] Reflection round ${round}/${effectiveMaxRounds}: converged (cosine ${similarity.toFixed(3)} >= ${convergenceThreshold}), stopping.`
                );
                break;
              }
              console.log(
                `[MoA] Reflection round ${round}/${effectiveMaxRounds}: revision applied (cosine ${similarity.toFixed(3)} < ${convergenceThreshold}, continuing).`
              );
            } catch (embedErr) {
              // Embedding failure is non-fatal — drop the convergence
              // check for this round, keep looping on the critic signal.
              console.warn(
                "[MoA] Convergence check embedding failed (non-fatal):",
                embedErr instanceof Error ? embedErr.message : String(embedErr)
              );
            }
          }
        }
        if (round >= effectiveMaxRounds && effectiveMaxRounds > 1) {
          console.log(
            `[MoA] Reflection hit maxRounds cap (${effectiveMaxRounds}). Shipping current text.`
          );
          // PM #51 — hit the cap WITHOUT the critic ever cleaning up means
          // the model couldn't converge. Recorded for trace quality score.
          if (!reflectionCriticCleanedUp) reflectionHitCap = true;
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

    const totalLatencyMs = Date.now() - totalStart;

    // PM #51 — capture this run as a trace if quality signals pass the
    // threshold. Best-effort; failures are logged but don't affect the
    // user-facing response. The capture happens AFTER finalText is
    // finalized (post-reflection) so a low-quality run that needed many
    // revisions doesn't poison the few-shot pool.
    try {
      const traceSignals: TraceSignals = {
        proposerSuccessRatio:
          drafts.length === 0
            ? 0
            : successfulDrafts.length / drafts.length,
        disagreementDetected: disagreement.detected,
        disagreementMaxDistance: disagreement.maxDistance,
        reflectionRounds: reflectionRevisionsExecuted,
        reflectionHitCap,
        totalLatencyMs,
        // PM #55 — record mode so retrieval can later filter/weight
        // traces by aggregator path. Default = "synthesis" here.
        aggregatorMode: "synthesis",
      };
      const captureResult = await captureSuccessfulTrace({
        userPrompt: userMessage,
        finalText,
        signals: traceSignals,
        brainConfig,
        settings,
        projectId,
      });
      if (captureResult.captured) {
        console.log(
          `[MoA] Trace memory: captured trace ${captureResult.traceId} (score ${captureResult.qualityScore.toFixed(3)}).`
        );
      } else if (settings.traceMemory?.enabled) {
        // Only log skip reasons when the feature is actually on; otherwise
        // the "trace-memory disabled" reason fires on every turn.
        console.log(
          `[MoA] Trace memory: skipped capture (${captureResult.reason}).`
        );
      }
    } catch (captureErr) {
      console.warn(
        "[MoA] Trace-memory capture failed (non-fatal):",
        captureErr instanceof Error ? captureErr.message : captureErr
      );
    }

    return {
      text: finalText,
      drafts,
      aggregationLatencyMs,
      totalLatencyMs,
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
