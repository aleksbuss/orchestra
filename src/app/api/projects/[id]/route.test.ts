/**
 * Tests for GET / PUT / DELETE /api/projects/[id].
 *
 * The pinned invariant here is the PUT body's blast radius. The handler
 * spreads the request body straight into `updateProject`, so `absoluteRoot`
 * — the project's filesystem root, the thing every file tool and the Files
 * API resolve against — is settable from an ordinary "rename this project"
 * request. `updateProject` validates it (see `validateAbsoluteRoot`); this
 * suite pins that the rejection surfaces as a 400 and not as an unhandled
 * 500, and that no OTHER storage error is silently downgraded to a 400.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/realtime/event-bus", () => ({
  publishUiSyncEvent: vi.fn(),
}));

vi.mock("@/lib/storage/project-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/storage/project-store")>();
  return {
    ...actual,
    getProject: vi.fn(),
    updateProject: vi.fn(),
    deleteProject: vi.fn(),
  };
});

import { GET, PUT, DELETE } from "./route";
import {
  getProject,
  updateProject,
  deleteProject,
  InvalidProjectRootError,
} from "@/lib/storage/project-store";

const mockedGet = vi.mocked(getProject);
const mockedUpdate = vi.mocked(updateProject);
const mockedDelete = vi.mocked(deleteProject);

const params = (id: string) => ({ params: Promise.resolve({ id }) });

function buildPut(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/projects/p-1", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/projects/[id]", () => {
  it("returns the project", async () => {
    mockedGet.mockResolvedValue({ id: "p-1", name: "P" } as never);
    const res = await GET({} as NextRequest, params("p-1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "p-1" });
  });

  it("404s on an unknown project", async () => {
    mockedGet.mockResolvedValue(null);
    const res = await GET({} as NextRequest, params("nope"));
    expect(res.status).toBe(404);
  });
});

describe("PUT /api/projects/[id] — absoluteRoot is operator input", () => {
  it("400s (not 500s) when the store rejects the supplied absoluteRoot", async () => {
    mockedUpdate.mockRejectedValue(
      new InvalidProjectRootError('absoluteRoot "/nope" does not exist')
    );

    const res = await PUT(buildPut({ absoluteRoot: "/nope" }), params("p-1"));

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("does not exist");
  });

  it("does NOT swallow unrelated storage errors as a 400", async () => {
    mockedUpdate.mockRejectedValue(new Error("ENOSPC: disk full"));
    await expect(
      PUT(buildPut({ name: "Renamed" }), params("p-1"))
    ).rejects.toThrow("ENOSPC");
  });

  it("passes a valid patch through and returns the updated project", async () => {
    mockedUpdate.mockResolvedValue({
      id: "p-1",
      name: "Renamed",
      absoluteRoot: "/Users/me/repo",
    } as never);

    const res = await PUT(
      buildPut({ name: "Renamed", absoluteRoot: "/Users/me/repo" }),
      params("p-1")
    );

    expect(res.status).toBe(200);
    expect(mockedUpdate).toHaveBeenCalledWith("p-1", {
      name: "Renamed",
      absoluteRoot: "/Users/me/repo",
    });
    expect(await res.json()).toMatchObject({ absoluteRoot: "/Users/me/repo" });
  });

  it("404s when the project does not exist", async () => {
    mockedUpdate.mockResolvedValue(null);
    const res = await PUT(buildPut({ name: "X" }), params("ghost"));
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/projects/[id]", () => {
  it("returns success when the project was removed", async () => {
    mockedDelete.mockResolvedValue(true);
    const res = await DELETE({} as NextRequest, params("p-1"));
    expect(res.status).toBe(200);
  });

  it("404s when there was nothing to remove", async () => {
    mockedDelete.mockResolvedValue(false);
    const res = await DELETE({} as NextRequest, params("p-1"));
    expect(res.status).toBe(404);
  });
});
