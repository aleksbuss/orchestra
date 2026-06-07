/**
 * Per-write file snapshots — recovery net for agent-induced overwrites.
 *
 * **Why this exists.** The agent calls `write_text_file` dozens of times per
 * run. Git only protects committed state; the window between commits is
 * exactly where damage happens silently — agent rewrites a file with wrong
 * content, user notices 20 minutes later, the previous content is gone.
 * This module captures the previous content of any file the agent is about
 * to overwrite, so we can recover after the fact.
 *
 * **Scope (deliberately minimal).**
 * - File-level: only snapshots the single file being overwritten. NOT a
 *   project-wide checkpoint. `code_execution` is NOT covered (a `git stash`
 *   suggestion would be more appropriate there; see `CLAUDE.md`).
 * - One-way: there is no `restore()` API yet. Snapshots are an audit/recovery
 *   trail; restoration is manual via `data/snapshots/<projectId>/`. A future
 *   PR can add a UI on top — the on-disk format is the contract.
 * - Best-effort: failures during snapshot must NOT block the write. We log
 *   and continue. A failed snapshot is regrettable; a failed write because
 *   of a snapshot bug is worse.
 *
 * **Storage layout.**
 * ```
 * data/snapshots/<projectId>/
 *   <isodate>-<random>.json      // metadata (originalPath, capturedAt, reason)
 *   <isodate>-<random>.content   // raw file bytes
 * ```
 * The pair is identified by the same id; metadata + content are sibling files
 * so manual recovery is `cp .content <originalPath>`.
 *
 * **FIFO cap.** Per-project ring buffer at `MAX_SNAPSHOTS_PER_PROJECT = 200`.
 * On overflow, oldest pairs are deleted. 200 chosen as a back-of-napkin: a
 * heavy session might do ~50 writes; this gives ~4 sessions of headroom
 * without unbounded growth.
 */
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { dataPath } from "@/lib/storage/data-dir";

// Computed lazily on each call so tests can stub `process.cwd()`. Module-load-
// time capture would freeze the path before tests have a chance to redirect it.
function getSnapshotsRoot(): string {
  return dataPath("snapshots");
}
const MAX_SNAPSHOTS_PER_PROJECT = 200;

export type SnapshotMetadata = {
  id: string;
  projectId: string;
  chatId?: string;
  originalPath: string;
  capturedAt: number;
  bytes: number;
  reason: string;
};

function snapshotDir(projectId: string): string {
  return path.join(getSnapshotsRoot(), projectId);
}

function generateSnapshotId(): string {
  // `2026-05-09T07-00-00-456Z__abc12345` — sortable lexicographically by time
  // so directory listing is naturally chronological. Avoid colons (Windows
  // path-incompatible) and dots (would collide with extensions).
  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = crypto.randomBytes(4).toString("hex");
  return `${iso}__${rand}`;
}

/**
 * Capture the existing content of `filePath` before the caller overwrites it.
 *
 * Returns the saved metadata, or `null` if no snapshot was needed (file
 * didn't exist) or if snapshotting failed. Errors are swallowed by design:
 * the snapshot is a safety net, not a write precondition.
 */
export async function snapshotBeforeWrite(args: {
  projectId: string;
  chatId?: string;
  filePath: string;
  reason: string;
}): Promise<SnapshotMetadata | null> {
  try {
    const stat = await fs.stat(args.filePath);
    if (!stat.isFile()) {
      // Directory or special file — nothing meaningful to back up.
      return null;
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // Fresh write, no previous content. Not an error.
      return null;
    }
    // Permission error or transient FS issue — log and skip silently.
    console.warn(
      `[snapshots] stat failed for ${args.filePath}, skipping snapshot:`,
      (err as Error).message
    );
    return null;
  }

  try {
    const dir = snapshotDir(args.projectId);
    await fs.mkdir(dir, { recursive: true });

    const id = generateSnapshotId();
    const contentPath = path.join(dir, `${id}.content`);
    const metaPath = path.join(dir, `${id}.json`);

    // Copy the existing file as the snapshot. Using copyFile (not read+write)
    // preserves the original even if it's binary — text vs binary is the
    // caller's concern, not ours.
    await fs.copyFile(args.filePath, contentPath);
    const stat = await fs.stat(contentPath);

    const metadata: SnapshotMetadata = {
      id,
      projectId: args.projectId,
      chatId: args.chatId,
      originalPath: args.filePath,
      capturedAt: Date.now(),
      bytes: stat.size,
      reason: args.reason,
    };
    await fs.writeFile(metaPath, JSON.stringify(metadata, null, 2), "utf-8");

    // Best-effort prune. Don't await failures.
    pruneSnapshots(args.projectId).catch((err) => {
      console.warn(`[snapshots] prune failed for ${args.projectId}:`, err.message);
    });

    return metadata;
  } catch (err) {
    console.warn(
      `[snapshots] capture failed for ${args.filePath}:`,
      (err as Error).message
    );
    return null;
  }
}

/**
 * List recent snapshots for a project, most recent first. Returns `[]` if
 * the project has no snapshots directory yet.
 */
export async function listProjectSnapshots(
  projectId: string,
  options: { chatId?: string; limit?: number } = {}
): Promise<SnapshotMetadata[]> {
  const dir = snapshotDir(projectId);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw err;
  }

  const metaFiles = entries.filter((f) => f.endsWith(".json"));
  const results: SnapshotMetadata[] = [];

  for (const file of metaFiles) {
    try {
      const content = await fs.readFile(path.join(dir, file), "utf-8");
      const meta = JSON.parse(content) as SnapshotMetadata;
      if (options.chatId && meta.chatId !== options.chatId) continue;
      results.push(meta);
    } catch {
      // Skip malformed metadata silently — a partially-written snapshot from
      // a crashed run is recoverable manually but not worth surfacing here.
    }
  }

  results.sort((a, b) => b.capturedAt - a.capturedAt);
  return options.limit ? results.slice(0, options.limit) : results;
}

/**
 * Remove the oldest snapshots once a project exceeds the cap. Pure FIFO,
 * no per-file logic. Pairs metadata + content; if either file is missing,
 * the surviving file is also unlinked (otherwise we'd accumulate orphans).
 */
async function pruneSnapshots(projectId: string): Promise<void> {
  const all = await listProjectSnapshots(projectId);
  if (all.length <= MAX_SNAPSHOTS_PER_PROJECT) return;

  const dir = snapshotDir(projectId);
  const toDelete = all.slice(MAX_SNAPSHOTS_PER_PROJECT); // oldest at the tail
  await Promise.all(
    toDelete.flatMap((meta) => [
      fs.rm(path.join(dir, `${meta.id}.json`), { force: true }),
      fs.rm(path.join(dir, `${meta.id}.content`), { force: true }),
    ])
  );
}
