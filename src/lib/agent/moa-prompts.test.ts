/**
 * Unit tests for the MoA prompt builders (moa-prompts.ts) — extracted from
 * moa.ts (Sprint 5 §10). `buildAggregatorPrompt` had no direct test before
 * (only indirect assertions via the ensemble); this pins its Together-MoA
 * numbered format. The other two are additionally covered through the ensemble
 * in moa.test.ts — here we assert the standalone module exports work.
 */
import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import {
  AGGREGATOR_SYSTEM_PROMPT,
  buildAggregatorPrompt,
  buildInlineSynthesisInjection,
  buildProposerContextBlock,
  capDraftForInjection,
  capHeadTail,
  INLINE_SYNTHESIS_DRAFT_CHAR_CAP,
} from "./moa-prompts";

const drafts = [
  { role: "architect", text: "Use a queue." },
  { role: "skeptic", text: "The queue can drop messages." },
];

describe("buildAggregatorPrompt — Together MoA numbered template", () => {
  it("embeds the original user request", () => {
    expect(buildAggregatorPrompt("How do I scale writes?", drafts)).toContain("How do I scale writes?");
  });
  it("numbers each draft and labels it with its expert role (hint, not hierarchy)", () => {
    const p = buildAggregatorPrompt("q", drafts);
    expect(p).toContain("1. [Expert role: architect]\nUse a queue.");
    expect(p).toContain("2. [Expert role: skeptic]\nThe queue can drop messages.");
  });
  it("closes with the synthesis instruction", () => {
    expect(buildAggregatorPrompt("q", drafts)).toMatch(/Now produce the final synthesized response\.$/);
  });
  it("treats drafts as candidates, not authority", () => {
    expect(buildAggregatorPrompt("q", drafts)).toContain("treat each as a candidate, not as authority");
  });
});

describe("buildInlineSynthesisInjection — collapsed-path system-prompt block", () => {
  it("mirrors buildAggregatorPrompt's numbering under the drafts header", () => {
    const block = buildInlineSynthesisInjection("SYNTHESIZE NOW", drafts, "");
    expect(block).toContain("## Expert Drafts to Synthesize");
    expect(block).toContain("1. [Expert role: architect]\nUse a queue.");
    expect(block).toContain("SYNTHESIZE NOW");
  });
  it("includes the disagreement marker when present", () => {
    const block = buildInlineSynthesisInjection("d", drafts, "<<DISAGREEMENT_DETECTED>>");
    expect(block).toContain("<<DISAGREEMENT_DETECTED>>");
  });
  it("omits the marker when it is empty/whitespace", () => {
    const block = buildInlineSynthesisInjection("d", drafts, "   ");
    expect(block).not.toContain("<<");
  });
});

describe("AGGREGATOR_SYSTEM_PROMPT — load-bearing synthesis rules", () => {
  it("carries the critical-evaluation, no-meta-commentary, and disagreement rules", () => {
    expect(AGGREGATOR_SYSTEM_PROMPT).toMatch(/critically evaluate/i);
    expect(AGGREGATOR_SYSTEM_PROMPT).toMatch(/NO META-COMMENTARY/);
    expect(AGGREGATOR_SYSTEM_PROMPT).toContain("<<DISAGREEMENT_DETECTED>>");
  });
});

describe("capDraftForInjection — Layer 0b draft cap (keeps head+tail, DoubleTake SEV5)", () => {
  it("passes a normal-size draft through verbatim", () => {
    const small = "A concise reviewer draft with a clear conclusion at the end.";
    expect(capDraftForInjection(small)).toBe(small);
  });

  it("caps an oversized draft but KEEPS both the head and the tail (conclusion)", () => {
    const head = "HEAD_MARKER intro reasoning ";
    const tail = " CONCLUSION_MARKER final actionable code";
    const huge = head + "x".repeat(INLINE_SYNTHESIS_DRAFT_CHAR_CAP) + tail;
    const out = capDraftForInjection(huge);
    expect(out.length).toBeLessThan(huge.length);
    expect(out).toContain("HEAD_MARKER"); // head preserved
    expect(out).toContain("CONCLUSION_MARKER"); // tail preserved (SEV5: don't drop the payload)
    expect(out).toMatch(/chars elided/);
  });

  it("buildInlineSynthesisInjection applies the cap to each draft", () => {
    const bigDraft = { role: "reviewer", text: "R".repeat(INLINE_SYNTHESIS_DRAFT_CHAR_CAP + 5000) };
    const block = buildInlineSynthesisInjection("SYNTH", [bigDraft], "");
    expect(block).toContain("chars elided");
    // The injected block is far smaller than the raw draft would have made it.
    expect(block.length).toBeLessThan(INLINE_SYNTHESIS_DRAFT_CHAR_CAP + 2000);
  });
});

describe("buildProposerContextBlock — D1 / PM #94 proposer grounding", () => {
  it("returns empty string for empty history (first turn → append is a no-op)", () => {
    expect(buildProposerContextBlock([])).toBe("");
  });

  it("surfaces tool ACTIVITY that safeHistory strips — this is the whole fix", () => {
    // A goal-tracker update lives in a tool-call + tool-result pair. safeHistory
    // drops BOTH; the proposer must still learn the active task from them.
    const history: ModelMessage[] = [
      { role: "user", content: "Redesign the CSS" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Starting the redesign." },
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "update_task_status",
            input: { task_id: "7", status: "in_progress", result_summary: "Full CSS/UI redesign" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "update_task_status",
            output: { type: "json", value: 'Task "7" updated to in_progress. Full CSS/UI redesign' },
          },
        ],
      },
      { role: "user", content: "Продолжай." },
    ];
    const block = buildProposerContextBlock(history);
    expect(block).toContain("## Recent Conversation Context");
    // The task the proposer was blind to is now present.
    expect(block).toContain("update_task_status");
    expect(block).toContain("Full CSS/UI redesign");
    // The continuation prompt and the guidance to act on it are present.
    expect(block).toContain("Продолжай");
    expect(block).toMatch(/do not ask the user to repeat context/i);
  });

  it("keeps only the last `maxMessages` messages", () => {
    const history: ModelMessage[] = Array.from({ length: 12 }, (_, i) => ({
      role: "user" as const,
      content: `msg-${i}`,
    }));
    const block = buildProposerContextBlock(history, 3);
    expect(block).toContain("msg-11");
    expect(block).toContain("msg-9");
    expect(block).not.toContain("msg-8");
  });

  it("caps each message so a huge tool dump can't blow the proposer prompt", () => {
    const huge = "x".repeat(5000);
    const history: ModelMessage[] = [{ role: "assistant", content: huge }];
    const block = buildProposerContextBlock(history, 8, 200);
    expect(block).toContain("…");
    // 200 kept + ellipsis, nowhere near the 5000-char original.
    expect(block.length).toBeLessThan(600);
  });

  it("skips messages that flatten to nothing (e.g. image-only parts)", () => {
    const history: ModelMessage[] = [
      { role: "user", content: [{ type: "image", image: "data:..." } as never] },
      { role: "assistant", content: "Real text." },
    ];
    const block = buildProposerContextBlock(history);
    expect(block).toContain("Real text.");
    // The image-only user turn produced no line.
    expect(block).not.toMatch(/\[USER\]/);
  });
});

describe("capHeadTail — PM #131 truncation primitive", () => {
  it("never exceeds the cap, over an exhaustive sweep of lengths and caps", () => {
    // A cross-model review claimed the output could exceed `cap`. It could not:
    // 36 300 combinations, zero violations. Pinned so a future edit to the
    // marker or the head/tail split cannot quietly introduce one.
    for (let len = 0; len <= 300; len += 1) {
      const text = "x".repeat(len);
      for (let cap = 0; cap <= 120; cap += 1) {
        expect(capHeadTail(text, cap).length).toBeLessThanOrEqual(Math.max(cap, 0));
      }
    }
  });

  it("keeps both ends, and returns short input untouched", () => {
    expect(capHeadTail("short", 50)).toBe("short");
    const out = capHeadTail("HEAD" + "-".repeat(400) + "TAIL", 60);
    expect(out.startsWith("HEAD")).toBe(true);
    expect(out.endsWith("TAIL")).toBe(true);
    expect(out).toMatch(/chars elided/);
  });

  it("never leaves a lone surrogate — an emoji run is cut on a pair boundary", () => {
    // `slice` cuts UTF-16 code units and an emoji is a surrogate PAIR. The
    // review flagged it and it reproduced: the orphaned half reaches the
    // provider as mojibake inside the Router's context.
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    for (let cap = 1; cap <= 90; cap++) {
      expect(loneSurrogate.test(capHeadTail("🎯".repeat(60), cap))).toBe(false);
    }
  });

  it("degenerate caps: zero, negative, and smaller than the marker", () => {
    expect(capHeadTail("anything", 0)).toBe("");
    expect(capHeadTail("anything", -5)).toBe("");
    // Cap below the marker's own length falls back to a plain head slice.
    const tiny = capHeadTail("x".repeat(100), 5);
    expect(tiny).toBe("xxxxx");
  });
});
