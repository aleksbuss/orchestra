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
import { describe, expect, it } from "vitest";
import {
  estimateCost,
  estimateCostFor,
  getModelPricing,
} from "./pricing";

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
