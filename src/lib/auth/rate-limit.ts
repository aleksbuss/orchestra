/**
 * In-memory rate limiter for `/api/auth/login`. Defends against credential
 * bruteforce on VPS deployments. Single-process — state lives in this module
 * and is lost on restart, which is fine: the attack window resets but the
 * window is bounded by how often Orchestra restarts.
 *
 * Policy:
 *   - 5 failed attempts within a 60-second window → lock for 5 minutes.
 *   - Successful login clears the counter for that IP.
 *   - Different IPs are independent buckets.
 *   - "Unknown IP" (no usable header) gets its own bucket so legitimate
 *     traffic without IP info doesn't get locked out by attacker noise from
 *     a different transport path.
 *
 * Known caveats (documented in README threat-model):
 *   - `X-Forwarded-For` is attacker-controlled when Orchestra is exposed
 *     directly. Always run behind a reverse proxy (Caddy/nginx/Cloudflare)
 *     that sanitizes the header. This module trusts the first IP in the
 *     comma-separated list, matching standard reverse-proxy convention.
 *   - In-memory state means a coordinated restart (or auto-deploy loop) can
 *     reset windows. Acceptable for the local-first / small-VPS threat model.
 */
import type { NextRequest } from "next/server";

export const RATE_LIMIT_WINDOW_MS = 60_000;
export const RATE_LIMIT_MAX_ATTEMPTS = 5;
export const RATE_LIMIT_LOCKOUT_MS = 5 * 60_000;

/** GC entries that haven't been touched in 2× the lockout duration. */
const GC_IDLE_MS = 2 * RATE_LIMIT_LOCKOUT_MS;
/** Run lazy GC every Nth call so we don't pay O(n) on every request. */
const GC_INTERVAL_CALLS = 100;

interface Bucket {
  attempts: number;
  windowStartAt: number;
  lockedUntil: number | null;
  lastTouchedAt: number;
}

const buckets = new Map<string, Bucket>();
let callsSinceLastGc = 0;

function now(): number {
  return Date.now();
}

function maybeRunGc(): void {
  callsSinceLastGc += 1;
  if (callsSinceLastGc < GC_INTERVAL_CALLS) return;
  callsSinceLastGc = 0;
  const cutoff = now() - GC_IDLE_MS;
  for (const [ip, bucket] of buckets) {
    if (bucket.lastTouchedAt < cutoff) {
      buckets.delete(ip);
    }
  }
}

/**
 * Extract the client IP for rate-limiting purposes. Returns a stable string
 * per client when behind a sane reverse proxy; returns `"unknown"` when no
 * usable header is present (groups all such requests into one bucket).
 *
 * Precedence:
 *   1. `x-forwarded-for` first comma-separated entry — standard reverse-proxy header
 *   2. `x-real-ip` — nginx variant
 *   3. `cf-connecting-ip` — Cloudflare
 *   4. `x-vercel-forwarded-for` — Vercel-specific
 *   5. fallback: `"unknown"`
 */
export function clientIpFromRequest(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const xRealIp = req.headers.get("x-real-ip")?.trim();
  if (xRealIp) return xRealIp;
  const cfIp = req.headers.get("cf-connecting-ip")?.trim();
  if (cfIp) return cfIp;
  const vercelIp = req.headers.get("x-vercel-forwarded-for")?.trim();
  if (vercelIp) return vercelIp;
  return "unknown";
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds the caller should wait before retrying. Set when `allowed=false`. */
  retryAfterSeconds?: number;
}

/**
 * Check whether a login attempt from `ip` should be allowed RIGHT NOW. Pure
 * read — does NOT increment any counter. Pair with `recordLoginOutcome`
 * after the credential check to update state.
 */
export function shouldAllowLoginAttempt(ip: string): RateLimitDecision {
  maybeRunGc();
  const bucket = buckets.get(ip);
  if (!bucket) return { allowed: true };

  const t = now();
  if (bucket.lockedUntil !== null && bucket.lockedUntil > t) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((bucket.lockedUntil - t) / 1000),
    };
  }
  return { allowed: true };
}

/**
 * Record the outcome of a login attempt. `success` clears the bucket;
 * `failure` increments the counter and arms the lockout if the threshold
 * is crossed within the active window.
 */
export function recordLoginOutcome(
  ip: string,
  outcome: "success" | "failure"
): void {
  const t = now();

  if (outcome === "success") {
    buckets.delete(ip);
    return;
  }

  const existing = buckets.get(ip);
  // Outside the rolling window? Reset to a fresh attempt.
  if (!existing || t - existing.windowStartAt > RATE_LIMIT_WINDOW_MS) {
    buckets.set(ip, {
      attempts: 1,
      windowStartAt: t,
      lockedUntil: null,
      lastTouchedAt: t,
    });
    return;
  }

  existing.attempts += 1;
  existing.lastTouchedAt = t;
  if (existing.attempts >= RATE_LIMIT_MAX_ATTEMPTS) {
    existing.lockedUntil = t + RATE_LIMIT_LOCKOUT_MS;
  }
}

/**
 * Test-only: drop all bucket state. Production code never needs this; tests
 * use it to isolate cases. Module-private would be cleaner but Vitest can't
 * peek into module-private state without ESM dynamic-import gymnastics, and
 * the function is harmless if called in production (empties an in-memory
 * map; rate-limiting simply restarts).
 */
export function __resetRateLimitForTests(): void {
  buckets.clear();
  callsSinceLastGc = 0;
}
