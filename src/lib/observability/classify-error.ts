/**
 * Map an arbitrary thrown value into a structured `ChatErrorPayload`.
 *
 * Why a separate module: error classification is the one piece of
 * observability code that's pure logic — no AsyncLocalStorage, no I/O.
 * Keeping it standalone makes it trivially testable and reusable from
 * any catch block in the agent path.
 *
 * The classifier looks at the AI SDK's `AI_APICallError` shape (which is
 * the dominant source of post-MoA failures, per PM #17), the standard
 * `AbortError` from request cancellation, and falls through to a generic
 * "internal" bucket for everything else. New cases are added here as
 * they're discovered — keep the function small and explicit, not clever.
 */
import type { ChatErrorPayload } from "@/lib/realtime/types";
import { isStreamStall } from "@/lib/observability/stream-stall";

interface ApiCallErrorShape {
  name?: string;
  statusCode?: number;
  url?: string;
  responseBody?: string;
  message?: string;
}

function asApiCallError(err: unknown): ApiCallErrorShape | null {
  if (!err || typeof err !== "object") return null;
  const candidate = err as ApiCallErrorShape;
  // The Vercel AI SDK throws errors with `name === "AI_APICallError"` and a
  // `statusCode` field. Duck-type instead of importing the SDK class — the
  // shape is stable across SDK versions, the exported class has changed.
  if (candidate.name === "AI_APICallError" && typeof candidate.statusCode === "number") {
    return candidate;
  }
  return null;
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; message?: string };
  return e.name === "AbortError" || /aborted/i.test(e.message ?? "");
}

export function classifyChatError(err: unknown, traceId?: string): ChatErrorPayload {
  // PM #98 — MUST precede the abort branch. A watchdog stall aborts the stream,
  // so it IS an AbortError by name (deliberately, so the AI SDK does not retry
  // it) and would otherwise be reported as "Request was cancelled." — telling a
  // user they cancelled a turn they were sitting waiting on. The stall message
  // is already user-safe: a model id and a duration, no paths or internals.
  if (isStreamStall(err)) {
    return {
      traceId,
      kind: "stream_stalled",
      message: err.message,
      hint:
        err.orchestraStreamStall === "ttft"
          ? "The provider accepted the connection and sent nothing. Free endpoints do " +
            "this under load — retry, or switch models in Settings → Models."
          : "The connection dropped mid-answer. Retry; if it repeats, switch models.",
      recoverable: true,
    };
  }

  // `AbortSignal.timeout` aborts with a `TimeoutError` DOMException whose
  // message reads "…aborted due to timeout" — so it matches `isAbortError`'s
  // /aborted/i test and, without this branch ahead of it, a call that BLEW ITS
  // DEADLINE is reported as "Request was cancelled." Same lie as a stall, and
  // it predates PM #98: the proposer and judge deadlines have always produced
  // this error shape.
  if (err && typeof err === "object" && (err as { name?: string }).name === "TimeoutError") {
    return {
      traceId,
      kind: "stream_stalled",
      message: "The model provider did not answer within the time limit.",
      hint: "Retry — a free endpoint under load frequently succeeds on a second attempt.",
      recoverable: true,
    };
  }

  if (isAbortError(err)) {
    return {
      traceId,
      kind: "abort",
      message: "Request was cancelled.",
      recoverable: false,
    };
  }

  const apiErr = asApiCallError(err);
  if (apiErr) {
    const status = apiErr.statusCode ?? 0;
    const body = apiErr.responseBody ?? "";

    // PM #17 — the precise marker that "the model rejected tool use." We
    // detect this by status + body substring rather than a generic 4xx
    // bucket because the user-facing hint is much more actionable.
    if (status === 404 && /no endpoints found that support tool/i.test(body)) {
      return {
        traceId,
        kind: "upstream_no_tools",
        message: "The selected chat model doesn't support tool calling via this provider.",
        hint:
          "Switch to a tool-capable model in Settings → Models " +
          "(e.g., openai/gpt-4o-mini, anthropic/claude-3-5-haiku, " +
          "or google/gemini-2.5-flash via OpenRouter).",
        recoverable: false,
      };
    }

    if (status === 429) {
      return {
        traceId,
        kind: "upstream_rate_limit",
        message: "Upstream provider rate-limited the request.",
        hint: "Wait a few seconds and retry. If this persists, check your provider quota.",
        recoverable: true,
      };
    }

    if (status >= 500 && status < 600) {
      return {
        traceId,
        kind: "upstream_5xx",
        message: `Upstream provider returned ${status}.`,
        recoverable: true,
      };
    }

    if (status >= 400 && status < 500) {
      return {
        traceId,
        kind: "upstream_4xx",
        message: apiErr.message?.slice(0, 200) ?? `Upstream returned ${status}.`,
        recoverable: false,
      };
    }
  }

  // Final fallback. We deliberately do NOT echo the raw error message back
  // to the UI — internal stack traces leak shape (paths, package versions,
  // sometimes secrets via cause chains). The trace id covers diagnosis.
  return {
    traceId,
    kind: "internal",
    message: "An internal error occurred while processing the request.",
    hint: "Check the server log for trace id, or retry.",
    recoverable: false,
  };
}
