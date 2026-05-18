/**
 * Tests for /api/chat/files — GET list, POST multipart upload, DELETE by name.
 *
 * Pinned invariants:
 *   - chatId is required on all verbs (400 otherwise).
 *   - POST is multipart/form-data; `file` field is the binary.
 *   - POST reads file as ArrayBuffer → Buffer and forwards to `saveChatFile`.
 *   - DELETE 404 when filename doesn't exist (chat-files-store returns false).
 *   - Each verb maps storage exceptions to 500 with a sanitized message.
 *   - The store call signature is preserved (chatId, buffer, filename) —
 *     drift here would silently swap arguments.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/storage/chat-files-store", () => ({
  getChatFiles: vi.fn(),
  saveChatFile: vi.fn(),
  deleteChatFile: vi.fn(),
}));

import { GET, POST, DELETE } from "./route";
import {
  getChatFiles,
  saveChatFile,
  deleteChatFile,
} from "@/lib/storage/chat-files-store";

const mockedGet = vi.mocked(getChatFiles);
const mockedSave = vi.mocked(saveChatFile);
const mockedDelete = vi.mocked(deleteChatFile);

beforeEach(() => {
  vi.clearAllMocks();
});

function buildGet(query: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/chat/files${query}`);
}

function buildDelete(query: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/chat/files${query}`, {
    method: "DELETE",
  });
}

function buildPostMultipart(
  chatId: string | null,
  fileBytes: Uint8Array | null,
  filename = "doc.pdf"
): NextRequest {
  const form = new FormData();
  if (chatId !== null) form.append("chatId", chatId);
  if (fileBytes !== null) {
    form.append("file", new Blob([fileBytes]), filename);
  }
  return new NextRequest("http://localhost:3000/api/chat/files", {
    method: "POST",
    body: form,
  });
}

describe("GET /api/chat/files — list", () => {
  it("returns 400 when chatId is missing", async () => {
    const res = await GET(buildGet(""));
    expect(res.status).toBe(400);
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it("returns {files: [...]} for a known chat", async () => {
    mockedGet.mockResolvedValue([
      { name: "a.txt", path: "/abs/a.txt", size: 5 } as any,
      { name: "b.pdf", path: "/abs/b.pdf", size: 200 } as any,
    ]);

    const res = await GET(buildGet("?chatId=c-1"));
    expect(res.status).toBe(200);
    expect(mockedGet).toHaveBeenCalledWith("c-1");
    const body = await res.json();
    expect(body.files).toHaveLength(2);
  });

  it("returns 500 + sanitized error when store throws", async () => {
    mockedGet.mockRejectedValue(new Error("disk read failed"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET(buildGet("?chatId=c-1"));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Failed to get chat files");
    errSpy.mockRestore();
  });
});

describe("POST /api/chat/files — upload", () => {
  it("returns 400 when chatId is missing", async () => {
    const res = await POST(
      buildPostMultipart(null, new Uint8Array([1, 2, 3]))
    );
    expect(res.status).toBe(400);
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it("returns 400 when file is missing", async () => {
    const res = await POST(buildPostMultipart("c-1", null));
    expect(res.status).toBe(400);
  });

  it("forwards (chatId, buffer, filename) to saveChatFile in the right order", async () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    mockedSave.mockResolvedValue({
      name: "doc.pdf",
      path: "/abs/doc.pdf",
      size: 4,
    } as any);

    await POST(buildPostMultipart("c-1", bytes, "doc.pdf"));
    expect(mockedSave).toHaveBeenCalledOnce();
    const [chatId, buffer, filename] = mockedSave.mock.calls[0];
    expect(chatId).toBe("c-1");
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(filename).toBe("doc.pdf");
    expect((buffer as Buffer).length).toBe(4);
  });

  it("returns 500 on store error", async () => {
    mockedSave.mockRejectedValue(new Error("EACCES"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(
      buildPostMultipart("c-1", new Uint8Array([1]), "x.txt")
    );
    expect(res.status).toBe(500);
    errSpy.mockRestore();
  });
});

describe("DELETE /api/chat/files", () => {
  it("returns 400 when chatId is missing", async () => {
    const res = await DELETE(buildDelete("?filename=x.txt"));
    expect(res.status).toBe(400);
  });

  it("returns 400 when filename is missing", async () => {
    const res = await DELETE(buildDelete("?chatId=c-1"));
    expect(res.status).toBe(400);
  });

  it("returns 404 when the file doesn't exist", async () => {
    mockedDelete.mockResolvedValue(false);
    const res = await DELETE(buildDelete("?chatId=c-1&filename=missing"));
    expect(res.status).toBe(404);
  });

  it("returns 200 + success on delete", async () => {
    mockedDelete.mockResolvedValue(true);
    const res = await DELETE(buildDelete("?chatId=c-1&filename=ok.txt"));
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(mockedDelete).toHaveBeenCalledWith("c-1", "ok.txt");
  });

  it("returns 500 on store throw", async () => {
    mockedDelete.mockRejectedValue(new Error("EACCES"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await DELETE(buildDelete("?chatId=c-1&filename=x.txt"));
    expect(res.status).toBe(500);
    errSpy.mockRestore();
  });
});
