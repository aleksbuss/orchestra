/**
 * Free-tier track Sprint 3 — the brain's own delivery failover.
 *
 * The failure this prevents: a throttled free endpoint answers HTTP 200 with an
 * empty body, PM #69's forced final answer runs ONCE on that same endpoint, gets
 * another empty body, and the turn ends SILENTLY blank.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, generateText: vi.fn() };
});

vi.mock("@/lib/providers/llm-provider", () => ({
  createModel: vi.fn((cfg: { model: string }) => ({ __model: cfg.model })),
}));

import { generateText } from "ai";
import { createModel } from "@/lib/providers/llm-provider";
import type { AppSettings, ModelConfig } from "@/lib/types";
import {
  generateFinalAnswerWithFailover,
  buildFinalAnswerPool,
  finalAnswerInstruction,
  compareModelsByBenchmarkScoreDesc,
  UNDELIVERABLE_NOTICE,
} from "./final-answer-failover";
import {
  resetModelHealth,
  recordModelFailure,
  isModelCircuitOpen,
  getModelHealthEntry,
} from "./model-health";
import { FORCED_ANSWER_TOOL_OVERRIDE } from "@/lib/agent/prompts";
import {
  __setOpenRouterBenchmarkScoreForTest,
  __resetOpenRouterPricingForTests,
} from "@/lib/cost/openrouter-pricing";

const mockedGenerateText = vi.mocked(generateText);

const BRAIN: ModelConfig = { provider: "openrouter", model: "vendor/brain:free", apiKey: "k" };
const UTILITY: ModelConfig = { provider: "openrouter", model: "vendor/utility", apiKey: "k" };

function settings(): AppSettings {
  return {
    chatModel: { ...BRAIN },
    utilityModel: { ...UTILITY },
    embeddingsModel: { provider: "openai", model: "text-embedding-3-small", dimensions: 1536 },
    codeExecution: { enabled: true, timeout: 600, maxOutputLength: 120000 },
    memory: { enabled: true, similarityThreshold: 0.35, maxResults: 10, chunkSize: 400 },
    search: { enabled: false, provider: "none" },
    general: { darkMode: false, language: "en" },
    auth: { enabled: true, username: "a", passwordHash: "h", mustChangeCredentials: false },
  } as AppSettings;
}

function args(overrides: Record<string, unknown> = {}) {
  return {
    model: { __model: "brain-handle" } as never,
    systemPrompt: "sys",
    messages: [{ role: "user" as const, content: "hi" }],
    providerOptions: undefined,
    settings: settings(),
    brainConfig: BRAIN,
    ...overrides,
  };
}

/** Which model handles `generateText` was actually called with, in order. */
function calledModels(): string[] {
  return mockedGenerateText.mock.calls.map(
    (c) => ((c[0] as { model?: { __model?: string } }).model?.__model ?? "?") as string
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resetModelHealth();
  delete process.env.ORCHESTRA_FINAL_ANSWER_BACKOFF_MS;
  process.env.ORCHESTRA_FINAL_ANSWER_BACKOFF_MS = "1"; // keep the suite fast
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ORCHESTRA_FINAL_ANSWER_BACKOFF_MS;
});

describe("generateFinalAnswerWithFailover", () => {
  it("returns the brain's answer on the first attempt — no retry, no substitution", async () => {
    mockedGenerateText.mockResolvedValueOnce({ text: "the answer", usage: { totalTokens: 5 } } as never);

    const out = await generateFinalAnswerWithFailover(args());

    expect(out.text).toBe("the answer");
    expect(out.notice).toBeUndefined();
    expect(mockedGenerateText).toHaveBeenCalledTimes(1);
    expect(createModel).not.toHaveBeenCalled();
  });

  it("retries the brain ONCE when the first attempt returns an empty body", async () => {
    mockedGenerateText
      .mockResolvedValueOnce({ text: "" } as never)
      .mockResolvedValueOnce({ text: "recovered" } as never);

    const out = await generateFinalAnswerWithFailover(args());

    expect(out.text).toBe("recovered");
    expect(mockedGenerateText).toHaveBeenCalledTimes(2);
    expect(createModel).not.toHaveBeenCalled(); // no substitution needed
  });

  it("substitutes a healthy model when the brain stays empty — and SAYS SO", async () => {
    mockedGenerateText
      .mockResolvedValueOnce({ text: "" } as never)
      .mockResolvedValueOnce({ text: "" } as never)
      .mockResolvedValueOnce({ text: "answered by the substitute" } as never);

    const out = await generateFinalAnswerWithFailover(args());

    expect(out.text).toBe("answered by the substitute");
    expect(mockedGenerateText).toHaveBeenCalledTimes(3);
    expect(createModel).toHaveBeenCalledWith(
      expect.objectContaining({ model: UTILITY.model }),
      expect.anything()
    );
    // A substituted answer must never look like a normal one.
    expect(out.notice).toContain(BRAIN.model);
    expect(out.notice).toContain(UTILITY.model);
  });

  it("skips the brain entirely when its circuit is already tripped", async () => {
    for (let i = 0; i < 3; i++) recordModelFailure(BRAIN.provider, BRAIN.model, "empty");
    expect(isModelCircuitOpen(BRAIN.provider, BRAIN.model)).toBe(true);
    mockedGenerateText.mockResolvedValueOnce({ text: "substitute answer" } as never);

    const out = await generateFinalAnswerWithFailover(args());

    expect(out.text).toBe("substitute answer");
    // Straight to the substitute — the dead brain is not dialled at all.
    expect(calledModels()).toEqual([UTILITY.model]);
  });

  it("skipBrainRetry — goes straight to the substitute, never re-attempting the brain", async () => {
    // Post-review Sprint 0: the caller (primary-stream-recovery.ts) already has
    // fresh, same-turn evidence a same-endpoint retry cannot help. The brain
    // must not be dialled at all — only the substitute.
    mockedGenerateText.mockResolvedValueOnce({ text: "substitute answer" } as never);

    const out = await generateFinalAnswerWithFailover(args({ skipBrainRetry: true }));

    expect(out.text).toBe("substitute answer");
    expect(calledModels()).toEqual([UTILITY.model]);
    expect(mockedGenerateText).toHaveBeenCalledTimes(1);
  });

  it("NEVER returns a silent empty — an undeliverable turn carries a notice", async () => {
    mockedGenerateText.mockResolvedValue({ text: "" } as never);

    const out = await generateFinalAnswerWithFailover(args());

    expect(out.text).toBe("");
    expect(out.notice).toBe(UNDELIVERABLE_NOTICE);
    expect(out.notice).toMatch(/rate-limited|Continue|Settings/);
  });

  it("is bounded — at most three generations even when everything is empty", async () => {
    mockedGenerateText.mockResolvedValue({ text: "" } as never);
    await generateFinalAnswerWithFailover(args());
    expect(mockedGenerateText).toHaveBeenCalledTimes(3);
  });

  it("treats a thrown error like an empty body and moves down the ladder", async () => {
    mockedGenerateText
      .mockRejectedValueOnce(new Error("503 Service Unavailable"))
      .mockRejectedValueOnce(new Error("503 Service Unavailable"))
      .mockResolvedValueOnce({ text: "substitute answer" } as never);

    const out = await generateFinalAnswerWithFailover(args());
    expect(out.text).toBe("substitute answer");
  });

  it("records endpoint health: empty bodies accumulate on the brain across turns", async () => {
    mockedGenerateText.mockResolvedValue({ text: "" } as never);
    // Turn 1: 2 brain attempts, both empty → 2 consecutive failures. The
    // threshold is 3, so the brain is not tripped YET.
    await generateFinalAnswerWithFailover(args());
    expect(isModelCircuitOpen(BRAIN.provider, BRAIN.model)).toBe(false);

    // Turn 2: the brain's first attempt is empty again → 3rd failure → tripped,
    // so the retry is skipped and the turn goes straight to the substitute.
    mockedGenerateText.mockReset();
    mockedGenerateText.mockResolvedValue({ text: "" } as never);
    await generateFinalAnswerWithFailover(args());
    expect(isModelCircuitOpen(BRAIN.provider, BRAIN.model)).toBe(true);
    expect(mockedGenerateText).toHaveBeenCalledTimes(2); // brain once, substitute once
  });

  it("a brain success heals its circuit", async () => {
    for (let i = 0; i < 3; i++) recordModelFailure(BRAIN.provider, BRAIN.model, "empty");
    expect(isModelCircuitOpen(BRAIN.provider, BRAIN.model)).toBe(true);
    // A later healthy turn on the brain (simulated directly through the helper,
    // with the breaker no longer blocking it) must clear the trip.
    resetModelHealth();
    mockedGenerateText.mockResolvedValueOnce({ text: "fine" } as never);
    await generateFinalAnswerWithFailover(args());
    expect(isModelCircuitOpen(BRAIN.provider, BRAIN.model)).toBe(false);
  });

  it("stops immediately when the user aborts, without spending the ladder", async () => {
    const controller = new AbortController();
    mockedGenerateText.mockImplementation((async () => {
      controller.abort();
      return { text: "" };
    }) as never);

    const out = await generateFinalAnswerWithFailover(args({ abortSignal: controller.signal }));

    expect(out.text).toBe("");
    expect(mockedGenerateText).toHaveBeenCalledTimes(1);
  });

  // PM #120 — protake council, unanimous 4/4: every `if (abortSignal?.aborted)
  // return { text: "", usage }` in this function was silent, the same defect
  // shape as PM #118's empty-response branch. A cascade stopped by a client
  // disconnect must leave the same trace a cascade stopped by any other means
  // does — this test is deliberately the LOG assertion, not a new behavior
  // assertion (the return value is already covered by the test above).
  it("logs when the abort gate fires, instead of returning silently", async () => {
    const controller = new AbortController();
    mockedGenerateText.mockImplementation((async () => {
      controller.abort();
      return { text: "" };
    }) as never);

    await generateFinalAnswerWithFailover(args({ abortSignal: controller.signal }));

    const warnCalls = vi.mocked(console.warn).mock.calls.map((c) => String(c[0]));
    expect(warnCalls.some((line) => line.includes("recovery aborted"))).toBe(true);
  });

  it("an abort is not counted against the endpoint's circuit", async () => {
    const controller = new AbortController();
    controller.abort();
    mockedGenerateText.mockImplementation((async () => {
      throw new Error("The operation was aborted.");
    }) as never);

    await generateFinalAnswerWithFailover(args({ abortSignal: controller.signal }));

    const snapshotTripped = isModelCircuitOpen(BRAIN.provider, BRAIN.model);
    expect(snapshotTripped).toBe(false);
  });

  it("degrades to ONE attempt when no brainConfig is supplied (pre-Sprint-3 callers)", async () => {
    mockedGenerateText.mockResolvedValue({ text: "" } as never);

    const out = await generateFinalAnswerWithFailover(args({ brainConfig: undefined }));

    expect(mockedGenerateText).toHaveBeenCalledTimes(2); // attempt + the one retry
    expect(out.notice).toBe(UNDELIVERABLE_NOTICE);
    expect(createModel).not.toHaveBeenCalled();
  });

  it("reports the last attempt's usage so a 3-generation turn is not under-billed", async () => {
    mockedGenerateText
      .mockResolvedValueOnce({ text: "", usage: { totalTokens: 1 } } as never)
      .mockResolvedValueOnce({ text: "", usage: { totalTokens: 2 } } as never)
      .mockResolvedValueOnce({ text: "done", usage: { totalTokens: 7 } } as never);

    const out = await generateFinalAnswerWithFailover(args());
    expect(out.usage).toEqual({ totalTokens: 7 });
  });

  it("PM #109 — caps the forced answer's output tokens (a 15KB markup blob cannot form)", async () => {
    mockedGenerateText.mockResolvedValueOnce({ text: "ok" } as never);
    await generateFinalAnswerWithFailover(args());
    const passed = (mockedGenerateText.mock.calls[0][0] as { maxOutputTokens?: number })
      .maxOutputTokens;
    expect(passed).toBeLessThanOrEqual(1500);
  });

  it("PM #109 — runs the forced answer at a BOUNDED context, pinning the original task", async () => {
    // A transcript far over budget: the original task first, a huge tool result
    // in the middle (the imitation fodder), the 'write your answer' instruction
    // last. The bounded context must keep the task + instruction and shed the
    // middle, so the model never sees the full 68K that collapsed the channel.
    const big = "y".repeat(200_000);
    const out = await (async () => {
      mockedGenerateText.mockResolvedValueOnce({ text: "recovered" } as never);
      return generateFinalAnswerWithFailover(
        args({
          messages: [
            { role: "user", content: "THE ORIGINAL TASK: rewrite performanceMonitor.ts" },
            { role: "assistant", content: `here is a huge file dump ${big}` },
            { role: "user", content: "Write your final answer now, in plain prose." },
          ],
        })
      );
    })();
    expect(out.text).toBe("recovered");
    const sent = (mockedGenerateText.mock.calls[0][0] as { messages: Array<{ content: unknown }> })
      .messages;
    const flat = JSON.stringify(sent);
    expect(flat).toContain("THE ORIGINAL TASK"); // pinned
    expect(flat).toContain("Write your final answer now"); // instruction survives (last)
    expect(flat).not.toContain(big); // the giant middle is gone
  });

  it("PM #109 — a SMALL transcript is passed through untouched", async () => {
    mockedGenerateText.mockResolvedValueOnce({ text: "ok" } as never);
    const small = [
      { role: "user" as const, content: "small task" },
      { role: "user" as const, content: "answer now" },
    ];
    await generateFinalAnswerWithFailover(args({ messages: small }));
    const sent = (mockedGenerateText.mock.calls[0][0] as { messages: unknown }).messages;
    expect(sent).toEqual(small);
  });
});

describe("buildFinalAnswerPool", () => {
  it("draws ONLY from operator settings (so Privacy Mode's air-gap holds)", () => {
    const s = settings();
    s.proposerTiers = {
      frontier: { provider: "openrouter", model: "tier/frontier" },
      balanced: undefined,
      fast: { provider: "openrouter", model: "tier/fast" },
    };
    const pool = buildFinalAnswerPool(s);
    expect(pool.map((c) => c.model)).toEqual([UTILITY.model, "tier/frontier", "tier/fast"]);
  });

  it("drops slots with no model id", () => {
    const s = settings();
    s.utilityModel = { provider: "openrouter", model: "" } as ModelConfig;
    expect(buildFinalAnswerPool(s)).toHaveLength(0);
  });

  // The pool used to hand back the raw settings slots. Those are routinely
  // stored as `{ provider, model }` with no key — Free Mode's overlay writes
  // exactly that shape — so `createModel(substitute)` threw "API Key is
  // missing" for anyone whose key lives in the vault instead of the
  // environment. It is caught, so nothing crashed: the failover simply never
  // substituted, which is the one thing it exists to do.
  it("resolves each candidate's key from the vault, so a substitution can actually authenticate", () => {
    const s = settings();
    s.providerApiKeys = { openrouter: "vault-key-123" };
    s.utilityModel = { provider: "openrouter", model: "util/model" };
    s.proposerTiers = {
      frontier: { provider: "openrouter", model: "tier/frontier" },
      balanced: undefined,
      fast: undefined,
    };

    expect(buildFinalAnswerPool(s).map((c) => c.apiKey)).toEqual([
      "vault-key-123",
      "vault-key-123",
    ]);
  });

  it("does not overwrite a key a slot already carries", () => {
    const s = settings();
    s.providerApiKeys = { openrouter: "vault-key-123" };
    s.utilityModel = { provider: "openrouter", model: "util/model", apiKey: "slot-key" };
    s.proposerTiers = { frontier: undefined, balanced: undefined, fast: undefined };

    expect(buildFinalAnswerPool(s)[0].apiKey).toBe("slot-key");
  });
});

/**
 * PM #119 — live incident, 2026-08-31: a substitute told (unconditionally)
 * "you have everything you need from the steps above, write your final
 * answer" fabricated a fully detailed completed-task report — specific file
 * edits, specific test output — for a turn where ZERO tool calls had
 * actually run. Council-reviewed (4take) fix: the instruction must be
 * conditional on whether real tool activity happened THIS turn, and the
 * failure-case wording must be an exact required string with no "what's
 * still needed" slot (independently flagged by two reviewers as itself
 * inviting a second layer of fabrication).
 */
describe("finalAnswerInstruction (PM #119 — anti-fabrication)", () => {
  it("didWork=true keeps PM #69's original 'steps above' framing", () => {
    const text = finalAnswerInstruction(true);
    expect(text).toContain("You have everything you need from the steps above");
    expect(text).toContain("Do not call any tools");
  });

  it("didWork=false forbids claiming any action, with an exact required failure string", () => {
    const text = finalAnswerInstruction(false);
    expect(text).toContain("You have NOT performed any actions this turn");
    expect(text).toContain(
      "I could not complete this — a technical failure occurred before any work was done."
    );
    expect(text).toContain("Do not call any tools");
  });

  it("didWork=false never invites the model to invent next steps", () => {
    const text = finalAnswerInstruction(false).toLowerCase();
    // The exact clause the live incident's fabrication resembled — asking the
    // model to name what's left invites the same kind of confident invention
    // that produced the original fake completion report.
    expect(text).not.toContain("still needed");
    expect(text).not.toContain("what's needed");
    expect(text).not.toContain("what is needed");
  });
});

describe("cascade through the substitute pool (PM #113)", () => {
  const FRONTIER: ModelConfig = { provider: "openrouter", model: "vendor/frontier:free", apiKey: "k" };
  const BALANCED: ModelConfig = { provider: "openrouter", model: "vendor/balanced:free", apiKey: "k" };
  const FAST: ModelConfig = { provider: "openrouter", model: "vendor/fast:free", apiKey: "k" };

  function multiPoolSettings(): AppSettings {
    const s = settings();
    s.proposerTiers = { frontier: { ...FRONTIER }, balanced: { ...BALANCED }, fast: { ...FAST } };
    return s;
  }

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.ORCHESTRA_FALLBACK_CASCADE_BUDGET_MS;
    // Some tests below override the base createModel mock's implementation.
    vi.mocked(createModel).mockImplementation(((cfg: { model: string }) => ({ __model: cfg.model })) as never);
  });

  it("cascades to a 2nd substitute after the 1st stays empty", async () => {
    mockedGenerateText
      .mockResolvedValueOnce({ text: "" } as never) // brain
      .mockResolvedValueOnce({ text: "" } as never) // brain retry
      .mockResolvedValueOnce({ text: "" } as never) // 1st substitute (utility) — empty
      .mockResolvedValueOnce({ text: "from frontier" } as never); // 2nd substitute — succeeds

    const out = await generateFinalAnswerWithFailover(args({ settings: multiPoolSettings() }));

    expect(out.text).toBe("from frontier");
    // The brain's two calls go through `args.model` (the "brain-handle" test
    // double), not `createModel` — only substitutes are built via createModel.
    expect(calledModels()).toEqual(["brain-handle", "brain-handle", UTILITY.model, FRONTIER.model]);
    expect(out.notice).toContain(FRONTIER.model);
  });

  it("cascades through a 3rd substitute when the first two stay empty", async () => {
    mockedGenerateText
      .mockResolvedValueOnce({ text: "" } as never) // brain
      .mockResolvedValueOnce({ text: "" } as never) // brain retry
      .mockResolvedValueOnce({ text: "" } as never) // utility
      .mockResolvedValueOnce({ text: "" } as never) // frontier
      .mockResolvedValueOnce({ text: "from balanced" } as never); // balanced — succeeds

    const out = await generateFinalAnswerWithFailover(args({ settings: multiPoolSettings() }));

    expect(out.text).toBe("from balanced");
    expect(out.notice).toContain(BALANCED.model);
  });

  it("stops at the FIRST success — a multi-candidate pool does not over-try", async () => {
    mockedGenerateText
      .mockResolvedValueOnce({ text: "" } as never) // brain
      .mockResolvedValueOnce({ text: "" } as never) // brain retry
      .mockResolvedValueOnce({ text: "from utility" } as never); // 1st substitute — succeeds

    const out = await generateFinalAnswerWithFailover(args({ settings: multiPoolSettings() }));

    expect(out.text).toBe("from utility");
    expect(mockedGenerateText).toHaveBeenCalledTimes(3); // never reaches frontier/balanced/fast
  });

  it("exhausts the whole pool and reports undeliverable when every candidate stays empty", async () => {
    mockedGenerateText.mockResolvedValue({ text: "" } as never);

    const out = await generateFinalAnswerWithFailover(args({ settings: multiPoolSettings() }));

    expect(out.text).toBe("");
    // brain + retry + 4 distinct pool candidates (utility, frontier, balanced, fast).
    expect(mockedGenerateText).toHaveBeenCalledTimes(6);
    expect(out.notice).toBe(UNDELIVERABLE_NOTICE);
  });

  it("dedups an identical candidate instead of trying the same endpoint twice", async () => {
    const s = multiPoolSettings();
    // frontier happens to be the same endpoint as utility.
    s.proposerTiers!.frontier = { ...UTILITY };
    mockedGenerateText
      .mockResolvedValueOnce({ text: "" } as never) // brain
      .mockResolvedValueOnce({ text: "" } as never) // brain retry
      .mockResolvedValueOnce({ text: "" } as never) // utility (== frontier, tried once)
      .mockResolvedValueOnce({ text: "from balanced" } as never); // balanced

    const out = await generateFinalAnswerWithFailover(args({ settings: s }));

    expect(out.text).toBe("from balanced");
    // If the dedup were missing this would be 5 (utility tried twice).
    expect(mockedGenerateText).toHaveBeenCalledTimes(4);
  });

  it("skips a circuit-open candidate without spending a generateText call on it", async () => {
    for (let i = 0; i < 3; i++) recordModelFailure(UTILITY.provider, UTILITY.model, "empty");
    expect(isModelCircuitOpen(UTILITY.provider, UTILITY.model)).toBe(true);

    mockedGenerateText.mockResolvedValueOnce({ text: "from frontier" } as never);

    const out = await generateFinalAnswerWithFailover(
      args({ settings: multiPoolSettings(), skipBrainRetry: true })
    );

    expect(out.text).toBe("from frontier");
    // Utility (tripped) is skipped entirely — frontier is the ONLY call.
    expect(calledModels()).toEqual([FRONTIER.model]);
  });

  // Post-review (protake council, 2026-08-31) — this branch used to return
  // silently. Live tonight it was indistinguishable in the logs from "policy
  // forbade substitution" (which DOES log) and cost real time to disambiguate
  // during a broad free-tier outage.
  it("logs when every candidate's circuit is open, naming them", async () => {
    for (let i = 0; i < 3; i++) recordModelFailure(UTILITY.provider, UTILITY.model, "empty");
    for (let i = 0; i < 3; i++) recordModelFailure(FRONTIER.provider, FRONTIER.model, "empty");
    for (let i = 0; i < 3; i++) recordModelFailure(BALANCED.provider, BALANCED.model, "empty");
    for (let i = 0; i < 3; i++) recordModelFailure(FAST.provider, FAST.model, "empty");

    const out = await generateFinalAnswerWithFailover(
      args({ settings: multiPoolSettings(), skipBrainRetry: true })
    );

    expect(out.text).toBe("");
    expect(mockedGenerateText).not.toHaveBeenCalled(); // brain retry skipped, no candidate attempted
    const warnCalls = vi.mocked(console.warn).mock.calls.map((c) => String(c[0]));
    expect(warnCalls.some((line) => line.includes(UTILITY.model) && line.includes("circuit is OPEN"))).toBe(true);
  });

  // 4take council review, 2026-08-31 — live-measured on the real catalogue:
  // `utilityModel` sat at index 0 (tried FIRST) despite being the WEAKEST of
  // the four candidates (intelligence 25.7 vs. 41-45 for the proposer tiers),
  // because it's drawn from a different, narrower pool (`structured_outputs`
  // capable ids only) that was never reconciled against the general pool's
  // scores when `buildFinalAnswerPool` assembled the flat 4-slot array.
  it("tries the STRONGEST candidate first, not whichever settings slot happens to be listed first", async () => {
    __setOpenRouterBenchmarkScoreForTest(
      new Map([
        [UTILITY.model, { intelligence: 25.7, agentic: 0, coding: 0 }], // weakest — but listed FIRST in buildFinalAnswerPool
        [FRONTIER.model, { intelligence: 45.4, agentic: 0, coding: 0 }], // strongest
        [BALANCED.model, { intelligence: 42.3, agentic: 0, coding: 0 }],
        [FAST.model, { intelligence: 41.2, agentic: 0, coding: 0 }],
      ])
    );
    try {
      mockedGenerateText.mockResolvedValueOnce({ text: "from strongest" } as never);

      const out = await generateFinalAnswerWithFailover(
        args({ settings: multiPoolSettings(), skipBrainRetry: true })
      );

      expect(out.text).toBe("from strongest");
      // If ordering were still slot-order (not score-order), this would have
      // called UTILITY.model first instead.
      expect(calledModels()).toEqual([FRONTIER.model]);
    } finally {
      __resetOpenRouterPricingForTests();
    }
  });

  // Live incident, 2026-08-31 — a cascade that visibly tried ONE candidate
  // then stopped was indistinguishable from 2-3 candidates silently
  // returning empty text in between: only the THROWN-exception branch of
  // `attemptOnce` logged. This closes that gap.
  it("logs an empty-response attempt (not just a thrown one), naming the finishReason", async () => {
    // Unscored fixtures (no benchmark data seeded in this describe block) keep
    // the stable assembly order: UTILITY is tried first, FRONTIER second.
    mockedGenerateText.mockResolvedValueOnce({ text: "", finishReason: "content-filter" } as never);
    mockedGenerateText.mockResolvedValueOnce({ text: "from frontier" } as never);

    const out = await generateFinalAnswerWithFailover(
      args({ settings: multiPoolSettings(), skipBrainRetry: true })
    );

    expect(out.text).toBe("from frontier");
    const warnCalls = vi.mocked(console.warn).mock.calls.map((c) => String(c[0]));
    expect(
      warnCalls.some(
        (line) => line.includes(UTILITY.model) && line.includes("empty response") && line.includes("content-filter")
      )
    ).toBe(true);
  });

  it("a createModel throw for one candidate skips to the next, not the whole cascade", async () => {
    vi.mocked(createModel).mockImplementation(((cfg: { model: string }) => {
      if (cfg.model === UTILITY.model) throw new Error("API Key is missing");
      return { __model: cfg.model };
    }) as never);
    mockedGenerateText.mockResolvedValueOnce({ text: "from frontier" } as never);

    const out = await generateFinalAnswerWithFailover(
      args({ settings: multiPoolSettings(), skipBrainRetry: true })
    );

    expect(out.text).toBe("from frontier");
    expect(calledModels()).toEqual([FRONTIER.model]);
  });

  it("the aggregate cascade budget stops STARTING a new attempt once exceeded", async () => {
    vi.useFakeTimers();
    process.env.ORCHESTRA_FALLBACK_CASCADE_BUDGET_MS = "1000";
    mockedGenerateText.mockImplementation((async () => {
      // Simulate the first substitute attempt itself taking longer than the
      // budget — the NEXT loop iteration's check must see it as exceeded.
      vi.advanceTimersByTime(2000);
      return { text: "" };
    }) as never);

    const out = await generateFinalAnswerWithFailover(
      args({ settings: multiPoolSettings(), skipBrainRetry: true })
    );

    expect(out.text).toBe("");
    // Only the first substitute was even attempted — budget exceeded before a
    // second one could start, even though 3 more candidates remained.
    expect(mockedGenerateText).toHaveBeenCalledTimes(1);
    // PM #123 — this used to be a silent break. Now it names what got skipped.
    const warnCalls = vi.mocked(console.warn).mock.calls.map((c) => String(c[0]));
    expect(warnCalls.some((m) => m.includes("cascade budget") && m.includes("NOT trying 3 remaining"))).toBe(
      true
    );
  });

  it("PM #123 — the default budget survives one full-length (~120s) slow candidate and still tries a second", async () => {
    // Live incident, 2026-09-02: brain failed fast, the FIRST substitute hung
    // for its own full ~120s call-deadline, and the (old, 90s) cascade budget
    // was ALREADY exceeded before a second, perfectly healthy candidate could
    // even be attempted. This pins the fix: with no env override (the real
    // default), a single 120s-long attempt must not exhaust the budget.
    delete process.env.ORCHESTRA_FALLBACK_CASCADE_BUDGET_MS;
    vi.useFakeTimers();
    let call = 0;
    mockedGenerateText.mockImplementation((async () => {
      call += 1;
      if (call === 1) {
        vi.advanceTimersByTime(120_000); // the slow candidate's own call-deadline
        return { text: "" };
      }
      return { text: "from the second candidate" };
    }) as never);

    const out = await generateFinalAnswerWithFailover(
      args({ settings: multiPoolSettings(), skipBrainRetry: true })
    );

    expect(mockedGenerateText).toHaveBeenCalledTimes(2);
    expect(out.text).toBe("from the second candidate");
  });
});

describe("degradation policy (Sprint 4)", () => {
  it("quality mode does NOT substitute — it reports honestly instead", async () => {
    mockedGenerateText.mockResolvedValue({ text: "" } as never);

    const out = await generateFinalAnswerWithFailover(args({ degradationPolicy: "quality" }));

    expect(out.text).toBe("");
    // Brain twice, and then a STOP — the healthy substitute is never dialled.
    expect(mockedGenerateText).toHaveBeenCalledTimes(2);
    expect(createModel).not.toHaveBeenCalled();
    expect(out.notice).toMatch(/quality mode/i);
    expect(out.notice).toContain(BRAIN.model);
  });

  it("ask mode does NOT substitute either — it offers the choice for the next turn", async () => {
    mockedGenerateText.mockResolvedValue({ text: "" } as never);

    const out = await generateFinalAnswerWithFailover(args({ degradationPolicy: "ask" }));

    expect(mockedGenerateText).toHaveBeenCalledTimes(2);
    expect(createModel).not.toHaveBeenCalled();
    expect(out.notice).toMatch(/speed/);
  });

  it("speed mode (the default) substitutes", async () => {
    mockedGenerateText
      .mockResolvedValueOnce({ text: "" } as never)
      .mockResolvedValueOnce({ text: "" } as never)
      .mockResolvedValueOnce({ text: "substitute answer" } as never);

    const out = await generateFinalAnswerWithFailover(args({ degradationPolicy: "speed" }));

    expect(out.text).toBe("substitute answer");
    expect(createModel).toHaveBeenCalled();
  });

  it("quality mode still RETRIES the user's own model — it only forbids swapping", async () => {
    mockedGenerateText
      .mockResolvedValueOnce({ text: "" } as never)
      .mockResolvedValueOnce({ text: "recovered on retry" } as never);

    const out = await generateFinalAnswerWithFailover(args({ degradationPolicy: "quality" }));

    expect(out.text).toBe("recovered on retry");
    expect(out.notice).toBeUndefined();
  });
});

// Tool-capable-retry work — extracted from an inline `.sort()` comparator so
// `tool-capable-retry.ts`'s own candidate selection shares this exact
// ordering instead of a second, driftable copy.
describe("compareModelsByBenchmarkScoreDesc", () => {
  beforeEach(() => __resetOpenRouterPricingForTests());

  const m = (model: string): ModelConfig => ({ provider: "openrouter", model });

  it("orders by intelligence, strongest first", () => {
    __setOpenRouterBenchmarkScoreForTest(
      new Map([
        ["a", { intelligence: 20, coding: 0, agentic: 0 }],
        ["b", { intelligence: 80, coding: 0, agentic: 0 }],
      ])
    );
    expect([m("a"), m("b")].sort(compareModelsByBenchmarkScoreDesc)).toEqual([m("b"), m("a")]);
  });

  it("ties on intelligence tie-break on agentic, then coding", () => {
    __setOpenRouterBenchmarkScoreForTest(
      new Map([
        ["a", { intelligence: 50, coding: 90, agentic: 10 }],
        ["b", { intelligence: 50, coding: 10, agentic: 90 }],
      ])
    );
    expect([m("a"), m("b")].sort(compareModelsByBenchmarkScoreDesc)).toEqual([m("b"), m("a")]);
  });

  it("an unscored id sorts after a scored one", () => {
    __setOpenRouterBenchmarkScoreForTest(new Map([["scored", { intelligence: 1, coding: 1, agentic: 1 }]]));
    expect([m("unscored"), m("scored")].sort(compareModelsByBenchmarkScoreDesc)).toEqual([
      m("scored"),
      m("unscored"),
    ]);
  });

  it("stable (returns 0) when neither side has score data", () => {
    expect(compareModelsByBenchmarkScoreDesc(m("x"), m("y"))).toBe(0);
  });
});

/**
 * PM #132 — this ladder is tool-less but is handed the FULL tool-capable system
 * prompt, which mandates tool use ("you MUST prioritize the `search_web` tool
 * heavily"). The only counter-instruction used to be one line in a user message,
 * which the system prompt outranks: a substitute printed three
 * `<function=search_web>` blocks as text and they were shipped to the user.
 */
describe("generateFinalAnswerWithFailover — tool-less system-prompt override", () => {
  function systemsSent(): string[] {
    return mockedGenerateText.mock.calls.map((c) => (c[0] as { system: string }).system);
  }

  it("countermands the tool-capable system prompt on the brain attempt", async () => {
    mockedGenerateText.mockResolvedValueOnce({ text: "answer", usage: undefined } as never);

    await generateFinalAnswerWithFailover(args({ systemPrompt: "You MUST use search_web." }));

    const [sent] = systemsSent();
    expect(sent).toContain("You MUST use search_web."); // caller's prompt is preserved…
    expect(sent).toContain(FORCED_ANSWER_TOOL_OVERRIDE); // …and then overridden
    // The override must be LAST — a countermand that the mandate follows is not
    // a countermand.
    expect(sent.endsWith(FORCED_ANSWER_TOOL_OVERRIDE)).toBe(true);
  });

  it("applies to every attempt, substitutes included — not just the first", async () => {
    mockedGenerateText
      .mockResolvedValueOnce({ text: "", usage: undefined } as never) // brain
      .mockResolvedValueOnce({ text: "", usage: undefined } as never) // brain retry
      .mockResolvedValueOnce({ text: "substitute answer", usage: undefined } as never);

    await generateFinalAnswerWithFailover(args({ settings: settings() }));

    const sent = systemsSent();
    expect(sent.length).toBeGreaterThanOrEqual(3);
    for (const s of sent) expect(s).toContain(FORCED_ANSWER_TOOL_OVERRIDE);
  });

  it("reports WHICH endpoint produced the text — the brain when the brain answered", async () => {
    mockedGenerateText.mockResolvedValueOnce({ text: "answer", usage: undefined } as never);

    const out = await generateFinalAnswerWithFailover(args());

    expect(out.endpoint).toEqual(BRAIN);
  });

  it("reports the SUBSTITUTE when a substitute answered (usage must not be billed to the brain)", async () => {
    mockedGenerateText
      .mockResolvedValueOnce({ text: "", usage: undefined } as never)
      .mockResolvedValueOnce({ text: "", usage: undefined } as never)
      .mockResolvedValueOnce({ text: "substitute answer", usage: undefined } as never);

    const out = await generateFinalAnswerWithFailover(args());

    expect(out.text).toBe("substitute answer");
    expect(out.endpoint?.model).toBe(UTILITY.model);
    expect(out.endpoint?.model).not.toBe(BRAIN.model);
  });

  it("reports no endpoint when nothing was delivered", async () => {
    mockedGenerateText.mockResolvedValue({ text: "", usage: undefined } as never);

    const out = await generateFinalAnswerWithFailover(args());

    expect(out.text).toBe("");
    expect(out.endpoint).toBeUndefined();
  });
});

/**
 * PM #134 — printed tool markup is a FAILURE, not a delivery.
 *
 * The live defect (2026-09-07, chat 560896d7): `attemptOnce` accepted any
 * non-empty string as an answer, so 289 chars of printed `call_mcp_tool` ended
 * the ladder at the brain — the four healthy substitutes were never tried — and
 * `recordModelSuccess` then wiped the breaker of the endpoint that had just
 * failed.
 *
 * Fixtures are REAL captured bytes from two live dialects, not hand-written
 * markup: degraded output is mangled in ways a synthetic fixture never is.
 */
describe("printed tool markup is not a delivery (PM #134)", () => {
  const FRONTIER: ModelConfig = { provider: "openrouter", model: "vendor/frontier:free", apiKey: "k" };
  const BALANCED: ModelConfig = { provider: "openrouter", model: "vendor/balanced:free", apiKey: "k" };

  /** Real bytes, chat 560896d7 message[1] — the Functionary dialect, prose-prefixed. */
  const LIVE_FUNCTIONARY_MARKUP =
    "I'll search for recent interesting GitHub projects and trends from the last month.\n" +
    "<function=search_web>\n<parameter=query>\n" +
    "GitHub trending repositories last month 2026 interesting projects ideas\n" +
    "</parameter>\n</function>";

  /** Real bytes, chat 9891bb43 — the dots dialect, `<invoke name=…>` inside a wrapper. */
  const LIVE_DOTS_MARKUP =
    '<dots_function_call>\n<invoke name="write_text_file">\n' +
    '<parameter name="file_path">\n/tmp/x.ts\n</parameter>\n</invoke>\n</dots_function_call>';

  function multiPoolSettings(): AppSettings {
    const s = settings();
    s.proposerTiers = { frontier: { ...FRONTIER }, balanced: { ...BALANCED } };
    return s;
  }

  it("does NOT accept markup as the answer, and does NOT heal the endpoint's breaker", async () => {
    mockedGenerateText
      .mockResolvedValueOnce({ text: LIVE_FUNCTIONARY_MARKUP } as never) // brain
      .mockResolvedValue({ text: "" } as never); // every substitute stays empty

    recordModelFailure(BRAIN.provider, BRAIN.model, "empty");
    recordModelFailure(BRAIN.provider, BRAIN.model, "empty");
    const out = await generateFinalAnswerWithFailover(args({ settings: multiPoolSettings() }));

    // The markup is never returned as text...
    expect(out.text).toBe("");
    expect(out.text).not.toContain("<function=");
    // ...the endpoint was NOT healed (a success here would have reset the two
    // failures above to zero — the D2 half of the defect)...
    const entry = getModelHealthEntry(BRAIN.provider, BRAIN.model);
    expect(entry?.totalSuccesses).toBe(0);
    expect(entry?.consecutiveFailures).toBeGreaterThanOrEqual(3);
    // ...and it was recorded as markup, not as some other kind.
    expect(entry?.markupFailures).toBe(1);
    expect(entry?.lastFailureKind).toBe("markup");
  });

  it("keeps cascading: a substitute's clean prose wins over the brain's markup", async () => {
    mockedGenerateText
      .mockResolvedValueOnce({ text: LIVE_DOTS_MARKUP } as never) // brain prints markup
      .mockResolvedValueOnce({ text: "" } as never) // utility — empty
      .mockResolvedValueOnce({ text: "a real answer" } as never); // frontier — delivers

    const out = await generateFinalAnswerWithFailover(args({ settings: multiPoolSettings() }));

    expect(out.text).toBe("a real answer");
    expect(out.endpoint).toEqual(FRONTIER);
    expect(out.markupDegradation).toBeUndefined(); // a delivery is not a degradation
  });

  it("SKIPS the same-endpoint retry after markup — the retry would re-send the same context", async () => {
    mockedGenerateText
      .mockResolvedValueOnce({ text: LIVE_FUNCTIONARY_MARKUP } as never) // brain, attempt 1
      .mockResolvedValueOnce({ text: "from utility" } as never); // straight to the substitute

    const out = await generateFinalAnswerWithFailover(args({ settings: multiPoolSettings() }));

    expect(out.text).toBe("from utility");
    // "brain-handle" appears ONCE — attempt 2 on the same endpoint never ran.
    expect(calledModels()).toEqual(["brain-handle", UTILITY.model]);
  });

  it("an empty brain still GETS its retry — the skip is markup-specific, not a blanket change", async () => {
    mockedGenerateText
      .mockResolvedValueOnce({ text: "" } as never) // brain
      .mockResolvedValueOnce({ text: "second time lucky" } as never); // brain retry

    const out = await generateFinalAnswerWithFailover(args({ settings: multiPoolSettings() }));

    expect(out.text).toBe("second time lucky");
    expect(calledModels()).toEqual(["brain-handle", "brain-handle"]);
  });

  it("reports the TRIGGERING markup when the whole cascade degrades — first wins, not last", async () => {
    // Council review 2026-09-07: last-wins misattributes both consumers. The
    // brain's markup is the causal answer to "why did failover run?", and it is
    // the brain's context that PM #82's compaction backstop must act on.
    mockedGenerateText
      .mockResolvedValueOnce({ text: LIVE_DOTS_MARKUP } as never) // brain — write_text_file
      .mockResolvedValue({ text: LIVE_FUNCTIONARY_MARKUP } as never); // substitutes — search_web

    const out = await generateFinalAnswerWithFailover(args({ settings: multiPoolSettings() }));

    expect(out.text).toBe("");
    expect(out.markupDegradation?.toolName).toBe("write_text_file"); // the brain's, not search_web
    expect(out.markupDegradation?.endpoint).toEqual(BRAIN);
    expect(out.markupDegradation?.markupChars).toBe(LIVE_DOTS_MARKUP.length);
  });

  it("still reports the degradation when the caller supplied no brainConfig", async () => {
    mockedGenerateText.mockResolvedValueOnce({ text: LIVE_FUNCTIONARY_MARKUP } as never);

    const out = await generateFinalAnswerWithFailover(args({ brainConfig: undefined }));

    // Without an endpoint there is nothing to quarantine, but the SIGNAL must
    // survive: tying it to knowing the endpoint dropped the honest notice
    // entirely and shipped an empty turn.
    expect(out.markupDegradation?.toolName).toBe("search_web");
    expect(out.markupDegradation?.endpoint).toBeUndefined();
  });

  it("a printed `response` call is the ANSWER, not a degradation — must not regress", async () => {
    mockedGenerateText.mockResolvedValueOnce({
      text: '<tool_call>{"name":"response","arguments":{"message":"here is the real answer"}}</tool_call>',
    } as never);

    const out = await generateFinalAnswerWithFailover(args());

    // Delivered on the first attempt, no cascade, endpoint healed.
    expect(out.text).toContain("here is the real answer");
    expect(out.markupDegradation).toBeUndefined();
    expect(getModelHealthEntry(BRAIN.provider, BRAIN.model)?.totalSuccesses).toBe(1);
  });

  it("prose that merely MENTIONS tool markup is delivered untouched", async () => {
    const prose =
      "The model emitted a `<tool_call>` block as text instead of calling the tool. " +
      "That is the bug you are seeing; nothing was executed.";
    mockedGenerateText.mockResolvedValueOnce({ text: prose } as never);

    const out = await generateFinalAnswerWithFailover(args());

    expect(out.text).toBe(prose);
    expect(out.markupDegradation).toBeUndefined();
  });

  it("a throttled cascade records throttle, not markup, against each substitute", async () => {
    // kimi council review — the cascade now actually runs, so substitutes start
    // accruing failures they never got before. That is correct, but it must be
    // the RIGHT kind: a 429 is availability, not degradation.
    mockedGenerateText
      .mockResolvedValueOnce({ text: LIVE_FUNCTIONARY_MARKUP } as never) // brain
      .mockRejectedValue(Object.assign(new Error("Rate limit exceeded"), { statusCode: 429 }));

    const out = await generateFinalAnswerWithFailover(args({ settings: multiPoolSettings() }));

    expect(out.text).toBe("");
    for (const c of [UTILITY, FRONTIER, BALANCED]) {
      expect(getModelHealthEntry(c.provider, c.model)?.lastFailureKind).toBe("throttle");
      expect(getModelHealthEntry(c.provider, c.model)?.markupFailures).toBe(0);
    }
  });
});

/**
 * PM #134 — the markup cascade runs on its own, SHORTER budget.
 *
 * Before PM #134 the cascade was practically unreachable, so its 300s budget
 * was paid on a rare path. Markup is common on free models, so the same 300s
 * now lands on a routine interactive turn. 90s is deliberately the number
 * PM #123 raised FROM — it is only safe because the per-attempt deadline is
 * tightened with it; the two are a pair.
 */
describe("markup cascade budget (PM #134)", () => {
  const FRONTIER: ModelConfig = { provider: "openrouter", model: "vendor/frontier:free", apiKey: "k" };
  const BALANCED: ModelConfig = { provider: "openrouter", model: "vendor/balanced:free", apiKey: "k" };

  const MARKUP = "<function=search_web>\n<parameter=query>\nx\n</parameter>\n</function>";

  function multiPoolSettings(): AppSettings {
    const s = settings();
    s.proposerTiers = { frontier: { ...FRONTIER }, balanced: { ...BALANCED } };
    return s;
  }

  /** The per-attempt deadline each `generateText` call was actually handed. */
  function attemptDeadlines(): number[] {
    return mockedGenerateText.mock.calls.map((c) => {
      const sig = (c[0] as { abortSignal?: AbortSignal }).abortSignal;
      // `AbortSignal.timeout(ms)` is opaque, so read the shape the ladder built
      // rather than the ms: what matters is that the SUBSTITUTE calls got a
      // different signal object than an unbounded one.
      return sig ? 1 : 0;
    });
  }

  afterEach(() => {
    delete process.env.ORCHESTRA_MARKUP_CASCADE_BUDGET_MS;
    delete process.env.ORCHESTRA_MARKUP_ATTEMPT_DEADLINE_MS;
    delete process.env.ORCHESTRA_FALLBACK_CASCADE_BUDGET_MS;
  });

  /** Everything `console.warn` was handed, flattened. */
  function warnings(): string {
    return vi.mocked(console.warn).mock.calls.map((c) => c.join(" ")).join("\n");
  }

  it("a markup trigger selects the SHORT budget and says so", async () => {
    process.env.ORCHESTRA_MARKUP_CASCADE_BUDGET_MS = "90000";
    process.env.ORCHESTRA_FALLBACK_CASCADE_BUDGET_MS = "300000";
    mockedGenerateText.mockResolvedValue({ text: MARKUP } as never);

    await generateFinalAnswerWithFailover(args({ settings: multiPoolSettings() }));

    expect(warnings()).toContain("cascade triggered by PRINTED MARKUP");
    expect(warnings()).toContain("90000ms aggregate");
  });

  it("an EMPTY brain does NOT get the short budget — it is markup-only", async () => {
    process.env.ORCHESTRA_MARKUP_CASCADE_BUDGET_MS = "90000";
    mockedGenerateText
      .mockResolvedValueOnce({ text: "" } as never) // brain
      .mockResolvedValueOnce({ text: "" } as never) // brain retry
      .mockResolvedValueOnce({ text: "from utility" } as never);

    const out = await generateFinalAnswerWithFailover(args({ settings: multiPoolSettings() }));

    expect(out.text).toBe("from utility");
    expect(warnings()).not.toContain("PRINTED MARKUP");
    expect(calledModels()).toEqual(["brain-handle", "brain-handle", UTILITY.model]);
  });

  it("the short budget actually TRUNCATES the cascade — untried candidates are named", async () => {
    // Real elapsed time, not fake timers: a 1ms budget plus a substitute that
    // takes ~20ms means the SECOND substitute is never started.
    process.env.ORCHESTRA_MARKUP_CASCADE_BUDGET_MS = "1";
    mockedGenerateText
      .mockResolvedValueOnce({ text: MARKUP } as never) // brain prints markup
      .mockImplementationOnce(
        () => new Promise((r) => setTimeout(() => r({ text: "" } as never), 20)) as never
      );

    const out = await generateFinalAnswerWithFailover(args({ settings: multiPoolSettings() }));

    expect(out.text).toBe("");
    expect(calledModels()).toEqual(["brain-handle", UTILITY.model]); // stopped after one
    // PM #123's rule: a truncated cascade must NAME what it skipped.
    expect(warnings()).toContain("cascade budget (1ms) exceeded");
    expect(warnings()).toContain(FRONTIER.model);
  });

  it("PM #123 guard — the per-attempt deadline stays BELOW the aggregate budget", () => {
    // The pair, asserted as a pair. A 90s aggregate smaller than one
    // candidate's own deadline is exactly the defect PM #123 fixed: a single
    // hung candidate eats the budget and the untried healthy ones are dropped.
    // Read through the same env indirection the code uses, so an operator
    // override that breaks the invariant is caught here too.
    const budget = Number(process.env.ORCHESTRA_MARKUP_CASCADE_BUDGET_MS ?? 90_000);
    const perAttempt = Number(process.env.ORCHESTRA_MARKUP_ATTEMPT_DEADLINE_MS ?? 30_000);
    expect(perAttempt).toBeLessThan(budget);
    // Room for the whole pool minus the brain, not just one attempt.
    expect(Math.floor(budget / perAttempt)).toBeGreaterThanOrEqual(3);
  });

  it("every substitute in a markup cascade is called WITH a bounded signal", async () => {
    mockedGenerateText
      .mockResolvedValueOnce({ text: MARKUP } as never) // brain
      .mockResolvedValueOnce({ text: "rescued" } as never); // utility

    const out = await generateFinalAnswerWithFailover(args({ settings: multiPoolSettings() }));

    expect(out.text).toBe("rescued");
    expect(attemptDeadlines().every((d) => d === 1)).toBe(true);
  });
});

/**
 * PM #134, council review 2026-09-07 — the budget pair must hold at RUNTIME,
 * not only for the defaults a test happens to read.
 */
describe("markup budget config guards (PM #134)", () => {
  const MARKUP = "<function=search_web>\n<parameter=query>\nx\n</parameter>\n</function>";

  afterEach(() => {
    delete process.env.ORCHESTRA_MARKUP_CASCADE_BUDGET_MS;
    delete process.env.ORCHESTRA_MARKUP_ATTEMPT_DEADLINE_MS;
  });

  function warnings(): string {
    return vi.mocked(console.warn).mock.calls.map((c) => c.join(" ")).join("\n");
  }

  it("clamps a per-attempt deadline that would exceed the budget — PM #123 cannot be re-created by env", async () => {
    // The exact hostile config: one attempt allowed to outlive the whole budget.
    process.env.ORCHESTRA_MARKUP_CASCADE_BUDGET_MS = "90000";
    process.env.ORCHESTRA_MARKUP_ATTEMPT_DEADLINE_MS = "120000";
    mockedGenerateText.mockResolvedValue({ text: MARKUP } as never);

    await generateFinalAnswerWithFailover(args());

    // Clamped to a third of the budget, so the whole pool still fits.
    expect(warnings()).toContain("30000ms per attempt");
    expect(warnings()).not.toContain("120000ms per attempt");
  });

  it("an unparseable budget falls back to the default instead of disabling the bound", async () => {
    // `NaN > x` is false, so a garbage value would make the budget check never
    // fire — an UNBOUNDED cascade, the opposite of the intent.
    process.env.ORCHESTRA_MARKUP_CASCADE_BUDGET_MS = "not-a-number";
    mockedGenerateText.mockResolvedValue({ text: MARKUP } as never);

    await generateFinalAnswerWithFailover(args());

    expect(warnings()).toContain("90000ms aggregate");
  });
});

/**
 * PM #134 self-audit — the ladder must NAME the endpoint that actually printed
 * the markup even when the brain rungs never ran.
 */
describe("markup attribution when the brain is skipped (PM #134)", () => {
  const MARKUP = "<function=search_web>\n<parameter=query>\nx\n</parameter>\n</function>";

  it("attributes to the SUBSTITUTE when skipBrainRetry bypassed the brain", async () => {
    mockedGenerateText.mockResolvedValue({ text: MARKUP } as never);

    const out = await generateFinalAnswerWithFailover(args({ skipBrainRetry: true }));

    expect(out.text).toBe("");
    // First-wins, and the brain never ran — so the first markup is the utility
    // substitute's, and BRAIN must not be what the caller blames.
    expect(out.markupDegradation?.endpoint).toEqual(UTILITY);
    expect(out.markupDegradation?.endpoint).not.toEqual(BRAIN);
  });
});
