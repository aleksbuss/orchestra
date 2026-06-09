/**
 * PM #49 — OpenRouter live pricing fetcher contract.
 *
 * Scope (the surfaces other code depends on):
 *   1. `fetchOpenRouterPricing` parses the live endpoint into a Map<id,
 *      ModelPricing>. Strings → numbers, per-token → per-million,
 *      missing pricing skipped.
 *   2. `loadCachedOpenRouterPricing` reads disk; corrupt/missing →
 *      null (no throws — graceful degradation).
 *   3. `saveCachedOpenRouterPricing` round-trips through load without
 *      data loss.
 *   4. `refreshOpenRouterPricingCache` orchestrates the three above:
 *      disk-warm → network-refresh → write-back. Source field reports
 *      which path was taken.
 *   5. `getCachedOpenRouterPricing` returns null on miss, the resolved
 *      ModelPricing on hit (sync lookup — this is what `getModelPricing`
 *      in pricing.ts depends on staying sync).
 *
 * The disk-cache tests use a per-test temp directory via the
 * `ORCHESTRA_DATA_DIR` env hook the module already respects.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import {
  fetchOpenRouterPricing,
  loadCachedOpenRouterPricing,
  saveCachedOpenRouterPricing,
  refreshOpenRouterPricingCache,
  getCachedOpenRouterPricing,
  getOpenRouterMaxOutput,
  __resetOpenRouterPricingForTests,
  __seedOpenRouterPricingForTests,
  __setOpenRouterMaxOutputForTest,
} from "./openrouter-pricing";

const originalFetch = globalThis.fetch;
let tempDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  __resetOpenRouterPricingForTests();
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "or-pricing-test-"));
  originalDataDir = process.env.ORCHESTRA_DATA_DIR;
  process.env.ORCHESTRA_DATA_DIR = tempDir;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (originalDataDir === undefined) {
    delete process.env.ORCHESTRA_DATA_DIR;
  } else {
    process.env.ORCHESTRA_DATA_DIR = originalDataDir;
  }
  await fs.rm(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function mockFetchOk(payload: unknown) {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  ) as unknown as typeof fetch;
}

function mockFetchStatus(status: number, body = "") {
  globalThis.fetch = vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch;
}

function mockFetchThrows(err: Error) {
  globalThis.fetch = vi.fn(async () => {
    throw err;
  }) as unknown as typeof fetch;
}

describe("PM #49 — fetchOpenRouterPricing", () => {
  it("parses per-token strings into per-million numbers", async () => {
    mockFetchOk({
      data: [
        {
          id: "anthropic/claude-haiku-4-5",
          pricing: { prompt: "0.0000008", completion: "0.000004" },
        },
        {
          id: "openai/gpt-4o",
          pricing: { prompt: "0.0000025", completion: "0.00001" },
        },
      ],
    });
    const map = await fetchOpenRouterPricing();
    const haiku = map.get("anthropic/claude-haiku-4-5");
    expect(haiku?.inputUsdPerMillion).toBeCloseTo(0.8, 5);
    expect(haiku?.outputUsdPerMillion).toBeCloseTo(4, 5);
    const gpt4o = map.get("openai/gpt-4o");
    expect(gpt4o?.inputUsdPerMillion).toBeCloseTo(2.5, 5);
    expect(gpt4o?.outputUsdPerMillion).toBeCloseTo(10, 5);
  });

  it("skips entries without pricing strings", async () => {
    mockFetchOk({
      data: [
        { id: "provider/no-prices" }, // no pricing at all
        { id: "provider/partial", pricing: { prompt: "0.001" } }, // missing completion
        { id: "provider/bad-numbers", pricing: { prompt: "abc", completion: "def" } },
        {
          id: "provider/valid",
          pricing: { prompt: "0.000001", completion: "0.000002" },
        },
      ],
    });
    const map = await fetchOpenRouterPricing();
    expect(map.has("provider/no-prices")).toBe(false);
    expect(map.has("provider/partial")).toBe(false);
    expect(map.has("provider/bad-numbers")).toBe(false);
    expect(map.has("provider/valid")).toBe(true);
  });

  it("ids are lowercased on store (case-insensitive lookup)", async () => {
    mockFetchOk({
      data: [
        {
          id: "Anthropic/Claude-Haiku-4-5",
          pricing: { prompt: "0.0000008", completion: "0.000004" },
        },
      ],
    });
    const map = await fetchOpenRouterPricing();
    expect(map.has("anthropic/claude-haiku-4-5")).toBe(true);
  });

  it("throws on non-200 status (caller handles fallback)", async () => {
    mockFetchStatus(503, "Service Unavailable");
    await expect(fetchOpenRouterPricing()).rejects.toThrow(/503/);
  });

  it("throws on network error (caller handles fallback)", async () => {
    mockFetchThrows(new Error("ECONNREFUSED"));
    await expect(fetchOpenRouterPricing()).rejects.toThrow(/ECONNREFUSED/);
  });

  it("empty data array → empty Map (not error)", async () => {
    mockFetchOk({ data: [] });
    const map = await fetchOpenRouterPricing();
    expect(map.size).toBe(0);
  });

  it("malformed response (data missing) → empty Map", async () => {
    mockFetchOk({ unexpected: "shape" });
    const map = await fetchOpenRouterPricing();
    expect(map.size).toBe(0);
  });
});

describe("PM #49 — disk cache round-trip", () => {
  it("loadCachedOpenRouterPricing returns null when cache file missing", async () => {
    const cached = await loadCachedOpenRouterPricing();
    expect(cached).toBeNull();
  });

  it("save then load round-trips entries exactly", async () => {
    const original = new Map([
      [
        "anthropic/claude-haiku-4-5",
        { inputUsdPerMillion: 0.8, outputUsdPerMillion: 4 },
      ],
      [
        "openai/gpt-4o",
        { inputUsdPerMillion: 2.5, outputUsdPerMillion: 10 },
      ],
    ]);
    await saveCachedOpenRouterPricing(original, new Date("2026-01-01T00:00:00Z"));
    const loaded = await loadCachedOpenRouterPricing();
    expect(loaded).not.toBeNull();
    expect(loaded?.pricing.size).toBe(2);
    expect(loaded?.pricing.get("openai/gpt-4o")?.inputUsdPerMillion).toBe(2.5);
    expect(loaded?.fetchedAt).toBe(Date.parse("2026-01-01T00:00:00Z"));
  });

  it("persists & restores per-model max output — the dynamic source survives a warm-cache boot", async () => {
    // Seed the in-memory max-output map (incl. a FREE model with no pricing).
    __setOpenRouterMaxOutputForTest(
      new Map([
        ["deepseek/deepseek-chat", 16_000],
        ["meta/free-model", 4_096],
      ])
    );
    await saveCachedOpenRouterPricing(
      new Map([["deepseek/deepseek-chat", { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }]]),
      new Date("2026-01-01T00:00:00Z")
    );
    // Wipe in-memory, then reload from disk (the warm-cache path).
    __setOpenRouterMaxOutputForTest(new Map());
    expect(getOpenRouterMaxOutput("deepseek/deepseek-chat")).toBeUndefined();
    await loadCachedOpenRouterPricing();
    expect(getOpenRouterMaxOutput("deepseek/deepseek-chat")).toBe(16_000);
    // The free model (absent from `pricing`) was persisted too.
    expect(getOpenRouterMaxOutput("meta/free-model")).toBe(4_096);
  });

  it("loadCachedOpenRouterPricing returns null on corrupt JSON (no throw)", async () => {
    const cachePath = path.join(tempDir, "cache", "openrouter-pricing.json");
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, "{{ not json ]]");
    const cached = await loadCachedOpenRouterPricing();
    expect(cached).toBeNull();
  });

  it("loadCachedOpenRouterPricing skips malformed entries within otherwise valid file", async () => {
    const cachePath = path.join(tempDir, "cache", "openrouter-pricing.json");
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(
      cachePath,
      JSON.stringify({
        fetchedAt: new Date().toISOString(),
        entries: [
          { id: "valid/one", inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
          { id: "bad/no-numbers" }, // missing both
          { id: 42, inputUsdPerMillion: 1, outputUsdPerMillion: 2 }, // bad id type
          { id: "valid/two", inputUsdPerMillion: 3, outputUsdPerMillion: 6 },
        ],
      })
    );
    const cached = await loadCachedOpenRouterPricing();
    expect(cached?.pricing.size).toBe(2);
    expect(cached?.pricing.has("valid/one")).toBe(true);
    expect(cached?.pricing.has("valid/two")).toBe(true);
  });
});

describe("PM #49 — refreshOpenRouterPricingCache orchestration", () => {
  it("no cache + successful fetch → source: fetched, writes to disk", async () => {
    mockFetchOk({
      data: [
        {
          id: "anthropic/claude-haiku-4-5",
          pricing: { prompt: "0.0000008", completion: "0.000004" },
        },
      ],
    });
    const result = await refreshOpenRouterPricingCache();
    expect(result.source).toBe("fetched");
    expect(result.entryCount).toBe(1);
    // Disk has the cache now.
    const loaded = await loadCachedOpenRouterPricing();
    expect(loaded?.pricing.size).toBe(1);
  });

  it("fresh in-memory cache → source: memory, no network call", async () => {
    __seedOpenRouterPricingForTests([
      ["x/y", { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }],
    ]);
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const result = await refreshOpenRouterPricingCache();
    expect(result.source).toBe("memory");
    expect(result.entryCount).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("stale in-memory cache + successful fetch → source: fetched (refresh)", async () => {
    const dayInMs = 24 * 60 * 60 * 1000;
    __seedOpenRouterPricingForTests(
      [["x/y", { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }]],
      Date.now() - 2 * dayInMs // 2 days old → stale
    );
    mockFetchOk({
      data: [
        { id: "x/y", pricing: { prompt: "0.000005", completion: "0.00001" } },
      ],
    });
    const result = await refreshOpenRouterPricingCache();
    expect(result.source).toBe("fetched");
    expect(getCachedOpenRouterPricing("x/y")?.inputUsdPerMillion).toBeCloseTo(
      5,
      5
    );
  });

  it("forceFetch: true bypasses freshness check", async () => {
    __seedOpenRouterPricingForTests([
      ["x/y", { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }],
    ]);
    mockFetchOk({
      data: [
        { id: "x/y", pricing: { prompt: "0.000007", completion: "0.000014" } },
      ],
    });
    const result = await refreshOpenRouterPricingCache({ forceFetch: true });
    expect(result.source).toBe("fetched");
    expect(getCachedOpenRouterPricing("x/y")?.inputUsdPerMillion).toBeCloseTo(
      7,
      5
    );
  });

  it("no cache + network failure → source: unavailable, no throw", async () => {
    mockFetchThrows(new Error("ECONNREFUSED"));
    const result = await refreshOpenRouterPricingCache();
    expect(result.source).toBe("unavailable");
    expect(result.entryCount).toBe(0);
  });

  it("disk cache present + network failure → source: disk (graceful fallback)", async () => {
    // Pre-populate disk cache from a previous-run snapshot.
    await saveCachedOpenRouterPricing(
      new Map([["x/y", { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }]]),
      new Date(Date.now() - 48 * 60 * 60 * 1000) // 2 days old
    );
    mockFetchThrows(new Error("upstream timeout"));
    const result = await refreshOpenRouterPricingCache();
    expect(result.source).toBe("disk");
    expect(result.entryCount).toBe(1);
    // The stale cache is still queryable.
    expect(getCachedOpenRouterPricing("x/y")?.inputUsdPerMillion).toBe(1);
  });

  it("empty network response keeps the in-memory map intact", async () => {
    __seedOpenRouterPricingForTests(
      [["x/y", { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }]],
      Date.now() - 48 * 60 * 60 * 1000
    );
    mockFetchOk({ data: [] });
    const result = await refreshOpenRouterPricingCache();
    expect(result.source).toBe("disk");
    expect(getCachedOpenRouterPricing("x/y")?.inputUsdPerMillion).toBe(1);
  });

  // PM #56 — simulates Next.js dev-mode HMR. Every save resets module
  // state (the in-memory map). Without the disk-cache fallback the
  // boot path would dump traffic on OpenRouter on every save. With the
  // disk cache, we promote from disk (no network call) when fresh.
  it("HMR-style reload: in-memory reset but disk cache fresh → NO network call", async () => {
    // First "boot": fetch and persist.
    mockFetchOk({
      data: [
        {
          id: "anthropic/claude-haiku-4-5",
          pricing: { prompt: "0.0000008", completion: "0.000004" },
        },
      ],
    });
    const first = await refreshOpenRouterPricingCache();
    expect(first.source).toBe("fetched");

    // Simulate HMR / module reload: reset in-memory state only.
    // Disk cache is intentionally untouched (same files on disk).
    __resetOpenRouterPricingForTests();

    // Replace fetch with a spy that records calls but never resolves
    // the way the code wants — if it's invoked we'll know.
    const fetchSpy = vi.fn(async () => {
      throw new Error("network was reached on reload — should not happen");
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const second = await refreshOpenRouterPricingCache();
    // Disk warmed memory; fresh → "memory" reported.
    expect(second.source).toBe("memory");
    expect(second.entryCount).toBe(1);
    // Critical: no network call was made.
    expect(fetchSpy).not.toHaveBeenCalled();
    // Lookup still works.
    expect(
      getCachedOpenRouterPricing("anthropic/claude-haiku-4-5")?.inputUsdPerMillion
    ).toBeCloseTo(0.8, 5);
  });

  it("HMR-style reload + stale disk cache → ONE network call, not many", async () => {
    // Pre-seed a stale disk cache (>24h old).
    await saveCachedOpenRouterPricing(
      new Map([["x/y", { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }]]),
      new Date(Date.now() - 48 * 60 * 60 * 1000)
    );
    __resetOpenRouterPricingForTests();

    mockFetchOk({
      data: [
        {
          id: "x/y",
          pricing: { prompt: "0.000005", completion: "0.00001" },
        },
      ],
    });
    const result = await refreshOpenRouterPricingCache();
    expect(result.source).toBe("fetched");
    // One fetch — not one per reload.
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("PM #49 — getCachedOpenRouterPricing sync lookup", () => {
  it("returns null when cache is empty (preserves null-fallback in pricing.ts)", () => {
    expect(getCachedOpenRouterPricing("anything")).toBeNull();
  });

  it("lookups are case-insensitive", () => {
    __seedOpenRouterPricingForTests([
      ["anthropic/claude-haiku-4-5", { inputUsdPerMillion: 0.8, outputUsdPerMillion: 4 }],
    ]);
    expect(
      getCachedOpenRouterPricing("Anthropic/Claude-Haiku-4-5")?.inputUsdPerMillion
    ).toBe(0.8);
  });

  it("returns null for empty string (defensive)", () => {
    __seedOpenRouterPricingForTests([
      ["x/y", { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }],
    ]);
    expect(getCachedOpenRouterPricing("")).toBeNull();
  });
});
