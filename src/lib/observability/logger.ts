/**
 * Structured logger for Orchestra. Emits one JSON line per event to stdout
 * (where Docker's log driver captures it) and additionally appends to a
 * rolling JSONL file at `data/logs/orchestra-YYYY-MM-DD.jsonl` for offline
 * `jq` queries.
 *
 * Design — what this is and isn't:
 *   - It IS the single source of truth for structured logs going forward.
 *     Every NEW logging callsite added to the codebase MUST use it.
 *   - It is NOT a `console.*` replacement campaign. Existing
 *     `console.error/log/warn` are migrated incrementally; the JSON output
 *     of this module is a STRICT SUPERSET of the old free-text output, so
 *     `docker logs` keeps working for code that hasn't been migrated.
 *   - It has zero external deps (no winston, no pino) — a 130-line file
 *     beats a third-party log lib for an app this size, and the JSON shape
 *     is OUR shape, not someone else's.
 *
 * Trace-id propagation:
 *   `withContext({ traceId, chatId, ... }, fn)` pushes a context onto the
 *   AsyncLocalStorage store; every `log.*` call inside `fn` (and any awaits
 *   it spawns) attaches those fields automatically. Use `withContext` at
 *   the API entry point (`POST /api/chat`); downstream code never has to
 *   thread `traceId` through arguments.
 *
 * Secret redaction:
 *   We deny-list known field names (`apiKey`, `passwordHash`, `token`, etc.)
 *   at emit time. Defense-in-depth — callers should not log these in the
 *   first place, but a single typo shouldn't ship hashes to the log file.
 *
 * Why a JSONL file in addition to stdout:
 *   `docker logs` rotates and is text-only. The file is jq-friendly and
 *   survives `docker compose down`; it sits inside the persistent
 *   `./data:/app/data` volume. The Sprint-4 MCP server (see
 *   `docs/observability.md` after it lands) reads from this file.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  /** Per-chat-turn correlation id (`POST /api/chat` issues one per call). */
  traceId?: string;
  chatId?: string;
  projectId?: string;
  /** The exporting subsystem (e.g. "moa", "agent", "auth", "fs"). Optional. */
  module?: string;
}

interface LogEntry extends LogContext {
  ts: string;
  level: LogLevel;
  event: string;
  msg?: string;
  /** Stack trace if a serialized error was passed in. */
  stack?: string;
  // Arbitrary structured fields go here. Strings, numbers, bools, null.
  [key: string]: unknown;
}

const als = new AsyncLocalStorage<LogContext>();

/**
 * Field names whose values are ALWAYS replaced with `"[REDACTED]"` before
 * a log line leaves the process. This is a safety net — never the primary
 * defense. Keep the list short and security-relevant.
 */
// Stored as lowercase — the lookup `REDACTED_KEYS.has(k.toLowerCase())`
// then matches `APIKey`, `Api_Key`, `apiKey`, etc. uniformly. Mixed-case
// entries here would silently fail to match camelCase callers.
const REDACTED_KEYS = new Set<string>([
  "apikey",
  "api_key",
  "passwordhash",
  "password_hash",
  "password",
  "passwd",
  "token",
  "secret",
  "authorization",
  "bearer",
  "cookie",
  "set-cookie",
  // Sprint 5 — fill the gaps that PM #28's `scrubProcessEnv` already
  // recognised at the env-var boundary but the logger was silent on.
  // Each name is matched as a whole key (lowercased), so `XApiKey` →
  // `xapikey` doesn't fire — be explicit with the header variants we
  // actually see in HTTP / MCP / provider integrations.
  "x-api-key",
  "x-token",
  "x-auth-token",
  "x-access-token",
  "credential",
  "credentials",
  "private",
  "private_key",
  "privatekey",
]);

function redact(fields: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!fields) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (REDACTED_KEYS.has(k.toLowerCase())) {
      out[k] = "[REDACTED]";
      continue;
    }
    if (v instanceof Error) {
      out[k] = v.message;
      // Preserve stack as a top-level field on the first Error we see.
      if (!("stack" in out) && v.stack) out.stack = v.stack;
      continue;
    }
    out[k] = v;
  }
  return out;
}

/**
 * Append-only rolling JSONL file. We only open the stream lazily (so
 * importing this module in a vitest worker doesn't touch the filesystem).
 * One file per UTC date; rotation happens on write when the date changes.
 */
let fileStream: fs.WriteStream | null = null;
let fileStreamDate: string | null = null;
let fileStreamDisabled = false;

function getDayKey(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function ensureFileStream(): fs.WriteStream | null {
  if (fileStreamDisabled) return null;
  // Tests, scripts, and other non-app contexts should not write to disk.
  // The `ORCHESTRA_LOG_TO_FILE=1` opt-in keeps them quiet by default and
  // production opt-IN-explicit; the Dockerfile sets the env.
  if (process.env.ORCHESTRA_LOG_TO_FILE !== "1") return null;

  const today = getDayKey();
  if (fileStream && fileStreamDate === today) return fileStream;

  try {
    const dir = path.join(process.cwd(), "data", "logs");
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `orchestra-${today}.jsonl`);
    fileStream?.end();
    fileStream = fs.createWriteStream(filePath, { flags: "a" });
    fileStreamDate = today;
    return fileStream;
  } catch {
    // First failure disables the file sink for this process. We do NOT
    // throw — logging must never break the request path. Operators see
    // the JSON on stdout regardless.
    fileStreamDisabled = true;
    return null;
  }
}

function emit(level: LogLevel, event: string, fields?: Record<string, unknown>): void {
  const ctx = als.getStore() ?? {};
  const safeFields = redact(fields);

  const line: LogEntry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...ctx,
    ...safeFields,
  };

  // Cycle-safe stringify: falls back to a `[Circular]` marker rather than
  // throwing if a caller hands us a cyclic structure (Error chains, Vercel
  // SDK request bodies that re-reference the original Request, etc).
  // Logging must NEVER throw — that turns a bad log line into a crashed
  // request handler.
  let serialized: string;
  try {
    serialized = JSON.stringify(line);
  } catch {
    const seen = new WeakSet<object>();
    serialized = JSON.stringify(line, (_key, value) => {
      if (typeof value === "object" && value !== null) {
        if (seen.has(value as object)) return "[Circular]";
        seen.add(value as object);
      }
      return value;
    });
  }

  // stdout: always — Docker captures it. Use the level-appropriate stream
  // so `docker logs` color-codes errors when configured to.
  const out = level === "error" || level === "warn" ? process.stderr : process.stdout;
  out.write(serialized + "\n");

  const file = ensureFileStream();
  if (file) {
    // Best-effort: drop a write rather than block the request path.
    // The `write` callback would surface backpressure errors — we
    // intentionally swallow them here for the same reason `safeWriteFile`
    // doesn't crash the request on disk-full conditions.
    file.write(serialized + "\n", () => { /* drop */ });
  }
}

/**
 * Run `fn` with a logging context. All `log.*` calls emitted from inside
 * `fn` (synchronous or via awaited promises) carry the context fields
 * automatically. Nested `withContext` calls merge — children inherit
 * parent fields and override on key collision.
 *
 * Use at API entrypoints to pin a per-request `traceId`, `chatId`, etc.
 */
export function withLogContext<T>(ctx: LogContext, fn: () => T): T {
  const merged: LogContext = { ...(als.getStore() ?? {}), ...ctx };
  return als.run(merged, fn);
}

/** Returns the current trace-id from AsyncLocalStorage, if any. */
export function getCurrentTraceId(): string | undefined {
  return als.getStore()?.traceId;
}

export const log = {
  debug: (event: string, fields?: Record<string, unknown>) => emit("debug", event, fields),
  info: (event: string, fields?: Record<string, unknown>) => emit("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit("error", event, fields),
};

/**
 * Test-only: wipe the file stream so tests can be deterministic about
 * what's been written. Production callers never need this.
 */
export function __resetFileStreamForTests(): void {
  fileStream?.end();
  fileStream = null;
  fileStreamDate = null;
  fileStreamDisabled = false;
}
