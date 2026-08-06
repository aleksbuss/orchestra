/**
 * Focused tests for the extracted MoA proposer fan-out (`moa-proposers.ts`,
 * §10 Sprint 5). `moa.test.ts` deliberately leaves the fan-out internals "out
 * of scope … for marginal value" and only drives them transitively through the
 * ensemble; this file exercises `runProposerFanOut` DIRECTLY (bypassing the
 * Router) to pin the contracts most likely to regress on a future edit:
 *
 *   1. Happy path — N proposers → N drafts, each carrying `rawUsage`, plus a
 *      numeric `proposerLatencyMs`.
 *   2. PM #77 — a proposer whose model throws yields an ERROR DRAFT and the
 *      fan-out RESOLVES; it must never reject (a rejection collapses the whole
 *      ensemble to a single agent, discarding every good draft).
 *   3. PM #23 — an already-aborted signal short-circuits each proposer to an
 *      "aborted before dispatch" draft rather than dispatching a model call.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, generateText: vi.fn() };
});

vi.mock("@/lib/providers/llm-provider", () => ({
  createModel: vi.fn(() => ({ /* opaque handle — generateText is mocked */ })),
}));

vi.mock("@/lib/realtime/event-bus", () => ({
  publishUiSyncEvent: vi.fn(),
}));

// Pass-through the global semaphore so the fan-out isn't bounded by the test
// box's RAM tier.
vi.mock("./semaphore", async (orig) => {
  const actual = await orig<typeof import("./semaphore")>();
  return {
    ...actual,
    agentSemaphore: { run: vi.fn(async (fn: () => Promise<unknown>) => fn()) },
  };
});

// Neutralize the free-tier pacing timers (Sprint 2) — the stagger/backoff
// sleeps are real `setTimeout`s otherwise. Behavior under test is draft
// collection + failure handling, not pacing.
vi.mock("@/lib/agent/proposer-pacing", () => ({
  abortableSleep: vi.fn(async () => {}),
  computeStaggerMs: vi.fn(() => 0),
  withFreeTierPacing: vi.fn(async (_config: unknown, fn: () => Promise<unknown>) => fn()),
  resetFreeTierPacing: vi.fn(),
}));

vi.mock("@/lib/tools/search-engine", () => ({
  searchWeb: vi.fn(),
  isSearchUsable: (s: { enabled?: boolean; provider?: string } | undefined) =>
    !!(s?.enabled && s.provider !== "none"),
}));

vi.mock("@/lib/observability/logger", async (orig) => {
  const actual = await orig<typeof import("@/lib/observability/logger")>();
  return {
    ...actual,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

import { runProposerFanOut, type ProposerFanOutContext } from "./moa-proposers";
import type { AppSettings, ModelConfig } from "@/lib/types";
import { generateText } from "ai";
import { resetModelHealth } from "./model-health";

const mockedGenerateText = vi.mocked(generateText);

function fakeSettings(): AppSettings {
  return {
    chatModel: { provider: "openai", model: "gpt-4o", apiKey: "k", authMethod: "api_key" },
    utilityModel: { provider: "openai", model: "gpt-4o-mini", apiKey: "k" },
    embeddingsModel: { provider: "openai", model: "text-embedding-3-small", dimensions: 1536 },
    codeExecution: { enabled: false, timeout: 600, maxOutputLength: 120000 },
    memory: { enabled: true, similarityThreshold: 0.35, maxResults: 10, chunkSize: 400 },
    search: { enabled: false, provider: "none" },
    general: { darkMode: false, language: "en" },
    auth: {
      enabled: true,
      username: "admin",
      passwordHash: "scrypt$x$y",
      mustChangeCredentials: false,
    },
  } as AppSettings;
}

function fakeCtx(overrides: Partial<ProposerFanOutContext> = {}): ProposerFanOutContext {
  const workerConfig: ModelConfig = { provider: "openai", model: "gpt-4o", apiKey: "k" };
  return {
    dynamicProposers: [
      { id: "analyst", role: "First-Principles Analyst", systemPrompt: "You analyze from first principles.", color: "blue" },
      { id: "pragmatist", role: "Pragmatic Executor", systemPrompt: "You ship working solutions.", color: "green" },
    ],
    chatId: "c1",
    routerNodeId: "router-1",
    projectId: undefined,
    currentPath: undefined,
    userMessage: "solve X",
    history: [],
    abortSignal: undefined,
    settings: fakeSettings(),
    degradationPolicy: undefined,
    background: undefined,
    skepticConfig: undefined,
    workerConfig,
    safeHistory: [],
    searchEnabled: false,
    resolveWindow: async () => 8000,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // The model-health breaker is PROCESS-GLOBAL (survives module reloads via a
  // Symbol.for store); a failure-path test that opens a circuit would leak
  // substitution into later tests. Reset per test.
  resetModelHealth();
});

describe("runProposerFanOut — happy path", () => {
  it("returns one draft per proposer, each with rawUsage, plus numeric latency", async () => {
    mockedGenerateText.mockResolvedValue({
      text: "draft answer",
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    } as any);

    const { draftsWithUsage, proposerLatencyMs } = await runProposerFanOut(fakeCtx());

    expect(draftsWithUsage).toHaveLength(2);
    expect(draftsWithUsage.map((d) => d.proposerId).sort()).toEqual(["analyst", "pragmatist"]);
    expect(draftsWithUsage.every((d) => d.text === "draft answer")).toBe(true);
    // PM #36/#48 — every successful draft carries usage for attribution.
    expect(draftsWithUsage.every((d) => d.rawUsage)).toBeTruthy();
    expect(draftsWithUsage.every((d) => d.resolvedProvider === "openai")).toBe(true);
    expect(typeof proposerLatencyMs).toBe("number");
    expect(proposerLatencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe("runProposerFanOut — PM #77 (a failed proposer never collapses the ensemble)", () => {
  it("resolves with error drafts when the model throws — does NOT reject", async () => {
    mockedGenerateText.mockRejectedValue(new Error("model exploded"));

    // The whole point of PM #77: this await must resolve, not throw.
    const { draftsWithUsage } = await runProposerFanOut(fakeCtx());

    expect(draftsWithUsage).toHaveLength(2);
    expect(draftsWithUsage.every((d) => d.text.startsWith("[Error:"))).toBe(true);
    // Error drafts carry no usage (nothing was generated).
    expect(draftsWithUsage.every((d) => d.rawUsage === undefined)).toBe(true);
  });

  it("a mix of one healthy and one throwing proposer keeps the healthy draft", async () => {
    mockedGenerateText
      .mockResolvedValueOnce({ text: "good draft", usage: { inputTokens: 5, outputTokens: 5 } } as any)
      .mockRejectedValue(new Error("second proposer down"));

    const { draftsWithUsage } = await runProposerFanOut(fakeCtx());

    expect(draftsWithUsage).toHaveLength(2);
    const good = draftsWithUsage.filter((d) => d.text === "good draft");
    const errored = draftsWithUsage.filter((d) => d.text.startsWith("[Error:"));
    expect(good).toHaveLength(1);
    expect(errored).toHaveLength(1);
  });
});

describe("runProposerFanOut — PM #23 (abort)", () => {
  it("an already-aborted signal short-circuits every proposer without a model call", async () => {
    const ac = new AbortController();
    ac.abort();

    const { draftsWithUsage } = await runProposerFanOut(fakeCtx({ abortSignal: ac.signal }));

    expect(draftsWithUsage).toHaveLength(2);
    expect(draftsWithUsage.every((d) => d.text.includes("aborted before dispatch"))).toBe(true);
    // No proposer should have dispatched a generation.
    expect(mockedGenerateText).not.toHaveBeenCalled();
  });
});
