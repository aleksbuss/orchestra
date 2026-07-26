/**
 * Proposer fan-out pacing (free-tier failover, Sprint 2).
 *
 * WHY: the retry (Sprint 1a) and the circuit breaker (Sprint 1b) both react
 * AFTER an endpoint has already failed. The failure itself is largely
 * self-inflicted: 3–5 proposers fire at the same instant, through the same
 * OpenRouter key, at the same shared free endpoint, and it answers HTTP 200
 * with an empty body (or 429). Pacing attacks that ROOT cause — it is the only
 * layer in the stack that prevents the failure instead of recovering from it.
 *
 * WHAT (two mechanisms, both scoped to free endpoints so paid tiers keep their
 * current latency profile):
 *  1. **Free-tier dispatch cap** — at most `N` proposers may be in flight
 *     against free endpoints at once (`ORCHESTRA_FREE_TIER_CONCURRENCY`,
 *     default 2). Paid endpoints are unbounded here (the `agentSemaphore`
 *     still applies globally).
 *  2. **Adaptive stagger** — the existing `index * PROPOSER_STAGGER_MS + jitter`
 *     start offset is widened for free endpoints, and widened FURTHER for an
 *     endpoint the breaker has already seen fail, capped so a slow start can
 *     never dominate the turn.
 *
 * SCOPE HEURISTIC: "free" is `:free`-suffixed model ids — the literal OpenRouter
 * convention (`nvidia/nemotron-3-super-120b-a12b:free`). That is a naming FACT,
 * not a guess about pricing, so it cannot mis-classify a paid model. An
 * operator on a differently-named free tier can force the behaviour on with
 * `ORCHESTRA_PACE_ALL_MODELS=true`.
 *
 * All of this is pure latency shaping — it never changes which model runs, and
 * a misconfigured value can only make the fan-out slower, never wrong.
 */

import { Semaphore } from "./semaphore";
import { getModelHealthEntry } from "./model-health";

/** Base per-index start offset (PM #66). Operator-tunable since Sprint 2. */
const DEFAULT_STAGGER_MS = 250;
/** Free endpoints get a wider spread — this is where the thundering herd hurts. */
const DEFAULT_FREE_STAGGER_MS = 900;
/** Extra delay per recorded consecutive failure on this endpoint. */
const FAILURE_BACKOFF_STEP_MS = 1500;
/** Ceiling on the computed offset — a slow start must never dominate the turn. */
const MAX_STAGGER_MS = 8000;
/** Max simultaneous in-flight proposer requests against free endpoints. */
const DEFAULT_FREE_CONCURRENCY = 2;

function numericEnv(name: string, fallback: number, { allowZero = false } = {}): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return fallback;
  if (n === 0 && !allowZero) return fallback;
  return n;
}

/**
 * Is this endpoint a shared free tier?
 *
 * Matches the `:free` OpenRouter suffix (case-insensitive, tolerant of a
 * trailing provider-routing segment). `ORCHESTRA_PACE_ALL_MODELS=true` (strict
 * string) forces every endpoint to be paced — for operators whose free tier
 * doesn't carry the suffix.
 */
export function isFreeTierModel(model: string | undefined): boolean {
  if (process.env.ORCHESTRA_PACE_ALL_MODELS === "true") return true;
  if (!model) return false;
  return /:free(?:$|[/:])/i.test(model.trim());
}

/**
 * Start offset for proposer `index`, in ms.
 *
 * - index 0 always starts immediately (no point delaying the first request).
 * - free endpoints use the wider base offset.
 * - an endpoint with recorded consecutive failures gets `FAILURE_BACKOFF_STEP_MS`
 *   per failure on top — it is already struggling, so joining the burst again
 *   at full speed is what re-triggers the throttle.
 * - jitter (0–150ms) breaks lockstep between proposers that resolve to the same
 *   offset; the total is capped at `MAX_STAGGER_MS`.
 *
 * `jitter` is injectable so tests are deterministic.
 */
export function computeStaggerMs(
  index: number,
  config: { provider: string; model: string },
  jitter: number = Math.floor(Math.random() * 150)
): number {
  if (index <= 0) return 0;

  const free = isFreeTierModel(config.model);
  const base = free
    ? numericEnv("ORCHESTRA_FREE_STAGGER_MS", DEFAULT_FREE_STAGGER_MS)
    : numericEnv("ORCHESTRA_PROPOSER_STAGGER_MS", DEFAULT_STAGGER_MS);

  const health = getModelHealthEntry(config.provider, config.model);
  const failurePenalty = (health?.consecutiveFailures ?? 0) * FAILURE_BACKOFF_STEP_MS;

  return Math.min(index * base + failurePenalty + jitter, MAX_STAGGER_MS);
}

/**
 * Free-tier dispatch semaphore — process-global (PM #71 `Symbol.for` store) so
 * every concurrent chat shares ONE budget against the shared upstream quota.
 * Two chats each firing 5 free proposers is the same thundering herd as one
 * chat firing 10.
 *
 * Permits are read once, on first use: the semaphore's permit count is fixed at
 * construction, so an operator changing the env var mid-process keeps the old
 * value until restart. Documented rather than fixed — a resizable semaphore is
 * more machinery than a local-first tool needs.
 */
const FREE_SEMAPHORE_KEY = Symbol.for("orchestra.free-tier-semaphore");

function freeSemaphore(): Semaphore {
  const g = globalThis as unknown as Record<symbol, Semaphore | undefined>;
  return (g[FREE_SEMAPHORE_KEY] ??= new Semaphore(
    Math.max(1, Math.floor(numericEnv("ORCHESTRA_FREE_TIER_CONCURRENCY", DEFAULT_FREE_CONCURRENCY)))
  ));
}

/**
 * Run `fn` under the free-tier dispatch cap when `config` is a free endpoint;
 * run it unchanged otherwise. `ORCHESTRA_FREE_TIER_CONCURRENCY=0` disables the
 * cap entirely (audit A5 — an escape hatch for a mis-classified endpoint).
 *
 * ORDERING CONTRACT: acquire this budget OUTSIDE the global `agentSemaphore`,
 * never inside it. This one bounds a remote shared QUOTA (unbounded wait);
 * the global one bounds MACHINE load and is shared with the embedder and the
 * main agent path, with as few as 2 permits on a 16 GB box. Nested the wrong
 * way, a proposer queued on the free quota holds a scarce global permit and
 * starves the rest of the process (audit A1).
 */
export async function withFreeTierPacing<T>(
  config: { provider: string; model: string },
  fn: () => Promise<T>
): Promise<T> {
  if (!isFreeTierModel(config.model)) return fn();
  if (numericEnv("ORCHESTRA_FREE_TIER_CONCURRENCY", DEFAULT_FREE_CONCURRENCY, { allowZero: true }) === 0) {
    return fn();
  }
  return freeSemaphore().run(fn);
}

/**
 * `setTimeout` that resolves EARLY when `signal` aborts (audit A3).
 *
 * The pacing offset can reach `MAX_STAGGER_MS`, so a plain sleep would keep a
 * cancelled turn's proposers queued long after the user pressed stop. Resolves
 * (never rejects) on abort — the caller decides what an aborted wait means, and
 * a rejection here would be caught by the proposer's try/catch and mislabelled
 * as an endpoint failure. The listener is always removed, so a long-lived
 * parent signal cannot accumulate listeners across a chat's turns.
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Test helper — drops the process-global semaphore so permits are re-read. */
export function resetFreeTierPacing(): void {
  const g = globalThis as unknown as Record<symbol, Semaphore | undefined>;
  delete g[FREE_SEMAPHORE_KEY];
}

/** Current free-tier permit budget (observability / tests). */
export function getFreeTierConcurrency(): number {
  return freeSemaphore().getTotalPermits();
}
