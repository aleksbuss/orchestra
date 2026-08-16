/**
 * Agent Skills storage — the `.meta/skills/<name>/SKILL.md` surface.
 *
 * Extracted from `project-store.ts` (§10 file-size decomposition). Skills were
 * the dominant concern in that file: ~940 LOC originally, of which the GitHub
 * installer already left for `project-skills-github.ts`. This is the rest —
 * the local read/write half.
 *
 * DEPENDENCY DIRECTION, one-way: this module imports the skill DIRECTORY
 * helpers from `project-store` and `project-store` imports NOTHING from here.
 * That is deliberate and load-bearing: `createProject` calls
 * `ensureDir(getProjectSkillsDir(id))` when it scaffolds a project, so the path
 * helpers have to stay on the project-store side or the two modules would
 * import each other. Same reasoning the MCP extraction recorded.
 */
import fs from "fs/promises";
import path from "path";
import type { ProjectSkill, ProjectSkillMetadata } from "@/lib/types";
import { safeWriteFile } from "./fs-utils";
import {
  ensureDir,
  getProjectLegacyInstructionsDir,
  getProjectSkillsDir,
} from "./project-store";

export const SKILL_FILE = "SKILL.md";

/** Agent Skills spec: lowercase, numbers, hyphens; no leading/trailing/consecutive hyphens (e.g. pdf, pdf-parsing) */
const NAME_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;


async function dirExists(dir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dir);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Move legacy .meta/instructions to .meta/skills when possible.
 * Keeps backward compatibility for existing projects.
 */
export async function migrateLegacySkillsDir(projectId: string): Promise<void> {
  const skillsDir = getProjectSkillsDir(projectId);
  const legacyDir = getProjectLegacyInstructionsDir(projectId);
  const [skillsExists, legacyExists] = await Promise.all([
    dirExists(skillsDir),
    dirExists(legacyDir),
  ]);

  if (skillsExists || !legacyExists) return;

  try {
    await fs.rename(legacyDir, skillsDir);
    return;
  } catch {
    // fallback below
  }

  try {
    await fs.mkdir(skillsDir, { recursive: true });
    await fs.cp(legacyDir, skillsDir, { recursive: true });
    await fs.rm(legacyDir, { recursive: true, force: true });
  } catch {
    // Keep both dirs if migration fails; readers still check legacy path.
  }
}

async function getProjectSkillDirs(projectId: string): Promise<string[]> {
  await migrateLegacySkillsDir(projectId);

  const skillsDir = getProjectSkillsDir(projectId);
  const legacyDir = getProjectLegacyInstructionsDir(projectId);
  const dirs: string[] = [];

  if (await dirExists(skillsDir)) dirs.push(skillsDir);
  if (await dirExists(legacyDir)) dirs.push(legacyDir);
  if (dirs.length === 0) dirs.push(skillsDir);

  return dirs;
}

export async function findProjectSkillDir(
  projectId: string,
  skillName: string
): Promise<string | null> {
  const dirs = await getProjectSkillDirs(projectId);
  for (const baseDir of dirs) {
    const skillDir = path.join(baseDir, skillName);
    if (await dirExists(skillDir)) return skillDir;
  }
  return null;
}

/** Validate skill name per Agent Skills spec. Returns error message or null if valid. */
export function validateSkillName(name: string): string | null {
  const n = name.trim();
  if (!n) return "Skill name is required.";
  if (n.length > 64) return "Skill name must be at most 64 characters.";
  if (!NAME_REGEX.test(n)) return "Skill name must use only lowercase letters, numbers, and hyphens; cannot start or end with a hyphen or contain consecutive hyphens (e.g. pdf, pdf-parsing, my-skill).";
  return null;
}

export function parseFrontmatter(raw: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("---")) {
    return { frontmatter: {}, body: trimmed };
  }
  const rest = trimmed.slice(3);
  const endIdx = rest.indexOf("\n---");
  const frontmatterBlock = endIdx >= 0 ? rest.slice(0, endIdx) : "";
  const body = endIdx >= 0 ? rest.slice(endIdx + 4).trim() : rest.trim();
  const frontmatter: Record<string, string> = {};
  for (const line of frontmatterBlock.split(/\r?\n/)) {
    const match = line.match(/^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/);
    if (match) {
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      frontmatter[match[1].toLowerCase()] = value;
    }
  }
  return { frontmatter, body };
}

/**
 * Load only skill metadata (name, description) for system prompt.
 * Keeps context small (~50–100 tokens per skill). Full instructions loaded via load_skill tool.
 * https://agentskills.io/integrate-skills
 */
export async function loadProjectSkillsMetadata(
  projectId: string
): Promise<ProjectSkillMetadata[]> {
  const baseDirs = await getProjectSkillDirs(projectId);
  const list: ProjectSkillMetadata[] = [];
  const seen = new Set<string>();

  for (const baseDir of baseDirs) {
    try {
      const entries = await fs.readdir(baseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const key = entry.name.toLowerCase();
        if (seen.has(key)) continue;

        const skillDir = path.join(baseDir, entry.name);
        const skillFilePath = path.join(skillDir, SKILL_FILE);
        let content: string;
        try {
          content = await fs.readFile(skillFilePath, "utf-8");
        } catch {
          continue;
        }

        const { frontmatter } = parseFrontmatter(content);
        const dirNameLower = entry.name.toLowerCase();
        if (entry.name.length > 64 || !NAME_REGEX.test(dirNameLower) || dirNameLower.includes("--")) continue;
        const name = (frontmatter.name ?? entry.name).trim().toLowerCase();
        const description = (frontmatter.description ?? "").trim().slice(0, 1024);
        if (!name || !description) continue;
        if (name !== dirNameLower) continue;

        seen.add(key);
        list.push({ name: entry.name, description, skillDir });
      }
    } catch {
      // directory missing or not readable
    }
  }
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Create a new skill in the project (Agent Skills spec).
 * Validates name and description; writes .meta/skills/<name>/SKILL.md.
 * Fails if a skill with that name already exists.
 */
export async function createSkill(
  projectId: string,
  params: {
    skill_name: string;
    description: string;
    body: string;
    compatibility?: string;
    license?: string;
  }
): Promise<{ success: true; skillDir: string } | { success: false; error: string }> {
  const name = params.skill_name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "");
  const err = validateSkillName(name);
  if (err) return { success: false, error: err };

  const description = params.description.trim().slice(0, 1024);
  if (!description) return { success: false, error: "Description is required (1–1024 characters)." };

  await migrateLegacySkillsDir(projectId);
  const baseDir = getProjectSkillsDir(projectId);
  await ensureDir(baseDir);
  const existingSkillDir = await findProjectSkillDir(projectId, name);
  if (existingSkillDir) {
    return { success: false, error: `Skill "${name}" already exists. Choose a different name or delete the existing skill first.` };
  }
  const skillDir = path.join(baseDir, name);

  const body = (params.body ?? "").trim();
  const licenseLine = params.license?.trim() ? `license: ${escapeYamlValue(params.license.trim())}\n` : "";
  const compatibilityLine = params.compatibility?.trim() ? `compatibility: ${escapeYamlValue(params.compatibility.trim().slice(0, 500))}\n` : "";
  const frontmatter = `---
name: ${name}
description: ${escapeYamlValue(description)}
${licenseLine}${compatibilityLine}---`;

  const content = body ? `${frontmatter}\n\n${body}` : `${frontmatter}\n`;

  await fs.mkdir(skillDir, { recursive: true });
  await safeWriteFile(path.join(skillDir, SKILL_FILE), content);

  return { success: true, skillDir };
}

function escapeYamlValue(s: string): string {
  if (/^[a-zA-Z0-9][a-zA-Z0-9 -]*$/.test(s) && !s.includes(":") && !s.includes("\n")) return s;
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}


/**
 * Write an optional file under a skill (scripts/, references/, assets/ or other).
 * Skill must already exist (SKILL.md present). Cannot overwrite SKILL.md.
 */
export async function writeSkillFile(
  projectId: string,
  skillName: string,
  relativePath: string,
  content: string
): Promise<{ success: true; filePath: string } | { success: false; error: string }> {
  const skillDir = await findProjectSkillDir(projectId, skillName);
  if (!skillDir) {
    return { success: false, error: `Skill "${skillName}" not found. Create the skill first with create_skill.` };
  }
  const skillFilePath = path.join(skillDir, SKILL_FILE);

  try {
    await fs.access(skillFilePath);
  } catch {
    return { success: false, error: `Skill "${skillName}" not found. Create the skill first with create_skill.` };
  }

  const normalized = path.normalize(relativePath).replace(/^[/\\]+/, "");
  if (normalized.includes("..")) {
    return { success: false, error: "Path must not contain '..'." };
  }
  const targetPath = path.join(skillDir, normalized);
  const skillDirReal = path.resolve(skillDir);
  const targetPathReal = path.resolve(targetPath);
  if (!targetPathReal.startsWith(skillDirReal + path.sep) && targetPathReal !== skillDirReal) {
    return { success: false, error: "Path must be inside the skill directory." };
  }
  if (path.resolve(skillDir, normalized) === path.resolve(skillDir, SKILL_FILE)) {
    return { success: false, error: "Cannot overwrite SKILL.md. Use create_skill or edit manually." };
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await safeWriteFile(targetPath, content);
  return { success: true, filePath: targetPath };
}

/**
 * Update an existing skill's SKILL.md frontmatter/body.
 * Unspecified fields keep previous values. Set compatibility/license to null to remove.
 */
export async function updateSkill(
  projectId: string,
  params: {
    skill_name: string;
    description?: string;
    body?: string;
    compatibility?: string | null;
    license?: string | null;
  }
): Promise<{ success: true; skillFilePath: string } | { success: false; error: string }> {
  const skillName = params.skill_name.trim().toLowerCase();
  if (!skillName) return { success: false, error: "Skill name is required." };

  if (
    params.description === undefined &&
    params.body === undefined &&
    params.compatibility === undefined &&
    params.license === undefined
  ) {
    return {
      success: false,
      error: "Provide at least one field to update: description, body, compatibility, or license.",
    };
  }

  const skillDir = await findProjectSkillDir(projectId, skillName);
  if (!skillDir) {
    return { success: false, error: `Skill "${skillName}" not found.` };
  }

  const skillFilePath = path.join(skillDir, SKILL_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(skillFilePath, "utf-8");
  } catch {
    return { success: false, error: `Skill "${skillName}" not found.` };
  }

  const { frontmatter, body: existingBody } = parseFrontmatter(raw);
  const existingDescription = (frontmatter.description ?? "").trim().slice(0, 1024);
  const existingCompatibility = frontmatter.compatibility?.trim();
  const existingLicense = frontmatter.license?.trim();

  let nextDescription = existingDescription;
  if (params.description !== undefined) {
    nextDescription = params.description.trim().slice(0, 1024);
    if (!nextDescription) {
      return { success: false, error: "Description is required (1–1024 characters)." };
    }
  }
  if (!nextDescription) {
    return { success: false, error: "Description is required (1–1024 characters)." };
  }

  const nextBody = (params.body ?? existingBody).trim();

  const compatibilityInput =
    params.compatibility === undefined ? existingCompatibility : params.compatibility;
  const compatibility =
    typeof compatibilityInput === "string"
      ? compatibilityInput.trim().slice(0, 500)
      : "";

  const licenseInput = params.license === undefined ? existingLicense : params.license;
  const license = typeof licenseInput === "string" ? licenseInput.trim() : "";

  const nameLine = `name: ${skillName}`;
  const descriptionLine = `description: ${escapeYamlValue(nextDescription)}`;
  const licenseLine = license ? `license: ${escapeYamlValue(license)}` : "";
  const compatibilityLine = compatibility
    ? `compatibility: ${escapeYamlValue(compatibility)}`
    : "";

  const frontmatterLines = [
    "---",
    nameLine,
    descriptionLine,
    ...(licenseLine ? [licenseLine] : []),
    ...(compatibilityLine ? [compatibilityLine] : []),
    "---",
  ];
  const nextContent = nextBody
    ? `${frontmatterLines.join("\n")}\n\n${nextBody}`
    : `${frontmatterLines.join("\n")}\n`;

  await safeWriteFile(skillFilePath, nextContent);
  return { success: true, skillFilePath };
}

export async function deleteSkill(
  projectId: string,
  skillName: string
): Promise<{ success: true; skillDir: string } | { success: false; error: string }> {
  const normalizedName = skillName.trim().toLowerCase();
  if (!normalizedName) return { success: false, error: "Skill name is required." };

  const skillDir = await findProjectSkillDir(projectId, normalizedName);
  if (!skillDir) {
    return { success: false, error: `Skill "${normalizedName}" not found.` };
  }

  try {
    await fs.rm(skillDir, { recursive: true, force: false });
    return { success: true, skillDir };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to delete skill.",
    };
  }
}

/**
 * Load full instructions for one skill (used when model activates a skill via load_skill tool).
 */
export async function loadSkillInstructions(
  projectId: string,
  skillName: string
): Promise<ProjectSkill | null> {
  const skillDir = await findProjectSkillDir(projectId, skillName);
  if (!skillDir) return null;
  const skillFilePath = path.join(skillDir, SKILL_FILE);
  try {
    const content = await fs.readFile(skillFilePath, "utf-8");
    const { frontmatter, body } = parseFrontmatter(content);
    const name = (frontmatter.name ?? skillName).trim().toLowerCase();
    const description = (frontmatter.description ?? "").trim().slice(0, 1024);
    if (name !== skillName.toLowerCase()) return null;
    return {
      name: skillName,
      description,
      body: body.trim(),
      license: frontmatter.license?.trim() || undefined,
      compatibility: frontmatter.compatibility?.trim() || undefined,
      skillDir,
    };
  } catch {
    return null;
  }
}

/**
 * Load all skills (full body). Used when full list with bodies is needed.
 * For agent prompt prefer loadProjectSkillsMetadata + load_skill tool.
 */
export async function loadProjectSkills(
  projectId: string
): Promise<ProjectSkill[]> {
  const metaList = await loadProjectSkillsMetadata(projectId);
  const skills: ProjectSkill[] = [];
  for (const m of metaList) {
    const full = await loadSkillInstructions(projectId, m.name);
    if (full) skills.push(full);
  }
  return skills;
}
