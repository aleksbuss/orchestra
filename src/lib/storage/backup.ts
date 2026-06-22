import fs from "fs/promises";
import path from "path";
import { getDataDir } from "@/lib/storage/data-dir";

/**
 * Local-first full-`data/` backup with FIFO rotation.
 *
 * Why this exists. CLAUDE.md is explicit: "data/ IS the database", and the
 * deployment is local-first / single-operator — there is NO external redundancy.
 * A bad write, a disk failure, or a fat-fingered `rm -rf data/` (PM #62 lost 34
 * real chats doing exactly that) is unrecoverable. `snapshots.ts` covers
 * pre-write project rollbacks and `.trash/` covers soft-deleted chats, but
 * nothing snapshots the WHOLE store. This does — proportionately:
 *
 *   - **Zero new deps.** Recursive `fs.cp` (Node 16.7+), not a tar lib or a
 *     shelled-out `tar` (which would add a platform dependency). Copies are
 *     uncompressed; for a local tool with rotation that is an acceptable disk
 *     trade for simplicity + cross-platform reliability.
 *   - **Backups live OUTSIDE `data/`** (sibling `data-backups/` by default).
 *     Two reasons, both load-bearing: (a) backing up `data/` can't recursively
 *     copy its own prior backups, and (b) the backup must SURVIVE the very
 *     accident it protects against — `rm -rf data/` / `mv data/` must not take
 *     the backups with it.
 *   - **Per-file consistency, not global point-in-time.** Chat/project writes
 *     are atomic (`safeWriteFile` = temp + rename), so each copied JSON is
 *     either fully-old or fully-new, never half-written. We do NOT freeze the
 *     whole store; a backup is a "good enough to recover from" snapshot, not a
 *     transactional dump. Sufficient for the threat model (loss, not tearing).
 *   - **Atomic publish.** Copy into `.tmp-…`, then `rename` into place, so a
 *     crash mid-copy never leaves a half-backup that looks complete.
 *
 * NOT in scope (deliberately — over-engineering for a solo local tool):
 * compression, incremental/dedup, cloud/offsite, encryption, point-in-time
 * consistency. If the operator outgrows this, that is a different product.
 *
 * Restore is a MANUAL operator step (it overwrites live state, so it must never
 * be automatic): stop the server, then
 * `rm -rf data && cp -r data-backups/<dir> data`. `listBackups()` /
 * `npm run backup:list` surface what's available.
 */

/** Strict-string opt-out, matching the ORCHESTRA_DISABLE_AUTH / _MULTI_PROCESS_OK posture. */
function backupDisabled(): boolean {
  return process.env.ORCHESTRA_BACKUP_DISABLED === "true";
}

// Each backup is a FULL uncompressed copy of data/ (chats, memory vectors,
// chat-files uploads), so the on-disk footprint is roughly RETENTION × |data/|.
// Default 7 = one week of dailies; lower it (ORCHESTRA_BACKUP_RETENTION) if
// data/ is large. Audit fix #1 — was 10.
const DEFAULT_RETENTION = 7;
const DEFAULT_INTERVAL_HOURS = 24;

/** Regenerable / ephemeral `data/` subdirs — excluded to keep backups lean. */
const EXCLUDED_TOP_LEVEL = new Set(["npm-cache", "tmp", "cache"]);

const BACKUP_DIR_PREFIX = "data-";
const TMP_DIR_PREFIX = ".tmp-";

/**
 * Backup root — a sibling of `data/` (or `ORCHESTRA_BACKUP_DIR`). Resolved at
 * call time (not module load) so a test setting `ORCHESTRA_DATA_DIR` /
 * `ORCHESTRA_BACKUP_DIR` after import is honored.
 */
function backupRoot(): string {
  const override = process.env.ORCHESTRA_BACKUP_DIR;
  if (override) {
    return path.isAbsolute(override) ? override : path.resolve(process.cwd(), override);
  }
  return path.resolve(getDataDir(), "..", "data-backups");
}

function retention(): number {
  const n = Number(process.env.ORCHESTRA_BACKUP_RETENTION);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_RETENTION;
}

function intervalMs(): number {
  const h = Number(process.env.ORCHESTRA_BACKUP_INTERVAL_HOURS);
  const hours = Number.isFinite(h) && h > 0 ? h : DEFAULT_INTERVAL_HOURS;
  return hours * 60 * 60 * 1000;
}

/** Sortable-lexicographically timestamp, mirroring snapshots.ts. */
function stamp(d: Date): string {
  return d.toISOString().replace(/[:.]/g, "-"); // 2026-06-20T19-58-00-456Z
}

/**
 * Copy the live `data/` into a new timestamped backup dir, excluding ephemeral
 * subdirs, with FIFO rotation afterward. Returns the created path, or null when
 * disabled or when there's no `data/` yet (fresh install). Never throws on a
 * partial-copy — it cleans its temp dir and rethrows only programmer errors.
 *
 * @param opts.now  inject the clock for deterministic test ordering.
 */
// PM #78 — `data/` is LIVE while the backup runs: chat-store, queue-store, and
// settings-store all write via `safeWriteFile` (temp-write + rename) on their
// own schedule, completely unsynchronized with the backup's `fs.cp`. `fs.cp`
// internally lists a directory, then `lstat`s/copies each entry — if a file is
// renamed away in the gap between those two steps, `fs.cp` throws ENOENT and
// the WHOLE copy aborts. Confirmed live: a boot backup raced a concurrent
// `chat-index.<uuid>.json.tmp` → `chat-index.json` rename and threw
// `ENOENT: ... lstat '.../chat-index.<uuid>.json.tmp'`.
//
// ROOT FIX = exclude `*.tmp` from the copy. The ONLY thing ever created-then-
// removed is safeWriteFile's `<base>.<uuid><ext>.tmp` artifact (it is renamed
// ONTO the real file); the real files are only ever ATOMICALLY rename-replaced,
// so they never go absent. Dropping `*.tmp` kills the dominant race at the
// source AND avoids copying worthless transient artifacts into the backup.
//
// The retry stays as defense-in-depth for any non-`.tmp` entry legitimately
// deleted mid-copy — but retry ALONE is NOT sufficient: it has no backoff, so
// under sustained churn of a hot file every attempt re-races the same window
// (verified — 3 retries FAIL under tight-loop temp+rename churn while the
// `.tmp` filter PASSES; the original "a retry is overwhelmingly likely to
// succeed" held only at realistic ~80ms debounce cadence, not under load).
const COPY_RETRY_ATTEMPTS = 3;

async function copyDataDirWithRetry(dataDir: string, tmpDir: string): Promise<void> {
  for (let attempt = 1; attempt <= COPY_RETRY_ATTEMPTS; attempt++) {
    try {
      await fs.cp(dataDir, tmpDir, {
        recursive: true,
        filter: (src) => {
          // PM #78 — drop safeWriteFile's transient temp artifacts: they are
          // created-then-renamed-away mid-copy (the ENOENT race) and are
          // worthless in a backup. The real file they become is copied normally.
          if (src.endsWith(".tmp")) return false;
          const rel = path.relative(dataDir, src);
          if (!rel) return true; // the data dir itself
          const top = rel.split(path.sep)[0];
          return !EXCLUDED_TOP_LEVEL.has(top);
        },
      });
      return;
    } catch (err) {
      // Partial copy from the failed attempt must not linger into the retry.
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      const isEnoent = (err as NodeJS.ErrnoException)?.code === "ENOENT";
      if (!isEnoent || attempt === COPY_RETRY_ATTEMPTS) throw err;
    }
  }
}

export async function createDataBackup(opts: { now?: Date } = {}): Promise<{ path: string } | null> {
  if (backupDisabled()) return null;
  const dataDir = getDataDir();
  try {
    await fs.access(dataDir);
  } catch {
    return null; // nothing to back up yet
  }

  const root = backupRoot();
  await fs.mkdir(root, { recursive: true });

  const now = opts.now ?? new Date();
  const finalDir = path.join(root, `${BACKUP_DIR_PREFIX}${stamp(now)}`);
  const tmpDir = path.join(root, `${TMP_DIR_PREFIX}${stamp(now)}-${process.pid}`);

  await copyDataDirWithRetry(dataDir, tmpDir);
  // Atomic publish: a reader never sees a half-populated `data-…` dir.
  await fs.rename(tmpDir, finalDir);

  await pruneBackups();
  return { path: finalDir };
}

/**
 * FIFO-rotate the backup ring to the retention cap (oldest evicted), and sweep
 * any crash-leaked `.tmp-…` partials. Returns `{ kept, removed }`.
 */
export async function pruneBackups(): Promise<{ kept: number; removed: number }> {
  const root = backupRoot();
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return { kept: 0, removed: 0 };
  }

  // Newest first — the timestamp is the lexical prefix, so a plain reverse-sort
  // is chronological.
  const backups = entries.filter((e) => e.startsWith(BACKUP_DIR_PREFIX)).sort().reverse();
  const keep = retention();
  const toDelete = backups.slice(keep);
  let removed = 0;
  for (const name of toDelete) {
    await fs.rm(path.join(root, name), { recursive: true, force: true }).catch(() => {});
    removed++;
  }

  // Crash-leaked temp dirs from an interrupted copy.
  for (const name of entries.filter((e) => e.startsWith(TMP_DIR_PREFIX))) {
    await fs.rm(path.join(root, name), { recursive: true, force: true }).catch(() => {});
  }

  return { kept: Math.min(backups.length, keep), removed };
}

/** List existing backups, newest first (for inspection / manual restore). */
export async function listBackups(): Promise<Array<{ name: string; path: string }>> {
  const root = backupRoot();
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.startsWith(BACKUP_DIR_PREFIX))
    .sort()
    .reverse()
    .map((name) => ({ name, path: path.join(root, name) }));
}

/**
 * Boot-backup gate (audit fix #1). Run the boot snapshot only when there's no
 * backup yet OR the newest is at least half an interval old — so a burst of
 * restarts doesn't produce a full-data/ copy each time. Pure + exported for tests.
 */
export function shouldRunBootBackup(newestAgeMs: number | null, interval: number): boolean {
  return newestAgeMs === null || newestAgeMs >= interval / 2;
}

/** Age (ms) of the newest backup by mtime, or null when there are none. */
async function mostRecentBackupAgeMs(): Promise<number | null> {
  const backups = await listBackups(); // newest first
  if (backups.length === 0) return null;
  try {
    const st = await fs.stat(backups[0].path);
    return Date.now() - st.mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Operator-facing backup health (audit fix #2) — surfaced by `/api/health` so a
 * silently-stopped backup is observable instead of false safety. Cheap by
 * design: one `readdir` + one `stat`, NO recursive size walk (the health route
 * is latency-sensitive). `staleThresholdMs` lets the caller flag "backups have
 * stopped" without re-deriving the interval.
 */
export async function getBackupStatus(): Promise<{
  disabled: boolean;
  count: number;
  newestAgeMs: number | null;
  staleThresholdMs: number;
}> {
  const staleThresholdMs = intervalMs() * 2;
  if (backupDisabled()) {
    return { disabled: true, count: 0, newestAgeMs: null, staleThresholdMs };
  }
  const backups = await listBackups();
  return {
    disabled: false,
    count: backups.length,
    newestAgeMs: await mostRecentBackupAgeMs(),
    staleThresholdMs,
  };
}

declare global {
  var __orchestraBackupInterval__: NodeJS.Timeout | undefined;
}

/**
 * Install a boot backup + a recurring interval (default 24h). Idempotent via
 * `globalThis` (dev-mode HMR must not stack timers), `unref`'d so it never keeps
 * the process alive, opt-out via `ORCHESTRA_BACKUP_DISABLED=true`, and skipped
 * under the test runner so suites don't spew copies. Mirrors
 * `ensureSweepersScheduled`.
 */
export function ensureDataBackupScheduled(): void {
  if (backupDisabled()) return;
  if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") return;
  if (globalThis.__orchestraBackupInterval__) return;

  // Boot snapshot — captures state before the session does anything risky.
  // Audit fix #1: SKIP it when a recent backup already exists, so frequent
  // restarts don't thrash full-data/ copies.
  void (async () => {
    const age = await mostRecentBackupAgeMs();
    if (!shouldRunBootBackup(age, intervalMs())) return;
    await createDataBackup();
  })().catch((err) => {
    console.warn("[backup] boot backup failed (non-fatal):", err);
  });

  globalThis.__orchestraBackupInterval__ = setInterval(() => {
    void createDataBackup().catch((err) => {
      console.warn("[backup] scheduled backup failed (non-fatal):", err);
    });
  }, intervalMs());
  globalThis.__orchestraBackupInterval__.unref?.();
}
