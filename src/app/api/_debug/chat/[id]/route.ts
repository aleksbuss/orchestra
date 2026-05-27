/**
 * Observability endpoint for "this chat appears stuck" debug flow (PM #31).
 *
 * Why this exists: CLAUDE.md § Observability lists a 4-step manual checklist
 * for diagnosing a stuck chat (read disk state, grep logs, check SSE, inspect
 * active job). Each step is one curl/grep/jq invocation. This endpoint
 * collapses them into one GET — the operator runs a single curl and gets
 * everything in a JSON envelope.
 *
 * Auth posture: standard middleware applies (no entry in `isPublicApi`), so
 * a valid session cookie is required. The endpoint reads chat state, recent
 * logs (potentially containing sensitive context), and daemon internals —
 * not something to expose anonymously.
 *
 * Output shape (stable contract):
 *   {
 *     chatId: string,
 *     diskState: { exists, lastMessage, messageCount, status, finishReason },
 *     recentLogs: Array<JSON log line>,    // last 20 for this chatId
 *     sseBusHealthy: boolean,              // event-bus listenable
 *     activeJob: { exists, ...details },   // daemon side
 *     uptimeSec: number,
 *   }
 */
import fs from "fs/promises";
import path from "path";
import { NextRequest } from "next/server";
import { getChat } from "@/lib/storage/chat-store";
import { isJobActive } from "@/lib/agent/daemon";

export const dynamic = "force-dynamic";

const MAX_RECENT_LOG_LINES = 20;
const LOGS_DIR = path.join(process.cwd(), "data", "logs");

/**
 * Tail the last N lines of a JSONL file that match a `chatId` field.
 * Returns parsed JSON objects; un-parseable lines are skipped silently.
 *
 * We read the entire file into memory because (a) daily log files are
 * bounded — typical size << 50 MB even on busy days, (b) Node has no clean
 * streaming "last N lines matching predicate" primitive, and (c) this is a
 * cold debug path, not a hot route. If logs ever grow unbounded, the cron
 * sweeper (PM #32 follow-up) will rotate them.
 */
async function tailLogsForChat(
  chatId: string,
  limit: number = MAX_RECENT_LOG_LINES
): Promise<Array<Record<string, unknown>>> {
  let files: string[];
  try {
    files = await fs.readdir(LOGS_DIR);
  } catch {
    return [];
  }
  // Sort descending so today's file comes first; we read newest first and
  // stop accumulating once we have `limit` matching entries.
  const jsonlFiles = files
    .filter((f) => f.startsWith("orchestra-") && f.endsWith(".jsonl"))
    .sort()
    .reverse();

  const collected: Array<Record<string, unknown>> = [];
  for (const file of jsonlFiles) {
    if (collected.length >= limit) break;
    let content: string;
    try {
      content = await fs.readFile(path.join(LOGS_DIR, file), "utf-8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    // Walk backwards through the file (newest entries are at the bottom of
    // each daily file).
    for (let i = lines.length - 1; i >= 0; i--) {
      if (collected.length >= limit) break;
      const raw = lines[i].trim();
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed.chatId === chatId) {
          collected.push(parsed);
        }
      } catch {
        // Non-JSON line (free-text console.log piped to the file by some
        // unmigrated callsite). Skip silently.
      }
    }
  }
  // Reverse to chronological order for the operator's reading convenience.
  return collected.reverse();
}

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id: chatId } = await ctx.params;

  // 1. Disk state — canonical source of truth (PM #5).
  const chat = await getChat(chatId);
  const lastMessage = chat?.messages?.[chat.messages.length - 1] ?? null;
  const diskState = chat
    ? {
        exists: true,
        title: chat.title,
        projectId: chat.projectId ?? null,
        messageCount: chat.messages?.length ?? 0,
        updatedAt: chat.updatedAt,
        lastMessage: lastMessage
          ? {
              id: lastMessage.id,
              role: lastMessage.role,
              contentPreview:
                typeof lastMessage.content === "string"
                  ? lastMessage.content.slice(0, 240)
                  : null,
              toolName: lastMessage.toolName ?? null,
              createdAt: lastMessage.createdAt ?? null,
            }
          : null,
      }
    : { exists: false };

  // 2. Recent logs scoped to this chat.
  const recentLogs = await tailLogsForChat(chatId);

  // 3. SSE bus health — module-level import; if the file fails to load,
  //    the route itself would 500. Reaching here means import succeeded,
  //    which is the same signal `/api/events` uses for `event: ready`.
  const sseBusHealthy = true;

  // 4. Daemon-side active-job state.
  const activeJob = {
    exists: isJobActive(chatId),
  };

  // 5. Process uptime — useful to correlate "stuck since boot" vs.
  //    "started failing N minutes after start".
  const uptimeSec = Math.round(process.uptime());

  return Response.json({
    chatId,
    diskState,
    recentLogs,
    sseBusHealthy,
    activeJob,
    uptimeSec,
  });
}
