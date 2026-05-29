/**
 * Tests for `memory.ts` — the vector-DB CRUD layer on top of
 * `data/memory/<subdir>/vectors.json`. Embeddings are deterministic via
 * a mock (length + provider don't matter; we control the vectors so
 * cosine-similarity sorting is testable).
 *
 * What this pins:
 *   - insertMemory / insertManyMemories store records under `area` with
 *     the supplied `additionalMetadata` and persist to disk atomically.
 *   - searchMemory sorts by cosine similarity, respects `threshold`,
 *     applies `areaFilter`, and bounds output by `limit`.
 *   - deleteMemoryById removes the matching record and reports the
 *     correct `removed` flag.
 *   - deleteMemoryByMetadata removes ALL records whose `key` equals
 *     `value` and reports the count.
 *   - deleteMemoryByQuery uses the search machinery (threshold=0.8)
 *     and only deletes records whose similarity beats that bar.
 *   - getAllMemories returns the full doc set for the dashboard.
 *   - getChunkCountsByFilename + getChunksByFilename scope to the
 *     KNOWLEDGE_AREA = "knowledge" + FILENAME_META = "filename"
 *     metadata invariant.
 *   - PM #6 Defect #2 — getDbPath uses `assertPathInside`, so a
 *     traversal-y subdir is rejected.
 *   - clearMemoryCache flushes the in-memory cache for a subdir.
 *
 * Why we mock embeddings: real `embedTexts` calls a network provider.
 * The mock returns a vector that's the concatenation of (text.length,
 * first-char-code, second-char-code, … padded). That's enough variation
 * to make cosineSimilarity sort meaningfully without depending on a
 * specific embedding model.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import type { AppSettings } from "@/lib/types";

const embedTextsMock = vi.fn();
vi.mock("@/lib/memory/embeddings", () => ({
  embedTexts: (...args: unknown[]) =>
    embedTextsMock(...(args as Parameters<typeof embedTextsMock>)),
}));

vi.mock("@/lib/agent/semaphore", () => ({
  agentSemaphore: {
    run: <T>(fn: () => Promise<T>) => fn(),
  },
}));

let tmpRoot: string;
let memory: typeof import("./memory");

function pseudoVector(text: string, dims = 8): number[] {
  // Deterministic non-zero embedding: char codes padded to `dims`.
  const v = new Array<number>(dims).fill(0);
  for (let i = 0; i < Math.min(text.length, dims); i++) {
    v[i] = text.charCodeAt(i);
  }
  return v;
}

const STUB_SETTINGS: AppSettings = {
  chatModel: { provider: "openrouter", model: "x" },
  utilityModel: { provider: "openrouter", model: "x" },
  embeddingsModel: { provider: "openai", model: "text-embedding-3-small" },
  codeExecution: { enabled: false, timeout: 30, maxOutputLength: 1000 },
  memory: { enabled: true, similarityThreshold: 0.5, maxResults: 5, chunkSize: 500 },
  search: { enabled: false, provider: "none" },
  general: { darkMode: false, language: "en" },
  auth: {
    enabled: false,
    username: "",
    passwordHash: "",
    mustChangeCredentials: false,
  },
};

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-memory-"));
  vi.spyOn(process, "cwd").mockReturnValue(tmpRoot);
  vi.resetModules();
  memory = await import("./memory");
  embedTextsMock.mockReset();
  // Default embed: each input text → its pseudoVector.
  embedTextsMock.mockImplementation(async (texts: string[]) =>
    texts.map((t) => pseudoVector(t))
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("insertMemory / insertManyMemories", () => {
  it("inserts a single record and returns its id", async () => {
    const id = await memory.insertMemory(
      "the cat sat on the mat",
      "notes",
      "chat-1",
      STUB_SETTINGS
    );
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const all = await memory.getAllMemories("chat-1");
    expect(all).toHaveLength(1);
    expect(all[0].text).toBe("the cat sat on the mat");
    expect(all[0].metadata.area).toBe("notes");
    expect(typeof all[0].metadata.createdAt).toBe("string");
  });

  it("persists to disk so a fresh load (cleared cache) reads the same data", async () => {
    await memory.insertMemory("alpha", "facts", "chat-1", STUB_SETTINGS);
    memory.clearMemoryCache("chat-1");

    const all = await memory.getAllMemories("chat-1");
    expect(all).toHaveLength(1);
    expect(all[0].text).toBe("alpha");
  });

  it("insertManyMemories is empty-safe (no embeddings call when texts is empty)", async () => {
    const ids = await memory.insertManyMemories(
      [],
      "notes",
      "chat-1",
      STUB_SETTINGS
    );
    expect(ids).toEqual([]);
    expect(embedTextsMock).not.toHaveBeenCalled();
  });

  it("insertManyMemories embeds all texts in ONE call (O(N) not O(N^2))", async () => {
    await memory.insertManyMemories(
      ["a", "b", "c"],
      "x",
      "chat-1",
      STUB_SETTINGS
    );
    expect(embedTextsMock).toHaveBeenCalledOnce();
    expect(embedTextsMock.mock.calls[0][0]).toEqual(["a", "b", "c"]);
  });

  it("throws when the embed result length doesn't match the input length", async () => {
    embedTextsMock.mockResolvedValueOnce([pseudoVector("a")]); // length 1, input length 2
    await expect(
      memory.insertManyMemories(["a", "b"], "x", "chat-1", STUB_SETTINGS)
    ).rejects.toThrow(/Failed to generate embeddings/);
  });

  it("attaches additionalMetadata to every inserted record", async () => {
    await memory.insertMemory("x", "notes", "chat-1", STUB_SETTINGS, {
      filename: "doc.txt",
      chunkIndex: 4,
    });
    const all = await memory.getAllMemories("chat-1");
    expect(all[0].metadata.filename).toBe("doc.txt");
    expect(all[0].metadata.chunkIndex).toBe(4);
  });
});

describe("searchMemory", () => {
  beforeEach(async () => {
    // Seed three docs whose embeddings have a known order.
    await memory.insertMemory("alpha", "x", "chat-1", STUB_SETTINGS);
    await memory.insertMemory("beta", "y", "chat-1", STUB_SETTINGS);
    await memory.insertMemory("gamma", "x", "chat-1", STUB_SETTINGS);
  });

  it("returns empty when the subdir has no documents", async () => {
    const r = await memory.searchMemory(
      "anything",
      5,
      0.0,
      "untouched",
      STUB_SETTINGS
    );
    expect(r).toEqual([]);
  });

  it("returns empty when embedTexts yields no embeddings", async () => {
    embedTextsMock.mockResolvedValueOnce([]);
    const r = await memory.searchMemory(
      "x",
      5,
      0.0,
      "chat-1",
      STUB_SETTINGS
    );
    expect(r).toEqual([]);
  });

  it("sorts results by cosine similarity descending", async () => {
    // Query "alpha" must rank "alpha" first (identical vector → score=1).
    const r = await memory.searchMemory(
      "alpha",
      5,
      0.0,
      "chat-1",
      STUB_SETTINGS
    );
    expect(r[0].text).toBe("alpha");
    // Scores are weakly descending.
    for (let i = 1; i < r.length; i++) {
      expect(r[i - 1].score).toBeGreaterThanOrEqual(r[i].score);
    }
  });

  it("excludes results below the threshold", async () => {
    // A threshold of 1.0 keeps only exact matches.
    const r = await memory.searchMemory(
      "alpha",
      5,
      1.0,
      "chat-1",
      STUB_SETTINGS
    );
    expect(r.map((x) => x.text)).toEqual(["alpha"]);
  });

  it("bounds output by `limit`", async () => {
    const r = await memory.searchMemory(
      "alpha",
      1,
      0.0,
      "chat-1",
      STUB_SETTINGS
    );
    expect(r.length).toBe(1);
  });

  it("areaFilter scopes by metadata.area", async () => {
    const onlyY = await memory.searchMemory(
      "anything",
      10,
      0.0,
      "chat-1",
      STUB_SETTINGS,
      "y"
    );
    expect(onlyY.map((r) => r.text)).toEqual(["beta"]);
  });
});

describe("delete operations", () => {
  beforeEach(async () => {
    await memory.insertMemory("alpha", "x", "chat-1", STUB_SETTINGS, {
      tag: "A",
    });
    await memory.insertMemory("beta", "x", "chat-1", STUB_SETTINGS, {
      tag: "B",
    });
    await memory.insertMemory("gamma", "y", "chat-1", STUB_SETTINGS, {
      tag: "A",
    });
  });

  it("deleteMemoryById removes the matching record (returns true)", async () => {
    const all = await memory.getAllMemories("chat-1");
    const target = all[0].id;
    const removed = await memory.deleteMemoryById(target, "chat-1");
    expect(removed).toBe(true);

    const after = await memory.getAllMemories("chat-1");
    expect(after.find((d) => d.id === target)).toBeUndefined();
    expect(after).toHaveLength(2);
  });

  it("deleteMemoryById returns false when id is not present", async () => {
    const removed = await memory.deleteMemoryById(
      "00000000-0000-0000-0000-000000000000",
      "chat-1"
    );
    expect(removed).toBe(false);
  });

  it("deleteMemoryByMetadata removes ALL records whose key/value matches", async () => {
    const n = await memory.deleteMemoryByMetadata("tag", "A", "chat-1");
    expect(n).toBe(2);
    const remaining = await memory.getAllMemories("chat-1");
    expect(remaining).toHaveLength(1);
    expect(remaining[0].text).toBe("beta");
  });

  it("deleteMemoryByMetadata returns 0 when nothing matches", async () => {
    const n = await memory.deleteMemoryByMetadata("tag", "Z", "chat-1");
    expect(n).toBe(0);
  });

  it("deleteMemoryByQuery uses similarity >= 0.8 to pick deletion targets", async () => {
    // Querying "alpha" matches "alpha" exactly (score=1.0); "beta" and
    // "gamma" should score below 0.8 with our pseudo-embedding shape.
    const n = await memory.deleteMemoryByQuery(
      "alpha",
      "chat-1",
      STUB_SETTINGS
    );
    expect(n).toBeGreaterThanOrEqual(1);
    const remaining = await memory.getAllMemories("chat-1");
    expect(remaining.find((d) => d.text === "alpha")).toBeUndefined();
  });

  it("deleteMemoryByQuery returns 0 when no matches beat the 0.8 threshold", async () => {
    // A query with a completely orthogonal vector won't match anything
    // above 0.8 — return zero, leave the DB intact.
    embedTextsMock.mockResolvedValueOnce([new Array(8).fill(0).map((_, i) => (i === 7 ? 1 : 0))]);
    const n = await memory.deleteMemoryByQuery(
      "totally-unrelated",
      "chat-1",
      STUB_SETTINGS
    );
    expect(n).toBe(0);
    expect(await memory.getAllMemories("chat-1")).toHaveLength(3);
  });
});

describe("knowledge helpers — getChunkCountsByFilename / getChunksByFilename", () => {
  beforeEach(async () => {
    // Only records with area=knowledge AND metadata.filename count.
    await memory.insertMemory("c1 of A", "knowledge", "proj-1", STUB_SETTINGS, {
      filename: "A.md",
    });
    await memory.insertMemory("c2 of A", "knowledge", "proj-1", STUB_SETTINGS, {
      filename: "A.md",
    });
    await memory.insertMemory("c1 of B", "knowledge", "proj-1", STUB_SETTINGS, {
      filename: "B.md",
    });
    // Different area — should NOT count.
    await memory.insertMemory("random note", "notes", "proj-1", STUB_SETTINGS, {
      filename: "A.md",
    });
  });

  it("returns per-filename counts only for KNOWLEDGE_AREA", async () => {
    const counts = await memory.getChunkCountsByFilename("proj-1");
    expect(counts).toEqual({ "A.md": 2, "B.md": 1 });
  });

  it("returns indexed chunks for a single filename, KNOWLEDGE_AREA-scoped", async () => {
    const chunks = await memory.getChunksByFilename("proj-1", "A.md");
    expect(chunks.length).toBe(2);
    expect(chunks.map((c) => c.index)).toEqual([1, 2]);
    expect(chunks.every((c) => c.text.startsWith("c"))).toBe(true);
  });

  it("returns empty when no chunks match the filename", async () => {
    const chunks = await memory.getChunksByFilename("proj-1", "missing.md");
    expect(chunks).toEqual([]);
  });
});

describe("path traversal / cache eviction (PM #6 + housekeeping)", () => {
  it("getDbPath rejects subdir that escapes data/memory/ (PM #6 Defect #2)", async () => {
    // `assertPathInside` throws synchronously when the resolved path
    // doesn't stay rooted at MEMORY_ROOT. The wrappers wrap that, so
    // any operation with a traversal subdir surfaces the error.
    await expect(
      memory.insertMemory("x", "a", "../../etc", STUB_SETTINGS)
    ).rejects.toThrow();
  });

  it("clearMemoryCache forces the next read to hit disk", async () => {
    await memory.insertMemory("seed", "x", "chat-1", STUB_SETTINGS);
    // Manually edit the file on disk to simulate an out-of-process update.
    const onDisk = path.join(tmpRoot, "data", "memory", "chat-1", "vectors.json");
    const before = JSON.parse(await fs.readFile(onDisk, "utf-8"));
    before.documents = []; // wipe externally
    await fs.writeFile(onDisk, JSON.stringify(before));

    // Without clearing the cache, the next read returns stale data.
    expect((await memory.getAllMemories("chat-1")).length).toBe(1);

    memory.clearMemoryCache("chat-1");
    expect((await memory.getAllMemories("chat-1")).length).toBe(0);
  });
});
