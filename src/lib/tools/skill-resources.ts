import fs from "fs/promises";
import path from "path";
import {
  inferLanguageFromPath,
  parseLocalMarkdownLinks,
  parseRequiredSkillResourceLinks,
} from "@/lib/tools/text-helpers";

/**
 * Skill resource discovery + required-resource autoload for the `load_skill`
 * / `load_skill_resource` tool family. Extracted verbatim from `tool.ts`
 * (§10 decomposition). The path containment check in `resolveSkillLocalFile`
 * is a security boundary — a skill body's markdown links are model-visible
 * text and must never escape the skill directory.
 */

const SKILL_RESOURCE_LIST_LIMIT = 60;
export const SKILL_RESOURCE_READ_MAX_CHARS = 24000;
const SKILL_REQUIRED_AUTOLOAD_MAX_FILES = 4;
const SKILL_REQUIRED_AUTOLOAD_MAX_CHARS_TOTAL = 50000;
const SKILL_REQUIRED_AUTOLOAD_MAX_CHARS_PER_FILE = 18000;

/**
 * Resolve a relative path inside a skill directory to an absolute file path.
 * Returns null when the path is empty, contains traversal, escapes the skill
 * root, or does not point at an existing regular file.
 */
export async function resolveSkillLocalFile(
  skillDir: string,
  relativePath: string
): Promise<string | null> {
  const normalized = path.normalize(relativePath).replace(/^[/\\]+/, "");
  if (!normalized || normalized.includes("..")) return null;

  const skillRoot = path.resolve(skillDir);
  const fullPath = path.resolve(skillRoot, normalized);
  if (!fullPath.startsWith(skillRoot + path.sep) && fullPath !== skillRoot) {
    return null;
  }

  try {
    const stat = await fs.stat(fullPath);
    if (!stat.isFile()) return null;
    return fullPath;
  } catch {
    return null;
  }
}

async function isDirectory(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function collectSkillFilesRecursive(
  rootDir: string,
  skillDir: string,
  limit: number
): Promise<string[]> {
  const results: string[] = [];
  const queue: string[] = [rootDir];

  while (queue.length > 0 && results.length < limit) {
    const dir = queue.shift()!;
    const entries = await fs
      .readdir(dir, { withFileTypes: true })
      .catch(() => null);
    if (!entries) {
      continue;
    }

    for (const entry of entries) {
      if (results.length >= limit) break;
      if (entry.name.startsWith(".")) continue;

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;

      const relative = path.relative(skillDir, fullPath).replaceAll("\\", "/");
      results.push(relative);
    }
  }

  return results;
}

/**
 * List resource files a skill exposes: local markdown links in SKILL.md plus
 * everything under the conventional references/, scripts/, assets/ dirs,
 * deduplicated and capped at SKILL_RESOURCE_LIST_LIMIT.
 */
export async function listSkillResourcePaths(
  skillDir: string,
  skillBody: string
): Promise<string[]> {
  const result: string[] = [];
  const seen = new Set<string>();
  const pushUnique = (value: string) => {
    if (seen.has(value) || result.length >= SKILL_RESOURCE_LIST_LIMIT) return;
    seen.add(value);
    result.push(value);
  };

  const links = parseLocalMarkdownLinks(skillBody);
  for (const link of links) {
    if (result.length >= SKILL_RESOURCE_LIST_LIMIT) break;
    const fullPath = await resolveSkillLocalFile(skillDir, link);
    if (!fullPath) continue;
    const relative = path.relative(skillDir, fullPath).replaceAll("\\", "/");
    pushUnique(relative);
  }

  const resourceDirs = ["references", "scripts", "assets"];
  for (const dirName of resourceDirs) {
    if (result.length >= SKILL_RESOURCE_LIST_LIMIT) break;
    const dirPath = path.join(skillDir, dirName);
    if (!(await isDirectory(dirPath))) continue;
    const remaining = SKILL_RESOURCE_LIST_LIMIT - result.length;
    const files = await collectSkillFilesRecursive(dirPath, skillDir, remaining);
    for (const file of files) {
      pushUnique(file);
    }
  }

  return result;
}

export interface RequiredSkillResourceContent {
  relativePath: string;
  language: string;
  content: string;
  truncated: boolean;
}

export type RequiredResourceSkipReason =
  | "not_found"
  | "read_error"
  | "file_limit"
  | "char_limit";

export interface RequiredSkillResourceSkip {
  relativePath: string;
  reason: RequiredResourceSkipReason;
}

export interface RequiredSkillResourceAutoloadReport {
  detectedLinks: string[];
  loaded: RequiredSkillResourceContent[];
  skipped: RequiredSkillResourceSkip[];
}

/**
 * Auto-load the files a SKILL.md links locally (treated as required context
 * before execution), bounded by file-count and char budgets so a link-heavy
 * skill cannot flood the prompt.
 */
export async function loadRequiredSkillResources(
  skillDir: string,
  skillBody: string
): Promise<RequiredSkillResourceAutoloadReport> {
  const requiredLinks = parseRequiredSkillResourceLinks(skillBody);
  const loaded: RequiredSkillResourceContent[] = [];
  const skipped: RequiredSkillResourceSkip[] = [];
  let totalChars = 0;

  for (const link of requiredLinks) {
    const normalizedLink = link.replace(/\\/g, "/");
    if (loaded.length >= SKILL_REQUIRED_AUTOLOAD_MAX_FILES) {
      skipped.push({ relativePath: normalizedLink, reason: "file_limit" });
      continue;
    }
    if (totalChars >= SKILL_REQUIRED_AUTOLOAD_MAX_CHARS_TOTAL) {
      skipped.push({ relativePath: normalizedLink, reason: "char_limit" });
      continue;
    }

    const fullPath = await resolveSkillLocalFile(skillDir, link);
    if (!fullPath) {
      skipped.push({ relativePath: normalizedLink, reason: "not_found" });
      continue;
    }

    let raw: string;
    try {
      raw = await fs.readFile(fullPath, "utf-8");
    } catch {
      skipped.push({ relativePath: normalizedLink, reason: "read_error" });
      continue;
    }

    const remaining = SKILL_REQUIRED_AUTOLOAD_MAX_CHARS_TOTAL - totalChars;
    const maxForFile = Math.min(SKILL_REQUIRED_AUTOLOAD_MAX_CHARS_PER_FILE, remaining);
    if (maxForFile <= 0) {
      skipped.push({ relativePath: normalizedLink, reason: "char_limit" });
      continue;
    }

    const truncated = raw.length > maxForFile;
    const content = truncated ? raw.slice(0, maxForFile) : raw;
    totalChars += content.length;

    loaded.push({
      relativePath: path.relative(skillDir, fullPath).replaceAll("\\", "/"),
      language: inferLanguageFromPath(fullPath),
      content,
      truncated,
    });
  }

  return {
    detectedLinks: requiredLinks,
    loaded,
    skipped,
  };
}

/** Human-readable skip reason for the load_skill autoload report. */
export function formatRequiredResourceSkipReason(
  reason: RequiredResourceSkipReason
): string {
  switch (reason) {
    case "not_found":
      return "not found";
    case "read_error":
      return "read error";
    case "file_limit":
      return `file limit (${SKILL_REQUIRED_AUTOLOAD_MAX_FILES})`;
    case "char_limit":
      return `char limit (${SKILL_REQUIRED_AUTOLOAD_MAX_CHARS_TOTAL})`;
    default:
      return reason;
  }
}
