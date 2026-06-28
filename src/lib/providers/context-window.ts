import { combineWithTimeout } from "@/lib/util/abort-signal";
import { getOpenRouterContextWindow } from "@/lib/cost/openrouter-pricing";

/**
 * Sprint A2 — single source of truth for "how many tokens fit in this model's
 * context window?" Replaces the brittle substring-on-model-name regex that
 * lived inline in `agent.ts` (it mapped `qwen2.5:latest` to an 8000 default
 * while the model actually ran at `num_ctx=4096`, silently truncating history).
 *
 * Empirically grounded (2026-06-20, Ollama 0.30.10): for a LOCAL model the real
 * limit is the RUNTIME `num_ctx`, NOT the trained `context_length` reported by
 * `/api/show` — qwen2.5 trains at 32768 but loads at 4096 by default, and its
 * Modelfile carries no `num_ctx`. The only reliable sources are `/api/ps` (the
 * loaded model's actual allocation) and, failing that, the Modelfile
 * `parameters.num_ctx`. We therefore probe, in priority order, rather than
 * guess from the name. Cloud models keep a conservative per-family map; an
 * unknown cloud model under-estimates (compacts earlier = safe), never over.
 */

/**
 * Fraction of the real window at which we trigger compaction, leaving headroom
 * for the model's own response + in-flight tool-result growth. NOTE: a flat
 * ratio is imperfect for tiny windows (it reserves too little absolute output
 * room at 4k); a fixed output reservation is the Sprint A3/A4 refinement. Kept
 * as a single tunable constant on purpose.
 */
export const COMPACTION_THRESHOLD_RATIO = 0.75;

/**
 * PM #82 — the model's RELIABLE working length, which is NOT its advertised
 * context window. A provider may advertise a giant window (OpenRouter reports
 * `qwen/qwen3-coder` at 1,048,576 tokens) while the model degrades into printed
 * `<tool_call>` markup — i.e. stops calling tools natively — at a small fraction
 * of it (~100k observed). With the raw 1M window, compaction (`0.75 × 1M` = 786k)
 * and the in-flight governor never fire, so a long agentic chat rots into an
 * unbreakable hallucination loop. We therefore cap the EFFECTIVE window used by
 * the prune-decision functions at a reliable ceiling: no current open model
 * tool-calls dependably past this in a long loop, and over-advertised windows are
 * the common case across providers. This is the cloud analogue of the Ollama
 * "advertised 32768 vs runtime 4096" note above. Tunable; key constant.
 *
 * `effectiveContextWindow` is a pure `Math.min` so it is a NO-OP for any window
 * already at/under the ceiling (32k families, local Ollama 4096) and bites ONLY
 * over-advertised large windows — provider-agnostic by construction.
 */
export const MAX_RELIABLE_CONTEXT_WINDOW = 120000;

/** Clamp an advertised window to the model's reliable working length (PM #82). */
export function effectiveContextWindow(window: number): number {
  return Math.min(window, MAX_RELIABLE_CONTEXT_WINDOW);
}

/** Ollama's built-in default `num_ctx` when nothing overrides it (v0.6+). */
const OLLAMA_DEFAULT_NUM_CTX = 4096;

/** Conservative window for an unknown CLOUD model — under-estimate is safe. */
const UNKNOWN_CLOUD_WINDOW = 8000;

/** Providers whose backend runs on the operator's own machine. */
const LOCAL_PROVIDERS = new Set(["ollama", "sglang", "vllm"]);

interface ContextWindowQuery {
  provider: string;
  model?: string;
  baseUrl?: string;
}

/**
 * Known REAL context windows by model-id family, most-specific first. Matched
 * against the lowercased model id, so it also catches OpenRouter-prefixed ids
 * (`anthropic/claude-3.5-sonnet`, `openai/gpt-4o`, `google/gemini-2.0-flash`).
 * Values are deliberately conservative — when a family spans several windows we
 * pick the smaller, because under-estimating only makes compaction fire sooner.
 */
const STATIC_CONTEXT_WINDOWS: ReadonlyArray<{ pattern: RegExp; window: number }> = [
  // OpenAI — order matters: -32k before the bare gpt-4 catch-all.
  { pattern: /gpt-4-32k/, window: 32768 },
  { pattern: /gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-4-1106|gpt-4-0125|gpt-4-vision/, window: 128000 },
  { pattern: /\bo1\b|\bo3\b|\bo4\b|o1-|o3-|o4-/, window: 200000 },
  { pattern: /gpt-4/, window: 8192 },
  { pattern: /gpt-3\.5/, window: 16385 },
  // Anthropic — every Claude 3.x / 3.5 / 3.7 / 4 ships ≥ 200k.
  { pattern: /claude|sonnet|opus|haiku/, window: 200000 },
  // Google — 1.5/2.x/3.x are 1M+; older gemini-pro is 32k.
  { pattern: /gemini-1\.5|gemini-2|gemini-3|gemini-exp/, window: 1000000 },
  { pattern: /gemini/, window: 32768 },
  // Meta Llama — 3.1+ is 128k; original llama-3 / llama3 is 8k.
  { pattern: /llama-3\.[1-9]|llama3\.[1-9]|llama-4|llama4/, window: 128000 },
  { pattern: /llama-3|llama3|llama-2|llama2/, window: 8192 },
  // Other common families.
  { pattern: /qwen/, window: 32768 },
  { pattern: /deepseek/, window: 64000 },
  { pattern: /mixtral|mistral/, window: 32768 },
  { pattern: /command-r|command-a/, window: 128000 },
];

/**
 * Static window lookup by model id. Returns null for an unknown family so the
 * caller can pick a provider-appropriate default.
 */
export function lookupStaticContextWindow(modelId: string): number | null {
  const id = modelId.toLowerCase();
  for (const { pattern, window } of STATIC_CONTEXT_WINDOWS) {
    if (pattern.test(id)) return window;
  }
  return null;
}

/**
 * Token count at which compaction should fire for a given window. Clamps to the
 * model's RELIABLE working length first (PM #82) — a 1M advertised window would
 * otherwise put the threshold at 786k, far past where the model degrades.
 */
export function compactionThresholdFor(window: number): number {
  return Math.floor(effectiveContextWindow(window) * COMPACTION_THRESHOLD_RATIO);
}

/**
 * Ollama `/api/show` returns `parameters` as a newline-delimited KV blob, e.g.
 * `num_ctx                        48000`. Extract `num_ctx` if the operator
 * pinned one in the Modelfile.
 */
export function parseNumCtxFromParameters(parameters?: string): number | null {
  if (!parameters) return null;
  const m = parameters.match(/^\s*num_ctx\s+(\d+)/m);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Probe a live Ollama for the model's REAL runtime context window, in priority
 * order. Returns null if every source is unavailable (caller applies the
 * Ollama default). Only Ollama exposes these endpoints; sglang/vllm return null.
 */
async function probeOllamaContextWindow(
  query: ContextWindowQuery,
  abortSignal?: AbortSignal
): Promise<number | null> {
  if (query.provider !== "ollama") return null;
  const modelId = query.model ?? "";
  if (!modelId) return null;
  const base = (query.baseUrl || "http://localhost:11434").replace(/\/v1\/?$/, "");

  // 1) /api/ps — the loaded model's actual allocation. Ground truth, and it
  //    reflects OLLAMA_CONTEXT_LENGTH / per-launch overrides regardless of how
  //    they were set. Only present once the model is loaded.
  try {
    const res = await fetch(`${base}/api/ps`, {
      signal: combineWithTimeout(abortSignal, 2500),
    });
    if (res.ok) {
      const data = (await res.json()) as {
        models?: Array<{ name?: string; model?: string; context_length?: number }>;
      };
      const match = (data.models ?? []).find(
        (m) => m.name === modelId || m.model === modelId
      );
      if (match?.context_length && match.context_length > 0) {
        return match.context_length;
      }
    }
  } catch {
    // not loaded / unreachable — try /api/show
  }

  // 2) /api/show — Modelfile `parameters.num_ctx`, if the operator pinned one.
  //    Catches the not-yet-loaded case for models with an explicit num_ctx.
  try {
    const res = await fetch(`${base}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelId }),
      signal: combineWithTimeout(abortSignal, 2500),
    });
    if (res.ok) {
      const data = (await res.json()) as { parameters?: string };
      const numCtx = parseNumCtxFromParameters(data.parameters);
      if (numCtx != null) return numCtx;
    }
  } catch {
    // unreachable — fall through to env / default
  }

  // 3) OLLAMA_CONTEXT_LENGTH — server-wide default override. Single-var read is
  //    allowed by the no-raw-process-env gate (no whole-object env spread).
  const envCtx = Number(process.env.OLLAMA_CONTEXT_LENGTH);
  if (Number.isFinite(envCtx) && envCtx > 0) return envCtx;

  return null;
}

/**
 * Resolve the real context window (in tokens) for a model config. Cloud
 * providers resolve synchronously from the static map; local providers probe
 * the live backend first and fall back to the static map / a conservative
 * local default. Never throws — a failed probe degrades to a safe default.
 */
export async function resolveContextWindow(
  query: ContextWindowQuery,
  opts?: { abortSignal?: AbortSignal }
): Promise<number> {
  const isLocal = LOCAL_PROVIDERS.has(query.provider);

  if (isLocal) {
    const probed = await probeOllamaContextWindow(query, opts?.abortSignal);
    if (probed != null) return probed;
  }

  // OpenRouter exposes each model's EXACT `context_length` in its live `/models`
  // catalog (cached in openrouter-pricing.ts). Prefer it over the static family
  // map — the map is a coarse per-family guess, while this is the authoritative
  // per-model window. Empty until the first fetch/disk-warm lands, in which case
  // we fall through to the family map (which also matches OpenRouter-prefixed ids).
  if (query.provider === "openrouter" && query.model) {
    const exact = getOpenRouterContextWindow(query.model);
    if (exact != null && exact > 0) return exact;
  }

  const fromMap = lookupStaticContextWindow(query.model ?? "");
  if (fromMap != null) return fromMap;

  // Unknown family: local backends default to Ollama's built-in num_ctx (a real
  // ceiling we'd silently truncate against); cloud falls to a safe under-estimate.
  return isLocal ? OLLAMA_DEFAULT_NUM_CTX : UNKNOWN_CLOUD_WINDOW;
}
