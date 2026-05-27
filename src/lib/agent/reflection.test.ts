/**
 * reflection.test.ts — Comprehensive Reflection System Tests
 *
 * Tests the QA Auditor module which self-critiques agent responses.
 * Uses vi.mock to avoid real LLM calls.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { AppSettings } from "@/lib/types";

// ── Mock the AI SDK to avoid real LLM calls ────────────────────────────────────

vi.mock("ai", () => ({
  generateText: vi.fn(),
}));

vi.mock("@/lib/providers/llm-provider", () => ({
  createModel: vi.fn(() => ({ modelId: "mock-model" })),
}));

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    chatModel: { provider: "openai", model: "gpt-4o" },
    utilityModel: { provider: "openai", model: "gpt-4o-mini" },
    providerApiKeys: { openai: "test-key" },
    reflectionEnabled: true,
    swarmEnabled: false,
    ...overrides,
  } as AppSettings;
}

describe("Reflection System (QA Auditor)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("Short response skip logic", () => {
    it("responses under 30 chars should skip reflection", async () => {
      const { reflectOnResponse } = await import("@/lib/agent/reflection");
      const result = await reflectOnResponse({
        userMessage: "ping",
        agentResponse: "pong",
        settings: makeSettings(),
      });

      expect(result.shouldRevise).toBe(false);
      expect(result.critique).toBe("");
    });

    it("responses of exactly 30 chars should trigger reflection", async () => {
      const { generateText } = await import("ai");
      vi.mocked(generateText).mockResolvedValueOnce({
        text: '{"shouldRevise": false, "critique": "", "suggestion": ""}',
      } as never);

      const { reflectOnResponse } = await import("@/lib/agent/reflection");
      const response30 = "a".repeat(30);

      const result = await reflectOnResponse({
        userMessage: "test",
        agentResponse: response30,
        settings: makeSettings(),
      });

      expect(result.shouldRevise).toBe(false);
    });
  });

  describe("JSON response parsing", () => {
    it("should parse shouldRevise=true with critique and suggestion", async () => {
      const { generateText } = await import("ai");
      vi.mocked(generateText).mockResolvedValueOnce({
        text: JSON.stringify({
          shouldRevise: true,
          critique: "The code has a missing import.",
          suggestion: "Add `import React from 'react';` at the top.",
        }),
      } as never);

      const { reflectOnResponse } = await import("@/lib/agent/reflection");
      const result = await reflectOnResponse({
        userMessage: "Write a React component",
        agentResponse: "a".repeat(50),
        settings: makeSettings(),
      });

      expect(result.shouldRevise).toBe(true);
      expect(result.critique).toBe("The code has a missing import.");
      expect(result.suggestion).toContain("import React");
    });

    it("should parse shouldRevise=false as clean response", async () => {
      const { generateText } = await import("ai");
      vi.mocked(generateText).mockResolvedValueOnce({
        text: '{"shouldRevise": false, "critique": "", "suggestion": ""}',
      } as never);

      const { reflectOnResponse } = await import("@/lib/agent/reflection");
      const result = await reflectOnResponse({
        userMessage: "Explain recursion",
        agentResponse: "a".repeat(100),
        settings: makeSettings(),
      });

      expect(result.shouldRevise).toBe(false);
    });

    it("should handle malformed JSON gracefully (no throw, returns shouldRevise=false)", async () => {
      const { generateText } = await import("ai");
      vi.mocked(generateText).mockResolvedValueOnce({
        text: "This is not valid JSON at all!",
      } as never);

      const { reflectOnResponse } = await import("@/lib/agent/reflection");
      const result = await reflectOnResponse({
        userMessage: "test",
        agentResponse: "a".repeat(50),
        settings: makeSettings(),
      });

      expect(result.shouldRevise).toBe(false);
      expect(result.critique).toBe("");
    });

    it("should extract JSON from mixed text response (JSON embedded in prose)", async () => {
      const { generateText } = await import("ai");
      vi.mocked(generateText).mockResolvedValueOnce({
        text: 'Here is my analysis:\n{"shouldRevise": true, "critique": "Missing null check.", "suggestion": "Add null guard."}\nThat concludes my review.',
      } as never);

      const { reflectOnResponse } = await import("@/lib/agent/reflection");
      const result = await reflectOnResponse({
        userMessage: "test",
        agentResponse: "a".repeat(50),
        settings: makeSettings(),
      });

      expect(result.shouldRevise).toBe(true);
      expect(result.critique).toBe("Missing null check.");
    });
  });

  describe("Error handling", () => {
    it("should return no-revision if LLM call throws (fail-safe)", async () => {
      const { generateText } = await import("ai");
      vi.mocked(generateText).mockRejectedValueOnce(new Error("LLM timeout"));

      const { reflectOnResponse } = await import("@/lib/agent/reflection");
      const result = await reflectOnResponse({
        userMessage: "test",
        agentResponse: "a".repeat(50),
        settings: makeSettings(),
      });

      // Reflection failure must never block the main response
      expect(result.shouldRevise).toBe(false);
      expect(result.critique).toBe("");
    });

    it("should use utilityModel if available, else fall back to chatModel", async () => {
      const { generateText } = await import("ai");
      const { createModel } = await import("@/lib/providers/llm-provider");

      vi.mocked(generateText).mockResolvedValueOnce({
        text: '{"shouldRevise": false, "critique": "", "suggestion": ""}',
      } as never);

      const { reflectOnResponse } = await import("@/lib/agent/reflection");
      const settings = makeSettings({
        utilityModel: { provider: "anthropic", model: "claude-haiku" },
      });

      await reflectOnResponse({
        userMessage: "test",
        agentResponse: "a".repeat(50),
        settings,
      });

      // createModel should have been called with the utilityModel config
      expect(vi.mocked(createModel)).toHaveBeenCalledWith(
        expect.objectContaining({ model: "claude-haiku" }),
        expect.anything()
      );
    });
  });

  // PM #38 — usage + modelConfig must surface so the budget banner
  // (PM #36) can attribute reflection cost. Without these the banner
  // would silently under-count when the operator enables reflection.
  describe("PM #38 — usage + modelConfig attribution", () => {
    it("reflectOnResponse returns usage + modelConfig on success", async () => {
      const { generateText } = await import("ai");
      vi.mocked(generateText).mockResolvedValueOnce({
        text: '{"shouldRevise": true, "critique": "missing X", "suggestion": "add X"}',
        usage: { inputTokens: 100, outputTokens: 30 },
      } as never);

      const { reflectOnResponse } = await import("@/lib/agent/reflection");
      const result = await reflectOnResponse({
        userMessage: "test",
        agentResponse: "a".repeat(50),
        settings: makeSettings({
          utilityModel: { provider: "openai", model: "gpt-4o-mini" },
        }),
      });

      expect(result.shouldRevise).toBe(true);
      expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 30 });
      expect(result.modelConfig).toEqual({
        provider: "openai",
        model: "gpt-4o-mini",
      });
    });

    it("reflectOnResponse short-circuit (< 30 chars) returns NO usage", async () => {
      const { reflectOnResponse } = await import("@/lib/agent/reflection");
      const result = await reflectOnResponse({
        userMessage: "ping",
        agentResponse: "pong",
        settings: makeSettings(),
      });
      // No LLM call happened — nothing to attribute. Banner adds zero.
      expect(result.usage).toBeUndefined();
      expect(result.modelConfig).toBeUndefined();
    });
  });
});

describe("PM #38 — reviseWithCritique", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns revised text + usage + modelConfig on success", async () => {
    const { generateText } = await import("ai");
    vi.mocked(generateText).mockResolvedValueOnce({
      text: "Revised version with the fix applied.",
      usage: { inputTokens: 200, outputTokens: 50 },
    } as never);

    const { reviseWithCritique } = await import("@/lib/agent/reflection");
    const result = await reviseWithCritique({
      userMessage: "Write a function",
      originalResponse: "function foo() {}",
      critique: "Missing JSDoc",
      suggestion: "Add a JSDoc comment",
      settings: makeSettings({
        chatModel: { provider: "anthropic", model: "claude-sonnet-4-6" },
      }),
    });

    expect(result.text).toBe("Revised version with the fix applied.");
    expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 50 });
    expect(result.modelConfig).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
  });

  it("returns ORIGINAL text when revisor throws (never blocks the response)", async () => {
    const { generateText } = await import("ai");
    vi.mocked(generateText).mockRejectedValueOnce(new Error("LLM timeout"));

    const { reviseWithCritique } = await import("@/lib/agent/reflection");
    const result = await reviseWithCritique({
      userMessage: "test",
      originalResponse: "original answer",
      critique: "issue",
      suggestion: "fix",
      settings: makeSettings(),
    });

    expect(result.text).toBe("original answer");
    expect(result.usage).toBeUndefined();
  });

  it("returns ORIGINAL when revisor produces an empty response (defensive)", async () => {
    const { generateText } = await import("ai");
    vi.mocked(generateText).mockResolvedValueOnce({
      text: "   \n  ",
      usage: { inputTokens: 100, outputTokens: 0 },
    } as never);

    const { reviseWithCritique } = await import("@/lib/agent/reflection");
    const result = await reviseWithCritique({
      userMessage: "test",
      originalResponse: "good original",
      critique: "issue",
      suggestion: "fix",
      settings: makeSettings(),
    });

    expect(result.text).toBe("good original");
  });

  it("modelOverride wins over settings.chatModel", async () => {
    const { generateText } = await import("ai");
    const { createModel } = await import("@/lib/providers/llm-provider");
    vi.mocked(generateText).mockResolvedValueOnce({
      text: "ok",
      usage: { inputTokens: 50, outputTokens: 10 },
    } as never);

    const { reviseWithCritique } = await import("@/lib/agent/reflection");
    await reviseWithCritique({
      userMessage: "test",
      originalResponse: "x".repeat(50),
      critique: "fix it",
      suggestion: "do this",
      settings: makeSettings({
        chatModel: { provider: "openai", model: "gpt-4o" },
      }),
      modelOverride: { provider: "anthropic", model: "claude-opus-4-7" },
    });

    expect(vi.mocked(createModel)).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-opus-4-7" }),
      expect.anything()
    );
  });
});
