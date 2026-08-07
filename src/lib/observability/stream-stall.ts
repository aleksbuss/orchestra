/**
 * The shared vocabulary for "the provider accepted the connection and then said
 * nothing" (PM #98).
 *
 * TWO layers detect this, and they must classify identically or the UI message
 * depends on which one happened to fire first:
 *
 *   - `src/lib/agent/stream-watchdog.ts` — the SEMANTIC bound. It watches the
 *     decoded stream: no first token, or no chunk for too long.
 *   - `src/lib/providers/fetch-timeout.ts` — the TRANSPORT bound. It watches the
 *     socket: no response HEADERS at all.
 *
 * The vocabulary lives here, in neither of them, because `providers` is below
 * `agent` in the dependency order and `classify-error.ts` (the third consumer)
 * must not import either. A shared marker beats two hand-copied string literals:
 * a drifting duplicate is exactly how one path stays honest and the other starts
 * reporting a stall as an internal error.
 *
 * DETECTION IS STRUCTURAL, never by `name` or message text. Both classes
 * deliberately borrow a standard `name` for their own reason, so `name` cannot
 * be the discriminator.
 */

/** Which bound was exceeded. */
export type StreamStallKind = "ttft" | "idle";

/** What every stall carries, whichever layer raised it. */
export interface StreamStallSignal extends Error {
  readonly orchestraStreamStall: StreamStallKind;
  /** The bound that was exceeded, in ms. */
  readonly budgetMs: number;
  /** Wall-clock ms from the start of the watched operation to the abort. */
  readonly elapsedMs: number;
}

/**
 * True for either layer's stall.
 *
 * Duck-typed on the marker property. A REAL user cancellation shares the
 * `AbortError` name with `StreamStalledError` and must not match — telling
 * someone who sat waiting on a dead endpoint that they cancelled their own turn
 * is the specific dishonesty this predicate exists to prevent.
 */
export function isStreamStall(err: unknown): err is StreamStallSignal {
  if (!err || typeof err !== "object") return false;
  const kind = (err as StreamStallSignal).orchestraStreamStall;
  return kind === "ttft" || kind === "idle";
}

/**
 * Raised by the stream watchdog.
 *
 * `name` is `"AbortError"` ON PURPOSE: the watchdog aborts the call through an
 * `AbortController`, and the AI SDK must treat that as a cancellation rather
 * than burn `maxRetries` re-running a request we deliberately killed — which
 * would triple the wall clock of the very hang this bounds.
 */
export class StreamStalledError extends Error implements StreamStallSignal {
  override readonly name = "AbortError";
  readonly orchestraStreamStall: StreamStallKind;
  readonly budgetMs: number;
  readonly elapsedMs: number;

  constructor(kind: StreamStallKind, budgetMs: number, elapsedMs: number, label: string) {
    super(
      kind === "ttft"
        ? `${label} sent no response within ${Math.round(budgetMs / 1000)}s.`
        : `${label} stopped mid-response — no output for ${Math.round(budgetMs / 1000)}s.`
    );
    this.orchestraStreamStall = kind;
    this.budgetMs = budgetMs;
    this.elapsedMs = elapsedMs;
  }
}

/**
 * Raised by the provider fetch wrapper when response HEADERS never arrive.
 *
 * `name` is `"TimeoutError"`, NOT `"AbortError"`, and the difference is the
 * whole point of having two classes: this one SHOULD be retried. Converting a
 * silently stalled TCP connection into a prompt, retryable failure is what the
 * bound is for — `maxRetries: 3` cannot help while the socket is merely open
 * and quiet, because nothing has failed yet for it to react to.
 */
export class ProviderHeadersTimeoutError extends Error implements StreamStallSignal {
  override readonly name = "TimeoutError";
  readonly orchestraStreamStall = "ttft" as const;
  readonly budgetMs: number;
  readonly elapsedMs: number;

  constructor(budgetMs: number, elapsedMs: number, label: string) {
    super(`${label} sent no response headers within ${Math.round(budgetMs / 1000)}s.`);
    this.budgetMs = budgetMs;
    this.elapsedMs = elapsedMs;
  }
}
