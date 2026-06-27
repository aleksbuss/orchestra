/**
 * PM #81 Sprint 2 — active self-heal for hallucinated tool calls. Pins the
 * circuit-breaker budget and the re-issue generation (delivered / degraded-again
 * / empty / throw), driving the REAL generateText with a MockLanguageModelV3.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { ModelMessage, ToolSet } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import type { AppSettings } from "@/lib/types";
import {
  recordReissueAttempt,
  resetReissueBudget,
  attemptToolReissue,
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

  it("returns null (never throws) when the model errors", async () => {
    const res = await attemptToolReissue({ ...baseArgs, model: modelThrowing() as never });
    expect(res).toBeNull();
  });
});
