import fs from "fs/promises";
import path from "path";
import { ensureGoalsDir, updateGoal } from "@/lib/storage/goal-store";
import { isJobActive } from "@/lib/agent/daemon";
import type { GoalTask } from "@/lib/types";
import { publishUiSyncEvent } from "@/lib/realtime/event-bus";
import { getDataDir } from "@/lib/storage/data-dir";

const DATA_DIR = getDataDir();
const GOALS_DIR = path.join(DATA_DIR, "goals");

export async function sweepGhostTasks(): Promise<void> {
  try {
    await ensureGoalsDir();
    const files = await fs.readdir(GOALS_DIR);

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const chatId = file.replace(".json", "");

      // If a job is legitimately running for this chat right now, skip sweeping.
      if (isJobActive(chatId)) continue;

      let modified = false;

      await updateGoal(chatId, (goal) => {
        if (goal.status !== "active") return goal;

        // Recursively mark any "in_progress" tasks as "failed"
        const fixTasks = (tasks: GoalTask[]) => {
          for (const t of tasks) {
            if (t.status === "in_progress") {
              t.status = "failed";
              t.result = "[System] Task aborted due to server termination/restart.";
              modified = true;
            }
            if (t.subtasks && t.subtasks.length > 0) {
              fixTasks(t.subtasks);
            }
          }
        };

        fixTasks(goal.tasks);
        return goal;
      });

      if (modified) {
        console.log(`[GhostSweeper] Cleaned up ghost tasks for chat ${chatId}`);

        publishUiSyncEvent({
          topic: "chat",
          chatId,
          reason: "[System] Ghost tasks recovered from server restart. Goal Tree updated.",
        });
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    console.error("[GhostSweeper] Failed to sweep:", err);
  }
}

