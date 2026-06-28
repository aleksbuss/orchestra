/**
 * PM #81 Sprint 2 — active self-heal for hallucinated tool calls. Pins the
 * circuit-breaker budget and the re-issue generation (delivered / degraded-again
 * / empty / throw), driving the REAL generateText with a MockLanguageModelV3.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import type { ModelMessage, ToolSet } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import type { AppSettings } from "@/lib/types";
import {
  recordReissueAttempt,
  resetReissueBudget,
  attemptToolReissue,
  recordChatDegradation,
  isChatDegraded,
  resetChatDegradation,
} from "./agent-tool-reissue";

describe("PM #81 — re-issue circuit breaker (recordReissueAttempt)", () => {
  beforeEach(() => resetReissueBudget());

  it("allows up to the per-chat cap, then blocks", () => {
    expect(recordReissueAttempt("c1")).toEqual({ allowed: true, count: 1 });
    expect(recordReissueAttempt("c1")).toEqual({ allowed: true, count: 2 });
    expect(recordReissueAttempt("c1")).toEqual({ allowed: false, count: 3 });
  });

  it("tracks chats independently", () => {
    recordReissueAttempt("a");
    recordReissueAttempt("a");
    recordReissueAttempt("a");
    expect(recordReissueAttempt("b").allowed).toBe(true);
  });

  it("reset clears one chat", () => {
    recordReissueAttempt("c");
    recordReissueAttempt("c");
    resetReissueBudget("c");
    expect(recordReissueAttempt("c")).toEqual({ allowed: true, count: 1 });
  });

  it("missing chatId is always allowed (best-effort)", () => {
    expect(recordReissueAttempt(undefined).allowed).toBe(true);
  });
});

function genResult(text: string): LanguageModelV3GenerateResult {
  return {
    content: text ? [{ type: "text", text }] : [],
    finishReason: "stop",
    usage: { inputTokens: { total: 5 }, outputTokens: { total: 5 } },
    warnings: [],
  } as unknown as LanguageModelV3GenerateResult;
}
const modelReturning = (text: string) =>
  new MockLanguageModelV3({ doGenerate: async () => genResult(text) });
const modelThrowing = () =>
  new MockLanguageModelV3({
    doGenerate: async () => {
      throw new Error("upstream down");
    },
  });

const settings = {
  chatModel: { provider: "openai", model: "gpt-4o", apiKey: "k", temperature: 0.5 },
} as unknown as AppSettings;

const baseArgs = {
  systemPrompt: "sys",
  baseMessages: [{ role: "user", content: "write hello.py" }] as ModelMessage[],
  priorMessages: [
    {
      role: "assistant",
      content:
        '<tool_call>{"name":"write_text_file","arguments":{"file_path":"hello.py","content":"x"}}</tool_call>',
    },
  ] as ModelMessage[],
  tools: {} as ToolSet,
  providerOptions: undefined,
  prepareStep: undefined,
  settings,
};

describe("PM #81 — attemptToolReissue (real generateText + mock model)", () => {
  it("DELIVERS when the model re-issues into a clean answer", async () => {
    const res = await attemptToolReissue({
      ...baseArgs,
      model: modelReturning("Done — hello.py was created.") as never,
    });
    expect(res).not.toBeNull();
    expect(res?.text).toBe("Done — hello.py was created.");
    expect(res?.responseMessages.length).toBeGreaterThan(0);
  });

  it("returns null when the re-issue DEGRADES into markup again", async () => {
    const res = await attemptToolReissue({
      ...baseArgs,
      model: modelReturning(
        '<tool_call>{"name":"write_text_file","arguments":{"file_path":"hello.py","content":"x"}}</tool_call>'
      ) as never,
    });
    expect(res).toBeNull();
  });

  it("returns null on an empty generation", async () => {
    const res = await attemptToolReissue({ ...baseArgs, model: modelReturning("") as never });
    expect(res).toBeNull();
  });

  it("KEEPS a re-issue that executed a tool but produced no final text", async () => {
    // The re-issue NATIVELY calls the tool (the write runs), then stops without
    // any closing text. That executed work must be persisted, not discarded — a
    // defect found in the deep audit: a null here loses the write from history +
    // billing and triggers a redundant forced generation.
    const echo = tool({
      description: "echo",
      inputSchema: z.object({}),
      execute: async () => "ok",
    });
    const model = new MockLanguageModelV3({
      doGenerate: async ({ prompt }) => {
        const sawToolResult = (prompt as Array<{ role: string }>).some((m) => m.role === "tool");
        return {
          content: sawToolResult
            ? [] // executed the tool, emits NO final text
            : [{ type: "tool-call", toolCallId: "e1", toolName: "echo", input: JSON.stringify({}) }],
          finishReason: sawToolResult ? "stop" : "tool-calls",
          usage: { inputTokens: { total: 5 }, outputTokens: { total: 5 } },
          warnings: [],
        } as unknown as LanguageModelV3GenerateResult;
      },
    });
    const res = await attemptToolReissue({
      ...baseArgs,
      tools: { echo } as unknown as ToolSet,
      model: model as never,
    });
    expect(res).not.toBeNull();
    expect(res?.text).toBe(""); // no final text …
    expect(res?.responseMessages.some((m) => m.role === "tool")).toBe(true); // … but the tool ran
  });

  it("returns null (never throws) when the model errors", async () => {
    const res = await attemptToolReissue({ ...baseArgs, model: modelThrowing() as never });
    expect(res).toBeNull();
  });
});

describe("PM #82 — degradation signal (recordChatDegradation / isChatDegraded)", () => {
  beforeEach(() => resetChatDegradation());

  it("is false for an unseen chat", () => {
    expect(isChatDegraded("x")).toBe(false);
  });

  it("flags a chat after a printed-as-text tool call", () => {
    recordChatDegradation("x");
    expect(isChatDegraded("x")).toBe(true);
    expect(isChatDegraded("y")).toBe(false);
  });

  it("reset clears one chat, then all", () => {
    recordChatDegradation("a");
    recordChatDegradation("b");
    resetChatDegradation("a");
    expect(isChatDegraded("a")).toBe(false);
    expect(isChatDegraded("b")).toBe(true);
    resetChatDegradation();
    expect(isChatDegraded("b")).toBe(false);
  });

  it("is a no-op for a missing chatId", () => {
    recordChatDegradation(undefined);
    expect(isChatDegraded(undefined)).toBe(false);
  });
});
