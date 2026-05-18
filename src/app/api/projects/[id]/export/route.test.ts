/**
 * Tests for GET /api/projects/[id]/export.
 *
 * The endpoint streams a ZIP of the project's working directory + its chats.
 * What we pin:
 *   - 400 on a malformed project id (regex reject) — BEFORE any FS access.
 *   - 404 when getProject returns null.
 *   - 404 when the working directory doesn't exist on disk.
 *   - 200 with `application/zip` + `Content-Disposition: attachment; filename=...`
 *     on the happy path.
 *   - The ZIP body contains the project's files under `<projectName>/...`,
 *     a `_manifest.json` at the archive root, and excludes the disallowed
 *     directories (`node_modules`, `.venv`, `__pycache__`, `.git`).
 *   - Symlinks pointing outside the work dir are skipped, not exfiltrated
 *     (PM #6 / #16 family — defence-in-depth via `assertPathInside`).
 *   - Chats whose `projectId` matches are bundled under `_chats/`.
 *
 * We use a real tmp workdir + a real `archiver` here. Mocks are limited to
 * the chat/project stores so the test stays hermetic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import AdmZipModule from "adm-zip";

vi.mock("@/lib/storage/project-store", () => ({
  getProject: vi.fn(),
  resolveWorkDirForProject: vi.fn(),
}));

vi.mock("@/lib/storage/chat-store", () => ({
  getAllChats: vi.fn(),
  getChat: vi.fn(),
}));

import { GET } from "./route";
import { getProject, resolveWorkDirForProject } from "@/lib/storage/project-store";
import { getAllChats, getChat } from "@/lib/storage/chat-store";
import { NextRequest } from "next/server";

const mockedGetProject = vi.mocked(getProject);
const mockedResolveWorkDir = vi.mocked(resolveWorkDirForProject);
const mockedGetAllChats = vi.mocked(getAllChats);
const mockedGetChat = vi.mocked(getChat);

let tmpRoot: string;

beforeEach(async () => {
  vi.clearAllMocks();
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-export-"));
  mockedGetAllChats.mockResolvedValue([]);
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const req = () =>
  new NextRequest("http://localhost:3000/api/projects/p-1/export");

async function readZipFromResponse(res: Response): Promise<AdmZipModule> {
  const buffer = Buffer.from(await res.arrayBuffer());
  return new AdmZipModule(buffer);
}

describe("GET /api/projects/[id]/export — input validation", () => {
  it("returns 400 for an empty project id", async () => {
    const res = await GET(req(), params(""));
    expect(res.status).toBe(400);
    expect(mockedGetProject).not.toHaveBeenCalled();
  });

  it("returns 400 for a project id with path separators (traversal attempt)", async () => {
    const res = await GET(req(), params("../../etc"));
    expect(res.status).toBe(400);
    expect(mockedGetProject).not.toHaveBeenCalled();
  });

  it("returns 400 for a project id with whitespace inside", async () => {
    const res = await GET(req(), params("my project"));
    expect(res.status).toBe(400);
    expect(mockedGetProject).not.toHaveBeenCalled();
  });

  it("returns 400 for a project id starting with a hyphen", async () => {
    const res = await GET(req(), params("-leading-hyphen"));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/projects/[id]/export — missing project", () => {
  it("returns 404 when getProject returns null", async () => {
    mockedGetProject.mockResolvedValue(null as any);
    const res = await GET(req(), params("p-1"));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/not found/i);
  });

  it("returns 404 when the workspace directory does not exist on disk", async () => {
    mockedGetProject.mockResolvedValue({
      id: "p-1",
      name: "Demo Project",
    } as any);
    mockedResolveWorkDir.mockResolvedValue(
      path.join(tmpRoot, "does-not-exist")
    );
    const res = await GET(req(), params("p-1"));
    expect(res.status).toBe(404);
  });
});

describe("GET /api/projects/[id]/export — happy path", () => {
  it("streams a ZIP with attachment headers + manifest", async () => {
    // Plant a workdir with a couple of files.
    const workDir = path.join(tmpRoot, "work");
    await fs.mkdir(workDir, { recursive: true });
    await fs.writeFile(path.join(workDir, "hello.txt"), "alpha bravo");
    await fs.mkdir(path.join(workDir, "src"), { recursive: true });
    await fs.writeFile(path.join(workDir, "src", "index.ts"), "export {};");

    mockedGetProject.mockResolvedValue({
      id: "p-1",
      name: "Demo Project",
      description: "test",
      createdAt: "2026-05-01T00:00:00Z",
      updatedAt: "2026-05-10T00:00:00Z",
    } as any);
    mockedResolveWorkDir.mockResolvedValue(workDir);

    const res = await GET(req(), params("p-1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    const disposition = res.headers.get("Content-Disposition") ?? "";
    expect(disposition).toMatch(/attachment/);
    expect(disposition).toMatch(/filename="Demo-Project-\d{4}-\d{2}-\d{2}\.zip"/);

    const zip = await readZipFromResponse(res);
    const names = zip.getEntries().map((e) => e.entryName).sort();

    // Files land under the sanitized project name folder.
    expect(names).toContain("Demo-Project/hello.txt");
    expect(names).toContain("Demo-Project/src/index.ts");

    // Manifest is at the project root inside the archive.
    expect(names).toContain("Demo-Project/_manifest.json");

    // Manifest content sanity.
    const manifestEntry = zip.getEntry("Demo-Project/_manifest.json")!;
    const manifest = JSON.parse(manifestEntry.getData().toString("utf-8"));
    expect(manifest.project.id).toBe("p-1");
    expect(manifest.project.name).toBe("Demo Project");
    expect(manifest.chatCount).toBe(0);
    expect(typeof manifest.exportedAt).toBe("string");
  });

  it("excludes node_modules, .venv, .git, __pycache__, and *.pyc files", async () => {
    const workDir = path.join(tmpRoot, "work");
    await fs.mkdir(path.join(workDir, "node_modules", "react"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(workDir, "node_modules", "react", "index.js"),
      "module.exports = {}"
    );
    await fs.mkdir(path.join(workDir, ".venv", "lib"), { recursive: true });
    await fs.writeFile(path.join(workDir, ".venv", "lib", "x.py"), "");
    await fs.mkdir(path.join(workDir, ".git"), { recursive: true });
    await fs.writeFile(path.join(workDir, ".git", "HEAD"), "ref: ");
    await fs.mkdir(path.join(workDir, "__pycache__"), { recursive: true });
    await fs.writeFile(path.join(workDir, "__pycache__", "a.pyc"), "");
    await fs.writeFile(path.join(workDir, "stray.pyc"), "");
    await fs.writeFile(path.join(workDir, "keep-me.md"), "kept");

    mockedGetProject.mockResolvedValue({ id: "p-1", name: "Proj" } as any);
    mockedResolveWorkDir.mockResolvedValue(workDir);

    const res = await GET(req(), params("p-1"));
    expect(res.status).toBe(200);
    const zip = await readZipFromResponse(res);
    const names = zip.getEntries().map((e) => e.entryName);

    expect(names).toContain("Proj/keep-me.md");
    // Critical exclusions — none of these may appear under ANY prefix.
    expect(names.some((n) => n.includes("node_modules"))).toBe(false);
    expect(names.some((n) => n.includes(".venv"))).toBe(false);
    expect(names.some((n) => n.includes(".git/"))).toBe(false);
    expect(names.some((n) => n.includes("__pycache__"))).toBe(false);
    expect(names.some((n) => n.endsWith(".pyc"))).toBe(false);
  });

  it("includes chats matching the project id under _chats/", async () => {
    const workDir = path.join(tmpRoot, "work");
    await fs.mkdir(workDir, { recursive: true });
    await fs.writeFile(path.join(workDir, "README.md"), "hi");

    mockedGetProject.mockResolvedValue({ id: "p-1", name: "Proj" } as any);
    mockedResolveWorkDir.mockResolvedValue(workDir);

    mockedGetAllChats.mockResolvedValue([
      { id: "chat-a", projectId: "p-1", title: "A" } as any,
      { id: "chat-b", projectId: "other-proj", title: "B" } as any,
      { id: "chat-c", projectId: "p-1", title: "C" } as any,
    ]);
    mockedGetChat.mockImplementation(async (id: string) =>
      id === "chat-a" || id === "chat-c"
        ? ({ id, title: id, messages: [] } as any)
        : null
    );

    const res = await GET(req(), params("p-1"));
    expect(res.status).toBe(200);
    const zip = await readZipFromResponse(res);
    const names = zip.getEntries().map((e) => e.entryName);

    expect(names).toContain("Proj/_chats/chat-a.json");
    expect(names).toContain("Proj/_chats/chat-c.json");
    // chat-b belongs to another project; must not be exfiltrated.
    expect(names.some((n) => n.includes("chat-b"))).toBe(false);
  });

  it("does not exfiltrate files outside workDir via a symlink", async () => {
    const workDir = path.join(tmpRoot, "work");
    const outside = path.join(tmpRoot, "outside-secret");
    await fs.mkdir(workDir, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, "secret.env"), "OPENAI_API_KEY=hunter2");
    await fs.writeFile(path.join(workDir, "safe.txt"), "fine");
    // Plant a symlink inside workDir that points outside it.
    await fs.symlink(outside, path.join(workDir, "escape-link"));

    mockedGetProject.mockResolvedValue({ id: "p-1", name: "Proj" } as any);
    mockedResolveWorkDir.mockResolvedValue(workDir);

    const res = await GET(req(), params("p-1"));
    expect(res.status).toBe(200);
    const zip = await readZipFromResponse(res);
    const names = zip.getEntries().map((e) => e.entryName);

    expect(names).toContain("Proj/safe.txt");
    // The symlink itself MAY appear (we skip on type), but its contents
    // MUST NOT — the secret file outside workDir must be absent.
    expect(names.some((n) => n.endsWith("secret.env"))).toBe(false);
    expect(names.some((n) => n.includes("hunter2"))).toBe(false);
  });

  it("falls back to project id when name is missing or unsafe", async () => {
    const workDir = path.join(tmpRoot, "work");
    await fs.mkdir(workDir, { recursive: true });
    await fs.writeFile(path.join(workDir, "x.txt"), "x");

    mockedGetProject.mockResolvedValue({ id: "p-1", name: "" } as any);
    mockedResolveWorkDir.mockResolvedValue(workDir);

    const res = await GET(req(), params("p-1"));
    expect(res.status).toBe(200);
    const zip = await readZipFromResponse(res);
    const names = zip.getEntries().map((e) => e.entryName);

    // With no usable name, the folder is the raw project id.
    expect(names).toContain("p-1/x.txt");
    expect(names).toContain("p-1/_manifest.json");
  });
});
