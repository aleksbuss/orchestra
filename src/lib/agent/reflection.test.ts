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
  generateObject: vi.fn(),
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

    // Audit C1 — the critic is told to reason (with a CLAIM/DOUBT chain) before
    // the verdict, and that reasoning contains braces. A greedy first-{ → last-}
    // match would splice the reasoning brace with the verdict brace → invalid
    // JSON → critic silently dropped. The verdict must still be extracted.
    it("extracts the verdict even when reasoning before it contains braces", async () => {
      const { generateText } = await import("ai");
      vi.mocked(generateText).mockResolvedValueOnce({
        text:
          "<doubt>\nCLAIM: the code is fine.\n" +
          "EXTRACT: it does `const cfg = { retries: 3, opts: { a: 1 } }` and a `function(){}`.\n" +
          "DOUBT: retries is unbounded on failure.\n</doubt>\n" +
          '{"shouldRevise": true, "critique": "Unbounded retry.", "suggestion": "Cap retries."}',
      } as never);

      const { reflectOnResponse } = await import("@/lib/agent/reflection");
      const result = await reflectOnResponse({
        userMessage: "review this",
        agentResponse: "a".repeat(80),
        settings: makeSettings(),
      });

      expect(result.shouldRevise).toBe(true);
      expect(result.critique).toBe("Unbounded retry.");
      expect(result.suggestion).toBe("Cap retries.");
    });

    // Audit C1 — a parse miss must NOT trigger a retry (a critic that can't emit
    // a parseable verdict won't on a second identical call; retrying just
    // doubles the cost). One call, then graceful skip.
    it("does NOT retry on an unparseable verdict (single call, graceful skip)", async () => {
      const { generateText } = await import("ai");
      vi.mocked(generateText).mockResolvedValue({
        text: "<doubt>lots of reasoning but I forgot the JSON verdict entirely</doubt>",
      } as never);

      const { reflectOnResponse } = await import("@/lib/agent/reflection");
      const result = await reflectOnResponse({
        userMessage: "test",
        agentResponse: "a".repeat(50),
        settings: makeSettings(),
      });

      expect(result.shouldRevise).toBe(false);
      expect(vi.mocked(generateText)).toHaveBeenCalledTimes(1);
    });
  });

  describe("extractCriticVerdict (unit)", () => {
    it("returns null when there is no verdict object", async () => {
      const { extractCriticVerdict } = await import("@/lib/agent/reflection");
      expect(extractCriticVerdict("just prose, no json")).toBeNull();
      expect(extractCriticVerdict('{"foo": 1}')).toBeNull(); // object without shouldRevise
    });

    it("picks the LAST balanced object carrying the verdict", async () => {
      const { extractCriticVerdict } = await import("@/lib/agent/reflection");
      const v = extractCriticVerdict(
        'noise {a:{b:1}} more {"shouldRevise": false, "critique": "", "suggestion": ""}'
      );
      expect(v).toEqual({ shouldRevise: false, critique: "", suggestion: "" });
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
    const { generateObject } = await import("ai");
    vi.mocked(generateObject).mockResolvedValueOnce({
      object: { diff: "Revised version with the fix applied.", status: "fixed" },
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

  // Audit R2 — weak/free models often can't satisfy a JSON schema. When
  // structured output fails, a tolerant text revision must still produce a
  // working revised answer instead of silently returning the un-revised original.
  it("falls back to a TEXT revision when structured output fails (weak-model path)", async () => {
    const { generateObject, generateText } = await import("ai");
    vi.mocked(generateObject).mockRejectedValueOnce(new Error("model does not support structured output"));
    vi.mocked(generateText).mockResolvedValueOnce({
      text: "Revised answer produced without a schema.",
      usage: { inputTokens: 120, outputTokens: 40 },
    } as never);

    const { reviseWithCritique } = await import("@/lib/agent/reflection");
    const result = await reviseWithCritique({
      userMessage: "test",
      originalResponse: "original with a bug",
      critique: "has a bug",
      suggestion: "fix the bug",
      settings: makeSettings(),
    });

    expect(result.status).toBe("fixed");
    expect(result.text).toBe("Revised answer produced without a schema.");
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 40 });
  });

  it("returns ORIGINAL text when BOTH structured and text revision throw (never blocks)", async () => {
    const { generateObject, generateText } = await import("ai");
    vi.mocked(generateObject).mockRejectedValueOnce(new Error("LLM failure"));
    vi.mocked(generateText).mockRejectedValueOnce(new Error("LLM failure too"));

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

// ── DDD Phase 4 (corrected) — compiler evidence injection ─────────────────────
describe("Compiler evidence in the critic prompt (advisory, PM #84 posture)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("a draft with a broken ts block → critic prompt carries the parser diagnostics", async () => {
    const { generateText } = await import("ai");
    vi.mocked(generateText).mockResolvedValueOnce({
      text: '{"shouldRevise": false, "critique": "", "suggestion": ""}',
    } as never);

    const { reflectOnResponse } = await import("@/lib/agent/reflection");
    const brokenDraft =
      "Use this helper:\n```ts\nexport function add(a: number {\n  return a + ;\n}\n```\n" +
      "That should solve the problem you described.";
    await reflectOnResponse({
      userMessage: "write an add function",
      agentResponse: brokenDraft,
      settings: makeSettings(),
    });

    const call = vi.mocked(generateText).mock.calls[0][0] as unknown as {
      messages: Array<{ content: string }>;
    };
    const content = call.messages[0].content;
    expect(content).toContain("Deterministic compiler evidence");
    expect(content).toContain("Syntax error");
    // Advisory framing — the evidence must NOT position itself as a verdict.
    expect(content).toContain("audit those yourself");
  });

  it("a prose-only draft → no evidence section is injected", async () => {
    const { generateText } = await import("ai");
    vi.mocked(generateText).mockResolvedValueOnce({
      text: '{"shouldRevise": false, "critique": "", "suggestion": ""}',
    } as never);

    const { reflectOnResponse } = await import("@/lib/agent/reflection");
    await reflectOnResponse({
      userMessage: "explain the tradeoffs",
      agentResponse:
        "The main tradeoff is latency versus quality: a bigger committee costs more time.",
      settings: makeSettings(),
    });

    const call = vi.mocked(generateText).mock.calls[0][0] as unknown as {
      messages: Array<{ content: string }>;
    };
    expect(call.messages[0].content).not.toContain(
      "Deterministic compiler evidence"
    );
  });
});

// ── DDD Phase 1 (corrected) — reflection outcome classification ───────────────
describe("deriveReflectionOutcome — flag precedence for ddd_reflection_outcome", () => {
  it("cannot_fix wins over everything (an unresolvable critique is never 'clean')", async () => {
    const { deriveReflectionOutcome } = await import("@/lib/agent/reflection");
    expect(
      deriveReflectionOutcome({
        criticCleanedUp: true,
        cannotFix: true,
        converged: true,
        hitCap: true,
      })
    ).toBe("cannot_fix");
  });

  it("critic_clean when the critic approved", async () => {
    const { deriveReflectionOutcome } = await import("@/lib/agent/reflection");
    expect(
      deriveReflectionOutcome({
        criticCleanedUp: true,
        cannotFix: false,
        converged: false,
        hitCap: false,
      })
    ).toBe("critic_clean");
  });

  it("converged when the loop stopped on cosine similarity", async () => {
    const { deriveReflectionOutcome } = await import("@/lib/agent/reflection");
    expect(
      deriveReflectionOutcome({
        criticCleanedUp: false,
        cannotFix: false,
        converged: true,
        hitCap: false,
      })
    ).toBe("converged");
  });

  it("max_rounds when the cap exhausted without approval", async () => {
    const { deriveReflectionOutcome } = await import("@/lib/agent/reflection");
    expect(
      deriveReflectionOutcome({
        criticCleanedUp: false,
        cannotFix: false,
        converged: false,
        hitCap: true,
      })
    ).toBe("max_rounds");
  });

  it("revised as the fallthrough (maxRounds=1 run that applied a revision)", async () => {
    const { deriveReflectionOutcome } = await import("@/lib/agent/reflection");
    expect(
      deriveReflectionOutcome({
        criticCleanedUp: false,
        cannotFix: false,
        converged: false,
        hitCap: false,
      })
    ).toBe("revised");
  });
});
