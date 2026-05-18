/**
 * Postmortem auto-dump (Sprint 5).
 *
 * On every agent failure (streamText `onError` callback or the outer fatal
 * catch in `runAgent`), we write a single self-contained JSON file to
 * `data/postmortems/<traceId>.json`. The file carries everything an
 * investigator (or replay harness) needs to reproduce and classify the
 * failure later, with no log-grep dance:
 *
 *   - The sanitized request shape (user message, project, swarm flags).
 *   - A *sanitized* settings snapshot — secrets stripped, every other
 *     field intact so model config is reproducible.
 *   - The classifier output (kind, recoverable, hint).
 *   - A bounded slice of structured-log entries that share the trace id.
 *   - A snapshot of `data/chats/<chatId>.json` at failure time.
 *
 * The dump is best-effort: it MUST NOT throw on its own writes (a failed
 * dump must never replace a successful chat-error event with a 500).
 *
 * Storage policy: postmortems live under `data/postmortems/`, which is
 * already inside the gitignored `data/` directory. They contain user
 * prompts, so treat them like any other chat content. The `npm run
 * scrub:secrets` script handles only `data/settings/`; postmortems
 * are user data, not credentials.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { AppSettings } from "@/lib/types";
import type { ChatErrorPayload } from "@/lib/realtime/types";
import { assertPathInside, safeWriteFile } from "@/lib/storage/fs-utils";
import {
  filterLogEntries,
  getLogFilenamesInRange,
  parseJsonlLines,
  takeLast,
  type LogEntry,
} from "@/lib/observability/log-query";

/** On-disk schema version. Bump when the shape changes incompatibly. */
export const POSTMORTEM_SCHEMA_VERSION = 1;

/** Cap on log entries embedded per postmortem. Prevents the file from
 *  growing into the megabytes for chats with very chatty tools. */
const MAX_LOG_ENTRIES = 200;

/** Cap on chat-state size embedded per postmortem (chars of the JSON
 *  string). Larger chats degrade to a metadata stub rather than a full
 *  embed — investigators can fetch the full chat via `orchestra_get_chat`. */
const MAX_CHAT_EMBED_BYTES = 250_000;

const TRACE_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

export interface PostmortemRequestSnapshot {
  /** The user-supplied message, untouched. */
  userMessage: string;
  /** Whether Swarm/MoA was enabled for this turn. */
  swarmEnabled: boolean;
  /** Preset tier used (legacy field; kept for completeness). */
  preset?: string;
  /** Active project at request time. */
  projectId?: string;
  /** File-tree path the agent was scoped to (project explorer state). */
  currentPath?: string;
}

export interface PostmortemSettingsSnapshot {
  chatModel: { provider: string; model: string };
  utilityModel: { provider: string; model: string };
  embeddingsModel: { provider: string; model: string };
  /** Key presence only — never the values. Useful to know "key was set"
   *  without leaking it. */
  providerApiKeysPresent: string[];
  /** Same model-level presence flag for the inline chatModel.apiKey. */
  chatModelApiKeyPresent: boolean;
  /** Pass-through of settings.search.provider — search routing matters
   *  for some failure modes (Tavily quota etc.). */
  searchProvider?: string;
}

export interface PostmortemFile {
  schemaVersion: number;
  traceId: string;
  ts: string; // ISO of when the dump was written
  chatId: string;
  projectId?: string;
  request: PostmortemRequestSnapshot;
  settings: PostmortemSettingsSnapshot;
  errorClassification: ChatErrorPayload;
  /** The raw error message + stack — these may contain secrets in cause
   *  chains, but they live behind the same gitignore that protects every
   *  user prompt; trade-off documented in the JSDoc above. */
  rawError: { message: string; stack?: string; name?: string };
  /** Up to MAX_LOG_ENTRIES recent log entries scoped to this trace id. */
  logs: LogEntry[];
  /** Snapshot of `data/chats/<chatId>.json` at failure time, or null if
   *  the file was missing / oversize. */
  chatSnapshot: unknown | null;
  /** Reason chatSnapshot is null, when it is. Helpful for triage. */
  chatSnapshotOmittedReason?:
    | "missing"
    | "oversize"
    | "read_error";
}

/**
 * Strip secrets from a settings object before writing it into a
 * postmortem file. We deliberately list what to KEEP rather than what to
 * drop — additive-by-default for a security-sensitive surface.
 */
export function sanitizeSettingsForPostmortem(
  settings: AppSettings
): PostmortemSettingsSnapshot {
  return {
    chatModel: {
      provider: settings.chatModel.provider,
      model: settings.chatModel.model,
    },
    utilityModel: {
      provider: settings.utilityModel.provider,
      model: settings.utilityModel.model,
    },
    embeddingsModel: {
      provider: settings.embeddingsModel.provider,
      model: settings.embeddingsModel.model,
    },
    providerApiKeysPresent: Object.entries(settings.providerApiKeys ?? {})
      .filter(([, v]) => Boolean(v))
      .map(([k]) => k),
    chatModelApiKeyPresent: Boolean(settings.chatModel.apiKey),
    searchProvider: settings.search?.provider,
  };
}

function postmortemDir(): string {
  return path.join(process.cwd(), "data", "postmortems");
}

function postmortemPath(traceId: string): string {
  if (!TRACE_ID_REGEX.test(traceId)) {
    throw new Error(`traceId must match /^[a-zA-Z0-9_-]+$/`);
  }
  return assertPathInside(postmortemDir(), `${traceId}.json`);
}

async function readChatSnapshot(
  chatId: string
): Promise<{ snapshot: unknown | null; reason?: PostmortemFile["chatSnapshotOmittedReason"] }> {
  if (!TRACE_ID_REGEX.test(chatId)) {
    return { snapshot: null, reason: "missing" };
  }
  try {
    const chatPath = path.join(process.cwd(), "data", "chats", `${chatId}.json`);
    const raw = await fs.readFile(chatPath, "utf-8");
    if (raw.length > MAX_CHAT_EMBED_BYTES) {
      return { snapshot: null, reason: "oversize" };
    }
    return { snapshot: JSON.parse(raw) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { snapshot: null, reason: "missing" };
    }
    return { snapshot: null, reason: "read_error" };
  }
}

async function readTraceLogs(
  traceId: string,
  windowDays = 2
): Promise<LogEntry[]> {
  const logsDir = path.join(process.cwd(), "data", "logs");
  const until = new Date();
  const since = new Date(until.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const filenames = getLogFilenamesInRange(since, until);

  const all: LogEntry[] = [];
  for (const f of filenames) {
    try {
      const text = await fs.readFile(path.join(logsDir, f), "utf-8");
      all.push(...parseJsonlLines(text));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      // Other read errors aren't fatal — postmortem dump must never throw.
    }
  }

  return takeLast(filterLogEntries(all, { traceId }), MAX_LOG_ENTRIES);
}

function summarizeError(err: unknown): PostmortemFile["rawError"] {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
    };
  }
  return { message: typeof err === "string" ? err : JSON.stringify(err) };
}

export interface DumpPostmortemInput {
  traceId: string;
  chatId: string;
  projectId?: string;
  request: PostmortemRequestSnapshot;
  settings: AppSettings;
  errorClassification: ChatErrorPayload;
  err: unknown;
}

/**
 * Best-effort write of a postmortem file. Returns the path on success,
 * `null` on any failure. Never throws.
 */
export async function dumpPostmortem(
  input: DumpPostmortemInput
): Promise<string | null> {
  try {
    if (!TRACE_ID_REGEX.test(input.traceId)) return null;
    if (!TRACE_ID_REGEX.test(input.chatId)) return null;

    const dir = postmortemDir();
    await fs.mkdir(dir, { recursive: true });

    const filePath = postmortemPath(input.traceId);
    const { snapshot, reason } = await readChatSnapshot(input.chatId);
    const logs = await readTraceLogs(input.traceId);

    const file: PostmortemFile = {
      schemaVersion: POSTMORTEM_SCHEMA_VERSION,
      traceId: input.traceId,
      ts: new Date().toISOString(),
      chatId: input.chatId,
      projectId: input.projectId,
      request: input.request,
      settings: sanitizeSettingsForPostmortem(input.settings),
      errorClassification: input.errorClassification,
      rawError: summarizeError(input.err),
      logs,
      chatSnapshot: snapshot,
      chatSnapshotOmittedReason: reason,
    };

    await safeWriteFile(filePath, JSON.stringify(file, null, 2));
    return filePath;
  } catch {
    // Postmortem dump must not propagate failures; we'd rather lose the PM
    // than turn a chat-error response into a 500.
    return null;
  }
}

/**
 * Read a postmortem file by trace id. Returns null on missing/malformed
 * files; never throws.
 */
export async function loadPostmortem(
  traceId: string
): Promise<PostmortemFile | null> {
  if (!TRACE_ID_REGEX.test(traceId)) return null;
  try {
    const text = await fs.readFile(postmortemPath(traceId), "utf-8");
    const parsed = JSON.parse(text) as PostmortemFile;
    return parsed;
  } catch {
    return null;
  }
}

export interface PostmortemListEntry {
  traceId: string;
  ts: string;
  chatId: string;
  kind: string;
  message: string;
}

/**
 * Lightweight index of all postmortem files. Reads each file just enough
 * to surface the front-page metadata (trace id, time, error kind) for an
 * MCP tool / UI listing.
 */
export async function listPostmortems(): Promise<PostmortemListEntry[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(postmortemDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const out: PostmortemListEntry[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const traceId = name.replace(/\.json$/, "");
    if (!TRACE_ID_REGEX.test(traceId)) continue;
    const pm = await loadPostmortem(traceId);
    if (!pm) continue;
    out.push({
      traceId: pm.traceId,
      ts: pm.ts,
      chatId: pm.chatId,
      kind: pm.errorClassification.kind,
      message: pm.errorClassification.message,
    });
  }
  // Newest first.
  out.sort((a, b) => b.ts.localeCompare(a.ts));
  return out;
}
