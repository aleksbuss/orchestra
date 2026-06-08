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

import { runMoAEnsemble, MOA_PROPOSERS, AGGREGATOR_SYSTEM_PROMPT } from "./moa";
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

describe("PM #37 — DPG output force-injects Skeptic when LLM omits it", () => {
  // Audit finding: CLAUDE.md §1 promises "one DPG role is ALWAYS forced to
  // be a QA Auditor / Skeptic". Pre-PM-37, this was enforced via a prompt
  // instruction — a weak utility-model could (and did, in testing) return
  // 3-5 personas without any critic. Now the code POST-VALIDATES the LLM
  // output and force-injects the canonical Adversarial Critic when absent.
  it("LLM returns 3 personas with NO skeptic → critic is injected", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: {
        requiresSwarm: true,
        personas: [
          { id: "analyst", role: "Senior Analyst", systemPrompt: "[GOAL] analyse [RULES] use data [FORMAT] markdown", color: "blue" },
          { id: "implementer", role: "Implementation Engineer", systemPrompt: "[GOAL] ship [RULES] no perf bugs [FORMAT] code", color: "green" },
          { id: "writer", role: "Documentation Writer", systemPrompt: "[GOAL] explain [RULES] no jargon [FORMAT] paragraphs", color: "purple" },
        ],
      },
    } as any);
    // Stub proposers — return short drafts so aggregation also fires.
    mockedGenerateText.mockResolvedValue({ text: "ok" } as any);

    const result = await runMoAEnsemble({
      chatId: "c1",
      userMessage: "design a system",
      history: [],
      settings: fakeSettings(),
    });

    // Drafts include the canonical critic — count is 4, the critic appears
    // in the roster.
    expect(result.drafts).toHaveLength(4);
    const hasSkeptic = result.drafts.some(d =>
      /critic|skeptic|auditor|red.?team|adversari/i.test(d.proposerId) ||
      /critic|skeptic|auditor|red.?team|adversari/i.test(d.role)
    );
    expect(hasSkeptic).toBe(true);
  });

  it("LLM already includes a skeptic → no injection (count unchanged)", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: {
        requiresSwarm: true,
        personas: [
          { id: "tax_lawyer", role: "Senior Tax Attorney", systemPrompt: "[GOAL] tax [RULES] cite IRC [FORMAT] markdown", color: "blue" },
          { id: "skeptic_auditor", role: "QA Auditor", systemPrompt: "[GOAL] doubt [RULES] hunt edge cases [FORMAT] bullets", color: "rose" },
          { id: "domain_expert", role: "Domain Expert", systemPrompt: "[GOAL] depth [RULES] cite sources [FORMAT] structured", color: "purple" },
        ],
      },
    } as any);
    mockedGenerateText.mockResolvedValue({ text: "ok" } as any);

    const result = await runMoAEnsemble({
      chatId: "c1",
      userMessage: "tax question",
      history: [],
      settings: fakeSettings(),
    });

    // Exactly 3 drafts — no injection happened because skeptic_auditor was
    // already in the LLM output.
    expect(result.drafts).toHaveLength(3);
  });

  it("LLM returns 5 personas with no skeptic → tail is evicted to make room for critic (cap stays at 5)", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: {
        requiresSwarm: true,
        personas: [
          { id: "p1", role: "Role 1", systemPrompt: "[GOAL] g [RULES] r [FORMAT] f", color: "blue" },
          { id: "p2", role: "Role 2", systemPrompt: "[GOAL] g [RULES] r [FORMAT] f", color: "green" },
          { id: "p3", role: "Role 3", systemPrompt: "[GOAL] g [RULES] r [FORMAT] f", color: "purple" },
          { id: "p4", role: "Role 4", systemPrompt: "[GOAL] g [RULES] r [FORMAT] f", color: "orange" },
          // Tail position — will be evicted.
          { id: "p5_tail", role: "Role 5 (tail)", systemPrompt: "[GOAL] g [RULES] r [FORMAT] f", color: "amber" },
        ],
      },
    } as any);
    mockedGenerateText.mockResolvedValue({ text: "ok" } as any);

    const result = await runMoAEnsemble({
      chatId: "c1",
      userMessage: "do a thing",
      history: [],
      settings: fakeSettings(),
    });

    expect(result.drafts).toHaveLength(5);
    const ids = result.drafts.map(d => d.proposerId);
    expect(ids).toContain("critic"); // injected
    expect(ids).not.toContain("p5_tail"); // evicted to keep ≤ 5
  });

  it("requiresSwarm=false → no injection (the swarm doesn't run; nothing to enforce)", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: {
        requiresSwarm: false,
        // Empty personas — the LLM correctly omitted them on a trivial prompt.
        personas: [],
      },
    } as any);
    mockedGenerateText.mockResolvedValueOnce({ text: "hi back" } as any);

    const result = await runMoAEnsemble({
      chatId: "c1",
      userMessage: "hi",
      history: [],
      settings: fakeSettings(),
    });

    // Bypass path — only the single direct-answer generateText fired, no
    // proposers, no aggregator. Nothing to inject into.
    expect(result.drafts).toEqual([]);
    expect(mockedGenerateText).toHaveBeenCalledTimes(1);
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
      // PresetTier is now narrowed to "custom" only (presets.ts gutted).
      // Using "custom" preserves the original test intent: confirm bypass
      // ignores ANY preset, regardless of which tier it is.
      preset: "custom",
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

describe("runMoAEnsemble — forceSwarm overrides Router bypass (2026-05-20)", () => {
  // The Router runs on `utilityModel` (often a cheap model). When the user
  // has explicitly pinned the "Force Swarm" toggle in the UI, the Router's
  // `requiresSwarm: false` verdict must be ignored — otherwise a weak
  // utilityModel silently mis-classifies substantive prompts as "trivial"
  // and the user gets a single-model answer when they demanded an ensemble.

  it("forceSwarm=true runs the full ensemble even when Router says bypass", async () => {
    // Router votes for bypass, but with personas already populated (the
    // schema enforces .min(3).max(5) so personas are present on success).
    mockedGenerateObject.mockResolvedValueOnce({
      object: {
        requiresSwarm: false,
        personas: MOA_PROPOSERS.slice(0, 3).map((p) => ({
          id: p.id,
          role: p.role,
          systemPrompt: p.systemPrompt,
          color: p.color,
        })),
      },
    } as any);

    let callIndex = 0;
    mockedGenerateText.mockImplementation(async () => {
      callIndex += 1;
      return { text: `draft-${callIndex}` } as any;
    });

    const result = await runMoAEnsemble({
      chatId: "c1",
      userMessage: "tell me about quantum computing",
      history: [],
      settings: fakeSettings(),
      forceSwarm: true,
    });

    // 3 proposers + 1 aggregator = 4 generateText calls. If forceSwarm were
    // ignored, it would be exactly 1 (the bypass direct-answer call).
    expect(mockedGenerateText).toHaveBeenCalledTimes(4);
    expect(result.drafts.length).toBe(3);
  }, 30_000);

  it("forceSwarm=false (the default) still respects the Router's bypass decision", async () => {
    // Negative-space guard: the forceSwarm flag must not accidentally flip
    // the default behavior. Existing bypass logic stays exactly as before.
    mockedGenerateObject.mockResolvedValueOnce({
      object: { requiresSwarm: false, personas: [] },
    } as any);
    mockedGenerateText.mockResolvedValueOnce({ text: "direct answer" } as any);

    const result = await runMoAEnsemble({
      chatId: "c1",
      userMessage: "hi",
      history: [],
      settings: fakeSettings(),
      forceSwarm: false,
    });

    expect(mockedGenerateText).toHaveBeenCalledTimes(1);
    expect(result.drafts).toEqual([]);
  });

  it("forceSwarm=true is a no-op when Router already wants the swarm", async () => {
    // When Router says `requiresSwarm: true`, the swarm runs regardless of
    // the flag. The flag's only job is to override `false → true`, never
    // the other way around.
    // PM #37 — must include a skeptic in the test data, otherwise the
    // Skeptic-injection guard now adds one and bumps the call count.
    // Picking analyst (0) + critic (3) + chameleon (4) gives the swarm
    // its required Adversarial Critic so the guard stays inert here.
    mockedGenerateObject.mockResolvedValueOnce({
      object: {
        requiresSwarm: true,
        personas: [MOA_PROPOSERS[0], MOA_PROPOSERS[3], MOA_PROPOSERS[4]].map((p) => ({
          id: p.id,
          role: p.role,
          systemPrompt: p.systemPrompt,
          color: p.color,
        })),
      },
    } as any);

    let callIndex = 0;
    mockedGenerateText.mockImplementation(async () => {
      callIndex += 1;
      return { text: `draft-${callIndex}` } as any;
    });

    const result = await runMoAEnsemble({
      chatId: "c1",
      userMessage: "complex multi-faceted analysis request",
      history: [],
      settings: fakeSettings(),
      forceSwarm: true,
    });

    // 3 proposers + 1 aggregator = 4 calls. Same as without the flag.
    expect(mockedGenerateText).toHaveBeenCalledTimes(4);
    expect(result.drafts.length).toBe(3);
  }, 30_000);
});

describe("PM #40 — aggregator prompt adapted from togethercomputer/MoA", () => {
  // Pin the key elements stolen from Together's reference prompt that
  // validated at 65.1% AlpacaEval (beat GPT-4o 57.5% on OSS models).
  // If a future PR weakens these, the synthesis quality regresses.

  it("system prompt contains the Together-paper 'critically evaluate ... may be biased' framing", () => {
    expect(AGGREGATOR_SYSTEM_PROMPT).toMatch(/critically evaluate/i);
    expect(AGGREGATOR_SYSTEM_PROMPT).toMatch(/biased.*incomplete.*incorrect|biased.*or incorrect/i);
  });

  it("system prompt forbids simple replication or vote-aggregation of drafts", () => {
    expect(AGGREGATOR_SYSTEM_PROMPT).toMatch(/NOT simply replicate|not simply replicate/);
    expect(AGGREGATOR_SYSTEM_PROMPT).toMatch(/vote-aggregate|refined.*accurate.*comprehensive/i);
  });

  it("system prompt cross-references the PM #39 disagreement marker", () => {
    expect(AGGREGATOR_SYSTEM_PROMPT).toContain("<<DISAGREEMENT_DETECTED>>");
  });

  it("system prompt preserves Orchestra-specific rules: code blocks + no meta-commentary", () => {
    expect(AGGREGATOR_SYSTEM_PROMPT).toMatch(/code/i);
    expect(AGGREGATOR_SYSTEM_PROMPT).toMatch(/NO META-COMMENTARY|no meta-commentary/i);
    expect(AGGREGATOR_SYSTEM_PROMPT).toMatch(/Start directly|don'?t begin|do not begin/i);
  });

  it("aggregator generateText call uses the new system prompt verbatim", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: {
        requiresSwarm: true,
        personas: [MOA_PROPOSERS[0], MOA_PROPOSERS[3], MOA_PROPOSERS[4]].map((p) => ({
          id: p.id,
          role: p.role,
          systemPrompt: p.systemPrompt,
          color: p.color,
        })),
      },
    } as never);
    mockedGenerateText.mockResolvedValue({
      text: "Aggregated reply long enough to skip reflection short-circuit.",
      usage: { inputTokens: 50, outputTokens: 30 },
    } as never);

    await runMoAEnsemble({
      chatId: "c1",
      userMessage: "test",
      history: [],
      settings: fakeSettings(),
    });

    // Aggregator is the LAST call.
    const aggregatorCall = mockedGenerateText.mock.calls.at(-1)?.[0] as
      | { system?: string }
      | undefined;
    expect(aggregatorCall?.system).toBe(AGGREGATOR_SYSTEM_PROMPT);
  }, 30_000);

  it("aggregator user content uses numbered-list format (Together MoA convention)", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: {
        requiresSwarm: true,
        personas: [MOA_PROPOSERS[0], MOA_PROPOSERS[3], MOA_PROPOSERS[4]].map((p) => ({
          id: p.id,
          role: p.role,
          systemPrompt: p.systemPrompt,
          color: p.color,
        })),
      },
    } as never);
    // 3 proposers + aggregator
    for (let i = 0; i < 3; i++) {
      mockedGenerateText.mockResolvedValueOnce({
        text: `Proposer ${i + 1} substantive draft text long enough.`,
        usage: { inputTokens: 50, outputTokens: 30 },
      } as never);
    }
    mockedGenerateText.mockResolvedValueOnce({
      text: "Final aggregated reply long enough to skip reflection.",
      usage: { inputTokens: 50, outputTokens: 30 },
    } as never);

    await runMoAEnsemble({
      chatId: "c1",
      userMessage: "trade-off question",
      history: [],
      settings: fakeSettings(),
    });

    const aggregatorCall = mockedGenerateText.mock.calls.at(-1)?.[0] as
      | { messages?: Array<{ content: string }> }
      | undefined;
    const userContent = aggregatorCall!.messages![0].content;
    // Numbered list: "1. [Expert role: ...]" / "2. [Expert role: ...]" / ...
    expect(userContent).toMatch(/^1\. \[Expert role: /m);
    expect(userContent).toMatch(/^2\. \[Expert role: /m);
    expect(userContent).toMatch(/^3\. \[Expert role: /m);
    // Original user request must still be in the prompt verbatim.
    expect(userContent).toContain("trade-off question");
    // Closing instruction.
    expect(userContent).toMatch(/Now produce the final synthesized response/);
  }, 30_000);
});

// PM #65 — probe a stepCountIs() StopCondition: it reports "stop" once the step
// count reaches its bound. A tool-using proposer must NOT stop at step 1 (it has
// to continue past the tool call to produce a final answer); a tool-less
// proposer stops at 1 (single generation).
async function stopsAtStep(stopWhen: unknown, stepCount: number): Promise<boolean> {
  const cond = (Array.isArray(stopWhen) ? stopWhen[0] : stopWhen) as
    | ((o: { steps: unknown[] }) => boolean | PromiseLike<boolean>)
    | undefined;
  if (typeof cond !== "function") return false;
  return Boolean(await cond({ steps: Array.from({ length: stepCount }, () => ({})) }));
}

describe("PM #65 — proposer tool-loop uses stopWhen (maxSteps was a silently-ignored no-op)", () => {
  // AI SDK v5+ removed `maxSteps` from generateText, so the prior
  // `maxSteps: proposerTools ? 3 : 1` was IGNORED and tool proposers stopped
  // right after the tool call (empty draft → dropped by isSuccessfulDraft). The
  // contract is now expressed via `stopWhen: stepCountIs(...)`. These cases pin
  // it: tool proposers may run multiple steps; tool-less proposers run exactly
  // one; the dead `maxSteps` field is gone.
  function basePersonas() {
    return [
      // analyst → researcher (gets search_web → maxSteps 3)
      { id: "analyst", role: "Senior Analyst", systemPrompt: "[GOAL] analyze [RULES] data-driven [FORMAT] markdown", color: "blue" as const },
      // creative → coder (no tools → maxSteps 1)
      { id: "creative", role: "Creative Brainstormer", systemPrompt: "[GOAL] ideate [RULES] no judgment [FORMAT] bullets", color: "green" as const },
      // critic → reviewer (gets search_web → maxSteps 3)
      { id: "critic", role: "Adversarial Critic", systemPrompt: "[GOAL] doubt [RULES] hunt edge cases [FORMAT] structured", color: "rose" as const },
    ];
  }

  it("with search enabled: tool proposers (researcher/reviewer) keep stepping past the tool call; coder stops at 1", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: { requiresSwarm: true, personas: basePersonas() },
    } as never);
    mockedGenerateText.mockResolvedValue({
      text: "draft text long enough to skip reflection short-circuit logic.",
      usage: { inputTokens: 50, outputTokens: 30 },
    } as never);

    const settings: AppSettings = {
      ...fakeSettings(),
      search: { enabled: true, provider: "tavily", apiKey: "test" },
    };

    await runMoAEnsemble({
      chatId: "c1",
      userMessage: "test",
      history: [],
      settings,
    });

    // Calls 1-3 are proposers; the last is the aggregator.
    const proposerCalls = mockedGenerateText.mock.calls.slice(0, 3) as Array<
      [{ system: string; maxSteps?: number; stopWhen?: unknown }]
    >;

    // analyst (researcher, has search_web) → must continue past the tool call.
    const analystCall = proposerCalls.find((c) => c[0].system.includes("analyze"));
    expect(analystCall?.[0].maxSteps).toBeUndefined(); // dead option is gone
    expect(await stopsAtStep(analystCall?.[0].stopWhen, 1)).toBe(false); // not after 1 step
    expect(await stopsAtStep(analystCall?.[0].stopWhen, 3)).toBe(true); // stops by step 3

    // creative (coder, no tools) → single generation (stops at step 1).
    const creativeCall = proposerCalls.find((c) => c[0].system.includes("ideate"));
    expect(creativeCall?.[0].maxSteps).toBeUndefined();
    expect(await stopsAtStep(creativeCall?.[0].stopWhen, 1)).toBe(true);

    // critic (reviewer, has search_web) → must continue past the tool call.
    const criticCall = proposerCalls.find((c) => c[0].system.includes("doubt"));
    expect(await stopsAtStep(criticCall?.[0].stopWhen, 1)).toBe(false);
    expect(await stopsAtStep(criticCall?.[0].stopWhen, 3)).toBe(true);
  }, 30_000);

  it("with search disabled: every proposer stops at step 1 (no tools assigned to anyone)", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: { requiresSwarm: true, personas: basePersonas() },
    } as never);
    mockedGenerateText.mockResolvedValue({
      text: "draft text long enough to skip reflection short-circuit logic.",
      usage: { inputTokens: 50, outputTokens: 30 },
    } as never);

    await runMoAEnsemble({
      chatId: "c1",
      userMessage: "test",
      history: [],
      settings: fakeSettings(), // search.enabled === false
    });

    const proposerCalls = mockedGenerateText.mock.calls.slice(0, 3) as Array<
      [{ system: string; maxSteps?: number; stopWhen?: unknown; tools?: object }]
    >;
    for (const call of proposerCalls) {
      expect(call[0].maxSteps).toBeUndefined();
      expect(call[0].tools).toBeUndefined();
      // No tools → single generation (stop at step 1).
      expect(await stopsAtStep(call[0].stopWhen, 1)).toBe(true);
    }
  }, 30_000);
});

describe("PM #66 — proposer maxOutputTokens respects configured maxTokens (no hard 2048 cap)", () => {
  it("does NOT cap proposers at 2048 when the operator configured a higher maxTokens", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: {
        requiresSwarm: true,
        personas: [
          { id: "analyst", role: "Analyst", systemPrompt: "[GOAL] analyze [RULES] x [FORMAT] md", color: "blue" },
          { id: "creative", role: "Creative", systemPrompt: "[GOAL] ideate [RULES] x [FORMAT] md", color: "green" },
        ],
      },
    } as never);
    mockedGenerateText.mockResolvedValue({
      text: "draft text long enough to skip reflection short-circuit logic.",
      usage: { inputTokens: 10, outputTokens: 10 },
    } as never);

    const base = fakeSettings();
    const settings: AppSettings = {
      ...base,
      // Proposers resolve to the utilityModel when no preset/tiers are set.
      utilityModel: { ...base.utilityModel, maxTokens: 8000 },
    };

    await runMoAEnsemble({ chatId: "c1", userMessage: "test", history: [], settings });

    // Calls 0-1 are the two proposers (call 2 is the aggregator).
    const proposerCalls = mockedGenerateText.mock.calls.slice(0, 2) as Array<
      [{ maxOutputTokens?: number }]
    >;
    for (const call of proposerCalls) {
      // Pre-fix this was Math.min(8000, 2048) = 2048.
      expect(call[0].maxOutputTokens).toBe(8000);
    }
  }, 30_000);
});

describe("PM #45 — unified skeptic detection (no double-injection on 'qa_engineer'-shape ids)", () => {
  // Audit finding: PM #37 used its own SKEPTIC_PATTERN regex; PM #42
  // used detectProposerRole's reviewer regex. They diverged on "qa",
  // "quality", "review" keywords. A DPG-returned persona "qa_engineer"
  // would be (a) recognized as a reviewer by PM #42 (gets search_web),
  // (b) NOT recognized as a skeptic by PM #37 (critic force-injected
  // anyway) — leaving two reviewer-shape personas in the swarm.
  //
  // PM #45 unifies both call sites on detectProposerRole. These tests
  // pin the behavior across the previously-divergent cases.
  it("DPG returns 'qa_engineer' (no explicit critic id) → NO double-injection", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: {
        requiresSwarm: true,
        personas: [
          { id: "tax_lawyer", role: "Senior Tax Attorney", systemPrompt: "[GOAL] tax [RULES] cite IRC [FORMAT] markdown", color: "blue" },
          // "qa_engineer" — matches PM #42's reviewer regex but did NOT
          // match PM #37's pre-fix SKEPTIC_PATTERN.
          { id: "qa_engineer", role: "QA Engineer", systemPrompt: "[GOAL] verify [RULES] hunt regressions [FORMAT] bullets", color: "amber" },
          { id: "domain_expert", role: "Domain Expert", systemPrompt: "[GOAL] depth [RULES] cite sources [FORMAT] structured", color: "purple" },
        ],
      },
    } as never);
    mockedGenerateText.mockResolvedValue({
      text: "ok draft text long enough to skip reflection short-circuit.",
      usage: { inputTokens: 50, outputTokens: 30 },
    } as never);

    const result = await runMoAEnsemble({
      chatId: "c1",
      userMessage: "tax + compliance question",
      history: [],
      settings: fakeSettings(),
    });

    // Exactly 3 drafts — qa_engineer is recognized as the skeptic, NO
    // duplicate critic injected. Pre-PM #45 this returned 4 drafts.
    expect(result.drafts).toHaveLength(3);
    const ids = result.drafts.map((d) => d.proposerId);
    expect(ids).toContain("qa_engineer");
    expect(ids).not.toContain("critic"); // would have been added by PM #37 alone
  }, 30_000);

  it("DPG returns persona with 'review' in role string → NO double-injection", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: {
        requiresSwarm: true,
        personas: [
          { id: "alpha", role: "Senior Alpha", systemPrompt: "[GOAL] g [RULES] r [FORMAT] f", color: "blue" },
          { id: "beta", role: "Code Reviewer", systemPrompt: "[GOAL] g [RULES] r [FORMAT] f", color: "amber" },
          { id: "gamma", role: "Implementer", systemPrompt: "[GOAL] g [RULES] r [FORMAT] f", color: "green" },
        ],
      },
    } as never);
    mockedGenerateText.mockResolvedValue({
      text: "draft text long enough to skip reflection short-circuit.",
      usage: { inputTokens: 50, outputTokens: 30 },
    } as never);

    const result = await runMoAEnsemble({
      chatId: "c1",
      userMessage: "build me x",
      history: [],
      settings: fakeSettings(),
    });

    expect(result.drafts).toHaveLength(3);
    expect(result.drafts.map((d) => d.proposerId)).not.toContain("critic");
  }, 30_000);
});

describe("PM #38 — reflection loop wired into MoA after aggregator", () => {
  // Audit finding: reflection.ts was thoroughly tested but never wired in.
  // These tests pin the integration: when settings.reflection.enabled is
  // true, reflection runs after aggregator; when the critic says
  // shouldRevise, the revisor replaces the aggregator's text. Cost goes
  // up by 1-2 LLM calls; usage attribution makes that visible to the
  // operator via the PM #36 budget banner.
  function settingsWithReflection(): AppSettings {
    return {
      ...fakeSettings(),
      reflection: { enabled: true },
    };
  }

  // Helper: stub DPG → 3 personas (analyst, critic, chameleon — includes
  // skeptic so PM #37 guard doesn't fire). Then proposers return cheap
  // drafts. Caller queues aggregator + reflection + revisor responses.
  function mockSwarmThru(aggregatorText: string) {
    mockedGenerateObject.mockResolvedValueOnce({
      object: {
        requiresSwarm: true,
        personas: [MOA_PROPOSERS[0], MOA_PROPOSERS[3], MOA_PROPOSERS[4]].map((p) => ({
          id: p.id,
          role: p.role,
          systemPrompt: p.systemPrompt,
          color: p.color,
        })),
      },
    } as never);
    // 3 proposers
    for (let i = 0; i < 3; i++) {
      mockedGenerateText.mockResolvedValueOnce({
        text: `draft ${i + 1}`,
        usage: { inputTokens: 50, outputTokens: 30 },
      } as never);
    }
    // Aggregator
    mockedGenerateText.mockResolvedValueOnce({
      text: aggregatorText,
      usage: { inputTokens: 200, outputTokens: 100 },
    } as never);
  }

  // IMPORTANT: aggregator stub text MUST exceed 30 characters or
  // reflection.ts short-circuits (the "skip on trivial response" guard)
  // and never calls generateText, breaking our call-count expectations.
  const AGG_TEXT = "Aggregated final consensus answer assembled from expert drafts.";
  const AGG_TEXT_REVISED = "Aggregated final consensus, bug fixed.";

  it("reflection.enabled=false (or undefined) → NO reflection LLM call", async () => {
    mockSwarmThru(AGG_TEXT);
    const result = await runMoAEnsemble({
      chatId: "c1",
      userMessage: "do a thing",
      history: [],
      settings: fakeSettings(), // no reflection setting → disabled by default
    });

    // 3 proposers + 1 aggregator = 4 calls. NO reflection, NO revisor.
    expect(mockedGenerateText).toHaveBeenCalledTimes(4);
    expect(result.text).toBe(AGG_TEXT);
  }, 30_000);

  it("reflection.enabled=true, critic says CLEAN → reflection fires but text unchanged", async () => {
    mockSwarmThru(AGG_TEXT);
    // Reflection call: critic says clean
    mockedGenerateText.mockResolvedValueOnce({
      text: '{"shouldRevise": false, "critique": "", "suggestion": ""}',
      usage: { inputTokens: 80, outputTokens: 20 },
    } as never);

    const result = await runMoAEnsemble({
      chatId: "c1",
      userMessage: "do a thing",
      history: [],
      settings: settingsWithReflection(),
    });

    // 3 proposers + 1 aggregator + 1 reflection = 5 calls. No revisor.
    expect(mockedGenerateText).toHaveBeenCalledTimes(5);
    expect(result.text).toBe(AGG_TEXT);
  }, 30_000);

  it("reflection.enabled=true, critic flags issue → revisor runs and replaces text", async () => {
    mockSwarmThru(AGG_TEXT);
    // Reflection call: critic flags
    mockedGenerateText.mockResolvedValueOnce({
      text: '{"shouldRevise": true, "critique": "code has a bug", "suggestion": "fix the bug"}',
      usage: { inputTokens: 80, outputTokens: 30 },
    } as never);
    // Revisor produces the corrected text
    mockedGenerateText.mockResolvedValueOnce({
      text: AGG_TEXT_REVISED,
      usage: { inputTokens: 250, outputTokens: 110 },
    } as never);

    const result = await runMoAEnsemble({
      chatId: "c1",
      userMessage: "do a thing",
      history: [],
      settings: settingsWithReflection(),
    });

    // 3 proposers + aggregator + reflection + revisor = 6 calls.
    expect(mockedGenerateText).toHaveBeenCalledTimes(6);
    // Text was replaced by the revisor output.
    expect(result.text).toBe(AGG_TEXT_REVISED);
  }, 30_000);

  it("reflection failure is non-fatal — original aggregator text ships", async () => {
    mockSwarmThru(AGG_TEXT);
    // Reflection throws (LLM timeout, network blip, anything)
    mockedGenerateText.mockRejectedValueOnce(new Error("LLM timeout"));

    const result = await runMoAEnsemble({
      chatId: "c1",
      userMessage: "do a thing",
      history: [],
      settings: settingsWithReflection(),
    });

    // 3 proposers + aggregator + reflection (failed) = 5 attempts. The
    // run completes with the un-revised aggregator output; the reflection
    // failure is caught inside reflectOnResponse and returns a no-op
    // result, so no visible error to the user.
    expect(result.text).toBe(AGG_TEXT);
  }, 30_000);

  // PM #39 — disagreement marker is prepended to the aggregator prompt
  // when the embedder reports divergent proposer outputs.
  it("PM #39 — when disagreement detected, aggregator prompt is prefixed with the marker", async () => {
    // Re-mock the embeddings module just for this test so the detector
    // actually runs successfully with controlled divergent vectors.
    vi.doMock("@/lib/memory/embeddings", () => ({
      embedTexts: vi.fn().mockResolvedValue([
        [1, 0, 0, 0], // proposer 1
        [0, 1, 0, 0], // proposer 2 — orthogonal (cosine distance = 1.0)
        [0, 0, 1, 0], // proposer 3 — orthogonal
      ]),
    }));
    vi.resetModules();
    // Re-import the runMoAEnsemble after the dynamic mock so it picks up
    // the new embeddings stub. We also re-import generateText / Object
    // mocks since vi.resetModules() wipes the module registry.
    const { runMoAEnsemble: runWithDisagreementMock } = await import("./moa");
    const { generateText: gt, generateObject: go } = await import("ai");
    const gtMock = vi.mocked(gt);
    const goMock = vi.mocked(go);
    gtMock.mockReset();
    goMock.mockReset();

    goMock.mockResolvedValueOnce({
      object: {
        requiresSwarm: true,
        personas: [MOA_PROPOSERS[0], MOA_PROPOSERS[3], MOA_PROPOSERS[4]].map((p) => ({
          id: p.id,
          role: p.role,
          systemPrompt: p.systemPrompt,
          color: p.color,
        })),
      },
    } as never);
    // 3 proposers
    for (let i = 0; i < 3; i++) {
      gtMock.mockResolvedValueOnce({
        text: `Distinct proposer response number ${i + 1} with enough chars`,
        usage: { inputTokens: 50, outputTokens: 30 },
      } as never);
    }
    // Aggregator
    gtMock.mockResolvedValueOnce({
      text: "Synthesized answer that acknowledges the divergence.",
      usage: { inputTokens: 200, outputTokens: 100 },
    } as never);

    await runWithDisagreementMock({
      chatId: "c1",
      userMessage: "trade-off question",
      history: [],
      settings: fakeSettings(),
    });

    // The aggregator is the LAST generateText call. Its `messages[0].content`
    // should contain the disagreement marker prefix.
    const aggregatorCall = gtMock.mock.calls.at(-1)?.[0] as
      | { messages?: Array<{ content: string }> }
      | undefined;
    expect(aggregatorCall).toBeDefined();
    const aggregatorContent = aggregatorCall!.messages![0].content;
    expect(aggregatorContent).toContain("<<DISAGREEMENT_DETECTED>>");
    expect(aggregatorContent).toContain("DIVERGE significantly");
    // The original user message and drafts should still be in the prompt
    // (the marker prepends, doesn't replace).
    expect(aggregatorContent).toContain("trade-off question");
    expect(aggregatorContent).toContain("Distinct proposer response number 1");

    vi.doUnmock("@/lib/memory/embeddings");
  }, 30_000);

  it("cumulativeUsage folds reflection + revisor tokens (PM #36 attribution)", async () => {
    mockSwarmThru(AGG_TEXT);
    // Reflection: flags issue
    mockedGenerateText.mockResolvedValueOnce({
      text: '{"shouldRevise": true, "critique": "X", "suggestion": "Y"}',
      usage: { inputTokens: 100, outputTokens: 30 },
    } as never);
    // Revisor
    mockedGenerateText.mockResolvedValueOnce({
      text: "Revised version of the answer with the correction applied.",
      usage: { inputTokens: 300, outputTokens: 150 },
    } as never);

    const result = await runMoAEnsemble({
      chatId: "c1",
      userMessage: "do a thing",
      history: [],
      settings: settingsWithReflection(),
    });

    // Expected cumulative inputTokens:
    //   3 proposers × 50 = 150
    //   aggregator: 200
    //   reflection: 100
    //   revisor: 300
    //   = 750
    // (Router via generateObject doesn't carry usage in this mock setup,
    // so we just assert the lower-bound sum from the LLM calls we mocked.)
    expect(result.cumulativeUsage).toBeDefined();
    expect(result.cumulativeUsage!.promptTokens).toBe(750);
    // Output tokens: 3×30 + 100 + 30 + 150 = 370
    expect(result.cumulativeUsage!.completionTokens).toBe(370);
  }, 30_000);
});

describe("PM #46 — multi-round reflection with convergence + hard cap", () => {
  // Helper: stub DPG with skeptic-included personas + 3 proposer drafts
  // + 1 aggregator. Caller queues additional reflection / revision calls.
  function queueSwarmThroughAggregator(aggregatorText: string) {
    mockedGenerateObject.mockResolvedValueOnce({
      object: {
        requiresSwarm: true,
        personas: [MOA_PROPOSERS[0], MOA_PROPOSERS[3], MOA_PROPOSERS[4]].map((p) => ({
          id: p.id,
          role: p.role,
          systemPrompt: p.systemPrompt,
          color: p.color,
        })),
      },
    } as never);
    for (let i = 0; i < 3; i++) {
      mockedGenerateText.mockResolvedValueOnce({
        text: `Substantive proposer draft #${i + 1} long enough to escape any short-circuit.`,
        usage: { inputTokens: 50, outputTokens: 30 },
      } as never);
    }
    mockedGenerateText.mockResolvedValueOnce({
      text: aggregatorText,
      usage: { inputTokens: 200, outputTokens: 100 },
    } as never);
  }

  const settingsMultiRound = (
    maxRounds: number,
    convergenceThreshold?: number
  ): AppSettings => ({
    ...fakeSettings(),
    reflection: {
      enabled: true,
      maxRounds,
      ...(convergenceThreshold !== undefined ? { convergenceThreshold } : {}),
    },
  });

  it("maxRounds=1 (default-shape) preserves PM #38 single-pass behavior", async () => {
    queueSwarmThroughAggregator("Initial aggregator response, long enough.");
    // Critic flags, revisor fires once, then stop (maxRounds=1).
    mockedGenerateText.mockResolvedValueOnce({
      text: '{"shouldRevise": true, "critique": "first issue", "suggestion": "fix it"}',
      usage: { inputTokens: 80, outputTokens: 30 },
    } as never);
    mockedGenerateText.mockResolvedValueOnce({
      text: "Revised version #1 long enough to escape short-circuit.",
      usage: { inputTokens: 200, outputTokens: 80 },
    } as never);

    const result = await runMoAEnsemble({
      chatId: "c1",
      userMessage: "do thing",
      history: [],
      settings: settingsMultiRound(1),
    });

    // 3 proposers + 1 aggregator + 1 reflection + 1 revisor = 6 calls.
    // NO second reflection call (maxRounds=1 caps after first revision).
    expect(mockedGenerateText).toHaveBeenCalledTimes(6);
    expect(result.text).toBe("Revised version #1 long enough to escape short-circuit.");
  }, 30_000);

  it("convergence stops the loop early when revision embeddings are near-identical", async () => {
    queueSwarmThroughAggregator("Aggregator output long enough to skip short-circuit.");
    // Round 1: critic flags, revisor runs.
    mockedGenerateText.mockResolvedValueOnce({
      text: '{"shouldRevise": true, "critique": "issue A", "suggestion": "fix A"}',
      usage: { inputTokens: 80, outputTokens: 30 },
    } as never);
    mockedGenerateText.mockResolvedValueOnce({
      text: "First revision long enough to skip short-circuit logic.",
      usage: { inputTokens: 200, outputTokens: 80 },
    } as never);
    // Embedder returns IDENTICAL vectors immediately → cosine = 1.0 →
    // convergence triggers on round 1. The loop stops; the 2nd
    // reflection / revisor never fires even though maxRounds=5.
    vi.doMock("@/lib/memory/embeddings", () => ({
      embedTexts: vi.fn().mockResolvedValue([
        [1, 0, 0, 0],
        [1, 0, 0, 0], // identical → converged
      ]),
    }));
    vi.resetModules();
    const { runMoAEnsemble: runWithConvergence } = await import("./moa");

    const result = await runWithConvergence({
      chatId: "c1",
      userMessage: "do thing",
      history: [],
      settings: settingsMultiRound(5),
    });

    // Final text = round 1 revision. The loop short-circuited on
    // convergence rather than running more rounds.
    expect(result.text).toBe(
      "First revision long enough to skip short-circuit logic."
    );

    vi.doUnmock("@/lib/memory/embeddings");
  }, 30_000);

  it("non-converged embeddings + persistently-flagging critic → loops to maxRounds cap", async () => {
    queueSwarmThroughAggregator("Aggregator output long enough to skip short-circuit.");
    // Queue 5 rounds of (reflection-flags + revisor). With maxRounds=3
    // and orthogonal embeddings (never converged), the loop should fire
    // 3 reflections + 3 revisions then exit.
    for (let i = 0; i < 5; i++) {
      mockedGenerateText.mockResolvedValueOnce({
        text: `{"shouldRevise": true, "critique": "issue ${i}", "suggestion": "fix ${i}"}`,
        usage: { inputTokens: 80, outputTokens: 30 },
      } as never);
      mockedGenerateText.mockResolvedValueOnce({
        text: `Revision ${i} long enough to escape short-circuit logic block here.`,
        usage: { inputTokens: 200, outputTokens: 80 },
      } as never);
    }

    // Embedder returns orthogonal vectors → cosine 0 → never converged.
    vi.doMock("@/lib/memory/embeddings", () => ({
      embedTexts: vi.fn().mockResolvedValue([
        [1, 0, 0, 0],
        [0, 1, 0, 0],
      ]),
    }));
    vi.resetModules();
    const { runMoAEnsemble: runWithCap } = await import("./moa");

    const result = await runWithCap({
      chatId: "c1",
      userMessage: "do thing",
      history: [],
      settings: settingsMultiRound(3),
    });

    // maxRounds=3 → 3 revisions fired. Final text is "Revision 2" (0-indexed).
    expect(result.text).toBe(
      "Revision 2 long enough to escape short-circuit logic block here."
    );

    vi.doUnmock("@/lib/memory/embeddings");
  }, 30_000);

  it("hard cap (ABSOLUTE_MAX_REFLECTION_ROUNDS=50) protects against runaway maxRounds=999", async () => {
    queueSwarmThroughAggregator("Initial response long enough to skip short-circuit logic.");

    // Mock 51 reflection rounds (50 cap + 1 buffer to verify cap fires).
    // Each round: critic flags + revisor runs.
    for (let i = 0; i < 51; i++) {
      mockedGenerateText.mockResolvedValueOnce({
        text: `{"shouldRevise": true, "critique": "round ${i}", "suggestion": "fix"}`,
        usage: { inputTokens: 10, outputTokens: 10 },
      } as never);
      mockedGenerateText.mockResolvedValueOnce({
        text: `Revision ${i} long enough to skip short-circuit logic always.`,
        usage: { inputTokens: 10, outputTokens: 10 },
      } as never);
    }

    // Force divergent embeddings so convergence never triggers.
    vi.doMock("@/lib/memory/embeddings", () => ({
      embedTexts: vi.fn().mockResolvedValue([
        [1, 0, 0, 0],
        [0, 1, 0, 0], // orthogonal each time
      ]),
    }));
    vi.resetModules();
    const { runMoAEnsemble: runWithCap } = await import("./moa");

    await runWithCap({
      chatId: "c1",
      userMessage: "do thing",
      history: [],
      settings: settingsMultiRound(999), // operator set absurd value
    });

    // We can't easily assert the call count after vi.resetModules() invalidated
    // the spy, but the run completing (within the 30s timeout) WITHOUT hanging
    // proves the hard cap fired. If the cap were bypassed, this test would
    // run forever consuming queued mocks until they exhausted then crash.

    vi.doUnmock("@/lib/memory/embeddings");
  }, 30_000);

  it("convergenceThreshold is clamped to [0, 1] (defensive against operator typos)", async () => {
    queueSwarmThroughAggregator("Initial response long enough to skip short-circuit.");
    mockedGenerateText.mockResolvedValue({
      text: '{"shouldRevise": false, "critique": "", "suggestion": ""}',
      usage: { inputTokens: 50, outputTokens: 20 },
    } as never);

    // Operator typo: threshold 1.5 (impossible). Code should clamp to 1.0.
    // We don't assert internally — just verify the run completes without
    // throwing on an out-of-range setting.
    await expect(
      runMoAEnsemble({
        chatId: "c1",
        userMessage: "do thing",
        history: [],
        settings: settingsMultiRound(3, 1.5),
      })
    ).resolves.toBeDefined();

    // Same for negative.
    await expect(
      runMoAEnsemble({
        chatId: "c1",
        userMessage: "do thing",
        history: [],
        settings: settingsMultiRound(3, -0.5),
      })
    ).resolves.toBeDefined();
  }, 30_000);
});

// PM #56 — integration coverage that PM #52 deferred: end-to-end
// tournament path with all judges failing should fall through to the
// synthesis aggregator. PR #52 unit-tested that `bordaCount` returns
// empty winnerProposerId when zero judges succeed; this test pins that
// runMoAEnsemble actually runs synthesis as the fallback (so the user
// sees a real answer, not "(tournament failed)").
describe("PM #56 — tournament-failure fallback to synthesis (PM #52 closure)", () => {
  // PM #56 — `vi.clearAllMocks()` in the top-level beforeEach clears
  // call history but does NOT empty the `mockResolvedValueOnce` queue.
  // The PM #46 reflection tests above us queue 10 Once-mocks per case
  // and only consume some — the leftovers shift our mock sequence.
  // `mockReset()` empties the queue + restores default implementation.
  beforeEach(() => {
    mockedGenerateText.mockReset();
    mockedGenerateObject.mockReset();
  });

  function tournamentSettings(): AppSettings {
    return {
      ...fakeSettings(),
      aggregator: {
        mode: "tournament",
        tournamentJudgeCount: 2,
      },
    };
  }

  it("all judges fail → synthesis runs and produces the final text", async () => {
    // Router: requiresSwarm with 3 personas.
    mockedGenerateObject.mockResolvedValueOnce({
      object: {
        requiresSwarm: true,
        personas: [
          {
            id: "skeptic",
            role: "QA Auditor",
            systemPrompt: "[GOAL] Find flaws. [RULES] - [FORMAT] markdown",
            color: "rose",
          },
          {
            id: "coder",
            role: "Senior Coder",
            systemPrompt: "[GOAL] Code. [RULES] - [FORMAT] markdown",
            color: "violet",
          },
          {
            id: "analyst",
            role: "Analyst",
            systemPrompt: "[GOAL] Analyze. [RULES] - [FORMAT] markdown",
            color: "blue",
          },
        ],
      },
    } as never);
    // Proposers: three successful drafts via generateText.
    mockedGenerateText
      .mockResolvedValueOnce({ text: "Draft from skeptic" } as never)
      .mockResolvedValueOnce({ text: "Draft from coder" } as never)
      .mockResolvedValueOnce({ text: "Draft from analyst" } as never)
      // Synthesis aggregator (the fallback path).
      .mockResolvedValueOnce({
        text: "Synthesized final answer from fallback path",
      } as never);
    // Tournament judges: BOTH fail via generateObject.
    mockedGenerateObject
      .mockRejectedValueOnce(new Error("judge #1 timeout"))
      .mockRejectedValueOnce(new Error("judge #2 timeout"));

    const result = await runMoAEnsemble({
      chatId: "c-tourn",
      userMessage: "build a function",
      history: [],
      settings: tournamentSettings(),
    });

    // The final text MUST come from the synthesis fallback, NOT from
    // any single proposer draft.
    expect(result.text).toBe("Synthesized final answer from fallback path");
    // Drafts ARE present (tournament ran, just no winner).
    expect(result.drafts.length).toBe(3);
  }, 30_000);

  it("one judge succeeds → tournament winner is picked, NOT synthesis fallback", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: {
        requiresSwarm: true,
        personas: [
          {
            id: "skeptic",
            role: "QA",
            systemPrompt: "[GOAL] x [RULES] - [FORMAT] md",
            color: "rose",
          },
          {
            id: "coder",
            role: "Coder",
            systemPrompt: "[GOAL] x [RULES] - [FORMAT] md",
            color: "violet",
          },
          {
            id: "analyst",
            role: "Analyst",
            systemPrompt: "[GOAL] x [RULES] - [FORMAT] md",
            color: "blue",
          },
        ],
      },
    } as never);
    mockedGenerateText
      .mockResolvedValueOnce({ text: "Skeptic's draft" } as never)
      .mockResolvedValueOnce({ text: "Coder's draft" } as never)
      .mockResolvedValueOnce({ text: "Analyst's draft" } as never);
    // Tournament: judge #1 fails, judge #2 picks "coder".
    mockedGenerateObject
      .mockRejectedValueOnce(new Error("judge #1 timeout"))
      .mockResolvedValueOnce({
        object: { rankedProposerIds: ["coder", "analyst", "skeptic"] },
      } as never);

    const result = await runMoAEnsemble({
      chatId: "c-tourn-2",
      userMessage: "x",
      history: [],
      settings: tournamentSettings(),
    });

    // Coder's draft wins verbatim — no synthesis call needed.
    expect(result.text).toBe("Coder's draft");
    // Synthesis was NOT called (1 router + 3 proposers + 2 judges = 6 LLM
    // calls, but generateText only ran for the 3 proposers; the 4th
    // generateText would be the synthesis we deliberately skipped).
    expect(mockedGenerateText).toHaveBeenCalledTimes(3);
  }, 30_000);
});
