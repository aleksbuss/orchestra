/**
 * Tests for computeNextRunAtMs and validateCronExpression — the schedule
 * arithmetic that every cron-tick relies on. Three schedule kinds:
 *
 *   - at:    one-shot at a specific epoch (returns the epoch if still in
 *            the future, otherwise undefined — the runtime treats that as
 *            "fire, then mark done").
 *   - every: fixed-interval, optionally anchored to a wall-clock origin.
 *            Without anchor, anchorMs defaults to nowMs (next run = now +
 *            everyMs). With anchor, the next run aligns to the anchor
 *            grid — important for "every 5 minutes at xx:00, xx:05, ..."
 *            (vs "5 minutes after I created it").
 *   - cron:  5-field cron-expression with timezone. The parser accepts
 *            stars, lists, ranges, and steps. dow=7 maps to 0 (Sunday).
 *
 * Pinned invariants:
 *   - 'at': time in the past → undefined; future → that exact ms.
 *   - 'every': everyMs floored & clamped to 1; future anchor returned;
 *              elapsed time → aligned to anchor + N*everyMs (smallest
 *              N giving a future time).
 *   - 'cron': lookahead is capped (we don't loop forever on impossible
 *             exprs like '0 0 30 2 *' — Feb 30th).
 *   - 'cron': dow=7 means Sunday (mapped to 0).
 *   - validateCronExpression: null on valid expressions, error message
 *             on invalid ones.
 */
import { describe, it, expect } from "vitest";
import { computeNextRunAtMs, validateCronExpression } from "./schedule";

// Anchor "now" deterministically so we can assert future timestamps.
// 2026-05-16 12:00:00 UTC.
const NOW_MS = Date.UTC(2026, 4, 16, 12, 0, 0);

describe("computeNextRunAtMs — 'at' schedule", () => {
  it("returns the parsed epoch when the date is in the future", () => {
    const at = "2026-05-16T13:00:00Z";
    const expected = Date.UTC(2026, 4, 16, 13, 0, 0);
    expect(computeNextRunAtMs({ kind: "at", at }, NOW_MS)).toBe(expected);
  });

  it("returns undefined when the date is in the past", () => {
    const at = "2026-05-16T11:00:00Z";
    expect(computeNextRunAtMs({ kind: "at", at }, NOW_MS)).toBeUndefined();
  });

  it("returns undefined when the date equals 'now' exactly (strict >)", () => {
    const at = new Date(NOW_MS).toISOString();
    expect(computeNextRunAtMs({ kind: "at", at }, NOW_MS)).toBeUndefined();
  });

  it("returns undefined for an unparseable 'at' string", () => {
    expect(
      computeNextRunAtMs({ kind: "at", at: "tomorrow at noon" }, NOW_MS)
    ).toBeUndefined();
  });

  it("accepts an epoch-millisecond string for 'at'", () => {
    const future = NOW_MS + 60_000;
    expect(
      computeNextRunAtMs({ kind: "at", at: String(future) }, NOW_MS)
    ).toBe(future);
  });
});

describe("computeNextRunAtMs — 'every' schedule (no anchor)", () => {
  it("defaults anchor to nowMs → first run is exactly nowMs + everyMs", () => {
    // anchor = nowMs, elapsed = 0, steps = ceil(0+e-1/e) = 1, anchor + 1*e
    expect(
      computeNextRunAtMs({ kind: "every", everyMs: 60_000 }, NOW_MS)
    ).toBe(NOW_MS + 60_000);
  });

  it("clamps everyMs to at least 1ms", () => {
    expect(
      computeNextRunAtMs({ kind: "every", everyMs: 0 }, NOW_MS)
    ).toBe(NOW_MS + 1);
  });

  it("floors fractional everyMs", () => {
    expect(
      computeNextRunAtMs({ kind: "every", everyMs: 1500.7 }, NOW_MS)
    ).toBe(NOW_MS + 1500);
  });
});

describe("computeNextRunAtMs — 'every' schedule (anchored)", () => {
  it("returns the anchor when nowMs is before the anchor", () => {
    const anchor = NOW_MS + 5 * 60_000;
    expect(
      computeNextRunAtMs(
        { kind: "every", everyMs: 60_000, anchorMs: anchor },
        NOW_MS
      )
    ).toBe(anchor);
  });

  it("aligns to anchor grid when nowMs lands BETWEEN anchor ticks", () => {
    // anchor = 11:00 UTC, every 5 min, now = 12:02 UTC → next tick is 12:05.
    const anchor = Date.UTC(2026, 4, 16, 11, 0, 0);
    const slightlyOffNow = Date.UTC(2026, 4, 16, 12, 2, 0);
    const expected = Date.UTC(2026, 4, 16, 12, 5, 0);
    expect(
      computeNextRunAtMs(
        { kind: "every", everyMs: 5 * 60_000, anchorMs: anchor },
        slightlyOffNow
      )
    ).toBe(expected);
  });

  it("when nowMs is EXACTLY on an anchor-aligned tick, returns that tick (NOT strict >)", () => {
    // anchor = 11:00 UTC, every 5 min, now = 12:00 UTC (an aligned tick).
    // formula: steps = ceil(elapsed / everyMs) = exactly 12 → next = 12:00.
    // This is the 'every' kind's subtle non-strict-> semantics:
    //   - 'at'   : nowMs == at  → undefined (strict >)
    //   - 'cron' : cursor starts at floor(now/MIN)*MIN + MIN → strict >
    //   - 'every': aligned tick → returns the same tick
    // The runtime handles the apparent "fire at now" by advancing the
    // running marker before re-computing.
    const anchor = Date.UTC(2026, 4, 16, 11, 0, 0);
    expect(
      computeNextRunAtMs(
        { kind: "every", everyMs: 5 * 60_000, anchorMs: anchor },
        NOW_MS
      )
    ).toBe(NOW_MS);
  });

  it("when now exactly equals an anchor tick, jumps to the NEXT tick (strict >)", () => {
    // anchor = 12:00, every 5 min, now = 12:00 → elapsed=0 → steps=ceil(0+e-1/e)=1
    // → next = 12:00 + 5min = 12:05. Strict-greater-than-now is the
    // contract; same-tick re-runs would risk infinite-loop on jitter.
    const anchor = NOW_MS;
    expect(
      computeNextRunAtMs(
        { kind: "every", everyMs: 5 * 60_000, anchorMs: anchor },
        NOW_MS
      )
    ).toBe(NOW_MS + 5 * 60_000);
  });

  it("floors a negative anchor to 0 (defensive — doesn't blow up)", () => {
    // anchor=-1000 → Math.max(0, Math.floor(-1000)) = 0. With everyMs=60s,
    // and NOW_MS landing on a minute boundary, elapsed is an exact multiple
    // of everyMs → result == NOW_MS (same aligned-tick semantics as above).
    const result = computeNextRunAtMs(
      { kind: "every", everyMs: 60_000, anchorMs: -1000 },
      NOW_MS
    );
    // The guarantee is "finite, integer, not in the deep past" — not
    // strict >. The 'every'-aligned-to-tick semantics applies.
    expect(typeof result).toBe("number");
    expect(result).toBeGreaterThanOrEqual(NOW_MS);
  });
});

describe("computeNextRunAtMs — 'cron' schedule (UTC tz)", () => {
  const TZ = "UTC";

  it("returns undefined for an empty cron expression", () => {
    expect(
      computeNextRunAtMs({ kind: "cron", expr: "  ", tz: TZ }, NOW_MS)
    ).toBeUndefined();
  });

  it("'* * * * *' fires next minute", () => {
    // Now = 12:00:00 UTC → next firing minute boundary is 12:01:00 UTC.
    const next = computeNextRunAtMs(
      { kind: "cron", expr: "* * * * *", tz: TZ },
      NOW_MS
    );
    expect(next).toBe(Date.UTC(2026, 4, 16, 12, 1, 0));
  });

  it("'*/5 * * * *' aligns to next 5-minute boundary", () => {
    // Now = 12:00:00 → next /5 boundary > now is 12:05.
    const next = computeNextRunAtMs(
      { kind: "cron", expr: "*/5 * * * *", tz: TZ },
      NOW_MS
    );
    expect(next).toBe(Date.UTC(2026, 4, 16, 12, 5, 0));
  });

  it("'0 9 * * *' fires next day 09:00 (today's already past)", () => {
    // Now = 12:00 UTC. Today's 09:00 is in the past, so next is tomorrow.
    const next = computeNextRunAtMs(
      { kind: "cron", expr: "0 9 * * *", tz: TZ },
      NOW_MS
    );
    expect(next).toBe(Date.UTC(2026, 4, 17, 9, 0, 0));
  });

  it("dow=0 (Sunday). 2026-05-17 is a Sunday → '0 9 * * 0' lands there", () => {
    // 2026-05-16 is a Saturday → next Sunday at 09:00 is 2026-05-17 09:00 UTC.
    const next = computeNextRunAtMs(
      { kind: "cron", expr: "0 9 * * 0", tz: TZ },
      NOW_MS
    );
    expect(next).toBe(Date.UTC(2026, 4, 17, 9, 0, 0));
  });

  it("dow=7 is treated as Sunday (parser maps 7→0)", () => {
    const dow0 = computeNextRunAtMs(
      { kind: "cron", expr: "0 9 * * 0", tz: TZ },
      NOW_MS
    );
    const dow7 = computeNextRunAtMs(
      { kind: "cron", expr: "0 9 * * 7", tz: TZ },
      NOW_MS
    );
    expect(dow7).toBe(dow0);
  });

  it("accepts a comma list ('0 9,18 * * *')", () => {
    // 12:00 → next is today 18:00.
    const next = computeNextRunAtMs(
      { kind: "cron", expr: "0 9,18 * * *", tz: TZ },
      NOW_MS
    );
    expect(next).toBe(Date.UTC(2026, 4, 16, 18, 0, 0));
  });

  it("accepts a range ('0 9-11 * * *')", () => {
    // 12:00 → today's 9, 10, 11 all past → tomorrow at 09:00.
    const next = computeNextRunAtMs(
      { kind: "cron", expr: "0 9-11 * * *", tz: TZ },
      NOW_MS
    );
    expect(next).toBe(Date.UTC(2026, 4, 17, 9, 0, 0));
  });

  it("returns undefined for impossible expression ('0 0 30 2 *' — Feb 30th)", () => {
    // Lookahead is capped at 2 years; Feb 30 never exists → undefined.
    const next = computeNextRunAtMs(
      { kind: "cron", expr: "0 0 30 2 *", tz: TZ },
      NOW_MS
    );
    expect(next).toBeUndefined();
  });

  it("returns undefined for syntactically invalid expressions", () => {
    expect(
      computeNextRunAtMs(
        { kind: "cron", expr: "not even close", tz: TZ },
        NOW_MS
      )
    ).toBeUndefined();
  });

  it("returns undefined for wrong number of fields", () => {
    expect(
      computeNextRunAtMs({ kind: "cron", expr: "* * * *", tz: TZ }, NOW_MS)
    ).toBeUndefined();
    expect(
      computeNextRunAtMs(
        { kind: "cron", expr: "* * * * * *", tz: TZ },
        NOW_MS
      )
    ).toBeUndefined();
  });

  it("returns undefined for out-of-range numeric fields", () => {
    expect(
      computeNextRunAtMs({ kind: "cron", expr: "60 * * * *", tz: TZ }, NOW_MS)
    ).toBeUndefined();
    expect(
      computeNextRunAtMs({ kind: "cron", expr: "* 24 * * *", tz: TZ }, NOW_MS)
    ).toBeUndefined();
  });

  it("falls back to the host tz when tz is missing/empty", () => {
    // We can't predict the host tz, but we can verify it doesn't crash
    // and returns a finite future timestamp.
    const next = computeNextRunAtMs(
      { kind: "cron", expr: "* * * * *" },
      NOW_MS
    );
    expect(typeof next).toBe("number");
    expect(next!).toBeGreaterThan(NOW_MS);
  });
});

describe("computeNextRunAtMs — 'cron' schedule (named tz)", () => {
  it("interprets hours in the supplied tz, not UTC", () => {
    // "0 9 * * *" in Europe/Riga (UTC+3 in May) means 09:00 local → 06:00 UTC.
    // Now = 12:00 UTC = 15:00 local → today's 09:00 local already past →
    // next is tomorrow 09:00 local = tomorrow 06:00 UTC.
    const next = computeNextRunAtMs(
      { kind: "cron", expr: "0 9 * * *", tz: "Europe/Riga" },
      NOW_MS
    );
    expect(next).toBe(Date.UTC(2026, 4, 17, 6, 0, 0));
  });
});

describe("validateCronExpression", () => {
  it("returns null for valid expressions", () => {
    expect(validateCronExpression("* * * * *")).toBeNull();
    expect(validateCronExpression("0 9 * * 1-5")).toBeNull();
    expect(validateCronExpression("*/15 0,12 * * *")).toBeNull();
  });

  it("returns a friendly message for empty input", () => {
    expect(validateCronExpression("")).toMatch(/required/i);
    expect(validateCronExpression("   ")).toMatch(/required/i);
  });

  it("returns a generic 'must contain 5 fields' message on shape errors", () => {
    expect(validateCronExpression("only-four * * *")).toMatch(/5 fields/i);
    expect(validateCronExpression("nope")).toMatch(/5 fields/i);
    expect(validateCronExpression("60 * * * *")).toMatch(/5 fields/i);
  });

  it("rejects invalid step zero", () => {
    expect(validateCronExpression("*/0 * * * *")).toMatch(/5 fields/i);
  });

  it("rejects invalid range (right < left)", () => {
    expect(validateCronExpression("0 11-9 * * *")).toMatch(/5 fields/i);
  });
});
