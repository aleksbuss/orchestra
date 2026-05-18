/**
 * Tests for GET / PUT /api/projects/[id]/mcp — read + save the raw
 * mcp-servers.json for a project.
 *
 * Pinned invariants:
 *   - 404 from both verbs when the project doesn't exist.
 *   - GET returns the raw content + parsed `servers[]` array.
 *   - GET on a project without an mcp-servers.json yet returns
 *     `{content: null, servers: []}` (ENOENT recovery — UI shows "no
 *     config yet" instead of an error).
 *   - PUT requires `content` to be a string. 400 on invalid JSON body.
 *   - PUT delegates validation + write to `saveProjectMcpServersContent`;
 *     400 maps from that function's failure shape.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "node:fs/promises";

vi.mock("@/lib/storage/project-store", () => ({
  getProject: vi.fn(),
  getProjectMcpServersPath: vi.fn(),
  loadProjectMcpServers: vi.fn(),
  saveProjectMcpServersContent: vi.fn(),
}));

import { GET, PUT } from "./route";
import {
  getProject,
  getProjectMcpServersPath,
  loadProjectMcpServers,
  saveProjectMcpServersContent,
} from "@/lib/storage/project-store";

const mockedGet = vi.mocked(getProject);
const mockedPath = vi.mocked(getProjectMcpServersPath);
const mockedLoad = vi.mocked(loadProjectMcpServers);
const mockedSave = vi.mocked(saveProjectMcpServersContent);

let readFileSpy: any;

beforeEach(() => {
  vi.clearAllMocks();
  mockedPath.mockReturnValue("/abs/p-1/.meta/mcp/servers.json");
  mockedGet.mockResolvedValue({ id: "p-1", name: "Test" } as any);
  readFileSpy?.mockRestore();
  readFileSpy = vi.spyOn(fs, "readFile");
});

function buildPut(body: unknown, raw = false): NextRequest {
  return new NextRequest("http://localhost:3000/api/projects/p-1/mcp", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

const reqGet = () =>
  new NextRequest("http://localhost:3000/api/projects/p-1/mcp");
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("GET /api/projects/[id]/mcp", () => {
  it("returns 404 when project doesn't exist", async () => {
    mockedGet.mockResolvedValue(null);
    const res = await GET(reqGet(), params("missing"));
    expect(res.status).toBe(404);
  });

  it("returns raw content + parsed servers", async () => {
    readFileSpy.mockResolvedValue('{"mcpServers": {"x": {"command": "ls"}}}');
    mockedLoad.mockResolvedValue({
      servers: [
        { id: "x", transport: "stdio", command: "ls", args: [] } as any,
      ],
    });
    const res = await GET(reqGet(), params("p-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toContain("mcpServers");
    expect(body.servers).toHaveLength(1);
  });

  it("returns {content:null, servers:[]} on ENOENT (no config yet)", async () => {
    const err = new Error("ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    readFileSpy.mockRejectedValue(err);
    mockedLoad.mockResolvedValue(null);

    const res = await GET(reqGet(), params("p-1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ content: null, servers: [] });
  });

  it("returns 500 on read errors other than ENOENT", async () => {
    readFileSpy.mockRejectedValue(new Error("EACCES — permission denied"));
    const res = await GET(reqGet(), params("p-1"));
    expect(res.status).toBe(500);
  });
});

describe("PUT /api/projects/[id]/mcp", () => {
  it("returns 404 when project doesn't exist", async () => {
    mockedGet.mockResolvedValue(null);
    const res = await PUT(buildPut({ content: "x" }), params("missing"));
    expect(res.status).toBe(404);
  });

  it("returns 400 on non-string `content` field", async () => {
    const res = await PUT(buildPut({ content: 42 }), params("p-1"));
    expect(res.status).toBe(400);
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it("returns 400 on missing `content` field", async () => {
    const res = await PUT(buildPut({}), params("p-1"));
    expect(res.status).toBe(400);
  });

  it("returns 400 on invalid JSON in request body", async () => {
    const res = await PUT(buildPut("{ broken", true), params("p-1"));
    expect(res.status).toBe(400);
  });

  it("forwards content to saveProjectMcpServersContent and returns 200 on success", async () => {
    mockedSave.mockResolvedValue({
      success: true,
      filePath: "/abs",
      content: "normalized",
      servers: [],
    });
    const res = await PUT(buildPut({ content: "raw json" }), params("p-1"));
    expect(res.status).toBe(200);
    expect(mockedSave).toHaveBeenCalledWith("p-1", "raw json");
    const body = await res.json();
    expect(body.content).toBe("normalized");
  });

  it("returns 400 when save validation fails (bubbles up the error message)", async () => {
    mockedSave.mockResolvedValue({
      success: false,
      error: 'Invalid server id "../evil"',
    });
    const res = await PUT(buildPut({ content: "{}" }), params("p-1"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/\.\.\/evil/);
  });
});
