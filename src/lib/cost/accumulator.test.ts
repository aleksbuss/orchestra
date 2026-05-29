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
  assertChatBudget,
  ChatBudgetExceededError,
  checkChatBudget,
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

describe("Sprint 2 — checkChatBudget (per-chat hard USD cap)", () => {
  const usage = (costUsd: number, fullyPriced = true) => ({
    promptTokens: 1000,
    completionTokens: 500,
    costUsd,
    fullyPriced,
  });

  it("returns over=false when no cap is configured (undefined)", () => {
    expect(checkChatBudget(usage(99), undefined)).toEqual({
      over: false,
      costUsd: 99,
      maxUsdPerChat: null,
    });
  });

  it("returns over=false when cap is null", () => {
    expect(checkChatBudget(usage(99), null)).toEqual({
      over: false,
      costUsd: 99,
      maxUsdPerChat: null,
    });
  });

  it("returns over=false when cap is 0 (treated as disabled — zero/negative is operator nonsense)", () => {
    // Choosing not to interpret 0 as "block everything"; if an operator
    // truly wants no spend, they delete the chat or disable the model.
    expect(checkChatBudget(usage(0.01), 0).over).toBe(false);
    expect(checkChatBudget(usage(0.01), -1).over).toBe(false);
  });

  it("returns over=false on non-finite cap (Infinity / NaN — treated as disabled)", () => {
    expect(checkChatBudget(usage(1), Infinity).over).toBe(false);
    expect(checkChatBudget(usage(1), NaN).over).toBe(false);
  });

  it("returns over=true once cost >= cap", () => {
    const r = checkChatBudget(usage(5.0), 5.0);
    expect(r.over).toBe(true);
    expect(r.costUsd).toBe(5.0);
    expect(r.maxUsdPerChat).toBe(5.0);
  });

  it("returns over=false when cost is strictly below cap", () => {
    expect(checkChatBudget(usage(4.999), 5.0).over).toBe(false);
  });

  it("treats undefined current as cost=0 (fresh chat passes any positive cap)", () => {
    expect(checkChatBudget(undefined, 5.0)).toEqual({
      over: false,
      costUsd: 0,
      maxUsdPerChat: 5.0,
    });
  });

  it("enforces the cap even when fullyPriced=false (lower-bound spend already over)", () => {
    // PM rationale recorded in accumulator.ts — once a lower-bound exceeds
    // the cap, the real spend definitely does too.
    expect(checkChatBudget(usage(10, false), 5.0).over).toBe(true);
  });
});

describe("Sprint 2 — assertChatBudget (throwing wrapper)", () => {
  const usage = (costUsd: number) => ({
    promptTokens: 0,
    completionTokens: 0,
    costUsd,
    fullyPriced: true,
  });

  it("does NOT throw when under cap", () => {
    expect(() => assertChatBudget(usage(4.99), 5.0)).not.toThrow();
  });

  it("does NOT throw when no cap configured", () => {
    expect(() => assertChatBudget(usage(99), undefined)).not.toThrow();
    expect(() => assertChatBudget(usage(99), null)).not.toThrow();
  });

  it("throws ChatBudgetExceededError when over cap", () => {
    expect(() => assertChatBudget(usage(5.01), 5.0)).toThrow(
      ChatBudgetExceededError
    );
  });

  it("error carries costUsd + maxUsdPerChat on the instance", () => {
    try {
      assertChatBudget(usage(7.42), 5.0);
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ChatBudgetExceededError);
      expect((err as ChatBudgetExceededError).costUsd).toBe(7.42);
      expect((err as ChatBudgetExceededError).maxUsdPerChat).toBe(5.0);
    }
  });

  it("error message includes both numbers formatted", () => {
    try {
      assertChatBudget(usage(7.42), 5.0);
      expect.fail("expected throw");
    } catch (err) {
      expect((err as Error).message).toMatch(/\$7\.4200/);
      expect((err as Error).message).toMatch(/\$5\.00/);
    }
  });
});
