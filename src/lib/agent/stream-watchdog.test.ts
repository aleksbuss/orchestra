/**
 * PM #98 regression suite for the interactive stream's time bound.
 *
 * The bug being fenced in: a free endpoint accepted the connection, sent
 * nothing, and the turn hung for seven minutes with no answer and no error.
 *
 * The bug this fix could EASILY introduce, and which several tests here exist
 * solely to prevent: a timeout that kills legitimately long agentic work.
 * `install-orchestrator` alone permits a ten-minute command, so any bound that
 * counts tool-execution time as "stalled" is a worse bug than the hang.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createStreamWatchdog, logStreamStall, callDeadlineSignal } from "./stream-watchdog";
import { isStreamStall, StreamStalledError } from "@/lib/observability/stream-stall";
import { log } from "@/lib/observability/logger";

vi.mock("@/lib/observability/logger", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const TTFT = 1000;
const IDLE = 2000;

function watchdog(base?: AbortSignal) {
  return createStreamWatchdog(base, { label: "openrouter/test:free", ttftMs: TTFT, idleMs: IDLE });
}

describe("stream watchdog — time to first token", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("aborts when the provider never sends a first token", () => {
    const w = watchdog();
    expect(w.signal.aborted).toBe(false);
    vi.advanceTimersByTime(TTFT + 1);
    expect(w.signal.aborted).toBe(true);
    expect(w.stalled?.orchestraStreamStall).toBe("ttft");
  });

  it("does not abort while the provider is still within the budget", () => {
    const w = watchdog();
    vi.advanceTimersByTime(TTFT - 1);
    expect(w.signal.aborted).toBe(false);
    expect(w.stalled).toBeNull();
  });

  it("names the model and the budget, and leaks no internals", () => {
    const w = watchdog();
    vi.advanceTimersByTime(TTFT + 1);
    const msg = w.stalled!.message;
    expect(msg).toContain("openrouter/test:free");
    expect(msg).toContain("1s");
    expect(msg).not.toMatch(/\/Users\/|api[_-]?key|Bearer/i);
  });

  it("re-arms at every step boundary — a later step can hang like the first", () => {
    const w = watchdog();
    w.noteActivity();               // step 1 produced output
    vi.advanceTimersByTime(500);
    w.noteStepBoundary();           // step 2's upstream request opens...
    vi.advanceTimersByTime(TTFT + 1); // ...and says nothing
    expect(w.stalled?.orchestraStreamStall).toBe("ttft");
  });
});

describe("stream watchdog — inter-chunk idle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("aborts when the stream dies mid-answer", () => {
    const w = watchdog();
    w.noteActivity();
    vi.advanceTimersByTime(IDLE + 1);
    expect(w.signal.aborted).toBe(true);
    expect(w.stalled?.orchestraStreamStall).toBe("idle");
  });

  it("EVERY chunk resets the clock — a long answer is never capped", () => {
    const w = watchdog();
    // Ten times the idle budget in wall clock, all of it healthy streaming.
    for (let i = 0; i < 10; i++) {
      w.noteActivity();
      vi.advanceTimersByTime(IDLE - 1);
    }
    expect(w.signal.aborted).toBe(false);
    expect(w.stalled).toBeNull();
  });

  it("does NOT count tool execution as a stall", () => {
    const w = watchdog();
    w.noteActivity();
    w.pauseForToolExecution();
    // A ten-minute `install-orchestrator` run, in a test that takes no time.
    vi.advanceTimersByTime(10 * 60_000);
    expect(w.signal.aborted).toBe(false);
    // The tool finished and the model resumed: the bound is live again.
    w.noteStepBoundary();
    vi.advanceTimersByTime(TTFT + 1);
    expect(w.stalled?.orchestraStreamStall).toBe("ttft");
  });
});

describe("stream watchdog — composition with the caller's signal", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a user cancel still aborts, and is NOT reported as a stall", () => {
    const user = new AbortController();
    const w = watchdog(user.signal);
    user.abort(new Error("user pressed stop"));
    expect(w.signal.aborted).toBe(true);
    // `stalled` stays null so the classifier reports a cancellation, not a
    // provider fault — the watchdog only ever ADDS a way to stop.
    expect(w.stalled).toBeNull();
  });

  it("works with no caller signal at all", () => {
    const w = createStreamWatchdog(undefined, { label: "m", ttftMs: 10, idleMs: 10 });
    vi.advanceTimersByTime(11);
    expect(w.signal.aborted).toBe(true);
  });

  it("an already-aborted caller signal aborts immediately", () => {
    const w = watchdog(AbortSignal.abort());
    expect(w.signal.aborted).toBe(true);
  });
});

describe("stream watchdog — settle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stops the clock so post-stream persistence cannot trip it", () => {
    const w = watchdog();
    w.settle();
    vi.advanceTimersByTime(10 * IDLE);
    expect(w.signal.aborted).toBe(false);
  });

  it("is idempotent and immune to late activity callbacks", () => {
    const w = watchdog();
    w.settle();
    w.settle();
    w.noteActivity();
    w.noteStepBoundary();
    vi.advanceTimersByTime(10 * IDLE);
    expect(w.signal.aborted).toBe(false);
  });

  it("once stalled, a late chunk cannot re-arm or overwrite the reason", () => {
    const w = watchdog();
    vi.advanceTimersByTime(TTFT + 1);
    const first = w.stalled;
    w.noteActivity();
    vi.advanceTimersByTime(10 * IDLE);
    expect(w.stalled).toBe(first);
  });
});

describe("stream watchdog — budgets and the escape hatch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a budget of 0 disables that bound", () => {
    const w = createStreamWatchdog(undefined, { label: "m", ttftMs: 0, idleMs: 0 });
    vi.advanceTimersByTime(60 * 60_000);
    expect(w.signal.aborted).toBe(false);
  });

  it("reads budgets from the environment", () => {
    vi.stubEnv("ORCHESTRA_STREAM_TTFT_MS", "500");
    const w = createStreamWatchdog(undefined, { label: "m" });
    vi.advanceTimersByTime(501);
    expect(w.stalled?.budgetMs).toBe(500);
    vi.unstubAllEnvs();
  });

  it("ignores a garbage env value instead of silently disabling the bound", () => {
    // A typo must not turn the watchdog off — that is how the seven-minute
    // hang comes back with nobody noticing.
    vi.stubEnv("ORCHESTRA_STREAM_TTFT_MS", "ninety seconds");
    const w = createStreamWatchdog(undefined, { label: "m" });
    vi.advanceTimersByTime(90_001);
    expect(w.stalled?.budgetMs).toBe(90_000);
    vi.unstubAllEnvs();
  });
});

describe("logStreamStall", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(log.warn).mockClear();
  });
  afterEach(() => vi.useRealTimers());

  const ctx = { chatId: "c1", projectId: "p1", model: "openrouter/test:free" };

  it("says nothing when the stream ended normally", () => {
    const w = watchdog();
    w.settle();
    logStreamStall(w, ctx);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("records WHICH bound was hit and how long it waited", () => {
    // Rule 18 — the model never spoke, so this line is the only thing that
    // distinguishes "the endpoint went quiet" from "the endpoint errored".
    const w = watchdog();
    vi.advanceTimersByTime(TTFT + 1);
    logStreamStall(w, ctx);
    expect(log.warn).toHaveBeenCalledWith(
      "agent_stream_stalled",
      expect.objectContaining({ stall: "ttft", budgetMs: TTFT, model: ctx.model })
    );
  });
});

describe("callDeadlineSignal — fail-safe by construction", () => {
  // A council review argued the CI scan "proves the syntax is there, not the
  // semantics — a developer passes undefined and the agent hangs". These pin
  // the counter-claim: the bound cannot be removed from a CALLSITE at all.
  // Only the documented operator env hatch can remove it.
  //
  // REAL timers on purpose. `AbortSignal.timeout` is backed by Node's internal
  // timer, which `vi.useFakeTimers()` does NOT patch — a fake-timer version of
  // these tests passes vacuously in the "no bound" direction and fails in the
  // "bound fires" direction. Budgets are tens of milliseconds so it stays fast.
  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("still bounds the call when the caller has NO signal to give", async () => {
    const s = callDeadlineSignal(undefined, 30)!;
    expect(s.aborted).toBe(false);
    await tick(60);
    expect(s.aborted).toBe(true);
  });

  it("keeps the caller's cancellation working alongside the deadline", () => {
    const user = new AbortController();
    const s = callDeadlineSignal(user.signal, 60_000)!;
    user.abort();
    expect(s.aborted).toBe(true);
  });

  it("the deadline fires even when the caller never cancels", async () => {
    const user = new AbortController();
    const s = callDeadlineSignal(user.signal, 30)!;
    await tick(60);
    expect(s.aborted).toBe(true);
  });

  it("a NEGATIVE budget is a typo, not an opt-out", async () => {
    // Falls back to the 120s default, so it is emphatically NOT aborted here.
    const s = callDeadlineSignal(undefined, -1)!;
    await tick(30);
    expect(s.aborted).toBe(false);
  });

  it("only an explicit 0 removes the bound — the documented operator hatch", () => {
    const user = new AbortController();
    expect(callDeadlineSignal(user.signal, 0)).toBe(user.signal);
    expect(callDeadlineSignal(undefined, 0)).toBeUndefined();
  });
});

describe("StreamStalledError", () => {
  it("is named AbortError so the AI SDK does not burn maxRetries on it", () => {
    // The SDK retries network faults. A call we deliberately killed must not be
    // re-run three times — that would triple the wall clock of the very hang
    // this exists to bound.
    const err = new StreamStalledError("ttft", 1000, 1001, "m");
    expect(err.name).toBe("AbortError");
    expect(err).toBeInstanceOf(Error);
  });

  it("is detected by its marker, not by its name or message", () => {
    expect(isStreamStall(new StreamStalledError("idle", 1, 1, "m"))).toBe(true);
    // A real user cancellation shares the name — and must NOT be mistaken for
    // a stall, or the UI would blame the provider for the user's stop button.
    const userAbort = new Error("aborted");
    userAbort.name = "AbortError";
    expect(isStreamStall(userAbort)).toBe(false);
    expect(isStreamStall(null)).toBe(false);
    expect(isStreamStall("AbortError")).toBe(false);
  });
});
