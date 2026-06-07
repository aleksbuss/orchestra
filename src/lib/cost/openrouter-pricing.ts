/**
 * PM #49 — Live OpenRouter pricing fetch + on-disk cache.
 *
 * Why this exists. The hardcoded `PRICING_TABLE` in [`pricing.ts`](./pricing.ts)
 * is fine for the ~3 vendors Orchestra prices directly (OpenAI / Anthropic /
 * Google), but the moment the operator picks a model via OpenRouter — and
 * Orchestra's MoA + tier routing actively encourages OpenRouter — the
 * hardcoded table degrades fast:
 *   - 200+ models, dozens added per quarter. Hand-maintaining is hopeless.
 *   - Free-tier suffixes (`:free`) get caught by the table, but
 *     `:nitro`, `:beta`, and other variants don't.
 *   - Pricing changes upstream are silent (OpenAI cut o1-mini 50% in 2025;
 *     hardcoded table still shows old rate for a month before someone
 *     notices the cost banner is over-reporting).
 *
 * Architecture.
 *   - `fetchOpenRouterPricing()` hits the **public** endpoint
 *     `https://openrouter.ai/api/v1/models` (no auth required for the
 *     model catalog with pricing). Returns a Map keyed by the OpenRouter
 *     model id (e.g. `"anthropic/claude-haiku-4-5"`).
 *   - `loadCachedOpenRouterPricing()` / `saveCachedOpenRouterPricing()`
 *     persist the Map to `data/cache/openrouter-pricing.json` so a fresh
 *     boot has pricing before the first fetch completes.
 *   - `refreshOpenRouterPricingCache()` is the orchestration entry point:
 *     loads disk cache → fires network refresh → on success, updates the
 *     in-memory map AND writes back to disk. Called fire-and-forget at
 *     boot from `instrumentation-node.ts`.
 *   - `getCachedOpenRouterPricing(modelId)` is the **synchronous** lookup
 *     called by `getModelPricing` in pricing.ts (which itself must stay
 *     sync to preserve the existing accumulator contract).
 *
 * Cache TTL: 24h. The hardcoded fallback in pricing.ts means stale-cache-
 * is-OK is the normal case; we don't need aggressive refresh. The disk
 * cache file persists across restarts so a single boot's failed network
 * fetch doesn't lose the last-known-good pricing.
 *
 * Security. The endpoint URL is fixed and public — no user input. We
 * still use `AbortSignal.timeout` per CLAUDE.md "User-supplied URLs"
 * convention even though this is a constant URL. SSRF guard not needed
 * (URL is a literal string, not derived from settings).
 */

import { promises as fs } from "fs";
import path from "path";
import { safeWriteFile } from "@/lib/storage/fs-utils";
import type { ModelPricing } from "./pricing";
import { getDataDir } from "@/lib/storage/data-dir";

/**
 * OpenRouter `/api/v1/models` response shape (subset we use).
 * Pricing strings are USD per token — multiply by 1,000,000 for the
 * per-million convention used elsewhere in Orchestra.
 */
interface OpenRouterModelEntry {
  id: string;
  pricing?: {
    prompt?: string;
    completion?: string;
  };
}

interface OpenRouterListing {
  data?: OpenRouterModelEntry[];
}

interface CacheFileShape {
  fetchedAt: string; // ISO8601
  entries: Array<{ id: string; inputUsdPerMillion: number; outputUsdPerMillion: number }>;
}

const OPENROUTER_PRICING_URL = "https://openrouter.ai/api/v1/models";
const FETCH_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const CACHE_FILENAME = "openrouter-pricing.json";

let inMemoryPricing: Map<string, ModelPricing> = new Map();
let inMemoryFetchedAt: number | null = null;

function dataDir(): string {
  // Mirrors the convention used by chat-store / project-store — `data/`
  // at the repo root, overridable via env for tests.
  return getDataDir();
}

function cacheFilePath(): string {
  return path.join(dataDir(), "cache", CACHE_FILENAME);
}

function parsePrice(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Fetch the live catalog and return a normalized Map. Throws on any
 * network/parse error so the caller can decide whether to keep using
 * the cached map.
 */
export async function fetchOpenRouterPricing(options: {
  signal?: AbortSignal;
} = {}): Promise<Map<string, ModelPricing>> {
  // AbortSignal.any requires Node 20.3+ — graceful fallback to the
  // timeout-only signal on older runtimes (matches the pattern in
  // moa.ts proposer dispatch).
  let signal: AbortSignal;
  if (typeof AbortSignal.any === "function" && options.signal) {
    signal = AbortSignal.any([options.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]);
  } else {
    signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  }

  const res = await fetch(OPENROUTER_PRICING_URL, { signal });
  if (!res.ok) {
    throw new Error(
      `OpenRouter pricing fetch failed: ${res.status} ${res.statusText}`
    );
  }

  const json = (await res.json()) as OpenRouterListing;
  const entries = Array.isArray(json?.data) ? json.data : [];
  const map = new Map<string, ModelPricing>();
  for (const entry of entries) {
    if (!entry?.id) continue;
    const promptPerToken = parsePrice(entry.pricing?.prompt);
    const completionPerToken = parsePrice(entry.pricing?.completion);
    if (promptPerToken === null || completionPerToken === null) continue;
    map.set(entry.id.toLowerCase(), {
      inputUsdPerMillion: promptPerToken * 1_000_000,
      outputUsdPerMillion: completionPerToken * 1_000_000,
    });
  }
  return map;
}

/**
 * Read the disk cache. Returns null if missing, corrupt, or older than
 * the TTL. Callers should treat null as "no cache — must refresh".
 *
 * Note: we DON'T enforce TTL here — we return the cache regardless of
 * age and let `refreshOpenRouterPricingCache()` decide whether to
 * trigger a fetch. A 26-hour-old cache is still better than no pricing
 * at all if the network fetch fails.
 */
export async function loadCachedOpenRouterPricing(): Promise<{
  pricing: Map<string, ModelPricing>;
  fetchedAt: number;
} | null> {
  const cachePath = cacheFilePath();
  let raw: string;
  try {
    raw = await fs.readFile(cachePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: CacheFileShape;
  try {
    parsed = JSON.parse(raw) as CacheFileShape;
  } catch {
    // Corrupt cache — treat as missing. Next refresh overwrites cleanly.
    return null;
  }
  if (!parsed?.entries || !Array.isArray(parsed.entries)) return null;
  const fetchedAt = Date.parse(parsed.fetchedAt);
  if (!Number.isFinite(fetchedAt)) return null;
  const map = new Map<string, ModelPricing>();
  for (const e of parsed.entries) {
    if (typeof e?.id !== "string") continue;
    if (
      typeof e.inputUsdPerMillion !== "number" ||
      typeof e.outputUsdPerMillion !== "number"
    ) {
      continue;
    }
    map.set(e.id.toLowerCase(), {
      inputUsdPerMillion: e.inputUsdPerMillion,
      outputUsdPerMillion: e.outputUsdPerMillion,
    });
  }
  return { pricing: map, fetchedAt };
}

/**
 * Atomically persist the Map. Uses `safeWriteFile` (PM #11/#12 storage
 * convention) so a crash mid-write doesn't corrupt the cache.
 */
export async function saveCachedOpenRouterPricing(
  pricing: Map<string, ModelPricing>,
  fetchedAt: Date = new Date()
): Promise<void> {
  const cachePath = cacheFilePath();
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  const payload: CacheFileShape = {
    fetchedAt: fetchedAt.toISOString(),
    entries: Array.from(pricing.entries()).map(([id, p]) => ({
      id,
      inputUsdPerMillion: p.inputUsdPerMillion,
      outputUsdPerMillion: p.outputUsdPerMillion,
    })),
  };
  await safeWriteFile(cachePath, JSON.stringify(payload, null, 2));
}

/**
 * Boot-time orchestration:
 *   1. Load disk cache → populate in-memory map (fast path for
 *      `getCachedOpenRouterPricing`).
 *   2. If cache is missing OR older than TTL, fire network refresh.
 *      On success, update in-memory AND write back to disk.
 *
 * Fire-and-forget from instrumentation-node.ts. Failures are logged
 * but never throw — pricing is best-effort, the cost banner already
 * handles unknown pricing via PM #36's `fullyPriced: false`.
 */
export async function refreshOpenRouterPricingCache(options: {
  signal?: AbortSignal;
  forceFetch?: boolean;
} = {}): Promise<{
  source: "fetched" | "disk" | "memory" | "unavailable";
  entryCount: number;
}> {
  const { signal, forceFetch = false } = options;

  // Step 1: warm in-memory from disk if we don't have it yet.
  if (inMemoryPricing.size === 0) {
    const cached = await loadCachedOpenRouterPricing().catch(() => null);
    if (cached) {
      inMemoryPricing = cached.pricing;
      inMemoryFetchedAt = cached.fetchedAt;
    }
  }

  // Step 2: decide whether to network-refresh.
  const ageMs = inMemoryFetchedAt
    ? Date.now() - inMemoryFetchedAt
    : Number.POSITIVE_INFINITY;
  const stale = ageMs > CACHE_TTL_MS;
  if (!forceFetch && !stale && inMemoryPricing.size > 0) {
    return { source: "memory", entryCount: inMemoryPricing.size };
  }

  // Step 3: network refresh. On failure, fall back to whatever's in
  // memory (which may itself have come from disk, possibly stale).
  try {
    const fresh = await fetchOpenRouterPricing({ signal });
    if (fresh.size === 0) {
      // Empty response is suspicious — keep the existing map.
      if (inMemoryPricing.size > 0) {
        return { source: "disk", entryCount: inMemoryPricing.size };
      }
      return { source: "unavailable", entryCount: 0 };
    }
    inMemoryPricing = fresh;
    inMemoryFetchedAt = Date.now();
    // Best-effort persist. A failure here doesn't void the run.
    await saveCachedOpenRouterPricing(fresh).catch((err) => {
      console.warn(
        "[OpenRouterPricing] cache persist failed (non-fatal):",
        err instanceof Error ? err.message : err
      );
    });
    return { source: "fetched", entryCount: fresh.size };
  } catch (err) {
    if (inMemoryPricing.size > 0) {
      console.warn(
        "[OpenRouterPricing] network refresh failed; using cached map:",
        err instanceof Error ? err.message : err
      );
      return { source: "disk", entryCount: inMemoryPricing.size };
    }
    console.warn(
      "[OpenRouterPricing] network refresh failed and no cache available:",
      err instanceof Error ? err.message : err
    );
    return { source: "unavailable", entryCount: 0 };
  }
}

/**
 * Synchronous lookup used by `getModelPricing` in pricing.ts.
 *
 * Accepts a normalized OpenRouter model id (the `<upstream>/<model>`
 * form, lowercased). Returns null if no live pricing is in memory —
 * the hardcoded fallback in pricing.ts handles it from there.
 */
export function getCachedOpenRouterPricing(
  openRouterModelId: string
): ModelPricing | null {
  if (!openRouterModelId) return null;
  const hit = inMemoryPricing.get(openRouterModelId.toLowerCase());
  return hit ?? null;
}

/**
 * Test-only seam — lets unit tests reset state between cases without
 * exporting the mutable map. Production code never calls this.
 */
export function __resetOpenRouterPricingForTests(): void {
  inMemoryPricing = new Map();
  inMemoryFetchedAt = null;
}

/**
 * Test-only seam — lets unit tests seed the in-memory map directly.
 * Production code uses `refreshOpenRouterPricingCache`.
 */
export function __seedOpenRouterPricingForTests(
  entries: Array<[string, ModelPricing]>,
  fetchedAt: number = Date.now()
): void {
  inMemoryPricing = new Map(entries.map(([k, v]) => [k.toLowerCase(), v]));
  inMemoryFetchedAt = fetchedAt;
}
