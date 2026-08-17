/**
 * Tests for `project-store.ts` — the JSON-on-disk "main table" of
 * Orchestra. This suite covers three tightly-scoped layers:
 *
 *   1. Path helpers (sync, pure-ish — `getProjectMetaRoot`,
 *      `getProjectSkillsDir`, `getProjectMcpDir`, etc.)
 *   2. Project CRUD (`getAllProjects`, `getProject`, `createProject`,
 *      `updateProject`, `deleteProject`)
 *   3. File-tree readout (`getProjectFiles`) and the work-dir resolver
 *      (`getProjectContentRoot`).
 *
 * Skills, MCP server config and GitHub install each moved out with their
 * code — see `project-skills.test.ts`, `project-mcp.test.ts` and
 * `project-skills-github.test.ts`.
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
  // Belt and braces for the shared-module spies above: any spy this file
  // installed is undone even if a test bailed before its own restore.
  vi.restoreAllMocks();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const projectsDir = () => path.join(tmpRoot, "data", "projects");

/**
 * Create a real directory OUTSIDE the data dir and return its realpath —
 * what a linked project's `absoluteRoot` looks like after validation. The
 * realpath matters on macOS, where `os.tmpdir()` is `/var/folders/…` and
 * resolves to `/private/var/folders/…`.
 */
async function realDir(name: string): Promise<string> {
  const dir = path.join(tmpRoot, "linked", name);
  await fs.mkdir(dir, { recursive: true });
  return await fs.realpath(dir);
}

/**
 * Make `fs.mkdir` throw for one path suffix, and hand back the restore.
 *
 * `fs` here is the SHARED `node:fs/promises` binding that every other module —
 * and every other test file in this worker — calls through. A spy leaked by a
 * failing assertion would break things far from this file and look like
 * flakiness somewhere else entirely, so callers MUST restore in a `finally`.
 */
function failMkdirAt(pathSuffix: string): () => void {
  const realMkdir = fs.mkdir.bind(fs);
  const spy = vi.spyOn(fs, "mkdir").mockImplementation(async (target: any, opts: any) => {
    if (String(target).endsWith(pathSuffix)) throw new Error("disk full");
    return realMkdir(target, opts);
  });
  return () => spy.mockRestore();
}

// ────────────────────────────────────────────────────────────
// TIER 1 — path helpers
// ────────────────────────────────────────────────────────────

describe("getProjectMetaRoot — sync, Orchestra-owned root", () => {
  it("returns PROJECTS_DIR for null/undefined projectId (global)", async () => {
    const m = await loadModule();
    expect(m.getProjectMetaRoot(null)).toBe(projectsDir());
    expect(m.getProjectMetaRoot(undefined)).toBe(projectsDir());
  });

  it("returns PROJECTS_DIR for the literal GLOBAL_PROJECT_ID 'none'", async () => {
    const m = await loadModule();
    expect(m.getProjectMetaRoot("none")).toBe(projectsDir());
    expect(m.GLOBAL_PROJECT_ID).toBe("none");
  });

  it("returns the sandbox path for a real project id", async () => {
    const m = await loadModule();
    expect(m.getProjectMetaRoot("proj-1")).toBe(
      path.join(projectsDir(), "proj-1")
    );
  });

  it("NEVER honors absoluteRoot — a linked project's meta stays in the sandbox", async () => {
    const m = await loadModule();
    const linkedRoot = await realDir("meta-stays-put");
    await m.createProject(
      sampleProject("proj-linked", { absoluteRoot: linkedRoot })
    );
    // The whole point of the second name: Orchestra's own state must not be
    // written into the user's repository.
    expect(m.getProjectMetaRoot("proj-linked")).toBe(
      path.join(projectsDir(), "proj-linked")
    );
    expect(await m.getProjectContentRoot("proj-linked")).toBe(linkedRoot);
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

  // PM #104 — `project.json` is written LAST, so a create that throws part-way
  // used to leave a directory `getAllProjects` skips forever: on disk, but not
  // in the app. Six of those accumulated for real.
  it("rolls back a directory IT created when the create fails part-way", async () => {
    const m = await loadModule();
    const projectDir = path.join(projectsDir(), "doomed");

    // Fail after the project dir exists but before project.json is written.
    const restore = failMkdirAt("knowledge");
    try {
      await expect(m.createProject(sampleProject("doomed"))).rejects.toThrow("disk full");
    } finally {
      restore();
    }

    await expect(
      fs.stat(projectDir),
      "the half-created directory must not survive as an invisible orphan"
    ).rejects.toMatchObject({ code: "ENOENT" });

    // And the app agrees it does not exist.
    m.__resetSkippedProjectDirReportForTests();
    expect((await m.getAllProjects()).map((p) => p.id)).not.toContain("doomed");
  });

  it("does NOT delete a PRE-EXISTING directory when the create fails", async () => {
    // The guard that keeps the rollback from turning a failed create into data
    // loss: those files belong to someone else.
    const m = await loadModule();
    const projectDir = path.join(projectsDir(), "occupied");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "precious.txt"), "do not delete me", "utf-8");

    const restore = failMkdirAt("knowledge");
    try {
      await expect(m.createProject(sampleProject("occupied"))).rejects.toThrow("disk full");
    } finally {
      restore();
    }

    expect(
      await fs.readFile(path.join(projectDir, "precious.txt"), "utf-8"),
      "a pre-existing directory's contents must survive a failed create"
    ).toBe("do not delete me");
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
    const linkedRoot = await realDir("preserved");
    const out = await m.createProject(
      sampleProject("p-linked", { absoluteRoot: linkedRoot })
    );
    expect(out.absoluteRoot).toBe(linkedRoot);
    const reloaded = await m.getProject("p-linked");
    expect(reloaded?.absoluteRoot).toBe(linkedRoot);
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

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const list = await m.getAllProjects();
    expect(list.map((p) => p.id)).toEqual(["real"]);
    warn.mockRestore();
  });

  // PM #104 — skipping is correct; skipping SILENTLY is how six orphaned
  // directories accumulated unnoticed, one of them a real project.
  it("getAllProjects NAMES the directories it skipped", async () => {
    const m = await loadModule();
    m.__resetSkippedProjectDirReportForTests();
    await m.createProject(sampleProject("real"));
    await fs.mkdir(path.join(projectsDir(), "ghost-a"), { recursive: true });
    await fs.mkdir(path.join(projectsDir(), "ghost-b"), { recursive: true });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await m.getAllProjects();

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain("ghost-a");
    expect(message).toContain("ghost-b");
    // The operator needs to know the files still exist — "skipped" alone reads
    // like "ignored something empty".
    expect(message).toMatch(/still on disk/i);
    warn.mockRestore();
  });

  it("getAllProjects stays quiet on an unchanged skip set, and speaks up for a NEW one", async () => {
    // Called on most dashboard interactions: warning every time would bury the
    // message in its own noise. Warning on CHANGE keeps a new orphan loud.
    const m = await loadModule();
    m.__resetSkippedProjectDirReportForTests();
    await fs.mkdir(path.join(projectsDir(), "ghost-a"), { recursive: true });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await m.getAllProjects();
    await m.getAllProjects();
    await m.getAllProjects();
    expect(warn, "an unchanged skip set must not re-warn").toHaveBeenCalledTimes(1);

    await fs.mkdir(path.join(projectsDir(), "ghost-b"), { recursive: true });
    await m.getAllProjects();
    expect(warn, "a newly orphaned directory must warn").toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[1][0])).toContain("ghost-b");
    warn.mockRestore();
  });

  it("getAllProjects says nothing when there is nothing to skip", async () => {
    const m = await loadModule();
    m.__resetSkippedProjectDirReportForTests();
    await m.createProject(sampleProject("real"));

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await m.getAllProjects();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
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
// TIER 4 — getProjectContentRoot
// ────────────────────────────────────────────────────────────

describe("getProjectContentRoot — async sandbox/linked resolver", () => {
  it("returns PROJECTS_DIR for null/undefined/'none'", async () => {
    const m = await loadModule();
    expect(await m.getProjectContentRoot(null)).toBe(projectsDir());
    expect(await m.getProjectContentRoot(undefined)).toBe(projectsDir());
    expect(await m.getProjectContentRoot("none")).toBe(projectsDir());
  });

  it("returns the SANDBOX path for a project without absoluteRoot", async () => {
    const m = await loadModule();
    await m.createProject(sampleProject("p-sand"));
    expect(await m.getProjectContentRoot("p-sand")).toBe(
      path.join(projectsDir(), "p-sand")
    );
  });

  it("returns the absoluteRoot for a linked project (Open Folder feature)", async () => {
    const m = await loadModule();
    const linkedRoot = await realDir("repo-linked");
    await m.createProject(
      sampleProject("p-linked", { absoluteRoot: linkedRoot })
    );
    expect(await m.getProjectContentRoot("p-linked")).toBe(linkedRoot);
  });

  it("falls back to sandbox when getProject lookup fails (never throws)", async () => {
    const m = await loadModule();
    // Project does not exist — getProject returns null, fallback path used.
    expect(await m.getProjectContentRoot("p-missing")).toBe(
      path.join(projectsDir(), "p-missing")
    );
  });
});

// ────────────────────────────────────────────────────────────
// TIER 5 — validateAbsoluteRoot (write-side guard)
//
// Before this existed, `PUT /api/projects/<id>` spread the request body into
// `updateProject`, so any string at all became a project's filesystem root.
// ────────────────────────────────────────────────────────────

describe("validateAbsoluteRoot", () => {
  it("accepts an existing directory and returns its REALPATH", async () => {
    const m = await loadModule();
    const dir = path.join(tmpRoot, "linked", "ok");
    await fs.mkdir(dir, { recursive: true });
    expect(await m.validateAbsoluteRoot(dir)).toBe(await fs.realpath(dir));
  });

  it("rejects a relative path — it would resolve against an unstable cwd", async () => {
    const m = await loadModule();
    await expect(m.validateAbsoluteRoot("../elsewhere")).rejects.toBeInstanceOf(
      m.InvalidProjectRootError
    );
  });

  it("rejects an empty / whitespace root", async () => {
    const m = await loadModule();
    await expect(m.validateAbsoluteRoot("   ")).rejects.toBeInstanceOf(
      m.InvalidProjectRootError
    );
  });

  it("rejects a path that does not exist", async () => {
    const m = await loadModule();
    await expect(
      m.validateAbsoluteRoot(path.join(tmpRoot, "nope", "missing"))
    ).rejects.toBeInstanceOf(m.InvalidProjectRootError);
  });

  it("rejects a regular file", async () => {
    const m = await loadModule();
    const file = path.join(tmpRoot, "a-file.txt");
    await fs.writeFile(file, "x", "utf-8");
    await expect(m.validateAbsoluteRoot(file)).rejects.toBeInstanceOf(
      m.InvalidProjectRootError
    );
  });

  it("rejects the data directory itself — that root publishes data/settings", async () => {
    const m = await loadModule();
    const dataDir = path.join(tmpRoot, "data");
    await fs.mkdir(dataDir, { recursive: true });
    await expect(m.validateAbsoluteRoot(dataDir)).rejects.toBeInstanceOf(
      m.InvalidProjectRootError
    );
  });

  it("rejects an ANCESTOR of the data directory (the `/` case)", async () => {
    const m = await loadModule();
    await fs.mkdir(path.join(tmpRoot, "data"), { recursive: true });
    // tmpRoot contains data/ — linking it would expose the API-key vault
    // through the Files API's list + download handlers.
    await expect(m.validateAbsoluteRoot(tmpRoot)).rejects.toBeInstanceOf(
      m.InvalidProjectRootError
    );
  });
});

describe("absoluteRoot is validated on every write path", () => {
  it("createProject stores the realpath of a valid linked root", async () => {
    const m = await loadModule();
    const linkedRoot = await realDir("created");
    const created = await m.createProject(
      sampleProject("p-new", { absoluteRoot: linkedRoot })
    );
    expect(created.absoluteRoot).toBe(linkedRoot);
    expect((await m.getProject("p-new"))?.absoluteRoot).toBe(linkedRoot);
  });

  it("createProject rejects a non-existent linked root", async () => {
    const m = await loadModule();
    await expect(
      m.createProject(
        sampleProject("p-bad", { absoluteRoot: "/definitely/not/here" })
      )
    ).rejects.toBeInstanceOf(m.InvalidProjectRootError);
  });

  it("updateProject rejects a bogus absoluteRoot and leaves project.json untouched", async () => {
    const m = await loadModule();
    await m.createProject(sampleProject("p-1"));
    const before = await m.getProject("p-1");

    await expect(
      m.updateProject("p-1", { absoluteRoot: "/definitely/not/here" })
    ).rejects.toBeInstanceOf(m.InvalidProjectRootError);

    // Not even `updatedAt` moved — validation runs before the file lock.
    expect(await m.getProject("p-1")).toEqual(before);
  });

  it("updateProject links a valid root (stored as realpath)", async () => {
    const m = await loadModule();
    await m.createProject(sampleProject("p-1"));
    const linkedRoot = await realDir("updated");

    const updated = await m.updateProject("p-1", { absoluteRoot: linkedRoot });
    expect(updated?.absoluteRoot).toBe(linkedRoot);
    expect(await m.getProjectContentRoot("p-1")).toBe(linkedRoot);
  });

  it("an explicitly empty absoluteRoot UNLINKS the project back to its sandbox", async () => {
    const m = await loadModule();
    const linkedRoot = await realDir("unlink-me");
    await m.createProject(sampleProject("p-1", { absoluteRoot: linkedRoot }));

    await m.updateProject("p-1", { absoluteRoot: "" });

    expect((await m.getProject("p-1"))?.absoluteRoot).toBeUndefined();
    expect(await m.getProjectContentRoot("p-1")).toBe(
      path.join(projectsDir(), "p-1")
    );
  });

  it("an update that does not mention absoluteRoot leaves the link intact", async () => {
    const m = await loadModule();
    const linkedRoot = await realDir("keep-me");
    await m.createProject(sampleProject("p-1", { absoluteRoot: linkedRoot }));

    await m.updateProject("p-1", { name: "Renamed" });

    expect((await m.getProject("p-1"))?.absoluteRoot).toBe(linkedRoot);
  });
});
