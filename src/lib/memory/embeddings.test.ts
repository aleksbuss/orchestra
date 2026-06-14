/**
 * Tests for `embedTexts` — the only entry point through which RAG and
 * Project Blackboard generate embeddings.
 *
 * Why this is worth testing despite being a thin SDK wrapper:
 *   - The "mock" provider branch is the test-without-API-keys path; without
 *     it, every memory test in this codebase would need a real OpenAI key.
 *     A regression there silently breaks development for everyone.
 *   - The single-text vs. multi-text branch must keep using `embed()` for
 *     N=1 and `embedMany()` for N>1. Vercel SDK's `embed()` returns
 *     `{embedding}` (singular); `embedMany()` returns `{embeddings}`. A
 *     refactor that uses one for both would crash at runtime.
 *   - Errors must propagate as the wrapped "Failed to generate embeddings"
 *     string. The RAG path classifies on this prefix to decide retry.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    embed: vi.fn(),
    embedMany: vi.fn(),
  };
});

vi.mock("@/lib/providers/llm-provider", () => ({
  createEmbeddingModel: vi.fn(() => ({ /* opaque model handle */ })),
}));

import { embedTexts } from "./embeddings";
import { embed, embedMany } from "ai";

const mockedEmbed = vi.mocked(embed);
const mockedEmbedMany = vi.mocked(embedMany);

beforeEach(() => {
  vi.clearAllMocks();
});

const baseConfig = {
  provider: "openai",
  model: "text-embedding-3-small",
  apiKey: "test-key",
};

describe("embedTexts — mock provider (zero-API-key path)", () => {
  it("returns random unit-norm vectors of the requested dimension", async () => {
    const out = await embedTexts(["a", "b", "c"], {
      provider: "mock",
      model: "mock-embed",
      dimensions: 64,
    });

    expect(out).toHaveLength(3);
    for (const vec of out) {
      expect(vec).toHaveLength(64);
      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
      // Should be normalized to unit length (~1.0 within float tolerance).
      expect(norm).toBeCloseTo(1, 3);
    }
  });

  it("defaults to 1536 dimensions when not provided (matches OpenAI's small)", async () => {
    const out = await embedTexts(["x"], { provider: "mock", model: "m" });
    expect(out[0]).toHaveLength(1536);
  });

  it("does NOT call the AI SDK on the mock path", async () => {
    await embedTexts(["a"], { provider: "mock", model: "m", dimensions: 8 });
    expect(mockedEmbed).not.toHaveBeenCalled();
    expect(mockedEmbedMany).not.toHaveBeenCalled();
  });

  it("returns an empty array for an empty input on mock provider", async () => {
    const out = await embedTexts([], { provider: "mock", model: "m", dimensions: 8 });
    expect(out).toEqual([]);
  });
});

describe("embedTexts — real provider routing (single vs. batch)", () => {
  it("uses `embed()` (singular) for exactly one text", async () => {
    mockedEmbed.mockResolvedValue({ embedding: [0.1, 0.2, 0.3] } as any);
    const out = await embedTexts(["hello"], baseConfig);

    expect(mockedEmbed).toHaveBeenCalledOnce();
    expect(mockedEmbedMany).not.toHaveBeenCalled();
    expect(out).toEqual([[0.1, 0.2, 0.3]]);
  });

  it("uses `embedMany()` for two or more texts", async () => {
    mockedEmbedMany.mockResolvedValue({
      embeddings: [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
    } as any);
    const out = await embedTexts(["a", "b"], baseConfig);

    expect(mockedEmbedMany).toHaveBeenCalledOnce();
    expect(mockedEmbed).not.toHaveBeenCalled();
    expect(out).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
  });
});

describe("embedTexts — error wrapping", () => {
  it("wraps SDK errors with a stable 'Failed to generate embeddings:' prefix", async () => {
    mockedEmbed.mockRejectedValue(new Error("API key invalid"));
    await expect(embedTexts(["x"], baseConfig)).rejects.toThrow(
      /Failed to generate embeddings: API key invalid/
    );
  });

  it("wraps non-Error throws (string, undefined) without crashing", async () => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    mockedEmbed.mockRejectedValue("plain string");
    await expect(embedTexts(["x"], baseConfig)).rejects.toThrow(
      /Failed to generate embeddings: plain string/
    );
  });
});

describe("embedTexts — abortSignal forwarding (QA audit F-12 / PM #23)", () => {
  it("forwards the abortSignal to embed() on the single-text path", async () => {
    mockedEmbed.mockResolvedValue({ embedding: [0.1] } as any);
    const controller = new AbortController();

    await embedTexts(["hello"], baseConfig, { abortSignal: controller.signal });

    // The whole point of F-12: an aborted turn must cancel the in-flight
    // embedding request, which only happens if the signal reaches the SDK.
    expect(mockedEmbed).toHaveBeenCalledWith(
      expect.objectContaining({ abortSignal: controller.signal })
    );
  });

  it("forwards the abortSignal to embedMany() on the batch path", async () => {
    mockedEmbedMany.mockResolvedValue({ embeddings: [[0.1], [0.2]] } as any);
    const controller = new AbortController();

    await embedTexts(["a", "b"], baseConfig, { abortSignal: controller.signal });

    expect(mockedEmbedMany).toHaveBeenCalledWith(
      expect.objectContaining({ abortSignal: controller.signal })
    );
  });

  it("short-circuits an already-aborted signal BEFORE touching the SDK", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      embedTexts(["x"], baseConfig, { abortSignal: controller.signal })
    ).rejects.toThrow();
    expect(mockedEmbed).not.toHaveBeenCalled();
    expect(mockedEmbedMany).not.toHaveBeenCalled();
  });

  it("propagates the abort error raw — NOT wrapped as an embedding failure", async () => {
    const controller = new AbortController();
    const abortErr = new DOMException("The operation was aborted.", "AbortError");
    mockedEmbed.mockImplementation(async () => {
      controller.abort();
      throw abortErr;
    });

    // Cancellation must stay distinguishable from a real provider error, so
    // the catch re-throws as-is instead of the "Failed to generate…" wrapper.
    await expect(
      embedTexts(["x"], baseConfig, { abortSignal: controller.signal })
    ).rejects.toBe(abortErr);
  });
});
