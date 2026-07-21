import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  lookupStaticContextWindow,
  compactionThresholdFor,
  parseNumCtxFromParameters,
  resolveContextWindow,
  COMPACTION_THRESHOLD_RATIO,
  effectiveContextWindow,
  hasReliableFullWindow,
  MAX_RELIABLE_CONTEXT_WINDOW,
} from "./context-window";
import {
  __setOpenRouterContextLengthForTest,
  __resetOpenRouterPricingForTests,
} from "@/lib/cost/openrouter-pricing";

describe("lookupStaticContextWindow", () => {
  it.each([
    ["gpt-4o", 128000],
    ["openai/gpt-4o-mini", 128000],
    ["gpt-4-32k", 32768], // -32k must win over the bare gpt-4 catch-all
    ["gpt-4", 8192],
    ["gpt-3.5-turbo", 16385],
    ["anthropic/claude-3.5-sonnet", 200000],
    ["claude-haiku-4-5", 200000],
    ["google/gemini-2.0-flash", 1000000],
    ["gemini-pro", 32768],
    ["meta-llama/llama-3.1-70b", 128000],
    ["llama3", 8192],
    ["qwen/qwen-2.5-72b-instruct", 32768],
    ["deepseek-chat", 64000],
    ["mistralai/mixtral-8x7b", 32768],
  ])("maps %s → %i", (id, expected) => {
    expect(lookupStaticContextWindow(id)).toBe(expected);
  });

  it("returns null for an unknown family", () => {
    expect(lookupStaticContextWindow("some-bespoke-7000B-model")).toBeNull();
  });
});

describe("effectiveContextWindow (PM #82 reliable-window cap)", () => {
  it("is a no-op for windows at or under the reliable ceiling", () => {
    expect(effectiveContextWindow(4096)).toBe(4096);
    expect(effectiveContextWindow(32768)).toBe(32768);
    expect(effectiveContextWindow(MAX_RELIABLE_CONTEXT_WINDOW)).toBe(
      MAX_RELIABLE_CONTEXT_WINDOW
    );
  });
  it("clamps an over-advertised window to the reliable ceiling", () => {
    expect(effectiveContextWindow(200000)).toBe(MAX_RELIABLE_CONTEXT_WINDOW);
    // qwen3-coder's advertised 1,048,576 — the exact bug PM #82 fixes.
    expect(effectiveContextWindow(1048576)).toBe(MAX_RELIABLE_CONTEXT_WINDOW);
  });
  it("still clamps with no hint (unchanged default behaviour)", () => {
    expect(effectiveContextWindow(200000, undefined)).toBe(MAX_RELIABLE_CONTEXT_WINDOW);
  });
});

describe("hasReliableFullWindow + effectiveContextWindow lift (PM #95 cross-model)", () => {
  it("lifts the clamp for known-reliable model-id families (native or routed)", () => {
    for (const id of [
      "anthropic/claude-sonnet-4.6",
      "claude-opus-4-8",
      "openrouter/anthropic/claude-3.5-sonnet",
      "google/gemini-2.0-flash",
      "gemini-3-pro-preview",
      "openai/gpt-4o",
      "gpt-4.1",
      "gpt-5",
      "openai/o3-mini",
    ]) {
      expect(hasReliableFullWindow({ model: id })).toBe(true);
      // A 1M advertised window is TRUSTED for these — not clamped to 120K.
      expect(effectiveContextWindow(1000000, { model: id })).toBe(1000000);
      expect(effectiveContextWindow(200000, { model: id })).toBe(200000);
    }
  });
  it("lifts the clamp for known-reliable native providers regardless of model id", () => {
    expect(hasReliableFullWindow({ provider: "anthropic", model: "whatever" })).toBe(true);
    expect(hasReliableFullWindow({ provider: "google", model: "whatever" })).toBe(true);
    expect(effectiveContextWindow(200000, { provider: "anthropic" })).toBe(200000);
  });
  it("KEEPS the clamp for unknown / degrading families (safe default)", () => {
    for (const id of [
      "qwen/qwen3-coder",
      "qwen2.5-coder",
      "deepseek/deepseek-v4-flash",
      "mistralai/mixtral-8x7b",
      "some-bespoke-model",
    ]) {
      expect(hasReliableFullWindow({ model: id })).toBe(false);
      expect(effectiveContextWindow(1048576, { model: id })).toBe(MAX_RELIABLE_CONTEXT_WINDOW);
    }
  });
  it("does NOT broad-match a provider it doesn't trust (openrouter alone is not reliable)", () => {
    // provider openrouter + a degrading model id stays clamped.
    expect(hasReliableFullWindow({ provider: "openrouter", model: "qwen/qwen3-coder" })).toBe(false);
  });
  it("compactionThresholdFor honours the lift for a reliable family", () => {
    // Gemini 1M is TRUSTED → threshold at 0.75 * 1M, not 0.75 * 120K.
    expect(compactionThresholdFor(1000000, { model: "google/gemini-2.0-flash" })).toBe(
      Math.floor(1000000 * COMPACTION_THRESHOLD_RATIO)
    );
    // deepseek stays clamped.
    expect(compactionThresholdFor(1000000, { model: "deepseek-chat" })).toBe(
      Math.floor(MAX_RELIABLE_CONTEXT_WINDOW * COMPACTION_THRESHOLD_RATIO)
    );
  });
});

describe("compactionThresholdFor", () => {
  it("applies the 0.75 ratio and floors for windows under the cap", () => {
    expect(compactionThresholdFor(4096)).toBe(
      Math.floor(4096 * COMPACTION_THRESHOLD_RATIO)
    );
    expect(compactionThresholdFor(4096)).toBe(3072);
    expect(compactionThresholdFor(32768)).toBe(24576);
  });
  it("caps the threshold at the reliable window for over-advertised models (PM #82)", () => {
    const capped = Math.floor(MAX_RELIABLE_CONTEXT_WINDOW * COMPACTION_THRESHOLD_RATIO);
    // A 1M advertised window must NOT push the threshold to 786k — the model
    // degrades long before that. 200k and 1,048,576 both collapse to the cap.
    expect(compactionThresholdFor(200000)).toBe(capped);
    expect(compactionThresholdFor(1048576)).toBe(capped);
  });
});

describe("parseNumCtxFromParameters", () => {
  it("extracts num_ctx from the whitespace-padded KV blob", () => {
    expect(parseNumCtxFromParameters("num_ctx                        48000")).toBe(48000);
  });
  it("handles a multi-line parameters blob", () => {
    const blob = `stop                           "<|im_end|>"\nnum_ctx                        8192\ntemperature                    0.7`;
    expect(parseNumCtxFromParameters(blob)).toBe(8192);
  });
  it("returns null when absent / empty / zero", () => {
    expect(parseNumCtxFromParameters(undefined)).toBeNull();
    expect(parseNumCtxFromParameters("")).toBeNull();
    expect(parseNumCtxFromParameters("temperature 0.7")).toBeNull();
    expect(parseNumCtxFromParameters("num_ctx 0")).toBeNull();
  });
});

describe("resolveContextWindow — cloud (no probe)", () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  afterEach(() => fetchSpy.mockReset());

  it("resolves a cloud model from the static map WITHOUT any fetch", async () => {
    const win = await resolveContextWindow({ provider: "openai", model: "gpt-4o" });
    expect(win).toBe(128000);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls to the safe cloud default for an unknown cloud model", async () => {
    const win = await resolveContextWindow({ provider: "openrouter", model: "weird/unknown-model" });
    expect(win).toBe(8000);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("resolveContextWindow — OpenRouter exact window from live cache", () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  afterEach(() => {
    fetchSpy.mockReset();
    __resetOpenRouterPricingForTests();
  });

  it("prefers the cached per-model context_length over the static family map", async () => {
    // Static map for the claude family = 200000; the live catalog reports this
    // specific OpenRouter listing at 250000 — the exact value must win.
    __setOpenRouterContextLengthForTest(
      new Map([["anthropic/claude-3.5-sonnet", 250000]])
    );
    const win = await resolveContextWindow({
      provider: "openrouter",
      model: "anthropic/claude-3.5-sonnet",
    });
    expect(win).toBe(250000);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls back to the static family map when the model isn't cached", async () => {
    __setOpenRouterContextLengthForTest(new Map([["some/other-model", 123000]]));
    const win = await resolveContextWindow({
      provider: "openrouter",
      model: "anthropic/claude-3.5-sonnet",
    });
    expect(win).toBe(200000); // static map, not the unrelated cache entry
  });

  it("is case-insensitive on the model id", async () => {
    __setOpenRouterContextLengthForTest(new Map([["vendor/model-x", 64000]]));
    const win = await resolveContextWindow({
      provider: "openrouter",
      model: "Vendor/Model-X",
    });
    expect(win).toBe(64000);
  });

  it("ignores the cache for a non-openrouter provider", async () => {
    // A coincidental id collision must NOT leak an OpenRouter window into a
    // direct-provider lookup.
    __setOpenRouterContextLengthForTest(new Map([["gpt-4o", 999999]]));
    const win = await resolveContextWindow({ provider: "openai", model: "gpt-4o" });
    expect(win).toBe(128000); // static map
  });
});

describe("resolveContextWindow — Ollama probe priority chain", () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");

  function jsonResponse(body: unknown, ok = true): Response {
    return { ok, json: async () => body } as unknown as Response;
  }

  beforeEach(() => {
    delete process.env.OLLAMA_CONTEXT_LENGTH;
    fetchSpy.mockReset();
  });
  afterEach(() => {
    delete process.env.OLLAMA_CONTEXT_LENGTH;
  });

  it("1) prefers /api/ps runtime context_length (the real allocation)", async () => {
    fetchSpy.mockImplementation(async (url) => {
      if (String(url).endsWith("/api/ps")) {
        return jsonResponse({ models: [{ name: "qwen2.5:latest", context_length: 4096 }] });
      }
      throw new Error("should not reach /api/show");
    });
    const win = await resolveContextWindow({ provider: "ollama", model: "qwen2.5:latest" });
    expect(win).toBe(4096); // NOT the 32768 trained ceiling
  });

  it("2) falls to /api/show Modelfile num_ctx when the model is not loaded", async () => {
    fetchSpy.mockImplementation(async (url) => {
      if (String(url).endsWith("/api/ps")) return jsonResponse({ models: [] });
      if (String(url).endsWith("/api/show")) {
        return jsonResponse({ parameters: "num_ctx                        48000" });
      }
      throw new Error("unexpected url");
    });
    const win = await resolveContextWindow({ provider: "ollama", model: "qwen2.5-large:latest" });
    expect(win).toBe(48000);
  });

  it("3) falls to OLLAMA_CONTEXT_LENGTH env when ps + show carry nothing", async () => {
    process.env.OLLAMA_CONTEXT_LENGTH = "8192";
    fetchSpy.mockImplementation(async (url) => {
      if (String(url).endsWith("/api/ps")) return jsonResponse({ models: [] });
      if (String(url).endsWith("/api/show")) return jsonResponse({ parameters: "temperature 0.7" });
      throw new Error("unexpected url");
    });
    const win = await resolveContextWindow({ provider: "ollama", model: "phi3:latest" });
    expect(win).toBe(8192);
  });

  it("4) falls to the Ollama default (4096) when the server is unreachable", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));
    const win = await resolveContextWindow({ provider: "ollama", model: "phi3:latest" });
    expect(win).toBe(4096); // the conservative local default, NOT the cloud 8000
  });

  it("uses the static map as the unreachable fallback for a KNOWN local family", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));
    // llama3.1 is in the static map (128000) → preferred over the bare 4096
    // local default once the live probe fails.
    const win = await resolveContextWindow({ provider: "ollama", model: "llama3.1:8b" });
    expect(win).toBe(128000);
  });
});
