/**
 * Tests for /api/projects/[id]/cron — GET list, POST create.
 *
 * Pinned invariants:
 *   - GET: starts the scheduler (idempotent), forwards `includeDisabled`.
 *   - GET maps "not found" error message to 404, anything else 400.
 *   - POST: requires valid `schedule` (kind: at|every|cron) + agentTurn payload.
 *   - POST returns 201 on success; 404/400 on errors.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/cron/runtime", () => ({
  ensureCronSchedulerStarted: vi.fn(),
}));

vi.mock("@/lib/cron/service", () => ({
  listCronJobs: vi.fn(),
  addCronJob: vi.fn(),
}));

import { GET, POST } from "./route";
import { ensureCronSchedulerStarted } from "@/lib/cron/runtime";
import { addCronJob, listCronJobs } from "@/lib/cron/service";

const mockedStart = vi.mocked(ensureCronSchedulerStarted);
const mockedList = vi.mocked(listCronJobs);
const mockedAdd = vi.mocked(addCronJob);

beforeEach(() => {
  vi.clearAllMocks();
  mockedStart.mockResolvedValue(undefined);
});

const params = (id: string) => ({ params: Promise.resolve({ id }) });

function buildGet(query = ""): NextRequest {
  return new NextRequest(`http://localhost:3000/api/projects/p-1/cron${query}`);
}

function buildPost(body: unknown, raw = false): NextRequest {
  return new NextRequest("http://localhost:3000/api/projects/p-1/cron", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

describe("GET /api/projects/[id]/cron — list", () => {
  it("starts the scheduler and lists jobs (no includeDisabled by default)", async () => {
    mockedList.mockResolvedValue([{ id: "j-1" } as any]);
    const res = await GET(buildGet(), params("p-1"));
    expect(res.status).toBe(200);
    expect(mockedStart).toHaveBeenCalledOnce();
    expect(mockedList).toHaveBeenCalledWith("p-1", { includeDisabled: false });
    expect((await res.json()).jobs).toHaveLength(1);
  });

  it("forwards includeDisabled=true when query param is set", async () => {
    mockedList.mockResolvedValue([]);
    await GET(buildGet("?includeDisabled=true"), params("p-1"));
    expect(mockedList).toHaveBeenCalledWith("p-1", { includeDisabled: true });
  });

  it("maps 'not found' error to 404, others to 400", async () => {
    mockedList.mockRejectedValue(new Error("project not found"));
    const res = await GET(buildGet(), params("missing"));
    expect(res.status).toBe(404);

    mockedList.mockRejectedValue(new Error("scheduler disabled"));
    const res2 = await GET(buildGet(), params("p-1"));
    expect(res2.status).toBe(400);
  });
});

describe("POST /api/projects/[id]/cron — create", () => {
  it("returns 400 on invalid JSON", async () => {
    const res = await POST(buildPost("{ broken", true), params("p-1"));
    expect(res.status).toBe(400);
    expect(mockedAdd).not.toHaveBeenCalled();
  });

  it("returns 400 on missing/invalid schedule", async () => {
    const res = await POST(
      buildPost({
        schedule: { kind: "unknown" },
        payload: { kind: "agentTurn", message: "x" },
      }),
      params("p-1")
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Invalid schedule/i);
  });

  it("returns 400 on missing payload", async () => {
    const res = await POST(
      buildPost({ schedule: { kind: "at", at: "2026-01-01T00:00:00Z" } }),
      params("p-1")
    );
    expect(res.status).toBe(400);
  });

  it("requires payload.kind='agentTurn' AND payload.message string", async () => {
    const res = await POST(
      buildPost({
        schedule: { kind: "at", at: "2026-01-01T00:00:00Z" },
        payload: { kind: "wrong", message: "x" },
      }),
      params("p-1")
    );
    expect(res.status).toBe(400);
  });

  it("returns 201 on success with the created job in the body", async () => {
    mockedAdd.mockResolvedValue({ id: "j-new", name: "x" } as any);
    const res = await POST(
      buildPost({
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "agentTurn", message: "run task" },
        name: "test job",
      }),
      params("p-1")
    );
    expect(res.status).toBe(201);
    expect((await res.json()).id).toBe("j-new");
    expect(mockedAdd).toHaveBeenCalledWith(
      "p-1",
      expect.objectContaining({
        name: "test job",
        schedule: { kind: "every", everyMs: 60_000, anchorMs: undefined },
        payload: expect.objectContaining({
          kind: "agentTurn",
          message: "run task",
        }),
      })
    );
  });

  it("coerces cron-style schedule", async () => {
    mockedAdd.mockResolvedValue({ id: "j" } as any);
    await POST(
      buildPost({
        schedule: { kind: "cron", expr: "*/5 * * * *", tz: "UTC" },
        payload: { kind: "agentTurn", message: "x" },
      }),
      params("p-1")
    );
    const call = mockedAdd.mock.calls[0][1] as any;
    expect(call.schedule).toEqual({
      kind: "cron",
      expr: "*/5 * * * *",
      tz: "UTC",
    });
  });

  it("telegramChatId number is coerced to string in the payload", async () => {
    mockedAdd.mockResolvedValue({ id: "j" } as any);
    await POST(
      buildPost({
        schedule: { kind: "at", at: "2026-01-01T00:00:00Z" },
        payload: {
          kind: "agentTurn",
          message: "x",
          telegramChatId: 12345, // number — must be String()-coerced
        },
      }),
      params("p-1")
    );
    const call = mockedAdd.mock.calls[0][1] as any;
    expect(call.payload.telegramChatId).toBe("12345");
  });

  it("maps 'not found' service error to 404", async () => {
    mockedAdd.mockRejectedValue(new Error("project p-1 not found"));
    const res = await POST(
      buildPost({
        schedule: { kind: "at", at: "2026-01-01T00:00:00Z" },
        payload: { kind: "agentTurn", message: "x" },
      }),
      params("p-1")
    );
    expect(res.status).toBe(404);
  });
});
