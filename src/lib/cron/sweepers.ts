/**
 * Boot-time + periodic sweepers for transient `data/` subsystems (PM #32).
 *
 * Background — CLAUDE.md is explicit that "data/ IS the database", but several
 * directories under it have no retention policy at all:
 *   - `data/tmp/`               — uploaded files, scratch artifacts. Tested
 *                                  deployments accumulated 400+ files older
 *                                  than 7 days with no cleanup path.
 *   - `data/queue/<chatId>.json` — pending background-job descriptors. If a
 *                                  chat is deleted while a job is queued, the
 *                                  queue file becomes orphan and gets resumed
 *                                  on the next boot for a chat that no longer
 *                                  exists (creates a fresh empty chat, runs
 *                                  the prompt, burns LLM budget).
 *
 * Deliberately NOT swept here yet:
 *   - `data/memory/<projectId>/` — needs project-store cross-check to decide
 *     "project deleted" vs "project still exists, just not opened in months".
 *     Adding without careful predicate would erase user knowledge. Deferred
 *     until the project-deletion path explicitly invokes the memory clear.
 *   - `data/external-sessions/`  — TTL semantics depend on the integration
 *     (Telegram session lifetime ≠ web-API session lifetime). Defer until
 *     we have per-integration TTL policy.
 *
 * Design choices:
 *   - Idempotent and bounded — every sweeper logs `{ removed, kept }` so the
 *     operator can audit the first few sweeps.
 *   - Boot-time + recurring — runs once on `ensureCronSchedulerStarted()`
 *     and every SWEEP_INTERVAL_MS (6h). Interval handle is registered in
 *     `globalThis` so dev-mode HMR doesn't stack timers.
 *   - Errors are caught and logged — a failed sweep never crashes the boot.
 */
import fs from "fs/promises";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const TMP_DIR = path.join(DATA_DIR, "tmp");
const QUEUE_DIR = path.join(DATA_DIR, "queue");

/** Files in `data/tmp/` older than this are eligible for deletion. */
export const TMP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Period for the recurring sweep timer (6h). Boot-time sweep is separate. */
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface SweepResult {
  scanned: number;
  removed: number;
  errors: number;
  /** File paths that were removed — bounded to first 20 for log brevity. */
  removedSample: string[];
}

/**
 * Delete files (not directories) inside `data/tmp/` whose mtime exceeds
 * `maxAgeMs`. Returns a summary suitable for structured logging.
 *
 * Crash-safe: each unlink is independent; one failed delete doesn't abort
 * the rest. Symlinks are NOT followed — `fs.lstat` is used so a symlink to
 * `/etc/...` won't trick us into deleting outside the sandbox.
 */
export async function sweepTempDir(
  maxAgeMs: number = TMP_MAX_AGE_MS
): Promise<SweepResult> {
  const result: SweepResult = {
    scanned: 0,
    removed: 0,
    errors: 0,
    removedSample: [],
  };
  let files: string[];
  try {
    files = await fs.readdir(TMP_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return result;
    throw err;
  }

  const cutoffMs = Date.now() - maxAgeMs;
  for (const file of files) {
    const filePath = path.join(TMP_DIR, file);
    result.scanned += 1;
    try {
      const stat = await fs.lstat(filePath);
      // Skip directories and symlinks — only sweep regular files.
      if (!stat.isFile()) continue;
      if (stat.mtimeMs > cutoffMs) continue;
      await fs.unlink(filePath);
      result.removed += 1;
      if (result.removedSample.length < 20) {
        result.removedSample.push(file);
      }
    } catch (err) {
      result.errors += 1;
      console.warn(
        `[sweepers] sweepTempDir failed for ${file}:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }
  return result;
}

/**
 * Delete queue entries whose `chatId` no longer corresponds to an existing
 * chat. Without this, a background job queued before the user deleted the
 * chat would be resumed on next boot for a non-existent chat — the daemon
 * silently creates a fresh empty chat under that id and runs the prompt,
 * burning LLM budget on output the user will never see.
 *
 * `existingChatIds` is injected (not imported from chat-store directly) so
 * the unit test can stub it without booting the whole chat-store module.
 */
export async function sweepOrphanQueueEntries(
  existingChatIds: ReadonlySet<string>
): Promise<SweepResult> {
  const result: SweepResult = {
    scanned: 0,
    removed: 0,
    errors: 0,
    removedSample: [],
  };
  let files: string[];
  try {
    files = await fs.readdir(QUEUE_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return result;
    throw err;
  }

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    result.scanned += 1;
    const chatId = file.slice(0, -".json".length);
    if (existingChatIds.has(chatId)) continue;
    const filePath = path.join(QUEUE_DIR, file);
    try {
      await fs.unlink(filePath);
      result.removed += 1;
      if (result.removedSample.length < 20) {
        result.removedSample.push(file);
      }
    } catch (err) {
      result.errors += 1;
      console.warn(
        `[sweepers] sweepOrphanQueueEntries failed for ${file}:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }
  return result;
}

/**
 * One-shot sweep of every supported subsystem. Resolves the chat id set
 * lazily so this module doesn't pull the full chat-store at import time
 * (which would in turn install the SIGTERM-flush handler — fine in prod,
 * noisy under Vitest).
 *
 * Sweeps performed:
 *   - tmp: `data/tmp/` files older than 7d
 *   - queue: orphan `data/queue/<chatId>.json` whose chat no longer exists
 *   - ghost: orphan in-progress GoalTree tasks for chats not currently
 *     running. Pre-Sprint 2 this only ran ONCE at boot — any task that
 *     went orphan mid-uptime (job crashed without the queue picking it
 *     up) stayed in_progress until the next restart. Adding it here
 *     gives the 6h recurring path a chance to catch it.
 */
export async function runAllSweepers(): Promise<{
  tmp: SweepResult;
  queue: SweepResult;
  ghost: { ok: boolean };
}> {
  // Dynamic import: keeps the module dependency-light at boot and lets
  // tests stub the chat-store without affecting the sweeper API surface.
  const { getAllChats } = await import("@/lib/storage/chat-store");
  let chatIds: Set<string>;
  try {
    const items = await getAllChats();
    chatIds = new Set(items.map((c) => c.id));
  } catch (err) {
    console.warn(
      "[sweepers] Could not enumerate chats for queue-orphan sweep:",
      err instanceof Error ? err.message : String(err)
    );
    chatIds = new Set();
  }

  const [tmp, queue, ghost] = await Promise.all([
    sweepTempDir().catch((err) => {
      console.warn("[sweepers] sweepTempDir threw:", err);
      return { scanned: 0, removed: 0, errors: 1, removedSample: [] };
    }),
    sweepOrphanQueueEntries(chatIds).catch((err) => {
      console.warn("[sweepers] sweepOrphanQueueEntries threw:", err);
      return { scanned: 0, removed: 0, errors: 1, removedSample: [] };
    }),
    // Dynamic import keeps sweepers.ts independent of the agent layer —
    // the only edge it adds is a single fn call, and tests can stub the
    // module without touching the daemon/goal-store wiring.
    (async () => {
      try {
        const { sweepGhostTasks } = await import("@/lib/agent/ghost-sweeper");
        await sweepGhostTasks();
        return { ok: true };
      } catch (err) {
        console.warn("[sweepers] sweepGhostTasks threw:", err);
        return { ok: false };
      }
    })(),
  ]);

  console.log(
    `[sweepers] Completed sweep: tmp ${JSON.stringify({
      scanned: tmp.scanned,
      removed: tmp.removed,
      errors: tmp.errors,
    })}, queue ${JSON.stringify({
      scanned: queue.scanned,
      removed: queue.removed,
      errors: queue.errors,
    })}, ghost ${JSON.stringify(ghost)}`
  );

  return { tmp, queue, ghost };
}

/**
 * Install a recurring interval that runs `runAllSweepers()` every 6 hours.
 * Idempotent via `globalThis` so dev-mode HMR doesn't stack timers.
 */
declare global {
  var __orchestraSweepInterval__: NodeJS.Timeout | undefined;
}

export function ensureSweepersScheduled(): void {
  if (globalThis.__orchestraSweepInterval__) return;
  globalThis.__orchestraSweepInterval__ = setInterval(() => {
    void runAllSweepers().catch((err) => {
      console.warn("[sweepers] Scheduled sweep failed:", err);
    });
  }, SWEEP_INTERVAL_MS);
  // Don't keep the event loop alive just for sweep timing — let the process
  // exit naturally if everything else is done.
  globalThis.__orchestraSweepInterval__.unref?.();
}
