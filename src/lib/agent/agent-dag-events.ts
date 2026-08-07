/**
 * Swarm DAG completion guard.
 *
 * Guarantees that the orchestrator node always transitions out of "running"
 * even when the SSE stream disconnects mid-response or `onFinish` throws.
 *
 * Extracted from `agent.ts` (rule 25) when PM #98 gave it a second caller: an
 * ABORTED stream fires neither `onFinish` nor `onError` in `ai@6`, so the abort
 * path has to finalize the DAG itself or the UI spins forever. That was already
 * true of a plain user cancel long before the watchdog existed.
 */
import { publishUiSyncEvent } from "@/lib/realtime/event-bus";

export function publishOrchestratorFinished(
  chatId: string,
  projectId: string | null | undefined,
  status: "completed" | "error" | "cancelled",
  reason?: string
) {
  publishUiSyncEvent({
    topic: "chat",
    projectId: projectId ?? null,
    chatId,
    reason: reason ?? "agent_turn_finished",
  });
  publishUiSyncEvent({
    topic: "chat",
    projectId: projectId ?? null,
    chatId,
    nodeType: "agent_node",
    swarmNode: {
      nodeId: chatId,
      role: "orchestrator",
      taskSummary:
        status === "completed" ? "Finished." : status === "cancelled" ? "Cancelled." : "Error.",
      status,
      completedAt: new Date().toISOString(),
    },
  });
}
