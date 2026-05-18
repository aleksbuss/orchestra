/**
 * Tests for combineWithTimeout — exercises both the AbortSignal.any fast
 * path AND the manual fallback that exists for Node 20.0–20.2.
 *
 * The manual fallback was the original Defect #5 in the 2026-05 audit: an
 * earlier ad-hoc helper returned `parent` alone when AbortSignal.any was
 * missing, silently dropping the timeout.
 *
 * NOTE: We use real timers with very short delays (5–20ms). `AbortSignal.timeout`
 * doesn't reliably interleave with vitest's fake timers in all environments.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { combineWithTimeout } from "./abort-signal";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("combineWithTimeout — AbortSignal.any fast path", () => {
  it("returns a signal that fires on parent abort", () => {
    const parent = new AbortController();
    const combined = combineWithTimeout(parent.signal, 10_000);
    expect(combined.aborted).toBe(false);

    parent.abort();
    expect(combined.aborted).toBe(true);
  });

  it("returns a signal that fires on timeout", async () => {
    const parent = new AbortController();
    const combined = combineWithTimeout(parent.signal, 5);
    expect(combined.aborted).toBe(false);

    await wait(30);
    expect(combined.aborted).toBe(true);
    expect(parent.signal.aborted).toBe(false);
  });

  it("returns a timeout-only signal when parent is undefined", async () => {
    const combined = combineWithTimeout(undefined, 5);
    expect(combined.aborted).toBe(false);
    await wait(30);
    expect(combined.aborted).toBe(true);
  });
});

describe("combineWithTimeout — manual fallback (AbortSignal.any unavailable)", () => {
  let originalAny: typeof AbortSignal.any | undefined;

  beforeEach(() => {
    originalAny = AbortSignal.any;
    // Simulate a Node 20.0–20.2 runtime by removing AbortSignal.any.
    // @ts-expect-error: deliberately removing a static method for the test
    delete AbortSignal.any;
  });

  afterEach(() => {
    if (originalAny) AbortSignal.any = originalAny;
  });

  it("still aborts on parent in fallback mode", () => {
    const parent = new AbortController();
    const combined = combineWithTimeout(parent.signal, 10_000);
    expect(combined.aborted).toBe(false);

    parent.abort();
    expect(combined.aborted).toBe(true);
  });

  it("still aborts on timeout in fallback mode (this was the Defect #5 bug)", async () => {
    const parent = new AbortController();
    const combined = combineWithTimeout(parent.signal, 5);
    expect(combined.aborted).toBe(false);

    await wait(30);
    expect(combined.aborted).toBe(true);
    // Crucial: the parent never aborted, only the timeout did. Old code
    // returned `parent` here and the timeout was silently dropped.
    expect(parent.signal.aborted).toBe(false);
  });

  it("propagates an already-aborted parent immediately", () => {
    const parent = new AbortController();
    parent.abort();
    const combined = combineWithTimeout(parent.signal, 10_000);
    expect(combined.aborted).toBe(true);
  });
});
