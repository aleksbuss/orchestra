/**
 * Tests for `sweepGhostTasks` — server-boot cleanup that marks orphaned
 * `in_progress` GoalTree tasks as `failed` after a restart.
 *
 * CLAUDE.md §4 calls this out: "background tasks live in Node's memory
 * (`activeJobs`). Restart clears them. Ghost-sweeper finds orphaned
 * `in_progress` tasks in `data/goals/` JSON files and marks them as
 * 'failed'." Without this, every UI shows tasks stuck in_progress forever
 * after a server restart.
 *
 * Pinned invariants:
 *   - Skip chats whose job is legitimately still running (`isJobActive`).
 *   - Recursively walk the task tree (subtasks of subtasks).
 *   - Touch only `active` goals — completed goals stay completed.
 *   - Publish a UI sync event so the open browser tabs refresh their goal
 *     tree without a manual reload.
 *   - Missing `data/goals/` dir → silent no-op (fresh install).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import type { Goal, GoalTask } from "@/lib/types";

vi.mock("@/lib/agent/daemon", () => ({
  isJobActive: vi.fn(() => false),
}));

vi.mock("@/lib/realtime/event-bus", () => ({
  publishUiSyncEvent: vi.fn(),
}));

// We use the REAL goal-store: it provides `ensureGoalsDir` and `updateGoal`
// which read+mutate+save JSON files. Pointing process.cwd() at a tmpdir
// gives us a clean slate per test.
let tmpRoot: string;
let cwdSpy: any;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-ghostsweep-"));
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmpRoot);
  vi.resetModules();
  vi.clearAllMocks();
});

afterEach(async () => {
  cwdSpy?.mockRestore();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function loadModule() {
  return await import("./ghost-sweeper");
}

async function plantGoal(chatId: string, goal: Goal): Promise<void> {
  const goalsDir = path.join(tmpRoot, "data", "goals");
  await fs.mkdir(goalsDir, { recursive: true });
  await fs.writeFile(path.join(goalsDir, `${chatId}.json`), JSON.stringify(goal), "utf-8");
}

async function readGoal(chatId: string): Promise<Goal> {
  const raw = await fs.readFile(
    path.join(tmpRoot, "data", "goals", `${chatId}.json`),
    "utf-8"
  );
  return JSON.parse(raw) as Goal;
}

const task = (overrides: Partial<GoalTask> = {}): GoalTask =>
  ({
    id: overrides.id ?? "t1",
    title: overrides.title ?? "task",
    status: overrides.status ?? "in_progress",
    subtasks: overrides.subtasks ?? [],
    ...overrides,
  } as GoalTask);

const goal = (overrides: Partial<Goal> = {}): Goal =>
  ({
    chatId: overrides.chatId ?? "c-1",
    description: "test goal",
    status: overrides.status ?? "active",
    tasks: overrides.tasks ?? [task()],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Goal);

describe("sweepGhostTasks — happy path", () => {
  it("marks an orphaned in_progress task as failed", async () => {
    await plantGoal("c-1", goal({ tasks: [task({ status: "in_progress" })] }));

    const m = await loadModule();
    await m.sweepGhostTasks();

    const updated = await readGoal("c-1");
    expect(updated.tasks[0].status).toBe("failed");
    expect(updated.tasks[0].result).toMatch(/server termination|restart/i);
  });

  it("recurses into subtasks of subtasks (the goal tree is N-deep)", async () => {
    const tree = goal({
      tasks: [
        task({
          id: "root",
          status: "in_progress",
          subtasks: [
            task({
              id: "child",
              status: "in_progress",
              subtasks: [task({ id: "grand", status: "in_progress" })],
            }),
          ],
        }),
      ],
    });
    await plantGoal("c-deep", tree);

    const m = await loadModule();
    await m.sweepGhostTasks();

    const updated = await readGoal("c-deep");
    expect(updated.tasks[0].status).toBe("failed");
    expect(updated.tasks[0].subtasks?.[0]?.status).toBe("failed");
    expect(updated.tasks[0].subtasks?.[0]?.subtasks?.[0]?.status).toBe("failed");
  });

  it("publishes a UI sync event so open tabs refresh", async () => {
    const { publishUiSyncEvent } = await import("@/lib/realtime/event-bus");
    await plantGoal("c-evt", goal({ tasks: [task({ status: "in_progress" })] }));

    const m = await loadModule();
    await m.sweepGhostTasks();

    expect(publishUiSyncEvent).toHaveBeenCalledWith(
      expect.objectContaining({ topic: "chat", chatId: "c-evt" })
    );
  });
});

describe("sweepGhostTasks — skip cases", () => {
  it("does not touch tasks whose job is currently active (live run, not a ghost)", async () => {
    const { isJobActive } = await import("@/lib/agent/daemon");
    vi.mocked(isJobActive).mockImplementation((chatId: string) => chatId === "c-live");

    await plantGoal("c-live", goal({ tasks: [task({ status: "in_progress" })] }));

    const m = await loadModule();
    await m.sweepGhostTasks();

    const untouched = await readGoal("c-live");
    expect(untouched.tasks[0].status).toBe("in_progress");
  });

  it("does not touch goals that are not 'active'", async () => {
    await plantGoal(
      "c-done",
      goal({
        status: "completed",
        tasks: [task({ status: "in_progress" })], // even if a leaf is in_progress, the goal is done
      })
    );

    const m = await loadModule();
    await m.sweepGhostTasks();

    const untouched = await readGoal("c-done");
    expect(untouched.tasks[0].status).toBe("in_progress");
  });

  it("does not touch tasks already in completed/failed state", async () => {
    await plantGoal(
      "c-mixed",
      goal({
        tasks: [
          task({ id: "ok", status: "completed" }),
          task({ id: "bad", status: "failed" }),
          task({ id: "live", status: "in_progress" }),
        ],
      })
    );

    const m = await loadModule();
    await m.sweepGhostTasks();

    const updated = await readGoal("c-mixed");
    expect(updated.tasks[0].status).toBe("completed");
    expect(updated.tasks[1].status).toBe("failed");
    expect(updated.tasks[2].status).toBe("failed"); // the in_progress one was swept
  });

  it("does NOT publish a UI event when nothing was swept (no spurious refreshes)", async () => {
    const { publishUiSyncEvent } = await import("@/lib/realtime/event-bus");
    await plantGoal(
      "c-clean",
      goal({ tasks: [task({ status: "completed" })] })
    );

    const m = await loadModule();
    await m.sweepGhostTasks();

    expect(publishUiSyncEvent).not.toHaveBeenCalled();
  });
});

describe("sweepGhostTasks — boot resilience", () => {
  it("missing goals directory → silent no-op (fresh install)", async () => {
    // Don't plant anything; the dir doesn't exist yet.
    const m = await loadModule();
    await expect(m.sweepGhostTasks()).resolves.toBeUndefined();
  });

  it("ignores non-.json files in the goals dir (defensive)", async () => {
    const goalsDir = path.join(tmpRoot, "data", "goals");
    await fs.mkdir(goalsDir, { recursive: true });
    await fs.writeFile(path.join(goalsDir, "stale.lock"), "x", "utf-8");

    const m = await loadModule();
    await expect(m.sweepGhostTasks()).resolves.toBeUndefined();
  });
});
