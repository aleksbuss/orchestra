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

import {
  compressChatHistory,
  estimateTokenCount,
  partitionForCompaction,
  formatVerbatimArchive,
  shouldSummarizeEviction,
  SUMMARY_MIN_EVICTED_TOKENS,
} from "./compressor";
import { generateText } from "ai";
import { encode } from "gpt-tokenizer/encoding/cl100k_base";
import type { ChatMessage } from "@/lib/types";

const mk = (id: string, role: ChatMessage["role"], content: string): ChatMessage => ({
  id,
  role,
  content,
  createdAt: id,
});

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

// Sprint A4 — sliding-window + anchors compaction. Pre-flight compaction must
// keep system anchors + the recent window VERBATIM and preserve exact strings.
describe("partitionForCompaction (Sprint A4 sliding-window + anchors)", () => {
  it("pins leading system anchors and the recent window, evicts the middle", () => {
    const messages: ChatMessage[] = [
      mk("s1", "system", "SYSTEM ANCHOR"),
      mk("o1", "user", "old-1"),
      mk("o2", "assistant", "old-2"),
      mk("r1", "user", "recent-1"),
      mk("r2", "assistant", "recent-2"),
    ];
    const { anchors, evicted, recent } = partitionForCompaction(messages, 2);

    expect(anchors.map((m) => m.id)).toEqual(["s1"]);
    expect(evicted.map((m) => m.id)).toEqual(["o1", "o2"]);
    expect(recent.map((m) => m.id)).toEqual(["r1", "r2"]);
  });

  it("evicts nothing for a short history (≤ anchors + keepRecent) — no negative-slice footgun", () => {
    const messages: ChatMessage[] = [
      mk("s1", "system", "anchor"),
      mk("u1", "user", "hi"),
    ];
    const { anchors, evicted, recent } = partitionForCompaction(messages, 8);

    expect(evicted).toHaveLength(0);
    expect(anchors.map((m) => m.id)).toEqual(["s1"]);
    expect(recent.map((m) => m.id)).toEqual(["u1"]);
  });

  it("handles a history with no system anchors", () => {
    const messages: ChatMessage[] = [
      mk("u1", "user", "a"),
      mk("u2", "user", "b"),
      mk("u3", "user", "c"),
    ];
    const { anchors, evicted, recent } = partitionForCompaction(messages, 1);
    expect(anchors).toHaveLength(0);
    expect(evicted.map((m) => m.id)).toEqual(["u1", "u2"]);
    expect(recent.map((m) => m.id)).toEqual(["u3"]);
  });
});

describe("shouldSummarizeEviction (audit fix #3 — gate the extra LLM summary)", () => {
  it("skips the summary for a small eviction (verbatim already suffices)", () => {
    expect(shouldSummarizeEviction(0)).toBe(false);
    expect(shouldSummarizeEviction(SUMMARY_MIN_EVICTED_TOKENS - 1)).toBe(false);
  });
  it("summarizes a substantial eviction (a dense paraphrase actually compresses)", () => {
    expect(shouldSummarizeEviction(SUMMARY_MIN_EVICTED_TOKENS)).toBe(true);
    expect(shouldSummarizeEviction(SUMMARY_MIN_EVICTED_TOKENS * 5)).toBe(true);
  });
});

describe("formatVerbatimArchive (Sprint A4 — exact strings survive compaction)", () => {
  it("preserves an exact stack trace byte-for-byte, unparaphrased", () => {
    const trace =
      "TypeError: Cannot read properties of undefined (reading 'x')\n    at foo (/src/a.ts:10:5)";
    const messages: ChatMessage[] = [
      mk("u1", "user", "it crashes"),
      mk("a1", "assistant", `The error was:\n${trace}`),
    ];
    const { evicted } = partitionForCompaction(messages, 0);
    const archive = formatVerbatimArchive(evicted);

    // The literal trace survives — NOT an LLM paraphrase.
    expect(archive).toContain(trace);
    expect(archive).toContain("[USER]: it crashes");
    expect(archive).toContain("[ASSISTANT]:");
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
  // and compaction never fired. Fixture is REALISTIC prose (not `"x".repeat`,
  // which BPE compresses ~8× and would mislead the bound) — the real-tokenizer
  // sprint switched estimation to `cl100k_base`.
  it("counts tokens inside an array tool-result, not the array length", () => {
    const bigOutput = "The quick brown fox jumps over the lazy dog. ".repeat(800); // ~36k chars
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
    // Real BPE ≈ 8000 tokens × margin ≈ 9200 — must be in the thousands, NOT ~1.
    expect(estimate).toBeGreaterThan(5000);
  });

  it("counts text + tool-call parts inside an assistant array content", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: [
          { type: "text", text: "Here is a detailed explanation of the algorithm. ".repeat(40) },
          {
            type: "tool-call",
            toolCallId: "c2",
            toolName: "search_web",
            input: { query: "search query about distributed systems and consensus ".repeat(40) },
          },
        ],
      },
    ];
    const estimate = estimateTokenCount(messages as any);
    // text ≈ 361 + query ≈ 281 BPE tokens, × margin — decisively above ~1.
    expect(estimate).toBeGreaterThan(400);
  });

  // Real-tokenizer sprint — round-trips assert the estimate is BPE-ACCURATE
  // (within the safety margin) for non-Latin script + code, not a loose char
  // heuristic. The margin guarantees it never UNDER-counts (overflow risk).
  it("Russian round-trip: BPE-accurate, never under-counts, stays within margin", () => {
    const ru = "Привет! Это пример текста на русском языке для проверки токенизации. ".repeat(10);
    const exact = encode(ru).length;
    const est = estimateTokenCount([{ role: "user", content: ru }] as any);
    expect(est).toBeGreaterThanOrEqual(exact); // margin ⇒ never below real count
    expect(est).toBeLessThanOrEqual(Math.ceil(exact * 1.3)); // and stays close
  });

  it("Code round-trip: BPE-accurate, never under-counts, stays within margin", () => {
    const code = "export function add(a: number, b: number): number {\n  return a + b;\n}\n".repeat(15);
    const exact = encode(code).length;
    const est = estimateTokenCount([{ role: "user", content: code }] as any);
    expect(est).toBeGreaterThanOrEqual(exact);
    expect(est).toBeLessThanOrEqual(Math.ceil(exact * 1.3));
  });

  it("returns 0 for empty / null content without throwing", () => {
    const messages = [
      { role: "assistant" as const, content: [] },
      { role: "user" as const, content: null },
    ];
    expect(estimateTokenCount(messages as any)).toBe(0);
  });
});
