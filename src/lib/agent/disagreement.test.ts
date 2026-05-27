/**
 * PM #39 — disagreement detector contracts.
 *
 * What we pin:
 *   - Identical drafts → cosine distance ~0 → not detected.
 *   - Substantively different drafts → cosine distance > threshold → detected.
 *   - Fewer than 2 drafts → no signal (no pairs to compare).
 *   - Embedding failure → no signal (non-fatal, MoA continues with default).
 *   - buildDisagreementMarker returns empty string when not detected
 *     (caller can prepend unconditionally).
 *   - buildDisagreementMarker contains the synthesizer instructions when
 *     detected — the aggregator LLM must see them.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@/lib/types";

vi.mock("@/lib/memory/embeddings", () => ({
  embedTexts: vi.fn(),
}));

import { embedTexts } from "@/lib/memory/embeddings";
import {
  buildDisagreementMarker,
  DEFAULT_DISAGREEMENT_THRESHOLD,
  detectDisagreement,
} from "./disagreement";

const mockedEmbedTexts = vi.mocked(embedTexts);

function settings(): AppSettings {
  return {
    chatModel: { provider: "openai", model: "gpt-4o" },
    utilityModel: { provider: "openai", model: "gpt-4o-mini" },
    embeddingsModel: {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 4,
    },
    codeExecution: { enabled: true, timeout: 600, maxOutputLength: 120000 },
    memory: { enabled: true, similarityThreshold: 0.35, maxResults: 10, chunkSize: 400 },
    search: { enabled: false, provider: "none" },
    general: { darkMode: false, language: "en" },
    auth: {
      enabled: true,
      username: "admin",
      passwordHash: "scrypt$x$y",
      mustChangeCredentials: false,
    },
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("PM #39 — detectDisagreement", () => {
  it("< 2 drafts → ranSuccessfully=false, no detection (nothing to compare)", async () => {
    const result = await detectDisagreement(
      [{ text: "only one draft", role: "analyst" }],
      settings()
    );
    expect(result.ranSuccessfully).toBe(false);
    expect(result.detected).toBe(false);
    expect(result.pairCount).toBe(0);
    // The embedder is never invoked when there's nothing to compare.
    expect(mockedEmbedTexts).not.toHaveBeenCalled();
  });

  it("identical embeddings → cosine distance 0 → NOT detected", async () => {
    // Three identical unit vectors. Cosine sim = 1, distance = 0.
    mockedEmbedTexts.mockResolvedValueOnce([
      [1, 0, 0, 0],
      [1, 0, 0, 0],
      [1, 0, 0, 0],
    ]);
    const result = await detectDisagreement(
      [
        { text: "a", role: "p1" },
        { text: "b", role: "p2" },
        { text: "c", role: "p3" },
      ],
      settings()
    );
    expect(result.ranSuccessfully).toBe(true);
    expect(result.maxDistance).toBeCloseTo(0, 5);
    expect(result.detected).toBe(false);
    expect(result.pairCount).toBe(3); // C(3,2)
  });

  it("orthogonal embeddings → cosine distance 1.0 → detected at default threshold", async () => {
    // Three orthogonal unit vectors. Cosine sim = 0, distance = 1.0.
    mockedEmbedTexts.mockResolvedValueOnce([
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
    ]);
    const result = await detectDisagreement(
      [
        { text: "use React hooks", role: "p1" },
        { text: "use Zustand", role: "p2" },
        { text: "use class components", role: "p3" },
      ],
      settings()
    );
    expect(result.maxDistance).toBeCloseTo(1.0, 5);
    expect(result.detected).toBe(true);
    expect(result.threshold).toBe(DEFAULT_DISAGREEMENT_THRESHOLD);
  });

  it("borderline distance (0.4) crosses the default threshold (0.35) → detected", async () => {
    // Constructed so cosine sim = 0.6 → distance = 0.4.
    // [1,0,0,0] vs [0.6, 0.8, 0, 0]: dot = 0.6, |a|=1, |b|=1, sim=0.6, dist=0.4.
    mockedEmbedTexts.mockResolvedValueOnce([
      [1, 0, 0, 0],
      [0.6, 0.8, 0, 0],
    ]);
    const result = await detectDisagreement(
      [
        { text: "perspective A", role: "p1" },
        { text: "perspective B", role: "p2" },
      ],
      settings()
    );
    expect(result.maxDistance).toBeCloseTo(0.4, 5);
    expect(result.detected).toBe(true);
  });

  it("custom threshold above the actual distance → NOT detected", async () => {
    mockedEmbedTexts.mockResolvedValueOnce([
      [1, 0, 0, 0],
      [0.6, 0.8, 0, 0],
    ]);
    const result = await detectDisagreement(
      [
        { text: "p1 text", role: "p1" },
        { text: "p2 text", role: "p2" },
      ],
      settings(),
      0.5 // higher threshold; 0.4 distance is now BELOW
    );
    expect(result.maxDistance).toBeCloseTo(0.4, 5);
    expect(result.detected).toBe(false);
  });

  it("embedding failure → ranSuccessfully=false, non-fatal", async () => {
    mockedEmbedTexts.mockRejectedValueOnce(new Error("embedding API down"));
    const result = await detectDisagreement(
      [
        { text: "x", role: "p1" },
        { text: "y", role: "p2" },
      ],
      settings()
    );
    expect(result.ranSuccessfully).toBe(false);
    expect(result.detected).toBe(false);
  });

  it("embedding count mismatch (provider returned fewer vectors) → ranSuccessfully=false", async () => {
    // Asked for 3, embedder only returned 2.
    mockedEmbedTexts.mockResolvedValueOnce([
      [1, 0, 0, 0],
      [0, 1, 0, 0],
    ]);
    const result = await detectDisagreement(
      [
        { text: "a", role: "p1" },
        { text: "b", role: "p2" },
        { text: "c", role: "p3" },
      ],
      settings()
    );
    expect(result.ranSuccessfully).toBe(false);
    expect(result.detected).toBe(false);
  });

  it("draft text is truncated to keep embedding cost bounded", async () => {
    const long = "x".repeat(10_000);
    mockedEmbedTexts.mockResolvedValueOnce([
      [1, 0, 0, 0],
      [1, 0, 0, 0],
    ]);
    await detectDisagreement(
      [
        { text: long, role: "p1" },
        { text: long, role: "p2" },
      ],
      settings()
    );
    const callArgs = mockedEmbedTexts.mock.calls[0][0];
    // Each input must be ≤ EMBED_DRAFT_CHAR_CAP (= 4000).
    for (const input of callArgs) {
      expect(input.length).toBeLessThanOrEqual(4000);
    }
  });
});

describe("PM #39 — buildDisagreementMarker", () => {
  it("returns empty string when NOT detected (caller can prepend unconditionally)", () => {
    const marker = buildDisagreementMarker({
      maxDistance: 0.1,
      averageDistance: 0.1,
      detected: false,
      threshold: 0.35,
      pairCount: 3,
      ranSuccessfully: true,
    });
    expect(marker).toBe("");
  });

  it("returns synthesizer instructions when detected", () => {
    const marker = buildDisagreementMarker({
      maxDistance: 0.5,
      averageDistance: 0.4,
      detected: true,
      threshold: 0.35,
      pairCount: 6,
      ranSuccessfully: true,
    });
    expect(marker).toContain("<<DISAGREEMENT_DETECTED>>");
    expect(marker).toContain("DIVERGE significantly");
    expect(marker).toContain("0.50"); // formatted maxDistance
    expect(marker).toContain("<<END_DISAGREEMENT_DETECTED>>");
    // Instructions to the synthesizer.
    expect(marker).toMatch(/Identify the specific point/i);
    expect(marker).toMatch(/Do NOT silently pick one side/i);
  });
});
