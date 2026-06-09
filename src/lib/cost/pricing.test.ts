/**
 * PM #36 — pricing table contract.
 *
 * What we pin:
 *   - Major-family substring matching works (gpt-4o-mini before gpt-4o
 *     because we want the cheap-tier price for the mini variant).
 *   - OpenRouter passthrough decomposes `openrouter/<upstream>/<model>`
 *     into the upstream's pricing entry. `:free` suffix → zero cost.
 *   - Local providers (ollama, codex-cli, gemini-cli) always priced at zero.
 *   - Unknown (provider, model) returns null — banner labels as "—",
 *     never fabricates a price.
 *   - estimateCost: unknown pricing → knownPricing: false, zero usd.
 *   - Numeric correctness on a known pair (gpt-4o: 2.5/M input + 10/M output).
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  estimateCost,
  estimateCostFor,
  getModelPricing,
} from "./pricing";
import * as liveCache from "./openrouter-pricing";

describe("getModelPricing — substring family matching", () => {
  it("gpt-4o-mini beats gpt-4o (order matters in the table)", () => {
    const mini = getModelPricing("openai", "gpt-4o-mini-2024-07-18");
    const flagship = getModelPricing("openai", "gpt-4o-2024-08-06");
    expect(mini?.inputUsdPerMillion).toBe(0.15);
    expect(flagship?.inputUsdPerMillion).toBe(2.5);
  });

  it("claude-sonnet-4-6 → flagship sonnet pricing", () => {
    const p = getModelPricing("anthropic", "claude-sonnet-4-6");
    expect(p?.inputUsdPerMillion).toBe(3);
    expect(p?.outputUsdPerMillion).toBe(15);
  });

  it("claude-haiku-4-5 → haiku-tier pricing", () => {
    const p = getModelPricing("anthropic", "claude-haiku-4-5-20251001");
    expect(p?.inputUsdPerMillion).toBe(0.8);
    expect(p?.outputUsdPerMillion).toBe(4);
  });

  it("gemini-1.5-flash → flash-tier pricing (not pro)", () => {
    const flash = getModelPricing("google", "gemini-1.5-flash-002");
    const pro = getModelPricing("google", "gemini-1.5-pro-002");
    expect(flash?.inputUsdPerMillion).toBe(0.075);
    expect(pro?.inputUsdPerMillion).toBe(1.25);
  });
});

describe("getModelPricing — OpenRouter passthrough", () => {
  it("routes openrouter/anthropic/claude-3-5-sonnet to upstream Anthropic pricing", () => {
    const p = getModelPricing("openrouter", "anthropic/claude-3-5-sonnet");
    expect(p?.inputUsdPerMillion).toBe(3);
    expect(p?.outputUsdPerMillion).toBe(15);
  });

  it(":free suffix → zero cost regardless of upstream", () => {
    const p = getModelPricing("openrouter", "deepseek/deepseek-chat:free");
    expect(p).toEqual({ inputUsdPerMillion: 0, outputUsdPerMillion: 0 });
  });

  it("unknown upstream → null", () => {
    const p = getModelPricing("openrouter", "obscure-vendor/some-model-v9");
    expect(p).toBeNull();
  });

  it("openrouter model with no slash → null (malformed)", () => {
    const p = getModelPricing("openrouter", "just-a-model");
    expect(p).toBeNull();
  });
});

describe("getModelPricing — local providers", () => {
  it.each(["ollama", "codex-cli", "gemini-cli"])(
    "%s always returns zero pricing",
    (provider) => {
      const p = getModelPricing(provider, "any-local-model");
      expect(p?.inputUsdPerMillion).toBe(0);
      expect(p?.outputUsdPerMillion).toBe(0);
    }
  );
});

describe("getModelPricing — unknown cases", () => {
  it("unknown provider returns null", () => {
    expect(getModelPricing("aleph-alpha", "luminous-supreme")).toBeNull();
  });

  it("empty inputs return null", () => {
    expect(getModelPricing("", "gpt-4o")).toBeNull();
    expect(getModelPricing("openai", "")).toBeNull();
  });

  it("known provider, unknown model family returns null", () => {
    // A future OpenAI model we haven't added yet → null, NOT a fabricated price.
    expect(getModelPricing("openai", "gpt-99-omega")).toBeNull();
  });
});

describe("estimateCost — numerical correctness", () => {
  it("gpt-4o: 1M prompt + 500K completion = $7.50", () => {
    const cost = estimateCostFor("openai", "gpt-4o", {
      promptTokens: 1_000_000,
      completionTokens: 500_000,
    });
    expect(cost.knownPricing).toBe(true);
    expect(cost.inputUsd).toBe(2.5);
    expect(cost.outputUsd).toBe(5);
    expect(cost.totalUsd).toBe(7.5);
  });

  it("typical small turn (1k in, 500 out) on gpt-4o-mini ≈ $0.00045", () => {
    const cost = estimateCostFor("openai", "gpt-4o-mini", {
      promptTokens: 1000,
      completionTokens: 500,
    });
    // 1000 / 1M × 0.15 + 500 / 1M × 0.6 = 0.00015 + 0.0003 = 0.00045
    expect(cost.totalUsd).toBeCloseTo(0.00045, 6);
    expect(cost.knownPricing).toBe(true);
  });

  it("unknown pricing → knownPricing: false, all USD zero (NOT fabricated)", () => {
    const cost = estimateCost(
      { promptTokens: 5000, completionTokens: 2000 },
      null
    );
    expect(cost.knownPricing).toBe(false);
    expect(cost.totalUsd).toBe(0);
  });

  it("local model (ollama) → knownPricing: true, zero cost", () => {
    const cost = estimateCostFor("ollama", "llama-3.1-8b-instruct", {
      promptTokens: 50_000,
      completionTokens: 5_000,
    });
    expect(cost.knownPricing).toBe(true);
    expect(cost.totalUsd).toBe(0);
  });
});

// PM #49 — live OpenRouter cache integration tests. Imported inline so
// the rest of the file stays focused on the hardcoded table behavior.
describe("PM #49 — getModelPricing consults OpenRouter live cache first", () => {
  beforeEach(() => {
    liveCache.__resetOpenRouterPricingForTests();
  });

  afterEach(() => {
    liveCache.__resetOpenRouterPricingForTests();
  });

  it("live cache hit overrides the hardcoded substring table", () => {
    // Hardcoded table would price openrouter/openai/gpt-4o at 2.5/10.
    // Seed a live override at 1.0/3.0 and assert it wins.
    liveCache.__seedOpenRouterPricingForTests([
      ["openai/gpt-4o", { inputUsdPerMillion: 1, outputUsdPerMillion: 3 }],
    ]);
    const p = getModelPricing("openrouter", "openai/gpt-4o");
    expect(p?.inputUsdPerMillion).toBe(1);
    expect(p?.outputUsdPerMillion).toBe(3);
  });

  it("live cache miss falls through to hardcoded passthrough rules", () => {
    // No live entry → falls to substring rules → openai/gpt-4o family.
    const p = getModelPricing("openrouter", "openai/gpt-4o");
    expect(p?.inputUsdPerMillion).toBe(2.5);
  });

  it("live cache hit on a model unknown to the hardcoded table (e.g. :nitro variant)", () => {
    liveCache.__seedOpenRouterPricingForTests([
      [
        "qwen/qwen-3-32b-instruct:nitro",
        { inputUsdPerMillion: 0.5, outputUsdPerMillion: 1.5 },
      ],
    ]);
    const p = getModelPricing("openrouter", "qwen/qwen-3-32b-instruct:nitro");
    expect(p?.inputUsdPerMillion).toBe(0.5);
    expect(p?.outputUsdPerMillion).toBe(1.5);
  });

  it("hardcoded `:free` suffix still wins when live cache has no entry", () => {
    const p = getModelPricing(
      "openrouter",
      "anthropic/some-experimental-model:free"
    );
    expect(p?.inputUsdPerMillion).toBe(0);
    expect(p?.outputUsdPerMillion).toBe(0);
  });

  it("live lookup is case-insensitive on the model id", () => {
    liveCache.__seedOpenRouterPricingForTests([
      ["openai/gpt-4o", { inputUsdPerMillion: 1, outputUsdPerMillion: 3 }],
    ]);
    const p = getModelPricing("OpenRouter", "OpenAI/GPT-4o");
    expect(p?.inputUsdPerMillion).toBe(1);
  });

  it("non-openrouter providers ignore the live cache", () => {
    liveCache.__seedOpenRouterPricingForTests([
      // Even with a same-name entry in the live cache, a direct openai
      // call should hit the hardcoded table — the live cache is only
      // consulted on the openrouter path.
      ["gpt-4o", { inputUsdPerMillion: 999, outputUsdPerMillion: 999 }],
    ]);
    const p = getModelPricing("openai", "gpt-4o");
    expect(p?.inputUsdPerMillion).toBe(2.5);
  });
});

describe("getModelPricing — direct-key entries added for gpt-4.1 / o3·o4 / gemini-2.5-flash", () => {
  it("gpt-4.1 beats the generic gpt-4 catch-all (NOT the legacy $30/$60)", () => {
    expect(getModelPricing("openai", "gpt-4.1")?.inputUsdPerMillion).toBe(2);
    expect(getModelPricing("openai", "gpt-4.1-2025-04-14")?.outputUsdPerMillion).toBe(8);
    expect(getModelPricing("openai", "gpt-4.1-mini")?.inputUsdPerMillion).toBe(0.4);
    expect(getModelPricing("openai", "gpt-4.1-nano")?.inputUsdPerMillion).toBe(0.1);
    // and the legacy gpt-4 still resolves to its own (old) rate
    expect(getModelPricing("openai", "gpt-4-0613")?.inputUsdPerMillion).toBe(30);
  });

  it("o3 / o3-mini / o4-mini resolve (were 'cost unknown' before)", () => {
    expect(getModelPricing("openai", "o3")?.inputUsdPerMillion).toBe(2);
    expect(getModelPricing("openai", "o3-mini")?.inputUsdPerMillion).toBe(1.1); // mini before bare o3
    expect(getModelPricing("openai", "o4-mini")?.inputUsdPerMillion).toBe(1.1);
    // o1 family unaffected
    expect(getModelPricing("openai", "o1-mini")?.inputUsdPerMillion).toBe(3);
  });

  it("gemini-2.5-flash beats the gemini-2.5 catch-all (NOT the Pro $1.25/$10)", () => {
    expect(getModelPricing("google", "gemini-2.5-flash")?.inputUsdPerMillion).toBe(0.3);
    expect(getModelPricing("google", "gemini-2.5-flash")?.outputUsdPerMillion).toBe(2.5);
    expect(getModelPricing("google", "gemini-2.5-flash-lite")?.inputUsdPerMillion).toBe(0.1);
    // Pro still resolves to Pro pricing
    expect(getModelPricing("google", "gemini-2.5-pro")?.inputUsdPerMillion).toBe(1.25);
  });
});
