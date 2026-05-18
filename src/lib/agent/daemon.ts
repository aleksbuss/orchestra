import { runAgent } from "./agent";
import { updateChat } from "@/lib/storage/chat-store";
import { publishUiSyncEvent } from "@/lib/realtime/event-bus";
import type { ChatMessage } from "@/lib/types";
import type { PresetTier } from "@/lib/agent/presets";
import { getActiveGoal } from "@/lib/storage/goal-store";
import type { GoalTask } from "@/lib/types";
import { enqueueJob, dequeueJob } from "@/lib/storage/queue-store";

export interface AgentJobPayload {
  chatId: string;
  userMessage: string;
  projectId?: string;
  currentPath?: string;
  swarmEnabled?: boolean;
  preset?: PresetTier;
}

/* ─── Abort Registry ─── */
const activeJobs = new Map<string, AbortController>();

/** Tracks how many auto-pilot iterations have run per chat to prevent runaway loops. */
const autoPilotIterations = new Map<string, number>();
const MAX_AUTO_PILOT_ITERATIONS = 50;

/**
 * Pending auto-pilot setTimeout handles, keyed by chatId. We store these so
 * `abortJob` can cancel a queued next-iteration BEFORE it fires — without
 * this, an abort during the backoff window still kicks off another billing
 * iteration on resume. See POST_MORTEMS.md PM #7.
 */
const autoPilotTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

function clearAutoPilotTimeout(chatId: string): void {
  const timer = autoPilotTimeouts.get(chatId);
  if (timer) {
    clearTimeout(timer);
    autoPilotTimeouts.delete(chatId);
  }
}

/**
 * Internal accessor for the auto-pilot timeouts Map. Used ONLY by
 * `daemon.testing.ts` to expose a narrow surface for PM #7 regression
 * coverage. The leading-underscore name makes every misuse easy to spot
 * in code review (`grep __getAutoPilotTimeoutsForTesting src/`); every
 * legitimate caller lives in a `*.testing.ts` file.
 */
export function __getAutoPilotTimeoutsForTesting(): Map<
  string,
  ReturnType<typeof setTimeout>
> {
  return autoPilotTimeouts;
}

/** Check if a job is currently running for a given chatId */
export function isJobActive(chatId: string): boolean {
  return activeJobs.has(chatId);
}

/** Abort a running background job by chatId. Returns true if a job was found and aborted. */
export function abortJob(chatId: string): boolean {
  const controller = activeJobs.get(chatId);
  // Always cancel any queued auto-pilot next-iteration, even if the
  // primary controller is gone — protects against the abort-during-backoff
  // window described in PM #7.
  clearAutoPilotTimeout(chatId);
  // Drop the iteration counter on abort: a subsequent resume should start
  // from a fresh budget, not inherit the count from the cancelled run.
  // Without this, the Map grows unbounded for chats that were aborted but
  // never resumed (bounded leak, but architecturally untidy).
  autoPilotIterations.delete(chatId);
  if (controller) {
    controller.abort();
    activeJobs.delete(chatId);
    publishUiSyncEvent({
      topic: "chat",
      chatId,
      reason: "[Daemon] Background job was cancelled by user.",
    });
    return true;
  }
  return false;
}

/**
 * Dispatches an agent execution to run asynchronously in the background.
 * This is crucial for local LLMs that may take hours to complete complex tasks.
 */
export async function dispatchAgentJob(options: AgentJobPayload) {
  // Cancel any previous job on the same chat
  abortJob(options.chatId);
  // Reset auto-pilot counter when user explicitly starts a new job
  if (!options.userMessage.startsWith("System [Auto-Pilot]")) {
    autoPilotIterations.delete(options.chatId);
  }

  const controller = new AbortController();
  activeJobs.set(options.chatId, controller);

  // Enqueue job for persistence across server restarts
  await enqueueJob(options);

  // Fire and forget: Do not await this Promise
  runBackgroundJob(options, controller.signal)
    .catch((err) => {
      if (err?.name !== "AbortError") {
        console.error(`[Daemon] Job ${options.chatId} failed catastrophically:`, err);
      }
    })
    .finally(() => {
      activeJobs.delete(options.chatId);
      dequeueJob(options.chatId).catch(console.error);
    });
}

async function runBackgroundJob(options: AgentJobPayload, signal: AbortSignal) {
  publishUiSyncEvent({
    topic: "chat",
    chatId: options.chatId,
    projectId: options.projectId ?? null,
    reason: "[Daemon] Background job started. The agent is analyzing your request...",
  });

  try {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");

    const result = await runAgent({
      ...options,
      agentNumber: 0,
      isBackground: true,
      abortSignal: signal,
    });

    // NOTE: Do NOT write messages here. The onFinish callback in agent.ts
    // already persists all messages (user + assistant + tool results) atomically.
    // Writing here would create duplicate assistant messages in every background job.
    //
    // We only need to await result.text to ensure the stream is fully consumed
    // before proceeding to auto-pilot logic.
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");

    await result.text; // Drain the stream — persistence is handled by onFinish

    if (signal.aborted) throw new DOMException("Aborted", "AbortError");

    publishUiSyncEvent({
      topic: "chat",
      chatId: options.chatId,
      projectId: options.projectId ?? null,
      reason: "[Daemon] Background job completed successfully.",
    });
      
    // Auto-Pilot Logic: Check if Goal Tree has pending tasks
    const activeGoal = await getActiveGoal(options.chatId);
    if (activeGoal && activeGoal.status === "active") {
      let hasPendingTasks = false;
      const checkPending = (tasks: GoalTask[]) => {
        for (const t of tasks) {
          if (t.status === "pending" || t.status === "in_progress") {
            hasPendingTasks = true;
          }
          if (t.subtasks) checkPending(t.subtasks);
        }
      };
      checkPending(activeGoal.tasks);

      if (hasPendingTasks && !signal.aborted) {
        const iterations = (autoPilotIterations.get(options.chatId) ?? 0) + 1;
        autoPilotIterations.set(options.chatId, iterations);

        if (iterations >= MAX_AUTO_PILOT_ITERATIONS) {
          console.warn(`[Auto-Pilot] Chat ${options.chatId}: reached ${MAX_AUTO_PILOT_ITERATIONS} iterations, stopping.`);
          autoPilotIterations.delete(options.chatId);
        } else {
          // Exponential backoff: 3s → 4.5s → 6.75s → ... capped at 60s
          // Prevents runaway API costs if the goal never fully completes.
          const delayMs = Math.min(3000 * Math.pow(1.5, iterations - 1), 60_000);
          console.log(`[Auto-Pilot] Next iteration in ${Math.round(delayMs / 1000)}s (iteration ${iterations}/${MAX_AUTO_PILOT_ITERATIONS})`);
          publishUiSyncEvent({
            topic: "chat",
            chatId: options.chatId,
            projectId: options.projectId ?? null,
            reason: `[Auto-Pilot] Engaging next step in ${Math.round(delayMs / 1000)}s... (iteration ${iterations}/${MAX_AUTO_PILOT_ITERATIONS})`,
          });

          const timer = setTimeout(() => {
            autoPilotTimeouts.delete(options.chatId);
            // Abort gates (PM #7): the parent job's signal could have flipped
            // to aborted during the backoff window, OR the user could have
            // started a new job that's already running on this chat.
            if (signal.aborted) return;
            if (activeJobs.has(options.chatId)) return;
            dispatchAgentJob({
              ...options,
              userMessage: "System [Auto-Pilot]: Proceed with the next pending task in the active Goal Tree. Remember to use 'update_task_status' when finished."
            });
          }, delayMs);
          autoPilotTimeouts.set(options.chatId, timer);
        }
      }
    }

    // Invariant: the iteration counter is only meaningful while a pending
    // auto-pilot timeout exists on this chat. If we didn't schedule one
    // (goal completed, no pending tasks, signal.aborted, no active goal),
    // drop the counter so the next dispatch starts from a clean budget and
    // the Map doesn't accumulate dead keys.
    if (!autoPilotTimeouts.has(options.chatId)) {
      autoPilotIterations.delete(options.chatId);
    }
  } catch (error) {
    // Either path below ends the job. Drop the iteration counter so a fresh
    // dispatch starts with a clean budget — symmetric with abortJob.
    autoPilotIterations.delete(options.chatId);

    if ((error as Error)?.name === "AbortError" || signal.aborted) {
      await updateChat(options.chatId, (chat) => {
        const cancelMsg: ChatMessage = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: "⏹ Task was stopped by user.",
          createdAt: new Date().toISOString(),
        };
        chat.messages.push(cancelMsg);
        return chat;
      });
      publishUiSyncEvent({
        topic: "chat",
        chatId: options.chatId,
        projectId: options.projectId ?? null,
        reason: "[Daemon] Background job was cancelled.",
      });
      return;
    }

    await updateChat(options.chatId, (chat) => {
      const errorMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: `**[Background Daemon Error]:**\n${error instanceof Error ? error.message : String(error)}`,
        createdAt: new Date().toISOString(),
      };
      chat.messages.push(errorMsg);
      return chat;
    });

    publishUiSyncEvent({
      topic: "chat",
      chatId: options.chatId,
      projectId: options.projectId ?? null,
      reason: "[Daemon] Background job failed.",
    });
  }
}
