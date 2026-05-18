/**
 * Tests for POST /api/projects/[id]/cron/[jobId]/run — "run now".
 *
 * Pinned invariants:
 *   - Boots the scheduler.
 *   - reason: "not-found"      → 404
 *   - reason: "already-running" → 409 (the only place this code surfaces)
 *   - ran === true             → 200 { success: true, ran: true }
 *   - Thrown "not found"       → 404; generic → 400.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/cron/runtime", () => ({
  ensureCronSchedulerStarted: vi.fn(),
}));

vi.mock("@/lib/cron/service", () => ({
  runCronJobNow: vi.fn(),
}));

import { POST } from "./route";
import { ensureCronSchedulerStarted } from "@/lib/cron/runtime";
import { runCronJobNow } from "@/lib/cron/service";

const mockedStart = vi.mocked(ensureCronSchedulerStarted);
const mockedRun = vi.mocked(runCronJobNow);

beforeEach(() => {
  vi.clearAllMocks();
  mockedStart.mockResolvedValue(undefined);
});

const params = (id: string, jobId: string) => ({
  params: Promise.resolve({ id, jobId }),
});
const req = () =>
  new Request("http://localhost:3000/api/projects/p-1/cron/j-1/run", {
    method: "POST",
  });

describe("POST /api/projects/[id]/cron/[jobId]/run", () => {
  it("returns 200 on successful invocation", async () => {
    mockedRun.mockResolvedValue({ ran: true });
    const res = await POST(req(), params("p-1", "j-1"));
    expect(res.status).toBe(200);
    expect(mockedStart).toHaveBeenCalledOnce();
    expect(mockedRun).toHaveBeenCalledWith("p-1", "j-1");
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.ran).toBe(true);
  });

  it("returns 404 when reason='not-found'", async () => {
    mockedRun.mockResolvedValue({ ran: false, reason: "not-found" });
    const res = await POST(req(), params("p-1", "missing"));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/not found/i);
  });

  it("returns 409 when reason='already-running' (concurrency guard)", async () => {
    mockedRun.mockResolvedValue({ ran: false, reason: "already-running" });
    const res = await POST(req(), params("p-1", "j-1"));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already running/i);
  });

  it("maps thrown 'not found' service error to 404", async () => {
    mockedRun.mockRejectedValue(new Error("project p-1 not found"));
    const res = await POST(req(), params("missing", "j-1"));
    expect(res.status).toBe(404);
  });

  it("maps thrown generic error to 400", async () => {
    mockedRun.mockRejectedValue(new Error("queue exploded"));
    const res = await POST(req(), params("p-1", "j-1"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/queue exploded/);
  });
});
