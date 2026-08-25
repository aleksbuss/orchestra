/**
 * Tests for GET / DELETE /api/chat/history.
 *
 * GET serves two shapes:
 *   - With `?id=<chatId>`: full chat JSON (or 404).
 *   - Without `id`: list of all chats, optionally filtered by ?projectId=
 *     (`projectId=none` means "global" / no project).
 * DELETE: 400 on missing id, 404 when not found, 200 + success on delete.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/storage/chat-store", () => ({
  getAllChats: vi.fn(),
  getChat: vi.fn(),
  deleteChat: vi.fn(),
  isValidChatId: vi.fn(),
}));

import { GET, DELETE } from "./route";
import {
  deleteChat,
  getAllChats,
  getChat,
  isValidChatId,
} from "@/lib/storage/chat-store";

const mockedAll = vi.mocked(getAllChats);
const mockedGet = vi.mocked(getChat);
const mockedDelete = vi.mocked(deleteChat);
const mockedValidId = vi.mocked(isValidChatId);

beforeEach(() => {
  vi.clearAllMocks();
  // Default: ids are well formed. The traversal cases below flip it.
  mockedValidId.mockReturnValue(true);
});

function buildGet(query: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/chat/history${query}`);
}

describe("GET /api/chat/history?id=<chatId>", () => {
  it("returns the chat when found", async () => {
    mockedGet.mockResolvedValue({ id: "c-1", messages: [] } as any);
    const res = await GET(buildGet("?id=c-1"));
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe("c-1");
  });

  it("returns 404 when not found", async () => {
    mockedGet.mockResolvedValue(null);
    const res = await GET(buildGet("?id=missing"));
    expect(res.status).toBe(404);
  });
});

describe("GET /api/chat/history (list)", () => {
  beforeEach(() => {
    mockedAll.mockResolvedValue([
      { id: "c-global", title: "g" } as any,
      { id: "c-p1", projectId: "p-1", title: "a" } as any,
      { id: "c-p1-2", projectId: "p-1", title: "b" } as any,
      { id: "c-p2", projectId: "p-2", title: "c" } as any,
    ]);
  });

  it("returns ALL chats with no projectId filter", async () => {
    const res = await GET(buildGet(""));
    const body = await res.json();
    expect(body).toHaveLength(4);
  });

  it("?projectId=p-1 filters to that project's chats", async () => {
    const res = await GET(buildGet("?projectId=p-1"));
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body.map((c) => c.id)).toEqual(["c-p1", "c-p1-2"]);
  });

  it('?projectId=none filters to GLOBAL chats only (no projectId)', async () => {
    const res = await GET(buildGet("?projectId=none"));
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body.map((c) => c.id)).toEqual(["c-global"]);
  });

  it("?projectId=unknown filters to nothing (empty array, not 404)", async () => {
    const res = await GET(buildGet("?projectId=unknown"));
    const body = await res.json();
    expect(body).toEqual([]);
  });
});

describe("DELETE /api/chat/history", () => {
  function buildDelete(query: string): NextRequest {
    return new NextRequest(`http://localhost:3000/api/chat/history${query}`, {
      method: "DELETE",
    });
  }

  it("returns 400 when id query param is missing", async () => {
    const res = await DELETE(buildDelete(""));
    expect(res.status).toBe(400);
    expect(mockedDelete).not.toHaveBeenCalled();
  });

  it("returns 404 when the chat doesn't exist", async () => {
    mockedDelete.mockResolvedValue(false);
    const res = await DELETE(buildDelete("?id=missing"));
    expect(res.status).toBe(404);
  });

  it("returns 200 + success on successful delete", async () => {
    mockedDelete.mockResolvedValue(true);
    const res = await DELETE(buildDelete("?id=c-1"));
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(mockedDelete).toHaveBeenCalledWith("c-1");
  });
});

describe("a traversal chat id is a 400, not a 500 (non-negotiable #2)", () => {
  // `getChat` / `deleteChat` resolve `<id>.json` inside `data/chats/` and the
  // store guard THROWS on traversal. Before the route-layer check, that throw
  // escaped and Next answered 500 with an empty body — on the DELETE path too.
  const TRAVERSAL = "..%2f..%2f..%2fetc%2fpasswd";

  // `buildDelete` above is scoped to its own describe block.
  function del(query: string): NextRequest {
    return new NextRequest(`http://localhost:3000/api/chat/history${query}`, {
      method: "DELETE",
    });
  }

  it("GET rejects it with 400 and never reaches the store", async () => {
    mockedValidId.mockReturnValue(false);
    const res = await GET(buildGet(`?id=${TRAVERSAL}`));
    expect(res.status).toBe(400);
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it("DELETE rejects it with 400 and never reaches the store", async () => {
    mockedValidId.mockReturnValue(false);
    const res = await DELETE(del(`?id=${TRAVERSAL}`));
    expect(res.status).toBe(400);
    expect(mockedDelete).not.toHaveBeenCalled();
  });

  it("a well-formed id still reaches the store (the guard is not a blanket block)", async () => {
    mockedGet.mockResolvedValue({ id: "c-1", messages: [] } as any);
    const res = await GET(buildGet("?id=c-1"));
    expect(res.status).toBe(200);
    expect(mockedGet).toHaveBeenCalledWith("c-1");
  });
});
