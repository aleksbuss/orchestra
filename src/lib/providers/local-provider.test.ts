/**
 * PM #47 — `isLocalProvider` contract.
 *
 * Pinned:
 *   - ollama / sglang / vllm with no baseUrl → local (uses per-provider
 *     loopback defaults).
 *   - ollama / sglang / vllm with explicit loopback baseUrl → local.
 *   - ollama / sglang / vllm with PUBLIC baseUrl → NOT local (operator
 *     redirected the local-by-default provider at a remote host).
 *   - custom with loopback baseUrl → local.
 *   - custom with public baseUrl → NOT local.
 *   - custom with no baseUrl → NOT local (unsafe default).
 *   - openai / anthropic / google / openrouter / codex-cli / gemini-cli →
 *     NEVER local (always vendor APIs).
 */
import { describe, expect, it } from "vitest";
import { isLocalProvider } from "./llm-provider";
import type { ModelConfig } from "@/lib/types";

function cfg(overrides: Partial<ModelConfig>): ModelConfig {
  return {
    provider: "ollama",
    model: "qwen2.5:7b",
    ...overrides,
  } as ModelConfig;
}

describe("PM #47 — isLocalProvider: local-by-default providers", () => {
  it.each(["ollama", "sglang", "vllm"] as const)(
    "%s with no baseUrl → local",
    (provider) => {
      expect(isLocalProvider(cfg({ provider }))).toBe(true);
    }
  );

  it.each(["ollama", "sglang", "vllm"] as const)(
    "%s with explicit loopback baseUrl → local",
    (provider) => {
      expect(
        isLocalProvider(cfg({ provider, baseUrl: "http://localhost:11434" }))
      ).toBe(true);
      expect(
        isLocalProvider(cfg({ provider, baseUrl: "http://127.0.0.1:30000/v1" }))
      ).toBe(true);
    }
  );

  it.each(["ollama", "sglang", "vllm"] as const)(
    "%s with PUBLIC baseUrl → NOT local (operator redirected the provider)",
    (provider) => {
      expect(
        isLocalProvider(cfg({ provider, baseUrl: "https://my-server.example.com" }))
      ).toBe(false);
      expect(
        isLocalProvider(cfg({ provider, baseUrl: "http://10.0.0.5:11434" }))
      ).toBe(false);
    }
  );
});

describe("PM #47 — isLocalProvider: custom", () => {
  it("custom with loopback baseUrl → local", () => {
    expect(
      isLocalProvider(cfg({ provider: "custom", baseUrl: "http://localhost:5000" }))
    ).toBe(true);
    expect(
      isLocalProvider(cfg({ provider: "custom", baseUrl: "http://127.0.0.1:8080/v1" }))
    ).toBe(true);
  });

  it("custom with public baseUrl → NOT local", () => {
    expect(
      isLocalProvider(cfg({ provider: "custom", baseUrl: "https://api.example.com" }))
    ).toBe(false);
  });

  it("custom with no baseUrl → NOT local (unsafe default)", () => {
    expect(isLocalProvider(cfg({ provider: "custom", baseUrl: undefined }))).toBe(false);
  });
});

describe("PM #47 — isLocalProvider: cloud providers (always rejected)", () => {
  it.each([
    "openai",
    "anthropic",
    "google",
    "openrouter",
    "codex-cli",
    "gemini-cli",
  ] as const)("%s → NOT local", (provider) => {
    expect(isLocalProvider(cfg({ provider }))).toBe(false);
    // Even with loopback baseUrl set, vendor-API providers stay non-local —
    // the AI SDK adapters point at the vendor's domain regardless of baseUrl
    // override for OpenAI/Anthropic/Google in practice.
    expect(
      isLocalProvider(cfg({ provider, baseUrl: "http://localhost:8080" }))
    ).toBe(false);
  });
});
