/**
 * Tests for GET / PUT / DELETE /api/projects/[id].
 *
 * Pinned invariants:
 *   - 404 from any verb when the project doesn't exist.
 *   - PUT plumbs the body to updateProject.
 *   - DELETE returns 200 + success.
 *   - All three verbs await the dynamic `params` Promise (Next.js 15 shape).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/storage/project-store", () => ({
  getProject: vi.fn(),
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
}));

import { GET, PUT, DELETE } from "./route";
import {
  deleteProject,
  getProject,
  updateProject,
} from "@/lib/storage/project-store";

const mockedGet = vi.mocked(getProject);
const mockedUpdate = vi.mocked(updateProject);
const mockedDelete = vi.mocked(deleteProject);

beforeEach(() => {
  vi.clearAllMocks();
});

function buildRequest(method: string, body?: unknown): NextRequest {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return new NextRequest("http://localhost:3000/api/projects/p-1", init);
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("GET /api/projects/[id]", () => {
  it("returns 200 + project when found", async () => {
    mockedGet.mockResolvedValue({ id: "p-1", name: "Test" } as any);
    const res = await GET(buildRequest("GET"), params("p-1"));
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe("p-1");
  });

  it("returns 404 when the project does not exist", async () => {
    mockedGet.mockResolvedValue(null);
    const res = await GET(buildRequest("GET"), params("missing"));
    expect(res.status).toBe(404);
  });
});

describe("PUT /api/projects/[id]", () => {
  it("forwards the body to updateProject", async () => {
    mockedUpdate.mockResolvedValue({ id: "p-1", name: "Renamed" } as any);
    const res = await PUT(
      buildRequest("PUT", { name: "Renamed", description: "new" }),
      params("p-1")
    );
    expect(res.status).toBe(200);
    expect(mockedUpdate).toHaveBeenCalledWith("p-1", {
      name: "Renamed",
      description: "new",
    });
  });

  it("returns 404 when the project does not exist", async () => {
    mockedUpdate.mockResolvedValue(null);
    const res = await PUT(buildRequest("PUT", { name: "x" }), params("missing"));
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/projects/[id]", () => {
  it("returns 200 + success on delete", async () => {
    mockedDelete.mockResolvedValue(true);
    const res = await DELETE(buildRequest("DELETE"), params("p-1"));
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(mockedDelete).toHaveBeenCalledWith("p-1");
  });

  it("returns 404 when the project doesn't exist", async () => {
    mockedDelete.mockResolvedValue(false);
    const res = await DELETE(buildRequest("DELETE"), params("missing"));
    expect(res.status).toBe(404);
  });
});
