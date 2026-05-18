/**
 * Tests for `knowledge.ts` — the ingestion pipeline that feeds the
 * loader output into the vector DB.
 *
 * Three exported functions:
 *   - `importKnowledge(dir, subdir, settings)` — sweep a directory.
 *   - `importKnowledgeFile(dir, subdir, settings, filename)` — single
 *     file (used by upload). Re-imports = delete-then-insert (no dup
 *     chunks).
 *   - `queryKnowledge(query, limit, subdirs, settings)` — RAG query
 *     across multiple subdirs, with dedupe and relevance formatting.
 *
 * Pinned invariants:
 *   - Only the SUPPORTED_EXTENSIONS set (22+) gets ingested; anything
 *     else is `skipped++`. Adding a new extension to `loaders/index.ts`
 *     without updating this set means the loader exists but ingestion
 *     never calls it.
 *   - Re-import deletes prior chunks tagged with the filename FIRST,
 *     then inserts. A failure of the delete is non-fatal (continues to
 *     insert) — preserves the operator's ability to recover from a
 *     partially-corrupted prior state.
 *   - Empty / null loader output → `skipped++`, NOT an error. (PDFs
 *     with no extractable text exist legitimately.)
 *   - Per-file errors are accumulated in `result.errors` but don't
 *     short-circuit the rest of the directory.
 *   - Missing knowledgeDir → returns the empty result object (NOT
 *     an exception). Callers don't have to existence-check first.
 *   - `queryKnowledge` dedupes by exact text content, sorts by score
 *     descending, formats with `(relevance: <pct>%)`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import type { AppSettings } from "@/lib/types";

// ────────────────────────────────────────────────────────────
// Module mocks
// ────────────────────────────────────────────────────────────

vi.mock("@/lib/memory/memory", () => ({
  insertMemory: vi.fn(),
  insertManyMemories: vi.fn(),
  searchMemory: vi.fn(),
  deleteMemoryByMetadata: vi.fn(),
}));

vi.mock("@/lib/memory/loaders", () => ({
  loadDocument: vi.fn(),
}));

import {
  importKnowledge,
  importKnowledgeFile,
  queryKnowledge,
} from "./knowledge";
import {
  deleteMemoryByMetadata,
  insertManyMemories,
  searchMemory,
} from "@/lib/memory/memory";
import { loadDocument } from "@/lib/memory/loaders";

const mockedDelete = vi.mocked(deleteMemoryByMetadata);
const mockedInsertMany = vi.mocked(insertManyMemories);
const mockedSearch = vi.mocked(searchMemory);
const mockedLoad = vi.mocked(loadDocument);

const fakeSettings = (chunkSize = 200): AppSettings =>
  ({
    memory: {
      enabled: true,
      similarityThreshold: 0.4,
      maxResults: 10,
      chunkSize,
    },
  } as AppSettings);

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-knowledge-"));
  vi.clearAllMocks();
  mockedDelete.mockResolvedValue(0);
  mockedInsertMany.mockResolvedValue([] as never);
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────
// importKnowledge
// ────────────────────────────────────────────────────────────

describe("importKnowledge — directory sweep", () => {
  it("returns the empty result when the directory does not exist (no throw)", async () => {
    const out = await importKnowledge(
      path.join(tmpRoot, "nope"),
      "main",
      fakeSettings()
    );
    expect(out).toEqual({ imported: 0, skipped: 0, errors: [] });
    expect(mockedLoad).not.toHaveBeenCalled();
  });

  it("ingests every supported file and counts inserted chunks", async () => {
    await fs.writeFile(path.join(tmpRoot, "a.txt"), "x", "utf-8");
    await fs.writeFile(path.join(tmpRoot, "b.md"), "y", "utf-8");

    mockedLoad.mockImplementation(async (filePath: string) => ({
      text: `loaded text for ${path.basename(filePath)}`,
      metadata: {},
    }));

    const out = await importKnowledge(tmpRoot, "main", fakeSettings(1000));
    // Each file's loaded text fits in one chunk → 1 insert per file.
    expect(out.imported).toBe(2);
    expect(out.skipped).toBe(0);
    expect(out.errors).toEqual([]);
  });

  it("skips unsupported extensions (counts them in `skipped`)", async () => {
    await fs.writeFile(path.join(tmpRoot, "data.bin"), "x");
    await fs.writeFile(path.join(tmpRoot, "music.mp3"), "x");
    await fs.writeFile(path.join(tmpRoot, "ok.txt"), "y", "utf-8");

    mockedLoad.mockResolvedValue({ text: "y", metadata: {} });

    const out = await importKnowledge(tmpRoot, "main", fakeSettings());
    expect(out.skipped).toBe(2);
    expect(out.imported).toBe(1);
    expect(mockedLoad).toHaveBeenCalledTimes(1);
  });

  it("ignores subdirectories (only processes files at the top level)", async () => {
    await fs.mkdir(path.join(tmpRoot, "subdir"), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, "subdir", "nested.txt"),
      "x",
      "utf-8"
    );
    await fs.writeFile(path.join(tmpRoot, "top.txt"), "y", "utf-8");

    mockedLoad.mockResolvedValue({ text: "y", metadata: {} });

    const out = await importKnowledge(tmpRoot, "main", fakeSettings());
    expect(out.imported).toBe(1);
    expect(mockedLoad).toHaveBeenCalledTimes(1);
  });

  it("skips files where the loader returns null", async () => {
    await fs.writeFile(path.join(tmpRoot, "broken.pdf"), "x");
    mockedLoad.mockResolvedValue(null);

    const out = await importKnowledge(tmpRoot, "main", fakeSettings());
    expect(out.skipped).toBe(1);
    expect(out.imported).toBe(0);
  });

  it("skips files whose loaded text is whitespace-only", async () => {
    await fs.writeFile(path.join(tmpRoot, "blank.txt"), "x", "utf-8");
    mockedLoad.mockResolvedValue({ text: "   \n\t  ", metadata: {} });

    const out = await importKnowledge(tmpRoot, "main", fakeSettings());
    expect(out.skipped).toBe(1);
    expect(out.imported).toBe(0);
  });

  it("collects per-file errors without short-circuiting", async () => {
    await fs.writeFile(path.join(tmpRoot, "ok.txt"), "x", "utf-8");
    await fs.writeFile(path.join(tmpRoot, "bad.txt"), "x", "utf-8");
    await fs.writeFile(path.join(tmpRoot, "also-ok.txt"), "x", "utf-8");

    mockedLoad.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith("bad.txt")) {
        throw new Error("malformed file");
      }
      return { text: "y", metadata: {} };
    });

    const out = await importKnowledge(tmpRoot, "main", fakeSettings());
    expect(out.imported).toBe(2);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toMatch(/Error processing bad\.txt/);
    expect(out.errors[0]).toMatch(/malformed file/);
  });

  it("deletes prior chunks for each filename BEFORE inserting (re-import = no dups)", async () => {
    await fs.writeFile(path.join(tmpRoot, "doc.txt"), "x", "utf-8");
    mockedLoad.mockResolvedValue({ text: "content", metadata: {} });

    await importKnowledge(tmpRoot, "main", fakeSettings());

    expect(mockedDelete).toHaveBeenCalledOnce();
    expect(mockedDelete).toHaveBeenCalledWith("filename", "doc.txt", "main");
    // Insert should fire AFTER the delete — verify by call order.
    expect(mockedDelete.mock.invocationCallOrder[0]).toBeLessThan(
      mockedInsertMany.mock.invocationCallOrder[0]
    );
  });

  it("non-fatally swallows deleteMemoryByMetadata errors (continues with insert)", async () => {
    await fs.writeFile(path.join(tmpRoot, "doc.txt"), "x", "utf-8");
    mockedDelete.mockRejectedValue(new Error("delete failed"));
    mockedLoad.mockResolvedValue({ text: "content", metadata: {} });

    const out = await importKnowledge(tmpRoot, "main", fakeSettings());
    expect(out.errors).toEqual([]); // delete failure is silent
    expect(out.imported).toBe(1);
    expect(mockedInsertMany).toHaveBeenCalledOnce();
  });

  it("forwards filename in metadata so future re-imports can target the same chunks", async () => {
    await fs.writeFile(path.join(tmpRoot, "report.txt"), "x", "utf-8");
    mockedLoad.mockResolvedValue({ text: "report content", metadata: {} });

    await importKnowledge(tmpRoot, "main", fakeSettings());

    const insertArgs = mockedInsertMany.mock.calls[0];
    // Args: chunks, area, subdir, settings, metadata
    expect(insertArgs[1]).toBe("knowledge");
    expect(insertArgs[2]).toBe("main");
    expect(insertArgs[4]).toEqual({ filename: "report.txt" });
  });
});

// ────────────────────────────────────────────────────────────
// importKnowledgeFile
// ────────────────────────────────────────────────────────────

describe("importKnowledgeFile — single-file path", () => {
  it("counts a single file's chunks without sweeping the directory", async () => {
    await fs.writeFile(path.join(tmpRoot, "a.txt"), "x", "utf-8");
    await fs.writeFile(path.join(tmpRoot, "b.txt"), "y", "utf-8");

    mockedLoad.mockResolvedValue({ text: "loaded", metadata: {} });

    const out = await importKnowledgeFile(
      tmpRoot,
      "main",
      fakeSettings(),
      "a.txt"
    );
    expect(out.imported).toBe(1);
    expect(out.skipped).toBe(0);
    expect(mockedLoad).toHaveBeenCalledOnce();
  });

  it("returns skipped++ for an unsupported extension", async () => {
    const out = await importKnowledgeFile(
      tmpRoot,
      "main",
      fakeSettings(),
      "track.mp3"
    );
    expect(out.skipped).toBe(1);
    expect(mockedLoad).not.toHaveBeenCalled();
  });

  it("returns errors[] entry when the loader throws", async () => {
    await fs.writeFile(path.join(tmpRoot, "bad.pdf"), "x");
    mockedLoad.mockRejectedValue(new Error("malformed pdf"));

    const out = await importKnowledgeFile(
      tmpRoot,
      "main",
      fakeSettings(),
      "bad.pdf"
    );
    expect(out.imported).toBe(0);
    expect(out.errors[0]).toMatch(/Error processing bad\.pdf/);
  });
});

// ────────────────────────────────────────────────────────────
// queryKnowledge
// ────────────────────────────────────────────────────────────

describe("queryKnowledge — RAG retrieval", () => {
  it("returns the documented 'no results' string when nothing matches", async () => {
    mockedSearch.mockResolvedValue([]);
    const out = await queryKnowledge("anything", 5, ["main"], fakeSettings());
    expect(out).toBe("No relevant documents found in the knowledge base.");
  });

  it("queries every subdir with the documented 'knowledge' area tag", async () => {
    mockedSearch.mockImplementation(async (q, limit, threshold, subdir) => [
      { text: `from ${subdir}`, score: 0.9, metadata: { subdir } },
    ]);

    await queryKnowledge("q", 5, ["main", "proj-1", "proj-2"], fakeSettings());
    expect(mockedSearch).toHaveBeenCalledTimes(3);
    // Every call passes "knowledge" as the area filter (arg 5).
    // Without this, RAG would also return memory entries written by the
    // memory_save tool — wrong scope.
    for (const call of mockedSearch.mock.calls) {
      expect(call[5]).toBe("knowledge");
    }
  });

  it("sorts results by score descending; formats with (relevance: <pct>%)", async () => {
    mockedSearch.mockResolvedValueOnce([
      { text: "low score", score: 0.5, metadata: {} },
      { text: "high score", score: 0.95, metadata: {} },
    ]);

    const out = await queryKnowledge("q", 5, ["main"], fakeSettings());
    expect(out).toContain("Document 1");
    expect(out).toContain("Document 2");
    // High-score result comes first.
    expect(out.indexOf("high score")).toBeLessThan(out.indexOf("low score"));
    expect(out).toContain("relevance: 95.0%");
    expect(out).toContain("relevance: 50.0%");
  });

  it("dedupes by exact text content (multiple subdirs with the same chunk = single result)", async () => {
    // Two subdirs return the same chunk text.
    mockedSearch.mockImplementation(async () => [
      { text: "shared chunk", score: 0.8, metadata: {} },
    ]);

    const out = await queryKnowledge(
      "q",
      5,
      ["main", "proj-1"],
      fakeSettings()
    );
    // Only ONE "Document N" header should appear despite both subdirs hitting.
    const matches = out.match(/Document \d+/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("respects the `limit` after dedupe", async () => {
    mockedSearch.mockResolvedValueOnce([
      { text: "a", score: 0.9, metadata: {} },
      { text: "b", score: 0.85, metadata: {} },
      { text: "c", score: 0.8, metadata: {} },
      { text: "d", score: 0.75, metadata: {} },
    ]);

    const out = await queryKnowledge("q", 2, ["main"], fakeSettings());
    const matches = out.match(/Document \d+/g) ?? [];
    expect(matches).toHaveLength(2);
    // First two by score: a and b.
    expect(out).toContain("Document 1");
    expect(out).toContain("Document 2");
    expect(out).not.toContain("Document 3");
  });

  it("silently skips a subdir whose searchMemory throws", async () => {
    mockedSearch.mockImplementationOnce(async () => {
      throw new Error("subdir does not exist yet");
    });
    mockedSearch.mockImplementationOnce(async () => [
      { text: "from-good", score: 0.9, metadata: {} },
    ]);

    const out = await queryKnowledge(
      "q",
      5,
      ["bad", "good"],
      fakeSettings()
    );
    expect(out).toContain("from-good");
    expect(out).not.toContain("Error");
  });
});
