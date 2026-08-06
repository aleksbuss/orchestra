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
 * TWO CONSTRAINTS DRIVE THE SELECTION:
 *
 * 1. **The Router needs `structured_outputs`.** Persona generation and the
 *    tournament judges' ballots go through `generateObject`. A free model
 *    without that capability answers HTTP 400, the Router falls back to three
 *    STATIC personas, and every judge fails. Both fallbacks are fail-safe and
 *    loud in stdout, but the turn still looks healthy — you get an answer, the
 *    proposers succeed, and nothing says the swarm just lost the two features
 *    that distinguish it from N-sampling. Only a minority of free models
 *    qualify, so the Router slot is filled from that subset or not at all.
 *    The brain and the proposers do NOT need the capability.
 *
 * 2. **Proposers should NOT share one endpoint.** A free endpoint under load
 *    returns HTTP 200 with an empty body, and the trigger is exactly the shape
 *    MoA generates: 3-5 proposers firing at one shared endpoint through one key.
 *    Pacing bounds the burst in time; spreading the tiers across DIFFERENT free
 *    models spreads it across different upstream quotas, which is the cheaper
 *    fix because it removes the contention instead of queueing behind it.
 *
 * NOT A PRESET WRITE: `applyFreeMode` returns a NEW settings object. Nothing is
 * persisted, so a user who flips Free off has their paid configuration back
 * exactly as it was — no "restore your models" migration to get wrong.
 */
import type { AppSettings, ModelConfig } from "@/lib/types";
import {
  listOpenRouterModelIds,
  modelSupportsStructuredOutputs,
} from "@/lib/cost/openrouter-pricing";
import { isFreeTierModel } from "@/lib/agent/proposer-pacing";

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

/** Fallback pool for the brain + proposers, which need no special capability. */
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
   * False when no free model advertising `structured_outputs` could be found.
   * The run still works, but the Router will use static personas and tournament
   * mode will fall back to synthesis — the caller should say so out loud.
   */
  routerSupportsStructuredOutputs: boolean;
  /** Every free id considered, for diagnostics. */
  candidateCount: number;
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
 * Choose free models from the live OpenRouter catalogue, falling back to the
 * curated lists when it has not loaded. Pure apart from reading the cache.
 */
export function selectFreeModels(): FreeModeSelection {
  // Sorted so selection is stable across processes — catalogue order is not.
  const catalogue = listOpenRouterModelIds().filter(isFreeTierModel).sort();

  const structured = catalogue.filter(
    (id) => modelSupportsStructuredOutputs(id) === true
  );
  // `undefined` means "catalogue does not know", which is NOT "incapable" —
  // treat only an explicit false as a disqualification for the general pool.
  const general = catalogue.length > 0 ? catalogue : [];

  const live = catalogue.length > 0;
  const routerPool = structured.length > 0 ? structured : FREE_ROUTER_FALLBACKS;
  const generalPool = general.length > 0 ? general : FREE_GENERAL_FALLBACKS;

  // Prefer a structured-output model for the brain too when one is available:
  // it costs nothing and keeps the brain on a model known to be well-formed.
  const brain = (structured.length > 0 ? structured : generalPool)[0];

  // Spread the three proposer tiers across DISTINCT endpoints where possible.
  // Rotating the general pool by 1 keeps the brain's endpoint out of the first
  // proposer slot, so the brain's own quota is not the first one hammered.
  const rotated = generalPool.length > 1
    ? [...generalPool.slice(1), generalPool[0]]
    : generalPool;
  const tiers = spread(rotated, 3);

  return {
    chatModel: cfg(brain),
    utilityModel: cfg(routerPool[0]),
    proposerTiers: {
      fast: cfg(tiers[0]),
      balanced: cfg(tiers[1]),
      frontier: cfg(tiers[2]),
    },
    source: live ? "live-catalogue" : "fallback-list",
    endpointSpread: new Set(tiers).size,
    routerSupportsStructuredOutputs: structured.length > 0,
    candidateCount: catalogue.length,
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
  const router = s.routerSupportsStructuredOutputs
    ? `router=${s.utilityModel.model}`
    : `router=${s.utilityModel.model} (NO structured_outputs — static personas, tournament falls back to synthesis)`;
  return (
    `Free Mode [${s.source}, ${s.candidateCount} free models seen]: ` +
    `brain=${s.chatModel.model}, ${router}, ` +
    `proposers across ${s.endpointSpread} endpoint(s): ` +
    `${s.proposerTiers.fast.model}, ${s.proposerTiers.balanced.model}, ${s.proposerTiers.frontier.model}`
  );
}
