/**
 * PM #36 — accumulator contracts.
 *
 * What we pin:
 *   - normalizeUsage handles both v5 (prompt/completion) and v6 (input/output)
 *     field naming + null/undefined gracefully.
 *   - addUsageToCumulative produces a fresh record on `undefined` current.
 *   - Unknown pricing propagates `fullyPriced: false` and DOES NOT fabricate
 *     a cost.
 *   - Known pricing computes correct cumulative USD across multiple calls.
 *   - mergeUsage sums tokens + cost; fullyPriced is AND-merged.
 */
import { describe, expect, it } from "vitest";
import {
  addUsageToCumulative,
  mergeUsage,
  normalizeUsage,
} from "./accumulator";

describe("normalizeUsage", () => {
  it("returns zero record on undefined / null", () => {
    expect(normalizeUsage(undefined)).toEqual({ promptTokens: 0, completionTokens: 0 });
    expect(normalizeUsage(null)).toEqual({ promptTokens: 0, completionTokens: 0 });
  });

  it("accepts AI SDK v5 field names (promptTokens / completionTokens)", () => {
    expect(normalizeUsage({ promptTokens: 100, completionTokens: 50 })).toEqual({
      promptTokens: 100,
      completionTokens: 50,
    });
  });

  it("accepts AI SDK v6 field names (inputTokens / outputTokens)", () => {
    expect(normalizeUsage({ inputTokens: 200, outputTokens: 75 })).toEqual({
      promptTokens: 200,
      completionTokens: 75,
    });
  });

  it("v5 wins over v6 when both present (defensive — v5 is the canonical legacy shape)", () => {
    expect(
      normalizeUsage({
        promptTokens: 100,
        completionTokens: 50,
        inputTokens: 999,
        outputTokens: 999,
      })
    ).toEqual({ promptTokens: 100, completionTokens: 50 });
  });
});

describe("addUsageToCumulative — fresh chat", () => {
  it("first call on `undefined` produces a populated record", () => {
    const out = addUsageToCumulative(undefined, "openai", "gpt-4o-mini", {
      promptTokens: 1000,
      completionTokens: 500,
    });
    expect(out.promptTokens).toBe(1000);
    expect(out.completionTokens).toBe(500);
    expect(out.fullyPriced).toBe(true);
    expect(out.costUsd).toBeCloseTo(0.00045, 6);
  });
});

describe("addUsageToCumulative — accumulation", () => {
  it("multiple calls sum tokens and cost", () => {
    let usage = addUsageToCumulative(undefined, "openai", "gpt-4o-mini", {
      promptTokens: 1000,
      completionTokens: 500,
    });
    usage = addUsageToCumulative(usage, "openai", "gpt-4o-mini", {
      promptTokens: 2000,
      completionTokens: 1000,
    });
    expect(usage.promptTokens).toBe(3000);
    expect(usage.completionTokens).toBe(1500);
    // (3000/1M × 0.15) + (1500/1M × 0.6) = 0.00045 + 0.0009 = 0.00135
    expect(usage.costUsd).toBeCloseTo(0.00135, 6);
    expect(usage.fullyPriced).toBe(true);
  });

  it("calls across different providers/models accumulate independently", () => {
    let usage = addUsageToCumulative(undefined, "openai", "gpt-4o", {
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    // gpt-4o: 1M input × 2.5 = $2.5
    expect(usage.costUsd).toBe(2.5);

    usage = addUsageToCumulative(usage, "anthropic", "claude-haiku-4-5", {
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    // claude-haiku: 1M input × 0.8 = $0.8; total $3.3
    expect(usage.costUsd).toBeCloseTo(3.3, 6);
    expect(usage.fullyPriced).toBe(true);
  });
});

describe("addUsageToCumulative — unknown pricing propagation", () => {
  it("one unknown call sets fullyPriced=false forever", () => {
    let usage = addUsageToCumulative(undefined, "openai", "gpt-4o-mini", {
      promptTokens: 100,
      completionTokens: 50,
    });
    expect(usage.fullyPriced).toBe(true);

    // A model we don't price — tokens are recorded but no cost added.
    usage = addUsageToCumulative(usage, "unknown-provider", "fancy-future-model", {
      promptTokens: 500,
      completionTokens: 200,
    });
    expect(usage.fullyPriced).toBe(false);
    expect(usage.promptTokens).toBe(600);
    expect(usage.completionTokens).toBe(250);
    // Cost is just the OpenAI portion — the unknown call adds 0 USD (not fabricated).
    expect(usage.costUsd).toBeCloseTo(0.000045, 6);

    // Subsequent KNOWN calls do NOT restore fullyPriced=true — it stays false.
    usage = addUsageToCumulative(usage, "openai", "gpt-4o-mini", {
      promptTokens: 100,
      completionTokens: 100,
    });
    expect(usage.fullyPriced).toBe(false);
  });
});

describe("addUsageToCumulative — local providers (zero-cost)", () => {
  it("ollama call adds tokens but no cost, stays fullyPriced", () => {
    const usage = addUsageToCumulative(undefined, "ollama", "llama-3.1-8b", {
      promptTokens: 5_000,
      completionTokens: 1_000,
    });
    expect(usage.promptTokens).toBe(5_000);
    expect(usage.completionTokens).toBe(1_000);
    expect(usage.costUsd).toBe(0);
    expect(usage.fullyPriced).toBe(true);
  });
});

describe("mergeUsage", () => {
  it("merging undefined with a value returns the value", () => {
    const b = { promptTokens: 100, completionTokens: 50, costUsd: 0.05, fullyPriced: true };
    expect(mergeUsage(undefined, b)).toEqual(b);
    expect(mergeUsage(b, undefined)).toEqual(b);
  });

  it("merging two records sums tokens and cost; AND-merges fullyPriced", () => {
    const a = { promptTokens: 100, completionTokens: 50, costUsd: 0.05, fullyPriced: true };
    const b = { promptTokens: 200, completionTokens: 100, costUsd: 0.1, fullyPriced: false };
    expect(mergeUsage(a, b)).toEqual({
      promptTokens: 300,
      completionTokens: 150,
      costUsd: 0.15000000000000002, // floating point — close enough
      fullyPriced: false,
    });
  });
});
