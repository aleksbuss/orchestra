/**
 * Cumulative usage accumulator for the soft budget banner (PM #36).
 *
 * Why a dedicated helper: the per-turn accounting touches three+ surfaces
 * (main streamText, MoA Router via generateObject, MoA proposers + aggregator
 * via generateText). Each returns a `usage` object with potentially-varying
 * field names depending on the AI SDK version. Centralising the merge here
 * keeps all callsites identical and avoids drift.
 *
 * Token-field naming: AI SDK 6.x emits `usage.inputTokens` / `usage.outputTokens`;
 * older code paths may surface `promptTokens` / `completionTokens`. We accept
 * either via `normalizeUsage` and write the canonical `promptTokens` /
 * `completionTokens` shape into the chat metadata.
 */
import type { ChatUsage } from "@/lib/types";
import {
  estimateCostFor,
  type UsageRecord,
} from "./pricing";

/** Accept either AI SDK v5 (promptTokens/completionTokens) or v6+ (inputTokens/outputTokens). */
export interface RawUsage {
  promptTokens?: number;
  completionTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export function normalizeUsage(raw: RawUsage | undefined | null): UsageRecord {
  if (!raw) return { promptTokens: 0, completionTokens: 0 };
  return {
    promptTokens: raw.promptTokens ?? raw.inputTokens ?? 0,
    completionTokens: raw.completionTokens ?? raw.outputTokens ?? 0,
  };
}

/**
 * Add one LLM call's (usage, provider, model) into the running cumulative.
 *
 * The accumulator is a pure function — caller decides whether to persist
 * the result. `current` is `null` for a fresh chat; the function returns
 * the starting record in that case.
 *
 * `fullyPriced` propagates as an AND across all calls: once a single call
 * with unknown pricing lands, the chat's cumulative is forever "lower bound"
 * until the operator clears the chat. The banner labels accordingly.
 */
export function addUsageToCumulative(
  current: ChatUsage | undefined,
  provider: string,
  modelId: string,
  raw: RawUsage | undefined | null
): ChatUsage {
  const usage = normalizeUsage(raw);
  const cost = estimateCostFor(provider, modelId, usage);

  const base: ChatUsage = current ?? {
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
    fullyPriced: true,
  };

  return {
    promptTokens: base.promptTokens + usage.promptTokens,
    completionTokens: base.completionTokens + usage.completionTokens,
    costUsd: base.costUsd + cost.totalUsd,
    // Once any call is unpriced, the total becomes a lower bound forever.
    fullyPriced: base.fullyPriced && cost.knownPricing,
  };
}

/**
 * Merge two ChatUsage records — used when MoA bubbles up its own internal
 * sum (router + N proposers + aggregator) and the agent path adds it to
 * the chat's running total in one shot.
 */
export function mergeUsage(
  a: ChatUsage | undefined,
  b: ChatUsage | undefined
): ChatUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    costUsd: a.costUsd + b.costUsd,
    fullyPriced: a.fullyPriced && b.fullyPriced,
  };
}
