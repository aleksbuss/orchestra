/**
 * Pure helpers for querying the structured-log JSONL files.
 *
 * The MCP server in `scripts/mcp-orchestra-server.ts` uses these to expose
 * `orchestra_tail_logs`, `orchestra_get_trace`, etc. to Claude Code. We
 * keep them pure (zero I/O, zero `console.*`) so vitest can pin every
 * filter rule without spinning up a server or mocking the filesystem.
 *
 * The file format is one JSON object per line, written by
 * `src/lib/observability/logger.ts`. Each line carries at minimum
 * `{ts, level, event}`; many also carry `traceId`, `chatId`, `projectId`,
 * `module`, and arbitrary additional fields. Malformed lines are skipped
 * silently — log files are append-only and a torn line at the tail is
 * normal during a crash.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  event: string;
  msg?: string;
  traceId?: string;
  chatId?: string;
  projectId?: string;
  module?: string;
  // Open shape — callers may carry arbitrary fields.
  [key: string]: unknown;
}

/**
 * Parse a JSONL string into LogEntry objects, dropping malformed lines.
 *
 * The parser is intentionally permissive — it doesn't enforce the LogEntry
 * shape beyond a sanity check on `ts` + `level` + `event`. A future
 * schema-tightening should add a Zod validator here, but the current
 * caller (the MCP server) values robustness over strictness: a single
 * corrupted line should not blank an entire `tail_logs` response.
 */
export function parseJsonlLines(text: string): LogEntry[] {
  if (!text) return [];
  const out: LogEntry[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as Partial<LogEntry>;
      if (
        typeof parsed.ts !== "string" ||
        typeof parsed.level !== "string" ||
        typeof parsed.event !== "string"
      ) {
        continue;
      }
      // Validate `level` against the closed set so a future widening of the
      // type doesn't silently flow into the MCP API surface.
      if (!["debug", "info", "warn", "error"].includes(parsed.level)) continue;
      out.push(parsed as LogEntry);
    } catch {
      // Torn line at tail-of-file or partially-flushed write; skip.
    }
  }
  return out;
}

export interface LogFilterOptions {
  /** Filter to a single trace id (preferred when investigating one turn). */
  traceId?: string;
  /** Filter to a single chat id. */
  chatId?: string;
  /**
   * Minimum level to keep. `"warn"` returns warn + error; `"error"` returns
   * error only. `"debug"` (default) returns everything.
   */
  minLevel?: LogLevel;
  /** Substring (case-insensitive) any entry's `event` or `msg` must contain. */
  contains?: string;
  /** ISO timestamp; entries strictly older than this are dropped. */
  sinceTs?: string;
  /** ISO timestamp; entries strictly newer than this are dropped. */
  untilTs?: string;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Apply the filter set to a parsed entry list. Returned in input order
 * (no sort) — caller is responsible for any presentation ordering.
 */
export function filterLogEntries(
  entries: LogEntry[],
  opts: LogFilterOptions = {}
): LogEntry[] {
  const minLevel = LEVEL_ORDER[opts.minLevel ?? "debug"];
  const containsLower = opts.contains?.toLowerCase();

  return entries.filter((e) => {
    if (opts.traceId && e.traceId !== opts.traceId) return false;
    if (opts.chatId && e.chatId !== opts.chatId) return false;
    if (LEVEL_ORDER[e.level] < minLevel) return false;
    if (opts.sinceTs && e.ts < opts.sinceTs) return false;
    if (opts.untilTs && e.ts > opts.untilTs) return false;
    if (containsLower) {
      const haystack = `${e.event} ${e.msg ?? ""}`.toLowerCase();
      if (!haystack.includes(containsLower)) return false;
    }
    return true;
  });
}

/**
 * Day-key (UTC YYYY-MM-DD) of the file the logger would write to right now.
 * Pure (no I/O) so tests can control time via `Date.now()` mocks.
 */
export function getLogDayKey(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Compute the list of `orchestra-YYYY-MM-DD.jsonl` filenames that cover
 * `[since, until]` inclusive. Used by the MCP server to know which files
 * to glob for a `recent_errors(window)` query that may straddle midnight.
 */
export function getLogFilenamesInRange(since: Date, until: Date): string[] {
  if (since.getTime() > until.getTime()) return [];
  const days: string[] = [];
  const cursor = new Date(
    Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate())
  );
  const end = new Date(
    Date.UTC(until.getUTCFullYear(), until.getUTCMonth(), until.getUTCDate())
  );
  while (cursor.getTime() <= end.getTime()) {
    days.push(`orchestra-${getLogDayKey(cursor)}.jsonl`);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    // Safety cap — ranges of more than 365 days are almost certainly bugs,
    // and reading 365 files into memory is the kind of mistake we'd rather
    // surface as a fast failure than a slow OOM.
    if (days.length > 365) break;
  }
  return days;
}

/**
 * Trim a list to the last `n` entries (most-recent at the end, the way
 * a `tail` command would render it). Stable — preserves input order
 * within the trailing window.
 */
export function takeLast<T>(items: T[], n: number): T[] {
  if (n <= 0) return [];
  if (items.length <= n) return items;
  return items.slice(items.length - n);
}
