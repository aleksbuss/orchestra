/**
 * Free Mode — run Orchestra with zero model configuration on $0 endpoints.
 *
 * WHY IT EXISTS: the operator's own constraint. With a small one-off OpenRouter
 * top-up, the `:free` model tier is genuinely capable enough for real agentic
 * coding — but only if the runtime survives how those endpoints fail. Picking
 * the models by hand is the part that stops people: which free ids exist changes
 * week to week, and the one that matters most (the Router) has a capability
 * requirement that is invisible until the swarm silently degrades.
 *
 * WHAT IT DOES: when `settings.freeMode.enabled` is on, Orchestra overlays the
 * model slots with free OpenRouter models chosen from the live catalogue. The
 * user configures nothing. Turning it off restores their own settings verbatim —
 * the overlay is computed per call and never written to disk.
 *
 * THE TECHNOLOGY COMES ALONG FOR FREE — literally. The free-tier failover stack
 * (retry-on-empty, circuit breaker + substitution, endpoint-aware pacing) keys
 * on the `:free` id suffix via `isFreeTierModel`, so selecting free ids engages
 * every layer automatically. There is no second switch to forget.
 *
 * RANKING BASIS: the candidate pool is ordered by real OpenRouter benchmark
 * score (`sortFreeModelsByScore` — `intelligence_index`, then `agentic_index`,
 * then `coding_index` as tiebreaks; ids with no score sink to the bottom and
 * tie-break alphabetically), NOT by parameter count. A real 550B free model
 * (`nvidia/nemotron-3-ultra-550b-a55b:free`) was live-measured scoring WORSE
 * (intelligence 38.3) than several smaller free models — size is not a proxy
 * for capability here, so this ranks on the measured thing directly.
 * `ORCHESTRA_FREE_MODE_RANK=legacy` restores the pre-existing plain
 * alphabetical sort with no redeploy, if the live ranking looks wrong.
 *
 * THREE CONSTRAINTS DRIVE THE SELECTION:
 *
 * 1. **The Router needs `structured_outputs`.** Persona generation and the
 *    tournament judges' ballots go through `generateObject`. A free model
 *    without that capability answers HTTP 400, the Router falls back to three
 *    STATIC personas, and every judge fails. Both fallbacks are fail-safe and
 *    loud in stdout, but the turn still looks healthy — you get an answer, the
 *    proposers succeed, and nothing says the swarm just lost the two features
 *    that distinguish it from N-sampling. Only a minority of free models
 *    qualify, so the Router slot is filled from that subset or not at all.
 *
 * 2. **The brain needs TOOLS.** PM #98 — the original version of this file said
 *    "the brain and the proposers do NOT need the capability", which was
 *    reasoned about the SWARM path: there the Router picks personas and the
 *    proposers call the tools, and `moa-proposers.ts` already gates each
 *    proposer on `modelSupportsTools` and degrades it to a tool-free draft.
 *    In SINGLE AGENT mode there is no Router and no proposers — the brain IS
 *    the thing that calls tools. Selecting it as `[0]` of an alphabetically
 *    sorted catalogue handed the slot to `google/gemma-4-…` on the letter "g",
 *    `agent.ts` dropped to plain-chat mode, and a "find me today's news"
 *    question was answered from stale weights. Tool support is now the FIRST
 *    key on the brain slot.
 *
 *    It is a PREFERENCE, not a filter: free tool-capable ids are a small
 *    subset, and a filter that empties the pool would hard-fail Free Mode for
 *    everyone. When nothing tool-capable exists we still run — and say so, so
 *    the degradation is visible instead of silent.
 *
 * 3. **Slots should NOT share one endpoint — the brain/Router pair included.**
 *    A free endpoint under load
 *    returns HTTP 200 with an empty body, and the trigger is exactly the shape
 *    MoA generates: 3-5 proposers firing at one shared endpoint through one key.
 *    Pacing bounds the burst in time; spreading the tiers across DIFFERENT free
 *    models spreads it across different upstream quotas, which is the cheaper
 *    fix because it removes the contention instead of queueing behind it.
 *
 *    PM #112 — this was written about the proposer fan-out only, and the
 *    brain/Router pair was left sharing one model because both are "the first
 *    structured-capable id, sorted". Concentration is not only a throughput
 *    problem: when that one upstream started rejecting requests, it took the
 *    brain, the Router and the fallback probe together. The Router now prefers a
 *    different id, and says so when it cannot get one.
 *
 * NOT A PRESET WRITE: `applyFreeMode` returns a NEW settings object. Nothing is
 * persisted, so a user who flips Free off has their paid configuration back
 * exactly as it was — no "restore your models" migration to get wrong.
 */
import type { AppSettings, ModelConfig } from "@/lib/types";
import {
  listOpenRouterModelIds,
  modelSupportsStructuredOutputs,
  getOpenRouterBenchmarkScore,
} from "@/lib/cost/openrouter-pricing";
import { isFreeTierModel } from "@/lib/agent/proposer-pacing";
import { modelSupportsTools } from "@/lib/providers/tool-support";
import { isModelCircuitOpen } from "@/lib/agent/model-health";

/**
 * Used when the live catalogue has not loaded (cold boot before the first
 * fetch, no network, or Privacy Mode having suppressed the refresh).
 *
 * These are ids observed to exist AND to advertise `structured_outputs`.
 * The list is a FALLBACK, not the source of truth — free ids churn, which is
 * exactly why the live catalogue is preferred. A stale entry here degrades to
 * "that model 404s", which the failover stack already handles; it cannot
 * silently disable the Router the way a capability mismatch can.
 */
export const FREE_ROUTER_FALLBACKS: readonly string[] = [
  "nvidia/nemotron-nano-9b-v2:free",
  "openai/gpt-oss-20b:free",
  "google/gemma-4-26b-a4b-it:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
];

/**
 * Fallback pool for the brain + proposers.
 *
 * Ordered tool-capable-first so that even a cold-boot run with no catalogue
 * puts a tool-calling model in the brain slot. `google/gemma-4-…` is kept last
 * rather than removed: it is a fine proposer, and dropping ids from a pool that
 * is already tiny is how Free Mode ends up with nothing to run.
 */
export const FREE_GENERAL_FALLBACKS: readonly string[] = [
  "nvidia/nemotron-3-super-120b-a12b:free",
  "openai/gpt-oss-20b:free",
  "nvidia/nemotron-nano-9b-v2:free",
  "google/gemma-4-26b-a4b-it:free",
];

export interface FreeModeSelection {
  /** Slot assignments, ready to overlay onto settings. */
  chatModel: ModelConfig;
  utilityModel: ModelConfig;
  proposerTiers: { fast: ModelConfig; balanced: ModelConfig; frontier: ModelConfig };
  /** Where the ids came from — surfaced so a fallback run is never silent. */
  source: "live-catalogue" | "fallback-list";
  /** How many distinct free endpoints the proposer tiers span (1-3). */
  endpointSpread: number;
  /**
   * True when the Router had to reuse the brain's model because no OTHER free
   * id advertising `structured_outputs` existed.
   *
   * PM #112 — constraint 3 below ("proposers should NOT share one endpoint") was
   * written about the proposer fan-out and silently left the brain/Router pair
   * out. Both are picked "first structured-capable id, sorted", so they landed
   * on the SAME model by construction, and one upstream having a bad day took
   * the whole turn — brain, Router and the fallback probe alike. Preferring a
   * different Router removes the collision when the pool allows it; this flag
   * reports the case where it does not.
   */
  routerSharesBrainEndpoint: boolean;
  /**
   * False when no free model advertising `structured_outputs` could be found.
   * The run still works, but the Router will use static personas and tournament
   * mode will fall back to synthesis — the caller should say so out loud.
   */
  routerSupportsStructuredOutputs: boolean;
  /**
   * False when no free model known to support tool calling could be found, so
   * the brain slot had to be filled with one that cannot. The run still works,
   * but Single Agent mode drops to plain chat: no web search, no file access,
   * answers from weights only. PM #98 — the caller MUST say this out loud.
   */
  brainSupportsTools: boolean;
  /** Every free id considered, for diagnostics. */
  candidateCount: number;
  /**
   * How many free ids were dropped as non-chat (moderation classifiers,
   * vision-only, embedders). Surfaced so a shrinking pool is never silent —
   * the original defect was invisible until a live swarm collapsed.
   */
  excludedNonChat: number;
  /**
   * WHICH ids were dropped. A count alone tells you something shrank but not
   * whether the heuristic was right — and diagnosing that from a number means
   * re-deriving the catalogue by hand.
   */
  excludedNonChatIds: string[];
  /**
   * True when EVERY free id looked non-chat, so the exclusion was abandoned and
   * the raw catalogue used. That means the run is back to the behaviour this
   * filter exists to prevent — it must be visible, not inferred from a count.
   */
  exclusionEmptiedPool: boolean;
  /**
   * PM #116 — how many candidate ids were excluded because their circuit
   * breaker is currently OPEN (recent endpoint-side failures). Before this,
   * `selectFreeModels()` ranked and picked with zero memory of a model's own
   * recent health — the breaker existed but was consulted only for WITHIN-turn
   * substitution, after the doomed model had already been picked. A fresh
   * `selectFreeModels()` call for the NEXT turn had no idea the top-scored
   * model had just failed and picked it again — live-observed hammering the
   * same shared-pool-throttled model for 9+ sustained hours.
   */
  excludedUnhealthy: number;
  /** WHICH ids were excluded for an open circuit — same rationale as `excludedNonChatIds`. */
  excludedUnhealthyIds: string[];
  /**
   * True when EVERY scored id had an open circuit, so the health filter was
   * abandoned and the full (unfiltered) catalogue used instead — protake
   * council review flagged this exact fallback as mandatory: reintroducing the
   * "silent empty pool" bug class one layer up from where it was fixed
   * tonight (PM #115) would be worse than the thing being fixed.
   */
  healthyPoolEmptied: boolean;
}

function cfg(model: string): ModelConfig {
  // Provider + model ONLY. Keys resolve server-side (`resolveWorkerKey`), which
  // is also the security shape the per-request Skeptic override settled on: a
  // model selection must never carry a key or a baseUrl.
  return { provider: "openrouter", model };
}

/**
 * Pick `n` ids spread across the pool, wrapping when the pool is smaller.
 * Deterministic: the same catalogue always yields the same assignment, so a
 * run is reproducible and a bug report names the same models twice.
 */
function spread(pool: readonly string[], n: number): string[] {
  if (pool.length === 0) return [];
  return Array.from({ length: n }, (_, i) => pool[i % pool.length]);
}

/**
 * Order free model ids by measured capability, strongest first.
 *
 * Primary key `intelligence_index` (general capability); `agentic_index` is
 * the first tiebreak rather than `coding_index` — Orchestra is a tool-calling
 * agent, not a code-completion tool, so that field is the closer match for
 * "which model should drive this turn." `coding_index` is the second tiebreak.
 * An id with no benchmark data (roughly a third of the live free catalogue,
 * including today's actual brain, `dots-studio/dots-3-note-preview:free`)
 * sinks to the bottom and tie-breaks alphabetically among other unscored ids —
 * "no evidence, no credit," the same principle `pickBrain` already uses for
 * capability gating. Plain compare, not `localeCompare`, for determinism
 * across runtimes (`spread()`'s "same catalogue -> same assignment" contract).
 *
 * `ORCHESTRA_FREE_MODE_RANK=legacy` restores the original plain alphabetical
 * sort with no redeploy.
 */
export function sortFreeModelsByScore(ids: readonly string[]): string[] {
  if (process.env.ORCHESTRA_FREE_MODE_RANK === "legacy") return [...ids].sort();
  return [...ids].sort((a, b) => {
    const sa = getOpenRouterBenchmarkScore(a);
    const sb = getOpenRouterBenchmarkScore(b);
    const intelligenceDiff = (sb?.intelligence ?? -1) - (sa?.intelligence ?? -1);
    if (intelligenceDiff !== 0) return intelligenceDiff;
    const agenticDiff = (sb?.agentic ?? -1) - (sa?.agentic ?? -1);
    if (agenticDiff !== 0) return agenticDiff;
    const codingDiff = (sb?.coding ?? -1) - (sa?.coding ?? -1);
    if (codingDiff !== 0) return codingDiff;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/** Free OpenRouter ids are always reached through the `openrouter` provider. */
const supportsTools = (id: string) => modelSupportsTools("openrouter", id);

/**
 * Pick the brain (the Single Agent chat model) from the general pool.
 *
 * Preference order, strongest key first:
 *   1. tool-capable AND structured-output capable — the whole feature set;
 *   2. tool-capable — tools beat well-formed JSON, because losing tools loses
 *      web search and every file operation, while the brain rarely needs
 *      `generateObject` (that is the Router's job);
 *   3. structured-output capable — no tools exist in the pool, so fall back to
 *      the previous heuristic rather than to raw alphabetical order;
 *   4. whatever is first.
 *
 * Never returns undefined for a non-empty pool, and never narrows the pool:
 * step 4 always fires. That is the "honesty over exclusion" rule — the caller
 * reports the degradation via `brainSupportsTools` instead of Free Mode
 * refusing to run because free tool-capable ids happen to be scarce this week.
 */
function pickBrain(generalPool: readonly string[], structured: readonly string[]): string {
  const structuredSet = new Set(structured);
  return (
    generalPool.find((id) => supportsTools(id) && structuredSet.has(id)) ??
    generalPool.find(supportsTools) ??
    generalPool.find((id) => structuredSet.has(id)) ??
    generalPool[0]
  );
}

/**
 * Choose free models from the live OpenRouter catalogue, falling back to the
 * curated lists when it has not loaded. Pure apart from reading the cache.
 */
/**
 * Free ids that are NOT general text-generation models.
 *
 * Found by a live swarm run, not by review: Free Mode handed
 * `nvidia/nemotron-3.5-content-safety:free` (a moderation classifier) and
 * `nvidia/nemotron-nano-12b-v2-vl:free` (vision-language) to proposers as
 * drafting models. Both answered "Provider returned error" instantly, the
 * circuit breaker opened after three strikes, and the ensemble reported
 * `0/5 proposers produced a usable draft` — a total swarm failure that looked
 * like free-tier rate limiting and was not.
 *
 * Same discipline as `NO_TOOL_PATTERNS` in `providers/tool-support.ts`: match
 * the NARROWEST substring that identifies the class, and pair every entry with
 * a positive test case. A pattern that over-matches silently shrinks the pool
 * and pushes every slot onto one endpoint — the failure this is fixing.
 */
const NON_CHAT_PATTERNS = [
  "content-safety",
  "guard", // llama-guard / nemoguard — moderation classifiers
  "moderation",
  "embed",
  "rerank",
  "-ocr",
  "whisper",
  "-tts",
  "-stt",
] as const;

/**
 * Is this id usable as a text proposer / brain?
 *
 * Vision-language models are excluded by SUFFIX rather than substring: `-vl`
 * appears inside plenty of ordinary names, so only a trailing `-vl` (after the
 * `:free` tag is stripped) counts.
 */
export function isGeneralChatModel(id: string): boolean {
  const lower = id.toLowerCase();
  const withoutTag = lower.split(":")[0];
  if (withoutTag.endsWith("-vl")) return false;
  return !NON_CHAT_PATTERNS.some((p) => lower.includes(p));
}

export function selectFreeModels(): FreeModeSelection {
  // Sorted so selection is stable across processes — catalogue order is not.
  const catalogue = sortFreeModelsByScore(listOpenRouterModelIds().filter(isFreeTierModel));

  const live = catalogue.length > 0;

  // PM #116 — exclude a circuit-open id BEFORE ranking/picking, not just at
  // within-turn substitution time. Same idiom as the chatCapable filter below
  // (preference, not a hard filter): if every scored id happens to have an
  // open circuit, fall back to the unfiltered catalogue rather than zeroing
  // the pool — a temporarily-tripped breaker is not "no free models exist".
  const healthy = catalogue.filter((id) => !isModelCircuitOpen("openrouter", id));
  const healthyPoolEmptied = live && catalogue.length > 0 && healthy.length === 0;
  const workingCatalogue = healthyPoolEmptied ? catalogue : healthy;
  const excludedUnhealthyIds = catalogue.filter((id) => !workingCatalogue.includes(id));

  const chatCapable = workingCatalogue.filter(isGeneralChatModel);

  // The Router pool is drawn from the CHAT-capable set, not the raw catalogue.
  // A moderation classifier can legitimately advertise `structured_outputs` —
  // emitting a JSON verdict is its whole job — so without this it could be
  // selected as Router. That failure is worse than a bad proposer: a dead
  // proposer is dropped and the ensemble degrades, whereas a Router that
  // cannot write personas takes the swarm's role specialisation with it.
  const structured = (chatCapable.length > 0 ? chatCapable : workingCatalogue).filter(
    (id) => modelSupportsStructuredOutputs(id) === true
  );
  const routerPool = structured.length > 0 ? structured : FREE_ROUTER_FALLBACKS;
  // `modelSupportsStructuredOutputs` returning `undefined` means "the catalogue
  // does not know", which is NOT "incapable", so nothing is disqualified on
  // that basis. Model CLASS is different: a moderation classifier or a
  // vision-only model cannot draft text at all, and handing one to a proposer
  // is not a degraded run, it is a guaranteed failure.
  //
  // Kept as a PREFERENCE, matching the tool-support policy directly above: if
  // the exclusion would empty the pool, take the raw catalogue instead. Free
  // Mode failing shut because this week's free list happens to look odd would
  // be worse than the thing being fixed.
  const exclusionEmptiedPool = live && chatCapable.length === 0;
  const generalPool = live ? (exclusionEmptiedPool ? workingCatalogue : chatCapable) : FREE_GENERAL_FALLBACKS;

  const brain = pickBrain(generalPool, structured);

  // Router on a DIFFERENT endpoint from the brain where the pool allows it
  // (PM #112). `routerPool[0]` and `pickBrain` both resolve to the first
  // structured-capable id, so taking [0] unconditionally guaranteed a
  // collision. Falls back to sharing rather than leaving the slot empty — a
  // Router on the brain's endpoint still works; no Router does not.
  const router = routerPool.find((id) => id !== brain) ?? routerPool[0];

  // Spread the three proposer tiers across DISTINCT endpoints where possible.
  // Rotating the pool to start AFTER the brain keeps the brain's endpoint out
  // of the first proposer slot, so its own quota is not the first one hammered.
  // Rotating by the brain's index — not by a hardcoded 1 — is what keeps that
  // true now that the brain is chosen by capability rather than by position.
  const brainAt = Math.max(0, generalPool.indexOf(brain));
  const rotated = generalPool.length > 1
    ? [...generalPool.slice(brainAt + 1), ...generalPool.slice(0, brainAt + 1)]
    : generalPool;
  const tiers = spread(rotated, 3);

  return {
    chatModel: cfg(brain),
    utilityModel: cfg(router),
    // `rotated` (and so `tiers`) is now score-descending after the brain, not
    // alphabetical — `tiers[0]` is the strongest of the three, so it goes to
    // `frontier`, not `fast`. Under the pre-ranking behavior this mapping
    // didn't matter (the array order carried no meaning); now it does, or the
    // tier names would lie about which proposer is actually the strongest.
    proposerTiers: {
      frontier: cfg(tiers[0]),
      balanced: cfg(tiers[1]),
      fast: cfg(tiers[2]),
    },
    source: live ? "live-catalogue" : "fallback-list",
    endpointSpread: new Set(tiers).size,
    routerSharesBrainEndpoint: router === brain,
    routerSupportsStructuredOutputs: structured.length > 0,
    brainSupportsTools: supportsTools(brain),
    candidateCount: catalogue.length,
    // Computed against `workingCatalogue` (post health-filter), not the raw
    // catalogue — otherwise a circuit-open id would double-count as "excluded
    // as non-chat" too, conflating two unrelated exclusion reasons.
    excludedNonChat: live ? workingCatalogue.length - chatCapable.length : 0,
    excludedNonChatIds: live ? workingCatalogue.filter((id) => !isGeneralChatModel(id)) : [],
    exclusionEmptiedPool,
    excludedUnhealthy: excludedUnhealthyIds.length,
    excludedUnhealthyIds,
    healthyPoolEmptied,
  };
}

/** Is Free Mode requested by settings? */
export function isFreeModeEnabled(settings: AppSettings): boolean {
  return settings.freeMode?.enabled === true;
}

/**
 * Overlay free models onto a settings object.
 *
 * Returns the settings UNCHANGED when Free Mode is off, or when Privacy Mode is
 * on — the two are mutually exclusive by construction: Free Mode means
 * OpenRouter, and Privacy Mode's whole contract is that no user data reaches a
 * cloud vendor. Silently swapping in a cloud model there would turn a privacy
 * guarantee into a privacy breach, so Free Mode yields rather than fight it.
 * The caller surfaces the conflict; this function never throws.
 */
export function applyFreeMode(settings: AppSettings): {
  settings: AppSettings;
  selection: FreeModeSelection | null;
  suppressedByPrivacyMode: boolean;
} {
  if (!isFreeModeEnabled(settings)) {
    return { settings, selection: null, suppressedByPrivacyMode: false };
  }
  if (settings.privacyMode?.enabled) {
    return { settings, selection: null, suppressedByPrivacyMode: true };
  }

  const selection = selectFreeModels();
  return {
    settings: {
      ...settings,
      chatModel: selection.chatModel,
      utilityModel: selection.utilityModel,
      proposerTiers: {
        // Preserve a pinned Skeptic if the operator set one: it is a deliberate
        // quality choice about WHO audits, orthogonal to "which tier models".
        // If it points at a paid model the failover stack handles it normally.
        ...settings.proposerTiers,
        ...selection.proposerTiers,
      },
    },
    selection,
    suppressedByPrivacyMode: false,
  };
}

/** One-line operator-facing summary — logged, and shown in the UI notice. */
export function describeFreeModeSelection(s: FreeModeSelection): string {
  const shared = s.routerSharesBrainEndpoint
    ? " (SHARES the brain's endpoint — no other structured-output free model exists right now, so one bad upstream takes both)"
    : "";
  const router = s.routerSupportsStructuredOutputs
    ? `router=${s.utilityModel.model}${shared}`
    : `router=${s.utilityModel.model} (NO structured_outputs — static personas, tournament falls back to synthesis)${shared}`;
  const brain = s.brainSupportsTools
    ? `brain=${s.chatModel.model}`
    : `brain=${s.chatModel.model} (NO tool support — Single Agent mode answers from ` +
      `knowledge only: no web search, no file access. No free tool-capable model ` +
      `was available; add a key or turn Free Mode off to get tools back)`;
  return (
    `Free Mode [${s.source}, ${s.candidateCount} free models seen` +
    (s.excludedNonChat > 0
      ? `, ${s.excludedNonChat} dropped as non-chat (${s.excludedNonChatIds.join(", ")})`
      : "") +
    (s.exclusionEmptiedPool ? ", ALL looked non-chat so the exclusion was ABANDONED" : "") +
    (s.excludedUnhealthy > 0
      ? `, ${s.excludedUnhealthy} dropped as currently unhealthy (${s.excludedUnhealthyIds.join(", ")})`
      : "") +
    (s.healthyPoolEmptied ? ", ALL scored ids are currently unhealthy so the health filter was ABANDONED" : "") +
    `]: ` +
    `${brain}, ${router}, ` +
    `proposers across ${s.endpointSpread} endpoint(s): ` +
    `${s.proposerTiers.fast.model}, ${s.proposerTiers.balanced.model}, ${s.proposerTiers.frontier.model}`
  );
}
