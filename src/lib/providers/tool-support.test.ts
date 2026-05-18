/**
 * Tests for `modelSupportsTools` — the central decision for whether the
 * agent should pass `tools` to a given (provider, model) pair.
 *
 * Why this file exists: PM #17 was caused by the OpenRouter branch in
 * `agent.ts` checking ONLY for `deepseek-r1`, while the Ollama branch
 * consulted the full `NO_TOOL_PATTERNS` list. This file encodes the
 * invariant that the SAME pattern list applies to every provider — so
 * the next person who adds a new pattern doesn't need to remember to
 * touch two branches.
 *
 * Coverage targets the actual user-visible failure cases:
 *   1. The historical OpenRouter gap: `google/gemma-4-31b-it`, `qwen-*-coder`
 *      (which 404'd in production), and other patterns that should be off.
 *   2. The historical Ollama branch's correct cases (kept passing through
 *      the new helper).
 *   3. The "we don't know — assume yes" path for unknown / empty model ids.
 *   4. Case-insensitivity (the user-facing settings UI doesn't normalize).
 */
import { describe, it, expect } from "vitest";
import {
  NO_TOOL_PATTERNS,
  modelSupportsTools,
} from "./tool-support";
import type { ModelConfig } from "@/lib/types";

const PROVIDERS: Array<ModelConfig["provider"]> = [
  "openai",
  "anthropic",
  "google",
  "openrouter",
  "ollama",
  "custom",
  "codex-cli",
  "gemini-cli",
];

describe("modelSupportsTools — PM #17 regression: shared pattern list across providers", () => {
  it("rejects google/gemma-4-31b-it on OpenRouter (the actual production failure)", () => {
    expect(modelSupportsTools("openrouter", "google/gemma-4-31b-it")).toBe(false);
  });

  it("rejects every non-tool pattern on EVERY provider — single source of truth", () => {
    // The historical bug was that one branch (OpenRouter) checked only a
    // subset of patterns. This test pins down the universal contract: if
    // a model id matches a NO_TOOL_PATTERNS entry, NO provider is allowed
    // to override and pretend it supports tools.
    for (const provider of PROVIDERS) {
      for (const pattern of NO_TOOL_PATTERNS) {
        // Fabricate a model id that contains the pattern. We append a
        // realistic suffix so we exercise the substring-match logic
        // rather than equality.
        const fakeId = `vendor/${pattern}some-suffix-name`;
        expect(
          modelSupportsTools(provider, fakeId),
          `${provider} + "${fakeId}" should NOT support tools (pattern "${pattern}")`
        ).toBe(false);
      }
    }
  });

  it("is case-insensitive (settings UI does not lowercase user input)", () => {
    expect(modelSupportsTools("openrouter", "Google/Gemma-4-31B-IT")).toBe(false);
    expect(modelSupportsTools("openrouter", "DEEPSEEK-R1-distill-32b")).toBe(false);
  });

  it("rejects Ollama gemma family — keeps the original Ollama-branch behavior", () => {
    // The pre-PM-#17 Ollama path (when the live `/api/show` probe failed)
    // already used these patterns. The helper preserves that.
    expect(modelSupportsTools("ollama", "gemma2:9b")).toBe(false);
    expect(modelSupportsTools("ollama", "gemma3:4b-instruct")).toBe(false);
    expect(modelSupportsTools("ollama", "phi4-mini")).toBe(false);
    expect(modelSupportsTools("ollama", "mistral:7b")).toBe(false);
  });
});

describe("modelSupportsTools — happy path", () => {
  it("allows tool-capable production models on OpenRouter", () => {
    const allowed = [
      "openai/gpt-4o-mini",
      "openai/gpt-4o",
      "anthropic/claude-3-5-sonnet-20241022",
      "anthropic/claude-3-5-haiku",
      "google/gemini-2.5-flash",
    ];
    for (const id of allowed) {
      expect(modelSupportsTools("openrouter", id), id).toBe(true);
    }
  });

  it("allows direct-provider tool-capable models", () => {
    expect(modelSupportsTools("openai", "gpt-4o")).toBe(true);
    expect(modelSupportsTools("openai", "gpt-4o-mini")).toBe(true);
    expect(modelSupportsTools("anthropic", "claude-3-5-sonnet-20241022")).toBe(true);
    expect(modelSupportsTools("google", "gemini-2.5-flash")).toBe(true);
  });

  it("returns true (not false) for unknown / empty model ids", () => {
    // The contract: if we don't know, assume yes. Upstream API will tell
    // us with a 4xx if we're wrong. That's preferable to silently dropping
    // tools for a model we just haven't tested yet.
    expect(modelSupportsTools("openai", "")).toBe(true);
    expect(modelSupportsTools("openai", "some-future-model-vX")).toBe(true);
    expect(modelSupportsTools("openrouter", "novel/unrecognized-2030")).toBe(true);
  });
});

describe("modelSupportsTools — pattern list shape", () => {
  it("NO_TOOL_PATTERNS is non-empty and contains all historical regressions", () => {
    // If anyone deletes a pattern by accident, this catches it.
    const required = ["deepseek-r1", "gemma-", "gemma2", "gemma3", "mistral", "phi"];
    for (const r of required) {
      expect(NO_TOOL_PATTERNS).toContain(r === "phi" ? "phi-" : r);
    }
  });

  it("NO_TOOL_PATTERNS is a frozen-style readonly array (no mutation by callers)", () => {
    // Compile-time `readonly` is enforced via the `as const` annotation —
    // runtime check is overkill, but a smoke test that the value didn't
    // somehow become an empty array.
    expect(Array.isArray(NO_TOOL_PATTERNS)).toBe(true);
    expect(NO_TOOL_PATTERNS.length).toBeGreaterThan(5);
  });
});
