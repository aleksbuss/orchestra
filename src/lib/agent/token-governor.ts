import { pruneMessages, type ModelMessage, type PrepareStepFunction } from "ai";
import { estimateTokenCount } from "@/lib/agent/compressor";

/**
 * Sprint A3 — in-flight token governor.
 *
 * Pre-flight compaction (Sprint A1/A2, `agent.ts`) runs ONCE before the turn,
 * but the AI SDK tool loop (`stopWhen: stepCountIs(n)`) balloons the payload
 * DURING execution as tool results accrete — there is no token check between
 * steps, which is the actual mechanism behind mid-loop context overflow.
 *
 * This wires the SDK-native `prepareStep` hook (ai v6): it measures the messages
 * about to be sent on EACH step and, when they exceed the model's real budget,
 * prunes them. Pruning is pair-safe — it uses the SDK's own `pruneMessages`,
 * which drops old tool-call/result CONTENT together by `toolCallId`, before
 * falling back to a recency window. Combined with the per-tool output cap in
 * `applyGlobalToolLoopGuard`, a single huge result can't overflow in one step
 * and a long tool loop can't accrete past the window across steps.
 *
 * It is a no-op when the payload is under budget (returns `{}`), so it is safe
 * to attach to every tool-loop callsite, single-step or multi-step.
 */

/** Never prune below this many tokens — a degenerate budget shouldn't empty the turn. */
const ABSOLUTE_MIN_BUDGET = 1000;

/** Never reserve more than this fraction of the window for the model's output. */
const MAX_OUTPUT_RESERVE_RATIO = 0.3;

/** Recent messages whose tool-call/result content is always preserved. */
const KEEP_RECENT_TOOL_WINDOW = "before-last-2-messages" as const;

/**
 * Token budget for the INPUT side of a step = window minus headroom for the
 * model's own response. The output reserve is clamped to 30% of the window so a
 * misconfigured `maxOutputTokens` can't drive the budget to zero on a small
 * (e.g. 4096) window.
 */
export function computeGovernorBudget(
  contextWindow: number,
  reservedOutputTokens: number
): number {
  const reserve = Math.min(
    Math.max(0, reservedOutputTokens),
    Math.floor(contextWindow * MAX_OUTPUT_RESERVE_RATIO)
  );
  return Math.max(ABSOLUTE_MIN_BUDGET, contextWindow - reserve);
}

/**
 * Build a `prepareStep` function that keeps each step's payload within the
 * model's real context budget.
 */
export function createTokenGovernor(opts: {
  contextWindow: number;
  reservedOutputTokens: number;
}): PrepareStepFunction {
  const budget = computeGovernorBudget(opts.contextWindow, opts.reservedOutputTokens);
  return ({ messages }) => {
    if (estimateTokenCount(messages) <= budget) return {};
    return { messages: governMessages(messages, budget) };
  };
}

/**
 * Prune a message array toward `budget` tokens, least-destructive first.
 * Exported for direct unit testing.
 */
export function governMessages(messages: ModelMessage[], budget: number): ModelMessage[] {
  // Stage 1 — drop OLD tool-call/result content (pair-safe via toolCallId),
  // keeping the last two messages' tool context. This alone handles the
  // dominant case: a long loop whose old tool results dwarf everything else.
  const stage1 = pruneMessages({
    messages,
    toolCalls: KEEP_RECENT_TOOL_WINDOW,
    emptyMessages: "remove",
  });
  if (estimateTokenCount(stage1) <= budget) return stage1;

  // Stage 2 — still over budget (e.g. a huge pasted user message + recent
  // context). Keep the smallest recent suffix that fits; never return empty,
  // and never begin on an orphaned tool-result whose tool-call we just dropped.
  return slideToRecentWindow(stage1, budget);
}

function slideToRecentWindow(messages: ModelMessage[], budget: number): ModelMessage[] {
  let start = 0;
  while (
    start < messages.length - 1 &&
    estimateTokenCount(messages.slice(start)) > budget
  ) {
    start++;
  }
  // Don't start on a tool-result — providers reject a tool result with no
  // preceding tool call, and Stage 1 may have dropped that call.
  while (start < messages.length - 1 && messages[start]?.role === "tool") {
    start++;
  }
  return messages.slice(start);
}

/**
 * Sprint A3 — per-tool output cap. A single tool result (e.g. `cat huge_file`,
 * a 200 KB web page) can overflow the context window in ONE step, which the
 * cross-step governor above cannot prevent because the current result must be
 * shown. We keep the head + tail (errors cluster at both ends) and mark the
 * gap, so the model sees it was truncated and can re-query a narrower slice.
 * Only STRING outputs are capped — structured tool results pass through
 * untouched to avoid corrupting a shape the agent parses.
 */
const MAX_TOOL_RESULT_CHARS = 24000; // ~6800 tokens; beyond this a result is a dump, not signal
const TOOL_RESULT_HEAD_CHARS = 16000;
const TOOL_RESULT_TAIL_CHARS = 4000;

export function capToolResultSize(output: unknown): unknown {
  if (typeof output !== "string" || output.length <= MAX_TOOL_RESULT_CHARS) {
    return output;
  }
  const head = output.slice(0, TOOL_RESULT_HEAD_CHARS);
  const tail = output.slice(-TOOL_RESULT_TAIL_CHARS);
  const omitted = output.length - head.length - tail.length;
  return (
    `${head}\n\n` +
    `[Orchestra truncated this tool result: ${omitted} characters omitted to protect ` +
    `the context window. Re-run with a narrower query — grep, a line range, or pagination ` +
    `— to see a specific section.]\n\n` +
    `${tail}`
  );
}
