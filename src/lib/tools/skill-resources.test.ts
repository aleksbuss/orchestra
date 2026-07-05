import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  formatRequiredResourceSkipReason,
  listSkillResourcePaths,
  loadRequiredSkillResources,
  resolveSkillLocalFile,
} from "./skill-resources";

/**
 * Behavior pins for the skill-resource helpers extracted from `tool.ts`
 * (§10 decomposition, PR 1). `resolveSkillLocalFile` is a security
 * boundary: SKILL.md link targets are model-visible text and must never
 * escape the skill directory. The autoload budgets keep a link-heavy
 * skill from flooding the prompt.
 */

let tmpRoot: string;
let skillDir: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "skill-resources-test-"));
  skillDir = path.join(tmpRoot, "my-skill");
  await fs.mkdir(path.join(skillDir, "references"), { recursive: true });
  await fs.mkdir(path.join(skillDir, "scripts"), { recursive: true });
  await fs.writeFile(path.join(skillDir, "references", "guide.md"), "# guide", "utf-8");
  await fs.writeFile(path.join(skillDir, "scripts", "run.py"), "print(1)", "utf-8");
  await fs.writeFile(path.join(skillDir, "notes.md"), "notes body", "utf-8");
  // A sibling OUTSIDE the skill dir that a traversal link must never reach.
  await fs.writeFile(path.join(tmpRoot, "secret.txt"), "secret", "utf-8");
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("resolveSkillLocalFile", () => {
  it("resolves a valid relative file inside the skill dir", async () => {
    expect(await resolveSkillLocalFile(skillDir, "references/guide.md")).toBe(
      path.join(skillDir, "references", "guide.md")
    );
  });

  it("rejects traversal and escape attempts", async () => {
    expect(await resolveSkillLocalFile(skillDir, "../secret.txt")).toBeNull();
    expect(await resolveSkillLocalFile(skillDir, "refs/../../secret.txt")).toBeNull();
    expect(await resolveSkillLocalFile(skillDir, "")).toBeNull();
  });

  it("strips absolute-like prefixes instead of honoring them", async () => {
    // "/references/guide.md" is treated as skill-relative, not filesystem-absolute.
    expect(await resolveSkillLocalFile(skillDir, "/references/guide.md")).toBe(
      path.join(skillDir, "references", "guide.md")
    );
  });

  it("returns null for directories and missing files", async () => {
    expect(await resolveSkillLocalFile(skillDir, "references")).toBeNull();
    expect(await resolveSkillLocalFile(skillDir, "nope.md")).toBeNull();
  });
});

describe("listSkillResourcePaths", () => {
  it("merges SKILL.md local links with references/scripts/assets contents, deduped", async () => {
    const body = "See [guide](references/guide.md) and [guide again](references/guide.md).";
    const paths = await listSkillResourcePaths(skillDir, body);
    expect(paths).toContain("references/guide.md");
    expect(paths).toContain("scripts/run.py");
    // Deduped: the double link contributes one entry.
    expect(paths.filter((p) => p === "references/guide.md")).toHaveLength(1);
    // notes.md is not linked and not in a resource dir → not listed.
    expect(paths).not.toContain("notes.md");
  });

  it("ignores links that escape the skill dir", async () => {
    const paths = await listSkillResourcePaths(skillDir, "[x](../secret.txt)");
    expect(paths).not.toContain("../secret.txt");
    expect(paths.every((p) => !p.includes(".."))).toBe(true);
  });
});

describe("loadRequiredSkillResources", () => {
  it("loads linked files and reports missing ones as skipped", async () => {
    const body = "[guide](references/guide.md) [missing](references/nope.md)";
    const report = await loadRequiredSkillResources(skillDir, body);

    expect(report.detectedLinks).toEqual([
      "references/guide.md",
      "references/nope.md",
    ]);
    expect(report.loaded).toHaveLength(1);
    expect(report.loaded[0]).toMatchObject({
      relativePath: "references/guide.md",
      content: "# guide",
      truncated: false,
    });
    expect(report.skipped).toEqual([
      { relativePath: "references/nope.md", reason: "not_found" },
    ]);
  });

  it("enforces the max-files budget (4) with a file_limit skip", async () => {
    const linkDir = path.join(skillDir, "many");
    await fs.mkdir(linkDir, { recursive: true });
    const links: string[] = [];
    for (let i = 0; i < 5; i++) {
      await fs.writeFile(path.join(linkDir, `f${i}.md`), `file ${i}`, "utf-8");
      links.push(`[f${i}](many/f${i}.md)`);
    }
    const report = await loadRequiredSkillResources(skillDir, links.join(" "));
    expect(report.loaded).toHaveLength(4);
    expect(report.skipped).toEqual([
      { relativePath: "many/f4.md", reason: "file_limit" },
    ]);
  });

  it("truncates an oversized file at the per-file char cap", async () => {
    const big = "x".repeat(20000); // > 18000 per-file cap
    await fs.writeFile(path.join(skillDir, "big.md"), big, "utf-8");
    const report = await loadRequiredSkillResources(skillDir, "[big](big.md)");
    expect(report.loaded[0].truncated).toBe(true);
    expect(report.loaded[0].content).toHaveLength(18000);
  });
});

describe("formatRequiredResourceSkipReason", () => {
  it("maps every reason to a human-readable string", () => {
    expect(formatRequiredResourceSkipReason("not_found")).toBe("not found");
    expect(formatRequiredResourceSkipReason("read_error")).toBe("read error");
    expect(formatRequiredResourceSkipReason("file_limit")).toContain("file limit");
    expect(formatRequiredResourceSkipReason("char_limit")).toContain("char limit");
  });
});
