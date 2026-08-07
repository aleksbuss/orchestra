/**
 * A time bound for a streaming model call that does NOT cap honest work.
 *
 * PM #98 — WHY THIS EXISTS. Free Mode put a tool-incapable model in the brain
 * slot; `agent.ts` correctly dropped to plain-chat mode, issued one `streamText`
 * call, and the free endpoint accepted the connection and then said nothing.
 * The turn hung for SEVEN MINUTES with no answer, no error and no banner. The
 * reason nothing fired is that nothing was watching:
 *
 *   - `streamText` got `abortSignal: options.abortSignal` (the user's request
 *     signal) and `maxRetries: 3`, and NOTHING else. No timeout.
 *   - `llm-provider.ts` had no timeout either — grepping it for
 *     `AbortSignal.timeout` returned zero matches.
 *   - `generateFinalAnswerWithFailover`, the delivery ladder, only runs AFTER a
 *     stream completes EMPTY. A stream that never completes never reaches it.
 *
 * The proposer path had been bounded at two minutes since the free-tier failover
 * work (`moa-proposers.ts`, `ORCHESTRA_PROPOSER_TIMEOUT_MS`). The interactive
 * path — the one a human is actually staring at — had nothing.
 *
 * WHY NOT A SINGLE TOTAL-DURATION TIMEOUT. Because a legitimate agentic turn can
 * run for a very long time and still be healthy: `install-orchestrator` alone
 * allows a ten-minute command. A wall-clock cap would kill real work, which is
 * a worse failure than the one it fixes. Two narrower instruments instead:
 *
 *   1. TIME TO FIRST TOKEN — how long the provider may stay silent before it
 *      has said anything at all. Re-armed at every step boundary, because each
 *      step opens a fresh upstream request that can hang exactly the same way.
 *   2. AN INTER-CHUNK IDLE WATCHDOG — reset by every chunk. This catches a
 *      connection that died mid-answer without capping a long one.
 *
 * And the critical exemption: the idle timer is DISARMED while a tool executes.
 * Tool execution emits no chunks and is bounded by each tool's own timeout, so
 * counting it as "the stream stalled" would abort a healthy 10-minute install.
 * Getting this wrong is how a timeout fix becomes a worse bug than the hang.
 *
 * The abort reason is a `StreamStalledError` from `observability/stream-stall.ts`
 * — shared with the transport-level bound in `providers/fetch-timeout.ts` so the
 * two layers cannot classify the same phenomenon differently. `classifyChatError`
 * looks for its marker BEFORE the generic abort branch, so the user is told the
 * stream stalled rather than the untrue "Request was cancelled."
 */

import { StreamStalledError, type StreamStallKind } from "@/lib/observability/stream-stall";
import { log } from "@/lib/observability/logger";

/** Provider gets this long to emit its first chunk of a step. */
const DEFAULT_TTFT_MS = 90_000;
/** Longest silence allowed BETWEEN chunks, excluding tool execution. */
const DEFAULT_IDLE_MS = 120_000;

export interface StreamWatchdog {
  /** Pass to `streamText({ abortSignal })` — composed with the caller's signal. */
  readonly signal: AbortSignal;
  /** A chunk arrived: the provider is alive. Re-arms the idle timer. */
  noteActivity(): void;
  /**
   * A tool call was emitted, so execution — which produces no chunks and has
   * its own timeout — is about to start. Disarms until the next activity.
   */
  pauseForToolExecution(): void;
  /** A step finished; a fresh upstream request follows. Re-arms the TTFT timer. */
  noteStepBoundary(): void;
  /** The stream is over (finished or errored). Idempotent; clears all timers. */
  settle(): void;
  /** The error we aborted with, or `null` if we did not abort. */
  readonly stalled: StreamStalledError | null;
}

/** Read a positive-integer ms budget from the environment. */
function envBudget(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  // NaN or negative is a typo, not an intent — do not silently disable the
  // watchdog on a fat-fingered value. `0` IS honoured: it is the documented
  // escape hatch for an operator who wants the bound off.
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

export interface StreamWatchdogOptions {
  /** Named in the user-facing message — pass the model id, never a URL or key. */
  label: string;
  /** Override the TTFT budget (ms). `0` disables it. */
  ttftMs?: number;
  /** Override the idle budget (ms). `0` disables it. */
  idleMs?: number;
}

/**
 * Create a watchdog for one streaming call.
 *
 * The returned `signal` is the caller's signal composed with the watchdog's, so
 * a user pressing cancel still aborts immediately and with THEIR reason — the
 * watchdog only ever adds a way to stop, never removes one.
 *
 * Timers are `unref`'d where the runtime supports it, so a forgotten `settle()`
 * can never hold a process open.
 */
export function createStreamWatchdog(
  base: AbortSignal | undefined,
  options: StreamWatchdogOptions
): StreamWatchdog {
  const ttftMs = options.ttftMs ?? envBudget("ORCHESTRA_STREAM_TTFT_MS", DEFAULT_TTFT_MS);
  const idleMs = options.idleMs ?? envBudget("ORCHESTRA_STREAM_IDLE_MS", DEFAULT_IDLE_MS);

  const controller = new AbortController();
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settled = false;
  let stalled: StreamStalledError | null = null;

  function disarm() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function arm(kind: StreamStallKind, budgetMs: number) {
    disarm();
    if (settled || budgetMs <= 0) return;
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      timer = null;
      stalled = new StreamStalledError(kind, budgetMs, Date.now() - startedAt, options.label);
      controller.abort(stalled);
    }, budgetMs);
    // `unref` exists on Node's Timeout, not on the DOM's numeric handle.
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  arm("ttft", ttftMs);

  return {
    signal: base ? AbortSignal.any([base, controller.signal]) : controller.signal,
    noteActivity() {
      arm("idle", idleMs);
    },
    pauseForToolExecution() {
      disarm();
    },
    noteStepBoundary() {
      arm("ttft", ttftMs);
    },
    settle() {
      settled = true;
      disarm();
    },
    get stalled() {
      return stalled;
    },
  };
}

/** Default bound for a NON-streaming call (`generateText` / `generateObject`). */
const DEFAULT_CALL_DEADLINE_MS = 120_000;

/**
 * A time bound for a non-streaming call.
 *
 * PM #98 — the watchdog above needs chunks, and `generateText` has none: it
 * resolves once, at the end. So the instrument there is a plain total-duration
 * deadline, which is safe precisely because a non-streaming call cannot be
 * "legitimately long because a tool is running" — its tools have already run
 * inside it… which is why the budget is generous rather than tight.
 *
 * This is the pattern `moa-proposers.ts` and `tournament-aggregator.ts` have
 * used for months (`AbortSignal.any([caller, AbortSignal.timeout(N)])`), lifted
 * into one place so the other call sites stop being the exception. The
 * `AbortSignal.any` feature-detect is kept from the original: it needs Node
 * 20.3+, and losing the caller's signal would be worse than losing the bound.
 */
export function callDeadlineSignal(
  abortSignal: AbortSignal | undefined,
  timeoutMs: number = Number(
    process.env.ORCHESTRA_CALL_DEADLINE_MS ?? DEFAULT_CALL_DEADLINE_MS
  )
): AbortSignal | undefined {
  // A typo must not silently disable the bound; `0` is the documented opt-out.
  const ms = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : DEFAULT_CALL_DEADLINE_MS;
  if (ms === 0) return abortSignal;
  const deadline = AbortSignal.timeout(ms);
  if (!abortSignal) return deadline;
  return typeof AbortSignal.any === "function"
    ? AbortSignal.any([abortSignal, deadline])
    : abortSignal;
}

/**
 * Record that a turn ended on a BOUND rather than on a provider error.
 *
 * Rule 18 — a system-limit stop is signalled by the system, deterministically.
 * The model never got to say anything here, so this line is the only record
 * that distinguishes "the endpoint went quiet" from "the endpoint errored", and
 * they need different operator responses. No-op when nothing stalled.
 */
export function logStreamStall(
  watchdog: StreamWatchdog,
  ctx: { chatId: string; projectId?: string; model: string }
): void {
  const stall = watchdog.stalled;
  if (!stall) return;
  log.warn("agent_stream_stalled", {
    chatId: ctx.chatId,
    projectId: ctx.projectId,
    model: ctx.model,
    stall: stall.orchestraStreamStall,
    budgetMs: stall.budgetMs,
    elapsedMs: stall.elapsedMs,
  });
}
