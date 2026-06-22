import { describe, it, expect } from "vitest";
import { isModelKeyConfigured } from "./llm-provider";

/**
 * `isModelKeyConfigured` mirrors the key guard inside createModel /
 * createEmbeddingModel so callers (e.g. /api/health) can detect a SILENTLY
 * unusable model. An unconfigured embeddings model disables RAG memory search,
 * MoA disagreement detection, and trace-memory with only a per-request log.
 */
describe("isModelKeyConfigured", () => {
  it("local providers (ollama / sglang / vllm) need no key → configured", () => {
    expect(isModelKeyConfigured({ provider: "ollama" })).toBe(true);
    expect(isModelKeyConfigured({ provider: "sglang" })).toBe(true);
    expect(isModelKeyConfigured({ provider: "vllm" })).toBe(true);
  });

  it("cloud provider with an explicit apiKey → configured", () => {
    expect(isModelKeyConfigured({ provider: "openai", apiKey: "sk-x" })).toBe(true);
    expect(isModelKeyConfigured({ provider: "openrouter", apiKey: "sk-or-x" })).toBe(true);
  });

  it("cloud provider with NO key and NO env var → NOT configured (the silent-degradation condition)", () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      expect(isModelKeyConfigured({ provider: "openai" })).toBe(false);
      expect(isModelKeyConfigured({ provider: "openai", apiKey: "" })).toBe(false);
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    }
  });

  it("cloud provider with the env var set → configured (no settings key needed)", () => {
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-from-env";
    try {
      expect(isModelKeyConfigured({ provider: "openai" })).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved;
    }
  });
});
