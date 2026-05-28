/**
 * PM #53 — trace-memory CLI stats logic.
 *
 * Pinned: `computeStats` is the only piece of CLI logic worth unit-
 * testing — the I/O wrappers around it are thin shells over `fs`
 * operations. We don't run the CLI subprocess; we exercise the pure
 * function directly.
 */
import { describe, it, expect } from "vitest";
import {
  computeStats,
  parseScope,
  projectTracesDir,
  dirForScope,
} from "./trace-memory-admin";

interface OnDiskTrace {
  id: string;
  userPrompt: string;
  finalText: string;
  qualityScore: number;
  modelConfig: { provider: string; model: string };
  capturedAt: string;
  embedding: number[];
}

function trace(over: Partial<OnDiskTrace>): OnDiskTrace {
  return {
    id: "id1",
    userPrompt: "p",
    finalText: "f",
    qualityScore: 0.8,
    modelConfig: { provider: "openai", model: "gpt-4o" },
    capturedAt: "2026-05-01T10:00:00Z",
    embedding: [1, 0, 0, 0],
    ...over,
  };
}

describe("PM #53 — computeStats", () => {
  it("empty pool → zero totals and zeros across", () => {
    const s = computeStats([]);
    expect(s.total).toBe(0);
    expect(s.scoreMin).toBe(0);
    expect(s.scoreMax).toBe(0);
    expect(s.oldest).toBeUndefined();
    expect(s.newest).toBeUndefined();
  });

  it("median on odd count is the middle value", () => {
    const s = computeStats([
      trace({ qualityScore: 0.7 }),
      trace({ qualityScore: 0.9 }),
      trace({ qualityScore: 0.8 }),
    ]);
    expect(s.scoreMedian).toBeCloseTo(0.8, 5);
  });

  it("median on even count is average of two middles", () => {
    const s = computeStats([
      trace({ qualityScore: 0.7 }),
      trace({ qualityScore: 0.8 }),
      trace({ qualityScore: 0.9 }),
      trace({ qualityScore: 1.0 }),
    ]);
    // 0.8 + 0.9 / 2 = 0.85
    expect(s.scoreMedian).toBeCloseTo(0.85, 5);
  });

  it("scoreMin / scoreMax track the boundaries", () => {
    const s = computeStats([
      trace({ qualityScore: 0.71 }),
      trace({ qualityScore: 0.99 }),
      trace({ qualityScore: 0.85 }),
    ]);
    expect(s.scoreMin).toBeCloseTo(0.71, 5);
    expect(s.scoreMax).toBeCloseTo(0.99, 5);
  });

  it("oldest / newest are the captured-at extremes sorted by ISO order", () => {
    const s = computeStats([
      trace({ capturedAt: "2026-05-03T10:00:00Z" }),
      trace({ capturedAt: "2026-05-01T10:00:00Z" }),
      trace({ capturedAt: "2026-05-02T10:00:00Z" }),
    ]);
    expect(s.oldest).toBe("2026-05-01T10:00:00Z");
    expect(s.newest).toBe("2026-05-03T10:00:00Z");
  });

  it("mean prompt / answer lengths are averaged correctly", () => {
    const s = computeStats([
      trace({ userPrompt: "a".repeat(100), finalText: "b".repeat(200) }),
      trace({ userPrompt: "a".repeat(200), finalText: "b".repeat(400) }),
    ]);
    expect(s.promptLengthMean).toBe(150);
    expect(s.answerLengthMean).toBe(300);
  });

  it("scoreMean is the arithmetic mean", () => {
    const s = computeStats([
      trace({ qualityScore: 0.6 }),
      trace({ qualityScore: 0.8 }),
      trace({ qualityScore: 1.0 }),
    ]);
    expect(s.scoreMean).toBeCloseTo(0.8, 5);
  });
});

describe("PM #55 — parseScope + scope dir resolution", () => {
  it("no flags → global", () => {
    expect(parseScope(["node", "script", "list"])).toEqual({ kind: "global" });
  });

  it("--global → global", () => {
    expect(parseScope(["node", "script", "list", "--global"])).toEqual({
      kind: "global",
    });
  });

  it("--all → all", () => {
    expect(parseScope(["node", "script", "list", "--all"])).toEqual({
      kind: "all",
    });
  });

  it("--project <id> → project scope", () => {
    expect(
      parseScope(["node", "script", "list", "--project", "abc123"])
    ).toEqual({ kind: "project", projectId: "abc123" });
  });

  it("--project with no id → defaults to global (defensive)", () => {
    expect(parseScope(["node", "script", "list", "--project"])).toEqual({
      kind: "global",
    });
  });

  it("--all wins over --project (defensive — both means all)", () => {
    expect(
      parseScope(["node", "script", "list", "--project", "abc", "--all"])
    ).toEqual({ kind: "all" });
  });

  it("projectTracesDir matches the runtime convention", () => {
    const out = projectTracesDir("proj-x");
    expect(out).toMatch(/projects\/proj-x\/\.orchestra_traces$/);
  });

  it("dirForScope global → data/traces", () => {
    expect(dirForScope({ kind: "global" })).toMatch(/data\/traces$/);
  });

  it("dirForScope project → per-project nested path", () => {
    expect(dirForScope({ kind: "project", projectId: "p1" })).toMatch(
      /projects\/p1\/\.orchestra_traces$/
    );
  });
});
