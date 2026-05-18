#!/usr/bin/env node
/**
 * Orchestra MCP server — gives Claude Code direct, structured access to the
 * running Orchestra instance: log tails, chat state, health probe, error
 * triage. The goal is to kill the "ask the user to run `docker logs`" loop
 * the operator and I were stuck in during the PM #15/#16/#17 incidents.
 *
 * Architecture:
 *   - Standalone Node script run via `npx tsx scripts/mcp-orchestra-server.ts`.
 *   - stdio transport (Claude Code launches it as a subprocess).
 *   - Reads `data/logs/orchestra-*.jsonl` directly (the durable sink set up
 *     by Sprint 3).
 *   - Reads `data/chats/*.json` and `data/chat-index.json` directly.
 *   - Calls `http://<host>:<port>/api/health` for the live probe.
 *
 * Configuration via env (override the defaults if your container binds
 * elsewhere or the data volume sits in a non-standard path):
 *   ORCHESTRA_DATA_DIR    — defaults to <cwd>/data
 *   ORCHESTRA_HEALTH_URL  — defaults to http://localhost:3000/api/health
 *
 * To register with Claude Code, add to `~/.claude.json` under `mcpServers`:
 *   "orchestra": {
 *     "command": "npx",
 *     "args": ["tsx", "/abs/path/to/scripts/mcp-orchestra-server.ts"]
 *   }
 *
 * See docs/observability.md for full setup + usage examples.
 *
 * Why these exact tools (and not more): each one maps to a question I
 * actually had to ask during a real incident in this repo. Speculative
 * tools (e.g. `orchestra_replay`) were intentionally cut from v1 — they
 * need extra writes to the log surface that haven't landed yet, and the
 * v1 read tools cover the entire diagnostic loop the operator and I went
 * through during PM #17.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  filterLogEntries,
  getLogFilenamesInRange,
  parseJsonlLines,
  takeLast,
  type LogEntry,
  type LogLevel,
} from "../src/lib/observability/log-query";
import {
  listPostmortems,
  loadPostmortem,
} from "../src/lib/observability/postmortem";
import {
  findSecretsInPostmortemString,
  replayPostmortem,
} from "../src/lib/observability/replay";

const DATA_DIR =
  process.env.ORCHESTRA_DATA_DIR ?? path.join(process.cwd(), "data");
const HEALTH_URL =
  process.env.ORCHESTRA_HEALTH_URL ?? "http://localhost:3000/api/health";

const LOGS_DIR = path.join(DATA_DIR, "logs");
const CHATS_DIR = path.join(DATA_DIR, "chats");
const CHAT_INDEX_FILE = path.join(DATA_DIR, "chat-index.json");

// ──────────────────────────────────────────────────────────────────
// Internal helpers — I/O wrappers around the pure log-query functions.
// ──────────────────────────────────────────────────────────────────

async function readLogFile(filename: string): Promise<LogEntry[]> {
  try {
    const text = await fs.readFile(path.join(LOGS_DIR, filename), "utf-8");
    return parseJsonlLines(text);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function loadEntriesForRange(
  sinceTs: string | undefined,
  untilTs: string | undefined
): Promise<LogEntry[]> {
  // Default window: last 24h. Matches the "I had a problem 5 minutes ago"
  // case without dragging in months of history.
  const until = untilTs ? new Date(untilTs) : new Date();
  const since = sinceTs
    ? new Date(sinceTs)
    : new Date(until.getTime() - 24 * 60 * 60 * 1000);

  const filenames = getLogFilenamesInRange(since, until);
  const all: LogEntry[] = [];
  for (const f of filenames) {
    const part = await readLogFile(f);
    all.push(...part);
  }
  return all;
}

function asTextResult(payload: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  const text =
    typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text", text }] };
}

function asErrorResult(message: string): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}

// ──────────────────────────────────────────────────────────────────
// Server + tool registry
// ──────────────────────────────────────────────────────────────────

const server = new McpServer(
  { name: "orchestra-mcp", version: "0.1.0" },
  {
    instructions:
      "Orchestra observability tools. Use orchestra_health for a quick " +
      "system check, orchestra_tail_logs to see recent activity, and " +
      "orchestra_get_trace to pull every log line for a single chat turn " +
      "(the trace id is exposed via the X-Trace-Id response header on " +
      "every chat request).",
  }
);

server.tool(
  "orchestra_health",
  "Hit the running Orchestra's /api/health endpoint and return the JSON. " +
    "Use this first when something looks broken — it reports settings, LLM " +
    "provider reachability, MCP-related subsystems, and the PM #17 " +
    "tool-call capability check.",
  {},
  async () => {
    try {
      const res = await fetch(HEALTH_URL, {
        signal: AbortSignal.timeout(5000),
      });
      const text = await res.text();
      // Try to pretty-print JSON, fall back to raw text.
      try {
        return asTextResult(JSON.parse(text));
      } catch {
        return asTextResult(text);
      }
    } catch (err) {
      return asErrorResult(
        `Failed to reach ${HEALTH_URL}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
);

server.tool(
  "orchestra_tail_logs",
  "Read the most recent structured log entries. Results are JSON entries " +
    "in chronological order (oldest first). Default window is the last 24 " +
    "hours; pass `sinceTs`/`untilTs` (ISO strings) for a wider or narrower " +
    "scope. Filter by `traceId`, `chatId`, `minLevel`, or substring match " +
    "via `contains`.",
  {
    lines: z
      .number()
      .int()
      .min(1)
      .max(2000)
      .optional()
      .describe("Max entries to return (default 200, hard cap 2000)."),
    minLevel: z
      .enum(["debug", "info", "warn", "error"])
      .optional()
      .describe("Drop anything below this level. Default: debug (all)."),
    traceId: z.string().optional(),
    chatId: z.string().optional(),
    contains: z
      .string()
      .optional()
      .describe("Case-insensitive substring matched against event + msg."),
    sinceTs: z.string().optional().describe("ISO 8601 timestamp."),
    untilTs: z.string().optional().describe("ISO 8601 timestamp."),
  },
  async ({ lines, minLevel, traceId, chatId, contains, sinceTs, untilTs }) => {
    try {
      const all = await loadEntriesForRange(sinceTs, untilTs);
      const filtered = filterLogEntries(all, {
        traceId,
        chatId,
        minLevel: minLevel as LogLevel | undefined,
        contains,
        sinceTs,
        untilTs,
      });
      const tail = takeLast(filtered, lines ?? 200);
      return asTextResult({
        count: tail.length,
        totalScanned: all.length,
        entries: tail,
      });
    } catch (err) {
      return asErrorResult(
        err instanceof Error ? err.message : String(err)
      );
    }
  }
);

server.tool(
  "orchestra_recent_errors",
  "Show recent error/warn-level log entries, newest first. Shortcut for " +
    "`orchestra_tail_logs` with `minLevel: 'warn'` and a tighter default " +
    "window (last 1 hour).",
  {
    windowHours: z
      .number()
      .min(0.1)
      .max(168)
      .optional()
      .describe("Lookback window in hours. Default 1, max 1 week."),
    lines: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe("Max entries to return (default 50, hard cap 500)."),
  },
  async ({ windowHours, lines }) => {
    try {
      const until = new Date();
      const since = new Date(
        until.getTime() - (windowHours ?? 1) * 60 * 60 * 1000
      );
      const all = await loadEntriesForRange(
        since.toISOString(),
        until.toISOString()
      );
      const filtered = filterLogEntries(all, { minLevel: "warn" });
      // Reverse so newest is first — matches what an oncall engineer wants
      // when they ask "what just broke."
      const tail = takeLast(filtered, lines ?? 50).reverse();
      return asTextResult({ count: tail.length, entries: tail });
    } catch (err) {
      return asErrorResult(
        err instanceof Error ? err.message : String(err)
      );
    }
  }
);

server.tool(
  "orchestra_get_trace",
  "Return EVERY log entry that carries the given trace id. The trace id " +
    "is per-chat-turn and is set by `POST /api/chat` (visible to the " +
    "client via the X-Trace-Id response header and the chat-error event " +
    "payload). Use this when the user reports a specific failure: ask for " +
    "the trace id, then call this tool to read the full server-side story.",
  {
    traceId: z.string().describe("UUID issued by POST /api/chat."),
    sinceDays: z
      .number()
      .int()
      .min(1)
      .max(30)
      .optional()
      .describe("Lookback in days (default 7)."),
  },
  async ({ traceId, sinceDays }) => {
    try {
      const until = new Date();
      const since = new Date(
        until.getTime() - (sinceDays ?? 7) * 24 * 60 * 60 * 1000
      );
      const all = await loadEntriesForRange(
        since.toISOString(),
        until.toISOString()
      );
      const filtered = filterLogEntries(all, { traceId });
      return asTextResult({ count: filtered.length, entries: filtered });
    } catch (err) {
      return asErrorResult(
        err instanceof Error ? err.message : String(err)
      );
    }
  }
);

server.tool(
  "orchestra_get_chat",
  "Read the on-disk JSON for a chat (the canonical state — see CLAUDE.md " +
    "§ 'Observability'). Returns the full message history. Pair this with " +
    "`orchestra_get_trace` to correlate the chat state with the server " +
    "log lines for that turn.",
  {
    chatId: z.string().describe("UUID from data/chats/<chatId>.json."),
  },
  async ({ chatId }) => {
    // Defensive sandbox: chatId is a UUID, but a malicious caller could
    // pass `../../etc/passwd`. Reject anything outside `[a-zA-Z0-9_-]`.
    if (!/^[a-zA-Z0-9_-]+$/.test(chatId)) {
      return asErrorResult(
        "chatId must match /^[a-zA-Z0-9_-]+$/ — anything else is rejected."
      );
    }
    try {
      const text = await fs.readFile(
        path.join(CHATS_DIR, `${chatId}.json`),
        "utf-8"
      );
      return asTextResult(JSON.parse(text));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return asErrorResult(`No chat file at data/chats/${chatId}.json.`);
      }
      return asErrorResult(
        err instanceof Error ? err.message : String(err)
      );
    }
  }
);

server.tool(
  "orchestra_list_chats",
  "List recent chats from the chat index, newest first. Use this when " +
    "you need to find a chatId by approximate timing or topic.",
  {
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe("Max chats to return (default 20)."),
  },
  async ({ limit }) => {
    try {
      const text = await fs.readFile(CHAT_INDEX_FILE, "utf-8");
      const all = JSON.parse(text) as Array<{
        id: string;
        title: string;
        projectId?: string;
        updatedAt: string;
        messageCount: number;
      }>;
      // chat-index.json is already newest-first per chat-store; defensive sort.
      const sorted = [...all].sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt)
      );
      return asTextResult({
        count: Math.min(sorted.length, limit ?? 20),
        chats: sorted.slice(0, limit ?? 20),
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return asTextResult({ count: 0, chats: [] });
      }
      return asErrorResult(
        err instanceof Error ? err.message : String(err)
      );
    }
  }
);

server.tool(
  "orchestra_list_postmortems",
  "List captured failure postmortems (Sprint 5 forensic snapshots, " +
    "newest first). Each entry surfaces the trace id, error kind, and a " +
    "short message. Pair with `orchestra_get_postmortem` to read the " +
    "full forensic snapshot.",
  {
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe("Max entries to return (default 50)."),
  },
  async ({ limit }) => {
    try {
      const all = await listPostmortems();
      return asTextResult({
        count: Math.min(all.length, limit ?? 50),
        postmortems: all.slice(0, limit ?? 50),
      });
    } catch (err) {
      return asErrorResult(err instanceof Error ? err.message : String(err));
    }
  }
);

server.tool(
  "orchestra_get_postmortem",
  "Read a postmortem file by trace id. Includes the sanitized request, " +
    "settings snapshot, captured raw error, classified payload, embedded " +
    "log entries scoped to the trace id, and a snapshot of the chat at " +
    "failure time. The single richest forensic artifact Orchestra " +
    "produces.",
  {
    traceId: z.string().describe("UUID issued by POST /api/chat."),
  },
  async ({ traceId }) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(traceId)) {
      return asErrorResult(
        "traceId must match /^[a-zA-Z0-9_-]+$/ — anything else is rejected."
      );
    }
    try {
      const pm = await loadPostmortem(traceId);
      if (!pm) {
        return asErrorResult(`No postmortem at data/postmortems/${traceId}.json.`);
      }
      return asTextResult(pm);
    } catch (err) {
      return asErrorResult(err instanceof Error ? err.message : String(err));
    }
  }
);

server.tool(
  "orchestra_replay_postmortem",
  "Re-run the error classifier against the captured raw error inside a " +
    "postmortem. Returns whether the classification today matches what " +
    "was recorded at dump time (any drift means the classifier changed " +
    "behavior since that incident — review). Also scans the persisted " +
    "file text for known secret shapes as a sanitizer regression guard.",
  {
    traceId: z.string().describe("UUID issued by POST /api/chat."),
  },
  async ({ traceId }) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(traceId)) {
      return asErrorResult("traceId must match /^[a-zA-Z0-9_-]+$/.");
    }
    try {
      const pm = await loadPostmortem(traceId);
      if (!pm) {
        return asErrorResult(`No postmortem at data/postmortems/${traceId}.json.`);
      }
      const replay = replayPostmortem(pm);
      const filePath = path.join(
        DATA_DIR,
        "postmortems",
        `${traceId}.json`
      );
      const raw = await fs.readFile(filePath, "utf-8");
      const secretFindings = findSecretsInPostmortemString(raw);
      return asTextResult({
        traceId,
        consistent: replay.consistent,
        drift: replay.drift,
        original: replay.original,
        reclassified: replay.reclassified,
        secretFindings,
      });
    } catch (err) {
      return asErrorResult(err instanceof Error ? err.message : String(err));
    }
  }
);

// ──────────────────────────────────────────────────────────────────
// Boot
// ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Per MCP convention: do NOT log to stdout — that's the wire. stderr is
  // free for humans-watching-the-process diagnostics.
  process.stderr.write(
    `[orchestra-mcp] connected; data=${DATA_DIR} health=${HEALTH_URL}\n`
  );
}

main().catch((err) => {
  process.stderr.write(
    `[orchestra-mcp] fatal: ${
      err instanceof Error ? err.message : String(err)
    }\n`
  );
  process.exit(1);
});
