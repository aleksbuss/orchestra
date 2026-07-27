/**
 * Loop-abort integration test (2026-07-28, DoubleTake-reviewed).
 *
 * The unit tests prove the PURE logic (`countTrailingLoopBlockSteps`, the
 * resolveTurnContinuation pause). This closes the one remaining gap they cannot:
 * that the AI SDK actually INVOKES the `loopAbortStop` stopWhen predicate after
 * each step and HONORS its `true` return to halt the tool loop early — the same
 * class of gap PM #65 hid in (a stopWhen that silently did nothing).
 *
 * It drives the REAL `generateText` (no "ai" mock) with:
 *   - a mock model that compulsively re-emits the IDENTICAL tool call every step
 *     (the weak-model spiral: it never delivers, never varies its args),
 *   - the REAL `applyGlobalToolLoopGuard` (so the 3rd+ identical call is BLOCKED
 *     with the shared LOOP_GUARD_REPEAT_MARKER),
 *   - the ACTUAL `loopAbortStop` predicate rebuilt from the exported helper.
 *
 * Asserts the loop halts in a handful of steps (loop-abort), NOT at the 50-step
 * cap — and, as the control, that WITHOUT the predicate the same spiral runs to
 * the cap. If a refactor drops `loopAbortStop` from a `stopWhen` array, the
 * control-vs-abort contrast fails here where a pure-function test would not.
 */
import { describe, it, expect } from "vitest";
import { generateText, stepCountIs, tool, type ToolSet } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { z } from "zod";
import { applyGlobalToolLoopGuard } from "./tool-guard";
import { countTrailingLoopBlockSteps, LOOP_ABORT_CONSECUTIVE } from "./agent-response";

function gen(content: unknown[], finishReason: string): LanguageModelV3GenerateResult {
  const usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 10, text: 10, reasoning: 0 },
    totalTokens: 20,
  };
  return { content, finishReason, usage, warnings: [] } as unknown as LanguageModelV3GenerateResult;
}

/** A model stuck in a spiral: it emits the SAME tool call with IDENTICAL args, forever. */
function makeSpiralingModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () =>
      gen(
        [
          {
            type: "tool-call",
            toolCallId: `tc-${Math.random().toString(36).slice(2)}`,
            toolName: "check",
            input: JSON.stringify({ what: "same-every-time" }), // IDENTICAL args → guard blocks it
          },
        ],
        "tool-calls"
      ),
  });
}

const checkTool: ToolSet = {
  check: tool({
    description: "Re-run a check.",
    inputSchema: z.object({ what: z.string() }),
    execute: async () => "check passed", // succeeds; the model just won't stop re-running it
  }),
};

// The exact predicate agent.ts wires into every tool-loop `stopWhen`.
const loopAbortStop = (opts: {
  steps: ReadonlyArray<{ toolResults?: ReadonlyArray<{ output?: unknown }> }>;
}): boolean => countTrailingLoopBlockSteps(opts.steps) >= LOOP_ABORT_CONSECUTIVE;

describe("loop-abort integration (real generateText + real loop guard)", () => {
  it("HALTS a spiral early via loopAbortStop — well before the 50-step cap", async () => {
    const result = await generateText({
      model: makeSpiralingModel(),
      messages: [{ role: "user", content: "verify it" }],
      tools: applyGlobalToolLoopGuard(checkTool),
      stopWhen: [stepCountIs(50), loopAbortStop],
    });
    // First 2 identical calls execute; the 3rd/4th/5th are guard-blocked; at the
    // 3rd consecutive block loopAbortStop fires. So it stops in a handful of
    // steps, an order of magnitude under the 50-step cap.
    expect(result.steps.length).toBeGreaterThan(LOOP_ABORT_CONSECUTIVE); // some real work happened
    expect(result.steps.length).toBeLessThan(12); // ...but nowhere near the cap
  });

  it("CONTROL: without loopAbortStop the identical spiral runs all the way to the 50-step cap", async () => {
    const result = await generateText({
      model: makeSpiralingModel(),
      messages: [{ role: "user", content: "verify it" }],
      tools: applyGlobalToolLoopGuard(checkTool),
      stopWhen: stepCountIs(50), // the pre-fix behaviour: only the global cap bounds it
    });
    // Proves the early halt above is DUE TO loopAbortStop, not something else.
    expect(result.steps.length).toBe(50);
  });
});
