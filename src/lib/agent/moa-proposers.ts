/**
 * MoA Proposer Fan-Out (§10 Sprint 5 decomposition — Phase 2)
 *
 * The parallel proposer stage of `runMoAEnsemble`, extracted VERBATIM from
 * `moa.ts` to bring that file back under the §8 1500-line hard cap. The logic
 * (staggered dispatch, free-tier pacing + circuit-breaker failover, empty-body
 * retry, loop-guarded proposer tools, per-proposer in-flight token governor,
 * reviewer/Skeptic fallback) is unchanged; `moa.test.ts` drives it end-to-end
 * as the regression net.
 *
 * Contracts honored on this cut — do NOT "clean up" any of these:
 *   - PM #77: a failed proposer RETURNS an error draft, never throws. A throw
 *     rejects `Promise.all` → `runMoAEnsemble` throws → agent.ts silently
 *     collapses the whole ensemble to a single agent, discarding good drafts.
 *   - §4: proposer tools pass through `applyGlobalToolLoopGuard` (the tree grep
 *     must still find the guard in a moa-path file).
 *   - PM #1/#23: every `generateText` keeps its `abortSignal` — the abort gate
 *     scans this file too.
 *   - PM #17: proposer tool gating via `modelSupportsTools`.
 */

import { generateText, stepCountIs, type ModelMessage } from "ai";
import type { AppSettings, ModelConfig } from "@/lib/types";
import { agentSemaphore } from "./semaphore";
import { publishUiSyncEvent } from "@/lib/realtime/event-bus";
import { getWorkDir } from "@/lib/storage/project-store";
import { createModel } from "@/lib/providers/llm-provider";
import { modelSupportsTools } from "@/lib/providers/tool-support";
import { applyGlobalToolLoopGuard } from "@/lib/agent/tool-guard";
import { createTokenGovernor } from "@/lib/agent/token-governor";
import {
  detectProposerRole,
  resolveProposerModelConfig,
  resolveWorkerKey,
  warnSkepticFamilyOverlapOnce,
  type MoAProposer,
  type ProposerTier,
} from "@/lib/agent/moa-personas";
import {
  classifyModelFailure,
  isModelCircuitOpen,
  recordModelFailure,
  recordModelSuccess,
  selectHealthyConfig,
} from "@/lib/agent/model-health";
import {
  abortableSleep,
  computeStaggerMs,
  withFreeTierPacing,
} from "@/lib/agent/proposer-pacing";
import {
  allowsModelSubstitution,
  resolveDegradationPolicy,
  type DegradationPolicy,
} from "@/lib/agent/degradation-policy";
import {
  selectProposerTools,
  augmentProposerPromptForTools,
} from "@/lib/agent/moa-proposer-tools";
import { buildProposerContextBlock } from "@/lib/agent/moa-prompts";
import type { EnsembleSetup } from "@/lib/agent/moa-setup";

/** `generateText().usage` — kept precise without pinning the SDK's export name. */
type GeneratedUsage = Awaited<ReturnType<typeof generateText>>["usage"];

/**
 * One proposer's draft plus its raw usage. `rawUsage` is folded into the
 * cumulative total (PM #36/#48) and then stripped before drafts are exposed.
 */
export interface ProposerDraftWithUsage {
  proposerId: string;
  role: string;
  text: string;
  latencyMs: number;
  /** Present only on a successful generation. */
  rawUsage?: GeneratedUsage;
  resolvedProvider: string;
  resolvedModel: string;
  resolvedTier: ProposerTier;
}

/**
 * Everything the fan-out closes over: the per-run setup fields it shares with
 * `resolveEnsembleSetup` plus the options-derived values. Destructured to the
 * same local names the original inline block used, so the moved body is verbatim.
 */
export interface ProposerFanOutContext
  extends Pick<
    EnsembleSetup,
    "skepticConfig" | "workerConfig" | "safeHistory" | "searchEnabled" | "resolveWindow"
  > {
  /** Personas from the DPG Router (`dpgResult.personas`). */
  dynamicProposers: MoAProposer[];
  chatId: string;
  /** Router/orchestrator DAG node — proposer nodes parent to it. */
  routerNodeId: string;
  projectId?: string;
  currentPath?: string;
  userMessage: string;
  /** Raw history for the PM #94 proposer-context block. */
  history: ModelMessage[];
  abortSignal?: AbortSignal;
  settings: AppSettings;
  /** Per-request degradation-policy override (`options.degradationPolicy`). */
  degradationPolicy?: DegradationPolicy;
  /** Unattended-run flag (`options.background`) — forces the `speed` policy. */
  background?: boolean;
}

export interface ProposerFanOutResult {
  draftsWithUsage: ProposerDraftWithUsage[];
  proposerLatencyMs: number;
}

/**
 * Backoff before re-attempting a proposer that got an empty body or a 429.
 *
 * Linear ladder (2s, 4s, …), operator-tunable via
 * `ORCHESTRA_PROPOSER_EMPTY_BACKOFF_MS`, **plus up to 40% jitter**.
 *
 * The jitter is not cosmetic (DoubleTake #6): proposers that hit the same
 * throttled endpoint at ~the same instant would otherwise wake at the SAME
 * millisecond and re-fire in lockstep — re-creating the exact burst the Sprint-2
 * stagger exists to break, one layer down.
 */
function emptyBackoffMs(attempt: number): number {
  const base = Number(process.env.ORCHESTRA_PROPOSER_EMPTY_BACKOFF_MS ?? 2000) * (attempt + 1);
  return Math.round(base * (1 + Math.random() * 0.4));
}

/**
 * Phase 2 of the MoA pipeline: fan out to N proposers in parallel and collect
 * their drafts (with per-draft usage for PM #36/#48 attribution). Never throws
 * on a proposer failure — see the PM #77 contract in the file header.
 */
export async function runProposerFanOut(
  ctx: ProposerFanOutContext
): Promise<ProposerFanOutResult> {
  const {
    dynamicProposers,
    chatId,
    routerNodeId,
    projectId,
    currentPath,
    userMessage,
    history,
    abortSignal,
    settings,
    degradationPolicy: degradationPolicyOverride,
    background,
    skepticConfig,
    workerConfig,
    safeHistory,
    searchEnabled,
    resolveWindow,
  } = ctx;

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

  // Free-tier failover (Sprint 1) — the substitution pool the circuit breaker
  // draws from when a proposer's resolved endpoint is marked dead. Built ONCE
  // per run: every operator-configured tier plus the utility worker, key-
  // resolved server-side (`resolveWorkerKey`) so a substitute is dispatchable.
  // Order = quality-descending-ish (frontier → balanced → fast → skeptic →
  // worker); `selectHealthyConfig` de-dups and skips open circuits.
  const degradationPolicy = resolveDegradationPolicy(
    settings,
    degradationPolicyOverride,
    { background }
  );
  const substitutionAllowed = allowsModelSubstitution(degradationPolicy);
  if (!substitutionAllowed) {
    console.log(
      `[MoA] Degradation policy "${degradationPolicy}" — proposer model substitution is OFF for this run.`
    );
  }

  const failoverPool: ModelConfig[] = [
    settings.proposerTiers?.frontier,
    settings.proposerTiers?.balanced,
    settings.proposerTiers?.fast,
    settings.proposerTiers?.skeptic,
  ]
    .filter((c): c is ModelConfig => Boolean(c?.model))
    .map((c) => resolveWorkerKey(c, settings))
    .concat(workerConfig);

  const proposerPromises = dynamicProposers.map(
    async (proposer, index): Promise<ProposerDraftWithUsage> => {
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

    // 2. Resolve WHICH endpoint this proposer WOULD hit — hoisted above the
    // stagger because the pacing (Sprint 2) must know whether it is pacing a
    // free endpoint before it sleeps. Pure (no I/O, no throw).
    //
    // PM #48 — when the operator hasn't configured `settings.proposerTiers`
    // this returns `workerConfig` for every proposer (exact pre-PM-48
    // behavior). Resolved outside the try/catch so the error branch can
    // attribute its (zero) usage to the model that would have run.
    const { config: preferredConfig, tier: proposerTier } =
      resolveProposerModelConfig(proposer, workerConfig, settings, skepticConfig);

    // 3. Staggered start — break the simultaneous request burst that makes a
    // shared free endpoint return empty 200s in the first place. PM #66 kept
    // this small (`index * 250ms`) because the `agentSemaphore` + the SDK's
    // 429 backoff carry the load; Sprint 2 makes it ENDPOINT-AWARE instead of
    // uniform: free endpoints get a wider spread, and one the breaker has
    // already seen fail gets a wider one still (`computeStaggerMs`). Paid
    // endpoints keep the PM #66 profile.
    //
    // The sleep is ABORT-AWARE (audit A3): the offset can now reach 8s, so a
    // plain `setTimeout` would keep a cancelled turn's proposers queued long
    // after the user pressed stop — the AbortSignal contract applies to every
    // wait on the request path, not just the SDK calls.
    const stagger = computeStaggerMs(index, preferredConfig);
    if (stagger > 0) {
      await abortableSleep(stagger, abortSignal);
    }
    if (abortSignal?.aborted) {
      return {
        proposerId: proposer.id,
        role: proposer.role,
        text: "[Error: aborted before dispatch]",
        latencyMs: 0,
        resolvedProvider: preferredConfig.provider,
        resolvedModel: preferredConfig.model,
        resolvedTier: proposerTier,
      };
    }

    // 4. Free-tier failover (Sprint 1) — a model whose circuit is OPEN is
    // known-dead (N consecutive empty bodies / throttles). Retrying it just
    // burns the empty-retry backoff and keeps hammering a rate-limited shared
    // endpoint, so substitute a healthy model from the pool instead. Fails
    // OPEN: when every candidate is dead this returns the operator's choice.
    //
    // Evaluated AFTER the stagger (audit A4) so it sees the FRESHEST breaker
    // state — the whole point of staggering is to let earlier proposers report
    // an endpoint's health before the later ones commit to it.
    //
    // The substitution is LOUD — both stdout and the DAG node — because a
    // silent model swap is indistinguishable from a healthy run (the
    // `degradedToSingleAgent` lesson).
    // Sprint 4 — a substituted model is a DIFFERENT model, so under
    // `quality`/`ask` the user has told us not to swap silently: keep their
    // configured endpoint and let this proposer fail if it must (the ensemble
    // survives on the other drafts). `speed` (the default) substitutes.
    const healthy = substitutionAllowed
      ? selectHealthyConfig(preferredConfig, failoverPool, index)
      : { config: preferredConfig, substituted: false as const };
    const proposerConfig = healthy.config;
    if (healthy.substituted) {
      console.warn(
        `[MoA] Proposer "${proposer.id}" — circuit OPEN on ${healthy.substitutedFrom}; ` +
          `substituting ${proposerConfig.provider}/${proposerConfig.model} for this run.`
      );
      publishUiSyncEvent({
        topic: "chat",
        chatId,
        nodeType: "agent_node",
        swarmNode: {
          nodeId,
          parentNodeId: routerNodeId,
          role: proposer.id as "coder",
          taskSummary: `${proposer.role}: ${healthy.substitutedFrom} unavailable → using ${proposerConfig.model}`,
          status: "running",
        },
      });
    }
    const resolvedProvider = proposerConfig.provider;
    const resolvedModel = proposerConfig.model;

    // 5. Two INDEPENDENT budgets, acquired OUTERMOST-SCARCEST-LAST:
    // `withFreeTierPacing` bounds a remote SHARED QUOTA (across every concurrent
    // chat); `agentSemaphore` bounds MACHINE load (local inference VRAM) and is
    // shared with the embedder + the main agent path.
    //
    // ORDER MATTERS (audit A1): the free-tier wait is OUTSIDE the global
    // semaphore. Nested the other way, a proposer queued on the free quota
    // would sit on one of the machine's scarce global permits (only 2 on a
    // 16 GB box) and starve `memory.ts` embeddings and `agent.ts`. Every
    // acquirer takes them in this same order, so there is no lock-order cycle.
    // R1 hardening (DoubleTake #4, second half) — the semaphores can THROW
    // before the per-proposer try/catch is ever entered: `Semaphore.acquire`
    // rejects with "Queue full" past `maxQueue`. That rejection would escape
    // this map callback, reject the `Promise.all`, make `runMoAEnsemble` throw,
    // and collapse the ENTIRE ensemble — discarding every good draft over a
    // local capacity problem. Contain it here, like every other proposer
    // failure: return an error draft and let the survivors aggregate.
    try {
      return await withFreeTierPacing(proposerConfig, async () => agentSemaphore.run(async () => {
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
          } else if (
            classifyModelFailure(textErr) === "throttle" &&
            attempt < PROPOSER_EMPTY_RETRIES &&
            !abortSignal?.aborted
          ) {
            // DoubleTake #1 — a THROWN throttle (429) used to skip this loop
            // entirely and kill the proposer on the spot: the loop only knew how
            // to retry an empty 200. Same upstream condition, same remedy, so
            // spend the same budget on it. (The AI SDK's own `maxRetries: 2`
            // already retried it on a ~ms ladder; this adds the multi-second
            // wait a shared free quota actually needs.)
            console.warn(
              `[MoA] Proposer "${proposer.id}" (${resolvedProvider}/${resolvedModel}) was THROTTLED ` +
                `(attempt ${attempt + 1}/${PROPOSER_EMPTY_RETRIES + 1}): ${msg}`
            );
            await abortableSleep(emptyBackoffMs(attempt), abortSignal);
            proposerSignal = buildProposerSignal();
            continue;
          } else {
            throw textErr;
          }
        }

          // Delivered non-empty -> heal the breaker and keep this result.
          if ((result.text ?? "").trim().length > 0) {
            recordModelSuccess(resolvedProvider, resolvedModel);
            break;
          }
          // Empty body. The breaker counts ONE failure per PROPOSER, recorded
          // only once the retry budget is EXHAUSTED — never one per attempt
          // (audit A2). The counter is shared by every concurrent proposer on
          // this endpoint, so per-attempt recording made N proposers each
          // hitting ONE transient empty look like N consecutive failures: the
          // circuit opened spuriously, their in-flight retries were abandoned,
          // and drafts that would have recovered on attempt 2 were lost —
          // regressing the very delivery metric this track exists to raise.
          // A transient empty that recovers now leaves no mark at all (and a
          // success heals the counter anyway); only a proposer that cannot get
          // a body out of the endpoint DESPITE its retries counts against it.
          if (attempt >= PROPOSER_EMPTY_RETRIES) {
            recordModelFailure(resolvedProvider, resolvedModel, "empty");
            break;
          }
          // A CONCURRENT proposer exhausted its retries and opened the circuit
          // → further attempts here are known-futile; stop early rather than
          // burn the remaining backoff on a dead endpoint.
          if (isModelCircuitOpen(resolvedProvider, resolvedModel)) {
            console.warn(
              `[MoA] Proposer "${proposer.id}" — circuit opened on ${resolvedProvider}/${resolvedModel} ` +
                `(by a concurrent proposer); abandoning the remaining empty-retries.`
            );
            recordModelFailure(resolvedProvider, resolvedModel, "empty");
            break;
          }
          const backoffMs = emptyBackoffMs(attempt);
          console.warn(
            `[MoA] Proposer "${proposer.id}" (${resolvedProvider}/${resolvedModel}) returned an EMPTY body ` +
              `(attempt ${attempt + 1}/${PROPOSER_EMPTY_RETRIES + 1}) — likely free-tier throttle. ` +
              `Backing off ${backoffMs}ms and retrying.`
          );
          // DoubleTake #5 — abort-aware: a plain sleep here kept firing retries
          // (and burning credit) after the user pressed stop, because the loop
          // also builds a FRESH signal for each attempt.
          await abortableSleep(backoffMs, abortSignal);
          if (abortSignal?.aborted) break;
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

        // Free-tier failover (Sprint 1) — count this endpoint's failure against
        // its circuit ONLY on positive evidence that the ENDPOINT is at fault:
        //  - a parent abort is the user pressing stop, not an endpoint failure;
        //  - `classifyModelFailure` returns null for OUR faults (an over-long
        //    prompt, a full semaphore queue, a local TypeError) — counting those
        //    let an Orchestra bug mark a healthy model dead for every concurrent
        //    chat (DoubleTake #4).
        // A proposer TIMEOUT does count — an endpoint too slow to answer inside
        // the proposer budget is functionally dead for this turn.
        const failureKind = abortSignal?.aborted ? null : classifyModelFailure(err);
        if (failureKind) {
          recordModelFailure(resolvedProvider, resolvedModel, failureKind);
        }

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

            // Feed the breaker: the failover model just proved itself (or
            // returned yet another empty body on a loaded free endpoint).
            if (result.text?.trim()) {
              recordModelSuccess(workerConfig.provider, workerConfig.model);
            } else {
              recordModelFailure(workerConfig.provider, workerConfig.model, "empty");
            }

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
             const fallbackKind = abortSignal?.aborted
               ? null
               : classifyModelFailure(fallbackErr);
             if (fallbackKind) {
               recordModelFailure(workerConfig.provider, workerConfig.model, fallbackKind);
             }
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
    }));
    } catch (dispatchErr) {
      const dispatchMsg =
        dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr);
      console.error(
        `[MoA] Proposer "${proposer.id}" could not be dispatched: ${dispatchMsg}`
      );
      publishUiSyncEvent({
        topic: "chat",
        chatId,
        nodeType: "agent_node",
        swarmNode: {
          nodeId,
          role: detectProposerRole(proposer),
          taskSummary: `${proposer.role}: Not dispatched (${dispatchMsg})`,
          status: "error",
          completedAt: new Date().toISOString(),
        },
      });
      return {
        proposerId: proposer.id,
        role: proposer.role,
        text: `[Error: ${dispatchMsg}]`,
        latencyMs: 0,
        resolvedProvider,
        resolvedModel,
        resolvedTier: proposerTier,
      };
    }

  });

  const draftsWithUsage = await Promise.all(proposerPromises);

  const proposerLatencyMs = Date.now() - proposerStart;
  return { draftsWithUsage, proposerLatencyMs };
}
