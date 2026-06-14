/**
 * Tests for /api/projects/[id]/knowledge — GET (list), POST (upload+ingest),
 * DELETE (file+vectors).
 *
 * The route reads/writes to data/projects/<id>/.meta/knowledge/ via raw
 * fs APIs and process.cwd(). We pin cwd to a per-test tmp dir so the
 * route's real filesystem code paths exercise without polluting the repo.
 *
 * Pinned invariants:
 *   - GET on missing knowledge dir → 200 + [] (NOT 404).
 *   - GET returns each file with { name, size, createdAt, chunkCount }
 *     where chunkCount comes from getChunkCountsByFilename (per-project map).
 *   - POST requires project existence (404 from getProject(null)) and a
 *     "file" formData field (400 if missing).
 *   - POST creates the knowledge dir, persists the file, then calls
 *     importKnowledgeFile with (knowledgeDir, projectId, settings, filename).
 *     If importer returns errors[], response is 207 Multi-Status.
 *   - DELETE requires project existence (404) + filename in body (400).
 *   - DELETE ENOENT on disk is swallowed; vectors are still deleted.
 *   - DELETE returns deletedVectors count from deleteMemoryByMetadata.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

vi.mock("@/lib/memory/knowledge", () => ({
  importKnowledgeFile: vi.fn(),
}));

vi.mock("@/lib/memory/memory", () => ({
  deleteMemoryByMetadata: vi.fn(),
  getChunkCountsByFilename: vi.fn(),
}));

vi.mock("@/lib/storage/project-store", () => ({
  getProject: vi.fn(),
}));

vi.mock("@/lib/storage/settings-store", () => ({
  getSettings: vi.fn(),
}));

import { GET, POST, DELETE } from "./route";
import { importKnowledgeFile } from "@/lib/memory/knowledge";
import {
  deleteMemoryByMetadata,
  getChunkCountsByFilename,
} from "@/lib/memory/memory";
import { getProject } from "@/lib/storage/project-store";
import { getSettings } from "@/lib/storage/settings-store";

const mockedImport = vi.mocked(importKnowledgeFile);
const mockedDeleteVectors = vi.mocked(deleteMemoryByMetadata);
const mockedChunkCounts = vi.mocked(getChunkCountsByFilename);
const mockedGetProject = vi.mocked(getProject);
const mockedSettings = vi.mocked(getSettings);

let tmpRoot: string;
let cwdSpy: any;

beforeEach(async () => {
  vi.clearAllMocks();
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-knowledge-"));
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmpRoot);
  mockedSettings.mockResolvedValue({} as any);
  mockedChunkCounts.mockResolvedValue({});
  mockedDeleteVectors.mockResolvedValue(0);
});

afterEach(async () => {
  cwdSpy?.mockRestore();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const params = (id: string) => ({ params: Promise.resolve({ id }) });

const knowledgeDirFor = (projectId: string) =>
  path.join(tmpRoot, "data", "projects", projectId, ".meta", "knowledge");

async function plantKnowledgeFile(
  projectId: string,
  filename: string,
  contents = "hello"
): Promise<void> {
  const dir = knowledgeDirFor(projectId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), contents);
}

function buildGet(): NextRequest {
  return new NextRequest(
    "http://localhost:3000/api/projects/p-1/knowledge"
  );
}

function buildPostMultipart(
  file: { name: string; content: string } | null
): NextRequest {
  const fd = new FormData();
  if (file) {
    fd.append("file", new Blob([file.content]), file.name);
  }
  return new NextRequest(
    "http://localhost:3000/api/projects/p-1/knowledge",
    { method: "POST", body: fd as any }
  );
}

type NextRequestInit = ConstructorParameters<typeof NextRequest>[1];

function buildDelete(body?: unknown): NextRequest {
  const init: NextRequestInit = { method: "DELETE" };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return new NextRequest(
    "http://localhost:3000/api/projects/p-1/knowledge",
    init
  );
}

describe("GET /api/projects/[id]/knowledge", () => {
  it("returns [] when the knowledge dir does not exist (NOT 404 — friendlier UX)", async () => {
    const res = await GET(buildGet(), params("p-fresh"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("returns one entry per file with metadata + chunkCount", async () => {
    await plantKnowledgeFile("p-1", "doc-a.md", "alpha contents");
    await plantKnowledgeFile("p-1", "doc-b.txt", "beta contents--");
    mockedChunkCounts.mockResolvedValue({ "doc-a.md": 7, "doc-b.txt": 3 });

    const res = await GET(buildGet(), params("p-1"));
    expect(res.status).toBe(200);
    const entries = (await res.json()) as Array<{
      name: string;
      size: number;
      chunkCount: number;
      createdAt: string;
    }>;
    expect(entries.map((e) => e.name).sort()).toEqual([
      "doc-a.md",
      "doc-b.txt",
    ]);
    const docA = entries.find((e) => e.name === "doc-a.md")!;
    expect(docA.size).toBe("alpha contents".length);
    expect(docA.chunkCount).toBe(7);
    expect(new Date(docA.createdAt).toString()).not.toBe("Invalid Date");

    expect(mockedChunkCounts).toHaveBeenCalledWith("p-1");
  });

  it("treats missing chunkCount as 0", async () => {
    await plantKnowledgeFile("p-1", "loose.md");
    mockedChunkCounts.mockResolvedValue({});
    const res = await GET(buildGet(), params("p-1"));
    const entries = (await res.json()) as Array<{ name: string; chunkCount: number }>;
    expect(entries[0].chunkCount).toBe(0);
  });
});

describe("POST /api/projects/[id]/knowledge", () => {
  it("returns 404 when the project does not exist", async () => {
    mockedGetProject.mockResolvedValue(null as any);
    const res = await POST(
      buildPostMultipart({ name: "x.md", content: "hi" }),
      params("missing")
    );
    expect(res.status).toBe(404);
    expect(mockedImport).not.toHaveBeenCalled();
  });

  it("returns 400 when no file is provided", async () => {
    mockedGetProject.mockResolvedValue({ id: "p-1" } as any);
    const res = await POST(buildPostMultipart(null), params("p-1"));
    expect(res.status).toBe(400);
  });

  it("blocks with 403 + NEVER ingests under Privacy Mode + cloud embeddings (QA audit F-19)", async () => {
    mockedGetProject.mockResolvedValue({ id: "p-1" } as any);
    // Local chat model but a CLOUD embeddings model with Privacy Mode ON —
    // importing would ship the file's content to the cloud embedder.
    mockedSettings.mockResolvedValue({
      privacyMode: { enabled: true },
      chatModel: { provider: "ollama", model: "llama3" },
      embeddingsModel: { provider: "openai", model: "text-embedding-3-small" },
    } as any);

    const res = await POST(
      buildPostMultipart({ name: "secret.md", content: "confidential client data" }),
      params("p-1")
    );
    expect(res.status).toBe(403);
    expect(mockedImport).not.toHaveBeenCalled(); // the embed never happens
  });

  it("persists the file under .meta/knowledge/ and calls the ingester", async () => {
    mockedGetProject.mockResolvedValue({ id: "p-1" } as any);
    mockedImport.mockResolvedValue({ imported: 4, skipped: 0, errors: [] });

    const res = await POST(
      buildPostMultipart({ name: "notes.md", content: "alpha bravo" }),
      params("p-1")
    );
    expect(res.status).toBe(200);

    // File landed on disk under the project's knowledge dir.
    const planted = await fs.readFile(
      path.join(knowledgeDirFor("p-1"), "notes.md"),
      "utf8"
    );
    expect(planted).toBe("alpha bravo");

    // Ingester was called with (knowledgeDir, projectId, settings, filename).
    expect(mockedImport).toHaveBeenCalledOnce();
    const [knowledgeDir, memorySubdir, , filename] = mockedImport.mock.calls[0];
    expect(knowledgeDir).toBe(knowledgeDirFor("p-1"));
    expect(memorySubdir).toBe("p-1");
    expect(filename).toBe("notes.md");
  });

  it("returns 207 Multi-Status when ingestion reports errors", async () => {
    mockedGetProject.mockResolvedValue({ id: "p-1" } as any);
    mockedImport.mockResolvedValue({
      imported: 0,
      skipped: 0,
      errors: ["embedder timed out"],
    });
    const res = await POST(
      buildPostMultipart({ name: "weird.bin", content: "xx" }),
      params("p-1")
    );
    expect(res.status).toBe(207);
    const body = await res.json();
    expect(body.message).toMatch(/ingestion had errors/i);
    expect(body.details.errors).toEqual(["embedder timed out"]);
  });

  it("returns 500 when fs.writeFile throws (e.g., disk full)", async () => {
    mockedGetProject.mockResolvedValue({ id: "p-1" } as any);
    const writeSpy = vi
      .spyOn(fs, "writeFile")
      .mockRejectedValueOnce(new Error("ENOSPC: no space left on device"));
    try {
      const res = await POST(
        buildPostMultipart({ name: "x.md", content: "y" }),
        params("p-1")
      );
      expect(res.status).toBe(500);
      expect(mockedImport).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
    }
  });

  // PM #34 — two parallel uploads of the SAME filename used to race on
  // writeFile + importKnowledgeFile, producing duplicate vector chunks
  // because importKnowledgeFile first deletes prior chunks then appends new
  // ones — two concurrent imports both observed "no prior chunks" and both
  // appended. The fix wraps writeFile + importKnowledgeFile in
  // withFileLock(filePath, ...) so the two operations serialise.
  it("PM #34 — two parallel uploads of the same filename serialise (no duplicate import)", async () => {
    mockedGetProject.mockResolvedValue({ id: "p-1" } as any);

    // Capture the order in which importKnowledgeFile is entered AND exited.
    // The fix guarantees: enter-1 → exit-1 → enter-2 → exit-2 (interleaved
    // enter-1 → enter-2 would be the bug shape).
    const trace: string[] = [];
    let counter = 0;
    mockedImport.mockImplementation(async () => {
      const id = ++counter;
      trace.push(`enter-${id}`);
      // Force the two calls to overlap if they're allowed to — a setImmediate
      // boundary makes the race observable. With the lock, the second caller
      // can't start until the first finishes.
      await new Promise((resolve) => setImmediate(resolve));
      trace.push(`exit-${id}`);
      return { imported: 1, skipped: 0, errors: [] };
    });

    const [resA, resB] = await Promise.all([
      POST(buildPostMultipart({ name: "report.md", content: "v1" }), params("p-1")),
      POST(buildPostMultipart({ name: "report.md", content: "v2" }), params("p-1")),
    ]);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(mockedImport).toHaveBeenCalledTimes(2);
    // The lock guarantees serialisation: each enter is followed by its own
    // exit before the next enter. The interleaved (broken) trace would be
    // [enter-1, enter-2, exit-1, exit-2].
    expect(trace).toEqual(["enter-1", "exit-1", "enter-2", "exit-2"]);
  });

  // Note on different-filename parallelism: withFileLock keys by resolved
  // file path, so uploads of different filenames DO run in parallel — the
  // lock keying is verified directly in `src/lib/storage/fs-utils.test.ts`.
  // We don't repeat the assertion here because Vitest's event-loop ordering
  // makes the trace test too flaky to be a regression guard at this layer.
});

describe("DELETE /api/projects/[id]/knowledge", () => {
  it("returns 404 when the project does not exist", async () => {
    mockedGetProject.mockResolvedValue(null as any);
    const res = await DELETE(buildDelete({ filename: "x.md" }), params("missing"));
    expect(res.status).toBe(404);
  });

  it("returns 400 when filename is missing from the body", async () => {
    mockedGetProject.mockResolvedValue({ id: "p-1" } as any);
    const res = await DELETE(buildDelete({}), params("p-1"));
    expect(res.status).toBe(400);
  });

  it("deletes the file on disk + vectors and reports the count", async () => {
    mockedGetProject.mockResolvedValue({ id: "p-1" } as any);
    await plantKnowledgeFile("p-1", "doomed.md", "xx");
    mockedDeleteVectors.mockResolvedValue(12);

    const res = await DELETE(
      buildDelete({ filename: "doomed.md" }),
      params("p-1")
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deletedVectors).toBe(12);

    await expect(
      fs.access(path.join(knowledgeDirFor("p-1"), "doomed.md"))
    ).rejects.toThrow();
    expect(mockedDeleteVectors).toHaveBeenCalledWith(
      "filename",
      "doomed.md",
      "p-1"
    );
  });

  it("swallows ENOENT on disk and still deletes vectors (idempotent delete)", async () => {
    mockedGetProject.mockResolvedValue({ id: "p-1" } as any);
    mockedDeleteVectors.mockResolvedValue(3);
    const res = await DELETE(
      buildDelete({ filename: "never-existed.md" }),
      params("p-1")
    );
    expect(res.status).toBe(200);
    expect((await res.json()).deletedVectors).toBe(3);
  });

  it("returns 500 when fs.unlink throws a non-ENOENT error", async () => {
    mockedGetProject.mockResolvedValue({ id: "p-1" } as any);
    await plantKnowledgeFile("p-1", "guarded.md", "xx");
    const unlinkSpy = vi
      .spyOn(fs, "unlink")
      .mockRejectedValueOnce(Object.assign(new Error("EACCES"), { code: "EACCES" }));
    try {
      const res = await DELETE(
        buildDelete({ filename: "guarded.md" }),
        params("p-1")
      );
      expect(res.status).toBe(500);
      expect(mockedDeleteVectors).not.toHaveBeenCalled();
    } finally {
      unlinkSpy.mockRestore();
    }
  });
});

/**
 * PM #21 — path traversal regression suite.
 *
 * Pre-fix behavior: POST and DELETE both passed user-controlled `file.name`/
 * `filename` straight into `path.join(knowledgeDir, ...)`. That gave any
 * authenticated user an arbitrary file-write (POST) and arbitrary file-delete
 * (DELETE) primitive — identical to the bug class of PM #6 and PM #16.
 *
 * These tests pin the fix: any non-basename input (anything containing a path
 * separator, leading dot-dot, or otherwise resolving outside the knowledge
 * directory) MUST be rejected with 400 and MUST NOT call the importer / vector
 * deleter / fs.writeFile / fs.unlink.
 */
describe("PM #21 — path traversal in knowledge routes", () => {
  const traversalPayloads = [
    "../../../etc/passwd",
    "..\\..\\windows\\system32",  // Windows-style separators
    "subdir/file.txt",            // any slash → reject
    "./local.txt",                // leading ./ → reject
    "..",                          // bare parent
    ".",                           // bare current
    "",                            // empty
    "   ",                         // whitespace-only
  ];

  describe("POST — refuses traversal in file.name", () => {
    for (const payload of traversalPayloads) {
      it(`refuses "${payload.replace(/\n/g, "\\n")}"`, async () => {
        mockedGetProject.mockResolvedValue({ id: "p-1" } as any);
        const writeSpy = vi.spyOn(fs, "writeFile");
        try {
          const res = await POST(
            buildPostMultipart({ name: payload, content: "evil" }),
            params("p-1")
          );
          expect(res.status).toBe(400);
          expect((await res.json()).error).toMatch(/invalid filename|no file/i);
          expect(mockedImport).not.toHaveBeenCalled();
          // Critically: no actual write happened.
          expect(writeSpy).not.toHaveBeenCalled();
        } finally {
          writeSpy.mockRestore();
        }
      });
    }
  });

  describe("DELETE — refuses traversal in filename body", () => {
    for (const payload of traversalPayloads) {
      it(`refuses "${payload.replace(/\n/g, "\\n")}"`, async () => {
        mockedGetProject.mockResolvedValue({ id: "p-1" } as any);
        const unlinkSpy = vi.spyOn(fs, "unlink");
        try {
          const res = await DELETE(
            buildDelete({ filename: payload }),
            params("p-1")
          );
          // Empty/whitespace-only land in the existing 400 path; rest in PM #21 path.
          expect(res.status).toBe(400);
          expect(mockedDeleteVectors).not.toHaveBeenCalled();
          expect(unlinkSpy).not.toHaveBeenCalled();
        } finally {
          unlinkSpy.mockRestore();
        }
      });
    }
  });

  it("POST accepts a benign filename and writes it (sanity check that the guard isn't too strict)", async () => {
    mockedGetProject.mockResolvedValue({ id: "p-1" } as any);
    mockedImport.mockResolvedValue({ imported: 1, skipped: 0, errors: [] });
    const res = await POST(
      buildPostMultipart({ name: "doc.md", content: "alpha" }),
      params("p-1")
    );
    expect(res.status).toBe(200);
    expect((await res.json()).filename).toBe("doc.md");
    // Importer received the sanitized name (which equals the original here).
    const [, , , filenameArg] = mockedImport.mock.calls[0];
    expect(filenameArg).toBe("doc.md");
  });

  it("POST preserves Cyrillic / non-ASCII filenames as-is", async () => {
    mockedGetProject.mockResolvedValue({ id: "p-1" } as any);
    mockedImport.mockResolvedValue({ imported: 1, skipped: 0, errors: [] });
    const res = await POST(
      buildPostMultipart({ name: "Отчёт-2026.md", content: "x" }),
      params("p-1")
    );
    expect(res.status).toBe(200);
    expect((await res.json()).filename).toBe("Отчёт-2026.md");
  });
});
