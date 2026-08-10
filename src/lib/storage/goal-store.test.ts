/**
 * goal-store.test.ts
 *
 * Tests for the Goal Tree persistence layer:
 *   - saveGoal / getActiveGoal / updateGoal / clearGoal
 *   - updateGoal concurrency: ensures no task overwrite under race
 *   - Error handling: no chatId, nonexistent goal
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import fs from "fs/promises";
import os from "os";

vi.mock("@/lib/realtime/event-bus", () => ({
  publishUiSyncEvent: vi.fn(),
}));

import type { ProjectGoal } from "@/lib/types";

function makeGoal(chatId: string): ProjectGoal {
  return {
    id: crypto.randomUUID(),
    chatId,
    projectId: "proj-123",
    title: "Test Goal",
    description: "Testing goal store",
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tasks: [
      { id: "1", description: "Task 1", status: "pending" },
      { id: "2", description: "Task 2", status: "pending" },
    ],
  };
}

describe("Goal Store", () => {
  const chatIds: string[] = [];

  // This file had NO isolation: every case wrote real goal files into the
  // operator's live `data/goals/` and relied on `clearGoal` to tidy up. Found
  // by running the file alone and diffing `data/` afterwards, not by reading.
  // `data/` IS the database and there is no undo — see PM #62.
  let tmpDir: string;
  let previousDataDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-goal-"));
    previousDataDir = process.env.ORCHESTRA_DATA_DIR;
    process.env.ORCHESTRA_DATA_DIR = tmpDir;
  });

  afterEach(async () => {
    const { clearGoal } = await import("@/lib/storage/goal-store");
    for (const id of chatIds) {
      await clearGoal(id).catch(() => {});
    }
    chatIds.length = 0;
    if (previousDataDir === undefined) delete process.env.ORCHESTRA_DATA_DIR;
    else process.env.ORCHESTRA_DATA_DIR = previousDataDir;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // The isolation fails SILENTLY — the suite passes either way, it just passes
  // against real data. Assert it rather than trust it.
  it("runs against an isolated data dir, not the operator's live one", async () => {
    const { getDataDir } = await import("@/lib/storage/data-dir");
    expect(getDataDir()).toBe(path.resolve(tmpDir));
    expect(getDataDir()).not.toBe(path.join(process.cwd(), "data"));
  });

  function trackChat(id: string) {
    chatIds.push(id);
    return id;
  }

  it("saveGoal then getActiveGoal should return persisted goal", async () => {
    const { saveGoal, getActiveGoal } = await import("@/lib/storage/goal-store");
    const chatId = trackChat(`goal-test-${Date.now()}`);
    const goal = makeGoal(chatId);

    await saveGoal(goal);
    const loaded = await getActiveGoal(chatId);

    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(goal.id);
    expect(loaded!.title).toBe("Test Goal");
    expect(loaded!.tasks).toHaveLength(2);
  });

  it("getActiveGoal should return null when no goal exists", async () => {
    const { getActiveGoal } = await import("@/lib/storage/goal-store");
    const result = await getActiveGoal("nonexistent-chat-for-goal-999");
    expect(result).toBeNull();
  });

  it("saveGoal should throw if chatId is missing", async () => {
    const { saveGoal } = await import("@/lib/storage/goal-store");
    const badGoal = makeGoal("will-be-removed");
    (badGoal as unknown as Record<string, unknown>).chatId = "";

    await expect(saveGoal(badGoal)).rejects.toThrow("Cannot save goal without a chatId");
  });

  it("updateGoal should apply mutator and persist changes", async () => {
    const { saveGoal, updateGoal, getActiveGoal } = await import("@/lib/storage/goal-store");
    const chatId = trackChat(`goal-update-${Date.now()}`);
    const goal = makeGoal(chatId);
    await saveGoal(goal);

    const updated = await updateGoal(chatId, (g) => {
      g.tasks[0].status = "completed";
      g.tasks[0].result = "Task done!";
      return g;
    });

    expect(updated).not.toBeNull();
    expect(updated!.tasks[0].status).toBe("completed");
    expect(updated!.tasks[0].result).toBe("Task done!");

    // Verify persisted
    const reloaded = await getActiveGoal(chatId);
    expect(reloaded!.tasks[0].status).toBe("completed");
  });

  it("updateGoal should return null for nonexistent goal", async () => {
    const { updateGoal } = await import("@/lib/storage/goal-store");
    const result = await updateGoal("nonexistent-goal-chat-999", (g) => g);
    expect(result).toBeNull();
  });

  it("clearGoal should remove the goal file", async () => {
    const { saveGoal, clearGoal, getActiveGoal } = await import("@/lib/storage/goal-store");
    const chatId = trackChat(`goal-clear-${Date.now()}`);
    await saveGoal(makeGoal(chatId));

    await clearGoal(chatId);

    const result = await getActiveGoal(chatId);
    expect(result).toBeNull();
  });

  it("clearGoal on nonexistent goal should not throw", async () => {
    const { clearGoal } = await import("@/lib/storage/goal-store");
    await expect(clearGoal("goal-that-was-never-created")).resolves.not.toThrow();
  });

  it("updateGoal concurrency: 30 parallel task updates should all persist", async () => {
    const { saveGoal, updateGoal, getActiveGoal } = await import("@/lib/storage/goal-store");
    const chatId = trackChat(`goal-concurrent-${Date.now()}`);
    const goal = makeGoal(chatId);
    // Start with an array-based counter
    goal.tasks = Array.from({ length: 30 }, (_, i) => ({
      id: String(i),
      description: `Task ${i}`,
      status: "pending" as const,
    }));
    await saveGoal(goal);

    // 30 concurrent updates, each completing a different task
    await Promise.all(
      goal.tasks.map((task) =>
        updateGoal(chatId, (g) => {
          const t = g.tasks.find((t) => t.id === task.id);
          if (t) t.status = "completed";
          return g;
        })
      )
    );

    const final = await getActiveGoal(chatId);
    const completed = final!.tasks.filter((t) => t.status === "completed");
    expect(completed.length).toBe(30);
  });
});
