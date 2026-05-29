/**
 * Tests for `boundedBootProbe` — pins the three exit paths:
 *   1. Probe resolves within budget → returns its value, no log noise.
 *   2. Probe rejects → caught, logged, returns undefined (no rethrow).
 *   3. Probe hangs past budget → timeout log fires, returns undefined.
 *
 * Boot probes are fire-and-forget; the boundedBootProbe contract is that
 * the boot scope NEVER sees an unhandled rejection or a never-resolving
 * promise, regardless of how the probe behaves. These tests pin that.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { boundedBootProbe } from "./boot-probe";

// Inferred type — vitest's ReturnType-based annotations are fragile across
// console method overloads; let the compiler infer from vi.spyOn directly.
let warnSpy = vi.spyOn(console, "warn");

beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe("boundedBootProbe — success path", () => {
  it("returns the probe's resolved value when it finishes in time", async () => {
    const result = await boundedBootProbe(
      { name: "Test", timeoutMs: 100 },
      async () => "ok"
    );
    expect(result).toBe("ok");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("handles a resolved-value-of-undefined the same as any other value", async () => {
    const result = await boundedBootProbe(
      { name: "Test", timeoutMs: 100 },
      async () => undefined
    );
    expect(result).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("preserves the typed return shape", async () => {
    const result = await boundedBootProbe<{ x: number }>(
      { name: "Test", timeoutMs: 100 },
      async () => ({ x: 42 })
    );
    expect(result).toEqual({ x: 42 });
  });
});

describe("boundedBootProbe — rejection path", () => {
  it("catches probe rejections and returns undefined (no rethrow)", async () => {
    const result = await boundedBootProbe(
      { name: "Test", timeoutMs: 100 },
      async () => {
        throw new Error("boom");
      }
    );
    expect(result).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toMatch(/\[Test\] boot probe failed/);
  });

  it("includes the error in the log line", async () => {
    await boundedBootProbe({ name: "X", timeoutMs: 100 }, async () => {
      throw new Error("specific-error-message");
    });
    expect(warnSpy.mock.calls[0][1]).toBeInstanceOf(Error);
    expect((warnSpy.mock.calls[0][1] as Error).message).toBe(
      "specific-error-message"
    );
  });
});

describe("boundedBootProbe — timeout path", () => {
  it("returns undefined and logs when the probe outruns the budget", async () => {
    const result = await boundedBootProbe(
      { name: "SlowProbe", timeoutMs: 20 },
      () =>
        new Promise<string>((resolve) => {
          // Resolves after the budget — exact value never observed.
          setTimeout(() => resolve("late"), 200);
        })
    );
    expect(result).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toMatch(
      /\[SlowProbe\] boot probe timed out after 20ms/
    );
  });

  it("returns undefined when the probe never resolves at all", async () => {
    const result = await boundedBootProbe(
      { name: "Hang", timeoutMs: 10 },
      () => new Promise<string>(() => {})
    );
    expect(result).toBeUndefined();
  });
});
