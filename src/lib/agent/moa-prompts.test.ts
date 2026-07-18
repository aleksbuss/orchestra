/**
 * Unit tests for the MoA prompt builders (moa-prompts.ts) — extracted from
 * moa.ts (Sprint 5 §10). `buildAggregatorPrompt` had no direct test before
 * (only indirect assertions via the ensemble); this pins its Together-MoA
 * numbered format. The other two are additionally covered through the ensemble
 * in moa.test.ts — here we assert the standalone module exports work.
 */
import { describe, it, expect } from "vitest";
import {
  AGGREGATOR_SYSTEM_PROMPT,
  buildAggregatorPrompt,
  buildInlineSynthesisInjection,
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
