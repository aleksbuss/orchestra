/**
 * Model-endpoint circuit breaker (free-tier failover, Sprint 1).
 *
 * WHY: `ORCHESTRA_PROPOSER_EMPTY_RETRIES` (moa.ts) recovers a TRANSIENTLY
 * throttled free endpoint — it cannot fix a PERMANENTLY dead one. A model that
 * is down (upstream outage, revoked free tier, hard quota) answers every retry
 * with the same empty 200, so the retry loop just burns `2s + 4s` of backoff per
 * proposer, per turn, forever. Worse, hammering a rate-limited shared free
 * endpoint is what got the key throttled in the first place.
 *
 * WHAT: a tiny in-memory breaker keyed on `provider/model`. N consecutive
 * failures OPEN the circuit for a cooldown window; callers ask
 * `isModelCircuitOpen()` BEFORE dispatching and substitute a healthy model from
 * their own candidate pool (`selectHealthyConfig`). A success closes it.
 *
 * DESIGN NOTES
 * - **In-memory + process-global.** State evaporates on restart, exactly like
 *   the daemon's `autoPilotIterations` and the write-rewrite budget — a fresh
 *   boot deserves a fresh probe of every endpoint. It rides a
 *   `Symbol.for()`-keyed `globalThis` singleton because Next.js bundles
 *   instrumentation and route handlers into SEPARATE module graphs (PM #71): a
 *   module-level `Map` would give the health route a different breaker than the
 *   agent path writes to.
 * - **Half-open is a real single probe (DoubleTake #3).** The first design let
 *   `isModelCircuitOpen` heal the entry as a SIDE EFFECT of being read, which
 *   meant every proposer in the fan-out saw "closed" the moment the cooldown
 *   expired and the whole herd hit a maybe-dead endpoint at once — the opposite
 *   of half-open. Reads are now PURE; a single probe is handed out explicitly
 *   via `tryAcquireProbe()`, which is safe without locks because Node runs this
 *   single-threaded (the check and the flag set happen in one tick).
 * - **Failures need POSITIVE evidence (DoubleTake #4).** `classifyModelFailure`
 *   returns `null` for anything that is not demonstrably the endpoint's fault —
 *   a 400 (our prompt was too long), a local `TypeError`, a full semaphore
 *   queue. Counting those let OUR bugs mark a healthy model dead for every
 *   concurrent chat. Unknown errors are NOT counted: a breaker must open on
 *   evidence, never on ignorance.
 * - **Fail-OPEN by construction.** This module only ever REPORTS health;
 *   `selectHealthyConfig` returns the preferred config when every candidate is
 *   dead. A breaker that can block a run is worse than the throttling it guards
 *   against (PM #60 fail-safe posture).
 * - **Universal, not free-tier-only.** The threshold (3 CONSECUTIVE failures)
 *   is conservative enough that a healthy paid endpoint never trips it, so
 *   there is no need for a "is this model free?" heuristic.
 *
 * ESCAPE HATCH: `ORCHESTRA_MODEL_CIRCUIT_DISABLED=true` (strict string compare,
 * same posture as `ORCHESTRA_DISABLE_AUTH`) makes every call a no-op.
 */

/**
 * Why a model attempt was counted as a failure.
 *
 * The first four are TRANSIENT — the endpoint may recover, which is exactly what
 * the "N consecutive failures, then a short cooldown, then a half-open probe"
 * policy below is built for. `"unusable"` is NOT: the provider refused to serve
 * this model to this account/app at all (PM #127), so there is nothing to wait
 * for and no reason to spend a probe every 5 minutes. It therefore carries its
 * own policy — see `policyFor`.
 */
export type ModelFailureKind =
  | "empty"
  | "throttle"
  | "server"
  | "unreachable"
  | "unusable";

export interface ModelHealthEntry {
  provider: string;
  model: string;
  consecutiveFailures: number;
  /** Epoch ms when the circuit tripped, or `null` when healthy. */
  openedAt: number | null;
  lastFailureKind: ModelFailureKind | null;
  /**
   * The kind that actually TRIPPED the circuit, which is NOT always
   * `lastFailureKind` (PM #127 audit).
   *
   * A fan-out is parallel: several proposers hit the same endpoint at once and
   * can report DIFFERENT kinds. `lastFailureKind` is last-writer-wins telemetry,
   * so a sibling proposer's timeout arriving after a 403 used to silently
   * downgrade a 24h quarantine to the 5-minute transient schedule — exactly the
   * shape of the incident this fix exists for. The cooldown must follow the
   * reason the endpoint was quarantined, and it only ever escalates: a
   * permanent kind upgrades an open circuit, a transient one never demotes it.
   */
  openedByKind: ModelFailureKind | null;
  lastFailureAt: number | null;
  totalFailures: number;
  totalSuccesses: number;
  /** A half-open probe has been handed out and has not reported back yet. */
  probeInFlight: boolean;
}

const DEFAULT_THRESHOLD = 3;
/**
 * Cooldown before a tripped endpoint gets a probe.
 *
 * 5 minutes, not the 15 the first cut used: a free endpoint's availability
 * fluctuates by the minute, so a long cooldown keeps substituting away from a
 * model that recovered — which costs DELIVERY, the metric this whole track
 * exists to raise. The half-open probe is cheap (one proposer), so probing
 * often is the right trade.
 */
const DEFAULT_COOLDOWN_MS = 5 * 60_000;

/**
 * Cooldown for a `"unusable"` refusal — a provider-side entitlement decision,
 * not an availability blip.
 *
 * 24h, not "forever": a vendor allowlist is a business setting that can change
 * (the operator may register the app, the model may leave preview), so a
 * permanent ban would need an invalidation path nobody would remember to call.
 * Note the store is in-memory on a `globalThis` singleton, so in practice this
 * is "for the life of the process" on a machine that restarts more often than
 * daily — the TTL matters for long-lived servers.
 */
const DEFAULT_UNUSABLE_COOLDOWN_MS = 24 * 60 * 60_000;

const HEALTH_STORE_KEY = Symbol.for("orchestra.model-health.store");

function store(): Map<string, ModelHealthEntry> {
  const g = globalThis as unknown as Record<symbol, Map<string, ModelHealthEntry> | undefined>;
  return (g[HEALTH_STORE_KEY] ??= new Map());
}

/** Env is read per-call (not cached) so a test / operator change takes effect immediately. */
function isDisabled(): boolean {
  return process.env.ORCHESTRA_MODEL_CIRCUIT_DISABLED === "true";
}

function numericEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function failureThreshold(): number {
  return numericEnv("ORCHESTRA_MODEL_CIRCUIT_THRESHOLD", DEFAULT_THRESHOLD);
}

function cooldownMs(): number {
  return numericEnv("ORCHESTRA_MODEL_CIRCUIT_COOLDOWN_MS", DEFAULT_COOLDOWN_MS);
}

/**
 * How a failure KIND is policed. One store and one `recordModelFailure` — the
 * kind selects the numbers, rather than a second parallel registry with its own
 * bookkeeping to drift out of sync.
 *
 * `"unusable"` trips on the FIRST failure: waiting for three identical
 * deterministic refusals just buys three dead proposers instead of one.
 */
function policyFor(kind: ModelFailureKind): { threshold: number; cooldownMs: number } {
  if (kind === "unusable") {
    return {
      threshold: 1,
      cooldownMs: numericEnv(
        "ORCHESTRA_MODEL_UNUSABLE_COOLDOWN_MS",
        DEFAULT_UNUSABLE_COOLDOWN_MS
      ),
    };
  }
  return { threshold: failureThreshold(), cooldownMs: cooldownMs() };
}

/** True for failure kinds that no amount of retrying can fix. */
export function isPermanentFailureKind(kind: ModelFailureKind | null): boolean {
  return kind === "unusable";
}

/** Stable identity for a (provider, model) endpoint. Exported for logs/tests. */
export function modelHealthKey(provider: string, model: string): string {
  return `${provider}/${model}`;
}

function entryFor(provider: string, model: string): ModelHealthEntry {
  const key = modelHealthKey(provider, model);
  const existing = store().get(key);
  if (existing) return existing;
  const fresh: ModelHealthEntry = {
    provider,
    model,
    consecutiveFailures: 0,
    openedAt: null,
    lastFailureKind: null,
    openedByKind: null,
    lastFailureAt: null,
    totalFailures: 0,
    totalSuccesses: 0,
    probeInFlight: false,
  };
  store().set(key, fresh);
  return fresh;
}

/**
 * Record a failed attempt against a model endpoint. Opens the circuit when the
 * consecutive-failure count reaches the threshold.
 *
 * Callers MUST NOT record a parent-abort (user pressed stop) as a failure — the
 * endpoint did nothing wrong. Timeouts DO count: a free endpoint too slow to
 * answer within the proposer budget is functionally dead for this turn.
 */
export function recordModelFailure(
  provider: string,
  model: string,
  kind: ModelFailureKind
): void {
  if (isDisabled()) return;
  const entry = entryFor(provider, model);
  entry.consecutiveFailures += 1;
  entry.totalFailures += 1;
  entry.lastFailureKind = kind;
  entry.lastFailureAt = Date.now();
  entry.probeInFlight = false;

  const policy = policyFor(kind);

  if (entry.openedAt !== null) {
    // A half-open probe (or a sibling proposer in the same fan-out) just
    // failed → restart the cooldown from now. The quarantine REASON only ever
    // escalates: a permanent refusal upgrades an open circuit, but a transient
    // failure arriving afterwards must not demote a permanent one back onto
    // the 5-minute schedule (PM #127 audit — reachable whenever a parallel
    // fan-out reports mixed kinds against one endpoint).
    entry.openedAt = Date.now();
    if (isPermanentFailureKind(kind)) entry.openedByKind = kind;
    return;
  }
  if (entry.consecutiveFailures >= policy.threshold) {
    entry.openedAt = Date.now();
    entry.openedByKind = kind;
    const forSeconds = Math.round(policy.cooldownMs / 1000);
    console.warn(
      kind === "unusable"
        ? `[ModelHealth] Circuit OPEN for ${modelHealthKey(provider, model)} — ` +
            `the provider REFUSED to serve this model to this account/app. ` +
            `No retry can fix it; quarantining for ${forSeconds}s and substituting.`
        : `[ModelHealth] Circuit OPEN for ${modelHealthKey(provider, model)} — ` +
            `${entry.consecutiveFailures} consecutive failures (last: ${kind}). ` +
            `Skipping this endpoint for ${forSeconds}s.`
    );
  }
}

/** Record a successful (non-empty) generation — fully heals the endpoint. */
export function recordModelSuccess(provider: string, model: string): void {
  if (isDisabled()) return;
  const entry = entryFor(provider, model);
  const wasOpen = entry.openedAt !== null;
  entry.consecutiveFailures = 0;
  entry.openedAt = null;
  // The endpoint answered, so whatever quarantined it no longer applies —
  // clear the reason too, or a later transient trip would inherit the old
  // permanent cooldown.
  entry.openedByKind = null;
  entry.probeInFlight = false;
  entry.totalSuccesses += 1;
  if (wasOpen) {
    console.warn(`[ModelHealth] Circuit CLOSED for ${modelHealthKey(provider, model)} — probe succeeded.`);
  }
}

/**
 * Has this endpoint's breaker TRIPPED and not yet been healed?
 *
 * PURE — reading never mutates (DoubleTake #3). It stays `true` through the
 * cooldown AND through the half-open window; only a recorded SUCCESS clears it.
 * Callers that want to dispatch anyway must ask for a probe explicitly via
 * `tryAcquireProbe`.
 */
export function isModelCircuitOpen(provider: string, model: string): boolean {
  if (isDisabled()) return false;
  const entry = store().get(modelHealthKey(provider, model));
  return !!entry && entry.openedAt !== null;
}

/**
 * Hand out the ONE half-open probe for a tripped endpoint, or `false`.
 *
 * Grants when the cooldown has elapsed and no probe is already outstanding. The
 * flag is cleared by the next `recordModelFailure` / `recordModelSuccess` for
 * this endpoint, so a probe that never reports back (process crash, dropped
 * promise) is the only way to leak it — and that state dies with the process.
 *
 * Safe without a lock: Node executes the read-check-set below in a single tick.
 */
export function tryAcquireProbe(provider: string, model: string): boolean {
  if (isDisabled()) return true;
  const entry = store().get(modelHealthKey(provider, model));
  if (!entry || entry.openedAt === null) return true; // not tripped — free to dispatch
  if (entry.probeInFlight) return false;
  // The cooldown follows the kind that TRIPPED the circuit — a permanent
  // refusal must not be re-probed on the 5-minute transient schedule.
  if (Date.now() - entry.openedAt < policyFor(entry.openedByKind ?? "empty").cooldownMs) {
    return false;
  }

  entry.probeInFlight = true;
  console.warn(
    `[ModelHealth] Circuit HALF-OPEN for ${modelHealthKey(provider, model)} — ` +
      `cooldown elapsed, handing out ONE probe.`
  );
  return true;
}

/**
 * Map a thrown error onto a failure kind — or `null` when it is NOT evidence
 * that the ENDPOINT is unhealthy (DoubleTake #4).
 *
 * A breaker must open on positive evidence, never on ignorance. Counting every
 * exception let OUR OWN bugs kill a healthy model for every concurrent chat:
 * an over-long prompt (400), a full semaphore queue, a local `TypeError` — none
 * of those get better by substituting a different model, and a 15-minute global
 * skip is a wildly disproportionate response to a bad request.
 *
 * So: `null` is the DEFAULT, and only recognised endpoint-side signatures
 * count. Callers must also skip a parent abort (a user pressing stop is not an
 * endpoint failure) — that check needs the signal, which this function has no
 * access to.
 */
/**
 * Read an upstream HTTP status off an error, unwrapping `AI_RetryError.lastError`
 * when the SDK's own retry loop is what exhausted (same shape as `AI_RetryError`
 * from `node_modules/ai/src/util/retry-error.ts` — no `statusCode` of its own,
 * the real `AI_APICallError` sits one level down). Same fix as PM #114
 * (`postmortem.ts`'s `extractUpstreamResponse`), applied here because
 * `classifyModelFailure` had the identical blind spot: a 429 wrapped in
 * "Failed after 4 attempts. Last error: Provider returned error" matched
 * `msg.includes("provider returned error")` below and was classified `"server"`,
 * never `"throttle"` — so a plain rate limit and a real 5xx were indistinguishable
 * in the breaker's own telemetry.
 */
/**
 * The exact vendor phrase for OpenRouter's registered-app gate. Kept as ONE
 * multi-word constant so the fallback below can never be widened by accident.
 */
const HARNESS_GATE_PHRASE = "only available on agentic harnesses";

/**
 * Is there POSITIVE evidence that a 403 is about THIS MODEL rather than the
 * account?
 *
 * The PM #127 audit's strongest finding: the rationale for `401 → null` ("every
 * endpoint on that key fails identically, so blaming one model teaches the
 * breaker nothing") applies just as well to an account-scoped 403 — a suspended
 * account, a WAF rule, a provider-wide block. Classifying a BARE 403 as a
 * permanent model fault at threshold 1 would quarantine every healthy model in
 * the pool, one at a time, for 24h — reproducing the exact false-positive class
 * this whole "positive evidence only" rule exists to prevent, and doing it in a
 * single turn once same-turn substitution walks the pool.
 *
 * So a 403 is only model-scoped when the provider SAYS it is. OpenRouter does,
 * twice over: a structured `metadata.failed_routing_step` in the response body
 * (`"Gate Free Endpoints by Agentic Harness"`), and the phrase in the message.
 * Anything else stays `null` — a breaker must open on evidence, not on a
 * status code that has several unrelated meanings.
 */
function hasModelScopedRefusalEvidence(err: unknown, msg: string): boolean {
  if (msg.includes(HARNESS_GATE_PHRASE)) return true;
  if (!err || typeof err !== "object") return false;
  const bodies: unknown[] = [];
  const e = err as Record<string, unknown>;
  bodies.push(e.responseBody, e.data);
  const lastError = e.lastError;
  if (lastError && typeof lastError === "object") {
    const le = lastError as Record<string, unknown>;
    bodies.push(le.responseBody, le.data);
  }
  return bodies.some((b) => {
    const text = typeof b === "string" ? b : b ? JSON.stringify(b) : "";
    // The routing-funnel field names the gate that rejected us; its presence
    // on a 403 is the provider stating this was a per-endpoint decision.
    return text.toLowerCase().includes("failed_routing_step");
  });
}

function upstreamStatusCode(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as Record<string, unknown>;
  const direct = typeof e.statusCode === "number" ? e.statusCode : typeof e.status === "number" ? e.status : undefined;
  if (direct !== undefined) return direct;
  const lastError = e.lastError;
  if (lastError && typeof lastError === "object") {
    const le = lastError as Record<string, unknown>;
    return typeof le.statusCode === "number" ? le.statusCode : typeof le.status === "number" ? le.status : undefined;
  }
  return undefined;
}

export function classifyModelFailure(err: unknown): ModelFailureKind | null {
  const msg = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();

  // A real HTTP status beats message-text guessing when one is available.
  const status = upstreamStatusCode(err);
  if (status === 429) return "throttle";
  if (status !== undefined && status >= 500 && status < 600) return "server";

  // 401 is OUR credential, not the model's fault — every endpoint on that key
  // would fail identically, so penalising this one model teaches the breaker
  // nothing and would quarantine the whole provider one model at a time.
  if (status === 401) return null;

  // 403/404 are the PERMANENT class (PM #127). 403: the provider refuses to
  // serve this model to this account/app — OpenRouter gates some `:free`
  // endpoints behind a registered-app allowlist and answers
  //   403 {"metadata":{"failed_routing_step":"Gate Free Endpoints by Agentic Harness"}}
  // which no amount of retrying or waiting will change. 404: the model id does
  // not exist upstream. That one MAY be our own bug (an id we constructed), and
  // it is logged as such — but the response is the same either way, because the
  // poisoned artifact is that id: quarantine it and substitute, rather than
  // spend the turn re-asking for a model that cannot answer.
  if (status === 403) {
    if (hasModelScopedRefusalEvidence(err, msg)) return "unusable";
    // A bare 403 is indistinguishable from an account-scoped block, so it gets
    // the same treatment as a 401: not this model's fault, do not quarantine.
    // Logged, not swallowed — if a second refusal shape shows up, this line is
    // how it gets discovered instead of silently looping (PM #127 audit).
    console.warn(
      `[ModelHealth] Upstream 403 with no model-scoped evidence (no failed_routing_step, ` +
        `no known refusal phrase) — treating as account-scoped and NOT quarantining the model. ` +
        `If this repeats on one model only, its refusal shape needs a branch: ${msg.slice(0, 200)}`
    );
    return null;
  }
  if (status === 404) {
    console.warn(
      `[ModelHealth] Upstream 404 for a chat completion — the model id does not exist. ` +
        `Quarantining it, but CHECK whether Orchestra constructed a bad id: ${msg.slice(0, 200)}`
    );
    return "unusable";
  }

  // Ours, not theirs — never penalize the endpoint.
  if (
    msg.includes("semaphore") ||
    msg.includes("context length") ||
    msg.includes("context_length") ||
    msg.includes("maximum context") ||
    msg.includes("too many tokens") ||
    msg.includes("invalid_request") ||
    msg.includes("invalid request")
  ) {
    return null;
  }

  // Status-ABSENT fallback for the permanent class, and only that. An exact
  // multi-word vendor phrase, never a single token: this runs after the
  // "ours, not theirs" guard above, so a local fault still wins, and it exists
  // solely for a transport that drops the status code on the floor. If you are
  // tempted to widen this to `"only available on"`, don't — prefer the status.
  if (msg.includes(HARNESS_GATE_PHRASE)) return "unusable";

  if (
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("rate-limit") ||
    msg.includes("ratelimit") ||
    msg.includes("too many requests") ||
    msg.includes("overloaded") ||
    msg.includes("quota") ||
    msg.includes("capacity")
  ) {
    return "throttle";
  }

  if (
    msg.includes("500") ||
    msg.includes("502") ||
    msg.includes("503") ||
    msg.includes("504") ||
    msg.includes("internal server error") ||
    msg.includes("bad gateway") ||
    msg.includes("service unavailable") ||
    msg.includes("provider returned error") ||
    msg.includes("upstream")
  ) {
    return "server";
  }

  if (
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("enotfound") ||
    msg.includes("socket hang up") ||
    msg.includes("fetch failed") ||
    msg.includes("network")
  ) {
    return "unreachable";
  }

  // Unknown → not counted. Fail-safe: a breaker that opens on unrecognised
  // errors is a breaker that opens on our own regressions.
  return null;
}

/**
 * Read one endpoint's tracked health, or `null` when it has never been
 * dispatched. Returns a COPY — callers must not mutate breaker state.
 *
 * Used by the pacing layer to slow down an endpoint that is already failing
 * (see `proposer-pacing.ts`), before the breaker's threshold is reached.
 */
export function getModelHealthEntry(
  provider: string,
  model: string
): ModelHealthEntry | null {
  const entry = store().get(modelHealthKey(provider, model));
  return entry ? { ...entry } : null;
}

/** Snapshot for observability (`/api/health`, debug routes). Sorted by key. */
export function getModelHealthSnapshot(): ModelHealthEntry[] {
  return [...store().values()]
    .map((e) => ({ ...e }))
    .sort((a, b) =>
      modelHealthKey(a.provider, a.model).localeCompare(modelHealthKey(b.provider, b.model))
    );
}

/** Test helper — clears all breaker state. */
export function resetModelHealth(): void {
  store().clear();
}

/** Minimal shape `selectHealthyConfig` needs. Any `ModelConfig` satisfies it. */
export interface HealthCheckableConfig {
  provider: string;
  model: string;
}

export interface HealthySelection<T extends HealthCheckableConfig> {
  config: T;
  /** True when `config` is NOT the caller's preferred endpoint. */
  substituted: boolean;
  /** `provider/model` of the preferred endpoint, present only when substituted. */
  substitutedFrom?: string;
  /** True when this dispatch is the half-open probe of a tripped endpoint. */
  probe?: boolean;
}

/**
 * Choose an endpoint to dispatch on:
 *   1. the preferred config, when its breaker has not tripped;
 *   2. else the first healthy candidate in the pool — rotated by `offset`;
 *   3. else the ONE half-open probe, if a tripped endpoint's cooldown elapsed;
 *   4. else the preferred config anyway (fail-open).
 *
 * **Rotation (DoubleTake #2, adopted in part).** Without it, every proposer in
 * the fan-out lands on the SAME first-healthy model the moment their shared tier
 * dies, so the ensemble's model diversity collapses to one endpoint and that one
 * absorbs the entire burst. Passing the proposer index as `offset` spreads the
 * substitutions across the pool. (DoubleTake's stronger suggestion — DROP the
 * proposer instead of substituting — was rejected: fewer drafts is precisely the
 * delivery loss this track exists to prevent, and its premise that the swarm
 * would then send "5 identical prompts" is wrong — each persona carries its own
 * system prompt, so role diversity survives a shared model.)
 *
 * **Fail-open (step 4) is deliberate.** When every candidate is tripped, running
 * the operator's own choice beats refusing to dispatch: the breaker's job is to
 * route around a dead endpoint, never to become one.
 */
export function selectHealthyConfig<T extends HealthCheckableConfig>(
  preferred: T,
  candidates: readonly T[] = [],
  offset = 0
): HealthySelection<T> {
  if (!isModelCircuitOpen(preferred.provider, preferred.model)) {
    return { config: preferred, substituted: false };
  }

  const preferredKey = modelHealthKey(preferred.provider, preferred.model);
  const seen = new Set<string>([preferredKey]);
  const pool: T[] = [];
  for (const candidate of candidates) {
    if (!candidate?.provider || !candidate?.model) continue;
    const key = modelHealthKey(candidate.provider, candidate.model);
    if (seen.has(key)) continue;
    seen.add(key);
    pool.push(candidate);
  }

  // Rotate so concurrent proposers prefer DIFFERENT substitutes.
  const rotated =
    pool.length > 1 && offset > 0
      ? pool.slice(offset % pool.length).concat(pool.slice(0, offset % pool.length))
      : pool;

  for (const candidate of rotated) {
    if (!isModelCircuitOpen(candidate.provider, candidate.model)) {
      return { config: candidate, substituted: true, substitutedFrom: preferredKey };
    }
  }

  // Nothing healthy. Spend the half-open probe if one is available — preferring
  // the operator's own model, then the pool.
  for (const candidate of [preferred, ...rotated]) {
    if (tryAcquireProbe(candidate.provider, candidate.model)) {
      const key = modelHealthKey(candidate.provider, candidate.model);
      return {
        config: candidate,
        substituted: key !== preferredKey,
        substitutedFrom: key !== preferredKey ? preferredKey : undefined,
        probe: true,
      };
    }
  }

  // Everything tripped, no probe available — fail open on the operator's choice.
  return { config: preferred, substituted: false };
}
