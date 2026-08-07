/**
 * Behaviour pinned when this moved out of `agent.ts` (rule 25 offset for the
 * PM #98 watchdog). The extraction was meant to be behaviour-preserving; these
 * tests are what makes that claim checkable rather than asserted.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { detectToolSupport } from "./agent-tool-capability";
import type { ModelConfig } from "@/lib/types";

function cfg(over: Partial<ModelConfig>): ModelConfig {
  return { provider: "openrouter", model: "vendor/model", ...over } as ModelConfig;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Stub `fetch` with one Ollama `/api/show` response. */
function stubOllamaShow(body: unknown, ok = true) {
  const spy = vi.fn().mockResolvedValue({ ok, json: async () => body });
  vi.stubGlobal("fetch", spy);
  return spy;
}

describe("detectToolSupport — non-Ollama providers", () => {
  it("defers to the shared pattern list, with no network call", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    // PM #98's model: `gemma-` is in NO_TOOL_PATTERNS.
    await expect(
      detectToolSupport(cfg({ model: "google/gemma-4-26b-a4b-it:free" }))
    ).resolves.toBe(false);
    await expect(
      detectToolSupport(cfg({ model: "nvidia/nemotron-nano-9b-v2:free" }))
    ).resolves.toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it("assumes yes for an empty model id — let the upstream API decide", async () => {
    await expect(detectToolSupport(cfg({ model: "" }))).resolves.toBe(true);
  });
});

describe("detectToolSupport — the Ollama live probe", () => {
  it("trusts the live template over the pattern list", async () => {
    // The whole reason the probe exists: local users install tool-capable
    // forks of models the substring list would reject outright.
    stubOllamaShow({ template: "{{ if .Tools }}...{{ end }}" });
    await expect(
      detectToolSupport(cfg({ provider: "ollama", model: "gemma-3-27b" }))
    ).resolves.toBe(true);
  });

  it("trusts a template that says no, even for a normally tool-capable id", async () => {
    stubOllamaShow({ template: "{{ .Prompt }}" });
    await expect(
      detectToolSupport(cfg({ provider: "ollama", model: "qwen3:8b" }))
    ).resolves.toBe(false);
  });

  it("falls back to the pattern list when the probe fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    // Never throws: refusing the turn over a capability question is worse than
    // running it on the best available guess.
    await expect(
      detectToolSupport(cfg({ provider: "ollama", model: "gemma-3-27b" }))
    ).resolves.toBe(false);
    await expect(
      detectToolSupport(cfg({ provider: "ollama", model: "qwen3:8b" }))
    ).resolves.toBe(true);
  });

  it("falls back when the probe answers non-2xx", async () => {
    stubOllamaShow({}, false);
    await expect(
      detectToolSupport(cfg({ provider: "ollama", model: "qwen3:8b" }))
    ).resolves.toBe(true);
  });

  it("bounds the probe and strips a /v1 suffix from the base url", async () => {
    const spy = stubOllamaShow({ template: "tools" });
    await detectToolSupport(
      cfg({ provider: "ollama", model: "qwen3:8b", baseUrl: "http://box:11434/v1" })
    );
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://box:11434/api/show");
    // An unbounded probe would reintroduce a smaller version of the same hang
    // this whole change exists to fix.
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
