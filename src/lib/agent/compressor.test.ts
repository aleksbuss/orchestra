import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock ALL transitive dependencies BEFORE importing the module under test
vi.mock("@/lib/providers/llm-provider", () => ({
  createModel: vi.fn(() => ({})),
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual("ai");
  return {
    ...actual,
    generateText: vi.fn(),
  };
});

import { compressChatHistory, estimateTokenCount } from "./compressor";
import { generateText } from "ai";
import type { ChatMessage } from "@/lib/types";

describe("Context Compressor (Archivarius)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("should return empty string for empty messages", async () => {
    const result = await compressChatHistory([], {} as any);
    expect(result).toBe("");
  });

  it("should produce a compressed summary from chat messages", async () => {
    const mockMessages: ChatMessage[] = [
      { id: "1", role: "user", content: "Write a React button", createdAt: "1" },
      { id: "2", role: "assistant", content: "Here is the code for Button.tsx", createdAt: "2" },
    ];

    vi.mocked(generateText).mockResolvedValue({
      text: "- User requested React button component\n- Assistant provided Button.tsx",
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 15, totalTokens: 25 },
    } as any);

    const summary = await compressChatHistory(mockMessages, {
      chatModel: { provider: "ollama", model: "llama3", temperature: 0.1, maxTokens: 1000 },
    } as any);

    expect(summary).toContain("React button");
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("should gracefully handle LLM failure", async () => {
    const mockMessages: ChatMessage[] = [
      { id: "1", role: "user", content: "Hello", createdAt: "1" },
    ];

    vi.mocked(generateText).mockRejectedValue(new Error("Ollama is offline"));

    const result = await compressChatHistory(mockMessages, {
      chatModel: { provider: "ollama", model: "llama3", temperature: 0.1, maxTokens: 1000 },
    } as any);

    // Should NOT throw — returns a formatted error string instead
    expect(result).toContain("Context Compression Failed");
    expect(result).toContain("Ollama is offline");
  });
});

describe("estimateTokenCount", () => {
  it("should estimate tokens from message content length", () => {
    const messages = [
      { role: "user" as const, content: "Hello world" }, // 11 chars ~ 3 tokens
    ];
    const estimate = estimateTokenCount(messages as any);
    expect(estimate).toBeGreaterThan(0);
    expect(estimate).toBeLessThan(20);
  });

  // Sprint A1 regression — the root cause of mid-loop context-overflow crashes.
  // A tool-result lives in an ARRAY content; the old `(content as string).length`
  // counted the ARRAY LENGTH (1), so a 50 KB file dump was estimated at ~0 tokens
  // and compaction never fired.
  it("counts characters inside an array tool-result, not the array length", () => {
    const bigOutput = "x".repeat(35000); // ~10k tokens of file dump
    const messages = [
      {
        role: "tool" as const,
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "read_file",
            output: { type: "json", value: bigOutput },
          },
        ],
      },
    ];
    const estimate = estimateTokenCount(messages as any);
    // 35000 chars / 3.5 ≈ 10000 — must be in the thousands, NOT ~1.
    expect(estimate).toBeGreaterThan(9000);
  });

  it("counts text + tool-call parts inside an assistant array content", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: [
          { type: "text", text: "y".repeat(700) },
          {
            type: "tool-call",
            toolCallId: "c2",
            toolName: "search_web",
            input: { query: "z".repeat(700) },
          },
        ],
      },
    ];
    const estimate = estimateTokenCount(messages as any);
    // ~1400+ chars / 3.5 ≈ 400+, decisively above the old buggy ~1.
    expect(estimate).toBeGreaterThan(380);
  });

  it("returns 0 for empty / null content without throwing", () => {
    const messages = [
      { role: "assistant" as const, content: [] },
      { role: "user" as const, content: null },
    ];
    expect(estimateTokenCount(messages as any)).toBe(0);
  });
});
