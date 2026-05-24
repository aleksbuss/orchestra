/**
 * Tests for GET /api/projects/[id]/knowledge/chunks?filename=... —
 * returns the raw chunks for a given file (used by knowledge inspector
 * UI to verify what RAG would search).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/memory/memory", () => ({
  getChunksByFilename: vi.fn(),
}));

vi.mock("@/lib/storage/project-store", () => ({
  getProject: vi.fn(),
}));

import { GET } from "./route";
import { getChunksByFilename } from "@/lib/memory/memory";
import { getProject } from "@/lib/storage/project-store";

const mockedChunks = vi.mocked(getChunksByFilename);
const mockedProject = vi.mocked(getProject);

beforeEach(() => {
  vi.clearAllMocks();
});

function buildReq(query: string): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/projects/p-1/knowledge/chunks${query}`
  );
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("GET /api/projects/[id]/knowledge/chunks", () => {
  it("returns 400 when `filename` query param is missing", async () => {
    const res = await GET(buildReq(""), params("p-1"));
    expect(res.status).toBe(400);
    expect(mockedChunks).not.toHaveBeenCalled();
  });

  it("returns 404 when the project doesn't exist (after filename check)", async () => {
    mockedProject.mockResolvedValue(null);
    const res = await GET(buildReq("?filename=doc.pdf"), params("missing"));
    expect(res.status).toBe(404);
    expect(mockedChunks).not.toHaveBeenCalled();
  });

  it("returns chunks for a known file", async () => {
    mockedProject.mockResolvedValue({ id: "p-1" } as any);
    mockedChunks.mockResolvedValue([
      { id: "c-1", text: "first chunk" } as any,
      { id: "c-2", text: "second chunk" } as any,
    ]);
    const res = await GET(buildReq("?filename=doc.pdf"), params("p-1"));
    expect(res.status).toBe(200);
    expect(mockedChunks).toHaveBeenCalledWith("p-1", "doc.pdf");
    const body = await res.json();
    expect(body.filename).toBe("doc.pdf");
    expect(body.chunks).toHaveLength(2);
  });

  it("returns 500 (and logs) when chunks loader throws", async () => {
    mockedProject.mockResolvedValue({ id: "p-1" } as any);
    mockedChunks.mockRejectedValue(new Error("vector store down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET(buildReq("?filename=doc.pdf"), params("p-1"));
    expect(res.status).toBe(500);
    errSpy.mockRestore();
  });
});
