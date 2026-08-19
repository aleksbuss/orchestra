import fs from "fs/promises";
import path from "path";
import { Project, ProjectSchema } from "@/lib/types";
import { deleteChatsByProjectId } from "@/lib/storage/chat-store";
import { clearMemoryCache } from "@/lib/memory/memory";
import { publishUiSyncEvent } from "@/lib/realtime/event-bus";
import { assertPathInsideRealpath, safeWriteFile, withFileLock } from "./fs-utils";
import { getDataDir } from "@/lib/storage/data-dir";
import { autoInstallGraphifyIfAvailable } from "@/lib/storage/skill-autoinstall";

const DATA_DIR = getDataDir();
const PROJECTS_DIR = path.join(DATA_DIR, "projects");

/** ID used for "No Project (Global)" — work dir is data/projects */
export const GLOBAL_PROJECT_ID = "none";

/*
 * ─── Project roots: there are TWO, and they are deliberately two names ───
 *
 *   getProjectContentRoot(id)   async   Where the project's FILES live.
 *                                       Linked project → its `absoluteRoot`.
 *                                       Sandbox project → data/projects/<id>/.
 *
 *   getProjectMetaRoot(id)      sync    Where ORCHESTRA's own per-project
 *                                       state lives (.meta/, blackboard).
 *                                       ALWAYS data/projects/<id>/ — never
 *                                       the user's repository.
 *
 * PM #105 came from one name serving both meanings: `getWorkDir(projectId)`
 * returned the sandbox, `getWorkDir(projectId, absoluteRoot)` returned the
 * linked repo, and which one you got depended on whether the caller happened
 * to have looked the project up. The tool that REPORTED the working directory
 * got the sandbox while every tool that ACTED got the repo; the agent believed
 * the report and answered from the wrong codebase.
 *
 * So: no single-name resolver, and no sync content root. Resolving content
 * means reading project.json, and a cached sync accessor would hand out a
 * stale root intermittently — a worse failure than the one being fixed
 * (silent, non-reproducible, and it looks like a model error).
 *
 * A caller that cannot say which of the two it wants is the bug.
 * `workdir-resolution-contract.test.ts` fails the build on new bare uses.
 */

/**
 * Orchestra-owned directory for a project: `data/projects/<id>/`, or
 * `data/projects/` for the global context. Never honors `absoluteRoot` —
 * Orchestra's internals do not get written into the user's repository.
 */
export function getProjectMetaRoot(projectId?: string | null): string {
  if (!projectId || projectId === GLOBAL_PROJECT_ID) return PROJECTS_DIR;
  return path.join(PROJECTS_DIR, projectId);
}

/**
 * The project's content root — the directory whose FILES the project is
 * about. For a linked project (Open Folder) that is the validated
 * `absoluteRoot`; for a sandbox project it coincides with the meta root.
 *
 * Async because it reads `project.json`. Falls back to the sandbox on any
 * lookup failure — never throws, because every caller is on a request path
 * where a thrown resolver would take down the turn.
 */
export async function getProjectContentRoot(
  projectId?: string | null
): Promise<string> {
  if (!projectId || projectId === GLOBAL_PROJECT_ID) return PROJECTS_DIR;
  try {
    const project = await getProject(projectId);
    const linked = project?.absoluteRoot?.trim();
    return linked || getProjectMetaRoot(projectId);
  } catch {
    return getProjectMetaRoot(projectId);
  }
}

export async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Thrown when an operator-supplied `absoluteRoot` is not a linkable directory.
 * Routes map it to a 400; every other failure keeps its existing status.
 */
export class InvalidProjectRootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidProjectRootError";
  }
}

/**
 * Validate and canonicalize an operator-supplied `absoluteRoot` before it is
 * persisted. Until this existed, `PUT /api/projects/<id>` spread the request
 * body straight into `updateProject`, so ANY string became a project's
 * filesystem root — including one that does not exist, a regular file, or the
 * data directory itself.
 *
 * Rejects:
 *   - relative paths (a relative root resolves against `process.cwd()`, which
 *     differs between `next dev`, a cron tick and a test run);
 *   - paths that don't exist or aren't directories (the agent would `cd` into
 *     nothing and improvise — that is PM #105's failure shape);
 *   - the data directory or any ancestor of it. `data/settings/*.json` holds
 *     provider API keys, and the Files API lists + downloads anything under a
 *     project's content root — a root of `/` would publish the vault.
 *
 * Returns the REALPATH, not the input. Every guard on the linked surface
 * (`assertPathInsideRealpath`) compares against the realpath'd root, so
 * storing the realpath keeps the value the operator sees, the value we store,
 * and the guard's baseline the same string. On macOS this means a link to
 * `/tmp/x` is stored as `/private/tmp/x`.
 */
export async function validateAbsoluteRoot(raw: string): Promise<string> {
  const candidate = raw.trim();
  if (!candidate) {
    throw new InvalidProjectRootError("absoluteRoot must not be empty");
  }
  if (!path.isAbsolute(candidate)) {
    throw new InvalidProjectRootError(
      `absoluteRoot must be an absolute path (got "${candidate}")`
    );
  }

  let realRoot: string;
  try {
    realRoot = await fs.realpath(path.resolve(candidate));
  } catch {
    throw new InvalidProjectRootError(
      `absoluteRoot "${candidate}" does not exist`
    );
  }

  const stat = await fs.stat(realRoot);
  if (!stat.isDirectory()) {
    throw new InvalidProjectRootError(
      `absoluteRoot "${candidate}" is not a directory`
    );
  }

  // The data dir may not exist yet on a fresh install — fall back to the
  // string form rather than letting a missing dir skip the check.
  const realDataDir = await fs
    .realpath(path.resolve(DATA_DIR))
    .catch(() => path.resolve(DATA_DIR));
  if (realRoot === realDataDir || realDataDir.startsWith(realRoot + path.sep)) {
    throw new InvalidProjectRootError(
      `absoluteRoot "${candidate}" contains Orchestra's data directory`
    );
  }

  return realRoot;
}

function projectMetaDir(projectId: string) {
  return path.join(PROJECTS_DIR, projectId, ".meta");
}

function projectMetaFile(projectId: string) {
  return path.join(projectMetaDir(projectId), "project.json");
}

/** Path to project's .meta/skills directory — Agent Skills spec */
export function getProjectSkillsDir(projectId: string): string {
  return path.join(projectMetaDir(projectId), "skills");
}

/**
 * Legacy path to project's .meta/instructions directory (kept for
 * compatibility/migration). Exported for `project-skills.ts` only — it needs
 * the legacy dir to migrate and to read pre-migration skills, and it cannot
 * derive it, because `projectMetaDir` stays private here.
 */
export function getProjectLegacyInstructionsDir(projectId: string): string {
  return path.join(projectMetaDir(projectId), "instructions");
}

/** @deprecated Use getProjectSkillsDir. Kept for compatibility with existing imports. */
export function getProjectInstructionsDir(projectId: string): string {
  return getProjectSkillsDir(projectId);
}

/** Path to project's .meta/mcp directory — MCP servers config (next to skills) */
export function getProjectMcpDir(projectId: string): string {
  return path.join(projectMetaDir(projectId), "mcp");
}

/** Path to project's .meta/mcp/servers.json */
export function getProjectMcpServersPath(projectId: string): string {
  return path.join(getProjectMcpDir(projectId), "servers.json");
}


/**
 * The last set of skipped directory names we logged about.
 *
 * `getAllProjects` runs on most dashboard interactions, so warning on every
 * call would bury the message in its own noise and train the operator to scroll
 * past it. Warning only when the SET CHANGES keeps a newly-orphaned directory
 * loud — which is the case that matters — while a known steady state stays
 * quiet. Deliberately per-process and not persisted: a restart re-announcing
 * the current state is a feature, not a bug.
 */
let lastReportedSkips = "";

function reportSkippedProjectDirs(skipped: string[]): void {
  const fingerprint = skipped.slice().sort().join(",");
  if (fingerprint === lastReportedSkips) return;
  lastReportedSkips = fingerprint;
  if (skipped.length === 0) return;

  console.warn(
    `[project-store] ${skipped.length} director${skipped.length === 1 ? "y" : "ies"} under ` +
      `data/projects/ ${skipped.length === 1 ? "has" : "have"} no readable .meta/project.json ` +
      `and ${skipped.length === 1 ? "is" : "are"} invisible in the app: ${skipped.join(", ")}. ` +
      `Their files are still on disk. Give one a .meta/project.json to bring it back, ` +
      `or move it out of data/projects/.`
  );
}

/** Test seam — the report is deduplicated per process, which a test must reset. */
export function __resetSkippedProjectDirReportForTests(): void {
  lastReportedSkips = "";
}

export async function getAllProjects(): Promise<Project[]> {
  await ensureDir(PROJECTS_DIR);
  const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
  const projects: Project[] = [];

  const skipped: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const metaFile = projectMetaFile(entry.name);
      const content = await fs.readFile(metaFile, "utf-8");
      const parsedRaw = JSON.parse(content);
      const parseResult = ProjectSchema.safeParse(parsedRaw);
      if (parseResult.success) {
        projects.push(parseResult.data);
      } else {
        console.warn(`[project-store] Project ${entry.name} metadata is corrupted:`, parseResult.error.message);
      }
    } catch {
      // PM #104 — a directory without readable `.meta/project.json` is skipped,
      // and skipping it SILENTLY is how six of them accumulated on disk while
      // the app reported they did not exist. One of the six was a real project.
      // The skip itself is right (there is nothing to show); saying nothing
      // about it is not.
      skipped.push(entry.name);
    }
  }

  reportSkippedProjectDirs(skipped);

  return projects.sort(
    (a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

export async function getProject(projectId: string): Promise<Project | null> {
  try {
    const content = await fs.readFile(projectMetaFile(projectId), "utf-8");
    const parsedRaw = JSON.parse(content);
    const parseResult = ProjectSchema.safeParse(parsedRaw);
    if (!parseResult.success) {
      console.warn(`[project-store] Project ${projectId} metadata is corrupted:`, parseResult.error.message);
      return null;
    }
    return parseResult.data;
  } catch {
    return null;
  }
}

export async function createProject(
  project: Omit<Project, "createdAt" | "updatedAt">
): Promise<Project> {
  const now = new Date().toISOString();
  const linkedRoot = project.absoluteRoot?.trim();
  const fullProject: Project = {
    ...project,
    // Validated at the library layer, not only at the route, so a script or a
    // future caller cannot write an unchecked root behind the API's back.
    absoluteRoot: linkedRoot ? await validateAbsoluteRoot(linkedRoot) : undefined,
    createdAt: now,
    updatedAt: now,
  };

  const projectDir = path.join(PROJECTS_DIR, project.id);

  // PM #104 — `project.json` is written LAST, after all the scaffolding below,
  // so anything that throws in between used to leave a directory that
  // `getAllProjects` then skips forever: a project that exists on disk and not
  // in the app. Roll the partial creation back instead.
  //
  // The rollback removes the directory ONLY if this call created it. If it was
  // already there, it holds someone else's files and deleting it would turn a
  // failed create into data loss — the opposite of the point.
  const dirExistedBefore = await fs
    .access(projectDir)
    .then(() => true)
    .catch(() => false);

  try {
    await ensureDir(projectDir);
    await ensureDir(projectMetaDir(project.id));
    await ensureDir(getProjectSkillsDir(project.id));
    await ensureDir(path.join(projectMetaDir(project.id), "knowledge"));
    await ensureDir(getProjectMcpDir(project.id));

    const defaultMcpServers = {
      mcpServers: {
        "firecrawl-mcp": {
          command: "npx",
          args: ["-y", "firecrawl-mcp"],
          env: {
            FIRECRAWL_API_KEY: "",
          },
        },
        "sendforsign-mcp": {
          command: "npx",
          args: ["-y", "@sendforsign/mcp"],
          env: {
            ORCHESTRA_API_KEY: "",
            ORCHESTRA_CLIENT_KEY: "",
          },
        },
        "sequential-thinking": {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
        },
        "sqlite-mcp": {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-sqlite"],
          env: {
            SQLITE_DB_PATH: path.join(projectMetaDir(project.id), "mcp", "project.db"),
          },
        },
        "github-mcp": {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: {
            GITHUB_PERSONAL_ACCESS_TOKEN: "",
          },
        },
      },
    };

    await safeWriteFile(
      getProjectMcpServersPath(project.id),
      JSON.stringify(defaultMcpServers, null, 2)
    );

    await safeWriteFile(
      projectMetaFile(project.id),
      JSON.stringify(fullProject, null, 2)
    );
  } catch (err) {
    if (!dirExistedBefore) {
      // Best-effort: a failed rollback must not replace the real error with its
      // own. Worst case we are back to the old behaviour for this one call.
      await fs.rm(projectDir, { recursive: true, force: true }).catch(() => {});
    }
    throw err;
  }

  // Binary-gated: install graphify into the new project only when the CLI is
  // actually present (see skill-autoinstall.ts). Best-effort and never throws —
  // the project is already fully created above; a skill copy failure must not
  // undo it. Runs AFTER the rollback-protected block for exactly that reason.
  const skillInstall = await autoInstallGraphifyIfAvailable(
    getProjectSkillsDir(project.id)
  ).catch(() => "failed" as const);
  if (skillInstall === "failed") {
    // Surface a broken/permission-denied bundled copy — distinct from the CLI
    // simply being absent (which is "skipped-unavailable", not logged). Never
    // fails the create; the project above is already committed.
    console.error(
      JSON.stringify({ event: "skill_autoinstall_failed", projectId: project.id, skill: "graphify" })
    );
  }

  publishUiSyncEvent({
    topic: "projects",
    projectId: project.id,
    reason: "project_created",
  });

  return fullProject;
}

export async function updateProject(
  projectId: string,
  updates: Partial<Project>
): Promise<Project | null> {
  const filePath = projectMetaFile(projectId);

  // Validate BEFORE taking the lock: an invalid root must fail without
  // touching project.json. An explicitly falsy `absoluteRoot` in the patch
  // means "unlink" — the key is dropped and the project reverts to its
  // sandbox. `JSON.stringify` omits the undefined value on write.
  let patch = updates;
  if ("absoluteRoot" in updates) {
    const raw = updates.absoluteRoot?.trim();
    patch = {
      ...updates,
      absoluteRoot: raw ? await validateAbsoluteRoot(raw) : undefined,
    };
  }

  return await withFileLock(filePath, async () => {
    const existing = await getProject(projectId);
    if (!existing) return null;

    const updated: Project = {
      ...existing,
      ...patch,
      id: existing.id, // don't allow ID change
      updatedAt: new Date().toISOString(),
    };

    await safeWriteFile(
      filePath,
      JSON.stringify(updated, null, 2)
    );

    publishUiSyncEvent({
      topic: "projects",
      projectId,
      reason: "project_updated",
    });

    return updated;
  });
}

export async function deleteProject(projectId: string): Promise<boolean> {
  const projectDir = path.join(PROJECTS_DIR, projectId);
  try {
    // Remove chats that belong to this project
    await deleteChatsByProjectId(projectId);
    // Remove project's vector memory (dir and in-memory cache)
    const memoryDir = path.join(DATA_DIR, "memory", projectId);
    await fs.rm(memoryDir, { recursive: true, force: true });
    clearMemoryCache(projectId);
    // Remove project directory (files, .meta, etc.)
    await fs.rm(projectDir, { recursive: true, force: true });
    publishUiSyncEvent({
      topic: "projects",
      projectId,
      reason: "project_deleted",
    });
    return true;
  } catch {
    return false;
  }
}

export async function getProjectFiles(
  projectId: string,
  subPath: string = ""
): Promise<{ name: string; type: "file" | "directory"; size: number }[]> {
  const baseDir = await getProjectContentRoot(projectId);
  // PM #16 defense-in-depth — `path.join` normalizes `../` silently, so a
  // caller that forgot to validate `subPath` could escape the project
  // sandbox. Guard here too; route-layer validation is not assumed.
  // PM #105 — realpath variant, because `baseDir` can be a linked project's
  // real repository root, symlinks and all.
  let targetDir = baseDir;
  if (subPath) {
    try {
      targetDir = await assertPathInsideRealpath(baseDir, subPath);
    } catch {
      return [];
    }
  }

  try {
    const entries = await fs.readdir(targetDir, { withFileTypes: true });
    const files = [];
    const HIDDEN_NAMES = new Set([".meta", ".venv", "venv"]);

    for (const entry of entries) {
      if (HIDDEN_NAMES.has(entry.name)) continue; // hide internal metadata and virtualenvs
      const stat = await fs.stat(path.join(targetDir, entry.name));
      files.push({
        name: entry.name,
        type: entry.isDirectory() ? ("directory" as const) : ("file" as const),
        size: stat.size,
      });
    }

    return files.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  } catch {
    return [];
  }
}

export { PROJECTS_DIR };
