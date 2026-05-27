"use client";

/**
 * Soft per-chat budget banner (PM #36). Renders cumulative tokens + USD
 * estimate for the active chat. Deliberately NOT a hard cap — just
 * situational awareness so the operator and their friends see what a chat
 * is spending without hitting their provider invoice unprepared.
 *
 * Display rules:
 *   - Hidden when usage is zero or undefined (clean chat, no LLM call yet).
 *   - Tokens always shown (cheap fact, never wrong).
 *   - USD shown as `~$0.0123` when `fullyPriced=true` and cost > 0.
 *   - USD shown as `cost unknown` (no $ number) when fullyPriced=false —
 *     pricing returned null for at least one model in this chat's history.
 *     Better to label honestly than to fabricate `$0.00`.
 *   - USD shown as `local (no cost)` when fullyPriced=true AND cost == 0
 *     (every LLM call was a local provider like Ollama).
 */
import type { ChatUsage } from "@/lib/types";

interface BudgetBannerProps {
  usage: ChatUsage | undefined;
}

/**
 * Format a USD number with appropriate precision. Below $0.01 we show four
 * decimal places (the operator cares about fractional cents accumulating);
 * above $0.01 we show two.
 */
function formatUsd(value: number): string {
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export function BudgetBanner({ usage }: BudgetBannerProps) {
  if (!usage) return null;
  const totalTokens = usage.promptTokens + usage.completionTokens;
  if (totalTokens === 0) return null;

  let costLabel: string;
  if (!usage.fullyPriced) {
    costLabel = "cost ~$" + formatUsd(usage.costUsd).replace("$", "") + " (partial — some models unpriced)";
    if (usage.costUsd === 0) {
      costLabel = "cost unknown (no pricing data for this model)";
    }
  } else if (usage.costUsd === 0) {
    costLabel = "local (no cost)";
  } else {
    costLabel = `~${formatUsd(usage.costUsd)}`;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-auto max-w-3xl w-full px-4 md:px-6 pt-2 pb-1 text-[11px] text-muted-foreground/80 flex items-center gap-2 select-none"
      title={`Prompt: ${usage.promptTokens.toLocaleString()} · Completion: ${usage.completionTokens.toLocaleString()} tokens. Estimate based on published per-million-token rates; verify against your provider invoice.`}
    >
      <span className="inline-flex items-center gap-1">
        <span className="size-1.5 rounded-full bg-muted-foreground/40" />
        <span>
          {formatTokens(totalTokens)} tokens · {costLabel}
        </span>
      </span>
    </div>
  );
}
