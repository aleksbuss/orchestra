/**
 * Tests for GET / POST /api/projects — list / create projects.
 *
 * Pinned invariants on POST:
 *   - 400 on missing/non-string name.
 *   - The id is auto-derived from name: lowercase, [a-z0-9]+ runs joined
 *     by `-`, leading/trailing dashes stripped. Names with no usable
 *     characters fall back to a UUID prefix (8 chars).
 *   - Required fields plumb through to createProject.
 *   - 500 on storage failure surfaces the underlying message.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/storage/project-store", () => ({
  getAllProjects: vi.fn(),
  createProject: vi.fn(),
}));

import { GET, POST } from "./route";
import {
  createProject,
  getAllProjects,
} from "@/lib/storage/project-store";

const mockedAll = vi.mocked(getAllProjects);
const mockedCreate = vi.mocked(createProject);

beforeEach(() => {
  vi.clearAllMocks();
});

function buildPost(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/projects — list", () => {
  it("returns the persisted list verbatim", async () => {
    mockedAll.mockResolvedValue([{ id: "a" }, { id: "b" }] as any);
    const res = await GET();
    const body = await res.json();
    expect(body).toHaveLength(2);
  });
});

describe("POST /api/projects — validation", () => {
  it("returns 400 when name is missing", async () => {
    const res = await POST(buildPost({}));
    expect(res.status).toBe(400);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("returns 400 when name is not a string", async () => {
    const res = await POST(buildPost({ name: 42 }));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/projects — id derivation", () => {
  beforeEach(() => {
    mockedCreate.mockImplementation(async (p) => p as any);
  });

  it("derives kebab-case id from name (lowercase, [a-z0-9]+ joined by -)", async () => {
    await POST(buildPost({ name: "My Cool Project!" }));
    const arg = mockedCreate.mock.calls[0][0];
    expect(arg.id).toBe("my-cool-project");
  });

  it("strips leading and trailing dashes (e.g., from punctuation at the edges)", async () => {
    await POST(buildPost({ name: "  --hello world--  " }));
    expect(mockedCreate.mock.calls[0][0].id).toBe("hello-world");
  });

  it("collapses runs of non-alphanumerics into a single dash", async () => {
    await POST(buildPost({ name: "Foo___Bar...Baz" }));
    expect(mockedCreate.mock.calls[0][0].id).toBe("foo-bar-baz");
  });

  it("falls back to a UUID prefix for names with NO alphanumerics", async () => {
    await POST(buildPost({ name: "!@#$%" }));
    const id = mockedCreate.mock.calls[0][0].id;
    // 8-char hex slice from a UUID; matches /^[a-f0-9]{8}$/
    expect(id).toMatch(/^[a-f0-9]{8}$/);
  });

  it("preserves digits", async () => {
    await POST(buildPost({ name: "Project 2026 Q1" }));
    expect(mockedCreate.mock.calls[0][0].id).toBe("project-2026-q1");
  });
});

describe("POST /api/projects — happy path", () => {
  it("returns 201 + the created project, plumbing optional fields with empty defaults", async () => {
    mockedCreate.mockImplementation(async (p) => ({ ...p, createdAt: "x" }) as any);

    const res = await POST(buildPost({ name: "Demo" }));
    expect(res.status).toBe(201);

    const arg = mockedCreate.mock.calls[0][0];
    expect(arg).toEqual(
      expect.objectContaining({
        id: "demo",
        name: "Demo",
        description: "",
        instructions: "",
        memoryMode: "global",
      })
    );
  });

  it("forwards optional fields when provided", async () => {
    mockedCreate.mockImplementation(async (p) => p as any);
    await POST(
      buildPost({
        name: "Custom",
        description: "Has a desc",
        instructions: "Be helpful",
        memoryMode: "isolated",
      })
    );
    expect(mockedCreate.mock.calls[0][0]).toEqual({
      id: "custom",
      name: "Custom",
      description: "Has a desc",
      instructions: "Be helpful",
      memoryMode: "isolated",
    });
  });

  it("returns 500 on storage failure", async () => {
    mockedCreate.mockRejectedValue(new Error("disk full"));
    const res = await POST(buildPost({ name: "Fails" }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/disk full/);
  });
});
