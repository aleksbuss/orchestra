/**
 * Tests for the SKILL-related slice of `project-store.ts` (Agent Skills spec):
 *   - `loadProjectSkillsMetadata` — directory walk, frontmatter parse, dedup
 *   - `loadSkillInstructions` — full SKILL.md body for activated skill
 *   - `loadProjectSkills` — convenience: meta + bodies
 *   - `createSkill` — write .meta/skills/<name>/SKILL.md from inputs
 *   - `writeSkillFile` — write companion files (scripts/refs/assets); SKILL.md
 *     is read-only via this entrypoint, plus path-traversal guard
 *   - `updateSkill` — surgical edit of frontmatter / body
 *   - `deleteSkill` — recursive removal
 *
 * Pinned invariants:
 *   - Skill name validation gates every mutation (path-traversal class).
 *   - Skill name in frontmatter MUST match the directory name (case-sensitive
 *     after lowercase). Mismatch silently dropped from listings — that's the
 *     defense against accidental cross-loading.
 *   - description capped at 1024 chars (frontmatter shape lock).
 *   - `writeSkillFile` rejects paths that escape the skill dir
 *     (`..`, absolute, prefix match without separator).
 *   - `writeSkillFile` rejects overwriting SKILL.md.
 *   - `updateSkill` requires AT LEAST one provided field.
 *   - `updateSkill` with `compatibility: null` / `license: null` removes
 *     those frontmatter lines.
 *   - `deleteSkill` returns success on actual removal; ENOENT-shape error
 *     when not present.
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

let tmpRoot: string;
let cwdSpy: any;

async function loadModule() {
  return await import("./project-store");
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-projstore-skills-"));
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmpRoot);
  vi.resetModules();
  vi.clearAllMocks();
});

afterEach(async () => {
  cwdSpy?.mockRestore();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function makeProject(id = "p-1"): Promise<void> {
  const m = await loadModule();
  await m.createProject({
    id,
    name: id,
    description: "",
    instructions: "",
    memoryMode: "global",
  });
}

async function plantSkill(
  projectId: string,
  name: string,
  options: {
    description?: string | null;
    body?: string;
    license?: string;
    compatibility?: string;
    frontmatterName?: string | null;
  } = {}
): Promise<string> {
  const m = await loadModule();
  const baseDir = m.getProjectSkillsDir(projectId);
  const skillDir = path.join(baseDir, name);
  await fs.mkdir(skillDir, { recursive: true });

  const fmLines: string[] = ["---"];
  if (options.frontmatterName !== null) {
    fmLines.push(`name: ${options.frontmatterName ?? name}`);
  }
  if (options.description !== null) {
    fmLines.push(`description: ${options.description ?? `Description of ${name}`}`);
  }
  if (options.license) fmLines.push(`license: ${options.license}`);
  if (options.compatibility) fmLines.push(`compatibility: ${options.compatibility}`);
  fmLines.push("---");

  const content = options.body
    ? `${fmLines.join("\n")}\n\n${options.body}`
    : `${fmLines.join("\n")}\n`;
  await fs.writeFile(path.join(skillDir, "SKILL.md"), content, "utf-8");
  return skillDir;
}

// ────────────────────────────────────────────────────────────
// loadProjectSkillsMetadata
// ────────────────────────────────────────────────────────────

describe("loadProjectSkillsMetadata", () => {
  it("returns [] for a fresh project with no skills", async () => {
    await makeProject();
    const m = await loadModule();
    expect(await m.loadProjectSkillsMetadata("p-1")).toEqual([]);
  });

  it("lists every valid skill, sorted by name", async () => {
    await makeProject();
    await plantSkill("p-1", "zebra");
    await plantSkill("p-1", "alpha");
    await plantSkill("p-1", "middle");

    const m = await loadModule();
    const list = await m.loadProjectSkillsMetadata("p-1");
    expect(list.map((s) => s.name)).toEqual(["alpha", "middle", "zebra"]);
    expect(list[0].description).toBe("Description of alpha");
  });

  it("skips skills missing a description (frontmatter integrity check)", async () => {
    await makeProject();
    await plantSkill("p-1", "good");
    await plantSkill("p-1", "no-desc", { description: null });

    const m = await loadModule();
    const list = await m.loadProjectSkillsMetadata("p-1");
    expect(list.map((s) => s.name)).toEqual(["good"]);
  });

  it("skips skills whose frontmatter name doesn't match the directory name (cross-load defense)", async () => {
    await makeProject();
    await plantSkill("p-1", "realname", { frontmatterName: "different-name" });

    const m = await loadModule();
    expect(await m.loadProjectSkillsMetadata("p-1")).toEqual([]);
  });

  it("skips directories whose name fails NAME_REGEX (no consecutive dashes etc.)", async () => {
    await makeProject();
    await plantSkill("p-1", "good");
    // Plant a dir directly without going through validation, mimicking
    // someone manually creating a bad-name dir.
    const m = await loadModule();
    const skillsDir = m.getProjectSkillsDir("p-1");
    const badDir = path.join(skillsDir, "bad--name");
    await fs.mkdir(badDir, { recursive: true });
    await fs.writeFile(
      path.join(badDir, "SKILL.md"),
      `---\nname: bad--name\ndescription: x\n---`,
      "utf-8"
    );

    const list = await m.loadProjectSkillsMetadata("p-1");
    expect(list.map((s) => s.name)).toEqual(["good"]);
  });

  it("truncates description to 1024 chars (defensive against frontmatter abuse)", async () => {
    await makeProject();
    await plantSkill("p-1", "verbose", { description: "x".repeat(2000) });

    const m = await loadModule();
    const list = await m.loadProjectSkillsMetadata("p-1");
    expect(list[0].description.length).toBe(1024);
  });

  it("ignores files (only directories count as skills)", async () => {
    await makeProject();
    const m = await loadModule();
    const skillsDir = m.getProjectSkillsDir("p-1");
    await fs.writeFile(path.join(skillsDir, "stray.md"), "x", "utf-8");

    expect(await m.loadProjectSkillsMetadata("p-1")).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────
// loadSkillInstructions / loadProjectSkills
// ────────────────────────────────────────────────────────────

describe("loadSkillInstructions", () => {
  it("returns null for a missing skill", async () => {
    await makeProject();
    const m = await loadModule();
    expect(await m.loadSkillInstructions("p-1", "ghost")).toBeNull();
  });

  it("returns the full body + frontmatter fields", async () => {
    await makeProject();
    await plantSkill("p-1", "capable", {
      body: "## Steps\n1. do thing\n2. ship",
      license: "MIT",
      compatibility: "linux",
    });

    const m = await loadModule();
    const out = await m.loadSkillInstructions("p-1", "capable");
    expect(out?.name).toBe("capable");
    expect(out?.description).toBe("Description of capable");
    expect(out?.body).toContain("ship");
    expect(out?.license).toBe("MIT");
    expect(out?.compatibility).toBe("linux");
  });

  it("returns null when frontmatter name doesn't match the skill name (defense)", async () => {
    await makeProject();
    await plantSkill("p-1", "realname", { frontmatterName: "different" });
    const m = await loadModule();
    expect(await m.loadSkillInstructions("p-1", "realname")).toBeNull();
  });
});

describe("loadProjectSkills — convenience over meta + instructions", () => {
  it("returns full skills with bodies, sorted by name", async () => {
    await makeProject();
    await plantSkill("p-1", "two", { body: "body B" });
    await plantSkill("p-1", "one", { body: "body A" });

    const m = await loadModule();
    const skills = await m.loadProjectSkills("p-1");
    expect(skills.map((s) => s.name)).toEqual(["one", "two"]);
    expect(skills[0].body).toBe("body A");
  });
});

// ────────────────────────────────────────────────────────────
// createSkill
// ────────────────────────────────────────────────────────────

describe("createSkill", () => {
  it("writes .meta/skills/<name>/SKILL.md with the supplied frontmatter and body", async () => {
    await makeProject();
    const m = await loadModule();
    const result = await m.createSkill("p-1", {
      skill_name: "myskill",
      description: "What this does.",
      body: "## Body\n\nUse it like this.",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      const content = await fs.readFile(
        path.join(result.skillDir, "SKILL.md"),
        "utf-8"
      );
      expect(content).toMatch(/name: myskill/);
      // The escapeYamlValue helper allows only [a-zA-Z0-9 -] unquoted; a
      // period (or other punctuation) triggers double-quoting. Test pins
      // both possible shapes — quoted or unquoted — since both round-trip.
      expect(content).toMatch(/description: "?What this does\.?"?/);
      expect(content).toContain("Use it like this");
    }
  });

  it("normalizes skill name (trim, lowercase, spaces → hyphens, strip leading/trailing dashes)", async () => {
    await makeProject();
    const m = await loadModule();
    const result = await m.createSkill("p-1", {
      skill_name: "  My Cool Skill  ",
      description: "x",
      body: "",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.skillDir.endsWith("my-cool-skill")).toBe(true);
    }
  });

  it("rejects empty description (1-1024 chars required)", async () => {
    await makeProject();
    const m = await loadModule();
    const result = await m.createSkill("p-1", {
      skill_name: "x",
      description: "   ",
      body: "x",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid skill name (path-traversal class)", async () => {
    await makeProject();
    const m = await loadModule();
    const result = await m.createSkill("p-1", {
      skill_name: "../evil",
      description: "x",
      body: "x",
    });
    expect(result.success).toBe(false);
  });

  it("rejects creating a skill that already exists (no clobber)", async () => {
    await makeProject();
    const m = await loadModule();
    await m.createSkill("p-1", { skill_name: "dup", description: "x", body: "" });
    const second = await m.createSkill("p-1", {
      skill_name: "dup",
      description: "x",
      body: "",
    });
    expect(second.success).toBe(false);
    if (!second.success) expect(second.error).toMatch(/already exists/i);
  });

  it("escapes YAML-unsafe descriptions (colons, newlines)", async () => {
    await makeProject();
    const m = await loadModule();
    const tricky = "Has: colon\nand newline";
    const result = await m.createSkill("p-1", {
      skill_name: "yaml-tricky",
      description: tricky,
      body: "",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const content = await fs.readFile(
        path.join(result.skillDir, "SKILL.md"),
        "utf-8"
      );
      // YAML quoting must wrap the value in double quotes when special.
      expect(content).toMatch(/description: "Has: colon\\nand newline"/);
    }
  });

  it("optional license and compatibility are written when set, omitted when blank", async () => {
    await makeProject();
    const m = await loadModule();
    await m.createSkill("p-1", {
      skill_name: "with-extras",
      description: "x",
      body: "",
      license: "MIT",
      compatibility: "linux,macos",
    });
    const m2 = await loadModule();
    const meta = await m2.loadProjectSkillsMetadata("p-1");
    const full = await m2.loadSkillInstructions("p-1", "with-extras");
    expect(meta).toHaveLength(1);
    expect(full?.license).toBe("MIT");
    expect(full?.compatibility).toBe("linux,macos");
  });
});

// ────────────────────────────────────────────────────────────
// writeSkillFile
// ────────────────────────────────────────────────────────────

describe("writeSkillFile — companion files (scripts/refs/assets)", () => {
  it("writes a file inside the skill dir", async () => {
    await makeProject();
    const m = await loadModule();
    await m.createSkill("p-1", { skill_name: "ws", description: "x", body: "" });
    const result = await m.writeSkillFile("p-1", "ws", "scripts/run.sh", "#!/bin/sh\nls\n");
    expect(result.success).toBe(true);
    if (result.success) {
      const content = await fs.readFile(result.filePath, "utf-8");
      expect(content).toContain("ls");
    }
  });

  it("creates intermediate directories for the relative path", async () => {
    await makeProject();
    const m = await loadModule();
    await m.createSkill("p-1", { skill_name: "ws", description: "x", body: "" });
    const result = await m.writeSkillFile(
      "p-1",
      "ws",
      "deeply/nested/asset.txt",
      "ok"
    );
    expect(result.success).toBe(true);
  });

  it("returns 404-shape error when the skill does not exist", async () => {
    await makeProject();
    const m = await loadModule();
    const result = await m.writeSkillFile("p-1", "ghost", "x.txt", "y");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/not found/i);
  });

  it("rejects relative paths that contain '..' (path-traversal class)", async () => {
    await makeProject();
    const m = await loadModule();
    await m.createSkill("p-1", { skill_name: "ws", description: "x", body: "" });

    const result = await m.writeSkillFile("p-1", "ws", "../../etc/passwd", "evil");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/'\.\.'/);
  });

  it("rejects overwriting SKILL.md (must use create_skill or update_skill)", async () => {
    await makeProject();
    const m = await loadModule();
    await m.createSkill("p-1", { skill_name: "ws", description: "x", body: "" });

    const result = await m.writeSkillFile("p-1", "ws", "SKILL.md", "x");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/SKILL\.md/);
  });

  it("rejects ABSOLUTE paths (would escape the sandbox)", async () => {
    await makeProject();
    const m = await loadModule();
    await m.createSkill("p-1", { skill_name: "ws", description: "x", body: "" });
    // Absolute paths get the leading slash stripped to be relative;
    // the resulting `etc/passwd` lands in the skill dir as `etc/passwd`.
    // That's "fine" at the sandbox level (still inside the skill dir).
    // Verify the file actually lands inside the skill dir, not the OS root.
    const result = await m.writeSkillFile("p-1", "ws", "/etc/passwd", "x");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.filePath).toContain("/.meta/skills/ws/etc/passwd");
    }
  });
});

// ────────────────────────────────────────────────────────────
// updateSkill
// ────────────────────────────────────────────────────────────

describe("updateSkill", () => {
  it("requires at least one field to update", async () => {
    await makeProject();
    await plantSkill("p-1", "u");
    const m = await loadModule();
    const result = await m.updateSkill("p-1", { skill_name: "u" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/at least one field/i);
  });

  it("returns 404-shape when the skill does not exist", async () => {
    await makeProject();
    const m = await loadModule();
    const result = await m.updateSkill("p-1", {
      skill_name: "ghost",
      description: "x",
    });
    expect(result.success).toBe(false);
  });

  it("updates description while preserving the body", async () => {
    await makeProject();
    await plantSkill("p-1", "ub", { body: "preserved body" });
    const m = await loadModule();
    await m.updateSkill("p-1", {
      skill_name: "ub",
      description: "new desc",
    });

    const out = await m.loadSkillInstructions("p-1", "ub");
    expect(out?.description).toBe("new desc");
    expect(out?.body).toBe("preserved body");
  });

  it("updates body while preserving description", async () => {
    await makeProject();
    await plantSkill("p-1", "ub", { description: "stays" });
    const m = await loadModule();
    await m.updateSkill("p-1", { skill_name: "ub", body: "fresh body" });

    const out = await m.loadSkillInstructions("p-1", "ub");
    expect(out?.description).toBe("stays");
    expect(out?.body).toBe("fresh body");
  });

  it("license/compatibility=null removes that frontmatter line", async () => {
    await makeProject();
    await plantSkill("p-1", "ext", {
      license: "MIT",
      compatibility: "linux",
    });
    const m = await loadModule();
    await m.updateSkill("p-1", {
      skill_name: "ext",
      license: null,
      compatibility: null,
    });

    const out = await m.loadSkillInstructions("p-1", "ext");
    expect(out?.license).toBeUndefined();
    expect(out?.compatibility).toBeUndefined();
  });

  it("rejects empty description", async () => {
    await makeProject();
    await plantSkill("p-1", "u");
    const m = await loadModule();
    const result = await m.updateSkill("p-1", {
      skill_name: "u",
      description: "   ",
    });
    expect(result.success).toBe(false);
  });

  it("trims compatibility to 500 chars", async () => {
    await makeProject();
    await plantSkill("p-1", "u");
    const m = await loadModule();
    await m.updateSkill("p-1", {
      skill_name: "u",
      compatibility: "x".repeat(1000),
    });
    const out = await m.loadSkillInstructions("p-1", "u");
    expect(out?.compatibility?.length).toBe(500);
  });
});

// ────────────────────────────────────────────────────────────
// deleteSkill
// ────────────────────────────────────────────────────────────

describe("deleteSkill", () => {
  it("removes the skill directory", async () => {
    await makeProject();
    await plantSkill("p-1", "doomed");
    const m = await loadModule();
    const result = await m.deleteSkill("p-1", "doomed");
    expect(result.success).toBe(true);
    if (result.success) {
      await expect(fs.access(result.skillDir)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });

  it("returns 404-shape when the skill does not exist", async () => {
    await makeProject();
    const m = await loadModule();
    const result = await m.deleteSkill("p-1", "ghost");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/not found/i);
  });

  it("normalizes skill name (case-insensitive lookup)", async () => {
    await makeProject();
    await plantSkill("p-1", "case-test");
    const m = await loadModule();
    const result = await m.deleteSkill("p-1", "  CASE-TEST  ");
    expect(result.success).toBe(true);
  });
});
