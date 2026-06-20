import { describe, it, expect, vi, beforeEach } from "vitest";

// Count the underlying probes. resolveContextWindow probes live Ollama per call;
// the resolver must collapse duplicates within one ensemble run (audit fix #4).
vi.mock("@/lib/providers/context-window", () => ({
  resolveContextWindow: vi.fn(async () => 4096),
}));

import { createWindowResolver } from "./moa";
import { resolveContextWindow } from "@/lib/providers/context-window";

describe("createWindowResolver (audit fix #4 — per-ensemble window memo)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("probes ONCE per unique config, even across concurrent callers", async () => {
    const resolve = createWindowResolver();
    const ollama = { provider: "ollama", model: "qwen2.5", baseUrl: "http://localhost:11434" };
    // 5 concurrent proposers sharing one config (the no-tiers common case).
    const wins = await Promise.all([
      resolve(ollama),
      resolve(ollama),
      resolve(ollama),
      resolve(ollama),
      resolve(ollama),
    ]);
    expect(wins).toEqual([4096, 4096, 4096, 4096, 4096]);
    // Five callers, ONE underlying probe — concurrent callers share the promise.
    expect(resolveContextWindow).toHaveBeenCalledTimes(1);
  });

  it("probes separately for distinct configs (tiers split proposers across models)", async () => {
    const resolve = createWindowResolver();
    await Promise.all([
      resolve({ provider: "ollama", model: "fast" }),
      resolve({ provider: "ollama", model: "fast" }),
      resolve({ provider: "ollama", model: "frontier" }),
      resolve({ provider: "openai", model: "gpt-4o" }),
    ]);
    // 3 distinct keys → 3 probes (not 4 callers).
    expect(resolveContextWindow).toHaveBeenCalledTimes(3);
  });

  it("keys on baseUrl too (same model on different hosts is a distinct window)", async () => {
    const resolve = createWindowResolver();
    await resolve({ provider: "ollama", model: "m", baseUrl: "http://a:11434" });
    await resolve({ provider: "ollama", model: "m", baseUrl: "http://b:11434" });
    expect(resolveContextWindow).toHaveBeenCalledTimes(2);
  });

  it("separate resolvers (separate ensemble runs) do NOT share a cache", async () => {
    const cfg = { provider: "ollama", model: "m" };
    await createWindowResolver()(cfg);
    await createWindowResolver()(cfg);
    expect(resolveContextWindow).toHaveBeenCalledTimes(2);
  });
});
