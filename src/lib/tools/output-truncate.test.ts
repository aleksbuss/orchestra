/**
 * Tests for `truncateToolOutputForHistory` — the head+tail truncator that
 * caps how much of a tool result lands in the persistent chat JSON.
 *
 * Why this is load-bearing: the autoresearch loop in production used to
 * persist 50 KB tool outputs per iteration verbatim. The chat file
 * ballooned, the UI froze, every subsequent turn re-fed the bloat back
 * into the model. This function is the only thing between us and that
 * regression — pin its behavior tightly.
 */
import { describe, it, expect } from "vitest";
import {
  truncateToolOutputForHistory,
  TOOL_OUTPUT_HISTORY_LIMIT,
} from "./output-truncate";

describe("truncateToolOutputForHistory — pass-through cases", () => {
  it("returns the input unchanged when shorter than the limit", () => {
    const out = truncateToolOutputForHistory("hello world");
    expect(out.content).toBe("hello world");
    expect(out.truncated).toBe(false);
    expect(out.originalLength).toBe("hello world".length);
  });

  it("returns empty string for undefined", () => {
    const out = truncateToolOutputForHistory(undefined);
    expect(out.content).toBe("");
    expect(out.truncated).toBe(false);
    expect(out.originalLength).toBe(0);
  });

  it("JSON-stringifies non-string values (objects, arrays, numbers)", () => {
    expect(truncateToolOutputForHistory({ a: 1 }).content).toBe('{"a":1}');
    expect(truncateToolOutputForHistory([1, 2, 3]).content).toBe("[1,2,3]");
    expect(truncateToolOutputForHistory(42).content).toBe("42");
    expect(truncateToolOutputForHistory(null).content).toBe("null");
  });

  it("falls back to String() on values that JSON.stringify rejects (cyclic)", () => {
    const cyclic: { name: string; self?: unknown } = { name: "loop" };
    cyclic.self = cyclic;
    const out = truncateToolOutputForHistory(cyclic);
    // String(obj) returns "[object Object]" — not pretty, but does not throw.
    expect(typeof out.content).toBe("string");
    expect(out.truncated).toBe(false);
  });
});

describe("truncateToolOutputForHistory — truncation behavior", () => {
  const big = "X".repeat(TOOL_OUTPUT_HISTORY_LIMIT + 5000);

  it("flips `truncated` and reports original length when over the limit", () => {
    const out = truncateToolOutputForHistory(big);
    expect(out.truncated).toBe(true);
    expect(out.originalLength).toBe(big.length);
  });

  it("output stays at or below the configured cap (with marker overhead)", () => {
    const out = truncateToolOutputForHistory(big);
    // The marker + bookkeeping adds a few hundred chars; we don't pin the
    // exact length but assert the order-of-magnitude cap holds. This guards
    // against a future refactor that accidentally inflates the budget.
    expect(out.content.length).toBeLessThan(TOOL_OUTPUT_HISTORY_LIMIT + 500);
  });

  it("includes the truncation marker so a reader knows it's been cut", () => {
    const out = truncateToolOutputForHistory(big);
    expect(out.content).toMatch(/output truncated/i);
    expect(out.content).toMatch(/skipped \d+ chars/);
  });

  it("preserves head AND tail (not just one of them)", () => {
    // We need to distinguish head from tail. Build a string where the first
    // and last characters are different recognizable markers.
    const head = "AAA-HEAD-MARKER-AAA";
    const tail = "ZZZ-TAIL-MARKER-ZZZ";
    const middle = "M".repeat(TOOL_OUTPUT_HISTORY_LIMIT * 2);
    const input = head + middle + tail;

    const out = truncateToolOutputForHistory(input);
    expect(out.truncated).toBe(true);
    expect(out.content).toContain(head);
    expect(out.content).toContain(tail);
  });

  it("respects a custom maxChars argument", () => {
    const out = truncateToolOutputForHistory("X".repeat(2000), 500);
    expect(out.truncated).toBe(true);
    // Custom-cap result should be smaller than the default-cap result.
    expect(out.content.length).toBeLessThan(TOOL_OUTPUT_HISTORY_LIMIT);
  });

  it("uses 25% head / 75% tail split (signal-preserving for shell output)", () => {
    // Build distinguishable head and tail. The 75% tail bias mirrors how
    // shell commands distribute useful signal — exit codes and final
    // summaries live near the end.
    const head = "H".repeat(5000);
    const tail = "T".repeat(15000);
    const input = head + "M".repeat(50000) + tail;

    const out = truncateToolOutputForHistory(input);

    const tailCount = (out.content.match(/T/g) ?? []).length;
    const headCount = (out.content.match(/H/g) ?? []).length;
    // Tail block must be the larger half — strict inequality, no ties.
    expect(tailCount).toBeGreaterThan(headCount);
  });
});
