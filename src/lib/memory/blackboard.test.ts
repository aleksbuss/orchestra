/**
 * Tests for Project Blackboard — the shared-fact store powering MoA's
 * cross-agent communication (CLAUDE.md § 2 "Project Blackboard").
 *
 * Pinned invariants:
 *   - `loadBlackboard` returns [] for a missing file (fresh project).
 *   - `writeFactToBlackboard` appends, hard-caps at 500 entries (oldest
 *     evicted) — without this the file grows unbounded across a long
 *     project lifecycle.
 *   - `searchBlackboardFacts` returns top-K by cosine similarity
 *     descending. Cosine of the query embedding with itself = 1.0
 *     (perfect match).
 *   - cosineSimilarity is 0 on a zero vector (defensive against an
 *     embedder returning all-zeros).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, embed: vi.fn() };
});

vi.mock("@/lib/storage/project-store", () => ({
  getWorkDir: vi.fn(),
}));

vi.mock("@/lib/providers/llm-provider", () => ({
  createEmbeddingModel: vi.fn(() => ({})),
}));

vi.mock("@/lib/storage/settings-store", () => ({
  getSettings: vi.fn(),
}));

import {
  loadBlackboard,
  saveBlackboard,
  searchBlackboardFacts,
  writeFactToBlackboard,
  type BlackboardFact,
} from "./blackboard";
import { embed } from "ai";
import { getWorkDir } from "@/lib/storage/project-store";
import { getSettings } from "@/lib/storage/settings-store";

const mockedEmbed = vi.mocked(embed);
const mockedWorkDir = vi.mocked(getWorkDir);
const mockedSettings = vi.mocked(getSettings);

let tmpRoot: string;

function fakeFact(overrides: Partial<BlackboardFact> = {}): BlackboardFact {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    topic: overrides.topic ?? "topic",
    content: overrides.content ?? "content",
    embedding: overrides.embedding ?? [1, 0, 0],
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    author: overrides.author ?? "agent",
  };
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-bb-"));
  mockedWorkDir.mockReturnValue(tmpRoot);
  mockedSettings.mockResolvedValue({
    embeddingsModel: { provider: "openai", model: "text-embedding-3-small" },
  } as any);
  vi.clearAllMocks();
  // Re-establish mock returns after clearAllMocks.
  mockedWorkDir.mockReturnValue(tmpRoot);
  mockedSettings.mockResolvedValue({
    embeddingsModel: { provider: "openai", model: "text-embedding-3-small" },
  } as any);
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("loadBlackboard", () => {
  it("returns [] when the blackboard file does not exist (fresh project)", async () => {
    expect(await loadBlackboard("p-1")).toEqual([]);
  });

  it("returns parsed facts when the file exists", async () => {
    const facts = [fakeFact({ id: "f-1" }), fakeFact({ id: "f-2" })];
    await saveBlackboard("p-1", facts);
    const out = await loadBlackboard("p-1");
    expect(out).toHaveLength(2);
    expect(out.map((f) => f.id)).toEqual(["f-1", "f-2"]);
  });
});

describe("writeFactToBlackboard", () => {
  it("appends a new fact with a fresh id and the embedding from the SDK", async () => {
    mockedEmbed.mockResolvedValue({ embedding: [0.1, 0.2, 0.3] } as any);

    const out = await writeFactToBlackboard({
      projectId: "p-1",
      topic: "API limits",
      content: "Rate is 10 req/s",
      author: "researcher",
    });
    expect(out).toMatch(/Successfully wrote fact 'API limits'/);

    const stored = await loadBlackboard("p-1");
    expect(stored).toHaveLength(1);
    expect(stored[0].topic).toBe("API limits");
    expect(stored[0].content).toBe("Rate is 10 req/s");
    expect(stored[0].author).toBe("researcher");
    expect(stored[0].embedding).toEqual([0.1, 0.2, 0.3]);
  });

  it("calls embed with a Topic+Content payload (matches the documented format)", async () => {
    mockedEmbed.mockResolvedValue({ embedding: [0, 1] } as any);
    await writeFactToBlackboard({
      projectId: "p-1",
      topic: "T",
      content: "C",
      author: "a",
    });
    const callArg = mockedEmbed.mock.calls[0][0];
    expect((callArg as any).value).toBe("Topic: T\nContent: C");
  });

  it("hard-caps the fact list at 500 (oldest evicted on overflow)", async () => {
    // Pre-plant 500 existing facts.
    const existing = Array.from({ length: 500 }, (_, i) =>
      fakeFact({ id: `old-${i}` })
    );
    await saveBlackboard("p-1", existing);

    mockedEmbed.mockResolvedValue({ embedding: [1, 0, 0] } as any);
    await writeFactToBlackboard({
      projectId: "p-1",
      topic: "new",
      content: "new",
      author: "a",
    });

    const after = await loadBlackboard("p-1");
    expect(after).toHaveLength(500);
    // The very-oldest 'old-0' was evicted.
    expect(after[0].id).not.toBe("old-0");
    // The newest fact is at the end.
    expect(after[after.length - 1].topic).toBe("new");
  });

  it("throws when no embedding model is configured", async () => {
    mockedSettings.mockResolvedValue({} as any);
    await expect(
      writeFactToBlackboard({
        projectId: "p-1",
        topic: "x",
        content: "y",
        author: "a",
      })
    ).rejects.toThrow(/embedding model/i);
  });
});

describe("searchBlackboardFacts", () => {
  beforeEach(() => {
    mockedSettings.mockResolvedValue({
      embeddingsModel: { provider: "openai", model: "text-embedding-3-small" },
    } as any);
  });

  it("returns [] for an empty blackboard (no embedding call needed)", async () => {
    const out = await searchBlackboardFacts({ projectId: "p-1", query: "x" });
    expect(out).toEqual([]);
    expect(mockedEmbed).not.toHaveBeenCalled();
  });

  it("ranks by cosine similarity descending; identical vectors get score=1.0", async () => {
    const queryVec = [1, 0, 0];
    await saveBlackboard("p-1", [
      fakeFact({ id: "perpendicular", embedding: [0, 1, 0] }),
      fakeFact({ id: "exact-match", embedding: [1, 0, 0] }),
      fakeFact({ id: "opposite", embedding: [-1, 0, 0] }),
      fakeFact({ id: "close", embedding: [0.9, 0.4, 0] }),
    ]);
    mockedEmbed.mockResolvedValue({ embedding: queryVec } as any);

    const out = await searchBlackboardFacts({
      projectId: "p-1",
      query: "any",
      topK: 4,
    });

    expect(out.map((r) => r.topic)).toHaveLength(4);
    // exact-match is at top with score 1.0.
    expect(out[0].score).toBeCloseTo(1.0);
    // Opposite direction is at the bottom with score -1.0.
    expect(out[out.length - 1].score).toBeCloseTo(-1.0);
  });

  it("respects topK", async () => {
    await saveBlackboard("p-1", [
      fakeFact({ id: "a", embedding: [1, 0] }),
      fakeFact({ id: "b", embedding: [0.9, 0.1] }),
      fakeFact({ id: "c", embedding: [0.8, 0.2] }),
      fakeFact({ id: "d", embedding: [0.7, 0.3] }),
    ]);
    mockedEmbed.mockResolvedValue({ embedding: [1, 0] } as any);

    const out = await searchBlackboardFacts({
      projectId: "p-1",
      query: "x",
      topK: 2,
    });
    expect(out).toHaveLength(2);
  });

  it("returns score=0 for a fact with a zero-vector embedding (defensive)", async () => {
    await saveBlackboard("p-1", [
      fakeFact({ id: "zero", embedding: [0, 0, 0] }),
    ]);
    mockedEmbed.mockResolvedValue({ embedding: [1, 0, 0] } as any);

    const out = await searchBlackboardFacts({ projectId: "p-1", query: "x" });
    expect(out[0].score).toBe(0);
  });

  it("returns score=0 when query and fact embedding lengths mismatch (defensive)", async () => {
    await saveBlackboard("p-1", [
      fakeFact({ id: "wrong-dim", embedding: [1, 0] }), // 2 dims
    ]);
    mockedEmbed.mockResolvedValue({ embedding: [1, 0, 0] } as any); // 3 dims

    const out = await searchBlackboardFacts({ projectId: "p-1", query: "x" });
    expect(out[0].score).toBe(0);
  });
});

describe("abortSignal forwarding (QA audit F-12 follow-up — blackboard bypasses embedTexts)", () => {
  it("writeFactToBlackboard forwards abortSignal to the SDK embed()", async () => {
    mockedEmbed.mockResolvedValue({ embedding: [0.1, 0.2] } as any);
    const controller = new AbortController();

    await writeFactToBlackboard({
      projectId: "p-1",
      topic: "t",
      content: "c",
      author: "agent",
      abortSignal: controller.signal,
    });

    // blackboard calls the AI SDK embed() directly (not via embedTexts), so it
    // needs its own forward; an aborted agent turn must cancel this request.
    expect(mockedEmbed).toHaveBeenCalledWith(
      expect.objectContaining({ abortSignal: controller.signal })
    );
  });

  it("searchBlackboardFacts forwards abortSignal to the SDK embed()", async () => {
    await saveBlackboard("p-1", [fakeFact()]);
    mockedEmbed.mockResolvedValue({ embedding: [1, 0, 0] } as any);
    const controller = new AbortController();

    await searchBlackboardFacts({
      projectId: "p-1",
      query: "q",
      abortSignal: controller.signal,
    });

    expect(mockedEmbed).toHaveBeenCalledWith(
      expect.objectContaining({ abortSignal: controller.signal })
    );
  });
});
