/**
 * PM #43 — local-backend probe contracts.
 *
 * Pinned:
 *   - probeLocalBackend never throws, always returns DetectionResult.
 *   - Timeout maps to reason: "timeout".
 *   - Connection refused maps to reason: "refused".
 *   - HTTP 200 with non-OpenAI shape ("{...}" missing data: []) → "non_openai_shape".
 *   - SSRF-disallowed URL (private IP etc.) → "url_blocked", no fetch.
 *   - formatDetectionSummary produces a human-readable single-line string
 *     including model counts + prefix-cache notes.
 *   - detectLocalBackends probes every entry in KNOWN_LOCAL_BACKENDS.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectLocalBackends,
  formatDetectionSummary,
  KNOWN_LOCAL_BACKENDS,
  probeLocalBackend,
  type LocalBackendCandidate,
} from "./local-backend-detect";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

const sglang: LocalBackendCandidate = {
  provider: "sglang",
  name: "SGLang",
  baseUrl: "http://localhost:30000",
  supportsPrefixCache: true,
};

describe("PM #43 — probeLocalBackend", () => {
  it("HTTP 200 with OpenAI shape → available + model count", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "qwen-7b" },
          { id: "qwen-32b" },
          { id: "llama-3.1-8b" },
        ],
      }),
    } as Response);
    const r = await probeLocalBackend(sglang);
    expect(r.available).toBe(true);
    expect(r.modelCount).toBe(3);
    expect(r.reason).toBeUndefined();
  });

  it("HTTP non-200 → reason: 'non_200'", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({}),
    } as Response);
    const r = await probeLocalBackend(sglang);
    expect(r.available).toBe(false);
    expect(r.reason).toBe("non_200");
  });

  it("HTTP 200 but shape doesn't match OpenAI catalog → reason: 'non_openai_shape'", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "ok" }), // not { data: [...] }
    } as Response);
    const r = await probeLocalBackend(sglang);
    expect(r.available).toBe(false);
    expect(r.reason).toBe("non_openai_shape");
  });

  it("connection refused → reason: 'refused'", async () => {
    global.fetch = vi.fn().mockRejectedValue(
      Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" })
    );
    const r = await probeLocalBackend(sglang);
    expect(r.available).toBe(false);
    expect(r.reason).toBe("refused");
  });

  it("AbortError (timeout) → reason: 'timeout'", async () => {
    global.fetch = vi.fn().mockRejectedValue(
      Object.assign(new Error("aborted"), { name: "AbortError" })
    );
    const r = await probeLocalBackend(sglang);
    expect(r.available).toBe(false);
    expect(r.reason).toBe("timeout");
  });

  it("disallowed URL (private-IP candidate) → reason: 'url_blocked', no fetch", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;
    const evil: LocalBackendCandidate = {
      provider: "sglang",
      name: "Evil",
      baseUrl: "http://169.254.169.254", // AWS metadata
      supportsPrefixCache: false,
    };
    const r = await probeLocalBackend(evil);
    expect(r.available).toBe(false);
    expect(r.reason).toBe("url_blocked");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("PM #43 — detectLocalBackends", () => {
  it("probes every entry in KNOWN_LOCAL_BACKENDS exactly once", async () => {
    let calls = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      calls += 1;
      return {
        ok: true,
        json: async () => ({ data: [] }),
      } as Response;
    });
    const results = await detectLocalBackends();
    expect(results).toHaveLength(KNOWN_LOCAL_BACKENDS.length);
    expect(calls).toBe(KNOWN_LOCAL_BACKENDS.length);
  });
});

describe("PM #43 — formatDetectionSummary", () => {
  it("renders detected + not-detected on a single line", () => {
    const sample = [
      {
        candidate: KNOWN_LOCAL_BACKENDS.find((c) => c.provider === "sglang")!,
        available: true,
        modelCount: 4,
      },
      {
        candidate: KNOWN_LOCAL_BACKENDS.find((c) => c.provider === "vllm")!,
        available: false,
        reason: "refused" as const,
      },
      {
        candidate: KNOWN_LOCAL_BACKENDS.find((c) => c.provider === "ollama")!,
        available: true,
        modelCount: 12,
      },
    ];
    const out = formatDetectionSummary(sample);
    expect(out).toMatch(/^\[LocalBackends\]/);
    expect(out).toContain("SGLang");
    expect(out).toContain("4 models");
    expect(out).toContain("prefix-cache OK"); // SGLang
    expect(out).toContain("Ollama");
    expect(out).toContain("12 models");
    expect(out).not.toMatch(/Ollama.*prefix-cache OK/); // ollama doesn't have it
    expect(out).toContain("Not detected: vLLM");
  });

  it("zero detected → 'Detected: none.'", () => {
    const sample = KNOWN_LOCAL_BACKENDS.map((c) => ({
      candidate: c,
      available: false,
      reason: "refused" as const,
    }));
    const out = formatDetectionSummary(sample);
    expect(out).toContain("Detected: none.");
  });

  it("all detected → no 'Not detected' clause", () => {
    const sample = KNOWN_LOCAL_BACKENDS.map((c) => ({
      candidate: c,
      available: true,
      modelCount: 1,
    }));
    const out = formatDetectionSummary(sample);
    expect(out).not.toMatch(/Not detected/);
  });
});
