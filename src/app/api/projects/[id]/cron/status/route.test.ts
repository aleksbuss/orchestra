/**
 * Tests for GET /api/projects/[id]/cron/status.
 *
 * Pinned invariants:
 *   - Boots the cron scheduler (idempotent).
 *   - Forwards the project id to getCronProjectStatus.
 *   - "not found" error message → 404; anything else → 400.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/cron/runtime", () => ({
  ensureCronSchedulerStarted: vi.fn(),
}));

vi.mock("@/lib/cron/service", () => ({
  getCronProjectStatus: vi.fn(),
}));

import { GET } from "./route";
import { ensureCronSchedulerStarted } from "@/lib/cron/runtime";
import { getCronProjectStatus } from "@/lib/cron/service";

const mockedStart = vi.mocked(ensureCronSchedulerStarted);
const mockedStatus = vi.mocked(getCronProjectStatus);

beforeEach(() => {
  vi.clearAllMocks();
  mockedStart.mockResolvedValue(undefined);
});

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const req = () =>
  new Request("http://localhost:3000/api/projects/p-1/cron/status");

describe("GET /api/projects/[id]/cron/status", () => {
  it("starts the scheduler and returns the project status", async () => {
    mockedStatus.mockResolvedValue({
      projectId: "p-1",
      jobCount: 2,
      enabledJobCount: 1,
    } as any);

    const res = await GET(req(), params("p-1"));
    expect(res.status).toBe(200);
    expect(mockedStart).toHaveBeenCalledOnce();
    expect(mockedStatus).toHaveBeenCalledWith("p-1");
    expect((await res.json()).jobCount).toBe(2);
  });

  it("maps 'not found' service error to 404", async () => {
    mockedStatus.mockRejectedValue(new Error("project missing not found"));
    const res = await GET(req(), params("missing"));
    expect(res.status).toBe(404);
  });

  it("maps generic service error to 400", async () => {
    mockedStatus.mockRejectedValue(new Error("scheduler offline"));
    const res = await GET(req(), params("p-1"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/scheduler offline/);
  });

  it("falls back to a stable error message when error is not an Error", async () => {
    mockedStatus.mockRejectedValue("just a string");
    const res = await GET(req(), params("p-1"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Failed to load cron status/i);
  });
});
