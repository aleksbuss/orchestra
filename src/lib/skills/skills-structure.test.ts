/**
 * Structural validation of every `bundled-skills/<name>/SKILL.md`.
 *
 * What this catches (PM #24):
 *   - A skill directory missing its `SKILL.md` (the file the agent reads
 *     into system prompt context — without it the skill is invisible).
 *   - Frontmatter that doesn't parse (missing opening/closing `---`, missing
 *     required `name:` / `description:` keys).
 *   - `name` field that drifts from the directory name (silently breaks
 *     skill activation lookups elsewhere in the codebase).
 *   - Empty markdown body (frontmatter only, no operator guidance).
 *
 * What this deliberately does NOT do:
 *   - Execute the underlying CLI binary. Skills are thin wrappers around
 *     external tools like `gh`, `playwright-cli`, `whisper`, etc. — exercising
 *     them in CI would require installing dozens of system dependencies.
 *     The skill body is operator-facing markdown, not executable code.
 *   - Strict YAML parsing. Some Orchestra skills mix JSON-style objects
 *     into YAML metadata blocks (e.g. `metadata: { "orchestra": {...} }`).
 *     A line-based parser is more lenient and matches what the agent
 *     loader does at runtime.
 *
 * Add the bundled-skills/ checklist line to this test when you ship a new
 * skill so the registry stays trustworthy.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const SKILLS_ROOT = path.join(process.cwd(), "bundled-skills");

function listSkillDirs(): string[] {
  return fs
    .readdirSync(SKILLS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

interface ParsedSkill {
  frontmatter: Record<string, string>;
  body: string;
  raw: string;
}

/**
 * Parse a SKILL.md into frontmatter + body. Frontmatter values are kept as
 * raw strings (we don't strictly YAML-parse because metadata blocks mix
 * formats); we only require recognition of `key:` lines until the closing
 * `---`. Multi-line values (e.g. JSON-in-metadata) are collapsed onto the
 * key.
 */
function parseSkillMd(text: string): ParsedSkill | null {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;

  // Find the closing `---`.
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) return null;

  const fmLines = lines.slice(1, closeIdx);
  const frontmatter: Record<string, string> = {};
  let currentKey: string | null = null;
  for (const line of fmLines) {
    // `key: value` at column 0 starts a new key; everything else is a
    // continuation of the current key's value. This is intentionally loose:
    // matches both `name: foo` and `metadata: { …`.
    const m = line.match(/^([a-zA-Z_-][\w-]*):\s*(.*)$/);
    if (m && !line.startsWith(" ")) {
      currentKey = m[1];
      frontmatter[currentKey] = m[2];
    } else if (currentKey) {
      frontmatter[currentKey] += "\n" + line;
    }
  }

  const body = lines.slice(closeIdx + 1).join("\n").trim();
  return { frontmatter, body, raw: text };
}

// ── Tests ───────────────────────────────────────────────────────────────────

const skills = listSkillDirs();

describe("bundled-skills — structural validation (PM #24)", () => {
  it("registry directory exists and contains at least one skill", () => {
    expect(fs.existsSync(SKILLS_ROOT)).toBe(true);
    expect(skills.length).toBeGreaterThan(0);
  });

  it.each(skills)("[%s] has SKILL.md", (name) => {
    const skillFile = path.join(SKILLS_ROOT, name, "SKILL.md");
    expect(
      fs.existsSync(skillFile),
      `bundled-skills/${name}/ has no SKILL.md — the skill is invisible to the agent`
    ).toBe(true);
  });

  it.each(skills)("[%s] SKILL.md has well-formed frontmatter", (name) => {
    const raw = fs.readFileSync(
      path.join(SKILLS_ROOT, name, "SKILL.md"),
      "utf-8"
    );
    const parsed = parseSkillMd(raw);
    expect(
      parsed,
      `bundled-skills/${name}/SKILL.md is missing or malformed frontmatter ` +
        `(file must start with --- and have a closing ---)`
    ).not.toBeNull();
  });

  it.each(skills)("[%s] frontmatter has 'name' field", (name) => {
    const raw = fs.readFileSync(
      path.join(SKILLS_ROOT, name, "SKILL.md"),
      "utf-8"
    );
    const parsed = parseSkillMd(raw)!;
    expect(
      parsed.frontmatter.name,
      `bundled-skills/${name}/SKILL.md frontmatter is missing 'name:'`
    ).toBeTruthy();
  });

  it.each(skills)("[%s] frontmatter has 'description' field", (name) => {
    const raw = fs.readFileSync(
      path.join(SKILLS_ROOT, name, "SKILL.md"),
      "utf-8"
    );
    const parsed = parseSkillMd(raw)!;
    expect(
      parsed.frontmatter.description,
      `bundled-skills/${name}/SKILL.md frontmatter is missing 'description:' — ` +
        `without this the agent has no trigger keywords to activate the skill`
    ).toBeTruthy();
  });

  it.each(skills)("[%s] frontmatter.name matches the directory name", (name) => {
    const raw = fs.readFileSync(
      path.join(SKILLS_ROOT, name, "SKILL.md"),
      "utf-8"
    );
    const parsed = parseSkillMd(raw)!;
    // Strip quotes that some skills wrap their values in.
    const declared = parsed.frontmatter.name?.replace(/^["']|["']$/g, "").trim();
    expect(
      declared,
      `bundled-skills/${name}/SKILL.md declares name=${declared} but the directory is ${name}; ` +
        `the loader keys skills by directory name, so a drift here = silent invisibility`
    ).toBe(name);
  });

  it.each(skills)("[%s] description is at least 20 characters of operator guidance", (name) => {
    const raw = fs.readFileSync(
      path.join(SKILLS_ROOT, name, "SKILL.md"),
      "utf-8"
    );
    const parsed = parseSkillMd(raw)!;
    const desc = parsed.frontmatter.description
      ?.replace(/^["']|["']$/g, "")
      .trim();
    expect(
      desc?.length ?? 0,
      `bundled-skills/${name}/SKILL.md description is too short — the agent ` +
        `selects skills by description matching, so terse stubs never activate`
    ).toBeGreaterThan(20);
  });

  it.each(skills)("[%s] has a non-empty markdown body below the frontmatter", (name) => {
    const raw = fs.readFileSync(
      path.join(SKILLS_ROOT, name, "SKILL.md"),
      "utf-8"
    );
    const parsed = parseSkillMd(raw)!;
    expect(
      parsed.body.length,
      `bundled-skills/${name}/SKILL.md has no body — the agent reads this as ` +
        `system-prompt context; an empty body means the skill explains nothing`
    ).toBeGreaterThan(50);
  });
});

describe("bundled-skills — registry summary", () => {
  // Single test that emits a registry snapshot for human inspection on test
  // output. Useful for code reviewers ("did we ship a new skill?") and for
  // future regression triage. Always passes; the assertion is structural.
  it("emits the current skill inventory", () => {
    const inventory = skills.map((name) => {
      try {
        const raw = fs.readFileSync(
          path.join(SKILLS_ROOT, name, "SKILL.md"),
          "utf-8"
        );
        const parsed = parseSkillMd(raw);
        const desc = parsed?.frontmatter.description
          ?.replace(/^["']|["']$/g, "")
          .slice(0, 80)
          .trim();
        return { name, desc };
      } catch {
        return { name, desc: "(unreadable)" };
      }
    });
    expect(inventory.length).toBe(skills.length);
    expect(inventory.every((s) => typeof s.name === "string")).toBe(true);
  });
});
