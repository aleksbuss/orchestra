/**
 * PM #47 — Privacy Mode runtime guard contract.
 *
 * `assertPrivacyModeAllowsSettings` is the single chokepoint called at
 * runAgent entry. When privacyMode.enabled is true, ANY non-local model
 * in chatModel, utilityModel, or embeddingsModel produces a fatal
 * throw with a clear operator-facing message naming the violations.
 */
import { describe, expect, it } from "vitest";
import { assertPrivacyModeAllowsSettings } from "./agent";
import type { AppSettings } from "@/lib/types";

function baseSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    chatModel: { provider: "ollama", model: "qwen2.5:7b" },
    utilityModel: { provider: "ollama", model: "qwen2.5:3b" },
    embeddingsModel: {
      provider: "ollama",
      model: "nomic-embed-text",
      dimensions: 768,
    },
    codeExecution: { enabled: true, timeout: 600, maxOutputLength: 120000 },
    memory: {
      enabled: true,
      similarityThreshold: 0.35,
      maxResults: 10,
      chunkSize: 400,
    },
    search: { enabled: false, provider: "none" },
    general: { darkMode: false, language: "en" },
    auth: {
      enabled: true,
      username: "admin",
      passwordHash: "scrypt$x$y",
      mustChangeCredentials: false,
    },
    ...overrides,
  };
}

describe("PM #47 — assertPrivacyModeAllowsSettings", () => {
  it("privacyMode disabled (or undefined) → no-op regardless of provider", () => {
    expect(() =>
      assertPrivacyModeAllowsSettings(
        baseSettings({
          chatModel: { provider: "openai", model: "gpt-4o" },
          utilityModel: { provider: "anthropic", model: "claude-haiku" },
        })
      )
    ).not.toThrow();
  });

  it("privacyMode enabled + all-local settings → no-op", () => {
    expect(() =>
      assertPrivacyModeAllowsSettings(
        baseSettings({
          privacyMode: { enabled: true },
          chatModel: { provider: "ollama", model: "qwen2.5:7b" },
          utilityModel: { provider: "sglang", model: "Qwen/Qwen2.5-7B-Instruct" },
        })
      )
    ).not.toThrow();
  });

  it("privacyMode enabled + cloud chatModel → throws with model id in message", () => {
    expect(() =>
      assertPrivacyModeAllowsSettings(
        baseSettings({
          privacyMode: { enabled: true },
          chatModel: { provider: "openai", model: "gpt-4o" },
        })
      )
    ).toThrow(/Privacy Mode is enabled/);
    expect(() =>
      assertPrivacyModeAllowsSettings(
        baseSettings({
          privacyMode: { enabled: true },
          chatModel: { provider: "openai", model: "gpt-4o" },
        })
      )
    ).toThrow(/chatModel = openai\/gpt-4o/);
  });

  it("privacyMode enabled + cloud utilityModel only → throws naming utilityModel", () => {
    expect(() =>
      assertPrivacyModeAllowsSettings(
        baseSettings({
          privacyMode: { enabled: true },
          // chatModel still local
          chatModel: { provider: "ollama", model: "qwen2.5:7b" },
          // utility leaks to cloud
          utilityModel: { provider: "openai", model: "gpt-4o-mini" },
        })
      )
    ).toThrow(/utilityModel = openai\/gpt-4o-mini/);
  });

  it("privacyMode enabled + cloud embeddingsModel → throws naming embeddingsModel", () => {
    expect(() =>
      assertPrivacyModeAllowsSettings(
        baseSettings({
          privacyMode: { enabled: true },
          embeddingsModel: {
            provider: "openai",
            model: "text-embedding-3-small",
            dimensions: 1536,
          },
        })
      )
    ).toThrow(/embeddingsModel = openai\/text-embedding-3-small/);
  });

  it("privacyMode enabled + multiple violations → message lists ALL of them", () => {
    try {
      assertPrivacyModeAllowsSettings(
        baseSettings({
          privacyMode: { enabled: true },
          chatModel: { provider: "anthropic", model: "claude-sonnet-4-6" },
          utilityModel: { provider: "openrouter", model: "google/gemma" },
          embeddingsModel: {
            provider: "openai",
            model: "text-embedding-3-large",
            dimensions: 3072,
          },
        })
      );
      throw new Error("expected throw, none happened");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain("chatModel = anthropic/claude-sonnet-4-6");
      expect(msg).toContain("utilityModel = openrouter/google/gemma");
      expect(msg).toContain("embeddingsModel = openai/text-embedding-3-large");
    }
  });

  it("privacyMode enabled + custom provider with loopback baseUrl → allowed", () => {
    expect(() =>
      assertPrivacyModeAllowsSettings(
        baseSettings({
          privacyMode: { enabled: true },
          chatModel: {
            provider: "custom",
            model: "my-server-model",
            baseUrl: "http://127.0.0.1:5000",
          },
        })
      )
    ).not.toThrow();
  });

  it("privacyMode enabled + custom provider with PUBLIC baseUrl → rejected", () => {
    expect(() =>
      assertPrivacyModeAllowsSettings(
        baseSettings({
          privacyMode: { enabled: true },
          chatModel: {
            provider: "custom",
            model: "my-server-model",
            baseUrl: "https://my-public-server.example.com",
          },
        })
      )
    ).toThrow(/chatModel = custom\/my-server-model/);
  });

  it("privacyMode enabled + embeddingsModel.provider 'mock' → allowed (test fixture, no network)", () => {
    expect(() =>
      assertPrivacyModeAllowsSettings(
        baseSettings({
          privacyMode: { enabled: true },
          embeddingsModel: {
            provider: "mock",
            model: "mock",
            dimensions: 1536,
          },
        })
      )
    ).not.toThrow();
  });

  it("error message includes actionable remediation hint", () => {
    try {
      assertPrivacyModeAllowsSettings(
        baseSettings({
          privacyMode: { enabled: true },
          chatModel: { provider: "openai", model: "gpt-4o" },
        })
      );
      throw new Error("expected throw, none happened");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toMatch(/disable Privacy Mode|switch.*local backend/i);
      expect(msg).toMatch(/ollama|sglang|vllm/);
    }
  });
});
