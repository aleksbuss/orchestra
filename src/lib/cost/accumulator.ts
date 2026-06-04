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

/**
 * Fold a single agent turn's usage into the running per-chat cumulative.
 *
 * A turn can bill across THREE surfaces and every one must be counted (PM #36):
 *   - `streamUsage`       — the main `streamText` call.
 *   - `continuationUsage` — the auto-continuation `generateText` call that
 *     extends a length-truncated reply (full context re-sent + up to 1200
 *     output tokens). Dropping this under-reports the cost banner AND the
 *     per-chat USD cap on every truncated turn (the bug this helper closes).
 *   - `turnExtraUsage`    — the MoA bundle (router + proposers + aggregator),
 *     already summed into a single `ChatUsage` by the MoA layer.
 *
 * Centralising the fold keeps the contract in one testable place: a future
 * refactor that forgets one source fails the unit test rather than silently
 * leaking spend. Pure function — caller persists the result.
 */
export function foldTurnUsage(
  base: ChatUsage | undefined,
  provider: string,
  modelId: string,
  sources: {
    streamUsage?: RawUsage | null;
    continuationUsage?: RawUsage | null;
    turnExtraUsage?: ChatUsage;
  }
): ChatUsage {
  let next = addUsageToCumulative(base, provider, modelId, sources.streamUsage);
  next = addUsageToCumulative(next, provider, modelId, sources.continuationUsage);
  if (sources.turnExtraUsage) {
    next = mergeUsage(next, sources.turnExtraUsage) ?? next;
  }
  return next;
}

/**
 * Sprint 2 — per-chat hard USD cap.
 *
 * `settings.costGuard.maxUsdPerChat` is optional and only enforced when set
 * to a positive finite number. The accumulator never persists state on its
 * own; this helper just inspects the chat's existing cumulative against the
 * cap and tells the caller whether to refuse the next turn.
 *
 * Three returns:
 *   - `{ over: false }` — no cap, or cap not exceeded, proceed.
 *   - `{ over: true, costUsd, maxUsdPerChat }` — cap exceeded; caller
 *     translates this into a 402 response with the included numbers.
 *
 * `fullyPriced=false` is deliberately enforced too: a chat whose cumulative
 * is a lower bound and ALREADY over the cap is, by construction, AT LEAST
 * over the cap on real spend. Better to err on the side of "stop" than
 * silently let unpriced models bypass the guard.
 */
export interface BudgetCheckResult {
  over: boolean;
  costUsd: number;
  maxUsdPerChat: number | null;
}

export function checkChatBudget(
  current: ChatUsage | undefined,
  maxUsdPerChat: number | undefined | null
): BudgetCheckResult {
  const cap =
    typeof maxUsdPerChat === "number" &&
    Number.isFinite(maxUsdPerChat) &&
    maxUsdPerChat > 0
      ? maxUsdPerChat
      : null;
  const costUsd = current?.costUsd ?? 0;
  if (cap === null) {
    return { over: false, costUsd, maxUsdPerChat: null };
  }
  return {
    over: costUsd >= cap,
    costUsd,
    maxUsdPerChat: cap,
  };
}

/**
 * Thin wrapper that throws a labelled error when over budget. Callers can
 * `try { assertChatBudget(...) } catch (err) { if (err instanceof
 * ChatBudgetExceededError) ... }` to map the error to a 402.
 */
export class ChatBudgetExceededError extends Error {
  readonly costUsd: number;
  readonly maxUsdPerChat: number;
  constructor(costUsd: number, maxUsdPerChat: number) {
    super(
      `Chat budget exceeded: cumulative cost $${costUsd.toFixed(4)} >= cap $${maxUsdPerChat.toFixed(2)}. Lift settings.costGuard.maxUsdPerChat or start a new chat.`
    );
    this.name = "ChatBudgetExceededError";
    this.costUsd = costUsd;
    this.maxUsdPerChat = maxUsdPerChat;
  }
}

export function assertChatBudget(
  current: ChatUsage | undefined,
  maxUsdPerChat: number | undefined | null
): void {
  const result = checkChatBudget(current, maxUsdPerChat);
  if (result.over && result.maxUsdPerChat !== null) {
    throw new ChatBudgetExceededError(result.costUsd, result.maxUsdPerChat);
  }
}
