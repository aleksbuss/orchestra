/**
 * Tests for GET /api/projects/[id]/skills — returns full skill content
 * (name/description/body/license/compatibility) for one project.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/storage/project-store", () => ({
  getProject: vi.fn(),
  loadProjectSkills: vi.fn(),
}));

import { GET } from "./route";
import { getProject, loadProjectSkills } from "@/lib/storage/project-store";

const mockedGet = vi.mocked(getProject);
const mockedLoad = vi.mocked(loadProjectSkills);

beforeEach(() => {
  vi.clearAllMocks();
});

const req = () =>
  new NextRequest("http://localhost:3000/api/projects/p-1/skills");
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("GET /api/projects/[id]/skills", () => {
  it("returns 404 when the project does not exist", async () => {
    mockedGet.mockResolvedValue(null);
    const res = await GET(req(), params("missing"));
    expect(res.status).toBe(404);
  });

  it("returns the skills with body renamed to `content` for the UI", async () => {
    mockedGet.mockResolvedValue({ id: "p-1" } as any);
    mockedLoad.mockResolvedValue([
      {
        name: "skill-one",
        description: "First",
        body: "Full instructions.",
        license: "MIT",
        compatibility: "linux",
        skillDir: "/abs",
      },
    ]);

    const res = await GET(req(), params("p-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([
      {
        name: "skill-one",
        description: "First",
        content: "Full instructions.",
        license: "MIT",
        compatibility: "linux",
      },
    ]);
  });

  it("returns [] for a project with no skills", async () => {
    mockedGet.mockResolvedValue({ id: "p-1" } as any);
    mockedLoad.mockResolvedValue([]);
    const res = await GET(req(), params("p-1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("returns 500 when loadProjectSkills throws", async () => {
    mockedGet.mockResolvedValue({ id: "p-1" } as any);
    mockedLoad.mockRejectedValue(new Error("corrupt skill"));
    const res = await GET(req(), params("p-1"));
    expect(res.status).toBe(500);
  });
});
