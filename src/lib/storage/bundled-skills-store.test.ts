/**
 * Tests for `bundled-skills-store` — discovery + install of skills
 * shipped with the codebase under `bundled-skills/`.
 *
 * Pinned invariants:
 *   - `listBundledSkills` returns [] when the dir doesn't exist (fresh
 *     install / non-bundle build).
 *   - Each skill must have a frontmatter `description` AND a `name` that
 *     matches the directory name (case-insensitive). Mismatch or missing
 *     description → silently skipped (defends against accidentally listing
 *     scaffolding directories).
 *   - Skills with invalid names (caught by `validateSkillName`) are
 *     skipped, so a stray subfolder named "../evil" can never become
 *     "installable."
 *   - `installBundledSkill` returns 404 on unknown project, 404 on
 *     unknown skill, 409 if already installed, 500 if SKILL.md missing.
 *   - Successful install copies the source dir into the project's skills
 *     dir without overwriting (errorOnExist: true) — defends against an
 *     accidental clobber.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

vi.mock("@/lib/storage/project-store", () => ({
  getProject: vi.fn(),
  getProjectSkillsDir: vi.fn(),
  validateSkillName: vi.fn(),
}));

import {
  getProject,
  getProjectSkillsDir,
  validateSkillName,
} from "@/lib/storage/project-store";

// `BUNDLED_SKILLS_DIR` is computed at module-load time via `process.cwd()`.
// We must dynamic-import the module AFTER the cwd spy is installed so the
// constant points at our tmpdir, not the repo's real `bundled-skills/`.
async function loadModule() {
  return await import("./bundled-skills-store");
}

const mockedProject = vi.mocked(getProject);
const mockedSkillsDir = vi.mocked(getProjectSkillsDir);
const mockedValidate = vi.mocked(validateSkillName);

let tmpRoot: string;
let cwdSpy: any;

async function plantSkill(
  name: string,
  options: {
    descriptionInFrontmatter?: string | null;
    frontmatterName?: string | null;
    license?: string;
    skip?: boolean;
  } = {}
): Promise<string> {
  const dir = path.join(tmpRoot, "bundled-skills", name);
  await fs.mkdir(dir, { recursive: true });
  if (options.skip) return dir;

  const fmEntries: string[] = [];
  if (options.frontmatterName !== null) {
    fmEntries.push(`name: ${options.frontmatterName ?? name}`);
  }
  if (options.descriptionInFrontmatter !== null) {
    fmEntries.push(
      `description: ${options.descriptionInFrontmatter ?? `Description of ${name}`}`
    );
  }
  if (options.license) fmEntries.push(`license: ${options.license}`);
  const content = `---\n${fmEntries.join("\n")}\n---\n\nbody`;
  await fs.writeFile(path.join(dir, "SKILL.md"), content, "utf-8");
  return dir;
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-bundled-"));
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmpRoot);
  vi.resetModules();

  // Default: every name passes validation, every project exists.
  mockedValidate.mockReturnValue(null);
  mockedProject.mockResolvedValue({ id: "p-1", name: "Test" } as any);
  mockedSkillsDir.mockReturnValue(path.join(tmpRoot, "data/projects/p-1/.skills"));
});

afterEach(async () => {
  cwdSpy?.mockRestore();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("listBundledSkills — discovery", () => {
  it("returns [] when bundled-skills/ does not exist", async () => {
    expect(await (await loadModule()).listBundledSkills()).toEqual([]);
  });

  it("returns one entry per valid skill directory, sorted by name", async () => {
    await plantSkill("zebra");
    await plantSkill("alpha");
    await plantSkill("middle");

    const out = await (await loadModule()).listBundledSkills();
    expect(out.map((s) => s.name)).toEqual(["alpha", "middle", "zebra"]);
    expect(out[0].description).toBe("Description of alpha");
  });

  it("skips a directory whose SKILL.md has no `description`", async () => {
    await plantSkill("good");
    await plantSkill("bad", { descriptionInFrontmatter: null });

    const out = await (await loadModule()).listBundledSkills();
    expect(out.map((s) => s.name)).toEqual(["good"]);
  });

  it("skips a directory whose `name` doesn't match the directory name", async () => {
    await plantSkill("realname", { frontmatterName: "claimed-something-else" });
    expect(await (await loadModule()).listBundledSkills()).toEqual([]);
  });

  it("skips directories whose name fails `validateSkillName` (path-traversal class)", async () => {
    mockedValidate.mockImplementation((name: string) =>
      name === "evil-name" ? "name not allowed" : null
    );
    await plantSkill("good");
    await plantSkill("evil-name");

    const out = await (await loadModule()).listBundledSkills();
    expect(out.map((s) => s.name)).toEqual(["good"]);
  });

  it("skips directories that don't contain SKILL.md at all", async () => {
    await plantSkill("good");
    await plantSkill("empty-dir", { skip: true });

    const out = await (await loadModule()).listBundledSkills();
    expect(out.map((s) => s.name)).toEqual(["good"]);
  });

  it("captures optional license + compatibility fields when present", async () => {
    await plantSkill("with-license", { license: "MIT" });
    const [skill] = await (await loadModule()).listBundledSkills();
    expect(skill.license).toBe("MIT");
  });

  it("truncates a very long description to 1024 chars (defensive)", async () => {
    const longDesc = "x".repeat(2000);
    await plantSkill("verbose", { descriptionInFrontmatter: longDesc });
    const [skill] = await (await loadModule()).listBundledSkills();
    expect(skill.description.length).toBe(1024);
  });
});

describe("installBundledSkill — error paths", () => {
  it("returns 404 when the project does not exist", async () => {
    mockedProject.mockResolvedValue(null);
    await plantSkill("any-skill");

    const result = await (await loadModule()).installBundledSkill("p-missing", "any-skill");
    expect(result).toEqual({ success: false, error: "Project not found", code: 404 });
  });

  it("returns 404 when the bundled skill directory is missing", async () => {
    const result = await (await loadModule()).installBundledSkill("p-1", "no-such-skill");
    expect(result).toEqual({
      success: false,
      error: "Bundled skill not found",
      code: 404,
    });
  });

  it("returns 500 when bundled skill has no SKILL.md", async () => {
    await plantSkill("no-skill-md", { skip: true });
    const result = await (await loadModule()).installBundledSkill("p-1", "no-skill-md");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe(500);
    }
  });

  it("returns 409 when the skill is already installed in the project", async () => {
    await plantSkill("dup-skill");
    // Pre-create the target dir to simulate "already installed."
    const targetBase = path.join(tmpRoot, "data/projects/p-1/.skills");
    await fs.mkdir(path.join(targetBase, "dup-skill"), { recursive: true });

    const result = await (await loadModule()).installBundledSkill("p-1", "dup-skill");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe(409);
      expect(result.error).toMatch(/already installed/i);
    }
  });

  it("returns 400 when the skill name is invalid (validateSkillName rejects it)", async () => {
    mockedValidate.mockReturnValue("invalid name");
    const result = await (await loadModule()).installBundledSkill("p-1", "Bad/Name");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe(400);
    }
  });
});

describe("installBundledSkill — happy path", () => {
  it("copies the source into the project's skills directory", async () => {
    await plantSkill("good-skill");
    const result = await (await loadModule()).installBundledSkill("p-1", "good-skill");

    expect(result.success).toBe(true);
    if (result.success) {
      const skillFile = await fs.readFile(
        path.join(result.targetDir, "SKILL.md"),
        "utf-8"
      );
      expect(skillFile).toMatch(/Description of good-skill/);
    }
  });

  it("normalizes the requested name to lowercase before installing", async () => {
    await plantSkill("nameskill");
    const result = await (await loadModule()).installBundledSkill("p-1", "  NameSkill  ");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.targetDir.endsWith("nameskill")).toBe(true);
    }
  });
});
