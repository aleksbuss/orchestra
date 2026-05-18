/**
 * Tests for POST /api/chat/abort — cancel a running background agent job.
 *
 * Pinned invariants:
 *   - 400 on missing/non-string chatId.
 *   - Reports `wasActive` (whether a job was running) and `aborted`
 *     (whether abort actually fired). Useful for the UI to differentiate
 *     "nothing to cancel" from "cancellation sent."
 *   - 500 catches unexpected throws; never lets a daemon error bubble up
 *     as an unhandled promise rejection.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/agent/daemon", () => ({
  abortJob: vi.fn(),
  isJobActive: vi.fn(),
}));

import { POST } from "./route";
import { abortJob, isJobActive } from "@/lib/agent/daemon";

const mockedAbort = vi.mocked(abortJob);
const mockedActive = vi.mocked(isJobActive);

beforeEach(() => {
  vi.clearAllMocks();
});

function buildRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/chat/abort", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/chat/abort", () => {
  it("returns 400 when chatId is missing", async () => {
    const res = await POST(buildRequest({}));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/chatId.*required/i);
    expect(mockedAbort).not.toHaveBeenCalled();
  });

  it("returns 400 when chatId is not a string", async () => {
    const res1 = await POST(buildRequest({ chatId: 42 }));
    expect(res1.status).toBe(400);
    const res2 = await POST(buildRequest({ chatId: null }));
    expect(res2.status).toBe(400);
  });

  it("forwards chatId to abortJob and isJobActive", async () => {
    mockedActive.mockReturnValue(true);
    mockedAbort.mockReturnValue(true);

    const res = await POST(buildRequest({ chatId: "c-1" }));
    expect(res.status).toBe(200);
    expect(mockedActive).toHaveBeenCalledWith("c-1");
    expect(mockedAbort).toHaveBeenCalledWith("c-1");
  });

  it("reports both wasActive AND aborted in the response", async () => {
    mockedActive.mockReturnValue(true);
    mockedAbort.mockReturnValue(true);
    const res = await POST(buildRequest({ chatId: "c-1" }));
    const body = await res.json();
    expect(body).toEqual({ success: true, aborted: true, wasActive: true });
  });

  it("returns aborted=false when no job was running (UI surfaces 'nothing to cancel')", async () => {
    mockedActive.mockReturnValue(false);
    mockedAbort.mockReturnValue(false);
    const res = await POST(buildRequest({ chatId: "c-orphan" }));
    const body = await res.json();
    expect(body.wasActive).toBe(false);
    expect(body.aborted).toBe(false);
  });

  it("returns 500 on unexpected throws (does NOT leak the error message)", async () => {
    mockedActive.mockImplementation(() => {
      throw new Error("internal daemon issue with /etc/secrets-or-something");
    });
    const res = await POST(buildRequest({ chatId: "c-1" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    // The route uses a generic "Internal server error" — does not surface
    // internal details that may leak shape.
    expect(body.error).toBe("Internal server error");
  });
});
