/**
 * Tests for MoA (Mixture-of-Agents) ensemble orchestration.
 *
 * Scope: this file pins down the contracts that the audit flagged as
 * regression hazards and the rules CLAUDE.md § "🧠 Core Agentic Subsystems"
 * already encodes. Full ensemble behavior (5-proposer fan-out, staggered
 * starts, semaphore back-pressure) is out of scope here — too many timer +
 * SDK mocks for marginal value. Cover the brittle public surfaces:
 *
 *   1. `MOA_PROPOSERS` static fallback — the constant the Router DPG falls
 *      back to when persona generation throws. CLAUDE.md says exactly 3-5
 *      proposers; this constant is the floor for what gets shipped.
 *   2. Bypass path (`requiresSwarm: false`) — internal Router optimization
 *      per PM #9 / CLAUDE.md note. When the Router decides bypass, the
 *      ensemble must call the brain model exactly once, NOT fan out, and
 *      return drafts: []. A regression here would silently fan out on
 *      every "thanks" message and burn tokens (the inverse PM #9 case).
 *   3. **Aggregator user-message constraint** — the Aggregator MUST NOT be
 *      fed `safeHistory` because consecutive `user` messages crash strict
 *      models like Gemma (PM #2). The aggregator call's `messages` array
 *      must contain exactly one entry, and that entry's role must be
 *      "user". This is the test that would have caught PM #2 and prevents
 *      its return.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Module mocks: stub the AI SDK + provider + UI bus + presets so we can run
// the ensemble in-process without touching network / filesystem / models.
vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    generateText: vi.fn(),
    generateObject: vi.fn(),
  };
});

vi.mock("@/lib/providers/llm-provider", () => ({
  createModel: vi.fn(() => ({ /* opaque model handle — we don't run it */ })),
}));

vi.mock("@/lib/realtime/event-bus", () => ({
  publishUiSyncEvent: vi.fn(),
}));

vi.mock("@/lib/agent/presets", () => ({
  // Identity-ish: just return the chatModel back. The real presets module
  // has tier-specific selection that the ensemble's behavior under test
  // does not depend on — what matters is that SOME ModelConfig comes out.
  getBrainConfig: vi.fn((_tier, chatModel) => chatModel),
  getWorkerConfig: vi.fn((_tier, chatModel) => chatModel),
}));

vi.mock("./semaphore", () => ({
  agentSemaphore: { run: vi.fn(async (fn: () => Promise<unknown>) => fn()) },
}));

vi.mock("@/lib/tools/search-engine", () => ({
  searchWeb: vi.fn(),
}));

import { runMoAEnsemble, MOA_PROPOSERS } from "./moa";
import type { AppSettings } from "@/lib/types";
import { generateText, generateObject } from "ai";

const mockedGenerateText = vi.mocked(generateText);
const mockedGenerateObject = vi.mocked(generateObject);

function fakeSettings(): AppSettings {
  return {
    chatModel: { provider: "openai", model: "gpt-4o", apiKey: "k", authMethod: "api_key" },
    utilityModel: { provider: "openai", model: "gpt-4o-mini", apiKey: "k" },
    embeddingsModel: { provider: "openai", model: "text-embedding-3-small", dimensions: 1536 },
    codeExecution: { enabled: true, timeout: 600, maxOutputLength: 120000 },
    memory: { enabled: true, similarityThreshold: 0.35, maxResults: 10, chunkSize: 400 },
    search: { enabled: false, provider: "none" },
    general: { darkMode: false, language: "en" },
    auth: {
      enabled: true,
      username: "admin",
      passwordHash: "scrypt$x$y",
      mustChangeCredentials: false,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("MOA_PROPOSERS — static fallback constant", () => {
  it("ships exactly 5 proposers (within the 3–5 range the Router promises)", () => {
    expect(MOA_PROPOSERS.length).toBe(5);
    expect(MOA_PROPOSERS.length).toBeGreaterThanOrEqual(3);
    expect(MOA_PROPOSERS.length).toBeLessThanOrEqual(5);
  });

  it("each proposer has the full schema: id, role, systemPrompt, color", () => {
    for (const p of MOA_PROPOSERS) {
      expect(p.id).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(p.role.length).toBeGreaterThan(0);
      expect(p.systemPrompt.length).toBeGreaterThan(40);
      expect(p.color.length).toBeGreaterThan(0);
    }
  });

  it("proposer ids are unique — no UI/log collisions", () => {
    const ids = MOA_PROPOSERS.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("includes a critic/skeptic proposer (Zero-Latency Fact-Checking mandate)", () => {
    // CLAUDE.md says one DPG persona is ALWAYS forced to be a QA Auditor /
    // Skeptic. The static fallback must satisfy the same invariant — if the
    // Router throws and we fall back to MOA_PROPOSERS, we still want the
    // critic perspective in the ensemble.
    const hasSkeptic = MOA_PROPOSERS.some(p =>
      /critic|skeptic|auditor|red.?team/i.test(p.id) ||
      /critic|skeptic|auditor|red.?team/i.test(p.role)
    );
    expect(hasSkeptic).toBe(true);
  });
});

describe("runMoAEnsemble — Router bypass path (requiresSwarm: false)", () => {
  it("calls the brain model exactly once and returns no drafts", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: { requiresSwarm: false, personas: [] },
    } as any);
    mockedGenerateText.mockResolvedValueOnce({ text: "hi back" } as any);

    const result = await runMoAEnsemble({
      chatId: "c1",
      userMessage: "hi",
      history: [],
      settings: fakeSettings(),
    });

    expect(mockedGenerateText).toHaveBeenCalledTimes(1);
    expect(result.drafts).toEqual([]);
    expect(result.text).toBe("hi back");
  });

  it("does NOT fan out — the Router's decision overrides any preset implication", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: { requiresSwarm: false, personas: [] },
    } as any);
    mockedGenerateText.mockResolvedValueOnce({ text: "ok" } as any);

    await runMoAEnsemble({
      chatId: "c1",
      userMessage: "thanks",
      history: [],
      settings: fakeSettings(),
      preset: "best",
    });

    // Exactly one generateText call = the bypass call. If the ensemble had
    // fanned out we'd see 1 + N calls (one per proposer + aggregator).
    expect(mockedGenerateText).toHaveBeenCalledTimes(1);
  });

  it("falls back gracefully when the bypass call throws — no fan-out fallback either", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: { requiresSwarm: false, personas: [] },
    } as any);
    mockedGenerateText.mockRejectedValueOnce(new Error("upstream timeout"));

    const result = await runMoAEnsemble({
      chatId: "c1",
      userMessage: "thanks",
      history: [],
      settings: fakeSettings(),
    });

    // The current contract is "return error string, do not fan out as
    // recovery." The contract avoids burning 5x tokens on a model that's
    // already failing. If a future change adds fallback fan-out, this test
    // is the place to update intentionally — not silently.
    expect(mockedGenerateText).toHaveBeenCalledTimes(1);
    expect(result.text).toMatch(/error/i);
    expect(result.drafts).toEqual([]);
  });
});

describe("runMoAEnsemble — DPG router failure falls back to MOA_PROPOSERS", () => {
  it("when generateObject throws, the catch falls through to swarm with static proposers", async () => {
    // The catch returns `{ requiresSwarm: true, personas: MOA_PROPOSERS }` —
    // 5 proposers. Each proposer triggers a generateText call (we mock them
    // all to one quick reply). With ≥2 successful drafts, an aggregator call
    // also fires — that's the LAST generateText call in this test.
    mockedGenerateObject.mockRejectedValueOnce(new Error("router down"));

    // Stub every proposer + the aggregator call. We don't care about timing
    // here, just that SOME draft text comes back from each call.
    let callIndex = 0;
    mockedGenerateText.mockImplementation(async () => {
      callIndex += 1;
      return { text: `draft-${callIndex}` } as any;
    });

    const result = await runMoAEnsemble({
      chatId: "c1",
      userMessage: "design a real-time architecture for a streaming service",
      history: [],
      settings: fakeSettings(),
    });

    // 5 proposers + 1 aggregator = 6 generateText calls.
    expect(mockedGenerateText).toHaveBeenCalledTimes(6);
    // Drafts collection holds the 5 proposer outputs.
    expect(result.drafts.length).toBe(5);
  }, 30_000); // staggered starts: 0,1,2,3,4 sec → ≤10s wall-clock realistically; 30s headroom
});

describe("runMoAEnsemble — Aggregator must NOT receive consecutive user messages (PM #2)", () => {
  it("aggregator generateText call has exactly one message, role=user, no history", async () => {
    mockedGenerateObject.mockRejectedValueOnce(new Error("force fallback to MOA_PROPOSERS"));

    let callIndex = 0;
    mockedGenerateText.mockImplementation(async () => {
      callIndex += 1;
      return { text: `draft ${callIndex} content` } as any;
    });

    // Provide a noisy history with assistant + user turns. If a future
    // refactor accidentally prepends safeHistory to the aggregator's
    // messages array, the call's `messages` length would jump from 1 to N+1
    // and the assertion below catches it.
    await runMoAEnsemble({
      chatId: "c1",
      userMessage: "do the thing",
      history: [
        { role: "user", content: "earlier user message 1" },
        { role: "assistant", content: "earlier assistant response 1" },
        { role: "user", content: "earlier user message 2" },
        { role: "assistant", content: "earlier assistant response 2" },
      ],
      settings: fakeSettings(),
    });

    // Aggregator is the LAST call (proposer #5 → aggregator).
    const lastCallArgs = mockedGenerateText.mock.calls.at(-1)?.[0] as
      | { messages?: Array<{ role: string; content: unknown }> }
      | undefined;

    expect(lastCallArgs).toBeDefined();
    expect(Array.isArray(lastCallArgs!.messages)).toBe(true);
    expect(
      lastCallArgs!.messages!.length,
      "PM #2: Aggregator messages array must be exactly 1 entry — " +
        "the buildAggregatorPrompt user message. Adding safeHistory here " +
        "creates consecutive `user` messages, which crash Gemma and other " +
        "strict models."
    ).toBe(1);
    expect(lastCallArgs!.messages![0].role).toBe("user");
  }, 30_000);
});
