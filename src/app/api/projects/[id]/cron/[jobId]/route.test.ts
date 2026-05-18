/**
 * Tests for /api/projects/[id]/cron/[jobId] — GET / PATCH / DELETE.
 *
 * Pinned invariants:
 *   - All verbs boot the scheduler.
 *   - GET 404 when job is null; 404 also when service throws "not found".
 *   - PATCH validates each optional field shape; bad JSON → 400.
 *   - PATCH coerces telegramChatId number → string.
 *   - PATCH `payload` extracts only known fields (kind always = agentTurn).
 *   - DELETE returns 404 when removeCronJob.removed is false.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/cron/runtime", () => ({
  ensureCronSchedulerStarted: vi.fn(),
}));

vi.mock("@/lib/cron/service", () => ({
  getCronJob: vi.fn(),
  updateCronJob: vi.fn(),
  removeCronJob: vi.fn(),
}));

import { GET, PATCH, DELETE } from "./route";
import { ensureCronSchedulerStarted } from "@/lib/cron/runtime";
import { getCronJob, removeCronJob, updateCronJob } from "@/lib/cron/service";

const mockedStart = vi.mocked(ensureCronSchedulerStarted);
const mockedGet = vi.mocked(getCronJob);
const mockedUpdate = vi.mocked(updateCronJob);
const mockedRemove = vi.mocked(removeCronJob);

beforeEach(() => {
  vi.clearAllMocks();
  mockedStart.mockResolvedValue(undefined);
});

const params = (id: string, jobId: string) => ({
  params: Promise.resolve({ id, jobId }),
});

function buildReq(method: string, body?: unknown, raw = false): NextRequest {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = raw ? (body as string) : JSON.stringify(body);
  }
  return new NextRequest(
    "http://localhost:3000/api/projects/p-1/cron/j-1",
    init
  );
}

describe("GET /api/projects/[id]/cron/[jobId]", () => {
  it("returns 200 + job when found", async () => {
    mockedGet.mockResolvedValue({ id: "j-1", name: "X" } as any);
    const res = await GET(buildReq("GET"), params("p-1", "j-1"));
    expect(res.status).toBe(200);
    expect(mockedStart).toHaveBeenCalledOnce();
    expect(mockedGet).toHaveBeenCalledWith("p-1", "j-1");
    expect((await res.json()).id).toBe("j-1");
  });

  it("returns 404 when getCronJob resolves to null", async () => {
    mockedGet.mockResolvedValue(null as any);
    const res = await GET(buildReq("GET"), params("p-1", "missing"));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/not found/i);
  });

  it("maps 'not found' error message to 404", async () => {
    mockedGet.mockRejectedValue(new Error("project p-1 not found"));
    const res = await GET(buildReq("GET"), params("p-1", "j-1"));
    expect(res.status).toBe(404);
  });

  it("maps generic error to 400", async () => {
    mockedGet.mockRejectedValue(new Error("scheduler down"));
    const res = await GET(buildReq("GET"), params("p-1", "j-1"));
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/projects/[id]/cron/[jobId]", () => {
  it("returns 400 on invalid JSON", async () => {
    const res = await PATCH(
      buildReq("PATCH", "{ not json", true),
      params("p-1", "j-1")
    );
    expect(res.status).toBe(400);
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it("returns 400 when enabled is not a boolean", async () => {
    const res = await PATCH(
      buildReq("PATCH", { enabled: "yes" }),
      params("p-1", "j-1")
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/enabled must be a boolean/i);
  });

  it("returns 400 when deleteAfterRun is not a boolean", async () => {
    const res = await PATCH(
      buildReq("PATCH", { deleteAfterRun: 1 }),
      params("p-1", "j-1")
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/deleteAfterRun must be a boolean/i);
  });

  it("returns 400 when schedule patch is unrecognizable", async () => {
    const res = await PATCH(
      buildReq("PATCH", { schedule: { kind: "wibble" } }),
      params("p-1", "j-1")
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Invalid schedule patch/i);
  });

  it("returns 400 when payload patch is not an object", async () => {
    const res = await PATCH(
      buildReq("PATCH", { payload: "noop" }),
      params("p-1", "j-1")
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Invalid payload patch/i);
  });

  it("returns 200 with patched job and forwards normalized patch", async () => {
    mockedUpdate.mockResolvedValue({ id: "j-1", name: "renamed" } as any);
    const res = await PATCH(
      buildReq("PATCH", {
        name: "renamed",
        description: "ok",
        enabled: false,
        deleteAfterRun: true,
        schedule: { kind: "every", everyMs: 30_000, anchorMs: 12345 },
        payload: {
          message: "do it",
          chatId: "c-1",
          telegramChatId: 555, // number — must be String()-coerced
          currentPath: "/x",
          timeoutSeconds: 60,
        },
      }),
      params("p-1", "j-1")
    );
    expect(res.status).toBe(200);
    expect(mockedUpdate).toHaveBeenCalledOnce();
    const [pid, jid, patch] = mockedUpdate.mock.calls[0] as any;
    expect(pid).toBe("p-1");
    expect(jid).toBe("j-1");
    expect(patch.name).toBe("renamed");
    expect(patch.description).toBe("ok");
    expect(patch.enabled).toBe(false);
    expect(patch.deleteAfterRun).toBe(true);
    expect(patch.schedule).toEqual({
      kind: "every",
      everyMs: 30_000,
      anchorMs: 12345,
    });
    expect(patch.payload).toMatchObject({
      kind: "agentTurn",
      message: "do it",
      chatId: "c-1",
      telegramChatId: "555",
      currentPath: "/x",
      timeoutSeconds: 60,
    });
  });

  it("coerces non-string name/description to empty string (a deliberate scrub)", async () => {
    mockedUpdate.mockResolvedValue({ id: "j-1" } as any);
    await PATCH(
      buildReq("PATCH", { name: 123, description: { x: 1 } }),
      params("p-1", "j-1")
    );
    const [, , patch] = mockedUpdate.mock.calls[0] as any;
    expect(patch.name).toBe("");
    expect(patch.description).toBe("");
  });

  it("returns 404 when updateCronJob resolves to null", async () => {
    mockedUpdate.mockResolvedValue(null as any);
    const res = await PATCH(
      buildReq("PATCH", { name: "x" }),
      params("p-1", "missing")
    );
    expect(res.status).toBe(404);
  });

  it("maps 'not found' service error to 404", async () => {
    mockedUpdate.mockRejectedValue(new Error("project not found"));
    const res = await PATCH(
      buildReq("PATCH", { name: "x" }),
      params("missing", "j-1")
    );
    expect(res.status).toBe(404);
  });

  it("accepts a cron-style schedule patch", async () => {
    mockedUpdate.mockResolvedValue({ id: "j-1" } as any);
    await PATCH(
      buildReq("PATCH", {
        schedule: { kind: "cron", expr: "*/10 * * * *", tz: "Europe/Riga" },
      }),
      params("p-1", "j-1")
    );
    const [, , patch] = mockedUpdate.mock.calls[0] as any;
    expect(patch.schedule).toEqual({
      kind: "cron",
      expr: "*/10 * * * *",
      tz: "Europe/Riga",
    });
  });

  it("accepts an 'at' schedule patch", async () => {
    mockedUpdate.mockResolvedValue({ id: "j-1" } as any);
    await PATCH(
      buildReq("PATCH", {
        schedule: { kind: "at", at: "2026-12-31T23:00:00Z" },
      }),
      params("p-1", "j-1")
    );
    const [, , patch] = mockedUpdate.mock.calls[0] as any;
    expect(patch.schedule).toEqual({
      kind: "at",
      at: "2026-12-31T23:00:00Z",
    });
  });
});

describe("DELETE /api/projects/[id]/cron/[jobId]", () => {
  it("returns 200 + success when removed", async () => {
    mockedRemove.mockResolvedValue({ removed: true });
    const res = await DELETE(buildReq("DELETE"), params("p-1", "j-1"));
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });

  it("returns 404 when remove reports removed=false", async () => {
    mockedRemove.mockResolvedValue({ removed: false });
    const res = await DELETE(buildReq("DELETE"), params("p-1", "missing"));
    expect(res.status).toBe(404);
  });

  it("maps 'not found' service error to 404", async () => {
    mockedRemove.mockRejectedValue(new Error("project p-1 not found"));
    const res = await DELETE(buildReq("DELETE"), params("missing", "j-1"));
    expect(res.status).toBe(404);
  });

  it("maps generic service error to 400", async () => {
    mockedRemove.mockRejectedValue(new Error("disk full"));
    const res = await DELETE(buildReq("DELETE"), params("p-1", "j-1"));
    expect(res.status).toBe(400);
  });
});
