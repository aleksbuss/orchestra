/**
 * Tests for the login rate-limiter (PM #13). Policy under test:
 *   - 5 failed attempts within a 60s window → lock for 5 minutes
 *   - successful login clears the bucket
 *   - different IPs are independent
 *   - missing IP info coerces to a single "unknown" bucket
 *   - lockout window expires cleanly
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  RATE_LIMIT_MAX_ATTEMPTS,
  RATE_LIMIT_LOCKOUT_MS,
  RATE_LIMIT_WINDOW_MS,
  __resetRateLimitForTests,
  clientIpFromRequest,
  recordLoginOutcome,
  shouldAllowLoginAttempt,
} from "./rate-limit";

function fakeRequest(headers: Record<string, string>): {
  headers: { get: (name: string) => string | null };
} {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    lower[k.toLowerCase()] = v;
  }
  return {
    headers: {
      get(name: string): string | null {
        return lower[name.toLowerCase()] ?? null;
      },
    },
  };
}

describe("clientIpFromRequest — header precedence", () => {
  it("prefers x-forwarded-for first entry", () => {
    const req = fakeRequest({
      "x-forwarded-for": "1.2.3.4, 10.0.0.1, 192.168.1.1",
      "x-real-ip": "5.6.7.8",
    });
    expect(clientIpFromRequest(req as any)).toBe("1.2.3.4");
  });

  it("falls back to x-real-ip when xff missing", () => {
    const req = fakeRequest({ "x-real-ip": "5.6.7.8" });
    expect(clientIpFromRequest(req as any)).toBe("5.6.7.8");
  });

  it("falls back to cf-connecting-ip", () => {
    const req = fakeRequest({ "cf-connecting-ip": "9.9.9.9" });
    expect(clientIpFromRequest(req as any)).toBe("9.9.9.9");
  });

  it("returns 'unknown' when no header is set", () => {
    const req = fakeRequest({});
    expect(clientIpFromRequest(req as any)).toBe("unknown");
  });

  it("ignores empty xff entries gracefully", () => {
    const req = fakeRequest({
      "x-forwarded-for": "  , 5.6.7.8",
      "x-real-ip": "9.9.9.9",
    });
    // First entry is empty after trim → fall through to x-real-ip.
    expect(clientIpFromRequest(req as any)).toBe("9.9.9.9");
  });
});

describe("rate-limit policy", () => {
  beforeEach(() => {
    __resetRateLimitForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetRateLimitForTests();
  });

  it("allows the first attempt", () => {
    expect(shouldAllowLoginAttempt("1.2.3.4")).toEqual({ allowed: true });
  });

  it("locks after MAX_ATTEMPTS failures within the window", () => {
    const ip = "1.2.3.4";
    for (let i = 0; i < RATE_LIMIT_MAX_ATTEMPTS; i++) {
      expect(shouldAllowLoginAttempt(ip).allowed).toBe(true);
      recordLoginOutcome(ip, "failure");
    }
    const decision = shouldAllowLoginAttempt(ip);
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
    expect(decision.retryAfterSeconds).toBeLessThanOrEqual(
      RATE_LIMIT_LOCKOUT_MS / 1000
    );
  });

  it("unlocks after the lockout window expires", () => {
    const ip = "1.2.3.4";
    for (let i = 0; i < RATE_LIMIT_MAX_ATTEMPTS; i++) {
      recordLoginOutcome(ip, "failure");
    }
    expect(shouldAllowLoginAttempt(ip).allowed).toBe(false);

    vi.advanceTimersByTime(RATE_LIMIT_LOCKOUT_MS + 1000);
    expect(shouldAllowLoginAttempt(ip).allowed).toBe(true);
  });

  it("resets the counter when failures fall outside the rolling window", () => {
    const ip = "1.2.3.4";
    // 3 failures, then wait past the window — counter should reset.
    recordLoginOutcome(ip, "failure");
    recordLoginOutcome(ip, "failure");
    recordLoginOutcome(ip, "failure");
    vi.advanceTimersByTime(RATE_LIMIT_WINDOW_MS + 1000);

    // Two more failures should not lock — we're in a fresh window with count=1, then 2.
    recordLoginOutcome(ip, "failure");
    recordLoginOutcome(ip, "failure");
    expect(shouldAllowLoginAttempt(ip).allowed).toBe(true);
  });

  it("clears the bucket on success — fresh window after a good login", () => {
    const ip = "1.2.3.4";
    for (let i = 0; i < RATE_LIMIT_MAX_ATTEMPTS - 1; i++) {
      recordLoginOutcome(ip, "failure");
    }
    // 4 failures: still allowed.
    expect(shouldAllowLoginAttempt(ip).allowed).toBe(true);

    recordLoginOutcome(ip, "success");

    // Now an attacker can't ride the prior counter. Five fresh failures
    // would be needed to lock again.
    for (let i = 0; i < RATE_LIMIT_MAX_ATTEMPTS - 1; i++) {
      recordLoginOutcome(ip, "failure");
    }
    expect(shouldAllowLoginAttempt(ip).allowed).toBe(true);
  });

  it("treats different IPs as independent buckets", () => {
    const evil = "6.6.6.6";
    const innocent = "1.2.3.4";

    for (let i = 0; i < RATE_LIMIT_MAX_ATTEMPTS; i++) {
      recordLoginOutcome(evil, "failure");
    }
    expect(shouldAllowLoginAttempt(evil).allowed).toBe(false);
    // The legitimate user from a different IP is unaffected.
    expect(shouldAllowLoginAttempt(innocent).allowed).toBe(true);
  });

  it("groups all 'unknown' IPs into one bucket — does NOT lock named IPs", () => {
    for (let i = 0; i < RATE_LIMIT_MAX_ATTEMPTS; i++) {
      recordLoginOutcome("unknown", "failure");
    }
    expect(shouldAllowLoginAttempt("unknown").allowed).toBe(false);
    // A real client with a real IP must still be allowed — collateral damage
    // would let an attacker DoS legitimate traffic by spamming proxy-stripped
    // requests.
    expect(shouldAllowLoginAttempt("1.2.3.4").allowed).toBe(true);
  });
});
