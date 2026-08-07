/**
 * PM #98, second pass. These tests exist because the FIRST version of the fix
 * was wrong in a way that unit tests of the watchdog alone could never catch:
 * `ai@6` fires neither `onFinish` nor `onError` on an abort, so every honest-
 * failure path I had wired was dead code. A watchdog with nothing listening
 * turns a 640-second silence into a 90-second silence.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleStreamAbort, createPartialTextBuffer } from "./agent-abort";
import type { StreamWatchdog } from "./stream-watchdog";
import { StreamStalledError } from "@/lib/observability/stream-stall";
import type { AppSettings } from "@/lib/types";

/** The slice of a persisted chat these tests inspect. */
interface ChatLike {
  messages: { id: string; role: string; content: string; createdAt: string }[];
  updatedAt: string;
}

const updateChat = vi.hoisted(() =>
  vi.fn(async (_chatId: string, _updater: (chat: ChatLike) => ChatLike) => undefined)
);
const reportTurnError = vi.hoisted(() =>
  vi.fn(
    async (
      _err: unknown,
      _ctx: unknown,
      _opts: { logEvent: string; awaitPostmortem: boolean }
    ) => ({}) as never
  )
);
const publishOrchestratorFinished = vi.hoisted(() => vi.fn());
const publishUiSyncEvent = vi.hoisted(() => vi.fn());
const logWarn = vi.hoisted(() => vi.fn());

vi.mock("@/lib/storage/chat-store", () => ({ updateChat }));
vi.mock("@/lib/agent/agent-stream", () => ({ reportTurnError }));
vi.mock("@/lib/agent/agent-dag-events", () => ({ publishOrchestratorFinished }));
vi.mock("@/lib/realtime/event-bus", () => ({ publishUiSyncEvent }));
vi.mock("@/lib/observability/logger", () => ({
  log: { warn: logWarn, info: vi.fn(), error: vi.fn() },
}));

function fakeWatchdog(stalled: StreamStalledError | null): StreamWatchdog & { settled: boolean } {
  const w = {
    settled: false,
    signal: new AbortController().signal,
    noteActivity: vi.fn(),
    pauseForToolExecution: vi.fn(),
    noteStepBoundary: vi.fn(),
    settle: vi.fn(() => {
      w.settled = true;
    }),
    stalled,
  };
  return w as unknown as StreamWatchdog & { settled: boolean };
}

const ctx = {
  chatId: "c1",
  projectId: "p1",
  model: "openrouter/google/gemma-4-26b-a4b-it:free",
  request: { userMessage: "новости Латвии", swarmEnabled: false },
  settings: {} as AppSettings,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createPartialTextBuffer", () => {
  it("keeps the deltas in arrival order", () => {
    const b = createPartialTextBuffer();
    b.append("Вот ");
    b.append("новости");
    expect(b.text()).toBe("Вот новости");
  });

  it("is empty when nothing was streamed", () => {
    const b = createPartialTextBuffer();
    expect(b.text()).toBe("");
    b.append("");
    expect(b.text()).toBe("");
  });

  it("captures text from the IN-FLIGHT step, which `onAbort`'s `steps` never holds", () => {
    // The regression the council caught. `recordedSteps.push` runs only in
    // `ai@6`'s `finish-step` branch, so a single-step plain-chat turn — the
    // PM #98 shape — hands `onAbort` an EMPTY array. A `steps`-based
    // implementation preserved nothing in exactly the case it was built for.
    const b = createPartialTextBuffer();
    b.append("Сегодня в Латвии"); // streamed, step never finished
    expect(b.text()).toBe("Сегодня в Латвии");
  });
});

describe("handleStreamAbort — a watchdog stall", () => {
  const stall = () => new StreamStalledError("ttft", 90_000, 90_001, "openrouter/x:free");

  it("raises the chat-error report, so the user is TOLD", () => {
    // The whole point. Without this the turn ends silently and the fix only
    // shortens the wait.
    return handleStreamAbort(fakeWatchdog(stall()), "", ctx).then(() => {
      expect(reportTurnError).toHaveBeenCalledTimes(1);
      const [err, , opts] = reportTurnError.mock.calls[0];
      expect(err).toBeInstanceOf(StreamStalledError);
      expect(opts).toMatchObject({ logEvent: "agent_stream_stalled" });
    });
  });

  it("logs the bound that was hit", async () => {
    await handleStreamAbort(fakeWatchdog(stall()), "", ctx);
    expect(logWarn).toHaveBeenCalledWith(
      "agent_stream_stalled",
      expect.objectContaining({ stall: "ttft" })
    );
  });

  it("finalizes the DAG as an error so the UI stops spinning", async () => {
    await handleStreamAbort(fakeWatchdog(stall()), "", ctx);
    expect(publishOrchestratorFinished).toHaveBeenCalledWith("c1", "p1", "error", "agent_turn_error");
  });

  it("keeps the partial answer instead of discarding generated (and billed) tokens", async () => {
    await handleStreamAbort(fakeWatchdog(stall()), "Сегодня в Латвии", ctx);
    expect(updateChat).toHaveBeenCalledTimes(1);
    const chat: ChatLike = { messages: [], updatedAt: "" };
    updateChat.mock.calls[0][1](chat);
    expect(chat.messages[0].content).toContain("Сегодня в Латвии");
    expect(chat.messages[0].content).toContain("stopped responding");
  });

  it("writes no message when nothing was streamed", async () => {
    await handleStreamAbort(fakeWatchdog(stall()), "   ", ctx);
    expect(updateChat).not.toHaveBeenCalled();
  });

  it("settles the watchdog so no timer survives the turn", async () => {
    const w = fakeWatchdog(stall());
    await handleStreamAbort(w, "", ctx);
    expect(w.settle).toHaveBeenCalled();
  });
});

describe("handleStreamAbort — a genuine user cancel", () => {
  it("does NOT raise an error report — the user knows, they pressed stop", async () => {
    await handleStreamAbort(fakeWatchdog(null), "partial", ctx);
    expect(reportTurnError).not.toHaveBeenCalled();
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("still finalizes the DAG — cancelling used to leave it spinning forever", async () => {
    await handleStreamAbort(fakeWatchdog(null), "", ctx);
    // ...and as CANCELLED, not as an error: the user pressed stop.
    expect(publishOrchestratorFinished).toHaveBeenCalledWith(
      "c1",
      "p1",
      "cancelled",
      "agent_turn_cancelled"
    );
  });

  it("labels a cancelled partial as cancelled, not as a provider fault", async () => {
    await handleStreamAbort(fakeWatchdog(null), "half an answer", ctx);
    const chat: ChatLike = { messages: [], updatedAt: "" };
    updateChat.mock.calls[0][1](chat);
    expect(chat.messages[0].content).toContain("Cancelled");
    expect(chat.messages[0].content).not.toContain("stopped responding");
  });
});

describe("handleStreamAbort — never throws", () => {
  it("still reports and finalizes when persistence fails", async () => {
    updateChat.mockRejectedValueOnce(new Error("disk full"));
    await expect(
      handleStreamAbort(fakeWatchdog(new StreamStalledError("idle", 1, 1, "m")), "x", ctx)
    ).resolves.toBeUndefined();
    // A failed write must not swallow the reason the turn ended.
    expect(reportTurnError).toHaveBeenCalledTimes(1);
    expect(publishOrchestratorFinished).toHaveBeenCalled();
  });

  it("still finalizes when the error report itself fails", async () => {
    reportTurnError.mockRejectedValueOnce(new Error("bus down"));
    await expect(
      handleStreamAbort(fakeWatchdog(new StreamStalledError("idle", 1, 1, "m")), "", ctx)
    ).resolves.toBeUndefined();
    expect(publishOrchestratorFinished).toHaveBeenCalled();
  });
});
