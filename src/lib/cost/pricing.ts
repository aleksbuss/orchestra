/**
 * Per-provider × per-model pricing snapshot for the soft budget banner
 * (PM #36). Numbers are USD per million tokens. The banner exists to give
 * the operator situational awareness — "this chat spent ~$X" — NOT as a
 * hard billing system, so the data discipline is:
 *
 *   - Hardcoded major-model rates here. Updated by hand when providers
 *     change pricing (rare event — ~2-3× per year per provider).
 *   - Unknown (provider, model) returns null. The banner shows tokens only
 *     and labels the cost as "—" so the operator knows the number wasn't
 *     fabricated.
 *   - Local providers (ollama, codex-cli, gemini-cli) return zero — electricity
 *     isn't accounted here.
 *   - Substring matching on model id so a model that hasn't been seen yet
 *     (`gpt-4o-2026-01-15`) still gets the right family's pricing.
 *
 * PM #49 — `getModelPricing` now consults an in-memory live cache for
 * the OpenRouter path BEFORE falling back to the substring table. The
 * cache is populated at boot from `data/cache/openrouter-pricing.json`
 * and refreshed from `https://openrouter.ai/api/v1/models` once per
 * 24h. See [`openrouter-pricing.ts`](./openrouter-pricing.ts) for the
 * refresh orchestration. Lookup stays sync so the accumulator contract
 * doesn't change.
 */

// PM #49 — live cache lookup. Imported lazily to avoid circular-import
// concerns (the openrouter-pricing module depends on ModelPricing from
// here, and we want the type re-export to win). The function itself is
// a pure synchronous Map.get, so the indirection is cheap.
import { getCachedOpenRouterPricing } from "./openrouter-pricing";
import type { ModelPricing } from "./pricing-types";

// Canonical definition lives in ./pricing-types (breaks the openrouter-pricing
// cycle); re-exported here so existing `from "./pricing"` importers still work.
export type { ModelPricing } from "./pricing-types";

export interface UsageRecord {
  promptTokens: number;
  completionTokens: number;
}

export interface CostEstimate {
  inputUsd: number;
  outputUsd: number;
  totalUsd: number;
  /** False if pricing was unknown (cost defaulted to 0). UI labels accordingly. */
  knownPricing: boolean;
}

/**
 * Substring match table. Order matters slightly: more specific patterns
 * should come BEFORE generic ones (e.g. `gpt-4o-mini` before `gpt-4o`).
 * The matcher returns the first hit.
 */
const PRICING_TABLE: Array<{
  provider: string;
  matchModel: (id: string) => boolean;
  pricing: ModelPricing;
}> = [
  // ── OpenAI ────────────────────────────────────────────────────────────
  { provider: "openai", matchModel: (m) => m.includes("gpt-4o-mini"), pricing: { inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.6 } },
  { provider: "openai", matchModel: (m) => m.includes("gpt-4o"), pricing: { inputUsdPerMillion: 2.5, outputUsdPerMillion: 10 } },
  // gpt-4.1 family — MUST precede the generic `gpt-4` catch-all below, else
  // "gpt-4.1" matches `gpt-4` and is billed at the legacy $30/$60 (~15x too high).
  { provider: "openai", matchModel: (m) => m.includes("gpt-4.1-nano"), pricing: { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.4 } },
  { provider: "openai", matchModel: (m) => m.includes("gpt-4.1-mini"), pricing: { inputUsdPerMillion: 0.4, outputUsdPerMillion: 1.6 } },
  { provider: "openai", matchModel: (m) => m.includes("gpt-4.1"), pricing: { inputUsdPerMillion: 2, outputUsdPerMillion: 8 } },
  { provider: "openai", matchModel: (m) => m.includes("gpt-4-turbo"), pricing: { inputUsdPerMillion: 10, outputUsdPerMillion: 30 } },
  { provider: "openai", matchModel: (m) => m.includes("gpt-4"), pricing: { inputUsdPerMillion: 30, outputUsdPerMillion: 60 } },
  { provider: "openai", matchModel: (m) => m.includes("gpt-3.5"), pricing: { inputUsdPerMillion: 0.5, outputUsdPerMillion: 1.5 } },
  // o-series reasoning. The expensive `-pro` AND the cheap `-mini` variants
  // BOTH precede the bare family, else "o3-pro"/"o3-mini" match bare "o3" — and
  // for `-pro` that UNDER-reports ~10x ($2 vs o3-pro's $20/$80), which is worse
  // than "cost unknown". Prices reflect the 2025 cuts.
  { provider: "openai", matchModel: (m) => m.includes("o4-mini"), pricing: { inputUsdPerMillion: 1.1, outputUsdPerMillion: 4.4 } },
  { provider: "openai", matchModel: (m) => m.includes("o3-pro"), pricing: { inputUsdPerMillion: 20, outputUsdPerMillion: 80 } },
  { provider: "openai", matchModel: (m) => m.includes("o3-mini"), pricing: { inputUsdPerMillion: 1.1, outputUsdPerMillion: 4.4 } },
  { provider: "openai", matchModel: (m) => m.includes("o3"), pricing: { inputUsdPerMillion: 2, outputUsdPerMillion: 8 } },
  { provider: "openai", matchModel: (m) => m.includes("o1-pro"), pricing: { inputUsdPerMillion: 150, outputUsdPerMillion: 600 } },
  { provider: "openai", matchModel: (m) => m.includes("o1-mini"), pricing: { inputUsdPerMillion: 3, outputUsdPerMillion: 12 } },
  { provider: "openai", matchModel: (m) => m.includes("o1"), pricing: { inputUsdPerMillion: 15, outputUsdPerMillion: 60 } },

  // ── Anthropic ─────────────────────────────────────────────────────────
  { provider: "anthropic", matchModel: (m) => m.includes("claude-opus-4-7") || m.includes("opus-4.7") || m.includes("claude-4-7"), pricing: { inputUsdPerMillion: 15, outputUsdPerMillion: 75 } },
  { provider: "anthropic", matchModel: (m) => m.includes("claude-sonnet-4-6") || m.includes("sonnet-4.6"), pricing: { inputUsdPerMillion: 3, outputUsdPerMillion: 15 } },
  { provider: "anthropic", matchModel: (m) => m.includes("claude-haiku-4-5") || m.includes("haiku-4.5"), pricing: { inputUsdPerMillion: 0.8, outputUsdPerMillion: 4 } },
  { provider: "anthropic", matchModel: (m) => m.includes("claude-3-5-sonnet"), pricing: { inputUsdPerMillion: 3, outputUsdPerMillion: 15 } },
  { provider: "anthropic", matchModel: (m) => m.includes("claude-3-5-haiku") || m.includes("claude-3.5-haiku"), pricing: { inputUsdPerMillion: 0.8, outputUsdPerMillion: 4 } },
  { provider: "anthropic", matchModel: (m) => m.includes("claude-3-opus") || m.includes("claude-opus"), pricing: { inputUsdPerMillion: 15, outputUsdPerMillion: 75 } },
  { provider: "anthropic", matchModel: (m) => m.includes("claude-3-haiku"), pricing: { inputUsdPerMillion: 0.25, outputUsdPerMillion: 1.25 } },
  { provider: "anthropic", matchModel: (m) => m.includes("claude-3-sonnet"), pricing: { inputUsdPerMillion: 3, outputUsdPerMillion: 15 } },

  // ── Google ────────────────────────────────────────────────────────────
  // 2.5 Flash/Flash-Lite MUST precede the `gemini-2.5` catch-all, else they
  // match it and get the Pro rate ($1.25/$10) — ~4x too high for Flash.
  { provider: "google", matchModel: (m) => m.includes("gemini-2.5-flash-lite"), pricing: { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.4 } },
  { provider: "google", matchModel: (m) => m.includes("gemini-2.5-flash"), pricing: { inputUsdPerMillion: 0.3, outputUsdPerMillion: 2.5 } },
  { provider: "google", matchModel: (m) => m.includes("gemini-2.5-pro") || m.includes("gemini-2.5"), pricing: { inputUsdPerMillion: 1.25, outputUsdPerMillion: 10 } },
  { provider: "google", matchModel: (m) => m.includes("gemini-2.0-flash") || m.includes("gemini-2.0"), pricing: { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.4 } },
  { provider: "google", matchModel: (m) => m.includes("gemini-1.5-flash-8b"), pricing: { inputUsdPerMillion: 0.0375, outputUsdPerMillion: 0.15 } },
  { provider: "google", matchModel: (m) => m.includes("gemini-1.5-flash"), pricing: { inputUsdPerMillion: 0.075, outputUsdPerMillion: 0.3 } },
  { provider: "google", matchModel: (m) => m.includes("gemini-1.5-pro"), pricing: { inputUsdPerMillion: 1.25, outputUsdPerMillion: 5 } },

  // ── Local providers (zero cost) ───────────────────────────────────────
  { provider: "ollama", matchModel: () => true, pricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
  { provider: "codex-cli", matchModel: () => true, pricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
  { provider: "gemini-cli", matchModel: () => true, pricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
];

/**
 * Returns pricing for the (provider, model) pair, or `null` if unknown.
 *
 * OpenRouter is a special case — it proxies many providers and the model
 * string looks like `openrouter/anthropic/claude-3-5-sonnet`. We strip the
 * `<provider>/` prefix and re-route through the table by the upstream
 * provider's name. If the upstream isn't matched, return null (operator
 * sees "cost unknown" in the banner — honest).
 */
export function getModelPricing(
  provider: string,
  modelId: string
): ModelPricing | null {
  if (!provider || !modelId) return null;
  const normalizedProvider = provider.toLowerCase();
  const normalizedModel = modelId.toLowerCase();

  // OpenRouter passthrough: peel off the prefix and route by upstream.
  if (normalizedProvider === "openrouter") {
    // PM #49 — live cache first. OpenRouter's `/api/v1/models` returns
    // authoritative pricing for every variant including `:nitro`,
    // `:beta`, etc. which the hardcoded table can't cover. A hit here
    // sidesteps the substring rules entirely.
    const live = getCachedOpenRouterPricing(normalizedModel);
    if (live) return live;

    const slashIdx = normalizedModel.indexOf("/");
    if (slashIdx > 0) {
      const upstreamProvider = normalizedModel.slice(0, slashIdx);
      const upstreamModel = normalizedModel.slice(slashIdx + 1);
      // Free-tier suffix (`:free`) — OpenRouter convention. No charge.
      if (upstreamModel.endsWith(":free")) {
        return { inputUsdPerMillion: 0, outputUsdPerMillion: 0 };
      }
      return getModelPricing(upstreamProvider, upstreamModel);
    }
    return null;
  }

  for (const entry of PRICING_TABLE) {
    if (entry.provider !== normalizedProvider) continue;
    if (entry.matchModel(normalizedModel)) return entry.pricing;
  }
  return null;
}

/**
 * Compute USD cost from a single (usage, pricing) pair. If pricing is
 * unknown, returns zero with `knownPricing: false` so the caller can
 * display the cost as "unknown" rather than misleading "$0.00".
 */
export function estimateCost(
  usage: UsageRecord,
  pricing: ModelPricing | null
): CostEstimate {
  if (!pricing) {
    return { inputUsd: 0, outputUsd: 0, totalUsd: 0, knownPricing: false };
  }
  const inputUsd = (usage.promptTokens / 1_000_000) * pricing.inputUsdPerMillion;
  const outputUsd = (usage.completionTokens / 1_000_000) * pricing.outputUsdPerMillion;
  return {
    inputUsd,
    outputUsd,
    totalUsd: inputUsd + outputUsd,
    knownPricing: true,
  };
}

/**
 * Convenience: compute cost directly from a (provider, model, usage) triple.
 * Returns `{ totalUsd: 0, knownPricing: false }` if the model isn't priced.
 */
export function estimateCostFor(
  provider: string,
  modelId: string,
  usage: UsageRecord
): CostEstimate {
  return estimateCost(usage, getModelPricing(provider, modelId));
}
