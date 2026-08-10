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
  UNDELIVERABLE_NOTICE,
} from "./final-answer-failover";
import { resetModelHealth, recordModelFailure, isModelCircuitOpen } from "./model-health";

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
