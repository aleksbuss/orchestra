/**
 * Tests for GET /api/projects/[id]/cron/[jobId]/runs — run-log listing.
 *
 * Pinned invariants:
 *   - Boots the scheduler.
 *   - `limit` query param: numeric → forwarded; non-numeric → undefined.
 *   - "not found" error → 404; otherwise → 400.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/cron/runtime", () => ({
  ensureCronSchedulerStarted: vi.fn(),
}));

vi.mock("@/lib/cron/service", () => ({
  listCronRuns: vi.fn(),
}));

import { GET } from "./route";
import { ensureCronSchedulerStarted } from "@/lib/cron/runtime";
import { listCronRuns } from "@/lib/cron/service";

const mockedStart = vi.mocked(ensureCronSchedulerStarted);
const mockedList = vi.mocked(listCronRuns);

beforeEach(() => {
  vi.clearAllMocks();
  mockedStart.mockResolvedValue(undefined);
});

const params = (id: string, jobId: string) => ({
  params: Promise.resolve({ id, jobId }),
});

const buildReq = (query = "") =>
  new Request(
    `http://localhost:3000/api/projects/p-1/cron/j-1/runs${query}`
  );

describe("GET /api/projects/[id]/cron/[jobId]/runs", () => {
  it("returns 200 + entries array (no limit by default)", async () => {
    mockedList.mockResolvedValue([{ id: "r-1" } as any]);
    const res = await GET(buildReq(), params("p-1", "j-1"));
    expect(res.status).toBe(200);
    expect(mockedStart).toHaveBeenCalledOnce();
    expect(mockedList).toHaveBeenCalledWith("p-1", "j-1", undefined);
    expect((await res.json()).entries).toHaveLength(1);
  });

  it("forwards a numeric ?limit", async () => {
    mockedList.mockResolvedValue([]);
    await GET(buildReq("?limit=25"), params("p-1", "j-1"));
    expect(mockedList).toHaveBeenCalledWith("p-1", "j-1", 25);
  });

  it("falls back to undefined when ?limit is not numeric", async () => {
    mockedList.mockResolvedValue([]);
    await GET(buildReq("?limit=many"), params("p-1", "j-1"));
    // Number("many") → NaN → Number.isFinite(NaN) === false → undefined
    expect(mockedList).toHaveBeenCalledWith("p-1", "j-1", undefined);
  });

  it("maps 'not found' service error to 404", async () => {
    mockedList.mockRejectedValue(new Error("project p-1 not found"));
    const res = await GET(buildReq(), params("missing", "j-1"));
    expect(res.status).toBe(404);
  });

  it("maps generic service error to 400", async () => {
    mockedList.mockRejectedValue(new Error("log disk corrupt"));
    const res = await GET(buildReq(), params("p-1", "j-1"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/log disk corrupt/);
  });
});
