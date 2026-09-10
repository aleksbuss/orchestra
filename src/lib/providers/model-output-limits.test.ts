/**
 * Per-model max OUTPUT token resolution — replaces the old hardcoded `?? 4096`
 * so completion length auto-sizes to the SELECTED model (gpt-4o 16k, Claude 8k,
 * Gemini 2.5 64k, DeepSeek 8k, …), with the operator's explicit `maxTokens` as
 * an override that is never allowed to exceed the model's true max.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { ModelConfig } from "@/lib/types";
import {
  getModelMaxOutput,
  resolveMaxOutputTokens,
  registerOpenRouterMaxOutputLookup,
  DEFAULT_MAX_OUTPUT,
  OPENROUTER_RELIABLE_MAX_OUTPUT,
} from "./model-output-limits";

const cfg = (over: Partial<ModelConfig>): ModelConfig =>
  ({ provider: "openai", model: "gpt-4o", apiKey: "k", ...over } as ModelConfig);

describe("getModelMaxOutput — static family registry", () => {
  it("matches known families, most-specific first", () => {
    expect(getModelMaxOutput("openai", "gpt-4o")).toBe(16_384);
    expect(getModelMaxOutput("openai", "gpt-4o-mini")).toBe(16_384);
    expect(getModelMaxOutput("openai", "gpt-4-turbo")).toBe(4_096);
    expect(getModelMaxOutput("openai", "o3-mini")).toBe(100_000);
    expect(getModelMaxOutput("openrouter", "deepseek/deepseek-chat")).toBe(16_384);
    expect(getModelMaxOutput("anthropic", "claude-3-5-sonnet")).toBe(8_192);
    expect(getModelMaxOutput("google", "gemini-2.5-pro")).toBe(65_536);
  });

  it("keeps beta-gated Claude families at the SAFE default (8192), never the 64k/128k beta limit", () => {
    // Anthropic 400s on max_tokens > 8192 without an `anthropic-beta` header,
    // which Orchestra does not send. These MUST resolve to 8192.
    expect(getModelMaxOutput("anthropic", "claude-sonnet-4-20250514")).toBe(8_192);
    expect(getModelMaxOutput("anthropic", "claude-3-7-sonnet")).toBe(8_192);
    expect(getModelMaxOutput("anthropic", "claude-opus-4")).toBe(8_192);
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
    ).toBe(16_384);
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

/**
 * PM #112 — the file used to assume "providers cap the request to their true
 * max, so an over-estimate degrades gracefully". Measured against
 * `dots-studio/dots-3-note-preview:free`, whose catalogue entry advertises
 * `max_completion_tokens: 460800`: 300000 → HTTP 200, 400000 → HTTP 400
 * (`{"msg":"bad request"}` from AtlasCloud), 460800 → HTTP 400 three times out
 * of three. Free Mode drops the operator's `maxTokens`, so every Free Mode turn
 * took the unset branch, asked for 460800, and died before the first token.
 */
describe("OpenRouter advertised ceilings are NOT trusted (PM #112)", () => {
  afterEach(() => {
    // Leave the module-level hook clean for whatever runs next.
    registerOpenRouterMaxOutputLookup(() => undefined);
  });

  it("clamps a catalogue value above the reliable ceiling", () => {
    registerOpenRouterMaxOutputLookup((id) =>
      id === "dots-studio/dots-3-note-preview:free" ? 460_800 : undefined
    );
    expect(
      getModelMaxOutput("openrouter", "dots-studio/dots-3-note-preview:free")
    ).toBe(OPENROUTER_RELIABLE_MAX_OUTPUT);
  });

  it("leaves a catalogue value BELOW the ceiling exactly as advertised", () => {
    registerOpenRouterMaxOutputLookup(() => 12_345);
    expect(getModelMaxOutput("openrouter", "some/model")).toBe(12_345);
  });

  it("clamps the family-registry path too — same unverified bet, different door", () => {
    registerOpenRouterMaxOutputLookup(() => undefined);
    // "o1" resolves to 100_000 in FAMILY_LIMITS.
    expect(getModelMaxOutput("openrouter", "openai/o1-preview")).toBe(
      OPENROUTER_RELIABLE_MAX_OUTPUT
    );
    // Same model id on the DIRECT provider keeps the curated vendor limit.
    expect(getModelMaxOutput("openai", "o1-preview")).toBe(100_000);
  });

  it("is the value actually requested when Free Mode leaves maxTokens unset", () => {
    registerOpenRouterMaxOutputLookup(() => 460_800);
    // Free Mode's overlay is provider+model ONLY — this is the exact shape.
    const freeModeConfig = {
      provider: "openrouter",
      model: "dots-studio/dots-3-note-preview:free",
    } as ModelConfig;
    const requested = resolveMaxOutputTokens(freeModeConfig);
    expect(requested).toBe(OPENROUTER_RELIABLE_MAX_OUTPUT);
    // The measured 400 boundary sits between 300000 and 400000; whatever we
    // send must stay far below it, not merely below the advertised number.
    expect(requested).toBeLessThan(300_000);
  });
});
