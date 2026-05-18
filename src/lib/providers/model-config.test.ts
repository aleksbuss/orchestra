import { describe, it, expect } from "vitest";
import { MODEL_PROVIDERS } from "@/lib/providers/model-config";

describe("Model Provider Configuration Registry", () => {
  const providerKeys = Object.keys(MODEL_PROVIDERS);

  it("should have at least 5 providers registered", () => {
    expect(providerKeys.length).toBeGreaterThanOrEqual(5);
  });

  it("should include all expected providers", () => {
    expect(providerKeys).toContain("openai");
    expect(providerKeys).toContain("anthropic");
    expect(providerKeys).toContain("google");
    expect(providerKeys).toContain("openrouter");
    expect(providerKeys).toContain("ollama");
    expect(providerKeys).toContain("codex-cli");
    expect(providerKeys).toContain("gemini-cli");
  });

  describe.each(providerKeys)("Provider '%s'", (key) => {
    const provider = MODEL_PROVIDERS[key];

    it("should have a human-readable name", () => {
      expect(provider.name).toBeTruthy();
      expect(typeof provider.name).toBe("string");
    });

    it("should declare requiresApiKey as boolean", () => {
      expect(typeof provider.requiresApiKey).toBe("boolean");
    });

    it("should have authMethods array", () => {
      expect(Array.isArray(provider.authMethods)).toBe(true);
      expect(provider.authMethods!.length).toBeGreaterThan(0);
    });

    it("should have a defaultAuthMethod", () => {
      expect(provider.defaultAuthMethod).toBeTruthy();
      expect(provider.authMethods).toContain(provider.defaultAuthMethod);
    });
  });

  describe("Provider-specific requirements", () => {
    it("OpenAI should require an API key", () => {
      expect(MODEL_PROVIDERS.openai.requiresApiKey).toBe(true);
      expect(MODEL_PROVIDERS.openai.envKey).toBe("OPENAI_API_KEY");
    });

    it("Ollama should NOT require an API key", () => {
      expect(MODEL_PROVIDERS.ollama.requiresApiKey).toBe(false);
      expect(MODEL_PROVIDERS.ollama.baseUrl).toContain("localhost");
    });

    it("Gemini CLI should use OAuth auth method", () => {
      expect(MODEL_PROVIDERS["gemini-cli"].defaultAuthMethod).toBe("oauth");
      expect(MODEL_PROVIDERS["gemini-cli"].requiresApiKey).toBe(false);
    });

    it("Codex CLI should have pre-defined models", () => {
      expect(MODEL_PROVIDERS["codex-cli"].models.length).toBeGreaterThan(0);
    });

    it("OpenAI should have embedding models", () => {
      expect(MODEL_PROVIDERS.openai.embeddingModels).toBeDefined();
      expect(MODEL_PROVIDERS.openai.embeddingModels!.length).toBeGreaterThan(0);
    });

    it("Ollama should have embedding models", () => {
      expect(MODEL_PROVIDERS.ollama.embeddingModels).toBeDefined();
      expect(MODEL_PROVIDERS.ollama.embeddingModels!.length).toBeGreaterThan(0);
    });

    it("Gemini CLI should have connection help with steps", () => {
      const help = MODEL_PROVIDERS["gemini-cli"].connectionHelp;
      expect(help).toBeDefined();
      expect(help!.oauth).toBeDefined();
      expect(help!.oauth!.steps.length).toBeGreaterThan(0);
    });
  });
});
