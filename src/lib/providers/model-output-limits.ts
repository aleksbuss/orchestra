/**
 * Per-model max OUTPUT token resolution.
 *
 * Different models cap completion length very differently (gpt-4o 16k, Claude
 * 3.5 8k, Gemini 2.5 64k, DeepSeek 8k, …). Hardcoding a single number (the old
 * `?? 4096`) either truncated capable models or risked over-requesting on small
 * ones. This module resolves the right ceiling for the SELECTED model:
 *
 *   resolveMaxOutputTokens(cfg) =
 *     cfg.maxTokens (operator override, capped at the model's true max)
 *     ?? the model's known max output
 *     ?? DEFAULT_MAX_OUTPUT
 *
 * The model's max comes from (a) the live OpenRouter `/models` metadata cache
 * (`max_completion_tokens`) when the provider is OpenRouter — injected at
 * runtime to avoid a cycle — else (b) a static family registry below.
 */
import type { ModelConfig } from "@/lib/types";

/** Generous, model-agnostic fallback when nothing else is known. Providers cap
 *  the request to their true max, so an over-estimate degrades gracefully. */
export const DEFAULT_MAX_OUTPUT = 8192;

/**
 * Static family registry — ordered MOST-SPECIFIC FIRST (the first substring
 * match on the lowercased model id wins, so `gpt-4o` must precede `gpt-4`).
 * Values are the documented max completion tokens for the family. Approximate
 * and drift over time — the OpenRouter dynamic source (when available) wins.
 */
const FAMILY_LIMITS: Array<[pattern: string, maxOutput: number]> = [
  // OpenAI reasoning models — very large completion budgets.
  ["o1", 100_000],
  ["o3", 100_000],
  ["o4", 100_000],
  ["gpt-4.1", 32_768],
  ["gpt-4o", 16_384],
  ["gpt-4-turbo", 4_096],
  ["gpt-4", 8_192],
  ["gpt-3.5", 4_096],
  // Anthropic — DEFAULT (no-beta) output caps only. Anthropic gates higher
  // limits (64k/128k on Sonnet, 32k on Opus) behind `anthropic-beta` headers
  // Orchestra does NOT send, so requesting >8192 on those models 400s. Keep
  // every Claude family at its safe default; revisit if the beta header is wired.
  ["claude-opus-4", 8_192],
  ["claude-sonnet-4", 8_192],
  ["claude-3-7", 8_192],
  ["claude-3.7", 8_192],
  ["claude-3-5", 8_192],
  ["claude-3.5", 8_192],
  ["claude-3", 4_096],
  // Google Gemini.
  ["gemini-2.5", 65_536],
  ["gemini-2.0", 8_192],
  ["gemini-1.5", 8_192],
  ["gemini", 8_192],
  // DeepSeek.
  ["deepseek", 8_192],
  // Common open families (Ollama / OpenRouter) — safe generous default.
  ["qwen", 8_192],
  ["llama", 8_192],
  ["mistral", 8_192],
  ["mixtral", 8_192],
  ["gemma", 8_192],
];

/**
 * Optional runtime provider of OpenRouter per-model max output (set by
 * `openrouter-pricing` at module load). Kept as an injectable hook so this
 * module stays dependency-light and free of import cycles. Returns the model's
 * `max_completion_tokens` or undefined when unknown.
 */
let openRouterMaxOutputLookup: ((modelId: string) => number | undefined) | null = null;
export function registerOpenRouterMaxOutputLookup(
  fn: (modelId: string) => number | undefined
): void {
  openRouterMaxOutputLookup = fn;
}

/** The model's known max output tokens, or undefined when unknown. */
export function getModelMaxOutput(
  provider: ModelConfig["provider"],
  modelId: string | undefined
): number | undefined {
  if (!modelId) return undefined;
  const id = modelId.toLowerCase();

  // OpenRouter: prefer the live `/models` metadata (the "query" — cached).
  if (provider === "openrouter" && openRouterMaxOutputLookup) {
    const dynamic = openRouterMaxOutputLookup(modelId);
    if (dynamic && dynamic > 0) return dynamic;
  }

  for (const [pattern, max] of FAMILY_LIMITS) {
    if (id.includes(pattern)) return max;
  }
  return undefined;
}

/**
 * The max output tokens to request for a generation with this model config.
 * An explicit operator `maxTokens` is honored but never allowed to EXCEED the
 * model's true max (avoids provider 400s / wasted budget); when unset, the
 * model's max (or the default) is used so answers auto-size to the model.
 */
export function resolveMaxOutputTokens(cfg: ModelConfig): number {
  const modelMax = getModelMaxOutput(cfg.provider, cfg.model);
  const requested = cfg.maxTokens;
  if (typeof requested === "number" && requested > 0) {
    return modelMax ? Math.min(requested, modelMax) : requested;
  }
  return modelMax ?? DEFAULT_MAX_OUTPUT;
}
