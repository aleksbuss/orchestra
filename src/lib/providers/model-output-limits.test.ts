/**
 * Per-model max OUTPUT token resolution — replaces the old hardcoded `?? 4096`
 * so completion length auto-sizes to the SELECTED model (gpt-4o 16k, Claude 8k,
 * Gemini 2.5 64k, DeepSeek 8k, …), with the operator's explicit `maxTokens` as
 * an override that is never allowed to exceed the model's true max.
 */
import { describe, it, expect } from "vitest";
import type { ModelConfig } from "@/lib/types";
import {
  getModelMaxOutput,
  resolveMaxOutputTokens,
  registerOpenRouterMaxOutputLookup,
  DEFAULT_MAX_OUTPUT,
} from "./model-output-limits";

const cfg = (over: Partial<ModelConfig>): ModelConfig =>
  ({ provider: "openai", model: "gpt-4o", apiKey: "k", ...over } as ModelConfig);

describe("getModelMaxOutput — static family registry", () => {
  it("matches known families, most-specific first", () => {
    expect(getModelMaxOutput("openai", "gpt-4o")).toBe(16_384);
    expect(getModelMaxOutput("openai", "gpt-4o-mini")).toBe(16_384);
    expect(getModelMaxOutput("openai", "gpt-4-turbo")).toBe(4_096);
    expect(getModelMaxOutput("openai", "o3-mini")).toBe(100_000);
    expect(getModelMaxOutput("openrouter", "deepseek/deepseek-chat")).toBe(8_192);
    expect(getModelMaxOutput("anthropic", "claude-3-5-sonnet")).toBe(8_192);
    expect(getModelMaxOutput("google", "gemini-2.5-pro")).toBe(65_536);
  });

  it("returns undefined for unknown models and empty ids", () => {
    expect(getModelMaxOutput("ollama", "some-obscure-local-model")).toBeUndefined();
    expect(getModelMaxOutput("openai", undefined)).toBeUndefined();
  });
});

describe("resolveMaxOutputTokens", () => {
  it("uses the model's max when no explicit maxTokens is set (auto-size)", () => {
    expect(resolveMaxOutputTokens(cfg({ model: "gpt-4o", maxTokens: undefined }))).toBe(16_384);
  });

  it("honors an explicit maxTokens that is below the model max", () => {
    expect(resolveMaxOutputTokens(cfg({ model: "gpt-4o", maxTokens: 4_096 }))).toBe(4_096);
  });

  it("CAPS an explicit maxTokens that exceeds the model's true max", () => {
    expect(
      resolveMaxOutputTokens(
        cfg({ provider: "openrouter", model: "deepseek/deepseek-chat", maxTokens: 50_000 })
      )
    ).toBe(8_192);
  });

  it("falls back to DEFAULT_MAX_OUTPUT for an unknown model with no explicit value", () => {
    expect(
      resolveMaxOutputTokens(cfg({ provider: "ollama", model: "obscure", maxTokens: undefined }))
    ).toBe(DEFAULT_MAX_OUTPUT);
  });

  it("keeps an explicit maxTokens for an unknown model (no cap available)", () => {
    expect(
      resolveMaxOutputTokens(cfg({ provider: "ollama", model: "obscure", maxTokens: 12_000 }))
    ).toBe(12_000);
  });
});

describe("OpenRouter dynamic source (the live query) wins over the registry", () => {
  it("uses max_completion_tokens from the injected OpenRouter lookup", () => {
    registerOpenRouterMaxOutputLookup((id) =>
      id === "deepseek/deepseek-chat" ? 12_345 : undefined
    );
    // dynamic value wins for the known id…
    expect(getModelMaxOutput("openrouter", "deepseek/deepseek-chat")).toBe(12_345);
    // …and the registry still answers when the dynamic source has nothing.
    expect(getModelMaxOutput("openrouter", "anthropic/claude-3.5-sonnet")).toBe(8_192);
    // dynamic only applies to the openrouter provider.
    expect(getModelMaxOutput("openai", "gpt-4o")).toBe(16_384);
  });
});
