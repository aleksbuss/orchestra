/**
 * A per-attempt bound on how long a provider may take to send response HEADERS.
 *
 * PM #98 — the third gap behind the seven-minute hang. `streamText` had
 * `maxRetries: 3`, which sounds like a bound and is not one: retries fire on a
 * FAILURE, and a socket that is open, accepted and silent has not failed. Node
 * will sit on it until a keepalive or OS-level timeout expires, which is
 * minutes. Converting that silence into a prompt, retryable error is what makes
 * `maxRetries` mean something.
 *
 * ⚠️ THE TRAP THIS FILE EXISTS TO AVOID. The obvious implementation —
 * `fetch(url, { signal: AbortSignal.timeout(ms) })` — is WRONG for a streaming
 * provider. That signal stays live for the whole response, so it destroys the
 * BODY mid-answer once the budget expires, truncating every generation longer
 * than the timeout. `fetch` resolves as soon as headers arrive, so clearing the
 * timer in a `finally` bounds exactly the connect-and-wait phase and never
 * touches the body stream. If you change this file, that `finally` is the line
 * that matters.
 *
 * This is deliberately NOT a second stream watchdog. It cannot see tokens — only
 * whether the provider ever started answering. The semantic bound lives in
 * `agent/stream-watchdog.ts`; both raise the same marker so a stall is reported
 * honestly whichever layer catches it first.
 */
import { ProviderHeadersTimeoutError } from "@/lib/observability/stream-stall";

/**
 * Default headroom for a provider to return headers. Generous on purpose: a
 * cold free-tier endpoint can legitimately queue a request for a while, and a
 * false positive here spends real money re-running a request that was fine.
 */
const DEFAULT_HEADERS_TIMEOUT_MS = 60_000;

/** Read a positive-integer ms budget from the environment. */
function envBudget(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  // A typo must not silently disable the bound — that is how the hang returns
  // with nobody noticing. `0` IS honoured as the documented escape hatch.
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

export interface HeadersTimeoutFetchOptions {
  /** Named in the error message — a provider name, never a URL or a key. */
  label: string;
  /** Override the budget (ms). `0` disables the bound entirely. */
  timeoutMs?: number;
}

/**
 * Wrap `fetch` so an attempt that never returns headers rejects promptly.
 *
 * The caller's `signal` is preserved and composed, never replaced: a user
 * pressing cancel must still abort instantly, and with THEIR reason. This
 * wrapper only ever adds a way to stop.
 */
export function createHeadersTimeoutFetch(
  options: HeadersTimeoutFetchOptions
): typeof globalThis.fetch {
  const timeoutMs =
    options.timeoutMs ?? envBudget("ORCHESTRA_PROVIDER_HEADERS_TIMEOUT_MS", DEFAULT_HEADERS_TIMEOUT_MS);

  return async (input, init) => {
    if (timeoutMs <= 0) return fetch(input, init);

    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(
        new ProviderHeadersTimeoutError(timeoutMs, Date.now() - startedAt, options.label)
      );
    }, timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();

    const callerSignal = init?.signal ?? undefined;
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, controller.signal])
      : controller.signal;

    try {
      return await fetch(input, { ...init, signal });
    } finally {
      // Headers have arrived (or the attempt failed). Everything after this is
      // body streaming, which this bound must never interrupt.
      clearTimeout(timer);
    }
  };
}
