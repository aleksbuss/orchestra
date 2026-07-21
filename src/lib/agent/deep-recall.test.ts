import { describe, it, expect } from "vitest";
import {
  buildBoundedRecallBlock,
  capChunkHeadTail,
  resolveRecallBudgetChars,
  DEEP_RECALL_PER_CHUNK_CHARS,
  DEEP_RECALL_TOTAL_CHARS,
  DEEP_RECALL_MIN_TOTAL_CHARS,
  DEEP_RECALL_MAX_TOTAL_CHARS,
  RECALL_WINDOW_FRACTION,
  type RecallHit,
} from "./deep-recall";

const hit = (score: number, text: string, area = "Auto-Archive"): RecallHit => ({
  score,
  text,
  metadata: { area },
});

describe("capChunkHeadTail", () => {
  it("passes a short chunk through verbatim", () => {
    expect(capChunkHeadTail("small chunk", 100)).toBe("small chunk");
  });

  it("keeps HEAD and TAIL of an over-long chunk (exact artifacts at both ends)", () => {
    const text = "HEAD_ARTIFACT" + "x".repeat(5000) + "TAIL_ARTIFACT";
    const out = capChunkHeadTail(text, 1000);
    expect(out.length).toBeLessThan(text.length);
    expect(out).toContain("HEAD_ARTIFACT");
    expect(out).toContain("TAIL_ARTIFACT");
    expect(out).toMatch(/chars elided/);
  });
});

describe("buildBoundedRecallBlock — PM #94 recall bound", () => {
  it("returns empty string for no hits", () => {
    expect(buildBoundedRecallBlock([])).toBe("");
  });

  it("formats each hit with its score + area and the (capped) text", () => {
    const block = buildBoundedRecallBlock([hit(0.91, "recalled content", "main")]);
    expect(block).toContain("[Relevance Score: 0.91] (Area: main)");
    expect(block).toContain("recalled content");
  });

  it("BOUNDS a giant verbatim archive far below its raw size (the actual bug)", () => {
    // Simulate the live case: 3 unbounded verbatim-archive chunks ~30k chars each.
    const huge = [
      hit(0.9, "A".repeat(30_000)),
      hit(0.85, "B".repeat(30_000)),
      hit(0.8, "C".repeat(30_000)),
    ];
    const rawTotal = 90_000;
    const block = buildBoundedRecallBlock(huge);
    expect(block.length).toBeLessThan(rawTotal / 4); // massively smaller
    // Stays within the total budget (plus small formatting overhead per kept chunk).
    expect(block.length).toBeLessThanOrEqual(DEEP_RECALL_TOTAL_CHARS + 3 * 200);
  });

  it("respects the total budget by dropping the least-relevant tail chunks", () => {
    // Many mid-size chunks: only the first few fit within the total budget.
    const many = Array.from({ length: 20 }, (_, i) =>
      hit(0.9 - i * 0.01, `chunk${i}-` + "z".repeat(DEEP_RECALL_PER_CHUNK_CHARS))
    );
    const block = buildBoundedRecallBlock(many);
    expect(block).toContain("chunk0-"); // highest relevance kept
    expect(block).not.toContain("chunk19-"); // lowest relevance dropped (budget spent)
    expect(block.length).toBeLessThanOrEqual(DEEP_RECALL_TOTAL_CHARS + 20 * 200);
  });

  it("honors custom caps", () => {
    const block = buildBoundedRecallBlock([hit(0.9, "y".repeat(1000))], 100, 1000);
    // per-chunk cap 100 → the one chunk is capped near 100 chars + marker/format.
    expect(block.length).toBeLessThan(400);
  });
});

describe("resolveRecallBudgetChars — window-relative budget (PM #95)", () => {
  it("scales the total with the effective window (~8% × 3.5 chars/token)", () => {
    // 200K window → 0.08 * 200000 * 3.5 = 56000 chars.
    expect(resolveRecallBudgetChars(200000).totalChars).toBe(
      Math.round(200000 * RECALL_WINDOW_FRACTION * 3.5)
    );
    // A big window carries strictly more recall than a small one.
    expect(resolveRecallBudgetChars(1000000).totalChars).toBeGreaterThan(
      resolveRecallBudgetChars(120000).totalChars
    );
  });
  it("floors a tiny window at the minimum so recall never vanishes", () => {
    // 4096 window → 0.08 * 4096 * 3.5 ≈ 1147 < MIN → floored.
    expect(resolveRecallBudgetChars(4096).totalChars).toBe(DEEP_RECALL_MIN_TOTAL_CHARS);
    expect(resolveRecallBudgetChars(0).totalChars).toBe(DEEP_RECALL_MIN_TOTAL_CHARS);
  });
  it("caps an enormous window at the ceiling (no absurd injection)", () => {
    // 10M window → way over the ceiling.
    expect(resolveRecallBudgetChars(10_000_000).totalChars).toBe(DEEP_RECALL_MAX_TOTAL_CHARS);
  });
  it("keeps per-chunk a bounded fraction of the total (≥2000, ~35%)", () => {
    const { perChunkChars, totalChars } = resolveRecallBudgetChars(200000);
    expect(perChunkChars).toBeGreaterThanOrEqual(2000);
    expect(perChunkChars).toBeLessThan(totalChars);
  });
  it("at the operator's ~120K window the total exceeds the old fixed 16K cap (more headroom, not less)", () => {
    expect(resolveRecallBudgetChars(120000).totalChars).toBeGreaterThan(DEEP_RECALL_TOTAL_CHARS);
  });
});
