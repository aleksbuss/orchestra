/**
 * PM #51 — Trace memory contract.
 *
 * What we pin:
 *   1. `computeQualityScore` is pure and weights signals correctly.
 *      The weighting choice is the API contract — the threshold (default
 *      0.7) means something specific only if the weights stay stable.
 *   2. `captureSuccessfulTrace` is feature-flag-gated, threshold-gated,
 *      and disk-write atomic.
 *   3. `retrieveRelevantTraces` returns sorted top-K by cosine, filters
 *      sub-threshold traces, returns [] under disabled feature flag,
 *      returns [] gracefully on embedding failure (no throw).
 *   4. `formatTracesAsFewShots` renders the prompt-injectable block with
 *      the required marker tags (`<past_successful_runs>`,
 *      `<example>`) — the Router prompt expects them for visual
 *      delimitation.
 *   5. `computeTraceId` is stable across whitespace + case variations
 *      of the same prompt (dedupe correctness).
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import type { AppSettings, ModelConfig } from "@/lib/types";

// Stub the embeddings module BEFORE importing the trace-memory module —
// Vitest hoists vi.mock above imports automatically.
vi.mock("@/lib/memory/embeddings", () => ({
  embedTexts: vi.fn(),
}));

import {
  captureSuccessfulTrace,
  computeQualityScore,
  computeTraceId,
  formatTracesAsFewShots,
  retrieveRelevantTraces,
  __resetTraceMemoryForTests,
  __seedTraceMemoryForTests,
  type TraceSignals,
  type SuccessfulTrace,
} from "./trace-memory";
import { embedTexts } from "@/lib/memory/embeddings";

const mockedEmbedTexts = vi.mocked(embedTexts);

function baseSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    chatModel: { provider: "openai", model: "gpt-4o", apiKey: "k" },
    utilityModel: { provider: "openai", model: "gpt-4o-mini", apiKey: "k" },
    embeddingsModel: {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
    },
    codeExecution: { enabled: true, timeout: 600, maxOutputLength: 120000 },
    memory: {
      enabled: true,
      similarityThreshold: 0.35,
      maxResults: 10,
      chunkSize: 400,
    },
    search: { enabled: false, provider: "none" },
    general: { darkMode: false, language: "en" },
    auth: {
      enabled: true,
      username: "admin",
      passwordHash: "scrypt$x$y",
      mustChangeCredentials: false,
    },
    traceMemory: { enabled: true, qualityThreshold: 0.7 },
    ...overrides,
  };
}

const goodSignals: TraceSignals = {
  proposerSuccessRatio: 1.0,
  disagreementDetected: false,
  disagreementMaxDistance: 0.1,
  reflectionRounds: 0,
  reflectionHitCap: false,
  totalLatencyMs: 5000,
};

const badSignals: TraceSignals = {
  proposerSuccessRatio: 0.4,
  disagreementDetected: true,
  disagreementMaxDistance: 0.8,
  reflectionRounds: 3,
  reflectionHitCap: true,
  totalLatencyMs: 90000,
};

const brainConfig: ModelConfig = {
  provider: "anthropic",
  model: "claude-opus-4-7",
  apiKey: "k",
};

let tempDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  __resetTraceMemoryForTests();
  vi.clearAllMocks();
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "trace-mem-test-"));
  originalDataDir = process.env.ORCHESTRA_DATA_DIR;
  process.env.ORCHESTRA_DATA_DIR = tempDir;
});

afterEach(async () => {
  if (originalDataDir === undefined) {
    delete process.env.ORCHESTRA_DATA_DIR;
  } else {
    process.env.ORCHESTRA_DATA_DIR = originalDataDir;
  }
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("PM #51 — computeQualityScore", () => {
  it("perfect signals → score 1.0", () => {
    expect(computeQualityScore(goodSignals)).toBeCloseTo(1.0, 5);
  });

  it("all-bad signals → score 0.0", () => {
    expect(computeQualityScore({ ...badSignals, proposerSuccessRatio: 0 })).toBeCloseTo(
      0,
      5
    );
  });

  it("0 reflection rounds AND no disagreement → high score even with partial proposer success", () => {
    // 0.4 * 0.5 (half proposers ok) + 0.3 * 1 + 0.2 * 1 + 0.1 * 1 = 0.8
    const score = computeQualityScore({
      ...goodSignals,
      proposerSuccessRatio: 0.5,
    });
    expect(score).toBeCloseTo(0.8, 5);
  });

  it("1 reflection round = half weight on the critic dimension", () => {
    // 0.4 * 1 + 0.3 * 1 + 0.2 * 0.5 + 0.1 * 1 = 0.9
    const score = computeQualityScore({ ...goodSignals, reflectionRounds: 1 });
    expect(score).toBeCloseTo(0.9, 5);
  });

  it("2+ reflection rounds = zero weight on the critic dimension", () => {
    // 0.4 + 0.3 + 0 + 0.1 = 0.8
    const s2 = computeQualityScore({ ...goodSignals, reflectionRounds: 2 });
    const s3 = computeQualityScore({ ...goodSignals, reflectionRounds: 3 });
    expect(s2).toBeCloseTo(0.8, 5);
    expect(s3).toBeCloseTo(0.8, 5);
  });

  it("disagreement detected wipes 0.3 of the score (whole consensus dimension)", () => {
    // 0.4 + 0 + 0.2 + 0.1 = 0.7
    const score = computeQualityScore({
      ...goodSignals,
      disagreementDetected: true,
    });
    expect(score).toBeCloseTo(0.7, 5);
  });

  it("reflectionHitCap zeros the cap dimension (0.1)", () => {
    // 0.4 + 0.3 + 0 + 0 = 0.7 (rounds=2 already zeroed critic; cap adds visibility)
    const score = computeQualityScore({
      ...goodSignals,
      reflectionRounds: 2,
      reflectionHitCap: true,
    });
    expect(score).toBeCloseTo(0.7, 5);
  });

  it("proposerSuccessRatio out of range clamps to [0,1]", () => {
    const s1 = computeQualityScore({ ...goodSignals, proposerSuccessRatio: 1.5 });
    const s2 = computeQualityScore({ ...goodSignals, proposerSuccessRatio: -0.3 });
    expect(s1).toBeCloseTo(1.0, 5);
    expect(s2).toBeCloseTo(0.6, 5); // 0 + 0.3 + 0.2 + 0.1
  });

  it("NaN proposerSuccessRatio degrades to 0 (defensive)", () => {
    const score = computeQualityScore({ ...goodSignals, proposerSuccessRatio: NaN });
    expect(score).toBeCloseTo(0.6, 5);
  });
});

describe("PM #51 — computeTraceId", () => {
  it("same prompt → same id (deterministic)", () => {
    expect(computeTraceId("hello world")).toBe(computeTraceId("hello world"));
  });

  it("whitespace + case variations of same prompt → same id (dedupe)", () => {
    const a = computeTraceId("Build me a REST API");
    const b = computeTraceId("  build me a rest api  ");
    expect(a).toBe(b);
  });

  it("different prompts → different ids", () => {
    expect(computeTraceId("foo")).not.toBe(computeTraceId("bar"));
  });

  it("id is 16-char hex slice (file-system-friendly)", () => {
    const id = computeTraceId("anything");
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("PM #51 — captureSuccessfulTrace", () => {
  it("disabled feature flag → not captured", async () => {
    const settings = baseSettings({ traceMemory: { enabled: false } });
    const result = await captureSuccessfulTrace({
      userPrompt: "test",
      finalText: "answer",
      signals: goodSignals,
      brainConfig,
      settings,
    });
    expect(result.captured).toBe(false);
    expect(result.reason).toMatch(/disabled/i);
  });

  it("score below threshold → not captured", async () => {
    const settings = baseSettings({
      traceMemory: { enabled: true, qualityThreshold: 0.7 },
    });
    const result = await captureSuccessfulTrace({
      userPrompt: "test",
      finalText: "answer",
      signals: badSignals, // score = 0 — well below 0.7
      brainConfig,
      settings,
    });
    expect(result.captured).toBe(false);
    expect(result.reason).toMatch(/score.*threshold/i);
  });

  it("good signals → captured, file written to disk", async () => {
    mockedEmbedTexts.mockResolvedValueOnce([new Array(16).fill(0.5)]);
    const result = await captureSuccessfulTrace({
      userPrompt: "build me a tax calculator",
      finalText: "Here's a calculator…",
      signals: goodSignals,
      brainConfig,
      settings: baseSettings(),
    });
    expect(result.captured).toBe(true);
    expect(result.traceId).toBeDefined();
    // Verify the file landed on disk.
    const expectedPath = path.join(
      tempDir,
      "traces",
      `${result.traceId}.json`
    );
    const raw = await fs.readFile(expectedPath, "utf-8");
    const parsed = JSON.parse(raw) as SuccessfulTrace;
    expect(parsed.userPrompt).toBe("build me a tax calculator");
    expect(parsed.finalText).toBe("Here's a calculator…");
    expect(parsed.qualityScore).toBeCloseTo(1.0, 5);
    expect(parsed.embedding.length).toBe(16);
    expect(parsed.modelConfig.provider).toBe("anthropic");
  });

  it("embedding failure → not captured (no partial write)", async () => {
    mockedEmbedTexts.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const result = await captureSuccessfulTrace({
      userPrompt: "test",
      finalText: "answer",
      signals: goodSignals,
      brainConfig,
      settings: baseSettings(),
    });
    expect(result.captured).toBe(false);
    expect(result.reason).toMatch(/embedding failed/i);
  });

  it("empty embedding vector → not captured", async () => {
    mockedEmbedTexts.mockResolvedValueOnce([[]]);
    const result = await captureSuccessfulTrace({
      userPrompt: "test",
      finalText: "answer",
      signals: goodSignals,
      brainConfig,
      settings: baseSettings(),
    });
    expect(result.captured).toBe(false);
    expect(result.reason).toMatch(/empty vector/i);
  });

  // PM #54 — score-regression guard: rerunning the same prompt with a
  // WORSE quality score must not overwrite the better existing trace.
  it("rerun with lower score does NOT overwrite a better existing trace", async () => {
    // Seed an existing high-score trace for prompt "hello".
    const existingId = (await import("./trace-memory")).computeTraceId("hello");
    __seedTraceMemoryForTests([
      {
        id: existingId,
        userPrompt: "hello",
        finalText: "great answer",
        signals: goodSignals,
        qualityScore: 0.95,
        modelConfig: { provider: "openai", model: "gpt-4o" },
        capturedAt: new Date("2026-05-01").toISOString(),
        embedding: [1, 0, 0, 0],
      },
    ]);
    // Try to overwrite with a lower-but-still-above-threshold score:
    // we need score >= 0.7 (threshold) AND < 0.95 (existing).
    // With reflectionRounds=1 → critic dimension = 0.5 * 0.2 = 0.1
    // → total = 0.4 + 0.3 + 0.1 + 0.1 = 0.9, still < 0.95.
    const lowerButStillGoodSignals = {
      ...goodSignals,
      reflectionRounds: 1,
    };
    const result = await captureSuccessfulTrace({
      userPrompt: "hello",
      finalText: "worse answer",
      signals: lowerButStillGoodSignals,
      brainConfig,
      settings: baseSettings(),
    });
    expect(result.captured).toBe(false);
    expect(result.reason).toMatch(/no regression overwrite/i);
    // Embedding was NOT called — we short-circuited before the costly step.
    expect(mockedEmbedTexts).not.toHaveBeenCalled();
  });

  it("rerun with equal-or-higher score DOES overwrite (capturedAt freshness)", async () => {
    const existingId = (await import("./trace-memory")).computeTraceId("hello");
    __seedTraceMemoryForTests([
      {
        id: existingId,
        userPrompt: "hello",
        finalText: "old answer",
        signals: goodSignals,
        qualityScore: 0.8,
        modelConfig: { provider: "openai", model: "gpt-4o" },
        capturedAt: new Date("2026-05-01").toISOString(),
        embedding: [1, 0, 0, 0],
      },
    ]);
    mockedEmbedTexts.mockResolvedValueOnce([new Array(4).fill(0.5)]);
    const result = await captureSuccessfulTrace({
      userPrompt: "hello",
      finalText: "newer answer",
      signals: goodSignals, // score = 1.0 > 0.8 → overwrite allowed
      brainConfig,
      settings: baseSettings(),
    });
    expect(result.captured).toBe(true);
  });
});

describe("PM #51 — retrieveRelevantTraces", () => {
  it("disabled feature flag → returns []", async () => {
    const settings = baseSettings({ traceMemory: { enabled: false } });
    const out = await retrieveRelevantTraces("anything", settings);
    expect(out).toEqual([]);
  });

  it("k=0 → returns [] without calling embedTexts", async () => {
    const settings = baseSettings({
      traceMemory: { enabled: true, retrievalK: 0 },
    });
    const out = await retrieveRelevantTraces("anything", settings);
    expect(out).toEqual([]);
    expect(mockedEmbedTexts).not.toHaveBeenCalled();
  });

  it("no traces on disk → returns []", async () => {
    mockedEmbedTexts.mockResolvedValue([new Array(4).fill(0.5)]);
    const out = await retrieveRelevantTraces("anything", baseSettings());
    expect(out).toEqual([]);
  });

  it("returns top-K sorted by cosine similarity, filtered by threshold", async () => {
    // Seed three traces with deliberate embedding vectors.
    const trace1 = makeTrace("first prompt", [1, 0, 0, 0], 0.9);
    const trace2 = makeTrace("second prompt", [0.8, 0.6, 0, 0], 0.9);
    const trace3 = makeTrace("third prompt", [0, 1, 0, 0], 0.9);
    __seedTraceMemoryForTests([trace1, trace2, trace3]);

    // Query vector aligned with trace1, partial overlap with trace2,
    // orthogonal to trace3.
    mockedEmbedTexts.mockResolvedValueOnce([[1, 0, 0, 0]]);

    const out = await retrieveRelevantTraces("query aligned with first", baseSettings(), {
      k: 2,
    });
    expect(out.length).toBe(2);
    expect(out[0].trace.id).toBe(trace1.id);
    expect(out[1].trace.id).toBe(trace2.id);
    expect(out[0].similarity).toBeGreaterThan(out[1].similarity);
  });

  it("sub-threshold traces are filtered out (quality gate)", async () => {
    const traceGood = makeTrace("g", [1, 0, 0, 0], 0.9);
    const traceBad = makeTrace("b", [1, 0, 0, 0], 0.5); // sub-threshold
    __seedTraceMemoryForTests([traceGood, traceBad]);

    mockedEmbedTexts.mockResolvedValueOnce([[1, 0, 0, 0]]);
    const out = await retrieveRelevantTraces("q", baseSettings(), { k: 5 });
    expect(out.length).toBe(1);
    expect(out[0].trace.id).toBe(traceGood.id);
  });

  it("query embedding failure → returns [] (no throw)", async () => {
    __seedTraceMemoryForTests([makeTrace("g", [1, 0, 0, 0], 0.9)]);
    mockedEmbedTexts.mockRejectedValueOnce(new Error("upstream"));
    const out = await retrieveRelevantTraces("q", baseSettings());
    expect(out).toEqual([]);
  });

  it("dim mismatch between query and stored embedding → trace skipped", async () => {
    // Query is 4-dim; stored trace is 3-dim. Skip cleanly, don't crash.
    const trace = makeTrace("g", [1, 0, 0], 0.9);
    __seedTraceMemoryForTests([trace]);
    mockedEmbedTexts.mockResolvedValueOnce([[1, 0, 0, 0]]);
    const out = await retrieveRelevantTraces("q", baseSettings());
    expect(out).toEqual([]);
  });
});

describe("PM #51 — formatTracesAsFewShots", () => {
  it("empty input → empty string (no marker noise in the Router prompt)", () => {
    expect(formatTracesAsFewShots([])).toBe("");
  });

  it("renders <past_successful_runs> wrapper + <example> per trace", () => {
    const traces = [
      { trace: makeTrace("first prompt", [1], 0.9), similarity: 0.95 },
      { trace: makeTrace("second prompt", [1], 0.8), similarity: 0.72 },
    ];
    const out = formatTracesAsFewShots(traces);
    expect(out).toContain("<past_successful_runs>");
    expect(out).toContain("</past_successful_runs>");
    expect(out).toContain(`<example index="1"`);
    expect(out).toContain(`<example index="2"`);
    expect(out).toContain("first prompt");
    expect(out).toContain("second prompt");
    expect(out).toContain('similarity="0.950"');
  });

  it("truncates long prompt + long answer (Router context budget)", () => {
    const longPrompt = "a".repeat(2000);
    const longAnswer = "b".repeat(2000);
    const trace: SuccessfulTrace = {
      id: "test",
      userPrompt: longPrompt,
      finalText: longAnswer,
      signals: goodSignals,
      qualityScore: 0.9,
      modelConfig: { provider: "x", model: "y" },
      capturedAt: new Date().toISOString(),
      embedding: [1],
    };
    const out = formatTracesAsFewShots([{ trace, similarity: 0.9 }]);
    // Prompt truncated to ~500, answer to ~800.
    expect(out.length).toBeLessThan(longPrompt.length + longAnswer.length);
    expect(out).toContain("…");
  });
});

function makeTrace(
  prompt: string,
  embedding: number[],
  score: number
): SuccessfulTrace {
  return {
    id: computeTraceId(prompt),
    userPrompt: prompt,
    finalText: `answer to ${prompt}`,
    signals: goodSignals,
    qualityScore: score,
    modelConfig: { provider: "openai", model: "gpt-4o" },
    capturedAt: new Date().toISOString(),
    embedding,
  };
}
