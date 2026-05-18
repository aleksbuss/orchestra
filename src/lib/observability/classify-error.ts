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
