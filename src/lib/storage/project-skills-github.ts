/**
 * GitHub skill installation (§8 decomposition — extracted from
 * `project-store.ts` to shrink it below the 1500-line line). Clones a SKILL
 * bundle from a public GitHub repo (URL → ref → tree walk → download → write),
 * with fixed-host GitHub fetches and a file-count cap. The shared skill helpers
 * (`parseFrontmatter` / `validateSkillName` / `findProjectSkillDir` /
 * `getProjectSkillsDir` / `SKILL_FILE`) stay in `project-store` and are imported
 * one-way — `project-store` does NOT import this module, so there is no cycle.
 */
import fs from "fs/promises";
import path from "path";
import { safeWriteFile } from "./fs-utils";
import {
  SKILL_FILE,
  parseFrontmatter,
  validateSkillName,
  findProjectSkillDir,
  getProjectSkillsDir,
  getProject,
  ensureDir,
  migrateLegacySkillsDir,
} from "./project-store";

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_MAX_SKILL_FILES = 600;
const GITHUB_MAX_TOTAL_BYTES = 30 * 1024 * 1024;

interface ParsedGitHubSkillUrl {
  owner: string;
  repo: string;
  ref?: string;
  sourcePath: string;
}

interface GitHubContentItem {
  type: string;
  path: string;
  download_url: string | null;
  url?: string;
}

interface GitHubFileDescriptor {
  repoPath: string;
  downloadUrl: string | null;
  apiUrl: string | null;
}

interface DownloadedGitHubFile {
  relativePath: string;
  content: Buffer;
}

function normalizePosixPath(input: string): string {
  const normalized = path.posix.normalize(input.replace(/\\/g, "/"));
  return normalized.replace(/^\/+/, "").replace(/\/+$/, "");
}

function encodeGitHubPath(pathValue: string): string {
  return normalizePosixPath(pathValue)
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function parseGitHubSkillUrl(rawUrl: string): { ok: true; value: ParsedGitHubSkillUrl } | { ok: false; error: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { ok: false, error: "Invalid URL. Provide a full GitHub URL." };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== "github.com" && hostname !== "www.github.com") {
    return {
      ok: false,
      error: "Only github.com URLs are supported for skill import.",
    };
  }

  const parts = parsed.pathname
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part));
  if (parts.length < 2) {
    return {
      ok: false,
      error: "GitHub URL must include owner and repository.",
    };
  }

  const owner = parts[0].trim();
  const repo = parts[1].replace(/\.git$/i, "").trim();
  if (!owner || !repo) {
    return {
      ok: false,
      error: "GitHub URL must include valid owner and repository names.",
    };
  }

  let ref: string | undefined;
  let sourcePath = "";

  if (parts.length >= 3) {
    const mode = parts[2];
    if (mode === "tree" || mode === "blob" || mode === "raw") {
      if (parts[3]) {
        ref = parts[3].trim();
      }
      if (parts.length > 4) {
        sourcePath = normalizePosixPath(parts.slice(4).join("/"));
      }
    }
  }

  return {
    ok: true,
    value: {
      owner,
      repo,
      ref,
      sourcePath,
    },
  };
}

function githubApiHeaders(accept = "application/vnd.github+json"): HeadersInit {
  return {
    Accept: accept,
    "User-Agent": "orchestra-skill-installer",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function fetchGitHubJson(
  url: string
): Promise<{ ok: true; data: unknown } | { ok: false; error: string; status: number }> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: githubApiHeaders(),
    });
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : "Network error calling GitHub API.",
    };
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { message?: string }
      | null;
    const remaining = response.headers.get("x-ratelimit-remaining");
    const resetAt = response.headers.get("x-ratelimit-reset");
    if (response.status === 403 && remaining === "0") {
      const reset = resetAt
        ? new Date(Number(resetAt) * 1000).toISOString()
        : "later";
      return {
        ok: false,
        status: response.status,
        error: `GitHub API rate limit exceeded. Try again after ${reset}.`,
      };
    }
    return {
      ok: false,
      status: response.status,
      error:
        payload?.message?.trim() ||
        `GitHub API request failed with status ${response.status}.`,
    };
  }

  const data = await response.json().catch(() => null);
  if (data === null) {
    return {
      ok: false,
      status: response.status,
      error: "GitHub API returned invalid JSON.",
    };
  }
  return { ok: true, data };
}

function asGitHubContentItem(value: unknown): GitHubContentItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const entry = value as Record<string, unknown>;
  const type = typeof entry.type === "string" ? entry.type : "";
  const filePath = typeof entry.path === "string" ? entry.path : "";
  if (!type || !filePath) return null;
  const downloadUrl = typeof entry.download_url === "string" ? entry.download_url : null;
  const apiUrl = typeof entry.url === "string" ? entry.url : null;
  return {
    type,
    path: normalizePosixPath(filePath),
    download_url: downloadUrl,
    url: apiUrl ?? undefined,
  };
}

async function resolveGitHubRef(
  owner: string,
  repo: string,
  ref: string | undefined
): Promise<{ ok: true; ref: string } | { ok: false; error: string }> {
  const trimmedRef = ref?.trim();
  if (trimmedRef) {
    return { ok: true, ref: trimmedRef };
  }

  const repoMeta = await fetchGitHubJson(
    `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
  );
  if (!repoMeta.ok) {
    return {
      ok: false,
      error: `Failed to resolve repository default branch: ${repoMeta.error}`,
    };
  }

  const defaultBranch =
    typeof (repoMeta.data as { default_branch?: unknown }).default_branch === "string"
      ? (repoMeta.data as { default_branch: string }).default_branch.trim()
      : "";
  if (!defaultBranch) {
    return {
      ok: false,
      error: "Failed to resolve repository default branch.",
    };
  }
  return { ok: true, ref: defaultBranch };
}

async function collectGitHubFiles(
  owner: string,
  repo: string,
  ref: string,
  sourcePath: string
): Promise<{ ok: true; files: GitHubFileDescriptor[] } | { ok: false; error: string }> {
  const queue: string[] = [sourcePath];
  const visitedDirs = new Set<string>();
  const files: GitHubFileDescriptor[] = [];

  while (queue.length > 0) {
    const current = normalizePosixPath(queue.shift() ?? "");
    if (visitedDirs.has(current)) continue;
    visitedDirs.add(current);

    const encoded = encodeGitHubPath(current);
    const endpoint =
      `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents` +
      `${encoded ? `/${encoded}` : ""}?ref=${encodeURIComponent(ref)}`;
    const result = await fetchGitHubJson(endpoint);
    if (!result.ok) {
      return {
        ok: false,
        error:
          current
            ? `Failed to read GitHub path "${current}": ${result.error}`
            : `Failed to read repository root: ${result.error}`,
      };
    }

    const list = Array.isArray(result.data) ? result.data : [result.data];
    for (const item of list) {
      const entry = asGitHubContentItem(item);
      if (!entry) continue;
      if (entry.type === "dir") {
        queue.push(entry.path);
        continue;
      }
      if (entry.type !== "file") continue;

      files.push({
        repoPath: entry.path,
        downloadUrl: entry.download_url,
        apiUrl: entry.url ?? null,
      });
      if (files.length > GITHUB_MAX_SKILL_FILES) {
        return {
          ok: false,
          error: `Skill import aborted: too many files (${files.length}). Maximum allowed is ${GITHUB_MAX_SKILL_FILES}.`,
        };
      }
    }
  }

  return { ok: true, files };
}

function deriveRelativeSkillPath(repoPath: string, sourcePath: string): string | null {
  const normalizedRepoPath = normalizePosixPath(repoPath);
  const normalizedSourcePath = normalizePosixPath(sourcePath);

  // `path.posix.normalize("")` returns "." (not ""). Without the explicit
  // "." check, an installSkillFromGitHub call against a URL with no path
  // tail (e.g. `https://github.com/owner/repo`) silently drops every file
  // and bubbles up as "Imported path must contain SKILL.md at its root".
  // Caught by unit tests in `project-store-github.test.ts`.
  if (!normalizedSourcePath || normalizedSourcePath === ".") {
    return normalizedRepoPath;
  }
  if (normalizedRepoPath === normalizedSourcePath) {
    return path.posix.basename(normalizedRepoPath);
  }
  const prefix = `${normalizedSourcePath}/`;
  if (!normalizedRepoPath.startsWith(prefix)) {
    return null;
  }
  return normalizedRepoPath.slice(prefix.length);
}

async function downloadGitHubFile(
  file: GitHubFileDescriptor
): Promise<{ ok: true; content: Buffer } | { ok: false; error: string }> {
  const targetUrl = file.downloadUrl ?? file.apiUrl;
  if (!targetUrl) {
    return {
      ok: false,
      error: `Cannot download "${file.repoPath}": missing download URL.`,
    };
  }

  let response: Response;
  try {
    response = await fetch(targetUrl, {
      headers: file.downloadUrl
        ? { "User-Agent": "orchestra-skill-installer" }
        : githubApiHeaders("application/vnd.github.raw"),
    });
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? `Failed to download "${file.repoPath}": ${error.message}`
          : `Failed to download "${file.repoPath}".`,
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      error: `Failed to download "${file.repoPath}" (status ${response.status}).`,
    };
  }

  const content = Buffer.from(await response.arrayBuffer());
  return { ok: true, content };
}

function sanitizeSkillNameCandidate(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function deriveSkillNameCandidate(repo: string, sourcePath: string): string {
  const normalizedSourcePath = normalizePosixPath(sourcePath);
  // Same `path.posix.normalize("") -> "."` quirk as in
  // deriveRelativeSkillPath. Without the explicit "." check, an
  // installSkillFromGitHub call with no sourcePath in the URL fell back
  // to candidate="" and bubbled up as "Skill name is required."
  if (!normalizedSourcePath || normalizedSourcePath === ".") return repo;

  const baseName = path.posix.basename(normalizedSourcePath);
  if (baseName.toLowerCase() !== "skill.md") {
    return baseName || repo;
  }

  const parent = path.posix.basename(path.posix.dirname(normalizedSourcePath));
  return parent || repo;
}

function upsertSkillFrontmatterName(raw: string, skillName: string): string {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.trimStart().startsWith("---")) {
    return normalized;
  }

  const match = normalized.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    return normalized;
  }
  const frontmatterBlock = match[1];
  const lines = frontmatterBlock.split("\n");
  let replaced = false;
  const nextLines = lines.map((line) => {
    if (/^name:\s*/i.test(line)) {
      replaced = true;
      return `name: ${skillName}`;
    }
    return line;
  });

  if (!replaced) {
    nextLines.unshift(`name: ${skillName}`);
  }

  return normalized.replace(
    /^---\n[\s\S]*?\n---/,
    `---\n${nextLines.join("\n")}\n---`
  );
}

export async function installSkillFromGitHub(
  projectId: string,
  params: { url: string; skill_name?: string }
): Promise<
  | {
      success: true;
      skillDir: string;
      skillName: string;
      filesCopied: number;
      sourceRef: string;
      sourcePath: string;
    }
  | { success: false; error: string }
> {
  const rawUrl = params.url?.trim() ?? "";
  if (!rawUrl) {
    return { success: false, error: "GitHub URL is required." };
  }

  const project = await getProject(projectId);
  if (!project) {
    return { success: false, error: "Project not found." };
  }

  const parsedUrl = parseGitHubSkillUrl(rawUrl);
  if (!parsedUrl.ok) {
    return { success: false, error: parsedUrl.error };
  }

  const { owner, repo, sourcePath } = parsedUrl.value;
  const resolvedRef = await resolveGitHubRef(owner, repo, parsedUrl.value.ref);
  if (!resolvedRef.ok) {
    return { success: false, error: resolvedRef.error };
  }

  const ref = resolvedRef.ref;
  const collected = await collectGitHubFiles(owner, repo, ref, sourcePath);
  if (!collected.ok) {
    return { success: false, error: collected.error };
  }

  if (collected.files.length === 0) {
    return {
      success: false,
      error: sourcePath
        ? `No files found at path "${sourcePath}" for ref "${ref}".`
        : "Repository contains no files.",
    };
  }

  const downloaded: DownloadedGitHubFile[] = [];
  let totalBytes = 0;

  for (const file of collected.files) {
    const relativePath = deriveRelativeSkillPath(file.repoPath, sourcePath);
    if (!relativePath) continue;
    const normalizedRelativePath = normalizePosixPath(relativePath);
    if (
      !normalizedRelativePath ||
      normalizedRelativePath === ".." ||
      normalizedRelativePath.startsWith("../") ||
      normalizedRelativePath.includes("/../")
    ) {
      return {
        success: false,
        error: `Invalid relative path detected in repository: "${relativePath}".`,
      };
    }

    const fetched = await downloadGitHubFile(file);
    if (!fetched.ok) {
      return { success: false, error: fetched.error };
    }

    totalBytes += fetched.content.byteLength;
    if (totalBytes > GITHUB_MAX_TOTAL_BYTES) {
      return {
        success: false,
        error: `Skill import aborted: total file size exceeds ${Math.round(GITHUB_MAX_TOTAL_BYTES / (1024 * 1024))} MB.`,
      };
    }

    downloaded.push({
      relativePath: normalizedRelativePath,
      content: fetched.content,
    });
  }

  const skillMdIndex = downloaded.findIndex(
    (file) => file.relativePath.toLowerCase() === SKILL_FILE.toLowerCase()
  );
  if (skillMdIndex < 0) {
    return {
      success: false,
      error: `Imported path must contain ${SKILL_FILE} at its root.`,
    };
  }

  const explicitName = params.skill_name?.trim().toLowerCase();
  let skillName = explicitName ?? "";
  if (!skillName) {
    const parsedSkill = parseFrontmatter(downloaded[skillMdIndex].content.toString("utf-8"));
    const frontmatterName = (parsedSkill.frontmatter.name ?? "").trim().toLowerCase();
    if (frontmatterName && validateSkillName(frontmatterName) === null) {
      skillName = frontmatterName;
    } else {
      const candidate = deriveSkillNameCandidate(repo, sourcePath);
      skillName = sanitizeSkillNameCandidate(candidate);
    }
  }

  const nameError = validateSkillName(skillName);
  if (nameError) {
    return {
      success: false,
      error: `Failed to derive valid skill name "${skillName}": ${nameError}`,
    };
  }

  const existingSkillDir = await findProjectSkillDir(projectId, skillName);
  if (existingSkillDir) {
    return {
      success: false,
      error: `Skill "${skillName}" already exists. Choose another name or remove the existing skill first.`,
    };
  }

  const updatedSkillMd = upsertSkillFrontmatterName(
    downloaded[skillMdIndex].content.toString("utf-8"),
    skillName
  );
  downloaded[skillMdIndex] = {
    ...downloaded[skillMdIndex],
    content: Buffer.from(updatedSkillMd, "utf-8"),
  };

  await migrateLegacySkillsDir(projectId);
  const baseDir = getProjectSkillsDir(projectId);
  await ensureDir(baseDir);
  const targetDir = path.join(baseDir, skillName);
  const targetRoot = path.resolve(targetDir);

  try {
    await fs.mkdir(targetDir, { recursive: false });

    for (const file of downloaded) {
      const localRelative = file.relativePath.split("/").join(path.sep);
      const targetPath = path.resolve(targetDir, localRelative);
      if (!targetPath.startsWith(targetRoot + path.sep) && targetPath !== targetRoot) {
        throw new Error(`Invalid write path "${file.relativePath}".`);
      }

      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await safeWriteFile(targetPath, file.content.toString("utf-8"));
    }
  } catch (error) {
    await fs.rm(targetDir, { recursive: true, force: true }).catch(() => undefined);
    return {
      success: false,
      error:
        error instanceof Error
          ? `Failed to write imported skill files: ${error.message}`
          : "Failed to write imported skill files.",
    };
  }

  return {
    success: true,
    skillDir: targetDir,
    skillName,
    filesCopied: downloaded.length,
    sourceRef: ref,
    sourcePath,
  };
}
