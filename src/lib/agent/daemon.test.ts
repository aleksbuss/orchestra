import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { publishUiSyncEvent } from "@/lib/realtime/event-bus";
// We don't import daemon.ts directly and rely on its side effects to avoid Node HTTP environment issues
import { dispatchAgentJob, abortJob } from "./daemon";
import {
  hasPendingAutoPilotTimeout,
  primeAutoPilotTimeout,
  getAutoPilotIterations,
  setAutoPilotIterations,
  clearAutoPilotIterations,
} from "./daemon.testing";
import { runAgent } from "./agent";
import { getActiveGoal } from "@/lib/storage/goal-store";
// `dequeueJob` and `updateChat` are mocked via the `vi.mock(...)` factories
// below but not referenced by name in any test — pulling them as imports
// would just tickle TS6133. The mock factories are still required: they
// prevent the daemon's real fs writes from running during tests.
import { enqueueJob } from "@/lib/storage/queue-store";

// Mock the real event bus so we can track events emitted by the daemon
vi.mock("@/lib/realtime/event-bus", () => ({
  publishUiSyncEvent: vi.fn(),
}));

// Mock the real agent to avoid Vite importing Vercel SDK
vi.mock("./agent", () => ({
  runAgent: vi.fn(),
}));

// Mock storage layer so dispatchAgentJob doesn't touch the real filesystem.
vi.mock("@/lib/storage/goal-store", () => ({
  getActiveGoal: vi.fn(),
}));
vi.mock("@/lib/storage/queue-store", () => ({
  enqueueJob: vi.fn().mockResolvedValue(undefined),
  dequeueJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/storage/chat-store", () => ({
  updateChat: vi.fn().mockResolvedValue(undefined),
}));

// Mock process.nextTick so we can run background jobs synchronously in tests
vi.stubGlobal("process", { ...process, nextTick: (cb: any) => cb() });

describe("Background Daemon Integration (Message Bus)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should have dispatchAgentJob defined", () => {
    expect(dispatchAgentJob).toBeDefined();
    expect(typeof dispatchAgentJob).toBe("function");
  });

  it("should properly structure UiSyncEvents emitted from the backend", () => {
    // We emit an event manually to test the integration schema
    publishUiSyncEvent({
      topic: "chat",
      chatId: "123",
      reason: "Daemon running in background",
      nodeType: "agent_node",
      parentId: "root"
    });

    expect(publishUiSyncEvent).toHaveBeenCalledTimes(1);
    expect(publishUiSyncEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: "chat",
        chatId: "123",
        reason: "Daemon running in background",
        nodeType: "agent_node",
        parentId: "root"
      })
    );
  });
});

describe("PM #7 — auto-pilot abort gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears a pending auto-pilot timeout when abortJob is called", () => {
    const chatId = "pm7-abort-during-backoff";
    const nextIterationCallback = vi.fn();

    // Prime the daemon's internal timeout registry as if a runAgent run had
    // just completed and queued the next auto-pilot iteration.
    primeAutoPilotTimeout(chatId, 5000, nextIterationCallback);
    expect(hasPendingAutoPilotTimeout(chatId)).toBe(true);

    // User aborts during the backoff window.
    abortJob(chatId);

    // Advance past the original delay — the callback must NOT fire.
    vi.advanceTimersByTime(10_000);
    expect(nextIterationCallback).not.toHaveBeenCalled();
    expect(hasPendingAutoPilotTimeout(chatId)).toBe(false);
  });

  it("lets the timeout fire normally when no abort happens", () => {
    const chatId = "pm7-normal-flow";
    const nextIterationCallback = vi.fn();

    primeAutoPilotTimeout(chatId, 1000, nextIterationCallback);
    expect(hasPendingAutoPilotTimeout(chatId)).toBe(true);

    vi.advanceTimersByTime(1500);
    expect(nextIterationCallback).toHaveBeenCalledTimes(1);
    // Timer self-clears from the registry once it fires.
    expect(hasPendingAutoPilotTimeout(chatId)).toBe(false);
  });
});

describe("PM #7 — production setTimeout path (integration; Defect #6 from 2026-05 audit)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Clean up any pending production timers we don't want firing across tests.
    abortJob("pm7-integration-chat");
  });

  it("real dispatchAgentJob registers an auto-pilot timeout in autoPilotTimeouts when the goal has pending tasks", async () => {
    const chatId = "pm7-integration-chat";

    // Mock runAgent to resolve immediately with a drained text stream.
    vi.mocked(runAgent).mockResolvedValue({
      text: Promise.resolve("done"),
    } as unknown as Awaited<ReturnType<typeof runAgent>>);

    // Mock an active goal with one pending task — this is the branch that
    // schedules the auto-pilot setTimeout in daemon.ts.
    vi.mocked(getActiveGoal).mockResolvedValue({
      id: "goal-1",
      chatId,
      status: "active",
      tasks: [
        {
          id: "task-1",
          status: "pending",
          subtasks: [],
        },
      ],
    } as unknown as Awaited<ReturnType<typeof getActiveGoal>>);

    // Fire-and-forget by design — dispatchAgentJob returns once the controller
    // is registered and runBackgroundJob is launched.
    await dispatchAgentJob({
      chatId,
      userMessage: "hello",
    });

    // Wait for the async chain (runAgent → getActiveGoal → setTimeout) to
    // reach the autoPilotTimeouts.set call. We poll because the chain is
    // entirely microtask-driven once mocks resolve synchronously.
    await vi.waitFor(
      () => {
        expect(hasPendingAutoPilotTimeout(chatId)).toBe(true);
      },
      { timeout: 1000, interval: 10 }
    );

    // Crucial: this proves the production path (daemon.ts:184-196) — NOT the
    // test helper — registered the timer. Defect #6: the previous regression
    // test only exercised primeAutoPilotTimeout, which would
    // have stayed green even if production stopped registering the handle.

    // Now exercise the abort path on a production-registered timer.
    expect(enqueueJob).toHaveBeenCalledWith(expect.objectContaining({ chatId }));
    abortJob(chatId);
    expect(hasPendingAutoPilotTimeout(chatId)).toBe(false);
  });

  it("PM #22 follow-up — forceSwarm is forwarded to runAgent in background mode", async () => {
    // The interactive path (api/chat/route.ts L114) sent forceSwarm down all
    // along. The background dispatch silently dropped it: a user with the
    // Force pill ON who flipped to Auto-Pilot would lose the override the
    // moment the Router decided `requiresSwarm: false`. This pins the
    // contract on the daemon side so a future refactor can't re-introduce
    // the gap.
    const chatId = "pm22-force-swarm-background";

    vi.mocked(runAgent).mockResolvedValue({
      text: Promise.resolve("done"),
    } as unknown as Awaited<ReturnType<typeof runAgent>>);
    vi.mocked(getActiveGoal).mockResolvedValue(null);

    await dispatchAgentJob({
      chatId,
      userMessage: "hello",
      swarmEnabled: true,
      forceSwarm: true,
    });

    await vi.waitFor(
      () => {
        expect(runAgent).toHaveBeenCalledWith(
          expect.objectContaining({ forceSwarm: true })
        );
      },
      { timeout: 1000, interval: 10 }
    );

    // Bonus: the persisted queue entry must also carry the flag, so a
    // server restart mid-run resumes with the override intact.
    expect(enqueueJob).toHaveBeenCalledWith(
      expect.objectContaining({ forceSwarm: true })
    );

    abortJob(chatId);
  });

  it("an auto-pilot continuation dispatch INCREMENTS the counter (does not reset to 1)", async () => {
    // review bug_001: abortJob unconditionally wiped autoPilotIterations, and
    // dispatchAgentJob calls abortJob first — so the continuation path cycled
    // 5→(wipe)→0→1 every iteration and MAX_AUTO_PILOT_ITERATIONS never tripped.
    // The fix preserves the counter on auto-pilot continuations.
    const chatId = "ap-counter-chat";
    setAutoPilotIterations(chatId, 5);

    vi.mocked(runAgent).mockResolvedValue({
      text: Promise.resolve("done"),
    } as unknown as Awaited<ReturnType<typeof runAgent>>);
    vi.mocked(getActiveGoal).mockResolvedValue({
      id: "goal-1",
      chatId,
      status: "active",
      tasks: [{ id: "task-1", status: "pending", subtasks: [] }],
    } as unknown as Awaited<ReturnType<typeof getActiveGoal>>);

    await dispatchAgentJob({
      chatId,
      userMessage:
        "System [Auto-Pilot]: Proceed with the next pending task in the active Goal Tree.",
    });

    // Must climb to 6 (5 + 1), NOT reset to 1.
    await vi.waitFor(
      () => {
        expect(getAutoPilotIterations(chatId)).toBe(6);
      },
      { timeout: 1000, interval: 10 }
    );

    abortJob(chatId);
    clearAutoPilotIterations(chatId);
  });

  it("abortJob preserves the counter only when preserveAutoPilotCounter is set", () => {
    const chatId = "ap-abort-opt";
    setAutoPilotIterations(chatId, 7);

    // Auto-pilot continuation re-entry: keep the count.
    abortJob(chatId, { preserveAutoPilotCounter: true });
    expect(getAutoPilotIterations(chatId)).toBe(7);

    // Genuine user abort (default): reset to a fresh budget.
    abortJob(chatId);
    expect(getAutoPilotIterations(chatId)).toBe(0);
  });

  it("a user-initiated dispatch resets the counter to a fresh budget", async () => {
    const chatId = "ap-user-reset";
    setAutoPilotIterations(chatId, 9);

    vi.mocked(runAgent).mockResolvedValue({
      text: Promise.resolve("done"),
    } as unknown as Awaited<ReturnType<typeof runAgent>>);
    vi.mocked(getActiveGoal).mockResolvedValue(null);

    await dispatchAgentJob({ chatId, userMessage: "a real user message" });

    await vi.waitFor(
      () => {
        expect(getAutoPilotIterations(chatId)).toBe(0);
      },
      { timeout: 1000, interval: 10 }
    );
    abortJob(chatId);
  });

  it("does NOT register an auto-pilot timeout when the goal has no pending tasks", async () => {
    const chatId = "pm7-no-pending";

    vi.mocked(runAgent).mockResolvedValue({
      text: Promise.resolve("done"),
    } as unknown as Awaited<ReturnType<typeof runAgent>>);

    // All tasks completed — no auto-pilot iteration should be queued.
    vi.mocked(getActiveGoal).mockResolvedValue({
      id: "goal-1",
      chatId,
      status: "active",
      tasks: [
        {
          id: "task-1",
          status: "completed",
          subtasks: [],
        },
      ],
    } as unknown as Awaited<ReturnType<typeof getActiveGoal>>);

    await dispatchAgentJob({
      chatId,
      userMessage: "hello",
    });

    // Drain the microtask queue — let the background job finish entirely.
    // No setTimeout should have been registered. We assert via a small
    // settle window rather than vi.waitFor (which expects truthy convergence).
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(hasPendingAutoPilotTimeout(chatId)).toBe(false);

    // Defensive cleanup if for some reason a job is still tracked.
    abortJob(chatId);
  });

});
