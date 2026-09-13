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
  recoverMissingToolCall,
  type ReissueTelemetrySource,
  buildReissueMessages,
  recordChatDegradation,
  isChatDegraded,
  resetChatDegradation,
  REISSUE_CORRECTION,
  DROP_REISSUE_CORRECTION,
} from "./agent-tool-reissue";
import { estimateTokenCount } from "@/lib/agent/compressor";

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

describe("PM #97 (Layer 2) — correction param selects the injected correction", () => {
  beforeEach(() => resetReissueBudget());

  function captureCorrectionModel(captured: { text?: string }) {
    return new MockLanguageModelV3({
      doGenerate: async ({ prompt }) => {
        // The injected correction is the LAST user message before generation.
        const msgs = prompt as Array<{ role: string; content: unknown }>;
        const lastUser = [...msgs].reverse().find((m) => m.role === "user");
        const c = lastUser?.content;
        captured.text = typeof c === "string"
          ? c
          : Array.isArray(c)
            ? c.map((p) => (p && typeof p === "object" && "text" in p ? (p as { text: string }).text : "")).join("")
            : "";
        return genResult("re-issued fine.");
      },
    });
  }

  it("defaults to the printed-markup REISSUE_CORRECTION when omitted", async () => {
    const captured: { text?: string } = {};
    await attemptToolReissue({ ...baseArgs, model: captureCorrectionModel(captured) as never });
    expect(captured.text).toBe(REISSUE_CORRECTION);
    expect(captured.text).toContain("PRINTED a tool call");
  });

  it("injects DROP_REISSUE_CORRECTION for the Layer-2 dropped-call case", async () => {
    const captured: { text?: string } = {};
    await attemptToolReissue({
      ...baseArgs,
      correction: DROP_REISSUE_CORRECTION,
      model: captureCorrectionModel(captured) as never,
    });
    expect(captured.text).toBe(DROP_REISSUE_CORRECTION);
    expect(captured.text).toContain("lost in transit");
    expect(captured.text).not.toContain("PRINTED a tool call"); // NOT the wrong correction
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


/**
 * `mergeConsecutiveSameRole` folds the correction into a preceding user turn, so
 * the assertion is "the last message is a user turn ENDING in the correction",
 * not "the last message IS the correction".
 */
function expectCorrectionLast(messages: ModelMessage[]): void {
  const last = messages.at(-1);
  expect(last?.role).toBe("user");
  const text =
    typeof last?.content === "string"
      ? last.content
      : JSON.stringify(last?.content ?? "");
  expect(text.trimEnd().endsWith("CORRECTION")).toBe(true);
}

describe("PM #109 — buildReissueMessages (the retry runs at a SHORT context)", () => {
  const big = (n: number) => "x".repeat(n);

  it("leaves a small payload untouched, correction last", () => {
    const base: ModelMessage[] = [{ role: "user", content: "task" }];
    const prior: ModelMessage[] = [{ role: "assistant", content: "printed markup" }];
    const { messages, compactedFrom } = buildReissueMessages(base, prior, "CORRECTION");
    expect(compactedFrom).toBeUndefined();
    expectCorrectionLast(messages);
  });

  it("prunes an oversized payload below budget and KEEPS the correction last", () => {
    // The live failure: the re-issue replayed the whole failing context to the
    // same model, which is a retry under the conditions that just failed.
    const base: ModelMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "the original task" },
    ];
    const prior: ModelMessage[] = Array.from({ length: 12 }, (_, i) => ({
      role: "assistant" as const,
      content: `${i} ${big(4000)}`,
    }));
    const budget = 2000;
    const { messages, compactedFrom } = buildReissueMessages(
      base,
      prior,
      "CORRECTION",
      budget
    );
    expect(compactedFrom).toBeGreaterThan(budget);
    expect(estimateTokenCount(messages)).toBeLessThanOrEqual(compactedFrom!);
    // The correction is the whole point of the call — it must survive pruning.
    expectCorrectionLast(messages);
    // Never pruned to nothing.
    expect(messages.length).toBeGreaterThan(0);
  });

  it("never opens on an orphaned tool result (pair-safety)", () => {
    const base: ModelMessage[] = [{ role: "user", content: "task" }];
    const prior: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "t1", toolName: "read_text_file", input: {} },
        ],
      } as unknown as ModelMessage,
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "t1",
            toolName: "read_text_file",
            output: big(40000),
          },
        ],
      } as unknown as ModelMessage,
    ];
    const { messages } = buildReissueMessages(base, prior, "CORRECTION", 1500);
    expect(messages[0]?.role).not.toBe("tool");
    expectCorrectionLast(messages);
  });
});

/**
 * PM #81 + PM #97 — `recoverMissingToolCall`, both layers, driven DIRECTLY.
 *
 * While this lived inside `runAgent`'s `onFinish` closure the ONLY way to reach
 * it was the full streamText integration harness, and that harness exercises one
 * happy path. The branches below — budget exhausted, loop-abort suppression,
 * layer exclusivity, plain-chat — had no test at all. That is what the
 * extraction bought; the line count is incidental.
 */
const MARKUP =
  '<tool_call>{"name":"write_text_file","arguments":{"file_path":"a.py","content":"x"}}</tool_call>';
/** A dropped native call usually leaves a short prose PREAMBLE, never markup. */
const PREAMBLE = "Начинаю работу над файлом 🚀";

const assistant = (text: string): ModelMessage => ({ role: "assistant", content: text });

type RecoveryArgs = Parameters<typeof recoverMissingToolCall>[0];

function recoveryArgs(over: Partial<RecoveryArgs> = {}): RecoveryArgs {
  return {
    rawResponseMessages: [assistant("All done.")],
    finishReason: "stop",
    useTools: true,
    stepLimitReached: false,
    loopAbortReached: false,
    telemetrySource: {} as ReissueTelemetrySource,
    baseMessages: [{ role: "user", content: "write a.py" }],
    model: modelReturning("Re-issued and done.") as never,
    systemPrompt: "sys",
    tools: {} as ToolSet,
    providerOptions: undefined,
    prepareStep: undefined,
    settings,
    chatId: "recovery-chat",
    provider: "openrouter",
    modelId: "qwen/qwen3-coder",
    ...over,
  };
}

/** Flatten every message to searchable text, whatever part shape it uses. */
function allText(messages: ModelMessage[]): string {
  return JSON.stringify(messages);
}

describe("PM #81 + #97 — recoverMissingToolCall", () => {
  beforeEach(() => resetReissueBudget());

  it("passes a clean turn straight through — same array, nothing spent", async () => {
    const args = recoveryArgs();
    const out = await recoverMissingToolCall(args);
    // Identity, not just equality: the overwhelmingly common path must not
    // rebuild the message array.
    expect(out.responseMessages).toBe(args.rawResponseMessages);
    expect(out.reissueUsage).toBeUndefined();
    // The budget is untouched, so the NEXT real degradation gets both attempts.
    expect(recordReissueAttempt("recovery-chat").count).toBe(1);
  });

  it("never fires layer 1 in plain-chat mode — there is no tool to re-issue with", async () => {
    const args = recoveryArgs({
      useTools: false,
      rawResponseMessages: [assistant(MARKUP)],
    });
    const out = await recoverMissingToolCall(args);
    expect(out.responseMessages).toBe(args.rawResponseMessages);
    expect(recordReissueAttempt("recovery-chat").count).toBe(1);
  });

  it("treats a step-cap pause as a pause, not a hallucination", async () => {
    const args = recoveryArgs({
      stepLimitReached: true,
      rawResponseMessages: [assistant(MARKUP)],
    });
    const out = await recoverMissingToolCall(args);
    expect(out.responseMessages).toBe(args.rawResponseMessages);
    expect(recordReissueAttempt("recovery-chat").count).toBe(1);
  });

  it("layer 1: STRIPS the printed markup and appends the re-issue's messages", async () => {
    const out = await recoverMissingToolCall(
      recoveryArgs({ rawResponseMessages: [assistant(MARKUP)] })
    );
    expect(allText(out.responseMessages)).not.toContain("tool_call");
    expect(allText(out.responseMessages)).toContain("Re-issued and done.");
    expect(out.reissueUsage).toBeDefined();
  });

  it("layer 1: strips the markup even when the BUDGET IS EXHAUSTED", async () => {
    // The circuit breaker stops the re-prompt, never the suppression — a user
    // who has already burned both attempts must still not be shown raw XML.
    recordReissueAttempt("recovery-chat");
    recordReissueAttempt("recovery-chat");
    const out = await recoverMissingToolCall(
      recoveryArgs({ rawResponseMessages: [assistant(MARKUP)] })
    );
    expect(out.responseMessages).toEqual([]);
    expect(out.reissueUsage).toBeUndefined();
  });

  it("layer 1: a DELIVERED re-issue RESETS the budget for later turns", async () => {
    // Without the reset a chat that self-heals twice would arrive at its third
    // real degradation with the breaker already open. Found by a surviving
    // mutant: deleting the reset left all nine other tests green.
    recordReissueAttempt("recovery-chat"); // one already spent this chat
    await recoverMissingToolCall(
      recoveryArgs({ rawResponseMessages: [assistant(MARKUP)] })
    );
    expect(recordReissueAttempt("recovery-chat").count).toBe(1);
  });

  it("layer 1: drops ONLY the markup message, not the turn before it", async () => {
    // The single-message case cannot tell "strip the trailing markup" apart from
    // "discard everything" — both produce []. Two messages can.
    const out = await recoverMissingToolCall(
      recoveryArgs({
        rawResponseMessages: [assistant("Reading the file now."), assistant(MARKUP)],
      })
    );
    expect(allText(out.responseMessages)).toContain("Reading the file now.");
    expect(allText(out.responseMessages)).not.toContain("tool_call");
    expect(allText(out.responseMessages)).toContain("Re-issued and done.");
  });

  it("layer 2: re-issues a DROPPED native call and KEEPS the preamble", async () => {
    const out = await recoverMissingToolCall(
      recoveryArgs({
        finishReason: "tool-calls",
        rawResponseMessages: [assistant(PREAMBLE)],
      })
    );
    expect(allText(out.responseMessages)).toContain(PREAMBLE);
    expect(allText(out.responseMessages)).toContain("Re-issued and done.");
    expect(out.reissueUsage).toBeDefined();
  });

  it("layer 2: a LOOP-ABORT is a stop reason, not a dropped call", async () => {
    const args = recoveryArgs({
      finishReason: "tool-calls",
      loopAbortReached: true,
      rawResponseMessages: [assistant(PREAMBLE)],
    });
    const out = await recoverMissingToolCall(args);
    expect(out.responseMessages).toBe(args.rawResponseMessages);
    expect(out.reissueUsage).toBeUndefined();
    expect(recordReissueAttempt("recovery-chat").count).toBe(1);
  });

  it("layer 2 never fires after layer 1 — one degradation spends ONE attempt", async () => {
    // A re-issue that degrades into markup AGAIN returns null, so the budget is
    // NOT reset: the count it leaves behind is the honest measure of how many
    // attempts ran. Two would mean the layers double-charged the same turn.
    const out = await recoverMissingToolCall(
      recoveryArgs({
        finishReason: "tool-calls",
        rawResponseMessages: [assistant(MARKUP)],
        model: modelReturning(MARKUP) as never,
      })
    );
    expect(recordReissueAttempt("recovery-chat").count).toBe(2);
    expect(out.responseMessages).toEqual([]);
    expect(out.reissueUsage).toBeUndefined();
  });

  it("both layers draw on the SAME budget", async () => {
    recordReissueAttempt("recovery-chat");
    recordReissueAttempt("recovery-chat");
    const args = recoveryArgs({
      finishReason: "tool-calls",
      rawResponseMessages: [assistant(PREAMBLE)],
    });
    const out = await recoverMissingToolCall(args);
    expect(out.responseMessages).toBe(args.rawResponseMessages);
    expect(out.reissueUsage).toBeUndefined();
  });
});
