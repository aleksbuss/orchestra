/**
 * PM #65 — integration test for the proposer tool-loop CONTRACT.
 *
 * The MoA unit tests mock `generateText` entirely, so they verify that we pass
 * the right options but NOT that the underlying AI SDK actually loops a
 * tool-using call to a final text answer. That gap is exactly how PM #65 hid:
 * `maxSteps` was a silently-ignored no-op, the default `stepCountIs(1)` kicked
 * in, and a tool proposer stopped after emitting the tool call with empty text.
 *
 * This test drives the REAL `generateText` (no "ai" mock) with a real tool and
 * a `MockLanguageModelV3` scripted to behave like a tool-using proposer:
 *   step 1 → emit a tool call
 *   step 2 (after the tool result) → emit the final text answer
 *
 * It pins both directions: `stepCountIs(3)` (what moa.ts now uses) completes the
 * loop and returns text; `stepCountIs(1)` (the PM #65 failure condition) stops
 * after the tool call and returns empty text. If a future refactor regresses the
 * proposer `stopWhen`, this fails where the param-level unit test might not.
 */
import { describe, it, expect } from "vitest";
import { generateText, stepCountIs, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { z } from "zod";

// The V3 generate-result shape (finishReason is an object union, usage is
// deeply nested) is richer than this behavioural test needs — and the tool
// LOOP is driven by tool-call CONTENT, not by finishReason. Build a minimal
// result and contain the single cast here.
function gen(content: unknown[], finishReason: string): LanguageModelV3GenerateResult {
  const usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 10, text: 10, reasoning: 0 },
    totalTokens: 20,
  };
  return { content, finishReason, usage, warnings: [] } as unknown as LanguageModelV3GenerateResult;
}

/**
 * A model that behaves like a proposer with a tool: first turn it calls the
 * tool, and once it sees a tool result in the prompt it produces the answer.
 */
function makeToolUsingModel(answer: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async ({ prompt }) => {
      const sawToolResult = (prompt as Array<{ role: string }>).some(
        (m) => m.role === "tool"
      );
      if (!sawToolResult) {
        return gen(
          [
            {
              type: "tool-call",
              toolCallId: "tc-1",
              toolName: "search_web",
              input: JSON.stringify({ query: "anything" }),
            },
          ],
          "tool-calls"
        );
      }
      return gen([{ type: "text", text: answer }], "stop");
    },
  });
}

const searchWebTool = tool({
  description: "Search the web.",
  inputSchema: z.object({ query: z.string() }),
  execute: async () => "stubbed search results",
});

describe("PM #65 — proposer tool-loop contract (real generateText + MockLanguageModelV3)", () => {
  it("stopWhen: stepCountIs(3) — a tool-using proposer completes the loop and returns the final text", async () => {
    const result = await generateText({
      model: makeToolUsingModel("FINAL-ANSWER-AFTER-TOOL"),
      messages: [{ role: "user", content: "do the thing" }],
      tools: { search_web: searchWebTool },
      // The exact value moa.ts passes for a tool-equipped proposer.
      stopWhen: stepCountIs(3),
    });

    // The loop ran tool-call → tool-result → final generation.
    expect(result.text).toBe("FINAL-ANSWER-AFTER-TOOL");
    expect(result.steps.length).toBeGreaterThanOrEqual(2);
  });

  it("stopWhen: stepCountIs(1) — the PM #65 failure condition: stops after the tool call with EMPTY text", async () => {
    const result = await generateText({
      model: makeToolUsingModel("UNREACHED-ANSWER"),
      messages: [{ role: "user", content: "do the thing" }],
      tools: { search_web: searchWebTool },
      // The (former, broken) effective behavior: only one step.
      stopWhen: stepCountIs(1),
    });

    // Step 1 emitted only the tool call → no assistant text → "(empty draft)"
    // in moa.ts → isSuccessfulDraft drops it. This is the bug, pinned.
    expect(result.text).toBe("");
    expect(result.steps.length).toBe(1);
  });

  it("a tool-LESS proposer returns its text in a single step (stepCountIs(1) is correct there)", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => gen([{ type: "text", text: "DIRECT-DRAFT" }], "stop"),
    });
    const result = await generateText({
      model,
      messages: [{ role: "user", content: "draft this" }],
      stopWhen: stepCountIs(1),
    });
    expect(result.text).toBe("DIRECT-DRAFT");
  });
});
