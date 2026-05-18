/**
 * Whether a given (provider, model) pair supports function/tool calling.
 *
 * Why this lives in its own file: the audit (PM #17 — see POST_MORTEMS) found
 * the OpenRouter detection branch in `agent.ts` was checking ONLY for
 * `deepseek-r1`, ignoring the broader `NO_TOOL_PATTERNS` list that the Ollama
 * branch (correctly) consults. Result: a user picking `google/gemma-4-31b-it`
 * via OpenRouter got 63 tools forwarded to a model that cannot tool-call →
 * OpenRouter returned 404 "No endpoints found that support tool use" → the
 * agent run died silently AFTER the MoA pipeline had already produced a
 * consensus, so the operator saw "Swarm crashed" with nothing in the UI.
 *
 * Centralizing the logic + adding unit coverage makes that class of bug a
 * single-line code review concern instead of "did anyone update both
 * branches when they added a new pattern."
 *
 * Note: this module is intentionally synchronous and side-effect-free.
 * The Ollama capability probe (which calls `<base>/api/show`) stays in
 * `agent.ts` because it's an async I/O call gated on a 3s timeout — this
 * helper is the FALLBACK used when the probe fails or when the provider is
 * not Ollama.
 */
import type { ModelConfig } from "@/lib/types";

/**
 * Substring patterns of model ids known to NOT support function/tool calling.
 *
 * The patterns are matched case-insensitively as substrings of the model id
 * (e.g. `google/gemma-4-31b-it` matches `gemma-`). Add new patterns here when
 * you discover a model class that 404s on tool calls.
 *
 * Reasoning models (deepseek-r1) are listed first; these are commonly the
 * tempting "free / cheap" picks that cause the silent failure described in
 * PM #17.
 */
export const NO_TOOL_PATTERNS: readonly string[] = [
  "deepseek-r1",
  "gemma3", "gemma2", "gemma:", "gemma-",
  "phi4", "phi3", "phi-",
  "mistral", "mixtral",
  "codellama", "starcoder",
  "tinyllama", "stablelm",
  "yi-",
] as const;

/**
 * Decide whether to forward `tools` to the model on the next call.
 *
 * Returns `false` if the model id (case-insensitive) contains any of
 * `NO_TOOL_PATTERNS`. Caller should run the agent in plain-chat mode
 * (no tools) when this returns `false`.
 *
 * For Ollama, callers should ALSO consult the live `/api/show` template
 * before falling back here — local Ollama users frequently install
 * tool-capable forks of the same base model, and the live template is
 * authoritative.
 */
export function modelSupportsTools(provider: ModelConfig["provider"], modelId: string): boolean {
  const id = (modelId ?? "").toLowerCase();
  if (!id) return true; // unknown id — assume yes; the upstream API will tell us if not.

  // For all providers we currently target (openai, anthropic, google,
  // openrouter, ollama, custom, codex-cli, gemini-cli), the same substring
  // patterns apply: "gemma-" is gemma whether you reach it via Ollama or
  // OpenRouter. PM #17 was specifically the OpenRouter branch ignoring the
  // shared list — a single source of truth fixes that whole class.
  if (NO_TOOL_PATTERNS.some(p => id.includes(p))) return false;

  // Provider-specific extras can be added here as they're discovered. Keep
  // the list short — most signals are model-id-specific, not provider-
  // specific. If you find yourself adding many provider clauses, prefer
  // pushing the substring into NO_TOOL_PATTERNS instead.
  void provider;
  return true;
}
