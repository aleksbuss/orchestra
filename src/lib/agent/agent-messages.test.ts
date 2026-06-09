/**
 * §10 phase 2 extracted conversion helpers. These run on EVERY turn — loading
 * history into the model prompt and persisting the model's output back to the
 * chat — so a silent bug here corrupts chats or drops tool context. The pre-
 * extraction code had no direct coverage; this is the regression guard.
 */
import { describe, it, expect } from "vitest";
import type { ChatMessage } from "@/lib/types";
import type { ModelMessage } from "ai";
import {
  convertChatMessagesToModelMessages,
  convertModelMessageToChatMessages,
} from "./agent-messages";

describe("convertChatMessagesToModelMessages (ChatMessage[] → ModelMessage[])", () => {
  it("forwards a system message as user-role context (memory archives survive)", () => {
    const out = convertChatMessagesToModelMessages([
      { id: "1", role: "system", content: "archived memory", createdAt: "t" },
    ]);
    expect(out).toEqual([
      { role: "user", content: "[System Context — Conversation Memory]\narchived memory" },
    ]);
  });

  it("converts a tool result message (output wrapped as json)", () => {
    const out = convertChatMessagesToModelMessages([
      {
        id: "1",
        role: "tool",
        content: "result",
        createdAt: "t",
        toolCallId: "tc1",
        toolName: "search_web",
        toolResult: { hits: 3 },
      },
    ]);
    expect(out[0].role).toBe("tool");
    const part = (out[0].content as Array<Record<string, unknown>>)[0];
    expect(part).toMatchObject({
      type: "tool-result",
      toolCallId: "tc1",
      toolName: "search_web",
      output: { type: "json", value: { hits: 3 } },
    });
  });

  it("converts an assistant message with tool calls (args → input)", () => {
    const out = convertChatMessagesToModelMessages([
      {
        id: "1",
        role: "assistant",
        content: "let me search",
        createdAt: "t",
        toolCalls: [{ toolCallId: "tc1", toolName: "search_web", args: { q: "x" } }],
      },
    ]);
    const content = out[0].content as Array<Record<string, unknown>>;
    expect(content).toContainEqual({ type: "text", text: "let me search" });
    expect(content).toContainEqual({
      type: "tool-call",
      toolCallId: "tc1",
      toolName: "search_web",
      input: { q: "x" },
    });
  });

  it("passes plain user/assistant messages through unchanged", () => {
    const out = convertChatMessagesToModelMessages([
      { id: "1", role: "user", content: "hi", createdAt: "t" },
      { id: "2", role: "assistant", content: "hello", createdAt: "t" },
    ]);
    expect(out).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });
});

describe("convertModelMessageToChatMessages (ModelMessage → ChatMessage[])", () => {
  const now = "2026-01-01T00:00:00Z";

  it("strips <thinking> from assistant string content", () => {
    const out = convertModelMessageToChatMessages(
      { role: "assistant", content: "<thinking>reason</thinking>The answer." } as ModelMessage,
      now
    );
    expect(out[0].content).toBe("The answer.");
  });

  it("extracts text + tool calls from array content (input → args)", () => {
    const out = convertModelMessageToChatMessages(
      {
        role: "assistant",
        content: [
          { type: "text", text: "ok" },
          { type: "tool-call", toolCallId: "tc1", toolName: "search_web", input: { q: "x" } },
        ],
      } as unknown as ModelMessage,
      now
    );
    expect(out[0].content).toBe("ok");
    expect(out[0].toolCalls).toEqual([
      { toolCallId: "tc1", toolName: "search_web", args: { q: "x" } },
    ]);
  });

  it("converts a tool-result message back into a ChatMessage tool", () => {
    const out = convertModelMessageToChatMessages(
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "tc1", toolName: "search_web", output: { type: "json", value: "results" } },
        ],
      } as unknown as ModelMessage,
      now
    );
    expect(out[0]).toMatchObject({ role: "tool", toolCallId: "tc1", toolName: "search_web" });
  });
});

describe("round-trip ChatMessage → ModelMessage → ChatMessage preserves essentials", () => {
  it("user + assistant text survive a round trip", () => {
    const original: ChatMessage[] = [
      { id: "1", role: "user", content: "question", createdAt: "t" },
      { id: "2", role: "assistant", content: "answer", createdAt: "t" },
    ];
    const model = convertChatMessagesToModelMessages(original);
    const back = model.flatMap((m) => convertModelMessageToChatMessages(m, "t"));
    expect(back.map((m) => ({ role: m.role, content: m.content }))).toEqual([
      { role: "user", content: "question" },
      { role: "assistant", content: "answer" },
    ]);
  });
});
