/**
 * Tests for `project-store.ts` — the JSON-on-disk "main table" of
 * Orchestra. The full file is 1500+ lines; this suite covers four
 * tightly-scoped layers:
 *
 *   1. Path helpers (sync, pure-ish — `getWorkDir`, `getProjectSkillsDir`,
 *      `getProjectMcpDir`, etc.)
 *   2. Skill-name validation (pure function, security-relevant)
 *   3. Project CRUD (`getAllProjects`, `getProject`, `createProject`,
 *      `updateProject`, `deleteProject`)
 *   4. File-tree readout (`getProjectFiles`) and the work-dir resolver
 *      (`resolveWorkDirForProject`).
 *
 * Skill mutations + MCP server config + GitHub install — these are
 * 600+ lines of separate logic and need their own follow-up suite.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

vi.mock("@/lib/storage/chat-store", () => ({
  deleteChatsByProjectId: vi.fn(),
}));

vi.mock("@/lib/memory/memory", () => ({
  clearMemoryCache: vi.fn(),
}));

vi.mock("@/lib/realtime/event-bus", () => ({
  publishUiSyncEvent: vi.fn(),
}));

import {
  deleteChatsByProjectId,
} from "@/lib/storage/chat-store";
import { clearMemoryCache } from "@/lib/memory/memory";
import { publishUiSyncEvent } from "@/lib/realtime/event-bus";

// PROJECTS_DIR / DATA_DIR are computed at module-load time via cwd().
// We dynamic-import per test after installing the cwd spy.
async function loadModule() {
  return await import("./project-store");
}

const mockedDeleteChats = vi.mocked(deleteChatsByProjectId);
const mockedClearMemory = vi.mocked(clearMemoryCache);
const mockedPublish = vi.mocked(publishUiSyncEvent);

let tmpRoot: string;
let cwdSpy: any;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-projstore-"));
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmpRoot);
  vi.resetModules();
  vi.clearAllMocks();
  mockedDeleteChats.mockResolvedValue(0);
});

afterEach(async () => {
  cwdSpy?.mockRestore();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const projectsDir = () => path.join(tmpRoot, "data", "projects");

// ────────────────────────────────────────────────────────────
// TIER 1 — path helpers
// ────────────────────────────────────────────────────────────

describe("getWorkDir — sync sandbox / global / linked-root resolver", () => {
  it("returns PROJECTS_DIR for null/undefined projectId (global)", async () => {
    const m = await loadModule();
    expect(m.getWorkDir(null)).toBe(projectsDir());
    expect(m.getWorkDir(undefined)).toBe(projectsDir());
  });

  it("returns PROJECTS_DIR for the literal GLOBAL_PROJECT_ID 'none'", async () => {
    const m = await loadModule();
    expect(m.getWorkDir("none")).toBe(projectsDir());
    expect(m.GLOBAL_PROJECT_ID).toBe("none");
  });

  it("returns sandbox path for a real project id", async () => {
    const m = await loadModule();
    expect(m.getWorkDir("proj-1")).toBe(path.join(projectsDir(), "proj-1"));
  });

  it("absoluteRoot wins — returns it verbatim when provided (linked project)", async () => {
    const m = await loadModule();
    expect(m.getWorkDir("proj-1", "/Users/me/repos/foo")).toBe(
      "/Users/me/repos/foo"
    );
  });

  it("ignores empty/whitespace absoluteRoot (falls back to sandbox)", async () => {
    const m = await loadModule();
    expect(m.getWorkDir("proj-1", "")).toBe(path.join(projectsDir(), "proj-1"));
    expect(m.getWorkDir("proj-1", "   ")).toBe(path.join(projectsDir(), "proj-1"));
  });
});

describe("path helpers — derived per-project paths", () => {
  it("getProjectSkillsDir → <projects>/<id>/.meta/skills", async () => {
    const m = await loadModule();
    expect(m.getProjectSkillsDir("p-1")).toBe(
      path.join(projectsDir(), "p-1", ".meta", "skills")
    );
  });

  it("getProjectInstructionsDir is an alias of getProjectSkillsDir (legacy)", async () => {
    const m = await loadModule();
    expect(m.getProjectInstructionsDir("p-1")).toBe(m.getProjectSkillsDir("p-1"));
  });

  it("getProjectMcpDir → <projects>/<id>/.meta/mcp", async () => {
    const m = await loadModule();
    expect(m.getProjectMcpDir("p-1")).toBe(
      path.join(projectsDir(), "p-1", ".meta", "mcp")
    );
  });

  it("getProjectMcpServersPath → <projects>/<id>/.meta/mcp/servers.json", async () => {
    const m = await loadModule();
    expect(m.getProjectMcpServersPath("p-1")).toBe(
      path.join(projectsDir(), "p-1", ".meta", "mcp", "servers.json")
    );
  });

  it("getProjectWorkDir is the sandbox path (NEVER honors absoluteRoot — that's getWorkDir's job)", async () => {
    const m = await loadModule();
    expect(m.getProjectWorkDir("p-1")).toBe(path.join(projectsDir(), "p-1"));
  });
});

// ────────────────────────────────────────────────────────────
// TIER 1.5 — validateSkillName (security-relevant)
// ────────────────────────────────────────────────────────────

describe("validateSkillName — pure validation (Agent Skills spec)", () => {
  // The Agent Skills spec requires lowercase letters, digits, and hyphens,
  // no leading/trailing hyphen, no consecutive hyphens, and ≤ 64 chars.
  // This regex is the implicit security boundary: skill names flow into
  // path joins as directory names, so anything that escapes the regex
  // (slashes, dots, NULL bytes) becomes a path-traversal class issue.

  it("accepts the spec-allowed shapes", async () => {
    const m = await loadModule();
    for (const name of [
      "pdf",
      "pdf-parsing",
      "my-skill",
      "abc123",
      "skill-with-many-words",
      "a", // 1-char minimum is allowed
    ]) {
      expect(m.validateSkillName(name), name).toBeNull();
    }
  });

  it("rejects empty / whitespace-only", async () => {
    const m = await loadModule();
    expect(m.validateSkillName("")).toMatch(/required/i);
    expect(m.validateSkillName("   ")).toMatch(/required/i);
  });

  it("rejects names > 64 chars", async () => {
    const m = await loadModule();
    expect(m.validateSkillName("x".repeat(65))).toMatch(/64 characters/i);
  });

  it("rejects uppercase letters (lowercase-only spec)", async () => {
    const m = await loadModule();
    expect(m.validateSkillName("MySkill")).toMatch(/lowercase/i);
    expect(m.validateSkillName("My-Skill")).toMatch(/lowercase/i);
  });

  it("rejects leading or trailing hyphens", async () => {
    const m = await loadModule();
    expect(m.validateSkillName("-bad")).not.toBeNull();
    expect(m.validateSkillName("bad-")).not.toBeNull();
  });

  it("rejects consecutive hyphens", async () => {
    const m = await loadModule();
    expect(m.validateSkillName("a--b")).not.toBeNull();
  });

  it("rejects path-traversal-class characters (slashes, dots, NULL)", async () => {
    const m = await loadModule();
    expect(m.validateSkillName("../evil")).not.toBeNull();
    expect(m.validateSkillName("a/b")).not.toBeNull();
    expect(m.validateSkillName("a\\b")).not.toBeNull();
    expect(m.validateSkillName("a.b")).not.toBeNull();
    expect(m.validateSkillName("a\x00b")).not.toBeNull();
  });

  it("rejects whitespace within the name", async () => {
    const m = await loadModule();
    expect(m.validateSkillName("a b")).not.toBeNull();
  });
});

// ────────────────────────────────────────────────────────────
// TIER 2 — project CRUD
// ────────────────────────────────────────────────────────────

const sampleProject = (id: string, overrides: Partial<{ memoryMode: "global" | "isolated"; absoluteRoot: string }> = {}) => ({
  id,
  name: `Project ${id}`,
  description: "Test project",
  instructions: "Be helpful.",
  memoryMode: overrides.memoryMode ?? ("global" as const),
  ...(overrides.absoluteRoot ? { absoluteRoot: overrides.absoluteRoot } : {}),
});

describe("createProject", () => {
  it("creates the project directory tree with skills/mcp/knowledge subdirs", async () => {
    const m = await loadModule();
    await m.createProject(sampleProject("p-1"));

    const projectDir = path.join(projectsDir(), "p-1");
    expect((await fs.stat(projectDir)).isDirectory()).toBe(true);
    expect((await fs.stat(path.join(projectDir, ".meta"))).isDirectory()).toBe(true);
    expect((await fs.stat(m.getProjectSkillsDir("p-1"))).isDirectory()).toBe(true);
    expect((await fs.stat(m.getProjectMcpDir("p-1"))).isDirectory()).toBe(true);
    expect(
      (await fs.stat(path.join(projectDir, ".meta", "knowledge"))).isDirectory()
    ).toBe(true);
  });

  it("writes project.json with createdAt + updatedAt = now", async () => {
    const m = await loadModule();
    const before = Date.now();
    const out = await m.createProject(sampleProject("p-2"));
    const after = Date.now();

    expect(out.id).toBe("p-2");
    expect(new Date(out.createdAt).toISOString()).toBe(out.createdAt);
    expect(new Date(out.updatedAt).toISOString()).toBe(out.updatedAt);
    const ts = new Date(out.createdAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
    // createdAt === updatedAt at creation time.
    expect(out.createdAt).toBe(out.updatedAt);
  });

  it("seeds .meta/mcp/servers.json with the documented default MCP servers", async () => {
    const m = await loadModule();
    await m.createProject(sampleProject("p-mcp"));
    const raw = await fs.readFile(m.getProjectMcpServersPath("p-mcp"), "utf-8");
    const parsed = JSON.parse(raw) as { mcpServers: Record<string, unknown> };
    const ids = Object.keys(parsed.mcpServers).sort();
    expect(ids).toEqual([
      "firecrawl-mcp",
      "github-mcp",
      "sendforsign-mcp",
      "sequential-thinking",
      "sqlite-mcp",
    ]);
  });

  it("emits project_created event over the realtime bus", async () => {
    const m = await loadModule();
    await m.createProject(sampleProject("p-evt"));
    expect(mockedPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: "projects",
        projectId: "p-evt",
        reason: "project_created",
      })
    );
  });

  it("preserves absoluteRoot when supplied (linked-project case)", async () => {
    const m = await loadModule();
    const out = await m.createProject(
      sampleProject("p-linked", { absoluteRoot: "/Users/me/repos/foo" })
    );
    expect(out.absoluteRoot).toBe("/Users/me/repos/foo");
    const reloaded = await m.getProject("p-linked");
    expect(reloaded?.absoluteRoot).toBe("/Users/me/repos/foo");
  });
});

describe("getProject / getAllProjects — read", () => {
  it("getProject returns null when no metadata file exists", async () => {
    const m = await loadModule();
    expect(await m.getProject("nope")).toBeNull();
  });

  it("getProject returns null on corrupted JSON (does NOT throw)", async () => {
    const m = await loadModule();
    const dir = path.join(projectsDir(), "broken", ".meta");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "project.json"), "{ broken", "utf-8");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await m.getProject("broken")).toBeNull();
    warn.mockRestore();
  });

  it("getProject returns null on schema-invalid JSON (e.g., missing required field)", async () => {
    const m = await loadModule();
    const dir = path.join(projectsDir(), "incomplete", ".meta");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "project.json"),
      JSON.stringify({ id: "incomplete" }), // missing name, description, etc.
      "utf-8"
    );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await m.getProject("incomplete")).toBeNull();
    warn.mockRestore();
  });

  it("getAllProjects returns sorted-by-updatedAt-desc (newest first)", async () => {
    const m = await loadModule();
    await m.createProject(sampleProject("a"));
    // Bump 'b' past 'a' via updateProject so the timestamps differ.
    await new Promise((r) => setTimeout(r, 5));
    await m.createProject(sampleProject("b"));
    await new Promise((r) => setTimeout(r, 5));
    await m.createProject(sampleProject("c"));

    const list = await m.getAllProjects();
    expect(list.map((p) => p.id)).toEqual(["c", "b", "a"]);
  });

  it("getAllProjects skips directories without .meta/project.json (handles partial state)", async () => {
    const m = await loadModule();
    await m.createProject(sampleProject("real"));
    // Plant an orphan dir without metadata.
    await fs.mkdir(path.join(projectsDir(), "orphan"), { recursive: true });

    const list = await m.getAllProjects();
    expect(list.map((p) => p.id)).toEqual(["real"]);
  });

  it("getAllProjects skips schema-invalid metadata without crashing the whole list", async () => {
    const m = await loadModule();
    await m.createProject(sampleProject("good"));

    const dir = path.join(projectsDir(), "bad", ".meta");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "project.json"),
      JSON.stringify({ id: "bad" }), // schema-invalid
      "utf-8"
    );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const list = await m.getAllProjects();
    expect(list.map((p) => p.id)).toEqual(["good"]);
    warn.mockRestore();
  });
});

describe("updateProject", () => {
  it("returns null when the project does not exist", async () => {
    const m = await loadModule();
    expect(await m.updateProject("nope", { name: "x" })).toBeNull();
  });

  it("merges updates and bumps updatedAt", async () => {
    const m = await loadModule();
    const created = await m.createProject(sampleProject("p-1"));
    await new Promise((r) => setTimeout(r, 5));

    const updated = await m.updateProject("p-1", {
      name: "Renamed",
      description: "New desc",
    });
    expect(updated?.name).toBe("Renamed");
    expect(updated?.description).toBe("New desc");
    // createdAt unchanged.
    expect(updated?.createdAt).toBe(created.createdAt);
    // updatedAt moved forward.
    expect(new Date(updated!.updatedAt).getTime()).toBeGreaterThan(
      new Date(created.updatedAt).getTime()
    );
  });

  it("ignores attempts to change the id (id is immutable across rename)", async () => {
    const m = await loadModule();
    await m.createProject(sampleProject("p-1"));
    const updated = await m.updateProject("p-1", {
      id: "renamed-evil",
      name: "Has new name",
    } as any);
    expect(updated?.id).toBe("p-1");
  });

  it("emits project_updated event", async () => {
    const m = await loadModule();
    await m.createProject(sampleProject("p-1"));
    mockedPublish.mockClear();
    await m.updateProject("p-1", { name: "x" });
    expect(mockedPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: "projects",
        projectId: "p-1",
        reason: "project_updated",
      })
    );
  });
});

describe("deleteProject — cascading cleanup", () => {
  it("removes the project directory + chats + memory dir + clears memory cache", async () => {
    const m = await loadModule();
    await m.createProject(sampleProject("p-del"));
    // Plant a memory dir under data/memory/p-del to verify cascade.
    await fs.mkdir(path.join(tmpRoot, "data", "memory", "p-del"), { recursive: true });

    const result = await m.deleteProject("p-del");
    expect(result).toBe(true);
    // Project dir gone.
    await expect(
      fs.access(path.join(projectsDir(), "p-del"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    // Memory dir gone.
    await expect(
      fs.access(path.join(tmpRoot, "data", "memory", "p-del"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    // Chats deletion was triggered.
    expect(mockedDeleteChats).toHaveBeenCalledWith("p-del");
    // Memory cache was cleared.
    expect(mockedClearMemory).toHaveBeenCalledWith("p-del");
  });

  it("emits project_deleted event", async () => {
    const m = await loadModule();
    await m.createProject(sampleProject("p-del"));
    mockedPublish.mockClear();
    await m.deleteProject("p-del");
    expect(mockedPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: "projects",
        projectId: "p-del",
        reason: "project_deleted",
      })
    );
  });

  it("returns false when chat deletion (the first step) throws — non-fatal but reported", async () => {
    const m = await loadModule();
    await m.createProject(sampleProject("p-del"));
    mockedDeleteChats.mockRejectedValue(new Error("chat-store down"));

    const result = await m.deleteProject("p-del");
    expect(result).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// TIER 3 — getProjectFiles (file-tree readout)
// ────────────────────────────────────────────────────────────

describe("getProjectFiles", () => {
  it("returns [] for a non-existent project (no throw — UI shows 'empty')", async () => {
    const m = await loadModule();
    expect(await m.getProjectFiles("nope")).toEqual([]);
  });

  it("lists files + directories with name/type/size", async () => {
    const m = await loadModule();
    await m.createProject(sampleProject("p-1"));
    const projectDir = path.join(projectsDir(), "p-1");

    await fs.writeFile(path.join(projectDir, "README.md"), "hello", "utf-8");
    await fs.mkdir(path.join(projectDir, "src"));

    const files = await m.getProjectFiles("p-1");
    // .meta is hidden by the loader (HIDDEN_NAMES filter).
    const names = files.map((f) => f.name);
    expect(names).toContain("README.md");
    expect(names).toContain("src");
    expect(names).not.toContain(".meta");

    const readme = files.find((f) => f.name === "README.md")!;
    expect(readme.type).toBe("file");
    expect(readme.size).toBe(5); // "hello"
  });

  it("hides .meta, .venv, venv (internal Orchestra metadata + python venvs)", async () => {
    const m = await loadModule();
    await m.createProject(sampleProject("p-1"));
    const projectDir = path.join(projectsDir(), "p-1");

    await fs.mkdir(path.join(projectDir, ".venv"));
    await fs.mkdir(path.join(projectDir, "venv"));
    await fs.writeFile(path.join(projectDir, "real.txt"), "x", "utf-8");

    const files = await m.getProjectFiles("p-1");
    const names = files.map((f) => f.name);
    expect(names).not.toContain(".venv");
    expect(names).not.toContain("venv");
    expect(names).not.toContain(".meta");
    expect(names).toContain("real.txt");
  });

  it("sorts directories before files; alphabetical within each group", async () => {
    const m = await loadModule();
    await m.createProject(sampleProject("p-1"));
    const projectDir = path.join(projectsDir(), "p-1");

    await fs.writeFile(path.join(projectDir, "z-file.txt"), "x", "utf-8");
    await fs.writeFile(path.join(projectDir, "a-file.txt"), "x", "utf-8");
    await fs.mkdir(path.join(projectDir, "z-dir"));
    await fs.mkdir(path.join(projectDir, "a-dir"));

    const files = await m.getProjectFiles("p-1");
    const names = files.map((f) => f.name);
    // Two dirs first (a-dir, z-dir), then two files (a-file, z-file).
    expect(names).toEqual(["a-dir", "z-dir", "a-file.txt", "z-file.txt"]);
  });

  it("respects subPath argument (lists nested directory)", async () => {
    const m = await loadModule();
    await m.createProject(sampleProject("p-1"));
    const projectDir = path.join(projectsDir(), "p-1");
    const sub = path.join(projectDir, "src");
    await fs.mkdir(sub);
    await fs.writeFile(path.join(sub, "index.ts"), "x", "utf-8");

    const files = await m.getProjectFiles("p-1", "src");
    expect(files.map((f) => f.name)).toEqual(["index.ts"]);
  });
});

// ────────────────────────────────────────────────────────────
// TIER 4 — resolveWorkDirForProject
// ────────────────────────────────────────────────────────────

describe("resolveWorkDirForProject — async sandbox/linked resolver", () => {
  it("returns PROJECTS_DIR for null/undefined/'none'", async () => {
    const m = await loadModule();
    expect(await m.resolveWorkDirForProject(null)).toBe(projectsDir());
    expect(await m.resolveWorkDirForProject(undefined)).toBe(projectsDir());
    expect(await m.resolveWorkDirForProject("none")).toBe(projectsDir());
  });

  it("returns the SANDBOX path for a project without absoluteRoot", async () => {
    const m = await loadModule();
    await m.createProject(sampleProject("p-sand"));
    expect(await m.resolveWorkDirForProject("p-sand")).toBe(
      path.join(projectsDir(), "p-sand")
    );
  });

  it("returns the absoluteRoot for a linked project (Open Folder feature)", async () => {
    const m = await loadModule();
    await m.createProject(
      sampleProject("p-linked", { absoluteRoot: "/Users/me/repos/foo" })
    );
    expect(await m.resolveWorkDirForProject("p-linked")).toBe(
      "/Users/me/repos/foo"
    );
  });

  it("falls back to sandbox when getProject lookup fails (never throws)", async () => {
    const m = await loadModule();
    // Project does not exist — getProject returns null, fallback path used.
    expect(await m.resolveWorkDirForProject("p-missing")).toBe(
      path.join(projectsDir(), "p-missing")
    );
  });
});
