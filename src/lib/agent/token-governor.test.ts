import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import {
  computeGovernorBudget,
  createTokenGovernor,
  governMessages,
  capToolResultSize,
} from "./token-governor";
import { estimateTokenCount } from "./compressor";
import { MAX_RELIABLE_CONTEXT_WINDOW } from "@/lib/providers/context-window";

const big = (chars: number) => "x".repeat(chars);

// Minimal prepareStep options — the governor only reads `messages`.
async function callGovernor(
  gov: ReturnType<typeof createTokenGovernor>,
  messages: ModelMessage[]
): Promise<{ messages?: ModelMessage[] }> {
  const result = await gov({
    messages,
    stepNumber: 1,
    steps: [],
    model: {} as never,
    experimental_context: undefined,
  });
  return (result ?? {}) as { messages?: ModelMessage[] };
}

describe("computeGovernorBudget", () => {
  it("reserves output headroom, clamped to 30% of the window", () => {
    // maxOutput 2048 would over-reserve on a 4096 window → clamp to 30% (1228)
    expect(computeGovernorBudget(4096, 2048)).toBe(4096 - 1228);
    // maxOutput 4096 is under 30% of 100000 (under the cap) → reserve in full
    expect(computeGovernorBudget(100000, 4096)).toBe(100000 - 4096);
  });
  it("never drops below the absolute floor", () => {
    expect(computeGovernorBudget(1000, 100000)).toBe(1000);
  });
  it("clamps an over-advertised window to the reliable cap before budgeting (PM #82)", () => {
    // A 1M advertised window must NOT yield a ~1M budget — the governor would
    // then never prune (the root cause of the long-context loop). It collapses
    // to the reliable cap minus the reserve, same as a 200k window.
    expect(computeGovernorBudget(1048576, 4096)).toBe(MAX_RELIABLE_CONTEXT_WINDOW - 4096);
    expect(computeGovernorBudget(200000, 4096)).toBe(MAX_RELIABLE_CONTEXT_WINDOW - 4096);
  });
  it("LIFTS the clamp for a reliable large-window family via modelHint (PM #95)", () => {
    // Claude 200K is trusted → full budget, NOT clamped to 120K.
    expect(
      computeGovernorBudget(200000, 4096, { provider: "anthropic", model: "claude-opus-4-8" })
    ).toBe(200000 - 4096);
    // Gemini 1M (reserve clamps to 30% of the window: 300000).
    expect(computeGovernorBudget(1000000, 100000, { model: "google/gemini-2.0-flash" })).toBe(
      1000000 - 100000
    );
    // A degrading family with a hint STILL clamps.
    expect(computeGovernorBudget(1048576, 4096, { model: "qwen/qwen3-coder" })).toBe(
      MAX_RELIABLE_CONTEXT_WINDOW - 4096
    );
  });
});

describe("createTokenGovernor", () => {
  const gov = createTokenGovernor({ contextWindow: 4096, reservedOutputTokens: 1024 });

  it("is a no-op (returns {}) when messages are under budget", async () => {
    const out = await callGovernor(gov, [{ role: "user", content: "hi" }]);
    expect(out).toEqual({});
  });

  it("returns reduced messages when over budget", async () => {
    const messages: ModelMessage[] = [
      { role: "user", content: big(40000) }, // ~11k tokens, far over a 4096 window
      { role: "assistant", content: "ok" },
      { role: "user", content: "and now?" },
    ];
    const out = await callGovernor(gov, messages);
    expect(out.messages).toBeDefined();
    expect(estimateTokenCount(out.messages!)).toBeLessThan(estimateTokenCount(messages));
  });
});

describe("governMessages — Stage 1: drop old tool content (pair-safe)", () => {
  it("drops an old large tool result, keeps the recent exchange", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "start" },
      // older tool exchange (c1) with a huge result
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "read", input: {} }] as never },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "read", output: { type: "text", value: big(40000) } }] as never },
      // newer small tool exchange (c2) — within the keep window
      { role: "assistant", content: "interim" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c2", toolName: "read", input: {} }] as never },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "c2", toolName: "read", output: { type: "text", value: "tiny-recent" } }] as never },
    ];
    const before = estimateTokenCount(messages);
    const out = governMessages(messages, 2000);

    expect(estimateTokenCount(out)).toBeLessThan(before);
    expect(JSON.stringify(out)).not.toContain(big(40000)); // huge old result gone
    expect(JSON.stringify(out)).toContain("tiny-recent"); // recent result retained
  });
});

describe("governMessages — Stage 2: recency window safety", () => {
  it("slides to a recent suffix on plain-text overflow, never empty, keeps the latest message", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: big(40000) },
      { role: "assistant", content: big(40000) },
      { role: "user", content: "latest question" },
    ];
    const out = governMessages(messages, 2000);
    expect(out.length).toBeGreaterThan(0);
    expect(out[out.length - 1]).toEqual({ role: "user", content: "latest question" });
  });

  // Sprint A4 — the slide can leave two same-role messages adjacent. Strict
  // models (Gemma, Anthropic — §1 MoA "no consecutive user messages") reject
  // that, so the window must be coalesced before it goes back to the SDK.
  it("merges consecutive same-role messages the slide leaves adjacent", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: big(40000) }, // evicted by the slide
      { role: "user", content: "alpha" },
      { role: "user", content: "beta" },
    ];
    const out = governMessages(messages, 2000);

    // No two adjacent messages share a role — the strict-model invariant.
    for (let i = 1; i < out.length; i++) {
      expect(out[i].role).not.toBe(out[i - 1].role);
    }
    // The two recent user turns were coalesced, not dropped.
    const merged = out.map((m) => m.content).join(" ");
    expect(merged).toContain("alpha");
    expect(merged).toContain("beta");
  });

  it("never begins the kept window on an orphaned tool-result", () => {
    const messages: ModelMessage[] = [
      { role: "assistant", content: big(40000) }, // forces the slide boundary forward
      { role: "tool", content: [{ type: "tool-result", toolCallId: "x", toolName: "read", output: { type: "text", value: "r" } }] as never },
      { role: "user", content: "q" },
    ];
    const out = governMessages(messages, 500);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.role).not.toBe("tool"); // the leading-tool guard fired
  });

  // PM #76 follow-up — a pure recency slide used to drop the original task when a
  // few near-cap results blew the budget. Stage 2 now anchors a CONCISE leading
  // task (system run + first user turn) so the model can't "forget" it.
  it("preserves a concise task anchor (first user turn) through the recency slide", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "TASK_MARKER_42: build the metrics dashboard" }, // small task anchor
      { role: "assistant", content: big(40000) }, // huge middle — evicted by the slide
      { role: "user", content: "and add a CSV export button" }, // recent turn
    ];
    const out = governMessages(messages, 2000);
    const joined = out
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join(" ");
    expect(joined).toContain("TASK_MARKER_42"); // task survived (without the anchor it slid off)
    expect(joined).toContain("CSV export"); // recent turn survived too
    // strict-model invariant: no two adjacent same-role messages.
    for (let i = 1; i < out.length; i++) expect(out[i].role).not.toBe(out[i - 1].role);
  });

  it("does NOT anchor a huge first message (a paste is not a task pointer)", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: big(40000) }, // huge first user = paste, must NOT be re-pinned
      { role: "assistant", content: big(40000) },
      { role: "user", content: "latest" },
    ];
    const out = governMessages(messages, 2000);
    expect(out[out.length - 1]).toEqual({ role: "user", content: "latest" });
    const totalChars = out
      .map((m) => (typeof m.content === "string" ? m.content.length : 0))
      .reduce((a, b) => a + b, 0);
    expect(totalChars).toBeLessThan(40000); // the 40k paste was evicted, not pinned back in
  });
});

describe("capToolResultSize", () => {
  it("passes small string output through untouched", () => {
    expect(capToolResultSize("ok")).toBe("ok");
  });

  it("passes non-string output through untouched (no shape corruption)", () => {
    const obj = { success: true, rows: [1, 2, 3] };
    expect(capToolResultSize(obj)).toBe(obj);
  });

  it("truncates an oversized string, keeping head + tail with a marker", () => {
    const huge = "HEAD" + big(50000) + "TAIL";
    const out = capToolResultSize(huge) as string;
    expect(out.length).toBeLessThan(huge.length);
    expect(out.startsWith("HEAD")).toBe(true);
    expect(out.endsWith("TAIL")).toBe(true);
    expect(out).toContain("Orchestra truncated this tool result");
    expect(out).toContain("characters omitted");
  });
});

describe("createTokenGovernor — systemPromptTokens (Layer 0, PM #94-follow-up)", () => {
  // MANY messages (so the recency slide can actually drop some and get under
  // budget — a single huge message is never pruned below the floor). Alternating
  // roles so no pair/merge surprises. Total ~a few thousand tokens.
  const messages: ModelMessage[] = Array.from({ length: 12 }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: big(3000),
  }));

  it("does NOT prune when the system prompt is ignored (prior behaviour, tokens=0)", async () => {
    const window = MAX_RELIABLE_CONTEXT_WINDOW; // large window, messages fit
    const gov = createTokenGovernor({ contextWindow: window, reservedOutputTokens: 4096 });
    const out = await callGovernor(gov, messages);
    expect(out.messages).toBeUndefined(); // {} → no pruning
  });

  it("PRUNES the same payload once the system-prompt size is subtracted", async () => {
    const msgTokens = estimateTokenCount(messages);
    const reserved = 4096;
    const window = MAX_RELIABLE_CONTEXT_WINDOW;
    const fullBudget = computeGovernorBudget(window, reserved);
    // Subtract a system prompt big enough that budget-sys ≈ half the messages →
    // the recency slide must drop the older half to fit.
    const sysTokens = fullBudget - Math.floor(msgTokens / 2);
    const gov = createTokenGovernor({
      contextWindow: window,
      reservedOutputTokens: reserved,
      systemPromptTokens: sysTokens,
    });
    const out = await callGovernor(gov, messages);
    expect(out.messages).toBeDefined(); // pruning happened (vs {} above)
    // Ended up under the reduced budget, and strictly smaller than the input.
    expect(estimateTokenCount(out.messages!)).toBeLessThanOrEqual(fullBudget - sysTokens);
    expect(out.messages!.length).toBeLessThan(messages.length);
  });

  it("floors the message budget at ABSOLUTE_MIN_BUDGET when the system prompt is huge", async () => {
    // systemPromptTokens far exceeding the window must not yield a negative budget.
    const gov = createTokenGovernor({
      contextWindow: MAX_RELIABLE_CONTEXT_WINDOW,
      reservedOutputTokens: 4096,
      systemPromptTokens: MAX_RELIABLE_CONTEXT_WINDOW * 5,
    });
    const out = await callGovernor(gov, messages);
    // Still returns a non-empty pruned array (never empty, never throws).
    expect(out.messages).toBeDefined();
    expect(out.messages!.length).toBeGreaterThan(0);
  });
});
