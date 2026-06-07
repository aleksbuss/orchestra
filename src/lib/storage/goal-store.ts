import fs from "fs/promises";
import path from "path";
import { type ProjectGoal } from "@/lib/types";
import { safeWriteFile, withFileLock } from "./fs-utils";
import { getDataDir } from "@/lib/storage/data-dir";

const DATA_DIR = getDataDir();
const GOALS_DIR = path.join(DATA_DIR, "goals");

export async function ensureGoalsDir() {
  await fs.mkdir(GOALS_DIR, { recursive: true });
}

function getGoalPath(chatId: string): string {
  // We keep one active goal tree per chat.
  return path.join(GOALS_DIR, `${chatId}.json`);
}

/**
 * Gets the current active goal tree for a chat. 
 * If it doesn't exist, returns null.
 */
export async function getActiveGoal(chatId: string): Promise<ProjectGoal | null> {
  await ensureGoalsDir();
  const filePath = getGoalPath(chatId);
  try {
    const data = await fs.readFile(filePath, "utf-8");
    return JSON.parse(data) as ProjectGoal;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    console.error(`[GoalStore] Failed to read goal for chat ${chatId}:`, err);
    return null;
  }
}

/**
 * Saves or updates a goal tree.
 */
export async function saveGoal(goal: ProjectGoal): Promise<void> {
  await ensureGoalsDir();
  if (!goal.chatId) {
    throw new Error("[GoalStore] Cannot save goal without a chatId");
  }
  const filePath = getGoalPath(goal.chatId);
  goal.updatedAt = new Date().toISOString();
  
  await withFileLock(filePath, async () => {
    await safeWriteFile(filePath, JSON.stringify(goal, null, 2));
  });
}

export async function updateGoal(
  chatId: string,
  updater: (goal: ProjectGoal) => ProjectGoal | Promise<ProjectGoal>
): Promise<ProjectGoal | null> {
  const filePath = getGoalPath(chatId);
  return await withFileLock(filePath, async () => {
    let goal: ProjectGoal | null = null;
    try {
      const data = await fs.readFile(filePath, "utf-8");
      goal = JSON.parse(data) as ProjectGoal;
    } catch {
      return null;
    }
    
    goal = await updater(goal);
    goal.updatedAt = new Date().toISOString();
    await safeWriteFile(filePath, JSON.stringify(goal, null, 2));
    return goal;
  });
}

/**
 * Deletes the goal tree for a chat.
 */
export async function clearGoal(chatId: string): Promise<void> {
  const filePath = getGoalPath(chatId);
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[GoalStore] Failed to delete goal for chat ${chatId}:`, err);
    }
  }
}
