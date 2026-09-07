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
  isPermanentFailureKind,
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

    // Live-observed 2026-08-30/31: an `AI_RetryError` wrapping four exhausted
    // attempts against a rate-limited free endpoint carried the message
    // "Failed after 4 attempts. Last error: Provider returned error" — matching
    // the "server" branch above via text alone, even though the real cause
    // (unwrapped from `.lastError`) was a 429. The breaker's own telemetry was
    // silently lying about why every free model kept tripping.
    it("prefers a real statusCode over message-text guessing — 429 is throttle even when the message says 'provider returned error'", () => {
      const err = Object.assign(new Error("Provider returned error"), { statusCode: 429 });
      expect(classifyModelFailure(err)).toBe("throttle");
    });

    it("unwraps AI_RetryError.lastError to find the real statusCode", () => {
      const apiErr = Object.assign(new Error("Provider returned error"), { statusCode: 429 });
      const retryErr = Object.assign(
        new Error("Failed after 4 attempts. Last error: Provider returned error"),
        { name: "AI_RetryError", lastError: apiErr }
      );
      expect(classifyModelFailure(retryErr)).toBe("throttle");
    });

    it("a real 5xx statusCode still classifies as server", () => {
      const err = Object.assign(new Error("Provider returned error"), { statusCode: 502 });
      expect(classifyModelFailure(err)).toBe("server");
    });

    it("falls back to message-text matching when there is no statusCode at all (unchanged behavior)", () => {
      expect(classifyModelFailure(new Error("Provider returned error"))).toBe("server");
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

// ────────────────────────────────────────────────────────────
// PM #127 — the PERMANENT failure class
// ────────────────────────────────────────────────────────────

/**
 * OpenRouter gates some `:free` endpoints behind a registered-app allowlist and
 * answers HTTP 403 with `metadata.failed_routing_step: "Gate Free Endpoints by
 * Agentic Harness"`. Before this, `classifyModelFailure` matched no branch,
 * returned `null`, and the breaker never learned — so every proposer in the
 * fan-out, on every future turn, kept being dispatched to an endpoint that was
 * guaranteed to refuse. Detection is by STATUS, never by the vendor's prose.
 */
describe("permanent refusal (PM #127)", () => {
  beforeEach(() => {
    resetModelHealth();
    delete process.env.ORCHESTRA_MODEL_CIRCUIT_DISABLED;
    delete process.env.ORCHESTRA_MODEL_UNUSABLE_COOLDOWN_MS;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  /** The real shape: the AI SDK's APICallError carries `statusCode`. */
  function apiError(statusCode: number, message: string): Error {
    return Object.assign(new Error(message), { statusCode });
  }

  it("classifies a 403 as `unusable` — the provider refused to serve this model", () => {
    const err = apiError(
      403,
      "thinkingmachines/inkling:free is only available on agentic harnesses. " +
        "Try plugging it into a coding agent or productivity app listed on https://openrouter.ai/apps"
    );
    expect(classifyModelFailure(err)).toBe("unusable");
  });

  it("classifies a corroborated 403 wrapped in AI_RetryError.lastError too", () => {
    // The status is unwrapped from `lastError`; the corroborating phrase rides
    // on the wrapper's own message, which is what the SDK actually produces.
    const wrapped = Object.assign(
      new Error(
        "Failed after 3 attempts. Last error: x:free is only available on agentic harnesses."
      ),
      { lastError: apiError(403, "Forbidden") }
    );
    expect(classifyModelFailure(wrapped)).toBe("unusable");
  });

  it("classifies a 404 as `unusable` — the model id does not exist upstream", () => {
    expect(classifyModelFailure(apiError(404, "No endpoints found"))).toBe("unusable");
  });

  it("does NOT blame the model for a 401 — that is OUR credential", () => {
    expect(classifyModelFailure(apiError(401, "No auth credentials found"))).toBeNull();
  });

  it("still prefers the status: a 429 is a throttle even with refusal-shaped prose", () => {
    expect(
      classifyModelFailure(apiError(429, "only available on agentic harnesses"))
    ).toBe("throttle");
  });

  it("falls back to the exact vendor phrase ONLY when no status survived", () => {
    expect(
      classifyModelFailure(new Error("x is only available on agentic harnesses. Try..."))
    ).toBe("unusable");
    // A near-miss must not match — the fallback is an exact multi-word phrase.
    expect(classifyModelFailure(new Error("only available on weekdays"))).toBeNull();
  });

  it("a local fault still wins over the prose fallback", () => {
    expect(
      classifyModelFailure(
        new Error("invalid request: only available on agentic harnesses")
      )
    ).toBeNull();
  });

  it("opens the circuit on the FIRST unusable failure, not the third", () => {
    expect(isModelCircuitOpen(P, M)).toBe(false);
    recordModelFailure(P, M, "unusable");
    expect(isModelCircuitOpen(P, M)).toBe(true);
  });

  it("a transient kind still needs the full threshold (unchanged)", () => {
    recordModelFailure(P, M, "empty");
    recordModelFailure(P, M, "empty");
    expect(isModelCircuitOpen(P, M)).toBe(false);
    recordModelFailure(P, M, "empty");
    expect(isModelCircuitOpen(P, M)).toBe(true);
  });

  it("does NOT re-probe an unusable endpoint on the transient 5-minute schedule", () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    recordModelFailure(P, M, "unusable");

    // Well past the 5-minute transient cooldown…
    vi.spyOn(Date, "now").mockReturnValue(now + 10 * 60_000);
    expect(tryAcquireProbe(P, M)).toBe(false);

    // …but past its own (24h) cooldown it becomes probeable again: a vendor
    // allowlist is a business setting, so "permanent" is a TTL, not forever.
    vi.spyOn(Date, "now").mockReturnValue(now + 25 * 60 * 60_000);
    expect(tryAcquireProbe(P, M)).toBe(true);
  });

  it("a refused endpoint is substituted away from immediately", () => {
    const preferred = { provider: P, model: M };
    const alt = { provider: P, model: ALT };
    recordModelFailure(P, M, "unusable");
    const sel = selectHealthyConfig(preferred, [alt]);
    expect(sel.substituted).toBe(true);
    expect(sel.config).toBe(alt);
  });
});

/**
 * PM #127 AUDIT findings. Each of these pins a defect the first cut shipped
 * with — found by an external 4-model council review plus a direct probe.
 */
describe("PM #127 audit — defects the first cut shipped", () => {
  beforeEach(() => {
    resetModelHealth();
    delete process.env.ORCHESTRA_MODEL_CIRCUIT_DISABLED;
    delete process.env.ORCHESTRA_MODEL_UNUSABLE_COOLDOWN_MS;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  function apiError(statusCode: number, message: string, extra: object = {}): Error {
    return Object.assign(new Error(message), { statusCode, ...extra });
  }

  /**
   * The fan-out is parallel: siblings hit one endpoint and can report DIFFERENT
   * kinds. `lastFailureKind` is last-writer-wins, so a timeout landing after a
   * 403 used to silently downgrade the 24h quarantine to the 5-minute schedule.
   */
  it("a sibling proposer's transient failure cannot downgrade a permanent quarantine", () => {
    const t0 = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(t0);

    recordModelFailure(P, M, "unusable"); // proposer A: 403
    recordModelFailure(P, M, "unreachable"); // proposer B, same turn: timeout

    vi.spyOn(Date, "now").mockReturnValue(t0 + 10 * 60_000); // past 5 min, far short of 24h
    expect(tryAcquireProbe(P, M)).toBe(false);
  });

  it("a permanent refusal UPGRADES a circuit already open on a transient kind", () => {
    const t0 = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(t0);

    recordModelFailure(P, M, "empty");
    recordModelFailure(P, M, "empty");
    recordModelFailure(P, M, "empty"); // opens on the transient 5-min policy
    recordModelFailure(P, M, "unusable"); // now known permanently refused

    vi.spyOn(Date, "now").mockReturnValue(t0 + 10 * 60_000);
    expect(tryAcquireProbe(P, M)).toBe(false);
  });

  it("a success clears the quarantine REASON, not just the open flag", () => {
    const t0 = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(t0);
    recordModelFailure(P, M, "unusable");
    recordModelSuccess(P, M);

    // A later transient trip must use the transient cooldown, not inherit 24h.
    recordModelFailure(P, M, "empty");
    recordModelFailure(P, M, "empty");
    recordModelFailure(P, M, "empty");
    vi.spyOn(Date, "now").mockReturnValue(t0 + 6 * 60_000);
    expect(tryAcquireProbe(P, M)).toBe(true);
  });

  /**
   * The audit's strongest finding: the `401 → null` rationale applies to an
   * account-scoped 403 too (WAF, suspended account, provider-wide block). At
   * threshold 1 a bare 403 would quarantine every healthy model in the pool,
   * one at a time, for 24h — the exact false-positive class the evidence rule
   * exists to prevent.
   */
  it("does NOT quarantine on a bare 403 with no model-scoped evidence", () => {
    expect(classifyModelFailure(apiError(403, "Forbidden"))).toBeNull();
    expect(classifyModelFailure(apiError(403, "Account suspended"))).toBeNull();
  });

  it("DOES quarantine a 403 corroborated by the structured routing metadata", () => {
    const err = apiError(403, "Forbidden", {
      responseBody: JSON.stringify({
        error: {
          code: 403,
          metadata: { failed_routing_step: "Gate Free Endpoints by Agentic Harness" },
        },
      }),
    });
    expect(classifyModelFailure(err)).toBe("unusable");
  });

  it("DOES quarantine a 403 corroborated by the exact vendor phrase", () => {
    expect(
      classifyModelFailure(apiError(403, "x:free is only available on agentic harnesses."))
    ).toBe("unusable");
  });

  it("finds the corroborating body through AI_RetryError.lastError", () => {
    const wrapped = Object.assign(new Error("Failed after 3 attempts."), {
      lastError: apiError(403, "Forbidden", {
        responseBody: '{"error":{"metadata":{"failed_routing_step":"Gate Free Endpoints"}}}',
      }),
    });
    expect(classifyModelFailure(wrapped)).toBe("unusable");
  });
});

/**
 * PM #134 — `"markup"` is policed on its own counter, which a success does not
 * reset.
 *
 * Why it needs one: printed-tool-call degradation is context-driven, not an
 * availability problem, so the same endpoint alternates markup and clean
 * answers inside one chat. Measured on the three known incident chats
 * (9891bb43 `..X.X....X`, a8e1a43c `XX……X.`, e20e9bc4 `XX.`) the longest run of
 * CONSECUTIVE markup turns is 2 — so a reset-on-success counter at threshold 3
 * would have fired on none of them.
 */
describe("markup failures (PM #134)", () => {
  const MP = "openrouter";
  const MM = "vendor/prints-markup:free";

  beforeEach(() => {
    resetModelHealth();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("opens the circuit on the 9891bb43 pattern, which a consecutive counter never would", () => {
    // ..X.X....X — markup interleaved with clean answers.
    const seq = [".", ".", "X", ".", "X", ".", ".", ".", ".", "X"];
    for (const step of seq) {
      if (step === "X") recordModelFailure(MP, MM, "markup");
      else recordModelSuccess(MP, MM);
    }
    expect(isModelCircuitOpen(MP, MM)).toBe(true);
  });

  it("a success does NOT clear the markup count — but DOES clear consecutive failures", () => {
    recordModelFailure(MP, MM, "markup");
    recordModelFailure(MP, MM, "empty");
    recordModelSuccess(MP, MM);

    const entry = getModelHealthSnapshot().find((e) => e.model === MM);
    expect(entry?.consecutiveFailures).toBe(0); // availability healed
    expect(entry?.markupFailures).toBe(1); // degradation history kept
    expect(isModelCircuitOpen(MP, MM)).toBe(false);
  });

  it("two markup answers are not enough — the threshold is not hair-trigger", () => {
    recordModelFailure(MP, MM, "markup");
    recordModelFailure(MP, MM, "markup");
    expect(isModelCircuitOpen(MP, MM)).toBe(false);
  });

  it("markup is transient, never permanent — a 24h quarantine over one bad context is wrong", () => {
    for (let i = 0; i < 5; i++) recordModelFailure(MP, MM, "markup");
    const entry = getModelHealthSnapshot().find((e) => e.model === MM);
    expect(entry?.openedByKind).toBe("markup");
    expect(isPermanentFailureKind("markup")).toBe(false);
  });

  it("other kinds do not touch the markup counter", () => {
    recordModelFailure(MP, MM, "throttle");
    recordModelFailure(MP, MM, "empty");
    recordModelFailure(MP, MM, "server");
    expect(getModelHealthSnapshot().find((e) => e.model === MM)?.markupFailures).toBe(0);
  });
});
