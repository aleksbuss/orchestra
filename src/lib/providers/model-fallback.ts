/**
 * Model auto-fallback — picks a working replacement when the configured chat
 * model is unavailable.
 *
 * Triggers:
 *   - `404 model not found` / `model deprecated` (provider removed the model)
 *   - `400 No endpoints found that support tool use` (PM #17 family —
 *     model exists but doesn't accept tool calls)
 *
 * Does NOT trigger on:
 *   - `429 rate limited` — handled by retry-with-backoff
 *   - `402/403 quota/payment` — needs operator action; we surface a chat
 *     error, not a silent fallback (would mask billing problems)
 *   - Network errors — handled by retry
 *
 * Strategy per provider:
 *   - **OpenRouter**: live-query `/api/v1/models`, filter to tool-capable
 *     (per `NO_TOOL_PATTERNS`), sort by `pricing.prompt + pricing.completion`
 *     ascending, prefer free-tier (`:free` suffix). Returns the cheapest.
 *   - **OpenAI / Anthropic / Google**: static fallback chain — those APIs
 *     don't expose pricing programmatically, so "cheapest" isn't knowable
 *     at runtime. The chain is a curated list of known-cheap-but-capable
 *     models in descending preference order.
 *   - **Ollama**: query local `/api/tags`, take the first installed model
 *     (locally hosted, no cost).
 *
 * Pricing surfaces are best-effort INFORMATION ONLY — we don't track or
 * charge anything. The user sees a notification "new model may have
 * different pricing" so they can audit their provider invoice.
 */
import { modelSupportsTools, NO_TOOL_PATTERNS } from "@/lib/providers/tool-support";
import {
  assertSafeOutboundUrl,
  UnsafeOutboundUrlError,
} from "@/lib/security/url-guard";
import type { ModelFallbackDetails } from "@/lib/realtime/types";

/* ───────────────────────── error classification ───────────────────────── */

export type FailureKind =
  | "model_not_found"
  | "no_tool_support"
  | "quota_exceeded"
  | "rate_limited"
  | "network"
  | "abort"
  | "unknown_4xx"
  | "unknown_5xx"
  | "unknown";

interface ErrorShape {
  /** HTTP status if the error came from an upstream fetch. */
  statusCode?: number;
  /** Raw error message or upstream response body fragment. */
  message?: string;
  /** Original error object (for `.name` / instanceof checks). */
  original?: unknown;
}

/**
 * Map a thrown error into a coarse failure kind. Used by the agent to decide
 * whether to fall back, retry, or surface a chat error.
 *
 * Recognises the canonical shapes from Vercel AI SDK (`APICallError` with
 * `statusCode` and `responseBody`) plus the OpenRouter-specific tool-use
 * 400 (which has `statusCode: 404` historically — see PM #17 — but we look
 * at the message body too).
 */
export function classifyModelError(err: unknown): FailureKind {
  if (!err) return "unknown";

  // AbortError — user closed the tab / clicked Stop. Not a model issue.
  if (typeof err === "object" && err !== null) {
    const errObj = err as { name?: string; code?: string };
    if (errObj.name === "AbortError" || errObj.code === "ABORT_ERR") {
      return "abort";
    }
  }

  const shape = extractErrorShape(err);
  const status = shape.statusCode;
  const message = (shape.message || "").toLowerCase();

  // No-tool-support — the canonical PM #17 signature. OpenRouter returns
  // this as 404 with a specific message; some providers return 400.
  if (
    message.includes("no endpoints found that support tool") ||
    message.includes("does not support tool") ||
    message.includes("tool_use not supported")
  ) {
    return "no_tool_support";
  }

  // 404 / "model not found" / "model has been deprecated".
  if (
    status === 404 ||
    message.includes("model_not_found") ||
    message.includes("model not found") ||
    message.includes("the model") && message.includes("does not exist") ||
    message.includes("deprecated") && message.includes("model")
  ) {
    return "model_not_found";
  }

  if (status === 402 || status === 403 || message.includes("quota") || message.includes("insufficient_quota")) {
    return "quota_exceeded";
  }

  if (status === 429 || message.includes("rate limit")) {
    return "rate_limited";
  }

  if (
    message.includes("econnrefused") ||
    message.includes("enotfound") ||
    message.includes("etimedout") ||
    message.includes("network") ||
    message.includes("fetch failed")
  ) {
    return "network";
  }

  if (status && status >= 400 && status < 500) return "unknown_4xx";
  if (status && status >= 500) return "unknown_5xx";

  return "unknown";
}

function extractErrorShape(err: unknown): ErrorShape {
  if (typeof err !== "object" || err === null) {
    return { message: String(err) };
  }
  const errObj = err as Record<string, unknown>;
  const statusCode =
    typeof errObj.statusCode === "number" ? errObj.statusCode :
    typeof errObj.status === "number" ? errObj.status :
    undefined;
  const message =
    typeof errObj.message === "string" ? errObj.message :
    typeof errObj.responseBody === "string" ? errObj.responseBody :
    String(err);
  return { statusCode, message, original: err };
}

/* ──────────────────────── static fallback chains ──────────────────────── */

/**
 * Hardcoded fallback ladders for providers that don't expose pricing via API.
 * Ordered descending by capability — caller picks the first that satisfies
 * the constraint (tool-capable, not equal to the failed model, etc.).
 */
const STATIC_FALLBACK_CHAINS: Record<string, string[]> = {
  openai: [
    "gpt-4o-mini",
    "gpt-4o",
    "gpt-4-turbo",
    "gpt-3.5-turbo",
  ],
  anthropic: [
    "claude-3-5-haiku-latest",
    "claude-3-5-sonnet-latest",
    "claude-3-haiku-20240307",
  ],
  google: [
    "gemini-1.5-flash",
    "gemini-1.5-flash-8b",
    "gemini-1.5-pro",
  ],
};

/* ──────────────────────── core fallback resolver ──────────────────────── */

export interface FallbackInput {
  /** Provider id matching `MODEL_PROVIDERS` keys. */
  provider: string;
  /** The model id that just failed — must NOT be returned as the fallback. */
  failedModel: string;
  /** API key for live catalog queries (OpenRouter). Optional for static chains. */
  apiKey?: string;
  /** For Ollama: where the local daemon lives. */
  baseUrl?: string;
  /** AbortSignal — fallback queries respect cancellation. */
  signal?: AbortSignal;
}

export interface FallbackResult {
  /** The chosen replacement model id, or null if no candidate was found. */
  modelId: string | null;
  /** Provenance of the choice — feeds the `source` field of `ModelFallbackDetails`. */
  source: ModelFallbackDetails["source"];
  /** Pricing snapshot, when the provider exposes it. */
  pricing?: ModelFallbackDetails["pricing"];
}

/**
 * Pick a fallback model. Returns `{ modelId: null }` if no suitable
 * candidate can be found (e.g., OpenRouter `/models` is down AND the
 * provider has no static chain configured).
 *
 * The caller is responsible for actually re-invoking the agent with the
 * new model and for emitting the user-facing notification.
 */
export async function pickFallbackModel(
  input: FallbackInput
): Promise<FallbackResult> {
  const { provider, failedModel } = input;

  if (provider === "openrouter") {
    return await pickFromOpenRouterCatalog(input);
  }

  if (provider === "ollama") {
    return await pickFromOllamaLocal(input);
  }

  if (provider in STATIC_FALLBACK_CHAINS) {
    return pickFromStaticChain(provider, failedModel);
  }

  return { modelId: null, source: "static_chain" };
}

function pickFromStaticChain(
  provider: string,
  failedModel: string
): FallbackResult {
  const chain = STATIC_FALLBACK_CHAINS[provider] ?? [];
  for (const candidate of chain) {
    if (candidate === failedModel) continue;
    // Skip candidates that match NO_TOOL_PATTERNS — they'd just re-trigger
    // the same PM #17 failure. modelSupportsTools' strict union is wider
    // than what our chain map covers; cast to its expected shape so a new
    // provider key added here can't accidentally bypass the check by
    // failing the type alone.
    if (!modelSupportsTools(
      provider as Parameters<typeof modelSupportsTools>[0],
      candidate
    )) continue;
    return { modelId: candidate, source: "static_chain" };
  }
  return { modelId: null, source: "static_chain" };
}

/* ────────────────────── OpenRouter catalog lookup ────────────────────── */

interface OpenRouterModel {
  id: string;
  pricing?: {
    /** Per-token pricing as strings, e.g. "0.0000005" → $0.5 per 1M tokens. */
    prompt?: string;
    completion?: string;
  };
}

const OPENROUTER_FETCH_TIMEOUT_MS = 5000;

async function pickFromOpenRouterCatalog(
  input: FallbackInput
): Promise<FallbackResult> {
  const { failedModel, apiKey, signal } = input;
  if (!apiKey) {
    // No key → no catalog; nothing we can do here.
    return { modelId: null, source: "openrouter_catalog" };
  }

  let res: Response;
  try {
    res = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: combineSignals(signal, AbortSignal.timeout(OPENROUTER_FETCH_TIMEOUT_MS)),
    });
  } catch {
    return { modelId: null, source: "openrouter_catalog" };
  }
  if (!res.ok) {
    return { modelId: null, source: "openrouter_catalog" };
  }

  const data = (await res.json().catch(() => null)) as
    | { data?: OpenRouterModel[] }
    | null;
  const rawModels = Array.isArray(data?.data) ? data.data : [];

  type Scored = {
    id: string;
    score: number;
    isFree: boolean;
    promptUsdPerMillion: number;
    completionUsdPerMillion: number;
  };

  const candidates: Scored[] = [];
  for (const m of rawModels) {
    if (!m.id || m.id === failedModel) continue;
    // Skip anything matching the known no-tool-support patterns —
    // re-using them would just re-trigger PM #17.
    if (!modelSupportsTools("openrouter", m.id)) continue;

    // Parse pricing. OpenRouter returns strings; missing fields mean unknown.
    const promptPer = parsePrice(m.pricing?.prompt);
    const completionPer = parsePrice(m.pricing?.completion);
    // Per-million pricing (convenient for display + ordering).
    const promptUsdPerMillion = promptPer * 1_000_000;
    const completionUsdPerMillion = completionPer * 1_000_000;
    const isFree =
      m.id.endsWith(":free") ||
      (promptPer === 0 && completionPer === 0);

    candidates.push({
      id: m.id,
      // Cost score: sum of input + output per-token cost. Free models
      // get score 0 and naturally sort to the top.
      score: promptPer + completionPer,
      isFree,
      promptUsdPerMillion,
      completionUsdPerMillion,
    });
  }

  if (candidates.length === 0) {
    return { modelId: null, source: "openrouter_catalog" };
  }

  // Free models first, then by score ascending.
  candidates.sort((a, b) => {
    if (a.isFree !== b.isFree) return a.isFree ? -1 : 1;
    return a.score - b.score;
  });

  const winner = candidates[0];
  return {
    modelId: winner.id,
    source: "openrouter_catalog",
    pricing: {
      promptUsdPerMillion: winner.promptUsdPerMillion,
      completionUsdPerMillion: winner.completionUsdPerMillion,
      isFree: winner.isFree,
    },
  };
}

function parsePrice(raw: string | undefined): number {
  if (!raw) return Number.POSITIVE_INFINITY; // unknown → don't pick
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : Number.POSITIVE_INFINITY;
}

/* ────────────────────────── Ollama local probe ────────────────────────── */

async function pickFromOllamaLocal(
  input: FallbackInput
): Promise<FallbackResult> {
  const { failedModel, baseUrl, signal } = input;
  const rawBase = (baseUrl || "http://localhost:11434").trim()
    .replace(/\/+$/, "")
    .replace(/\/v1$/, "");

  let safeUrl: URL;
  try {
    safeUrl = assertSafeOutboundUrl(`${rawBase}/api/tags`);
  } catch (err) {
    // Non-loopback baseUrl that fails SSRF guard — refuse silently rather
    // than throwing; fallback "found nothing" lets the caller surface a
    // user-friendly error.
    if (err instanceof UnsafeOutboundUrlError) {
      return { modelId: null, source: "ollama_local" };
    }
    throw err;
  }

  let res: Response;
  try {
    res = await fetch(safeUrl, {
      signal: combineSignals(signal, AbortSignal.timeout(OPENROUTER_FETCH_TIMEOUT_MS)),
    });
  } catch {
    return { modelId: null, source: "ollama_local" };
  }
  if (!res.ok) {
    return { modelId: null, source: "ollama_local" };
  }

  const data = (await res.json().catch(() => null)) as
    | { models?: Array<{ name: string }> }
    | null;
  const names = (data?.models ?? [])
    .map((m) => m.name)
    .filter((n): n is string => typeof n === "string" && n.length > 0)
    .filter((n) => n !== failedModel)
    // Ollama tags don't follow OpenRouter naming; we still skip obvious
    // no-tool-support patterns conservatively (gemma, mistral 7b, etc.).
    .filter((n) => !NO_TOOL_PATTERNS.some((p) => n.toLowerCase().includes(p)));

  if (names.length === 0) {
    return { modelId: null, source: "ollama_local" };
  }
  return { modelId: names[0], source: "ollama_local" };
}

/* ────────────────────────── signal plumbing ────────────────────────── */

/**
 * Combine an optional caller signal with our internal timeout signal so
 * either can cancel the fallback lookup. Uses `AbortSignal.any` where
 * available (Node 20+) and falls back to manual relay otherwise.
 */
function combineSignals(
  ...signals: (AbortSignal | undefined)[]
): AbortSignal {
  const defined = signals.filter((s): s is AbortSignal => s instanceof AbortSignal);
  if (defined.length === 0) return new AbortController().signal;
  if (defined.length === 1) return defined[0];
  // Probe AbortSignal.any — Node 20.3+ ships it; the typedef in `lib.dom.d.ts`
  // lags behind. The `any` cast is the canonical workaround until TS catches up.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyStatic = (AbortSignal as any).any;
  if (typeof anyStatic === "function") {
    return anyStatic(defined) as AbortSignal;
  }
  const controller = new AbortController();
  for (const s of defined) {
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}

/* ──────────────────────── user-facing messaging ──────────────────────── */

/**
 * Build a friendly notification string for the UI banner. Designed to be
 * brief (one to two sentences) — the chat panel renders this directly.
 */
export function describeFallback(details: ModelFallbackDetails): {
  message: string;
  hint: string;
} {
  const reasonText = ({
    model_not_found: "is unavailable (the provider may have deprecated it)",
    no_tool_support: "doesn't support tool calls in this configuration",
    unknown_4xx: "returned an unexpected client error",
  } as const)[details.reason];

  const pricingNote =
    details.pricing?.isFree
      ? " The replacement is on the free tier — no extra cost."
      : details.pricing?.promptUsdPerMillion !== undefined
        ? ` Pricing for the replacement: $${details.pricing.promptUsdPerMillion.toFixed(2)}/M prompt + $${(details.pricing.completionUsdPerMillion ?? 0).toFixed(2)}/M completion tokens. Verify against your provider invoice.`
        : " Pricing may differ — verify against your provider invoice.";

  return {
    message: `Model \`${details.originalModel}\` ${reasonText}. Switched to \`${details.newModel}\`.${pricingNote}`,
    hint: "Update your default model in Settings if you'd like to change the choice.",
  };
}
