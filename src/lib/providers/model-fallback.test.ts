/**
 * Tests for the model-fallback module.
 *
 * What we pin:
 *   - `classifyModelError` recognises the canonical failure shapes:
 *     PM #17 "no endpoints support tool use" → no_tool_support,
 *     404 / "model not found" / "deprecated" → model_not_found,
 *     402/403/"quota" → quota_exceeded (no silent fallback for billing),
 *     429 → rate_limited (no fallback, retry instead),
 *     fetch failures → network,
 *     AbortError → abort.
 *   - `pickFallbackModel` for OpenAI/Anthropic/Google walks the static
 *     chain, skips the failed model, skips NO_TOOL_PATTERNS hits.
 *   - `pickFallbackModel` for OpenRouter live-queries /models, filters
 *     tool-capable, prefers free-tier, sorts cheapest first.
 *   - `pickFallbackModel` for Ollama queries local /api/tags.
 *   - SSRF guard on Ollama baseUrl is honoured (PM #8).
 *   - `describeFallback` produces human-readable messaging with the
 *     pricing disclosure the user asked for.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  classifyModelError,
  pickFallbackModel,
  describeFallback,
} from "./model-fallback";

let fetchSpy: any;

beforeEach(() => {
  // Each test installs its own fetch stub via mockImplementation. The
  // default returns 200 empty so an accidental un-stubbed call doesn't
  // crash the test runner.
  fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ data: [] }), { status: 200 })
  );
});

afterEach(() => {
  fetchSpy?.mockRestore();
});

describe("classifyModelError", () => {
  it("recognises the PM #17 'no endpoints support tool use' shape", () => {
    const err = {
      statusCode: 404,
      message: "No endpoints found that support tool use",
    };
    expect(classifyModelError(err)).toBe("no_tool_support");
  });

  it("recognises 404 / model-not-found / deprecated", () => {
    expect(classifyModelError({ statusCode: 404, message: "" })).toBe("model_not_found");
    expect(classifyModelError({ message: "The model gpt-foo does not exist" })).toBe("model_not_found");
    expect(classifyModelError({ message: "This model has been deprecated" })).toBe("model_not_found");
  });

  it("recognises quota/payment-required as quota_exceeded (NOT fallback)", () => {
    expect(classifyModelError({ statusCode: 402, message: "" })).toBe("quota_exceeded");
    expect(classifyModelError({ statusCode: 403, message: "" })).toBe("quota_exceeded");
    expect(classifyModelError({ message: "insufficient_quota" })).toBe("quota_exceeded");
  });

  it("recognises 429 as rate_limited (NOT fallback)", () => {
    expect(classifyModelError({ statusCode: 429, message: "" })).toBe("rate_limited");
    expect(classifyModelError({ message: "Rate limit exceeded" })).toBe("rate_limited");
  });

  it("recognises network errors", () => {
    expect(classifyModelError(new Error("fetch failed"))).toBe("network");
    expect(classifyModelError({ message: "ECONNREFUSED" })).toBe("network");
    expect(classifyModelError({ message: "ETIMEDOUT" })).toBe("network");
  });

  it("recognises AbortError", () => {
    const ab = new Error("aborted");
    ab.name = "AbortError";
    expect(classifyModelError(ab)).toBe("abort");
  });

  it("falls back to unknown_4xx / unknown_5xx / unknown", () => {
    expect(classifyModelError({ statusCode: 401, message: "auth" })).toBe("unknown_4xx");
    expect(classifyModelError({ statusCode: 500, message: "" })).toBe("unknown_5xx");
    expect(classifyModelError(null)).toBe("unknown");
    expect(classifyModelError("a plain string")).toBe("unknown");
  });
});

describe("pickFallbackModel — static chains", () => {
  it("OpenAI: returns first chain entry that isn't the failed model", async () => {
    const result = await pickFallbackModel({
      provider: "openai",
      failedModel: "gpt-4o-mini",
    });
    expect(result.source).toBe("static_chain");
    // gpt-4o-mini is skipped (it was the failed one); next is gpt-4o.
    expect(result.modelId).toBe("gpt-4o");
  });

  it("Anthropic: walks the chain, skipping the failed entry", async () => {
    const result = await pickFallbackModel({
      provider: "anthropic",
      failedModel: "claude-3-5-haiku-latest",
    });
    expect(result.source).toBe("static_chain");
    expect(result.modelId).toBe("claude-3-5-sonnet-latest");
  });

  it("Google: defaults to gemini-1.5-flash when the failed model is the chain head", async () => {
    const result = await pickFallbackModel({
      provider: "google",
      failedModel: "some-other-gemini",
    });
    expect(result.modelId).toBe("gemini-1.5-flash");
  });

  it("returns null modelId for an unknown provider with no static chain", async () => {
    const result = await pickFallbackModel({
      provider: "nonexistent-provider",
      failedModel: "anything",
    });
    expect(result.modelId).toBeNull();
  });
});

describe("pickFallbackModel — OpenRouter catalog", () => {
  it("returns null when no API key is provided (can't query the catalog)", async () => {
    const result = await pickFallbackModel({
      provider: "openrouter",
      failedModel: "openai/gpt-4o",
    });
    expect(result.modelId).toBeNull();
    expect(result.source).toBe("openrouter_catalog");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("queries OpenRouter /models with Authorization header", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "anthropic/claude-3-5-haiku",
              pricing: { prompt: "0.0000008", completion: "0.000004" },
            },
          ],
        }),
        { status: 200 }
      )
    );

    await pickFallbackModel({
      provider: "openrouter",
      failedModel: "openai/gpt-4o",
      apiKey: "sk-or-test",
    });

    expect(fetchSpy).toHaveBeenCalled();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe("https://openrouter.ai/api/v1/models");
    expect((init as any).headers.Authorization).toBe("Bearer sk-or-test");
  });

  it("picks the cheapest tool-capable model", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            // Pricey but capable
            { id: "anthropic/claude-3-5-sonnet", pricing: { prompt: "0.000003", completion: "0.000015" } },
            // Cheaper alternative
            { id: "anthropic/claude-3-5-haiku", pricing: { prompt: "0.0000008", completion: "0.000004" } },
            // Cheapest but NO_TOOL_PATTERNS — should be filtered out
            { id: "google/gemma-2-9b-it", pricing: { prompt: "0", completion: "0" } },
          ],
        }),
        { status: 200 }
      )
    );

    const result = await pickFallbackModel({
      provider: "openrouter",
      failedModel: "openai/gpt-4o",
      apiKey: "sk-or-test",
    });

    expect(result.source).toBe("openrouter_catalog");
    // Haiku is cheaper than Sonnet AND tool-capable; gemma is filtered.
    expect(result.modelId).toBe("anthropic/claude-3-5-haiku");
    expect(result.pricing?.promptUsdPerMillion).toBeCloseTo(0.8, 4);
    expect(result.pricing?.completionUsdPerMillion).toBeCloseTo(4, 4);
    expect(result.pricing?.isFree).toBe(false);
  });

  it("prefers free-tier models over priced ones", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: "anthropic/claude-3-5-haiku", pricing: { prompt: "0.0000008", completion: "0.000004" } },
            // Free variant — should win regardless of being last in the list.
            { id: "qwen/qwen-2.5-7b-instruct:free", pricing: { prompt: "0", completion: "0" } },
          ],
        }),
        { status: 200 }
      )
    );

    const result = await pickFallbackModel({
      provider: "openrouter",
      failedModel: "openai/gpt-4o",
      apiKey: "k",
    });
    expect(result.modelId).toBe("qwen/qwen-2.5-7b-instruct:free");
    expect(result.pricing?.isFree).toBe(true);
  });

  it("excludes the failed model from candidates", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: "openai/gpt-4o", pricing: { prompt: "0", completion: "0" } }, // failed — filtered
            { id: "anthropic/claude-3-5-haiku", pricing: { prompt: "0.0000008", completion: "0.000004" } },
          ],
        }),
        { status: 200 }
      )
    );

    const result = await pickFallbackModel({
      provider: "openrouter",
      failedModel: "openai/gpt-4o",
      apiKey: "k",
    });
    expect(result.modelId).toBe("anthropic/claude-3-5-haiku");
  });

  it("returns null when /models is down (non-OK status)", async () => {
    fetchSpy.mockResolvedValue(new Response("upstream broken", { status: 503 }));
    const result = await pickFallbackModel({
      provider: "openrouter",
      failedModel: "x",
      apiKey: "k",
    });
    expect(result.modelId).toBeNull();
  });

  it("returns null when fetch throws (network)", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await pickFallbackModel({
      provider: "openrouter",
      failedModel: "x",
      apiKey: "k",
    });
    expect(result.modelId).toBeNull();
  });
});

describe("pickFallbackModel — Ollama local", () => {
  it("queries local /api/tags and returns the first installed model", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          models: [
            { name: "llama3.1:latest" },
            { name: "qwen2.5:7b" },
          ],
        }),
        { status: 200 }
      )
    );
    const result = await pickFallbackModel({
      provider: "ollama",
      failedModel: "some-other:tag",
    });
    expect(result.source).toBe("ollama_local");
    expect(result.modelId).toBe("llama3.1:latest");
  });

  it("strips /v1 suffix from baseUrl before hitting /api/tags", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ models: [{ name: "qwen2.5:7b" }] }), { status: 200 })
    );
    await pickFallbackModel({
      provider: "ollama",
      failedModel: "x",
      baseUrl: "http://localhost:11434/v1/",
    });
    const [url] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe("http://localhost:11434/api/tags");
  });

  it("refuses an RFC1918 baseUrl (SSRF guard, PM #8)", async () => {
    const result = await pickFallbackModel({
      provider: "ollama",
      failedModel: "x",
      baseUrl: "http://10.0.0.5:11434",
    });
    expect(result.modelId).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("filters out the failed model from the local catalog", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ models: [{ name: "x:tag" }, { name: "y:tag" }] }),
        { status: 200 }
      )
    );
    const result = await pickFallbackModel({
      provider: "ollama",
      failedModel: "x:tag",
    });
    expect(result.modelId).toBe("y:tag");
  });

  it("returns null when no models are installed", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ models: [] }), { status: 200 })
    );
    const result = await pickFallbackModel({
      provider: "ollama",
      failedModel: "x",
    });
    expect(result.modelId).toBeNull();
  });
});

describe("describeFallback — user-facing notification text", () => {
  it("includes free-tier disclosure when the new model is free", () => {
    const { message } = describeFallback({
      originalModel: "openai/gpt-4o",
      newModel: "qwen/qwen-2.5-7b-instruct:free",
      provider: "openrouter",
      source: "openrouter_catalog",
      reason: "model_not_found",
      pricing: { isFree: true },
    });
    expect(message).toMatch(/qwen\/qwen-2\.5-7b-instruct:free/);
    expect(message).toMatch(/free tier/i);
    expect(message).not.toMatch(/\$\d/);
  });

  it("includes explicit pricing when available", () => {
    const { message } = describeFallback({
      originalModel: "x",
      newModel: "y",
      provider: "openrouter",
      source: "openrouter_catalog",
      reason: "model_not_found",
      pricing: {
        promptUsdPerMillion: 0.8,
        completionUsdPerMillion: 4,
        isFree: false,
      },
    });
    expect(message).toMatch(/\$0\.80\/M prompt/);
    expect(message).toMatch(/\$4\.00\/M completion/);
  });

  it("falls back to 'verify your invoice' wording when no pricing is known", () => {
    const { message, hint } = describeFallback({
      originalModel: "a",
      newModel: "b",
      provider: "openai",
      source: "static_chain",
      reason: "no_tool_support",
    });
    expect(message).toMatch(/Pricing may differ/i);
    expect(message).toMatch(/doesn't support tool calls/i);
    expect(hint).toMatch(/Settings/i);
  });
});
