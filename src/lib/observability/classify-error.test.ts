/**
 * Tests for `classifyChatError` — pure-function error mapping.
 *
 * Coverage targets the actual production failures we've seen + the
 * classifier's safety contracts:
 *   - PM #17 — `AI_APICallError` with status 404 + "no endpoints found
 *     that support tool use" body → `upstream_no_tools` with an actionable
 *     hint pointing to Settings → Models.
 *   - 429 → rate-limit, recoverable.
 *   - Generic 5xx → recoverable.
 *   - Generic 4xx → non-recoverable.
 *   - Aborts (browser tab closed) → `abort`.
 *   - Anything else → `internal`, with NO raw error text echoed back.
 *
 * The "no raw error text" rule is the privacy guarantee — internal errors
 * may carry stack traces, file paths, or in cause-chains even API keys.
 * The classifier is the last hop before the message reaches the user via
 * SSE, so it's the right place to enforce a sanitized message.
 */
import { describe, it, expect } from "vitest";
import { classifyChatError } from "./classify-error";
import {
  StreamStalledError,
  ProviderHeadersTimeoutError,
} from "@/lib/observability/stream-stall";

function fakeApiCallError(opts: {
  statusCode: number;
  responseBody?: string;
  message?: string;
}): Error & { name: string; statusCode: number; responseBody?: string; url?: string } {
  const err = new Error(opts.message ?? `HTTP ${opts.statusCode}`);
  Object.assign(err, {
    name: "AI_APICallError",
    statusCode: opts.statusCode,
    responseBody: opts.responseBody,
    url: "https://upstream.example/api",
  });
  return err as Error & {
    name: string;
    statusCode: number;
    responseBody?: string;
    url?: string;
  };
}

describe("classifyChatError — PM #17 specific shape", () => {
  it("404 + 'No endpoints found that support tool use' → upstream_no_tools with hint", () => {
    const err = fakeApiCallError({
      statusCode: 404,
      responseBody: JSON.stringify({
        error: {
          message: 'No endpoints found that support tool use. Try disabling "inject_mcp_defaults".',
          code: 404,
        },
      }),
    });

    const out = classifyChatError(err, "trace-123");
    expect(out.kind).toBe("upstream_no_tools");
    expect(out.recoverable).toBe(false);
    expect(out.traceId).toBe("trace-123");
    expect(out.hint).toMatch(/Settings.*Models/i);
    expect(out.message).not.toContain("inject_mcp_defaults"); // sanitized
  });

  it("404 with a different body falls into generic 4xx, not the no-tools bucket", () => {
    const err = fakeApiCallError({
      statusCode: 404,
      responseBody: JSON.stringify({ error: { message: "model not found" } }),
    });
    const out = classifyChatError(err);
    expect(out.kind).toBe("upstream_4xx");
  });
});

describe("classifyChatError — status-code buckets", () => {
  it("429 → upstream_rate_limit, recoverable=true", () => {
    const err = fakeApiCallError({ statusCode: 429 });
    const out = classifyChatError(err);
    expect(out.kind).toBe("upstream_rate_limit");
    expect(out.recoverable).toBe(true);
  });

  it("500 → upstream_5xx, recoverable=true", () => {
    const err = fakeApiCallError({ statusCode: 503 });
    const out = classifyChatError(err);
    expect(out.kind).toBe("upstream_5xx");
    expect(out.recoverable).toBe(true);
  });

  it("400 → upstream_4xx, recoverable=false", () => {
    const err = fakeApiCallError({ statusCode: 400, message: "invalid argument" });
    const out = classifyChatError(err);
    expect(out.kind).toBe("upstream_4xx");
    expect(out.recoverable).toBe(false);
  });
});

describe("classifyChatError — abort path", () => {
  it("named AbortError → abort, recoverable=false", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    const out = classifyChatError(err);
    expect(out.kind).toBe("abort");
    expect(out.recoverable).toBe(false);
  });

  it("generic Error with 'aborted' in the message → abort", () => {
    const out = classifyChatError(new Error("The operation was aborted."));
    expect(out.kind).toBe("abort");
  });
});

describe("classifyChatError — PM #98 stream stall", () => {
  it("a watchdog stall is NOT reported as a user cancellation", () => {
    // The stall carries `name === "AbortError"` deliberately, so that the AI
    // SDK does not retry it. That makes ORDER load-bearing here: if the stall
    // branch ever moves below the abort branch, a user who sat waiting on a
    // silent provider is told "Request was cancelled." — which they did not do.
    const out = classifyChatError(new StreamStalledError("ttft", 90_000, 90_001, "openrouter/x:free"));
    expect(out.kind).toBe("stream_stalled");
    expect(out.message).not.toMatch(/cancel/i);
  });

  it("surfaces the model and the elapsed budget, and stays recoverable", () => {
    const out = classifyChatError(new StreamStalledError("ttft", 90_000, 90_001, "openrouter/x:free"));
    expect(out.message).toContain("openrouter/x:free");
    expect(out.message).toContain("90s");
    // A retry frequently lands on a healthier free endpoint, so the UI should
    // offer one rather than presenting a dead end.
    expect(out.recoverable).toBe(true);
    expect(out.hint).toBeTruthy();
  });

  it("classifies the TRANSPORT-level stall identically to the semantic one", () => {
    // Two layers can detect the same phenomenon; whichever fires first, the
    // user must get the same story. The transport error carries a different
    // `name` on purpose (it is retryable), so `name` cannot be the key.
    const transport = classifyChatError(
      new ProviderHeadersTimeoutError(60_000, 60_001, "openrouter")
    );
    expect(transport.kind).toBe("stream_stalled");
    expect(transport.recoverable).toBe(true);
    expect(transport.message).toContain("openrouter");
  });

  it("distinguishes a mid-answer drop from a provider that never spoke", () => {
    const ttft = classifyChatError(new StreamStalledError("ttft", 1000, 1001, "m"));
    const idle = classifyChatError(new StreamStalledError("idle", 1000, 1001, "m"));
    expect(ttft.hint).not.toBe(idle.hint);
    expect(idle.message).toMatch(/mid-response/i);
  });
});

describe("classifyChatError — generic / unknown", () => {
  it("plain Error not from the AI SDK → internal, message is sanitized", () => {
    const err = new Error(
      "ENOENT: no such file '/etc/secret-config.json' (api_key=sk-actual-secret)"
    );
    const out = classifyChatError(err);
    expect(out.kind).toBe("internal");
    expect(out.message).not.toContain("sk-actual-secret");
    expect(out.message).not.toContain("/etc/secret-config.json");
    expect(out.recoverable).toBe(false);
  });

  it("non-Error thrown values do not crash the classifier", () => {
    expect(() => classifyChatError("string thrown")).not.toThrow();
    expect(() => classifyChatError(42)).not.toThrow();
    expect(() => classifyChatError(null)).not.toThrow();
    expect(() => classifyChatError(undefined)).not.toThrow();

    expect(classifyChatError("string thrown").kind).toBe("internal");
    expect(classifyChatError(null).kind).toBe("internal");
  });

  it("threads traceId through every branch", () => {
    expect(classifyChatError(new Error("x"), "T1").traceId).toBe("T1");
    expect(classifyChatError(fakeApiCallError({ statusCode: 429 }), "T2").traceId).toBe("T2");
    expect(classifyChatError("oops", "T3").traceId).toBe("T3");
  });
});
