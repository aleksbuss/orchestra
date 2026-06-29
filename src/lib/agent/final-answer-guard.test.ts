/**
 * PM #69 — `turnHasDeliverableAnswer` decides whether a turn actually delivered
 * an answer to the user. When it returns false, runAgent's onFinish forces one
 * tool-less final-answer generation so the user always gets a reply (the failure
 * mode: deepseek/OpenRouter returns `finishReason: "other"` after a tool call
 * and never proceeds to a `response`).
 *
 * This pins the DECISION: a `response` tool call/result or real assistant text
 * counts as delivered; a turn that ends with only a non-response tool call, a
 * `<thinking>`-only block, or nothing at all does NOT.
 */
import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import type { AppSettings } from "@/lib/types";
import { turnHasDeliverableAnswer, resolveTurnContinuation } from "./agent";
import { detectPrematureCompletion } from "./agent-response";

const responseToolCall = (message: string): ModelMessage => ({
  role: "assistant",
  content: [
    { type: "tool-call", toolCallId: "r1", toolName: "response", input: { message } },
  ],
}) as unknown as ModelMessage;

const responseToolResult = (message: string): ModelMessage => ({
  role: "tool",
  content: [
    { type: "tool-result", toolCallId: "r1", toolName: "response", output: message },
  ],
}) as unknown as ModelMessage;

const searchToolCall = (): ModelMessage => ({
  role: "assistant",
  content: [
    { type: "tool-call", toolCallId: "s1", toolName: "search_web", input: { query: "x" } },
  ],
}) as unknown as ModelMessage;

const searchToolResult = (): ModelMessage => ({
  role: "tool",
  content: [
    { type: "tool-result", toolCallId: "s1", toolName: "search_web", output: "results" },
  ],
}) as unknown as ModelMessage;

const assistantText = (text: string): ModelMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
}) as unknown as ModelMessage;

describe("PM #69 — turnHasDeliverableAnswer", () => {
  it("DELIVERED: a `response` tool call carries the answer", () => {
    expect(turnHasDeliverableAnswer([responseToolCall("Here is the answer.")])).toBe(true);
  });

  it("DELIVERED: a `response` tool result carries the answer", () => {
    expect(turnHasDeliverableAnswer([responseToolResult("Here is the answer.")])).toBe(true);
  });

  it("DELIVERED: plain assistant text is an answer", () => {
    expect(turnHasDeliverableAnswer([assistantText("React 19.2.7 is the latest.")])).toBe(true);
  });

  it("NOT delivered: the turn ended on a non-response tool call + result (the PM #69 failure)", () => {
    expect(turnHasDeliverableAnswer([searchToolCall(), searchToolResult()])).toBe(false);
  });

  it("NOT delivered: assistant text was only a <thinking> block (stripped to empty)", () => {
    expect(
      turnHasDeliverableAnswer([assistantText("<thinking>Goal: figure it out</thinking>")])
    ).toBe(false);
  });

  it("NOT delivered: no messages at all (model returned nothing)", () => {
    expect(turnHasDeliverableAnswer([])).toBe(false);
  });

  it("DELIVERED: search happened, THEN a response tool delivered (the success path)", () => {
    expect(
      turnHasDeliverableAnswer([
        searchToolCall(),
        searchToolResult(),
        responseToolCall("React 19.2.7, per the search."),
      ])
    ).toBe(true);
  });
});

// ── Integration: resolveTurnContinuation drives the REAL generateText with a
// MockLanguageModelV3, so it exercises the actual force-final-answer code path
// (detector → tool-less generateText → unwrap), not just the decision. ────────
function genResult(text: string): LanguageModelV3GenerateResult {
  return {
    content: [{ type: "text", text }],
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
  chatModel: { provider: "openai", model: "gpt-4o", apiKey: "k" },
} as unknown as AppSettings;
const base = {
  systemPrompt: "sys",
  baseMessages: [{ role: "user", content: "q" }] as ModelMessage[],
  providerOptions: undefined,
  settings,
};

describe("PM #69 — resolveTurnContinuation (real generateText + mock model)", () => {
  it("FORCES a final answer when the turn delivered nothing (the fix, end-to-end)", async () => {
    const res = await resolveTurnContinuation({
      ...base,
      // A valid ModelMessage that delivers nothing (thinking strips to empty) —
      // the detector tests above cover the tool-call/result detection; this
      // drives the FORCE generation through the real generateText.
      responseMessages: [assistantText("<thinking>I'll just stop here</thinking>")],
      finishReason: "other",
      model: modelReturning("FORCED FINAL ANSWER") as never,
    });
    expect(res.text).toBe("FORCED FINAL ANSWER");
    expect(res.uiNotice).toBeUndefined();
  });

  it("does NOT force when a `response` tool already delivered the answer", async () => {
    const res = await resolveTurnContinuation({
      ...base,
      responseMessages: [responseToolCall("already delivered")],
      finishReason: "stop",
      model: modelReturning("SHOULD-NOT-BE-USED") as never,
    });
    expect(res.text).toBe("");
  });

  it("does NOT force when plain assistant text already delivered the answer", async () => {
    const res = await resolveTurnContinuation({
      ...base,
      responseMessages: [assistantText("Here is the answer.")],
      finishReason: "stop",
      model: modelReturning("SHOULD-NOT-BE-USED") as never,
    });
    expect(res.text).toBe("");
  });

  it("continues a truncated reply (finishReason length)", async () => {
    const res = await resolveTurnContinuation({
      ...base,
      responseMessages: [assistantText("A partial answer that got cut off")],
      finishReason: "length",
      model: modelReturning("and the rest of it.") as never,
    });
    expect(res.text).toBe("and the rest of it.");
  });

  // ── Step-cap PAUSE (operator-requested): a turn that exhausts its per-turn
  // step budget without delivering an answer must emit a DETERMINISTIC "press
  // Continue" notice, NOT a forced (masquerading-as-complete) model answer. ────
  it("step-cap PAUSE: no answer + stepLimitReached → deterministic Continue notice, NO model call", async () => {
    const res = await resolveTurnContinuation({
      ...base,
      responseMessages: [searchToolCall(), searchToolResult()], // delivered nothing
      finishReason: "tool-calls",
      stepLimitReached: true,
      model: modelThrowing() as never, // would throw if the forced-answer path ran
    });
    expect(res.text).toContain("Reached the step limit");
    expect(res.text).toContain("Continue");
    expect(res.uiNotice).toContain("per-turn step limit");
  });

  it("step-cap PAUSE does NOT fire when an answer WAS delivered (even at the cap)", async () => {
    const res = await resolveTurnContinuation({
      ...base,
      responseMessages: [responseToolCall("Actually finished.")],
      finishReason: "tool-calls",
      stepLimitReached: true,
      model: modelThrowing() as never,
    });
    expect(res.text).toBe(""); // delivered → no pause, no force
  });

  it("step-cap PAUSE fires even when the model NARRATED before the tool call (PM #82 — the live bug)", async () => {
    // A model that says "Now I understand. Let me fix X" before each tool call
    // leaves non-empty assistant text → turnHasDeliverableAnswer === true, which
    // used to GATE OUT the pause (the pause lived inside !turnHasDeliverableAnswer)
    // → a 50-step turn ended SILENTLY. The hoisted check must still pause: at the
    // cap, narration before an action tool is NOT a delivered answer.
    const messages = [
      assistantText("Now I understand. Let me fix the call to the securityTools method."),
      searchToolCall(),
      searchToolResult(),
    ];
    expect(turnHasDeliverableAnswer(messages)).toBe(true); // narration looks "delivered"…
    const res = await resolveTurnContinuation({
      ...base,
      responseMessages: messages,
      finishReason: "tool-calls",
      stepLimitReached: true,
      model: modelThrowing() as never, // would throw if any LLM path ran
    });
    expect(res.text).toContain("Reached the step limit"); // …yet the pause still fires
    expect(res.uiNotice).toContain("per-turn step limit");
  });

  it("without stepLimitReached, a no-answer turn still FORCES a final answer (PM #69 unchanged)", async () => {
    const res = await resolveTurnContinuation({
      ...base,
      // No-deliverable input that passes the real generateText schema (a
      // <thinking>-only turn strips to empty), so the FORCE path actually runs.
      responseMessages: [assistantText("<thinking>I'll just stop here</thinking>")],
      finishReason: "other",
      stepLimitReached: false,
      model: modelReturning("FORCED ANSWER") as never,
    });
    expect(res.text).toBe("FORCED ANSWER");
  });

  it("PM #81: an action-tool hallucination forces a clean final answer (real wire)", async () => {
    // The model printed a `write_text_file` call as RAW TEXT instead of a native
    // tool call. turnHasDeliverableAnswer must classify this as NO delivery so
    // the continuation regenerates a real answer instead of shipping XML garbage.
    const res = await resolveTurnContinuation({
      ...base,
      responseMessages: [
        assistantText(
          '<tool_call>{"name":"write_text_file","arguments":{"file_path":"a.ts","content":"x"}}</tool_call>'
        ),
      ],
      finishReason: "stop",
      model: modelReturning("Here is the file content you asked for.") as never,
    });
    expect(res.text).toBe("Here is the file content you asked for.");
  });

  it("PM #81: a mis-emitted `response` markup is delivered (NOT regenerated)", async () => {
    const res = await resolveTurnContinuation({
      ...base,
      responseMessages: [
        assistantText('<tool_call>{"name":"response","arguments":{"message":"done"}}</tool_call>'),
      ],
      finishReason: "stop",
      model: modelThrowing() as never, // would throw if a regeneration ran
    });
    expect(res.text).toBe(""); // recoverable → no forced regeneration
  });

  it("on forced-generation failure: empty text + a uiNotice (never throws)", async () => {
    const res = await resolveTurnContinuation({
      ...base,
      responseMessages: [assistantText("<thinking>I'll just stop here</thinking>")],
      finishReason: "other",
      model: modelThrowing() as never,
    });
    expect(res.text).toBe("");
    expect(res.uiNotice).toMatch(/Could not produce a final answer/i);
  });
});

// ── PM #84 — detectPrematureCompletion: deterministic visibility note when the
// model claims "done" via `response` while its OWN last whitelisted check failed.
// Advisory backstop; false-negative-biased (narrow whitelist, last-check-wins,
// fires only on a delivered answer).
const codeExecCall = (id: string, code: string): ModelMessage =>
  ({
    role: "assistant",
    content: [
      { type: "tool-call", toolCallId: id, toolName: "code_execution", input: { runtime: "terminal", code } },
    ],
  }) as unknown as ModelMessage;

// Mirrors formatCommandResult: a NON-zero exit appends "Exit code: N"; a success
// (exit 0) appends NO such line.
const codeExecFail = (id: string, exit: number, stderr = "error"): ModelMessage =>
  ({
    role: "tool",
    content: [
      { type: "tool-result", toolCallId: id, toolName: "code_execution", output: `STDERR:\n${stderr}\n\nExit code: ${exit}` },
    ],
  }) as unknown as ModelMessage;

const codeExecPass = (id: string, stdout = "ok"): ModelMessage =>
  ({
    role: "tool",
    content: [
      { type: "tool-result", toolCallId: id, toolName: "code_execution", output: `STDOUT:\n${stdout}` },
    ],
  }) as unknown as ModelMessage;

describe("PM #84 — detectPrematureCompletion", () => {
  it("FIRES: the live repro — tsc --noEmit exited 2, then a COMPLETED ✅ response", () => {
    const notice = detectPrematureCompletion([
      codeExecCall("c1", "npx tsc --noEmit"),
      codeExecFail("c1", 2, "src/x.ts(1,1): error TS1005: ';' expected."),
      responseToolCall("# Sprint 3 — COMPLETED SUCCESSFULLY ✅"),
    ]);
    expect(notice).toMatch(/Completion check/);
    expect(notice).toMatch(/tsc --noEmit/);
    expect(notice).toMatch(/exited 2/);
  });

  it("FIRES via vitest, jest, pytest, build, eslint", () => {
    const cases: Array<[string, RegExp]> = [
      ["npx vitest run", /vitest/],
      ["npx jest", /jest/],
      ["pytest -q", /pytest/],
      ["npm run build", /build/],
      ["npx eslint .", /eslint/],
    ];
    for (const [cmd, label] of cases) {
      const notice = detectPrematureCompletion([
        codeExecCall("c1", cmd),
        codeExecFail("c1", 1),
        responseToolCall("Done ✅"),
      ]);
      expect(notice, cmd).toMatch(label);
    }
  });

  it("SILENT: the check PASSED (no Exit code line) even with a response", () => {
    expect(
      detectPrematureCompletion([
        codeExecCall("c1", "npx tsc --noEmit"),
        codeExecPass("c1"),
        responseToolCall("All green — done."),
      ])
    ).toBeNull();
  });

  it("SILENT: no `response` answer delivered (gate a) even though tsc failed", () => {
    expect(
      detectPrematureCompletion([codeExecCall("c1", "npx tsc --noEmit"), codeExecFail("c1", 2)])
    ).toBeNull();
  });

  it("SILENT: fix-then-rerun — the LAST tsc passed (earlier failure overridden)", () => {
    expect(
      detectPrematureCompletion([
        codeExecCall("c1", "npx tsc --noEmit"),
        codeExecFail("c1", 2),
        codeExecCall("c2", "npx tsc --noEmit"),
        codeExecPass("c2"),
        responseToolCall("Fixed and verified — done."),
      ])
    ).toBeNull();
  });

  it("FIRES: pass-then-fail — the LAST check failed", () => {
    const notice = detectPrematureCompletion([
      codeExecCall("c1", "npx vitest run"),
      codeExecPass("c1"),
      codeExecCall("c2", "npx vitest run"),
      codeExecFail("c2", 1),
      responseToolCall("Done ✅"),
    ]);
    expect(notice).toMatch(/vitest/);
    expect(notice).toMatch(/exited 1/);
  });

  it("SILENT: a non-whitelisted command failed (grep exits 1 normally)", () => {
    expect(
      detectPrematureCompletion([
        codeExecCall("c1", "grep -r TODO src/"),
        codeExecFail("c1", 1),
        responseToolCall("No TODOs — done."),
      ])
    ).toBeNull();
  });

  it("SILENT: no code_execution at all (pure Q&A answer)", () => {
    expect(detectPrematureCompletion([responseToolCall("React 19.2.7 is the latest.")])).toBeNull();
  });

  it("SILENT: an explicit `Exit code: 0` is not a failure (defensive non-zero guard)", () => {
    expect(
      detectPrematureCompletion([
        codeExecCall("c1", "npm test"),
        {
          role: "tool",
          content: [
            { type: "tool-result", toolCallId: "c1", toolName: "code_execution", output: "STDOUT:\nok\n\nExit code: 0" },
          ],
        } as unknown as ModelMessage,
        responseToolCall("Tests pass — done."),
      ])
    ).toBeNull();
  });
});
