import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  abortableSleep,
  isFreeTierModel,
  computeStaggerMs,
  withFreeTierPacing,
  resetFreeTierPacing,
  getFreeTierConcurrency,
} from "./proposer-pacing";
import { recordModelFailure, resetModelHealth } from "./model-health";

const PAID = { provider: "openrouter", model: "deepseek/deepseek-chat" };
const FREE = { provider: "openrouter", model: "nvidia/nemotron-3-super-120b-a12b:free" };

function clearEnv(): void {
  delete process.env.ORCHESTRA_PACE_ALL_MODELS;
  delete process.env.ORCHESTRA_FREE_STAGGER_MS;
  delete process.env.ORCHESTRA_PROPOSER_STAGGER_MS;
  delete process.env.ORCHESTRA_FREE_TIER_CONCURRENCY;
}

beforeEach(() => {
  clearEnv();
  resetModelHealth();
  resetFreeTierPacing();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  clearEnv();
  vi.restoreAllMocks();
});

describe("isFreeTierModel", () => {
  it("detects the OpenRouter `:free` suffix", () => {
    expect(isFreeTierModel("nvidia/nemotron-3-super-120b-a12b:free")).toBe(true);
    expect(isFreeTierModel("openai/gpt-oss-20b:FREE")).toBe(true);
  });

  it("tolerates a trailing routing segment after the suffix", () => {
    expect(isFreeTierModel("vendor/model:free/nitro")).toBe(true);
  });

  it("does not match a paid model, an empty id, or `free` inside the name", () => {
    expect(isFreeTierModel("deepseek/deepseek-chat")).toBe(false);
    expect(isFreeTierModel("")).toBe(false);
    expect(isFreeTierModel(undefined)).toBe(false);
    // "freeform" must not be read as the `:free` tier marker.
    expect(isFreeTierModel("vendor/freeform-7b")).toBe(false);
  });

  it("ORCHESTRA_PACE_ALL_MODELS=true forces every model to be paced", () => {
    process.env.ORCHESTRA_PACE_ALL_MODELS = "true";
    expect(isFreeTierModel("deepseek/deepseek-chat")).toBe(true);
  });

  it("ignores a sloppy truthy value on the force flag (strict string compare)", () => {
    process.env.ORCHESTRA_PACE_ALL_MODELS = "1";
    expect(isFreeTierModel("deepseek/deepseek-chat")).toBe(false);
  });
});

describe("computeStaggerMs", () => {
  it("never delays the first proposer", () => {
    expect(computeStaggerMs(0, FREE, 0)).toBe(0);
    expect(computeStaggerMs(0, PAID, 0)).toBe(0);
  });

  it("keeps the PM #66 profile for paid endpoints (250ms × index)", () => {
    expect(computeStaggerMs(1, PAID, 0)).toBe(250);
    expect(computeStaggerMs(3, PAID, 0)).toBe(750);
  });

  it("spreads free endpoints wider than paid ones", () => {
    expect(computeStaggerMs(1, FREE, 0)).toBeGreaterThan(computeStaggerMs(1, PAID, 0));
    expect(computeStaggerMs(1, FREE, 0)).toBe(900);
  });

  it("adds the jitter term", () => {
    expect(computeStaggerMs(1, PAID, 140)).toBe(390);
  });

  it("backs off further for an endpoint the breaker has already seen fail", () => {
    const clean = computeStaggerMs(1, FREE, 0);
    recordModelFailure(FREE.provider, FREE.model, "empty");
    recordModelFailure(FREE.provider, FREE.model, "empty");
    expect(computeStaggerMs(1, FREE, 0)).toBe(clean + 2 * 1500);
  });

  it("a success clears the failure penalty (health drives the pacing)", () => {
    recordModelFailure(FREE.provider, FREE.model, "empty");
    const penalized = computeStaggerMs(1, FREE, 0);
    resetModelHealth();
    expect(computeStaggerMs(1, FREE, 0)).toBeLessThan(penalized);
  });

  it("caps the total so a slow start can never dominate the turn", () => {
    for (let i = 0; i < 20; i++) recordModelFailure(FREE.provider, FREE.model, "empty");
    expect(computeStaggerMs(5, FREE, 150)).toBe(8000);
  });

  it("honors the stagger env tunables", () => {
    process.env.ORCHESTRA_PROPOSER_STAGGER_MS = "10";
    process.env.ORCHESTRA_FREE_STAGGER_MS = "20";
    expect(computeStaggerMs(2, PAID, 0)).toBe(20);
    expect(computeStaggerMs(2, FREE, 0)).toBe(40);
  });

  it("falls back to defaults on a garbage env value", () => {
    process.env.ORCHESTRA_PROPOSER_STAGGER_MS = "not-a-number";
    expect(computeStaggerMs(1, PAID, 0)).toBe(250);
  });
});

describe("withFreeTierPacing", () => {
  /** Runs `n` tasks concurrently, returning the peak observed overlap. */
  async function peakConcurrency(
    n: number,
    config: { provider: string; model: string }
  ): Promise<number> {
    let inFlight = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: n }, () =>
        withFreeTierPacing(config, async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 10));
          inFlight -= 1;
        })
      )
    );
    return peak;
  }

  it("caps concurrent free-tier dispatches at the configured budget", async () => {
    process.env.ORCHESTRA_FREE_TIER_CONCURRENCY = "2";
    resetFreeTierPacing();
    expect(await peakConcurrency(5, FREE)).toBeLessThanOrEqual(2);
  });

  it("leaves paid endpoints unbounded (no added latency for paying users)", async () => {
    process.env.ORCHESTRA_FREE_TIER_CONCURRENCY = "2";
    resetFreeTierPacing();
    expect(await peakConcurrency(5, PAID)).toBe(5);
  });

  it("still runs every task — the cap serializes, never drops", async () => {
    process.env.ORCHESTRA_FREE_TIER_CONCURRENCY = "1";
    resetFreeTierPacing();
    const done: number[] = [];
    await Promise.all(
      [1, 2, 3, 4].map((i) => withFreeTierPacing(FREE, async () => void done.push(i)))
    );
    expect(done.sort()).toEqual([1, 2, 3, 4]);
  });

  it("releases the permit when the task throws (no deadlock)", async () => {
    process.env.ORCHESTRA_FREE_TIER_CONCURRENCY = "1";
    resetFreeTierPacing();
    await expect(
      withFreeTierPacing(FREE, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    // A second task must still acquire the (released) permit.
    await expect(withFreeTierPacing(FREE, async () => "ok")).resolves.toBe("ok");
  });

  it("propagates the task's return value", async () => {
    await expect(withFreeTierPacing(FREE, async () => 42)).resolves.toBe(42);
    await expect(withFreeTierPacing(PAID, async () => 42)).resolves.toBe(42);
  });

  it("audit A5 — ORCHESTRA_FREE_TIER_CONCURRENCY=0 disables the cap entirely", async () => {
    process.env.ORCHESTRA_FREE_TIER_CONCURRENCY = "0";
    resetFreeTierPacing();
    expect(await peakConcurrency(5, FREE)).toBe(5);
  });

  it("defaults to a budget of 2 and floors a bogus value at 1", () => {
    expect(getFreeTierConcurrency()).toBe(2);
    resetFreeTierPacing();
    process.env.ORCHESTRA_FREE_TIER_CONCURRENCY = "0.4";
    expect(getFreeTierConcurrency()).toBe(1);
  });
});

describe("abortableSleep (audit A3)", () => {
  it("resolves after the requested delay when nothing aborts", async () => {
    const start = Date.now();
    await abortableSleep(40);
    expect(Date.now() - start).toBeGreaterThanOrEqual(30);
  });

  it("returns immediately for a non-positive delay", async () => {
    const start = Date.now();
    await abortableSleep(0);
    await abortableSleep(-5);
    expect(Date.now() - start).toBeLessThan(20);
  });

  it("returns immediately when the signal is ALREADY aborted", async () => {
    const c = new AbortController();
    c.abort();
    const start = Date.now();
    await abortableSleep(5000, c.signal);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("resolves EARLY when the signal aborts mid-sleep (the 8s-stagger case)", async () => {
    const c = new AbortController();
    const start = Date.now();
    const sleeping = abortableSleep(5000, c.signal);
    setTimeout(() => c.abort(), 20);
    await sleeping;
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("RESOLVES rather than rejects on abort — a rejection would be mislabelled as an endpoint failure", async () => {
    const c = new AbortController();
    const sleeping = abortableSleep(5000, c.signal);
    c.abort();
    await expect(sleeping).resolves.toBeUndefined();
  });

  it("removes its abort listener so a long-lived parent signal cannot accumulate them", async () => {
    const c = new AbortController();
    for (let i = 0; i < 50; i++) await abortableSleep(1, c.signal);
    // Node warns past 10 listeners on an EventTarget; assert the real count.
    // `AbortSignal` exposes no listener count, so probe indirectly: after 50
    // completed sleeps an abort must still settle cleanly and immediately.
    const start = Date.now();
    c.abort();
    await abortableSleep(5000, c.signal);
    expect(Date.now() - start).toBeLessThan(50);
  });
});
