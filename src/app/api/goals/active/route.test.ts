/**
 * Tests for GET /api/goals/active — returns the active GoalTree for a chat.
 *
 * Pinned invariants:
 *   - Missing chatId → `{goal: null}` (no 400; the UI uses this in a
 *     defensive query, blank chatId means "I don't have a chat yet").
 *   - Goal with status !== "active" → `{goal: null}`. The route is the
 *     boundary that the UI relies on for "do I show a goal tree?"
 *   - 500 with a sanitized error message on storage failure.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/storage/goal-store", () => ({
  getActiveGoal: vi.fn(),
}));

import { GET } from "./route";
import { getActiveGoal } from "@/lib/storage/goal-store";

const mocked = vi.mocked(getActiveGoal);

beforeEach(() => {
  vi.clearAllMocks();
});

function buildRequest(query: string): Request {
  return new Request(`http://localhost:3000/api/goals/active${query}`);
}

describe("GET /api/goals/active", () => {
  it("returns goal:null when no chatId query param", async () => {
    const res = await GET(buildRequest(""));
    expect(res.status).toBe(200);
    expect((await res.json()).goal).toBeNull();
    expect(mocked).not.toHaveBeenCalled();
  });

  it("returns goal:null when goal is missing", async () => {
    mocked.mockResolvedValue(null);
    const res = await GET(buildRequest("?chatId=c-1"));
    expect((await res.json()).goal).toBeNull();
  });

  it("returns goal:null when goal exists but is NOT active", async () => {
    mocked.mockResolvedValue({ status: "completed", tasks: [] } as any);
    const res = await GET(buildRequest("?chatId=c-1"));
    expect((await res.json()).goal).toBeNull();
  });

  it("returns the active goal when present", async () => {
    const goal = { status: "active", chatId: "c-1", tasks: [] };
    mocked.mockResolvedValue(goal as any);
    const res = await GET(buildRequest("?chatId=c-1"));
    expect((await res.json()).goal).toEqual(goal);
  });

  it("returns 500 on storage error", async () => {
    mocked.mockRejectedValue(new Error("disk read failed"));
    const res = await GET(buildRequest("?chatId=c-1"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to fetch active goal");
  });
});
