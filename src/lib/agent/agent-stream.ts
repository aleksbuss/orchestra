import type { AppSettings } from "@/lib/types";
import type { ChatErrorPayload } from "@/lib/realtime/types";
import { publishChatErrorEvent } from "@/lib/realtime/event-bus";
import { classifyChatError } from "@/lib/observability/classify-error";
import { getCurrentTraceId, log } from "@/lib/observability/logger";
import { dumpPostmortem } from "@/lib/observability/postmortem";
import { updateChat } from "@/lib/storage/chat-store";

/**
 * §10 agent.ts decomposition — the agent-stream error-reporting seam.
 *
 * The interactive `runAgent` reports a failed turn from TWO places with
 * near-identical plumbing: the `streamText` `onError` callback (the stream
 * itself errored mid-flight) and the outer fatal `catch` (setup/build threw
 * before/around the stream). Both must: classify the error, emit a structured
 * log line carrying the trace-id, publish a `chat-error` SSE event so the UI
 * renders something actionable (PM #17 — the path that once left the user
 * staring at a blank pane), and dump a forensic postmortem (Sprint 5).
 *
 * They differed ONLY in their tails — `onError` kicks off background model-
 * fallback then finalizes the DAG; the fatal catch awaits the postmortem, runs
 * `mcpCleanup`, emits a swarm "error" node, and rethrows. Consolidating the
 * shared core means the two paths can no longer drift apart — and drift here is
 * exactly the PM #17 failure mode (one path surfaces the error, the other goes
 * silent). The previously-untested core now has a focused test
 * ([`agent-stream.test.ts`](./agent-stream.test.ts)).
 */

/** Forensic request snapshot for the postmortem — derived from `dumpPostmortem`
 *  so it stays type-compatible without re-declaring the shape. */
type PostmortemRequest = Parameters<typeof dumpPostmortem>[0]["request"];

export interface TurnErrorContext {
  chatId: string;
  // `runAgent` passes `options.projectId` (string | undefined). Kept exactly that
  // wide so it threads straight into dumpPostmortem (which rejects `null`).
  projectId: string | undefined;
  request: PostmortemRequest;
  settings: AppSettings;
}

/**
 * Classify a failed turn, emit the structured log line + `chat-error` SSE event,
 * and dump a forensic postmortem. Returns the classified payload so the caller
 * can run its path-specific tail (fallback / rethrow / DAG node). Never throws.
 *
 * @param logEvent          structured log event name — `"agent_stream_error"`
 *                          for the live stream's `onError`, `"agent_fatal_error"`
 *                          for the outer fatal catch.
 * @param awaitPostmortem   the fatal-catch path awaits the dump (it's inside a
 *                          try/catch before a rethrow); the `onError` path
 *                          fire-and-forgets so a slow dump can't stall the SSE
 *                          stream.
 */
export async function reportTurnError(
  error: unknown,
  ctx: TurnErrorContext,
  { logEvent, awaitPostmortem }: { logEvent: string; awaitPostmortem: boolean }
): Promise<ChatErrorPayload> {
  const payload = classifyChatError(error, getCurrentTraceId());
  log.error(logEvent, {
    chatId: ctx.chatId,
    projectId: ctx.projectId,
    kind: payload.kind,
    message: payload.message,
    err: error instanceof Error ? error : new Error(String(error)),
  });
  publishChatErrorEvent({
    chatId: ctx.chatId,
    projectId: ctx.projectId,
    payload,
  });

  // Post-review (protake council, 2026-08-31) — the SSE event above is
  // live-only: a user who isn't watching at the exact moment a turn dies (a
  // free-tier retry ladder alone can run 20-30s) reloads to their last message
  // and total silence, indistinguishable from Orchestra never having received
  // it. `abort` is excluded — a user cancellation is an expected outcome, not a
  // failure that needs a chat bubble. Best-effort: never let a failed persist
  // turn this error-reporting path into a throw.
  if (payload.kind !== "abort") {
    try {
      await updateChat(ctx.chatId, (chat) => {
        const now = new Date().toISOString();
        chat.messages.push({
          id: crypto.randomUUID(),
          role: "assistant",
          content:
            `⚠️ **Turn failed:** ${payload.message}${payload.hint ? `\n\n${payload.hint}` : ""}` +
            // The hint frequently reads "check the server log for trace id" —
            // pointless if the trace id isn't actually included (operator had
            // to fish it out of stdout by hand the first time this shipped).
            (payload.traceId ? `\n\n\`traceId: ${payload.traceId}\`` : ""),
          createdAt: now,
        });
        chat.updatedAt = now;
        return chat;
      });
    } catch (err) {
      console.error(
        "[agent-stream] failed to persist the turn-error message:",
        err instanceof Error ? err.message : err
      );
    }
  }

  const traceId = getCurrentTraceId();
  if (traceId) {
    const dump = dumpPostmortem({
      traceId,
      chatId: ctx.chatId,
      projectId: ctx.projectId,
      request: ctx.request,
      settings: ctx.settings,
      errorClassification: payload,
      err: error,
    });
    if (awaitPostmortem) {
      // dumpPostmortem already swallows internally; this catch is belt-and-
      // braces against a future regression of that no-throw contract.
      try {
        await dump;
      } catch {
        /* non-fatal */
      }
    } else {
      void dump.catch(() => undefined);
    }
  }
  return payload;
}
