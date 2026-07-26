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
import { resolveMaxOutputTokens } from "@/lib/providers/model-output-limits";
import { addUsageToCumulative, mergeUsage } from "@/lib/cost/accumulator";
import type { ChatUsage } from "@/lib/types";
import {
  buildDisagreementMarker,
  DEFAULT_DISAGREEMENT_THRESHOLD,
  detectDisagreement,
} from "@/lib/agent/disagreement";
import { runReflectionLoop } from "@/lib/agent/moa-reflection";
import { createModel } from "@/lib/providers/llm-provider";
import { modelSupportsTools } from "@/lib/providers/tool-support";
import { applyGlobalToolLoopGuard } from "@/lib/agent/tool-guard";
import { createTokenGovernor } from "@/lib/agent/token-governor";
import type { AppSettings } from "@/lib/types";
import { getBrainConfig, type PresetTier } from "@/lib/agent/presets";
import { resolveEnsembleSetup } from "@/lib/agent/moa-setup";
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
  type SkepticModelOverride,
  MOA_PROPOSERS,
  deriveTierFromRole,
  detectProposerRole,
  resolveWorkerKey,
  resolveProposerModelConfig,
  resolveSkepticModelConfig,
  isValidSkepticOverride,
  modelFamily,
  detectSkepticFamilyOverlap,
} from "@/lib/agent/moa-personas";

import {
  detectProposerRole,
  resolveProposerModelConfig,
  resolveWorkerKey,
  warnSkepticFamilyOverlapOnce, type SkepticModelOverride,
} from "@/lib/agent/moa-personas";
export { createWindowResolver } from "@/lib/agent/moa-window";


// ── Dynamic Persona Generation (DPG) ────────────────────────────────────
//
// PM #57 — extracted to `moa-router.ts`. Re-export for callers/tests.

export {
  generateDynamicSwarm,
  type DPGResult,
} from "@/lib/agent/moa-router";

import { generateDynamicSwarm } from "@/lib/agent/moa-router";


/**
 * PM #66 — per-proposer start stagger (ms × proposer index). Small by design:
 * just enough to break the simultaneous request burst on rate-limited free
 * tiers. The semaphore + the SDK's 429 backoff do the heavy lifting; this only
 * avoids the initial thundering herd.
 */
const PROPOSER_STAGGER_MS = 250;

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
  PROPOSER_NO_TOOLS_DIRECTIVE,
} from "@/lib/agent/moa-proposer-tools";

import {
  selectProposerTools,
  augmentProposerPromptForTools,
  isSuccessfulDraft,
} from "@/lib/agent/moa-proposer-tools";


// ── Aggregator prompts ──────────────────────────────────────────────────
// §10 (Sprint 5) — the pure prompt builders (AGGREGATOR_SYSTEM_PROMPT,
// buildAggregatorPrompt, buildInlineSynthesisInjection) moved to
// `moa-prompts.ts`. Re-exported here for external callers/tests (agent.ts,
// moa.test.ts); imported below for internal use.
export {
  AGGREGATOR_SYSTEM_PROMPT,
  buildInlineSynthesisInjection,
} from "@/lib/agent/moa-prompts";
import {
  AGGREGATOR_SYSTEM_PROMPT,
  buildAggregatorPrompt,
  buildProposerContextBlock,
} from "@/lib/agent/moa-prompts";

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
  /** DDD — per-request Skeptic override; see `resolveSkepticModelConfig`. */
  skepticModelOverride?: SkepticModelOverride | null;
  /** DDD — per-request Deep Audit (reflection) toggle; overrides settings. */
  deepAudit?: boolean;
}

export interface MoAResult {
  /** Final aggregated text */
  text: string;
  /**
   * True when the Router decided `requiresSwarm: false` (and the user did not
   * Force-Swarm), so the ensemble produced NO consensus and intentionally did
   * NOT pre-generate an answer. The caller (`runAgent`) must treat this as
   * "no consensus to inject" and let its normal single-agent stream answer the
   * turn directly — with the full system prompt, RAG memory, tools, and
   * streaming. Generating a throwaway direct answer here used to be vestigial
   * double work: the ensemble's output is NEVER terminal (runAgent always runs
   * a final tool-capable streamText afterward and re-answers).
   */
  bypassed?: boolean;
  /**
   * True when the swarm was SUPPOSED to run (not bypassed) but produced NO
   * usable consensus — every proposer failed, so zero drafts survived
   * `isSuccessfulDraft`. The caller injects no consensus and the final stream
   * answers as a plain single agent WITHOUT any swarm input (and, critically,
   * without the Skeptic's audit). Distinct from `bypassed` (a DELIBERATE
   * Router decision on a trivial prompt): this is an UNINTENDED degradation
   * the operator must see — otherwise a swarm turn that silently collapsed to
   * one agent is indistinguishable from a healthy one. Surfaced by `runAgent`
   * as a UI note + `log.warn`. Root cause is almost always unreliable proposer
   * models (free-tier 429s under parallel load — see CLAUDE.md §1).
   */
  degradedToSingleAgent?: boolean;
  /**
   * Sprint 2 — MoA aggregator collapse (docs/moa-aggregator-collapse.md). When
   * set, the default synthesis aggregator did NOT run: `runAgent`'s final
   * tool-capable `streamText` must synthesize these drafts inline (ONE brain
   * generation instead of two). `text` is "" on this path; the synthesized
   * answer comes from the stream. Carries everything the relocated trace
   * capture needs in `onFinish` (the drafts are already in `text` form, so the
   * stream produces the final text the trace records).
   *
   * Populated ONLY on the collapsed path (`mode === "synthesis"` && reflection
   * OFF && ≥2 successful drafts && `settings.aggregator.inlineSynthesis`).
   * Every other path keeps returning a finished `text`.
   */
  synthesisHandoff?: {
    /** Successful proposer drafts to synthesize (role + text drive the prompt). */
    drafts: { proposerId: string; role: string; text: string }[];
    /** PM #39 disagreement marker — "" when consensus. Prepended to the directive. */
    disagreementMarker: string;
    /**
     * Trace-memory signals for the relocated capture in `onFinish`. `finalText`
     * is supplied there from the streamed synthesis; `totalLatencyMs` here
     * covers the MoA portion only (proposers + disagreement), not the stream.
     */
    signals: TraceSignals;
  };
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
// §8 offset — `createWindowResolver` moved to moa-window.ts (re-exported above).

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

  // ── Step 1: Resolve ensemble setup ─────────────────────────────────
  // All pure per-run derivations (Skeptic model, reflection toggle, memoized
  // context-window resolver, worker/router configs, proposer-safe history,
  // search-usable gate, clamped swarm size) live in `resolveEnsembleSetup`
  // (moa-setup.ts, §10 Sprint 5). Each derivation's rationale is documented
  // there; `options` is structurally assignable to the setup input.
  const {
    skepticConfig,
    reflectionEnabled,
    resolveWindow,
    workerConfig,
    safeHistory,
    routerConfig,
    searchEnabled,
    maxSwarmSize,
  } = resolveEnsembleSetup(options);

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

  const dpgResult = await generateDynamicSwarm(userMessage, history, routerConfig, searchEnabled, abortSignal, fewShotsBlock, maxSwarmSize);

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
      reason: `[MoA] Auto-Routing: Task is direct. Swarm bypassed — answering with the single agent.`,
    });

    // The ensemble's output is NEVER terminal: `runAgent` ALWAYS runs a final
    // tool-capable streamText after this returns. Pre-generating a throwaway
    // "direct answer" here only to inject it back as a (mislabeled, 0-agent)
    // "consensus" was vestigial double work — one whole brain-model generation
    // wasted on every bypassed turn. Return a bypass signal and defer to the
    // single-agent stream, which answers with the FULL system prompt, RAG
    // memory, tools, and streaming (none of which the throwaway call had).
    console.log(`[MoA] Swarm bypassed — deferring to the single-agent stream (no redundant pre-generation).`);
    return {
      text: "",
      bypassed: true,
      drafts: [],
      aggregationLatencyMs: 0,
      totalLatencyMs: Date.now() - totalStart,
      // PM #36 — the Router call still spent tokens; keep them in the banner.
      cumulativeUsage: addUsageToCumulative(
        undefined,
        routerConfig.provider,
        routerConfig.model,
        dpgResult.usage
      ),
    };
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

  // D1 / PM #94 — ground the proposers in the recent task context. `safeHistory`
  // strips tool activity (goal-tracker status, file edits, command output) for
  // pairing-safety, which blinds proposers to the ACTIVE task on a continuation
  // prompt ("Продолжай") → each returns a "please clarify" refusal that the
  // disagreement detector reads as consensus and lets poison the synthesis. This
  // restores the stripped context as a plain-text block appended to the proposer
  // SYSTEM prompt (no message re-insertion → no tool-pairing 400 hazard). Built
  // ONCE — identical for every proposer; the persona prompt is what varies.
  const proposerContextBlock = buildProposerContextBlock(history);

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
        resolveProposerModelConfig(proposer, workerConfig, settings, skepticConfig);
      const resolvedProvider = proposerConfig.provider;
      const resolvedModel = proposerConfig.model;

      // Resolve the standard role BEFORE the try so the catch/DAG events use
      // the ACTUAL detected role, not a hardcoded "reviewer".
      // detectProposerRole is pure (no I/O, no throw).
      const standardRole = detectProposerRole(proposer);

      // DDD Sprint 8 (corrected) — in-breed sycophancy ADVISORY, warn-once
      // per process per combo. Advisory only — never switches models (the
      // forced Tripartite variant was rejected; see moa-personas.ts docs).
      if (standardRole === "reviewer") {
        warnSkepticFamilyOverlapOnce({
          skeptic: proposerConfig,
          worker: workerConfig,
          brain: settings.chatModel,
        });
      }

      try {
        const workerModel = createModel(proposerConfig, { projectId, currentPath });

        // PM #42 — extracted to a reusable helper so the role detection
        // (UI icon, tool assignment, prompt augmentation) goes through
        // one place and stays consistent.

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
          },
          // Wire the "does this model support tool calling?" gate (PM #17).
          // Without it, a non-tool proposer model (e.g. an OpenRouter model in
          // NO_TOOL_PATTERNS) gets tools forwarded → the call 404s and wastes
          // the first attempt before the no-tools fallback retries. This makes
          // it run tool-less (with the PM #77 directive) on the first pass.
          modelSupportsTools(proposerConfig.provider, proposerConfig.model)
        );
        // §4 — proposers MUST go through the same loop guard as the main agent
        // path. Without it, a throwing tool (e.g. a flaky search_web) is caught
        // by the per-proposer try/catch and silently DROPS this proposer's draft
        // instead of self-healing within its step budget; proposers also lacked
        // no-progress dedup and the A3 per-tool output cap. selectProposerTools
        // returns undefined for tool-less roles, so wrap only when present.
        const guardedProposerTools = proposerTools
          ? applyGlobalToolLoopGuard(proposerTools)
          : proposerTools;
        // D1 / PM #94 — append the recent-task-context block so the proposer can
        // resolve continuation prompts. Grounding first, then tool augmentation.
        const augmentedSystemPrompt = augmentProposerPromptForTools(
          proposer.systemPrompt + proposerContextBlock,
          guardedProposerTools
        );

        // Free-tier resilience: a throttled/overloaded free endpoint answers
        // SLOWLY or returns an EMPTY body with a 200. Both look like "the
        // proposer produced nothing" and shrink the ensemble below the >=2
        // successful drafts the synthesis path needs. The timeout is therefore
        // operator-tunable (ORCHESTRA_PROPOSER_TIMEOUT_MS) and the generation is
        // retried on an EMPTY result (see PROPOSER_EMPTY_RETRIES below).
        const PROPOSER_TIMEOUT_MS = Number(
          process.env.ORCHESTRA_PROPOSER_TIMEOUT_MS ?? 120_000
        ); // default 2 minutes — generous for free/slow models
        // AbortSignal.any() requires Node 20.3+. Fall back gracefully on older runtimes.
        // Rebuilt per attempt so a retry gets a FRESH timeout budget (a reused
        // expired signal would abort the retry instantly).
        const buildProposerSignal = (): AbortSignal =>
          typeof AbortSignal.any === "function" && abortSignal
            ? AbortSignal.any([abortSignal, AbortSignal.timeout(PROPOSER_TIMEOUT_MS)])
            : AbortSignal.timeout(PROPOSER_TIMEOUT_MS);
        let proposerSignal: AbortSignal = buildProposerSignal();

        // PM #66 ceiling, lifted out so it feeds BOTH the output cap and the
        // in-flight governor's reserve (Follow-up A3b).
        const proposerMaxOutput = Math.min(
          proposerConfig.maxTokens ?? workerConfig.maxTokens ?? 2048,
          4096
        );
        // Follow-up A3b — proposers are tool-loops too (Skeptic/researcher with
        // search_web take up to 3 steps), so they need the SAME in-flight token
        // governor as the main agent path: prune the payload BETWEEN steps so
        // accreting tool results can't overflow the proposer model's real window.
        // The per-tool output cap already rides on the loop guard; this adds the
        // cross-step message-pruning the guard can't do. Resolved per-proposer
        // because tiers (PM #48) can land proposers on different models/windows.
        const proposerContextWindow = await resolveWindow(proposerConfig);

        // Free-tier throttle recovery: attempt the generation, and if the
        // provider returns an EMPTY body (200 + no text — the signature of a
        // rate-limited free endpoint), back off and retry. Bounded so a truly
        // silent model can't stall the fan-out. Errors keep their existing
        // handling (tool-unsupported retry / Skeptic failover) untouched.
        const PROPOSER_EMPTY_RETRIES = Number(
          process.env.ORCHESTRA_PROPOSER_EMPTY_RETRIES ?? 2
        );
        let result;
        for (let attempt = 0; ; attempt++) {
        try {
          result = await generateText({
            model: workerModel,
            // PM #42 — system prompt is augmented with the Fact-Check Mandate
            // when this proposer was assigned search_web (reviewer / researcher).
            // For other roles, augmentedSystemPrompt === proposer.systemPrompt
            // verbatim.
            system: augmentedSystemPrompt,
            messages,
            prepareStep: createTokenGovernor({
              contextWindow: proposerContextWindow,
              reservedOutputTokens: proposerMaxOutput,
              modelHint: { provider: proposerConfig.provider, model: proposerConfig.model },
            }),
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
            maxOutputTokens: proposerMaxOutput,
            tools: guardedProposerTools,
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
            stopWhen: stepCountIs(guardedProposerTools ? 3 : 1),
            abortSignal: proposerSignal,
          });
        } catch (textErr: any) {
          const msg = textErr instanceof Error ? textErr.message : String(textErr);
          if (guardedProposerTools && (msg.toLowerCase().includes("tool") || msg.toLowerCase().includes("endpoint"))) {
            console.warn(`[MoA] Proposer "${proposer.id}" model doesn't support tools. Retrying without tools... (${msg})`);
            result = await generateText({
              model: workerModel,
              // Tool-augmentation skipped (no-tools retry) but the PM #94 context
              // grounding still applies — the proposer needs the task context.
              system: proposer.systemPrompt + proposerContextBlock,
              messages,
              prepareStep: createTokenGovernor({
                contextWindow: proposerContextWindow,
                reservedOutputTokens: proposerMaxOutput,
                modelHint: { provider: proposerConfig.provider, model: proposerConfig.model },
              }),
              temperature: proposerConfig.temperature ?? workerConfig.temperature ?? 0.5,
              maxOutputTokens: proposerMaxOutput,
              tools: undefined,
              stopWhen: stepCountIs(1),
              abortSignal: proposerSignal,
            });
          } else {
            throw textErr;
          }
        }

          // Delivered non-empty, or retry budget exhausted -> keep this result.
          if ((result.text ?? "").trim().length > 0 || attempt >= PROPOSER_EMPTY_RETRIES) break;
          const backoffMs = 2000 * (attempt + 1);
          console.warn(
            `[MoA] Proposer "${proposer.id}" (${resolvedProvider}/${resolvedModel}) returned an EMPTY body ` +
              `(attempt ${attempt + 1}/${PROPOSER_EMPTY_RETRIES + 1}) — likely free-tier throttle. ` +
              `Backing off ${backoffMs}ms and retrying.`
          );
          await new Promise((r) => setTimeout(r, backoffMs));
          proposerSignal = buildProposerSignal(); // fresh timeout budget for the retry
        }

        const text = result.text?.trim() || "(empty draft)";
        const latencyMs = Date.now() - pStart;

        console.log(`[MoA] Proposer "${proposer.id}" (role=${standardRole}, model=${resolvedProvider}/${resolvedModel}) completed in ${latencyMs}ms (${text.length} chars)`);

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
        let latencyMs = Date.now() - pStart;
        let errMsg = err instanceof Error ? err.message : String(err);
        
        // Sprint 6 failover — A6: the substitution must be LOUD (with a
        // direct operator Skeptic the retry is off the operator's choice).
        if (standardRole === "reviewer") {
          console.warn(
            `[MoA] Skeptic failover: "${proposer.id}" on ${resolvedProvider}/${resolvedModel} failed (${errMsg}) → falling back to ${workerConfig.provider}/${workerConfig.model}${skepticConfig ? " (operator Skeptic model NOT honored for this retry)" : ""}`
          );
          publishUiSyncEvent({
            topic: "chat",
            chatId,
            nodeType: "agent_node",
            swarmNode: {
              nodeId,
              role: standardRole,
              taskSummary: `${proposer.role}: Failed. Activating fallback...`,
              status: "running",
            },
          });
          
          try {
            const fallbackModel = createModel(workerConfig, { projectId, currentPath });
            const messages: ModelMessage[] = [
              ...safeHistory.slice(-6),
              { role: "user", content: userMessage },
            ];
            const PROPOSER_TIMEOUT_MS = 120_000;
            let proposerSignal: AbortSignal;
            if (typeof AbortSignal.any === "function" && abortSignal) {
              proposerSignal = AbortSignal.any([abortSignal, AbortSignal.timeout(PROPOSER_TIMEOUT_MS)]);
            } else {
              proposerSignal = AbortSignal.timeout(PROPOSER_TIMEOUT_MS);
            }
            const proposerMaxOutput = Math.min(
              workerConfig.maxTokens ?? 2048,
              4096
            );

            // Retry without tools to maximize success chance. PM #94 context
            // grounding still applies on the failover model.
            const result = await generateText({
              model: fallbackModel,
              system: proposer.systemPrompt + proposerContextBlock,
              messages,
              prepareStep: createTokenGovernor({
                contextWindow: await resolveWindow(workerConfig),
                reservedOutputTokens: proposerMaxOutput,
                modelHint: { provider: workerConfig.provider, model: workerConfig.model },
              }),
              temperature: workerConfig.temperature ?? 0.5,
              maxOutputTokens: proposerMaxOutput,
              tools: undefined,
              stopWhen: stepCountIs(1),
              abortSignal: proposerSignal,
            });
            
            const text = result.text?.trim() || "(empty draft)";
            latencyMs = Date.now() - pStart;

            console.log(`[MoA] Proposer "${proposer.id}" (role=${standardRole}, model=${workerConfig.provider}/${workerConfig.model}) FALLBACK completed in ${latencyMs}ms (${text.length} chars)`);

            publishUiSyncEvent({
              topic: "chat",
              chatId,
              nodeType: "agent_node",
              swarmNode: {
                nodeId,
                role: standardRole,
                taskSummary: `${proposer.role}: Fallback complete.`,
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
              resolvedProvider: workerConfig.provider,
              resolvedModel: workerConfig.model,
              resolvedTier: "fast", // Fallback typically uses standard reliable utility config
            };
          } catch (fallbackErr) {
             const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
             console.error(`[MoA] Proposer "${proposer.id}" FALLBACK also failed: ${fallbackMsg}`);
             errMsg = `${errMsg} -> Fallback failed: ${fallbackMsg}`;
             latencyMs = Date.now() - pStart;
          }
        }

        console.error(`[MoA] Proposer "${proposer.id}" failed: ${errMsg}`);

        publishUiSyncEvent({
          topic: "chat",
          chatId,
          nodeType: "agent_node",
          swarmNode: {
            nodeId,
            role: standardRole,
            taskSummary: `${proposer.role}: Failed (${errMsg})`,
            status: "error",
            completedAt: new Date().toISOString(),
          },
        });

        // R1 — a failed reviewer (Skeptic) is dropped like any other proposer
        // (PM #77 contract): its error draft is filtered out by isSuccessfulDraft
        // while the other proposers' drafts survive. Throwing here would reject
        // the Promise.all → runMoAEnsemble throws → agent.ts silently collapses
        // the whole ensemble to a single agent, discarding every good draft.
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

  // If zero drafts succeeded, return a fallback. The `degradedToSingleAgent`
  // flag lets `runAgent` surface the collapse to the operator (the swarm was
  // meant to run but produced nothing — the final stream answers alone, with
  // no Skeptic audit). Without the flag this path was silent: the string-
  // matched "All MoA proposer agents failed" text skips consensus injection
  // and the turn looks like a healthy single-agent answer.
  if (successfulDrafts.length === 0) {
    return {
      text: "All MoA proposer agents failed. Please check your model configuration and API keys.",
      degradedToSingleAgent: true,
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

  // ── Sprint 2: inline-synthesis collapse ────────────────────────────
  // docs/moa-aggregator-collapse.md. By DEFAULT (2c flip — `DEFAULT_SETTINGS`
  // ships `aggregator.inlineSynthesis: true`, so every getSettings() caller has
  // it on) on the plain synthesis path (mode === "synthesis", reflection OFF,
  // ≥2 successful drafts), SKIP the
  // separate aggregator generateText entirely. Hand the drafts UP via
  // `synthesisHandoff`; runAgent's final tool-capable stream — which always
  // runs afterward — synthesizes them inline: ONE brain generation this turn
  // instead of two (aggregator + stream). The collapsed synthesizer can also
  // call tools mid-synthesis, which the standalone aggregator never could.
  //
  // Deliberately narrow: reflection (inherently multi-pass — needs a complete
  // answer to critique) and tournament (returns a verbatim winner, no
  // synthesis) are EXCLUDED. A tournament-fallback-to-synthesis keeps
  // `aggregatorMode === "tournament"`, so it does NOT collapse here either —
  // it runs the inline aggregator below as its last resort (safe).
  //
  // Default ON since the 2c flip (2026-06-22), after the N=8 live A/B: quality
  // held, latency −31%, completion tokens −16%. The default lives in
  // `DEFAULT_SETTINGS` (settings-store.ts); the gate below reads `=== true`, so a
  // settings object NOT built through getSettings() (e.g. a unit test passing
  // `fakeSettings()` directly) does NOT collapse unless it sets the flag. Set
  // `aggregator.inlineSynthesis: false` to opt OUT. `successfulDrafts.length >= 2`
  // is guaranteed here (we returned early for 0 and 1 drafts) but stated
  // explicitly to match the gate.
  if (
    settings.aggregator?.inlineSynthesis === true &&
    aggregatorMode === "synthesis" &&
    !reflectionEnabled &&
    successfulDrafts.length >= 2
  ) {
    const totalLatencyMs = Date.now() - totalStart;
    publishUiSyncEvent({
      topic: "chat",
      chatId,
      nodeType: "system_node",
      swarmNode: {
        nodeId: aggregatorNodeId,
        parentNodeId: routerNodeId,
        role: "orchestrator",
        taskSummary: "Synthesis handed to final stream",
        status: "completed",
        completedAt: new Date().toISOString(),
      },
    });
    console.log(
      `[MoA] Inline-synthesis collapse: handing ${successfulDrafts.length} drafts to the final tool-capable stream → 1 brain generation this turn (aggregator skipped).`
    );
    // Trace signals for the relocated capture in runAgent's onFinish (the
    // synthesized `finalText` only exists once the stream finishes). Latency
    // here covers the MoA portion only — the stream's time is not included.
    const signals: TraceSignals = {
      proposerSuccessRatio:
        drafts.length === 0 ? 0 : successfulDrafts.length / drafts.length,
      disagreementDetected: disagreement.detected,
      disagreementMaxDistance: disagreement.maxDistance,
      reflectionRounds: 0,
      reflectionHitCap: false,
      totalLatencyMs,
      aggregatorMode: "synthesis",
    };

    return {
      text: "",
      drafts,
      synthesisHandoff: {
        drafts: successfulDrafts.map((d) => ({
          proposerId: d.proposerId,
          role: d.role,
          text: d.text,
        })),
        disagreementMarker,
        signals,
      },
      aggregationLatencyMs: 0,
      totalLatencyMs,
      cumulativeUsage: moaUsage,
    };
  }

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

  // Follow-up A3b — govern the aggregator payload too. The aggregatorPrompt
  // concatenates the original request + every proposer draft (+ a disagreement
  // marker), which can dwarf the brain model's window. The governor is a no-op
  // under budget and pair-safe above it; it's mostly future-proofing here
  // (single-message, tool-less today) but keeps the contract uniform across
  // every tool-loop/LLM callsite in the MoA path.
  const aggregatorMaxOutput = resolveMaxOutputTokens(brainConfig);
  const aggregatorContextWindow = await resolveWindow(brainConfig);

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
      prepareStep: createTokenGovernor({
        contextWindow: aggregatorContextWindow,
        reservedOutputTokens: aggregatorMaxOutput,
        modelHint: { provider: brainConfig.provider, model: brainConfig.model },
      }),
      temperature: 0.3,
      maxOutputTokens: aggregatorMaxOutput,
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

    // PM #38 (single round) + PM #46 (multi-round) — the generator-critic-
    // revisor reflection loop. When reflection is enabled the aggregator output
    // is reviewed by the critic (operator's Skeptic, else the brain) and revised
    // by the brain until the critic is clean, revisions converge, or the hard
    // cap is hit. Extracted to `runReflectionLoop` (moa-reflection.ts, §10
    // Sprint 5) — it folds its own reflection/revisor usage and emits the single
    // `ddd_reflection_outcome` event. The caller keeps only the two trace
    // signals it records below (`reflectionRevisionsExecuted`, `reflectionHitCap`).
    const reflectionResult = await runReflectionLoop({
      reflectionEnabled,
      initialText: finalText,
      usage: moaUsage,
      userMessage,
      settings,
      skepticConfig,
      brainConfig,
      projectId,
      chatId,
      abortSignal,
    });
    finalText = reflectionResult.finalText;
    moaUsage = reflectionResult.usage;
    const reflectionRevisionsExecuted = reflectionResult.reflectionRevisionsExecuted;
    const reflectionHitCap = reflectionResult.reflectionHitCap;

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
