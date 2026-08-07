/**
 * PM #98 — the transport-level half of the hang fix.
 *
 * The single most important test in this file is
 * "does NOT truncate a slow streaming body": the naive implementation of this
 * bound (`signal: AbortSignal.timeout(ms)`) silently cuts every generation
 * longer than the budget, which is a far worse bug than the hang it fixes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHeadersTimeoutFetch } from "./fetch-timeout";
import { isStreamStall } from "@/lib/observability/stream-stall";

/** A `fetch` that resolves after `ms`, or never if `ms` is null. */
function slowFetch(ms: number | null, response: unknown = { ok: true }) {
  return vi.fn(
    (_input: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((resolve, reject) => {
        if (ms !== null) setTimeout(() => resolve(response), ms);
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })
  );
}

describe("createHeadersTimeoutFetch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("rejects with a stall marker when headers never arrive", async () => {
    vi.stubGlobal("fetch", slowFetch(null));
    const wrapped = createHeadersTimeoutFetch({ label: "openrouter", timeoutMs: 1000 });
    const pending = wrapped("https://x/y");
    const assertion = expect(pending).rejects.toSatisfy(isStreamStall);
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
  });

  it("names the provider and the budget without leaking the url or a key", async () => {
    vi.stubGlobal("fetch", slowFetch(null));
    const wrapped = createHeadersTimeoutFetch({ label: "openrouter", timeoutMs: 1000 });
    const pending = wrapped("https://openrouter.ai/api/v1/chat?key=sk-secret");
    const assertion = expect(pending).rejects.toThrow(/openrouter sent no response headers within 1s/);
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
  });

  it("passes headers through untouched when the provider answers in time", async () => {
    const inner = slowFetch(100, { ok: true, status: 200 });
    vi.stubGlobal("fetch", inner);
    const wrapped = createHeadersTimeoutFetch({ label: "p", timeoutMs: 1000 });
    const pending = wrapped("https://x/y");
    await vi.advanceTimersByTimeAsync(101);
    await expect(pending).resolves.toMatchObject({ status: 200 });
  });

  it("does NOT truncate a slow streaming body once headers have arrived", async () => {
    // The regression this bound must never cause. Headers land inside the
    // budget; the body then streams for ten times the budget, which is normal
    // for a long generation and must be left alone.
    let bodySignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_i: unknown, init?: { signal?: AbortSignal }) => {
        bodySignal = init?.signal;
        return Promise.resolve({ ok: true });
      })
    );
    const wrapped = createHeadersTimeoutFetch({ label: "p", timeoutMs: 1000 });
    await wrapped("https://x/y");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(bodySignal?.aborted).toBe(false);
  });

  it("preserves the caller's signal — cancel must still work", async () => {
    // Also the answer to "does the user's AbortSignal actually reach fetch?".
    // If this wrapper ever replaced the signal instead of composing it, the
    // stop button would silently do nothing.
    const user = new AbortController();
    vi.stubGlobal("fetch", slowFetch(null));
    const wrapped = createHeadersTimeoutFetch({ label: "p", timeoutMs: 60_000 });
    const pending = wrapped("https://x/y", { signal: user.signal });
    const assertion = expect(pending).rejects.toThrow("user cancelled");
    user.abort(new Error("user cancelled"));
    await assertion;
  });

  it("a user cancel is NOT reported as a provider stall", async () => {
    const user = new AbortController();
    vi.stubGlobal("fetch", slowFetch(null));
    const wrapped = createHeadersTimeoutFetch({ label: "p", timeoutMs: 60_000 });
    const pending = wrapped("https://x/y", { signal: user.signal });
    const assertion = expect(pending).rejects.toSatisfy((e) => !isStreamStall(e));
    user.abort(new Error("user cancelled"));
    await assertion;
  });

  it("timeoutMs=0 disables the bound and passes init through verbatim", async () => {
    const inner = slowFetch(5_000, { ok: true });
    vi.stubGlobal("fetch", inner);
    const wrapped = createHeadersTimeoutFetch({ label: "p", timeoutMs: 0 });
    const pending = wrapped("https://x/y", { method: "POST" });
    await vi.advanceTimersByTimeAsync(5_001);
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(inner.mock.calls[0][1]).toMatchObject({ method: "POST" });
  });

  it("reads the budget from the environment", async () => {
    vi.stubEnv("ORCHESTRA_PROVIDER_HEADERS_TIMEOUT_MS", "500");
    vi.stubGlobal("fetch", slowFetch(null));
    const wrapped = createHeadersTimeoutFetch({ label: "p" });
    const pending = wrapped("https://x/y");
    const assertion = expect(pending).rejects.toSatisfy(isStreamStall);
    await vi.advanceTimersByTimeAsync(501);
    await assertion;
  });

  it("ignores a garbage env value rather than disabling the bound", async () => {
    vi.stubEnv("ORCHESTRA_PROVIDER_HEADERS_TIMEOUT_MS", "one minute");
    vi.stubGlobal("fetch", slowFetch(null));
    const wrapped = createHeadersTimeoutFetch({ label: "p" });
    const pending = wrapped("https://x/y");
    const assertion = expect(pending).rejects.toSatisfy(isStreamStall);
    await vi.advanceTimersByTimeAsync(60_001);
    await assertion;
  });

  it("does not leave a timer armed after a fast response", async () => {
    vi.stubGlobal("fetch", slowFetch(10, { ok: true }));
    const wrapped = createHeadersTimeoutFetch({ label: "p", timeoutMs: 1000 });
    const pending = wrapped("https://x/y");
    await vi.advanceTimersByTimeAsync(11);
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });
});
