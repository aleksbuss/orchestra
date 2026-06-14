/**
 * Tests for /api/memory — GET (search/list), POST (insert), DELETE (by id).
 *
 * Pinned invariants:
 *   - GET with `query` → searchMemory with subdir + settings threshold.
 *   - GET without query → getAllMemories (dashboard listing).
 *   - POST 400 when text missing; defaults area/subdir to "main".
 *   - POST 201 + id on success.
 *   - DELETE 400 when id missing; 404 when not found; 200 success.
 *   - subdir defaults to "main" everywhere.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/memory/memory", () => ({
  searchMemory: vi.fn(),
  insertMemory: vi.fn(),
  deleteMemoryById: vi.fn(),
  getAllMemories: vi.fn(),
}));

vi.mock("@/lib/storage/settings-store", () => ({
  getSettings: vi.fn(),
}));

import { GET, POST, DELETE } from "./route";
import {
  searchMemory,
  insertMemory,
  deleteMemoryById,
  getAllMemories,
} from "@/lib/memory/memory";
import { getSettings } from "@/lib/storage/settings-store";

const mockedSearch = vi.mocked(searchMemory);
const mockedInsert = vi.mocked(insertMemory);
const mockedDelete = vi.mocked(deleteMemoryById);
const mockedAll = vi.mocked(getAllMemories);
const mockedSettings = vi.mocked(getSettings);

beforeEach(() => {
  vi.clearAllMocks();
  mockedSettings.mockResolvedValue({
    memory: { similarityThreshold: 0.5 },
  } as any);
});

function buildGet(query: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/memory${query}`);
}

function buildPost(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/memory", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function buildDelete(query: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/memory${query}`, {
    method: "DELETE",
  });
}

describe("GET /api/memory — search", () => {
  it("with `query` param: calls searchMemory with subdir + threshold from settings", async () => {
    mockedSearch.mockResolvedValue([
      { text: "match", score: 0.9, metadata: {} } as any,
    ]);
    const res = await GET(buildGet("?query=hello&limit=10&subdir=proj-1"));
    expect(res.status).toBe(200);
    expect(mockedSearch).toHaveBeenCalledWith(
      "hello",
      10,
      0.5, // from settings.memory.similarityThreshold
      "proj-1",
      expect.any(Object)
    );
    const body = await res.json();
    expect(body).toHaveLength(1);
  });

  it("defaults subdir to 'main' and limit to 20 when not provided", async () => {
    mockedSearch.mockResolvedValue([]);
    await GET(buildGet("?query=x"));
    expect(mockedSearch).toHaveBeenCalledWith(
      "x",
      20,
      0.5,
      "main",
      expect.any(Object)
    );
  });
});

describe("GET /api/memory — list (no query)", () => {
  it("without `query`: returns getAllMemories(subdir)", async () => {
    mockedAll.mockResolvedValue([
      { id: "1", text: "a" } as any,
      { id: "2", text: "b" } as any,
    ]);
    const res = await GET(buildGet("?subdir=proj-1"));
    expect(res.status).toBe(200);
    expect(mockedAll).toHaveBeenCalledWith("proj-1");
    const body = await res.json();
    expect(body).toHaveLength(2);
  });

  it("defaults subdir to 'main'", async () => {
    mockedAll.mockResolvedValue([]);
    await GET(buildGet(""));
    expect(mockedAll).toHaveBeenCalledWith("main");
  });
});

describe("POST /api/memory — insert", () => {
  it("returns 400 when text is missing", async () => {
    const res = await POST(buildPost({}));
    expect(res.status).toBe(400);
    expect(mockedInsert).not.toHaveBeenCalled();
  });

  it("returns 201 + id on success", async () => {
    mockedInsert.mockResolvedValue("mem-id-42");
    const res = await POST(
      buildPost({ text: "remember this", area: "facts", subdir: "p-1" })
    );
    expect(res.status).toBe(201);
    expect(mockedInsert).toHaveBeenCalledWith(
      "remember this",
      "facts",
      "p-1",
      expect.any(Object)
    );
    const body = await res.json();
    expect(body).toEqual({ id: "mem-id-42", success: true });
  });

  it("defaults area + subdir to 'main' when not provided", async () => {
    mockedInsert.mockResolvedValue("mem-id");
    await POST(buildPost({ text: "x" }));
    expect(mockedInsert).toHaveBeenCalledWith(
      "x",
      "main",
      "main",
      expect.any(Object)
    );
  });

  it("returns 500 with sanitized error on insert failure", async () => {
    mockedInsert.mockRejectedValue(new Error("vector store down"));
    const res = await POST(buildPost({ text: "x" }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/vector store down/);
  });
});

describe("DELETE /api/memory — by id", () => {
  it("returns 400 when id missing", async () => {
    const res = await DELETE(buildDelete(""));
    expect(res.status).toBe(400);
    expect(mockedDelete).not.toHaveBeenCalled();
  });

  it("returns 404 when memory doesn't exist", async () => {
    mockedDelete.mockResolvedValue(false);
    const res = await DELETE(buildDelete("?id=missing"));
    expect(res.status).toBe(404);
  });

  it("returns 200 + success on delete", async () => {
    mockedDelete.mockResolvedValue(true);
    const res = await DELETE(buildDelete("?id=mem-1"));
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(mockedDelete).toHaveBeenCalledWith("mem-1", "main");
  });

  it("forwards subdir when provided", async () => {
    mockedDelete.mockResolvedValue(true);
    await DELETE(buildDelete("?id=mem-1&subdir=p-1"));
    expect(mockedDelete).toHaveBeenCalledWith("mem-1", "p-1");
  });
});

describe("Privacy Mode air-gap (QA audit F-19 — embedding routes bypass the agent entry guard)", () => {
  // The exact dangerous config: local chat model, but a CLOUD embeddings model,
  // with Privacy Mode ON. Nothing at settings-write time forbids this state, so
  // the route must reject it before searchMemory/insertMemory embed the text.
  const cloudEmbedPrivacy = {
    memory: { similarityThreshold: 0.5 },
    privacyMode: { enabled: true },
    chatModel: { provider: "ollama", model: "llama3" },
    embeddingsModel: { provider: "openai", model: "text-embedding-3-small" },
  };

  it("GET search: 403 + searchMemory NEVER called under Privacy Mode + cloud embeddings", async () => {
    mockedSettings.mockResolvedValue(cloudEmbedPrivacy as any);
    const res = await GET(buildGet("?query=confidential client data"));
    expect(res.status).toBe(403);
    // The leak is the embedding call itself — it must not happen.
    expect(mockedSearch).not.toHaveBeenCalled();
    expect((await res.json()).error).toMatch(/Privacy Mode/i);
  });

  it("POST insert: 403 + insertMemory NEVER called under Privacy Mode + cloud embeddings", async () => {
    mockedSettings.mockResolvedValue(cloudEmbedPrivacy as any);
    const res = await POST(buildPost({ text: "confidential client data" }));
    expect(res.status).toBe(403);
    expect(mockedInsert).not.toHaveBeenCalled();
  });

  it("does NOT over-block: Privacy Mode ON with a LOCAL embeddings model proceeds", async () => {
    mockedSettings.mockResolvedValue({
      ...cloudEmbedPrivacy,
      embeddingsModel: { provider: "ollama", model: "nomic-embed-text" },
    } as any);
    mockedSearch.mockResolvedValue([]);
    const res = await GET(buildGet("?query=x"));
    expect(res.status).toBe(200);
    expect(mockedSearch).toHaveBeenCalled();
  });

  it("does NOT block when Privacy Mode is OFF (the default)", async () => {
    mockedInsert.mockResolvedValue("id-1");
    const res = await POST(buildPost({ text: "x" }));
    expect(res.status).toBe(201);
    expect(mockedInsert).toHaveBeenCalled();
  });
});
