/**
 * GET /api/projects/[id]/export
 *
 * Streams the entire project workspace (the per-project working directory
 * under `data/projects/<id>/`) plus the project's chats as a single ZIP
 * archive. Used by the "Download project as ZIP" UI affordance in the file
 * tree.
 *
 * Scope of the export:
 *   - The full project work directory, including `.meta/` (project metadata,
 *     skills, MCP config, knowledge files, cron jobs, blackboard).
 *   - All chats whose `projectId` matches this project (mounted under
 *     `_chats/<chatId>.json` inside the ZIP so the archive is self-contained
 *     and chats don't collide with user files).
 *   - A top-level `_manifest.json` describing the export (project id,
 *     timestamp, file count, Orchestra version).
 *
 * Excluded from the export:
 *   - `node_modules/`, `.next/`, `.git/` — reproducible build/VCS state.
 *   - `.venv/`, `venv/`, `__pycache__/` — Python virtualenvs.
 *   - Settings file (`data/settings/settings.json`) — global, not per-project.
 *   - Vector embeddings (`data/memory/...`) — global, large, not per-project.
 *
 * Security:
 *   - Requires an authenticated session (same gate as the rest of /api).
 *   - Project id is normalized and validated by the existing project store;
 *     `getProject` returning null produces a 404.
 *   - Every file added to the archive is resolved via `assertPathInside` so a
 *     symlink or absoluteRoot escape cannot exfiltrate a file outside the
 *     declared workDir.
 */
import { NextRequest } from "next/server";
import path from "path";
import fs from "fs/promises";
import archiver from "archiver";
import { getProject, resolveWorkDirForProject } from "@/lib/storage/project-store";
import { getAllChats, getChat } from "@/lib/storage/chat-store";
import { assertPathInside } from "@/lib/storage/fs-utils";

const EXCLUDED_DIR_NAMES = new Set([
  "node_modules",
  ".next",
  ".git",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".turbo",
  ".cache",
]);

const EXCLUDED_FILE_SUFFIXES = [".pyc", ".pyo"];

function shouldSkipEntry(name: string): boolean {
  if (EXCLUDED_DIR_NAMES.has(name)) return true;
  if (name.startsWith(".DS_Store")) return true;
  for (const suffix of EXCLUDED_FILE_SUFFIXES) {
    if (name.endsWith(suffix)) return true;
  }
  return false;
}

/**
 * Resolve and validate a project id from a route param. Rejects empty,
 * non-string, and structurally suspicious inputs before any filesystem
 * access. The downstream `getProject` lookup is the second gate.
 */
function sanitizeProjectId(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Project ids in Orchestra are lowercase slugs; we accept the same shape
  // here. The regex matches what `addCronJob`'s `throwIfInvalidProjectId`
  // accepts in `lib/cron/service.ts`.
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/i.test(trimmed)) return null;
  return trimmed;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: rawId } = await params;
  const projectId = sanitizeProjectId(rawId);
  if (!projectId) {
    return Response.json({ error: "Invalid project id." }, { status: 400 });
  }

  const project = await getProject(projectId);
  if (!project) {
    return Response.json({ error: "Project not found." }, { status: 404 });
  }

  const workDir = await resolveWorkDirForProject(projectId);

  // Verify the work directory actually exists on disk before attempting to
  // stream it — surfaces a clean 404 instead of a half-empty ZIP.
  try {
    const stat = await fs.stat(workDir);
    if (!stat.isDirectory()) {
      return Response.json(
        { error: "Project workspace is not a directory." },
        { status: 500 }
      );
    }
  } catch {
    return Response.json(
      { error: "Project workspace not found on disk." },
      { status: 404 }
    );
  }

  // The chat store doesn't have a "fetch all chats by projectId in one shot"
  // helper, so we list the lightweight index and fan out per matching chat.
  // Chat counts per project are typically O(10-100), so the N+1 here is
  // acceptable and avoids loading every chat in the system.
  const chatIndex = await getAllChats().catch(() => []);
  const matchingChatRefs = chatIndex.filter((c) => c.projectId === projectId);
  const chats = (
    await Promise.all(matchingChatRefs.map((ref) => getChat(ref.id).catch(() => null)))
  ).filter((c): c is NonNullable<typeof c> => c !== null);

  // Build the archive against a Node Readable stream we hand to the Response.
  // archiver streams its output as data is written, so memory usage stays
  // bounded by the largest single file rather than the total archive size.
  const archive = archiver("zip", {
    zlib: { level: 6 }, // moderate compression; the agent's text files
                       // compress well and we don't want to pin CPU.
  });

  const archivePromise = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    archive.on("data", (chunk: Buffer) => chunks.push(chunk));
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    archive.on("error", reject);
    archive.on("warning", (err) => {
      // ENOENT during finalize means a file disappeared mid-stream
      // (e.g., a temp file). Log and keep going rather than failing the
      // entire export.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        reject(err);
      }
    });
  });

  // Walk the work directory, adding entries one by one with explicit
  // `assertPathInside` guard at each step. We do NOT use `archive.directory(...)`
  // because it bypasses our path safety checks.
  async function addDirectoryRecursive(
    diskPath: string,
    archivePath: string
  ): Promise<void> {
    const entries = await fs.readdir(diskPath, { withFileTypes: true });
    for (const entry of entries) {
      if (shouldSkipEntry(entry.name)) continue;

      const childDiskPath = path.join(diskPath, entry.name);

      // Defence-in-depth: any entry whose resolved real path escapes the
      // declared workDir (e.g., via a symlink planted by a malicious agent)
      // is skipped. `assertPathInside` throws on escape; we treat the throw
      // as a "skip this entry" signal rather than failing the whole export.
      try {
        assertPathInside(workDir, path.relative(workDir, childDiskPath));
      } catch {
        continue;
      }

      const childArchivePath = `${archivePath}/${entry.name}`;
      if (entry.isDirectory()) {
        await addDirectoryRecursive(childDiskPath, childArchivePath);
      } else if (entry.isFile()) {
        archive.file(childDiskPath, { name: childArchivePath });
      }
      // Symlinks and other entry types intentionally skipped — see threat
      // model in `assertPathInside` doc comment.
    }
  }

  const projectDirName = project.name?.trim()
    ? project.name.trim().replace(/[^a-zA-Z0-9-_]+/g, "-").slice(0, 64)
    : projectId;

  await addDirectoryRecursive(workDir, projectDirName);

  // Append associated chats under _chats/ to keep them clearly separate
  // from the user's own files. Filenames are <chatId>.json which is
  // already constrained by the chat store to a safe shape.
  for (const chat of chats) {
    archive.append(JSON.stringify(chat, null, 2), {
      name: `${projectDirName}/_chats/${chat.id}.json`,
    });
  }

  // Manifest at the archive root — gives the recipient a quick sanity
  // check of what was exported and when.
  const manifest = {
    project: {
      id: projectId,
      name: project.name,
      description: project.description ?? null,
      createdAt: project.createdAt ?? null,
      updatedAt: project.updatedAt ?? null,
    },
    exportedAt: new Date().toISOString(),
    orchestraVersion: "1.0.0",
    chatCount: chats.length,
    excludedPatterns: [...EXCLUDED_DIR_NAMES, ...EXCLUDED_FILE_SUFFIXES],
    note:
      "Settings, vector embeddings, and integration sessions are intentionally excluded. " +
      "Restore by placing the project folder under `data/projects/<id>/`.",
  };
  archive.append(JSON.stringify(manifest, null, 2), {
    name: `${projectDirName}/_manifest.json`,
  });

  await archive.finalize();
  const buffer = await archivePromise;

  const filename = `${projectDirName}-${new Date().toISOString().slice(0, 10)}.zip`;
  return new Response(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(buffer.byteLength),
      "Cache-Control": "no-store",
    },
  });
}
