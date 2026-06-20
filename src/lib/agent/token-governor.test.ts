import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import {
  computeGovernorBudget,
  createTokenGovernor,
  governMessages,
  capToolResultSize,
} from "./token-governor";
import { estimateTokenCount } from "./compressor";

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
    // maxOutput 4096 is under 30% of 200000 → reserve it in full
    expect(computeGovernorBudget(200000, 4096)).toBe(200000 - 4096);
  });
  it("never drops below the absolute floor", () => {
    expect(computeGovernorBudget(1000, 100000)).toBe(1000);
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
