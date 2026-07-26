import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  recordModelFailure,
  recordModelSuccess,
  isModelCircuitOpen,
  getModelHealthSnapshot,
  resetModelHealth,
  selectHealthyConfig,
  modelHealthKey,
  tryAcquireProbe,
  classifyModelFailure,
} from "./model-health";

const P = "openrouter";
const M = "vendor/dead-model:free";
const ALT = "vendor/alive-model:free";

function failTimes(n: number, model = M): void {
  for (let i = 0; i < n; i++) recordModelFailure(P, model, "empty");
}

describe("model-health circuit breaker", () => {
  beforeEach(() => {
    resetModelHealth();
    delete process.env.ORCHESTRA_MODEL_CIRCUIT_DISABLED;
    delete process.env.ORCHESTRA_MODEL_CIRCUIT_THRESHOLD;
    delete process.env.ORCHESTRA_MODEL_CIRCUIT_COOLDOWN_MS;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("stays closed below the failure threshold", () => {
    failTimes(2);
    expect(isModelCircuitOpen(P, M)).toBe(false);
  });

  it("opens at the threshold (3 consecutive failures)", () => {
    failTimes(3);
    expect(isModelCircuitOpen(P, M)).toBe(true);
  });

  it("a success resets the consecutive count so the next 2 failures don't open it", () => {
    failTimes(2);
    recordModelSuccess(P, M);
    failTimes(2);
    expect(isModelCircuitOpen(P, M)).toBe(false);
  });

  it("a success on an OPEN circuit closes it", () => {
    failTimes(3);
    expect(isModelCircuitOpen(P, M)).toBe(true);
    recordModelSuccess(P, M);
    expect(isModelCircuitOpen(P, M)).toBe(false);
  });

  it("honors ORCHESTRA_MODEL_CIRCUIT_THRESHOLD", () => {
    process.env.ORCHESTRA_MODEL_CIRCUIT_THRESHOLD = "2";
    failTimes(2);
    expect(isModelCircuitOpen(P, M)).toBe(true);
  });

  it("is a strict no-op when ORCHESTRA_MODEL_CIRCUIT_DISABLED=true", () => {
    process.env.ORCHESTRA_MODEL_CIRCUIT_DISABLED = "true";
    failTimes(10);
    expect(isModelCircuitOpen(P, M)).toBe(false);
    expect(getModelHealthSnapshot()).toHaveLength(0);
  });

  it("does not disable on a sloppy truthy value (strict string compare)", () => {
    process.env.ORCHESTRA_MODEL_CIRCUIT_DISABLED = "1";
    failTimes(3);
    expect(isModelCircuitOpen(P, M)).toBe(true);
  });

  it("keys endpoints independently", () => {
    failTimes(3);
    expect(isModelCircuitOpen(P, M)).toBe(true);
    expect(isModelCircuitOpen(P, ALT)).toBe(false);
  });

  describe("cooldown / half-open probe (DoubleTake #3)", () => {
    const COOLDOWN = 5 * 60_000;

    it("the read is PURE — a tripped circuit stays tripped until a SUCCESS heals it", () => {
      vi.useFakeTimers();
      failTimes(3);
      expect(isModelCircuitOpen(P, M)).toBe(true);
      vi.advanceTimersByTime(COOLDOWN + 1);
      // Cooldown elapsed, but reading must not silently heal the entry — that
      // was the bug: every proposer in the fan-out then saw "closed" at once.
      expect(isModelCircuitOpen(P, M)).toBe(true);
      expect(isModelCircuitOpen(P, M)).toBe(true);
    });

    it("hands out NO probe inside the cooldown window", () => {
      vi.useFakeTimers();
      failTimes(3);
      vi.advanceTimersByTime(60_000);
      expect(tryAcquireProbe(P, M)).toBe(false);
    });

    it("hands out EXACTLY ONE probe once the cooldown elapses (no thundering herd)", () => {
      vi.useFakeTimers();
      failTimes(3);
      vi.advanceTimersByTime(COOLDOWN + 1);
      expect(tryAcquireProbe(P, M)).toBe(true);
      // Four more concurrent proposers must all be refused.
      expect(tryAcquireProbe(P, M)).toBe(false);
      expect(tryAcquireProbe(P, M)).toBe(false);
      expect(tryAcquireProbe(P, M)).toBe(false);
      expect(tryAcquireProbe(P, M)).toBe(false);
    });

    it("always allows dispatch on an untripped endpoint", () => {
      expect(tryAcquireProbe(P, ALT)).toBe(true);
      failTimes(2); // below threshold
      expect(tryAcquireProbe(P, M)).toBe(true);
    });

    it("a FAILED probe restarts the cooldown and frees the probe slot", () => {
      vi.useFakeTimers();
      failTimes(3);
      vi.advanceTimersByTime(COOLDOWN + 1);
      expect(tryAcquireProbe(P, M)).toBe(true);
      recordModelFailure(P, M, "throttle"); // probe failed
      expect(isModelCircuitOpen(P, M)).toBe(true);
      // Cooldown restarted from NOW — no probe until it elapses again.
      vi.advanceTimersByTime(COOLDOWN - 1000);
      expect(tryAcquireProbe(P, M)).toBe(false);
      vi.advanceTimersByTime(2000);
      expect(tryAcquireProbe(P, M)).toBe(true);
    });

    it("a SUCCESSFUL probe fully heals the endpoint", () => {
      vi.useFakeTimers();
      failTimes(3);
      vi.advanceTimersByTime(COOLDOWN + 1);
      tryAcquireProbe(P, M);
      recordModelSuccess(P, M);
      expect(isModelCircuitOpen(P, M)).toBe(false);
      recordModelFailure(P, M, "empty");
      expect(isModelCircuitOpen(P, M)).toBe(false); // needs 3 again, not 1
    });

    it("honors ORCHESTRA_MODEL_CIRCUIT_COOLDOWN_MS", () => {
      vi.useFakeTimers();
      process.env.ORCHESTRA_MODEL_CIRCUIT_COOLDOWN_MS = "1000";
      failTimes(3);
      expect(tryAcquireProbe(P, M)).toBe(false);
      vi.advanceTimersByTime(1001);
      expect(tryAcquireProbe(P, M)).toBe(true);
    });
  });

  describe("classifyModelFailure — positive evidence only (DoubleTake #4)", () => {
    it("counts throttling", () => {
      expect(classifyModelFailure(new Error("429 Too Many Requests"))).toBe("throttle");
      expect(classifyModelFailure(new Error("Rate limit exceeded"))).toBe("throttle");
      expect(classifyModelFailure(new Error("model is overloaded"))).toBe("throttle");
    });

    it("counts upstream server failures", () => {
      expect(classifyModelFailure(new Error("503 Service Unavailable"))).toBe("server");
      expect(classifyModelFailure(new Error("Provider returned error"))).toBe("server");
    });

    it("counts network / timeout failures", () => {
      expect(classifyModelFailure(new Error("The operation timed out"))).toBe("unreachable");
      expect(classifyModelFailure(new Error("fetch failed"))).toBe("unreachable");
      expect(classifyModelFailure(new Error("ECONNRESET"))).toBe("unreachable");
    });

    it("does NOT count OUR faults — an over-long prompt or a full semaphore queue", () => {
      expect(
        classifyModelFailure(new Error("This model's maximum context length is 8192 tokens"))
      ).toBeNull();
      expect(
        classifyModelFailure(new Error("[Semaphore] Queue full (200 tasks waiting)"))
      ).toBeNull();
      expect(classifyModelFailure(new Error("invalid_request_error"))).toBeNull();
    });

    it("does NOT count an unrecognised error — a breaker must open on evidence, not ignorance", () => {
      expect(classifyModelFailure(new TypeError("x.map is not a function"))).toBeNull();
      expect(classifyModelFailure(undefined)).toBeNull();
      expect(classifyModelFailure("something odd")).toBeNull();
    });
  });

  describe("snapshot", () => {
    it("reports counters and the open timestamp", () => {
      failTimes(3);
      recordModelSuccess(P, ALT);
      const snap = getModelHealthSnapshot();
      expect(snap).toHaveLength(2);
      const dead = snap.find((e) => e.model === M)!;
      expect(dead.consecutiveFailures).toBe(3);
      expect(dead.totalFailures).toBe(3);
      expect(dead.lastFailureKind).toBe("empty");
      expect(dead.openedAt).toBeTypeOf("number");
      const alive = snap.find((e) => e.model === ALT)!;
      expect(alive.totalSuccesses).toBe(1);
      expect(alive.openedAt).toBeNull();
    });

    it("returns copies, not live references", () => {
      failTimes(1);
      const snap = getModelHealthSnapshot();
      snap[0].consecutiveFailures = 99;
      expect(getModelHealthSnapshot()[0].consecutiveFailures).toBe(1);
    });
  });
});

describe("selectHealthyConfig", () => {
  const preferred = { provider: P, model: M };
  const alt = { provider: P, model: ALT };
  const alt2 = { provider: P, model: "vendor/third:free" };

  beforeEach(() => {
    resetModelHealth();
    delete process.env.ORCHESTRA_MODEL_CIRCUIT_DISABLED;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it("returns the preferred config when its circuit is closed", () => {
    const sel = selectHealthyConfig(preferred, [alt]);
    expect(sel.config).toBe(preferred);
    expect(sel.substituted).toBe(false);
    expect(sel.substitutedFrom).toBeUndefined();
  });

  it("substitutes the first healthy candidate when the preferred is open", () => {
    failTimes(3);
    const sel = selectHealthyConfig(preferred, [alt, alt2]);
    expect(sel.config).toBe(alt);
    expect(sel.substituted).toBe(true);
    expect(sel.substitutedFrom).toBe(modelHealthKey(P, M));
  });

  it("skips candidates whose circuits are also open", () => {
    failTimes(3);
    failTimes(3, ALT);
    const sel = selectHealthyConfig(preferred, [alt, alt2]);
    expect(sel.config).toBe(alt2);
    expect(sel.substituted).toBe(true);
  });

  it("fails OPEN (returns preferred) when every candidate is dead", () => {
    failTimes(3);
    failTimes(3, ALT);
    failTimes(3, alt2.model);
    const sel = selectHealthyConfig(preferred, [alt, alt2]);
    expect(sel.config).toBe(preferred);
    expect(sel.substituted).toBe(false);
  });

  it("fails OPEN with an empty candidate pool", () => {
    failTimes(3);
    expect(selectHealthyConfig(preferred).config).toBe(preferred);
  });

  it("ignores a candidate identical to the preferred endpoint", () => {
    failTimes(3);
    const dup = { provider: P, model: M };
    const sel = selectHealthyConfig(preferred, [dup, alt]);
    expect(sel.config).toBe(alt);
  });

  it("de-duplicates repeated candidates", () => {
    failTimes(3);
    failTimes(3, ALT);
    const sel = selectHealthyConfig(preferred, [alt, alt, alt2]);
    expect(sel.config).toBe(alt2);
  });

  it("rotates the pool by `offset` so concurrent proposers pick DIFFERENT substitutes", () => {
    failTimes(3);
    // Same dead preferred model, three proposers with different indices.
    expect(selectHealthyConfig(preferred, [alt, alt2], 0).config).toBe(alt);
    expect(selectHealthyConfig(preferred, [alt, alt2], 1).config).toBe(alt2);
    expect(selectHealthyConfig(preferred, [alt, alt2], 2).config).toBe(alt); // wraps
  });

  it("ignores the offset when the pool has a single entry", () => {
    failTimes(3);
    expect(selectHealthyConfig(preferred, [alt], 7).config).toBe(alt);
  });

  it("spends the half-open probe when EVERY candidate is tripped", () => {
    vi.useFakeTimers();
    failTimes(3);
    failTimes(3, ALT);
    // Inside the cooldown → no probe, fail open on the operator's choice.
    expect(selectHealthyConfig(preferred, [alt]).probe).toBeUndefined();
    vi.advanceTimersByTime(5 * 60_000 + 1);
    const probed = selectHealthyConfig(preferred, [alt]);
    expect(probed.probe).toBe(true);
    expect(probed.config).toBe(preferred); // the operator's model probes first
    // A concurrent proposer must NOT also probe the same endpoint.
    const second = selectHealthyConfig(preferred, [alt]);
    expect(second.config === preferred && second.probe).toBeFalsy();
    vi.useRealTimers();
  });

  it("skips malformed candidates without throwing", () => {
    failTimes(3);
    const bad = { provider: "", model: "" };
    const sel = selectHealthyConfig(preferred, [bad, alt]);
    expect(sel.config).toBe(alt);
  });
});
