/**
 * What happens when the stream is ABORTED rather than finished or errored.
 *
 * PM #98, second pass — found by reading the installed `ai@6` source, not by
 * reasoning about it, and it invalidated the first version of the fix.
 *
 * `streamText` treats an abort as a CLEAN CLOSE, not as a failure. In
 * `node_modules/ai/dist/index.mjs` the stream's `pull()` calls an internal
 * `abort()` which fires `onAbort({ steps })`, enqueues an `{ type: "abort" }`
 * part and closes the controller. It never calls `controller.error(...)`, and
 * `onError` is invoked ONLY for an `error` part. So on an abort:
 *
 *   - `onError` does NOT fire — no `chat-error` SSE event, no banner;
 *   - `onFinish` does NOT fire — no message persisted, no DAG finalize.
 *
 * The consequence for the watchdog is severe enough to be worth stating
 * plainly: without this module the watchdog would have converted a 640-second
 * silence into a 90-second silence. Faster, and still dishonest. The bound is
 * only half the fix; the other half is that SOMETHING has to speak afterwards.
 *
 * The same is true of a user pressing cancel — that has always ended with the
 * DAG still spinning, because nothing finalized it. Finalizing is safe and is
 * done here for both paths; the error banner is raised ONLY for a stall,
 * because a user who cancelled does not need to be told their turn failed.
 */
import { updateChat } from "@/lib/storage/chat-store";
import { publishUiSyncEvent } from "@/lib/realtime/event-bus";
import { publishOrchestratorFinished } from "@/lib/agent/agent-dag-events";
import { reportTurnError, type TurnErrorContext } from "@/lib/agent/agent-stream";
import { logStreamStall, type StreamWatchdog } from "@/lib/agent/stream-watchdog";
import { stripThinkingTags } from "@/lib/agent/agent-response";

/**
 * Accumulates streamed prose so an aborted turn can keep what the user was
 * already reading.
 *
 * WHY NOT `onAbort`'s `steps`: verified in `ai@6.0.193` — `recordedSteps.push`
 * runs ONLY inside the `finish-step` branch, so `onAbort({ steps })` contains
 * COMPLETED steps and nothing else. The in-flight step — the one that was
 * streaming when the watchdog fired, i.e. exactly the text on screen — is never
 * in it. For a single-step plain-chat turn, which is the PM #98 shape, `steps`
 * is EMPTY, so a `steps`-based implementation preserves nothing at all in the
 * one case it was written for. Three of three council models flagged this as
 * unverifiable-and-suspicious; the SDK source settles it.
 *
 * A running buffer of `text-delta` chunks covers both: completed steps' text
 * and the in-flight step's, in arrival order.
 */
export function createPartialTextBuffer(): {
  append(delta: string): void;
  text(): string;
} {
  const parts: string[] = [];
  return {
    append(delta: string) {
      if (delta) parts.push(delta);
    },
    text() {
      return parts.join("").trim();
    },
  };
}

export interface StreamAbortContext extends TurnErrorContext {
  /** `provider/model`, for the operator-facing log line. */
  model: string;
}

/**
 * Handle an aborted turn. Never throws — it runs on a path that has no other
 * error handler, so a failure here would be silent in the worst possible place.
 *
 * PERSISTING IS NOT OPTIONAL, and the reason inverts the obvious intuition.
 * `chat-panel.tsx` reconciles by REPLACEMENT — `setMessages(nextMessages)` from
 * `/api/chat/history` — not by appending. So there is no double-render risk
 * (the streamed copy is replaced, not duplicated), and conversely, NOT writing
 * here would make the next sync tick wipe the partial answer off the screen.
 * Two of three council models recommended dropping this write; following that
 * advice would have destroyed the very text the feature exists to keep.
 */
export async function handleStreamAbort(
  watchdog: StreamWatchdog,
  partialText: string,
  ctx: StreamAbortContext
): Promise<void> {
  watchdog.settle();
  const stall = watchdog.stalled;

  try {
    const partial = partialText.trim();
    if (partial) {
      const note = stall
        ? "*The provider stopped responding — this answer is incomplete.*"
        : "*Cancelled — this answer is incomplete.*";
      await updateChat(ctx.chatId, (chat) => {
        const now = new Date().toISOString();
        chat.messages.push({
          id: crypto.randomUUID(),
          role: "assistant",
          content: `${stripThinkingTags(partial)}\n\n${note}`,
          createdAt: now,
        });
        chat.updatedAt = now;
        return chat;
      });
    }
  } catch (err) {
    console.error("[Agent] failed to persist partial text on abort:", err);
  }

  if (stall) {
    logStreamStall(watchdog, {
      chatId: ctx.chatId,
      projectId: ctx.projectId,
      model: ctx.model,
    });
    // The `chat-error` event rides the SSE bus, NOT the response stream, so it
    // still reaches the UI even though the response stream has just closed.
    try {
      await reportTurnError(stall, ctx, {
        logEvent: "agent_stream_stalled",
        awaitPostmortem: false,
      });
    } catch (err) {
      console.error("[Agent] failed to report a stalled stream:", err);
    }
  }

  // PM #98 — a user pressing stop is NOT a system failure. Reporting their own
  // deliberate action as an error is the same class of lie as reporting a
  // provider stall as a cancellation; all three council models flagged it.
  publishOrchestratorFinished(
    ctx.chatId,
    ctx.projectId,
    stall ? "error" : "cancelled",
    stall ? "agent_turn_error" : "agent_turn_cancelled"
  );
  publishUiSyncEvent({
    topic: "chat",
    chatId: ctx.chatId,
    projectId: ctx.projectId ?? null,
    reason: "agent_turn_finished",
  });
}
