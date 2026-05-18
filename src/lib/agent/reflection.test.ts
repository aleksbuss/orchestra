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
});
