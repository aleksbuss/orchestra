/**
 * Tests for `callSubordinate` — the public entry that the agent's
 * `call_subordinate` tool wraps. The file has one export but a stack of
 * internal logic (error code extraction, retry decision, concurrency
 * slot acquisition, formatting). All branches are exercised through the
 * public surface by mocking the inner `runSubordinateAgent`.
 *
 * Contracts we pin:
 *   - Happy path → result is prefixed with `Subordinate Agent <N+1>`.
 *   - Error path → result is prefixed with `Subordinate agent error:`
 *     (never throws — callers map error strings into tool output).
 *   - Retry on retriable provider errors (HTTP 429/5xx, "rate limit",
 *     "timeout", "overloaded", "econnreset") up to 2 retries. Fake
 *     timers advance the SUBORDINATE_RETRY_DELAYS_MS pauses.
 *   - Non-retriable errors (400, 401, "not found") fail immediately.
 *   - Concurrency cap: MAX_SUBORDINATE_CONCURRENCY = 2. A third caller
 *     waits until one of the first two releases.
 *   - PM #23: `abortSignal` is forwarded into runSubordinateAgent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runSubordinateAgentMock = vi.fn();

vi.mock("@/lib/agent/agent", () => ({
  runSubordinateAgent: (...args: unknown[]) =>
    runSubordinateAgentMock(...(args as Parameters<typeof runSubordinateAgentMock>)),
}));

import { callSubordinate } from "./call-subordinate";

/**
 * Sprint 8 — runSubordinateAgent now returns a `SubordinateResult`
 * shape `{ text, usage?, provider, model }` (was raw `string`). Tests
 * use this helper to construct the shape without spelling out the
 * boilerplate every time.
 */
function subResult(
  text: string,
  override: { usage?: { inputTokens?: number; outputTokens?: number } } = {}
): {
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  provider: string;
  model: string;
} {
  return {
    text,
    provider: "openrouter",
    model: "test/model",
    ...override,
  };
}

beforeEach(() => {
  runSubordinateAgentMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("callSubordinate — happy path", () => {
  it("returns a single-string result prefixed with the agent number", async () => {
    runSubordinateAgentMock.mockResolvedValue(subResult("the answer"));
    const result = await callSubordinate("do work", "proj-1", 0, []);
    expect(result).toBe("Subordinate Agent 1 completed the task:\n\nthe answer");
  });

  it("increments the displayed agent number by 1 from parentAgentNumber", async () => {
    runSubordinateAgentMock.mockResolvedValue(subResult("nested"));
    const result = await callSubordinate("x", undefined, 4, []);
    expect(result).toContain("Subordinate Agent 5 completed");
  });

  it("forwards task / projectId / parentAgentNumber / parentHistory verbatim", async () => {
    runSubordinateAgentMock.mockResolvedValue(subResult("ok"));
    const hist = [{ role: "user" as const, content: "previous" }];
    await callSubordinate("verify code", "proj-x", 2, hist);
    expect(runSubordinateAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "verify code",
        projectId: "proj-x",
        parentAgentNumber: 2,
        parentHistory: hist,
      })
    );
  });

  it("forwards abortSignal to runSubordinateAgent (PM #23 contract)", async () => {
    runSubordinateAgentMock.mockResolvedValue(subResult("ok"));
    const controller = new AbortController();
    await callSubordinate("x", undefined, 0, [], controller.signal);
    expect(runSubordinateAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ abortSignal: controller.signal })
    );
  });

  it("Sprint 9 — forwards parentChatId to runSubordinateAgent (closes recursive-subordinate billing leak)", async () => {
    // Pre-Sprint-9 the subordinate's AgentContext.chatId was a synthetic
    // `subordinate-${Date.now()}`. If the subordinate invoked its OWN
    // `call_subordinate` (allowed until agentNumber >= 3), the recursive
    // level bypassed budget enforcement AND spend bubble-up because both
    // targeted a phantom chat that didn't exist on disk. Sprint 9
    // threads the real parent chat id all the way down via the new
    // `parentChatId` option on `runSubordinateAgent`. This test pins
    // the wire: callSubordinate MUST forward parentChatId verbatim,
    // not the synthetic id.
    runSubordinateAgentMock.mockResolvedValue(subResult("ok"));
    await callSubordinate("x", undefined, 0, [], undefined, "real-parent-id");
    expect(runSubordinateAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ parentChatId: "real-parent-id" })
    );
  });

  it("Sprint 9 — omits parentChatId when caller doesn't supply one (no-cap path)", async () => {
    // Some callers (cron, legacy) don't pass parentChatId. The forward
    // must be `undefined`, not a fabricated value — otherwise
    // runSubordinateAgent would use a bogus real-looking id and any
    // downstream bubble-up would write to the wrong chat.
    runSubordinateAgentMock.mockResolvedValue(subResult("ok"));
    await callSubordinate("x", undefined, 0, []);
    const callArgs = runSubordinateAgentMock.mock.calls[0][0];
    expect(callArgs.parentChatId).toBeUndefined();
  });

  it("Sprint 8 — bubbles subordinate usage to parent's cumulativeUsage via updateChat", async () => {
    // Verify the bubble-up contract: callSubordinate, when given a
    // parentChatId AND a subordinate that returned usage, calls
    // updateChat with the parent id and a reducer that grows
    // cumulativeUsage. We assert via spy on the dynamic-imported
    // chat-store module.
    runSubordinateAgentMock.mockResolvedValue(
      subResult("did work", { usage: { inputTokens: 1500, outputTokens: 800 } })
    );
    const chatStore = await import("@/lib/storage/chat-store");
    const updateChatSpy = vi
      .spyOn(chatStore, "updateChat")
      .mockResolvedValue(undefined as unknown as never);

    await callSubordinate("x", undefined, 0, [], undefined, "parent-chat-id");

    // The accumulator imports are dynamic — give them a tick to settle
    // before asserting on the spy.
    await new Promise((r) => setImmediate(r));

    expect(updateChatSpy).toHaveBeenCalledWith(
      "parent-chat-id",
      expect.any(Function)
    );
    // Drive the reducer manually to confirm it grows cumulativeUsage.
    const reducer = updateChatSpy.mock.calls[0][1] as (
      chat: { cumulativeUsage?: unknown }
    ) => unknown;
    const fakeChat: { cumulativeUsage?: unknown } = {};
    reducer(fakeChat);
    expect(fakeChat.cumulativeUsage).toBeDefined();
    expect(
      (fakeChat.cumulativeUsage as { promptTokens?: number })?.promptTokens
    ).toBe(1500);
    expect(
      (fakeChat.cumulativeUsage as { completionTokens?: number })
        ?.completionTokens
    ).toBe(800);

    updateChatSpy.mockRestore();
  });

  it("Sprint 8 — skips bubble-up when parentChatId is omitted (callSubordinate-from-cron path)", async () => {
    runSubordinateAgentMock.mockResolvedValue(
      subResult("ok", { usage: { inputTokens: 100, outputTokens: 50 } })
    );
    const chatStore = await import("@/lib/storage/chat-store");
    const updateChatSpy = vi
      .spyOn(chatStore, "updateChat")
      .mockResolvedValue(undefined as unknown as never);

    // No parentChatId arg → no accumulation possible.
    await callSubordinate("x", undefined, 0, []);
    await new Promise((r) => setImmediate(r));

    expect(updateChatSpy).not.toHaveBeenCalled();
    updateChatSpy.mockRestore();
  });

  it("Sprint 8 — skips bubble-up when subordinate result has no usage (provider quirk)", async () => {
    // `runSubordinateAgent` may return `usage: undefined` if the provider
    // didn't surface it. Don't accumulate zero/undefined — it would
    // pollute cumulativeUsage with a misleading "priced" entry.
    runSubordinateAgentMock.mockResolvedValue(subResult("text", { usage: undefined }));
    const chatStore = await import("@/lib/storage/chat-store");
    const updateChatSpy = vi
      .spyOn(chatStore, "updateChat")
      .mockResolvedValue(undefined as unknown as never);

    await callSubordinate("x", undefined, 0, [], undefined, "parent-id");
    await new Promise((r) => setImmediate(r));

    expect(updateChatSpy).not.toHaveBeenCalled();
    updateChatSpy.mockRestore();
  });

  it("Sprint 8 — bubble-up failure is best-effort: logged, doesn't fail the tool", async () => {
    runSubordinateAgentMock.mockResolvedValue(
      subResult("ok", { usage: { inputTokens: 10, outputTokens: 5 } })
    );
    const chatStore = await import("@/lib/storage/chat-store");
    const updateChatSpy = vi
      .spyOn(chatStore, "updateChat")
      .mockRejectedValue(new Error("disk full"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await callSubordinate("x", undefined, 0, [], undefined, "parent-id");
    await new Promise((r) => setImmediate(r));

    // Tool still returns success — bubble-up is best-effort.
    expect(result).toContain("Subordinate Agent 1 completed");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Failed to accumulate subordinate usage/),
      expect.any(String)
    );
    updateChatSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

describe("callSubordinate — error path (non-retriable)", () => {
  it("returns the formatted error message (never throws)", async () => {
    runSubordinateAgentMock.mockRejectedValue(new Error("boom"));
    const result = await callSubordinate("x", undefined, 0, []);
    expect(result).toMatch(/^Subordinate agent error:/);
    expect(result).toContain("boom");
  });

  it("surfaces status code + code in the formatted message", async () => {
    const err = Object.assign(new Error("Bad request"), {
      statusCode: 400,
      code: "invalid_request",
    });
    runSubordinateAgentMock.mockRejectedValue(err);
    const result = await callSubordinate("x", undefined, 0, []);
    expect(result).toMatch(/status=400/);
    expect(result).toMatch(/code=invalid_request/);
  });

  it("walks nested cause / responseBody / data / error chains for the status code", async () => {
    const err = Object.assign(new Error("wrapped"), {
      cause: { responseBody: { error: { statusCode: 422 } } },
    });
    runSubordinateAgentMock.mockRejectedValue(err);
    const result = await callSubordinate("x", undefined, 0, []);
    expect(result).toMatch(/status=422/);
  });

  it("accepts string-typed statusCode (provider quirk) and parses it as a number", async () => {
    const err = Object.assign(new Error("stringy"), {
      cause: { statusCode: "503" },
    });
    runSubordinateAgentMock.mockRejectedValue(err);
    const result = await callSubordinate("x", undefined, 0, []);
    expect(result).toMatch(/status=503/);
  });

  it("truncates very long error details to 280 chars + ellipsis", async () => {
    // BFS in `getErrorDetail` picks the first found `.message` string.
    // To hit the truncation branch we must (a) supply a long nested
    // message that isn't equal to the outer error.message, otherwise
    // `formatSubordinateError` skips the detail block. Plain-object
    // error means `String(error)` for the outer message → "[object Object]"
    // → never equal to the long body → detail gets appended truncated.
    const longBody = "x".repeat(1000);
    const err = { cause: { message: longBody } };
    runSubordinateAgentMock.mockRejectedValue(err);
    const result = await callSubordinate("x", undefined, 0, []);
    expect(result).toMatch(/\.\.\.$/);
    const tail = result.split(": ").pop() ?? "";
    expect(tail.length).toBeLessThanOrEqual(283);
  });

  it("does NOT retry on a 400-class non-retriable error", async () => {
    const err = Object.assign(new Error("bad request"), { statusCode: 400 });
    runSubordinateAgentMock.mockRejectedValue(err);
    await callSubordinate("x", undefined, 0, []);
    expect(runSubordinateAgentMock).toHaveBeenCalledOnce();
  });

  it("does NOT retry on a 404 not-found", async () => {
    const err = Object.assign(new Error("not found"), { statusCode: 404 });
    runSubordinateAgentMock.mockRejectedValue(err);
    await callSubordinate("x", undefined, 0, []);
    expect(runSubordinateAgentMock).toHaveBeenCalledOnce();
  });

  it("does NOT retry on a plain 'invalid api key' message (no status, not in retry list)", async () => {
    runSubordinateAgentMock.mockRejectedValue(new Error("invalid api key"));
    await callSubordinate("x", undefined, 0, []);
    expect(runSubordinateAgentMock).toHaveBeenCalledOnce();
  });
});

describe("callSubordinate — retry semantics (retriable errors)", () => {
  it("retries up to 2 times on HTTP 429 (rate limit) and returns the eventual success", async () => {
    vi.useFakeTimers();
    runSubordinateAgentMock
      .mockRejectedValueOnce(Object.assign(new Error("429"), { statusCode: 429 }))
      .mockRejectedValueOnce(Object.assign(new Error("429 again"), { statusCode: 429 }))
      .mockResolvedValueOnce(subResult("finally"));

    const promise = callSubordinate("x", undefined, 0, []);
    // Drive the SUBORDINATE_RETRY_DELAYS_MS sleeps forward; 4s is enough
    // for 1000ms + 2500ms + jitter.
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;

    expect(result).toContain("finally");
    expect(runSubordinateAgentMock).toHaveBeenCalledTimes(3);
  });

  it("retries on 'rate limit' substring in the message (no status code)", async () => {
    vi.useFakeTimers();
    runSubordinateAgentMock
      .mockRejectedValueOnce(new Error("rate limit exceeded"))
      .mockResolvedValueOnce(subResult("ok"));

    const promise = callSubordinate("x", undefined, 0, []);
    await vi.advanceTimersByTimeAsync(2000);
    await promise;
    expect(runSubordinateAgentMock).toHaveBeenCalledTimes(2);
  });

  it("retries on HTTP 5xx (server error)", async () => {
    vi.useFakeTimers();
    runSubordinateAgentMock
      .mockRejectedValueOnce(Object.assign(new Error("502"), { statusCode: 502 }))
      .mockResolvedValueOnce(subResult("ok"));
    const promise = callSubordinate("x", undefined, 0, []);
    await vi.advanceTimersByTimeAsync(2000);
    await promise;
    expect(runSubordinateAgentMock).toHaveBeenCalledTimes(2);
  });

  it("retries on 'econnreset' / 'timeout' / 'overloaded' in the message", async () => {
    vi.useFakeTimers();
    for (const phrase of ["econnreset", "timeout", "overloaded"]) {
      runSubordinateAgentMock.mockReset();
      runSubordinateAgentMock
        .mockRejectedValueOnce(new Error(phrase))
        .mockResolvedValueOnce(subResult("ok"));
      const promise = callSubordinate("x", undefined, 0, []);
      await vi.advanceTimersByTimeAsync(2000);
      await promise;
      expect(runSubordinateAgentMock).toHaveBeenCalledTimes(2);
    }
  });

  it("gives up after 3 total attempts (initial + 2 retries) and returns formatted error", async () => {
    vi.useFakeTimers();
    runSubordinateAgentMock.mockRejectedValue(
      Object.assign(new Error("permanently rate limited"), { statusCode: 429 })
    );
    const promise = callSubordinate("x", undefined, 0, []);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await promise;

    expect(runSubordinateAgentMock).toHaveBeenCalledTimes(3);
    expect(result).toMatch(/^Subordinate agent error:/);
    expect(result).toContain("status=429");
  });
});

/**
 * Concurrency-cap coverage (Sprint 8 — closed the gap from `bc0ea1d`).
 *
 * Pre-Sprint-8 the cap (`MAX_SUBORDINATE_CONCURRENCY = 2`) was an
 * untestable module-level global; the previous test attempt deleted as
 * "fragile module state". Sprint 8 extracted the slot accounting into
 * an injectable `SubordinateSlotState` so each test creates its own
 * fresh state and never races shared globals.
 *
 * The `withSubordinateSlot` helper is exported now; tests exercise it
 * directly with a controlled fn that signals when it's running.
 */
import { createSlotState, withSubordinateSlot } from "./call-subordinate";

describe("withSubordinateSlot — concurrency cap via DI (Sprint 8)", () => {
  it("under the cap: 2 callers run in parallel without waiting", async () => {
    const state = createSlotState(2);
    let activeAtPeak = 0;
    let currentActive = 0;
    const enter = () => {
      currentActive += 1;
      if (currentActive > activeAtPeak) activeAtPeak = currentActive;
    };
    const leave = () => {
      currentActive -= 1;
    };
    // Both subordinates take 50ms; with cap=2 they should overlap.
    const slow = async () => {
      enter();
      await new Promise((r) => setTimeout(r, 50));
      leave();
      return "ok";
    };

    const [a, b] = await Promise.all([
      withSubordinateSlot(slow, state),
      withSubordinateSlot(slow, state),
    ]);
    expect(a).toBe("ok");
    expect(b).toBe("ok");
    expect(activeAtPeak).toBe(2);
  });

  it("AT the cap: a third caller waits until a slot is released", async () => {
    const state = createSlotState(2);
    let activeAtPeak = 0;
    let currentActive = 0;

    // Hand-controlled release latches so the test owns the timing.
    let release1: () => void = () => {};
    let release2: () => void = () => {};
    let release3: () => void = () => {};
    const wait = (released: Promise<void>) => async () => {
      currentActive += 1;
      if (currentActive > activeAtPeak) activeAtPeak = currentActive;
      await released;
      currentActive -= 1;
      return "ok";
    };

    const p1 = new Promise<void>((r) => (release1 = r));
    const p2 = new Promise<void>((r) => (release2 = r));
    const p3 = new Promise<void>((r) => (release3 = r));

    const c1 = withSubordinateSlot(wait(p1), state);
    const c2 = withSubordinateSlot(wait(p2), state);
    const c3 = withSubordinateSlot(wait(p3), state);

    // Let microtasks settle so the first two acquire slots.
    await new Promise((r) => setImmediate(r));
    expect(state.activeCount).toBe(2);
    expect(currentActive).toBe(2);
    expect(state.waitQueue.length).toBe(1); // c3 parked

    // Release c1 → c3 should pick up the freed slot.
    release1();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(currentActive).toBe(2); // c2 still running, c3 now in
    expect(state.waitQueue.length).toBe(0);

    release2();
    release3();
    await Promise.all([c1, c2, c3]);
    expect(activeAtPeak).toBe(2); // never exceeded the cap
    expect(state.activeCount).toBe(0); // all released
  });

  it("releases the slot even when the wrapped fn throws", async () => {
    const state = createSlotState(1);
    await expect(
      withSubordinateSlot(async () => {
        throw new Error("boom");
      }, state)
    ).rejects.toThrow("boom");
    expect(state.activeCount).toBe(0); // released despite throw
  });

  it("default state (no DI) is used by production callers", async () => {
    // The exported defaultSlotState is module-private; we just verify the
    // overload accepts an omitted second arg (production callers).
    const r = await withSubordinateSlot(async () => "default-state-ok");
    expect(r).toBe("default-state-ok");
  });
});
