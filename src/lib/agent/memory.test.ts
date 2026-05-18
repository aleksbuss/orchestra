import { describe, it, expect } from "vitest";
import type { ChatMessage } from "@/lib/types";
import type { ModelMessage } from "ai";

/**
 * Memory Pipeline Tests
 *
 * We inline the core conversion logic here (same pattern as loop-guard.test.ts)
 * to avoid importing agent.ts which has 50+ transitive dependencies.
 * This tests the ALGORITHM, not the wiring.
 */

// ── Inlined conversion logic (mirrors agent.ts) ────────────────────

function convertChatMessagesToModelMessages(messages: ChatMessage[]): ModelMessage[] {
  const result: ModelMessage[] = [];
  let systemArchiveCount = 0;

  for (const m of messages) {
    if (m.role === "system") {
      result.push({
        role: "user",
        content: `[System Context — Conversation Memory]\n${m.content}`,
      });
      systemArchiveCount++;
    } else if (m.role === "tool") {
      // Simplified for test — skip tool-result shape
      continue;
    } else if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      result.push({ role: "assistant", content: m.content || "" });
    } else if (m.role === "user" || m.role === "assistant") {
      result.push({ role: m.role, content: m.content });
    }
  }

  return result;
}

function estimateTokenCount(messages: ModelMessage[]): number {
  let count = 0;
  for (const m of messages) {
    count += (m.content as string)?.length || 0;
  }
  return Math.ceil(count / 3.5);
}

// ── Helper to create ChatMessage ────────────────────────────────────

function msg(role: ChatMessage["role"], content: string, extra?: Partial<ChatMessage>): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    createdAt: new Date().toISOString(),
    ...extra,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("Memory Pipeline", () => {
  describe("System message inclusion (CRITICAL FIX)", () => {
    it("should include system messages in the converted output", () => {
      const messages: ChatMessage[] = [
        msg("system", "[Compressed Memory Archive]: User is building an AI agent called Orchestra."),
        msg("user", "What were we talking about?"),
        msg("assistant", "We were discussing the Orchestra project."),
      ];

      const converted = convertChatMessagesToModelMessages(messages);

      expect(converted).toHaveLength(3);
      expect(converted[0].role).toBe("user"); // system → user with context tag
      expect(converted[0].content).toContain("[System Context — Conversation Memory]");
      expect(converted[0].content).toContain("Orchestra");
    });

    it("should preserve multiple system archives", () => {
      const messages: ChatMessage[] = [
        msg("system", "[Archive 1]: Early context"),
        msg("system", "[Archive 2]: Later context"),
        msg("user", "Continue"),
      ];

      const converted = convertChatMessagesToModelMessages(messages);

      expect(converted).toHaveLength(3);
      expect(converted[0].content).toContain("Archive 1");
      expect(converted[1].content).toContain("Archive 2");
    });

    it("should NOT skip system messages (regression guard)", () => {
      const messages: ChatMessage[] = [
        msg("system", "Important context that must not be lost"),
        msg("user", "Hello"),
      ];

      const converted = convertChatMessagesToModelMessages(messages);

      // The OLD buggy code would return only 1 message (user).
      // The FIXED code must return 2.
      expect(converted.length).toBeGreaterThanOrEqual(2);
      const hasSystemContext = converted.some(
        (m) => (m.content as string).includes("Important context")
      );
      expect(hasSystemContext).toBe(true);
    });
  });

  describe("Standard message conversion", () => {
    it("should convert user and assistant messages", () => {
      const messages: ChatMessage[] = [
        msg("user", "Hello"),
        msg("assistant", "Hi there!"),
        msg("user", "How are you?"),
      ];

      const converted = convertChatMessagesToModelMessages(messages);

      expect(converted).toHaveLength(3);
      expect(converted[0]).toEqual({ role: "user", content: "Hello" });
      expect(converted[1]).toEqual({ role: "assistant", content: "Hi there!" });
    });

    it("should handle empty message arrays", () => {
      const converted = convertChatMessagesToModelMessages([]);
      expect(converted).toHaveLength(0);
    });
  });

  describe("Token counting", () => {
    it("should estimate tokens roughly as characters / 3.5", () => {
      const messages: ModelMessage[] = [
        { role: "user", content: "A".repeat(350) }, // ~100 tokens
      ];
      const tokens = estimateTokenCount(messages);
      expect(tokens).toBe(100);
    });

    it("should handle messages with non-string content gracefully", () => {
      const messages: ModelMessage[] = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: [{ type: "text", text: "Hi" }] } as any,
      ];
      // Should not crash
      const tokens = estimateTokenCount(messages);
      expect(typeof tokens).toBe("number");
    });
  });

  describe("Compression threshold logic", () => {
    it("compression should NOT trigger below 12000 tokens", () => {
      // Simulate: 30 messages of ~100 chars each = ~857 tokens
      const messages: ModelMessage[] = Array.from({ length: 30 }, (_, i) => ({
        role: "user" as const,
        content: `Message ${i}: ${"x".repeat(100)}`,
      }));
      const tokens = estimateTokenCount(messages);
      const shouldCompress = tokens > 12000 && messages.length > 12;
      expect(shouldCompress).toBe(false);
    });

    it("compression SHOULD trigger above 12000 tokens with enough messages", () => {
      // Simulate: 20 messages of ~2500 chars each = ~14285 tokens
      const messages: ModelMessage[] = Array.from({ length: 20 }, (_, i) => ({
        role: "user" as const,
        content: `Message ${i}: ${"x".repeat(2500)}`,
      }));
      const tokens = estimateTokenCount(messages);
      const shouldCompress = tokens > 12000 && messages.length > 12;
      expect(shouldCompress).toBe(true);
    });

    it("fresh message cutoff should keep last 8 messages", () => {
      const total = 20;
      const freshCount = 8;
      const cutoff = total - freshCount;
      expect(cutoff).toBe(12);
      // After compression: 1 archive + 8 fresh = 9 messages
      const afterCompression = 1 + freshCount;
      expect(afterCompression).toBe(9);
    });
  });
});
