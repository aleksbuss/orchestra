/**
 * Unit tests for `runReflectionLoop` (moa-reflection.ts) — the generator-critic-
 * revisor loop extracted from `runMoAEnsemble` (Sprint 5 §10). The loop is also
 * covered end-to-end through the ensemble in moa.test.ts (PM #38 / #46); these
 * pin the extracted function's own contract: the disabled no-op short-circuit
 * (no LLM call), and the critic-clean vs critic-flags outcomes with usage folding.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/agent/reflection", async (orig) => {
  const actual = await orig<typeof import("@/lib/agent/reflection")>();
  return {
    ...actual, // keep deriveReflectionOutcome (pure) real
    reflectOnResponse: vi.fn(),
    reviseWithCritique: vi.fn(),
  };
});
vi.mock("@/lib/memory/embeddings", () => ({
  embedTexts: vi.fn(async () => [[1, 0], [0, 1]]),
}));
vi.mock("@/lib/observability/logger", async (orig) => {
  const actual = await orig<typeof import("@/lib/observability/logger")>();
  return { ...actual, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } };
});

import { runReflectionLoop } from "./moa-reflection";
import { reflectOnResponse, reviseWithCritique } from "@/lib/agent/reflection";
import type { AppSettings } from "@/lib/types";

const mockedReflect = vi.mocked(reflectOnResponse);
const mockedRevise = vi.mocked(reviseWithCritique);

function fakeSettings(reflection?: AppSettings["reflection"]): AppSettings {
  return {
    chatModel: { provider: "openai", model: "gpt-4o", apiKey: "k", authMethod: "api_key" },
    utilityModel: { provider: "openai", model: "gpt-4o-mini", apiKey: "k" },
    embeddingsModel: { provider: "openai", model: "text-embedding-3-small", dimensions: 1536 },
    codeExecution: { enabled: true, timeout: 600, maxOutputLength: 120000 },
    memory: { enabled: true, similarityThreshold: 0.35, maxResults: 10, chunkSize: 400 },
    search: { enabled: false, provider: "none" },
    general: { darkMode: false, language: "en" },
    auth: { enabled: true, username: "admin", passwordHash: "scrypt$x$y", mustChangeCredentials: false },
    ...(reflection ? { reflection } : {}),
  } as AppSettings;
}

const brainConfig = { provider: "openai", model: "gpt-4o" } as never;

const baseParams = {
  initialText: "the aggregated answer",
  usage: undefined,
  userMessage: "q",
  skepticConfig: undefined,
  brainConfig,
  chatId: "chat1",
} as const;

beforeEach(() => vi.clearAllMocks());

describe("runReflectionLoop — disabled short-circuit", () => {
  it("returns the initial text unchanged and calls NO critic when reflection is off", async () => {
    const result = await runReflectionLoop({
      ...baseParams,
      reflectionEnabled: false,
      settings: fakeSettings(),
    });
    expect(result.finalText).toBe("the aggregated answer");
    expect(result.reflectionRevisionsExecuted).toBe(0);
    expect(result.reflectionHitCap).toBe(false);
    expect(mockedReflect).not.toHaveBeenCalled();
  });
});

describe("runReflectionLoop — enabled", () => {
  it("critic clean on round 1 → text unchanged, 0 revisions, critic called once", async () => {
    mockedReflect.mockResolvedValueOnce({ shouldRevise: false } as never);
    const result = await runReflectionLoop({
      ...baseParams,
      reflectionEnabled: true,
      settings: fakeSettings({ enabled: true, maxRounds: 1 } as AppSettings["reflection"]),
    });
    expect(result.finalText).toBe("the aggregated answer");
    expect(result.reflectionRevisionsExecuted).toBe(0);
    expect(mockedReflect).toHaveBeenCalledTimes(1);
    expect(mockedRevise).not.toHaveBeenCalled();
  });

  it("critic flags → revisor replaces text, 1 revision recorded", async () => {
    mockedReflect.mockResolvedValueOnce({ shouldRevise: true, critique: "wrong version", suggestion: "use v2" } as never);
    mockedRevise.mockResolvedValueOnce({ status: "revised", text: "the corrected answer" } as never);
    const result = await runReflectionLoop({
      ...baseParams,
      reflectionEnabled: true,
      settings: fakeSettings({ enabled: true, maxRounds: 1 } as AppSettings["reflection"]),
    });
    expect(result.finalText).toBe("the corrected answer");
    expect(result.reflectionRevisionsExecuted).toBe(1);
    expect(mockedRevise).toHaveBeenCalledTimes(1);
  });

  it("folds critic + revisor usage into the running total (PM #36)", async () => {
    mockedReflect.mockResolvedValueOnce({
      shouldRevise: true, critique: "c", suggestion: "s",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      modelConfig: { provider: "openai", model: "gpt-4o-mini" },
    } as never);
    mockedRevise.mockResolvedValueOnce({
      status: "revised", text: "fixed",
      usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
      modelConfig: { provider: "openai", model: "gpt-4o" },
    } as never);
    const result = await runReflectionLoop({
      ...baseParams,
      reflectionEnabled: true,
      settings: fakeSettings({ enabled: true, maxRounds: 1 } as AppSettings["reflection"]),
    });
    // Usage went from undefined to a folded total across both models
    // (10 + 20 prompt, 5 + 10 completion — critic on gpt-4o-mini, revisor on gpt-4o).
    expect(result.usage).toBeDefined();
    expect(result.usage!.promptTokens).toBe(30);
    expect(result.usage!.completionTokens).toBe(15);
  });

  it("revisor cannot_fix breaks the loop without recording a revision", async () => {
    mockedReflect.mockResolvedValueOnce({ shouldRevise: true, critique: "c", suggestion: "s" } as never);
    mockedRevise.mockResolvedValueOnce({ status: "cannot_fix", explanation: "no clean fix" } as never);
    const result = await runReflectionLoop({
      ...baseParams,
      reflectionEnabled: true,
      settings: fakeSettings({ enabled: true, maxRounds: 2 } as AppSettings["reflection"]),
    });
    expect(result.finalText).toBe("the aggregated answer");
    expect(result.reflectionRevisionsExecuted).toBe(0);
  });
});
