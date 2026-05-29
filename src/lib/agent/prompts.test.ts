/**
 * Tests for `prompts.ts:buildSystemPrompt` — assembles the agent's
 * system prompt by composing a base template, agent identity, tool
 * blocks, project + skills, file inventories, the active goal tree,
 * and a date/time stamp.
 *
 * Strategy: mock the storage-layer imports so the test doesn't touch
 * the real filesystem outside its tmpdir. The `loadPrompt` helper
 * reads from `src/prompts/*.md` via `fs.readFile`; we plant fixtures
 * there or accept the default-fallback branch.
 *
 * What this pins:
 *   - With no options: the base prompt (or fallback) + agent identity
 *     + date/time block are present; tool / project / chat / goal
 *     sections are absent.
 *   - tools=[...]: each tool name yields a `## Tool: <name>` header
 *     when a matching `tool-<name>.md` exists; missing tool prompt is
 *     silent. `## Tool Loop Safety` + self-healing blocks always
 *     appear when tools is non-empty.
 *   - tools containing `mcp_*`: the `## MCP (Model Context Protocol)
 *     tools` block appears with the count and execution rules.
 *   - projectId resolves to a project: `## Active Project: <name>` is
 *     inserted with description; skills metadata yields
 *     `## Project Skills (available)` with XML-escaped entries.
 *   - projectId / chatId with files: `## Available Files` block lists
 *     the project's first 50 files and / or chat uploads in a markdown
 *     table.
 *   - Active goal tree: `## Active Goal Tree` with rendered tasks.
 *   - agentNumber: 0 → "primary agent"; >0 → "subordinate agent"
 *     identity line.
 *   - All resource-fetch failures are swallowed (no throws). The
 *     prompt always reaches the date/time stamp at the bottom.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock factories are hoisted to the top of the file; module-level
// const declarations are NOT visible inside them at hoist time. vi.hoisted
// is the canonical workaround — runs the body at hoist time so the mocks
// can capture stable references the suite later mutates.
const {
  getProjectMock,
  loadProjectSkillsMetadataMock,
  getProjectFilesMock,
  getWorkDirMock,
  getChatFilesMock,
  getActiveGoalMock,
  readFileMock,
} = vi.hoisted(() => ({
  getProjectMock: vi.fn(),
  loadProjectSkillsMetadataMock: vi.fn(),
  getProjectFilesMock: vi.fn(),
  getWorkDirMock: vi.fn(),
  getChatFilesMock: vi.fn(),
  getActiveGoalMock: vi.fn(),
  readFileMock: vi.fn(),
}));

vi.mock("@/lib/storage/project-store", () => ({
  getProject: (...args: unknown[]) => getProjectMock(...args),
  loadProjectSkillsMetadata: (...args: unknown[]) =>
    loadProjectSkillsMetadataMock(...args),
  getProjectFiles: (...args: unknown[]) => getProjectFilesMock(...args),
  getWorkDir: (...args: unknown[]) => getWorkDirMock(...args),
}));

vi.mock("@/lib/storage/chat-files-store", () => ({
  getChatFiles: (...args: unknown[]) => getChatFilesMock(...args),
}));

vi.mock("@/lib/storage/goal-store", () => ({
  getActiveGoal: (...args: unknown[]) => getActiveGoalMock(...args),
}));

vi.mock("fs/promises", async () => {
  const actual = await vi.importActual<typeof import("fs/promises")>(
    "fs/promises"
  );
  return {
    ...actual,
    default: { ...actual, readFile: readFileMock },
    readFile: readFileMock,
  };
});

import { buildSystemPrompt } from "./prompts";

beforeEach(() => {
  getProjectMock.mockReset();
  loadProjectSkillsMetadataMock.mockReset();
  getProjectFilesMock.mockReset();
  getWorkDirMock.mockReset().mockReturnValue("/tmp/proj");
  getChatFilesMock.mockReset();
  getActiveGoalMock.mockReset();
  readFileMock.mockReset();

  // Default goal-store behavior: no active goal anywhere.
  getActiveGoalMock.mockResolvedValue(null);
  // Default project-store behavior: no skills, no files.
  loadProjectSkillsMetadataMock.mockResolvedValue([]);
  getProjectFilesMock.mockResolvedValue([]);
  // Default chat-files: empty.
  getChatFilesMock.mockResolvedValue([]);
  // Default loadPrompt: ENOENT (loadPrompt swallows errors and returns "").
  readFileMock.mockRejectedValue(
    Object.assign(new Error("not found"), { code: "ENOENT" })
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildSystemPrompt — defaults / minimal inputs", () => {
  it("uses the fallback when system.md isn't on disk", async () => {
    const prompt = await buildSystemPrompt({});
    // Fallback signature lines from getDefaultSystemPrompt():
    expect(prompt).toMatch(/Orchestra Agent/);
    expect(prompt).toMatch(/Be helpful and direct/);
  });

  it("uses the on-disk system.md when present", async () => {
    readFileMock.mockImplementation(async (filePath: unknown) => {
      const p = String(filePath);
      if (p.endsWith("system.md")) return "# Custom System\nYou are special.";
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    });
    const prompt = await buildSystemPrompt({});
    expect(prompt).toMatch(/Custom System/);
    expect(prompt).toMatch(/You are special/);
    // Fallback block should NOT appear in this case.
    expect(prompt).not.toMatch(/Orchestra Agent\n\nYou are a helpful AI/);
  });

  it("always appends the Current Information date/time block", async () => {
    const prompt = await buildSystemPrompt({});
    expect(prompt).toMatch(/## Current Information/);
    expect(prompt).toMatch(/Date\/Time: \d{4}-\d{2}-\d{2}T\d{2}:00:00Z/);
    expect(prompt).toMatch(/Timezone:/);
  });

  it("emits the 'primary agent' identity for agentNumber=0 (or omitted)", async () => {
    const prompt = await buildSystemPrompt({});
    expect(prompt).toMatch(/Agent Identity/);
    expect(prompt).toMatch(/primary agent communicating directly with the user/);
  });

  it("emits the 'subordinate agent' identity with level when agentNumber > 0", async () => {
    const prompt = await buildSystemPrompt({ agentNumber: 2 });
    expect(prompt).toMatch(/subordinate agent \(level 2\)/);
    expect(prompt).toMatch(/Agent 1/); // parent agent reference
  });

  it("omits tool / project / chat / goal sections when nothing is configured", async () => {
    const prompt = await buildSystemPrompt({});
    expect(prompt).not.toMatch(/## Tool:/);
    expect(prompt).not.toMatch(/## Active Project/);
    expect(prompt).not.toMatch(/## Available Files/);
    expect(prompt).not.toMatch(/## Active Goal Tree/);
    expect(prompt).not.toMatch(/## MCP/);
  });
});

describe("buildSystemPrompt — tools", () => {
  it("emits a '## Tool: <name>' block for each tool whose markdown is on disk", async () => {
    readFileMock.mockImplementation(async (filePath: unknown) => {
      const p = String(filePath);
      if (p.endsWith("tool-search_web.md")) return "Search the web.";
      if (p.endsWith("tool-code_execution.md")) return "Run code.";
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    });
    const prompt = await buildSystemPrompt({
      tools: ["search_web", "code_execution"],
    });
    expect(prompt).toMatch(/## Tool: search_web\nSearch the web/);
    expect(prompt).toMatch(/## Tool: code_execution\nRun code/);
  });

  it("silently skips tools that have no matching prompt file", async () => {
    const prompt = await buildSystemPrompt({
      tools: ["nonexistent_tool"],
    });
    expect(prompt).not.toMatch(/## Tool: nonexistent_tool/);
    // But the global Tool Loop Safety block STILL appears because tools[] is non-empty.
    expect(prompt).toMatch(/## Tool Loop Safety/);
  });

  it("appends Tool Loop Safety + Self-Healing Loop when tools is non-empty", async () => {
    const prompt = await buildSystemPrompt({ tools: ["whatever"] });
    expect(prompt).toMatch(/## Tool Loop Safety/);
    expect(prompt).toMatch(/## Self-Healing Loop/);
    expect(prompt).toMatch(/up to 3 times/);
  });

  it("does NOT emit Tool Loop Safety / Self-Healing when tools is empty", async () => {
    const prompt = await buildSystemPrompt({ tools: [] });
    expect(prompt).not.toMatch(/## Tool Loop Safety/);
    expect(prompt).not.toMatch(/## Self-Healing Loop/);
  });

  it("emits the MCP block with the count when any tool starts with 'mcp_'", async () => {
    const prompt = await buildSystemPrompt({
      tools: ["search_web", "mcp_github_search", "mcp_n8n_run"],
    });
    expect(prompt).toMatch(/## MCP \(Model Context Protocol\) tools/);
    expect(prompt).toMatch(/2 tool\(s\) from connected MCP servers/);
    expect(prompt).toMatch(/never guess ids/);
  });

  it("does NOT emit the MCP block when no tool name starts with 'mcp_'", async () => {
    const prompt = await buildSystemPrompt({
      tools: ["search_web", "code_execution"],
    });
    expect(prompt).not.toMatch(/## MCP/);
  });
});

describe("buildSystemPrompt — project + skills", () => {
  it("emits Active Project block when projectId resolves", async () => {
    getProjectMock.mockResolvedValue({
      id: "proj-1",
      name: "My Project",
      description: "Builds great things",
      instructions: "Always test first.",
    });
    const prompt = await buildSystemPrompt({ projectId: "proj-1" });
    expect(prompt).toMatch(/## Active Project: My Project/);
    expect(prompt).toMatch(/Description: Builds great things/);
    expect(prompt).toMatch(/### Project Instructions\nAlways test first/);
  });

  it("project without instructions: skips the Project Instructions sub-header", async () => {
    getProjectMock.mockResolvedValue({
      id: "p",
      name: "P",
      description: "d",
    });
    const prompt = await buildSystemPrompt({ projectId: "p" });
    expect(prompt).toMatch(/Active Project: P/);
    expect(prompt).not.toMatch(/Project Instructions/);
  });

  it("emits Project Skills block when skillsMetadata is non-empty (XML-escaped)", async () => {
    getProjectMock.mockResolvedValue({
      id: "p",
      name: "P",
      description: "d",
    });
    loadProjectSkillsMetadataMock.mockResolvedValue([
      {
        name: "Brand & Voice",
        description: "Apply <brand> guidelines",
      },
    ]);
    const prompt = await buildSystemPrompt({ projectId: "p" });
    expect(prompt).toMatch(/## Project Skills \(available\)/);
    // XML escaping: & → &amp; and < → &lt;
    expect(prompt).toMatch(/Brand &amp; Voice/);
    expect(prompt).toMatch(/Apply &lt;brand&gt; guidelines/);
  });

  it("getProject returns null → no Active Project block, no throw", async () => {
    getProjectMock.mockResolvedValue(null);
    const prompt = await buildSystemPrompt({ projectId: "missing" });
    expect(prompt).not.toMatch(/## Active Project/);
    // Date/time stamp still appears — prompt assembly didn't bail.
    expect(prompt).toMatch(/## Current Information/);
  });
});

describe("buildSystemPrompt — file inventories", () => {
  it("emits Available Files / Project Directory Files table for projects with files", async () => {
    getProjectMock.mockResolvedValue({ id: "p", name: "P", description: "d" });
    getProjectFilesMock.mockResolvedValue([
      { name: "README.md", type: "file", size: 1024 },
      { name: "src", type: "dir" },
    ]);
    const prompt = await buildSystemPrompt({ projectId: "p" });
    expect(prompt).toMatch(/## Available Files/);
    expect(prompt).toMatch(/### Project Directory Files/);
    expect(prompt).toMatch(/\| README\.md \|/);
    expect(prompt).toMatch(/1\.0 KB/);
  });

  it("emits Chat Uploaded Files table when chatId has uploads", async () => {
    getChatFilesMock.mockResolvedValue([
      { name: "diagram.png", path: "data/chat-files/c-1/diagram.png", size: 2048 },
    ]);
    const prompt = await buildSystemPrompt({ chatId: "c-1" });
    expect(prompt).toMatch(/### Chat Uploaded Files/);
    expect(prompt).toMatch(/diagram\.png/);
    expect(prompt).toMatch(/2\.0 KB/);
  });

  it("caps the project files list to 50 with an '...and N more files' tail", async () => {
    getProjectMock.mockResolvedValue({ id: "p", name: "P", description: "d" });
    const many = Array.from({ length: 75 }, (_, i) => ({
      name: `file${i}.txt`,
      type: "file" as const,
      size: 100,
    }));
    getProjectFilesMock.mockResolvedValue(many);
    const prompt = await buildSystemPrompt({ projectId: "p" });
    expect(prompt).toMatch(/\.\.\.and 25 more files/);
    // Each row references the file twice (name + path columns), so 50
    // rows produce 100 occurrences. Check the cap by membership: the
    // 49th file should appear, the 50th should not.
    expect(prompt).toContain("file49.txt");
    expect(prompt).not.toContain("file50.txt");
  });

  it("getProjectFiles throwing is silently swallowed (prompt still completes)", async () => {
    getProjectMock.mockResolvedValue({ id: "p", name: "P", description: "d" });
    getProjectFilesMock.mockRejectedValue(new Error("disk read failed"));
    const prompt = await buildSystemPrompt({ projectId: "p" });
    // No Files section appears, but Active Project + date still do.
    expect(prompt).not.toMatch(/## Available Files/);
    expect(prompt).toMatch(/## Active Project/);
    expect(prompt).toMatch(/## Current Information/);
  });
});

describe("buildSystemPrompt — active goal tree", () => {
  it("emits Active Goal Tree block with rendered task list when a goal is active", async () => {
    getActiveGoalMock.mockResolvedValue({
      id: "g",
      title: "Build the thing",
      description: "Ship the v3 of the thing",
      status: "active",
      tasks: [
        {
          id: 1,
          description: "Plan it",
          status: "completed",
          result: "Plan ready",
        },
        { id: 2, description: "Build it", status: "in_progress" },
      ],
    });
    const prompt = await buildSystemPrompt({});
    expect(prompt).toMatch(/## Active Goal Tree/);
    expect(prompt).toMatch(/Title: Build the thing/);
    expect(prompt).toMatch(/\[COMPLETED\] Task 1: Plan it \(Result: Plan ready\)/);
    expect(prompt).toMatch(/\[IN_PROGRESS\] Task 2: Build it/);
    expect(prompt).toMatch(/Auto-Pilot loop/);
  });

  it("getActiveGoal throwing or returning null → no Goal Tree block, no throw", async () => {
    getActiveGoalMock.mockRejectedValueOnce(new Error("goal-store crash"));
    const a = await buildSystemPrompt({});
    expect(a).not.toMatch(/## Active Goal Tree/);

    getActiveGoalMock.mockResolvedValueOnce(null);
    const b = await buildSystemPrompt({});
    expect(b).not.toMatch(/## Active Goal Tree/);
  });
});
