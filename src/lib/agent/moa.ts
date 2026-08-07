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

import { callDeadlineSignal } from "@/lib/agent/stream-watchdog";
import { generateText, type ModelMessage } from "ai";
import { resolveMaxOutputTokens } from "@/lib/providers/model-output-limits";
import { addUsageToCumulative, mergeUsage } from "@/lib/cost/accumulator";
import type { ChatUsage } from "@/lib/types";
import {
  buildDisagreementMarker,
  DEFAULT_DISAGREEMENT_THRESHOLD,
  detectDisagreement,
} from "@/lib/agent/disagreement";
import { runReflectionLoop } from "@/lib/agent/moa-reflection";
import { runProposerFanOut } from "@/lib/agent/moa-proposers";
import { createModel } from "@/lib/providers/llm-provider";
import { createTokenGovernor } from "@/lib/agent/token-governor";
import type { AppSettings } from "@/lib/types";
import { getBrainConfig, type PresetTier } from "@/lib/agent/presets";
import { resolveEnsembleSetup } from "@/lib/agent/moa-setup";
import { publishUiSyncEvent } from "@/lib/realtime/event-bus";

import {
  captureSuccessfulTrace,
  formatTracesAsFewShots,
  retrieveRelevantTraces,
  type TraceSignals,
} from "@/lib/agent/trace-memory";
import { runTournamentAggregation } from "@/lib/agent/tournament-aggregator";
import {
  recordEvalSwarmTelemetry,
  resolveEvalAggregatorMode,
} from "@/lib/agent/eval-arms";

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
  resolveWorkerKey,
  type SkepticModelOverride,
} from "@/lib/agent/moa-personas";
import type { DegradationPolicy } from "@/lib/agent/degradation-policy";
export { createWindowResolver } from "@/lib/agent/moa-window";


// ── Dynamic Persona Generation (DPG) ────────────────────────────────────
//
// PM #57 — extracted to `moa-router.ts`. Re-export for callers/tests.

export {
  generateDynamicSwarm,
  type DPGResult,
} from "@/lib/agent/moa-router";

import { generateDynamicSwarm } from "@/lib/agent/moa-router";


// §10 (Sprint 5) — `emptyBackoffMs` moved to `moa-proposers.ts` alongside the
// proposer fan-out that is its only caller.

// PM #66's per-proposer start stagger moved to `proposer-pacing.ts` in the
// Sprint 2 free-tier track: the offset is no longer a uniform constant but a
// function of the RESOLVED endpoint (free vs paid, healthy vs already-failing).
// The PM #66 profile is preserved for paid endpoints — see `computeStaggerMs`.

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

import { isSuccessfulDraft } from "@/lib/agent/moa-proposer-tools";


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
  /**
   * Sprint 4 — per-request degradation policy; overrides `settings`. Governs
   * whether a dead proposer endpoint may be SUBSTITUTED with another configured
   * model (`speed`) or must be left alone (`quality`/`ask`).
   */
  degradationPolicy?: DegradationPolicy;
  /**
   * True for unattended runs (Auto-Pilot, cron, external triggers). Forces the
   * policy to `speed`: nobody is there to read "try again later".
   */
  background?: boolean;
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
  // §10 (Sprint 5) — the proposer stage (staggered dispatch, free-tier
  // failover + pacing, empty-body retry, loop-guarded proposer tools, the
  // per-proposer in-flight token governor, and the reviewer/Skeptic fallback)
  // lives in `moa-proposers.ts`. It NEVER throws on a proposer failure (PM #77)
  // and threads `abortSignal` on every `generateText` (PM #1/#23). `moa.test.ts`
  // drives it end-to-end as the regression net for this cut.
  const { draftsWithUsage, proposerLatencyMs: proposerLatency } =
    await runProposerFanOut({
      dynamicProposers,
      chatId,
      routerNodeId,
      projectId,
      currentPath,
      userMessage,
      history,
      abortSignal,
      settings,
      degradationPolicy: options.degradationPolicy,
      background: options.background,
      skepticConfig,
      workerConfig,
      safeHistory,
      searchEnabled,
      resolveWindow,
    });

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
  // Eval-only sink (strict no-op unless ORCHESTRA_EVAL_CAPTURE_SWARM=true in a
  // dev process). Uses draftsWithUsage, not `drafts`, because only the former
  // still carries the RESOLVED provider/model per proposer — the field that
  // makes heterogeneity checkable after the fact instead of assumed.
  recordEvalSwarmTelemetry(chatId, {
    drafts: draftsWithUsage.map((d) => ({
      proposerId: d.proposerId,
      role: d.role,
      text: d.text,
      latencyMs: d.latencyMs,
      provider: d.resolvedProvider,
      model: d.resolvedModel,
      tier: d.resolvedTier,
    })),
    disagreement: {
      detected: disagreement.detected,
      maxDistance: disagreement.maxDistance,
      averageDistance: disagreement.averageDistance,
      pairCount: disagreement.pairCount,
      threshold: disagreement.threshold,
      ranSuccessfully: disagreement.ranSuccessfully,
    },
  });

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
  // `resolveEvalAggregatorMode` is a STRICT no-op unless the dev-only
  // `ORCHESTRA_EVAL_AGGREGATOR_MODE` flag is set (eval-arms.ts) — it exists so
  // the selection-vs-averaging A/B can flip synthesis↔tournament between arms
  // without editing settings mid-experiment.
  const aggregatorMode = resolveEvalAggregatorMode(
    settings.aggregator?.mode ?? "synthesis"
  );

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
      // PM #98 — the proposers below it were bounded; the aggregator that
      // consumes their drafts was not, so one silent endpoint stalled the turn
      // after all the expensive work had already succeeded.
      abortSignal: callDeadlineSignal(abortSignal),
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
