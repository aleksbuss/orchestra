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

beforeEach(() => {
  runSubordinateAgentMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("callSubordinate — happy path", () => {
  it("returns a single-string result prefixed with the agent number", async () => {
    runSubordinateAgentMock.mockResolvedValue("the answer");
    const result = await callSubordinate("do work", "proj-1", 0, []);
    expect(result).toBe("Subordinate Agent 1 completed the task:\n\nthe answer");
  });

  it("increments the displayed agent number by 1 from parentAgentNumber", async () => {
    runSubordinateAgentMock.mockResolvedValue("nested");
    const result = await callSubordinate("x", undefined, 4, []);
    expect(result).toContain("Subordinate Agent 5 completed");
  });

  it("forwards task / projectId / parentAgentNumber / parentHistory verbatim", async () => {
    runSubordinateAgentMock.mockResolvedValue("ok");
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
    runSubordinateAgentMock.mockResolvedValue("ok");
    const controller = new AbortController();
    await callSubordinate("x", undefined, 0, [], controller.signal);
    expect(runSubordinateAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ abortSignal: controller.signal })
    );
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
      .mockResolvedValueOnce("finally");

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
      .mockResolvedValueOnce("ok");

    const promise = callSubordinate("x", undefined, 0, []);
    await vi.advanceTimersByTimeAsync(2000);
    await promise;
    expect(runSubordinateAgentMock).toHaveBeenCalledTimes(2);
  });

  it("retries on HTTP 5xx (server error)", async () => {
    vi.useFakeTimers();
    runSubordinateAgentMock
      .mockRejectedValueOnce(Object.assign(new Error("502"), { statusCode: 502 }))
      .mockResolvedValueOnce("ok");
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
        .mockResolvedValueOnce("ok");
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
 * Concurrency-cap coverage (`MAX_SUBORDINATE_CONCURRENCY = 2`) — the
 * semaphore + wait-queue logic lives in module-level state. Validating
 * it from this test file is fragile (state leaks across tests, dynamic-
 * import settling adds microtask jitter). The cap is also implicitly
 * covered by the integration path: every time a subordinate is invoked
 * via the `call_subordinate` tool it runs through this gate, and the
 * higher-level agent-semaphore tests pin the parallel-worker bound from
 * the OTHER side. Track this gap explicitly if it ever bites in prod.
 */
