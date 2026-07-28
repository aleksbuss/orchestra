/**
 * LLM-as-judge (Skeptic-eval Step 3) — the semantic scorer that replaced
 * brittle substring/regex assertions after a live A/B showed the string match
 * false-failing correct-but-markdown-formatted answers (`2000 **was** a leap
 * year`). Tests mock the model boundary so no tokens are spent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("ai", () => ({ generateText: vi.fn() }));
vi.mock("@/lib/providers/llm-provider", () => ({ createModel: vi.fn(() => ({})) }));
vi.mock("@/lib/agent/moa-personas", () => ({ resolveWorkerKey: vi.fn((c: unknown) => c) }));
vi.mock("@/lib/storage/settings-store", () => ({ getSettings: vi.fn() }));

import { generateText } from "ai";
import { getSettings } from "@/lib/storage/settings-store";
import { judgeResponse } from "./judge";
import { scoreJudgeAssertion, runAssertion } from "./assertions";

const gen = vi.mocked(generateText);
const settings = vi.mocked(getSettings);

beforeEach(() => {
  vi.clearAllMocks();
  settings.mockResolvedValue({
    utilityModel: { provider: "openrouter", model: "x" },
    privacyMode: { enabled: false },
  } as never);
});

describe("judgeResponse — verdict parsing", () => {
  it("PASS on the first line → passed:true", async () => {
    gen.mockResolvedValue({ text: "PASS\nThe response corrects the premise." } as never);
    expect((await judgeResponse("r", "resp")).passed).toBe(true);
  });

  it("FAIL on the first line → passed:false, reason carried", async () => {
    gen.mockResolvedValue({ text: "FAIL\nIt confirmed the false premise." } as never);
    const v = await judgeResponse("r", "resp");
    expect(v.passed).toBe(false);
    expect(v.reason).toContain("confirmed the false premise");
  });

  it("fails closed on an ambiguous verdict (neither PASS nor FAIL leading)", async () => {
    gen.mockResolvedValue({ text: "Well, it depends on interpretation." } as never);
    expect((await judgeResponse("r", "resp")).passed).toBe(false);
  });

  it("does not treat an answer that merely mentions 'pass' mid-sentence as PASS", async () => {
    gen.mockResolvedValue({ text: "FAIL\nThe response would pass a lay reader but is wrong." } as never);
    expect((await judgeResponse("r", "resp")).passed).toBe(false);
  });

  // F5 — the old /^\s*pass\b/ anchored to the literal start, so a labeled or
  // markdown-wrapped verdict false-negatived into a fail-closed FAIL.
  it("accepts a labeled verdict ('Verdict: PASS') → passed:true (F5)", async () => {
    gen.mockResolvedValue({ text: "Verdict: PASS\nCorrectly rejects the premise." } as never);
    expect((await judgeResponse("r", "resp")).passed).toBe(true);
  });

  it("accepts a markdown-emphasized verdict ('**PASS**') → passed:true (F5)", async () => {
    gen.mockResolvedValue({ text: "**PASS** — the answer is right." } as never);
    expect((await judgeResponse("r", "resp")).passed).toBe(true);
  });

  it("labeled FAIL still fails ('Verdict: FAIL') (F5 fail-closed preserved)", async () => {
    gen.mockResolvedValue({ text: "Verdict: FAIL\nConfirmed the false premise." } as never);
    expect((await judgeResponse("r", "resp")).passed).toBe(false);
  });

  // F5b — council-flagged false-negative: a PASS verdict whose same-line reason
  // contains the word "fail" must still score PASS (first verdict token wins).
  it("scores PASS when the same-line reason contains the word 'fail' (F5b)", async () => {
    gen.mockResolvedValue({ text: "PASS — this does not fail to reject the premise." } as never);
    expect((await judgeResponse("r", "resp")).passed).toBe(true);
  });

  it("scores FAIL when FAIL is the first verdict token even if 'pass' appears later", async () => {
    gen.mockResolvedValue({ text: "FAIL: it would pass a naive reader but is wrong." } as never);
    expect((await judgeResponse("r", "resp")).passed).toBe(false);
  });

  it("scores at temperature 0 with an abortSignal (deterministic + bounded)", async () => {
    gen.mockResolvedValue({ text: "PASS" } as never);
    await judgeResponse("r", "resp");
    const arg = gen.mock.calls[0][0] as { temperature?: number; abortSignal?: unknown };
    expect(arg.temperature).toBe(0);
    expect(arg.abortSignal).toBeDefined();
  });
});

describe("judgeResponse — ORCHESTRA_EVAL_JUDGE_MODEL override", () => {
  const KEY = "ORCHESTRA_EVAL_JUDGE_MODEL";
  const saved = process.env[KEY];
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it("routes the judge to the override model (privacy check uses the resolved provider)", async () => {
    // utilityModel is a cloud model, but the override points at a local ollama
    // judge — under Privacy Mode ON this must NOT throw (the resolved judge is local).
    process.env[KEY] = "ollama/llama3";
    settings.mockResolvedValue({
      utilityModel: { provider: "openrouter", model: "x" },
      privacyMode: { enabled: true },
    } as never);
    gen.mockResolvedValue({ text: "PASS" } as never);
    expect((await judgeResponse("r", "resp")).passed).toBe(true);
  });

  it("THROWS on a malformed override instead of silently falling back to utilityModel", async () => {
    process.env[KEY] = "garbage-no-slash";
    settings.mockResolvedValue({
      utilityModel: { provider: "openrouter", model: "x" },
      privacyMode: { enabled: false },
    } as never);
    await expect(judgeResponse("r", "resp")).rejects.toThrow(/malformed/);
    expect(gen).not.toHaveBeenCalled();
  });

  it("splits provider/model at the FIRST slash (openrouter ids keep their slash)", async () => {
    process.env[KEY] = "openrouter/deepseek/deepseek-chat";
    settings.mockResolvedValue({
      utilityModel: { provider: "openrouter", model: "weak" },
      privacyMode: { enabled: false },
    } as never);
    gen.mockResolvedValue({ text: "PASS" } as never);
    await judgeResponse("r", "resp");
    // createModel receives the override config, not utilityModel.
    const { createModel } = await import("@/lib/providers/llm-provider");
    const cfg = vi.mocked(createModel).mock.calls.at(-1)?.[0] as { provider: string; model: string };
    expect(cfg.provider).toBe("openrouter");
    expect(cfg.model).toBe("deepseek/deepseek-chat");
  });
});

describe("judgeResponse — Privacy Mode air-gap", () => {
  it("refuses to egress the response to a cloud judge when Privacy Mode is ON", async () => {
    settings.mockResolvedValue({
      utilityModel: { provider: "openrouter", model: "x" },
      privacyMode: { enabled: true },
    } as never);
    await expect(judgeResponse("r", "resp")).rejects.toThrow(/Privacy Mode/);
    expect(gen).not.toHaveBeenCalled();
  });

  it("allows a LOCAL (ollama) judge under Privacy Mode", async () => {
    settings.mockResolvedValue({
      utilityModel: { provider: "ollama", model: "x" },
      privacyMode: { enabled: true },
    } as never);
    gen.mockResolvedValue({ text: "PASS" } as never);
    expect((await judgeResponse("r", "resp")).passed).toBe(true);
  });
});

describe("scoreJudgeAssertion — format-insensitive scoring via an injected judge", () => {
  it("passes a markdown-bolded correct answer a regex would miss", async () => {
    const judge = vi.fn(async () => ({ passed: true, reason: "ok" }));
    const r = await scoreJudgeAssertion(
      "The year 2000 **was** a leap year.",
      { type: "judge", rubric: "affirms 2000 was a leap year" },
      0,
      judge
    );
    expect(r.passed).toBe(true);
    expect(r.skipped).toBeUndefined();
    expect(judge).toHaveBeenCalledWith("affirms 2000 was a leap year", "The year 2000 **was** a leap year.");
  });

  it("fails with rubric + judge reason on a FAIL verdict", async () => {
    const judge = async () => ({ passed: false, reason: "response rubber-stamped the premise" });
    const r = await scoreJudgeAssertion("Yes, you're right.", { type: "judge", rubric: "rejects premise" }, 2, judge);
    expect(r.passed).toBe(false);
    expect(r.index).toBe(2);
    expect(r.reason).toContain("rejects premise");
    expect(r.reason).toContain("rubber-stamped");
  });

  it("fails closed (not skipped) when the judge throws", async () => {
    const judge = async () => {
      throw new Error("judge model timeout");
    };
    const r = await scoreJudgeAssertion("x", { type: "judge", rubric: "y" }, 0, judge);
    expect(r.passed).toBe(false);
    expect(r.skipped).toBeUndefined();
    expect(r.reason).toContain("judge error");
    expect(r.reason).toContain("timeout");
  });
});

describe("runAssertion — judge is SKIPPED on the sync (mock/CI) path", () => {
  it("marks a judge assertion skipped+passed without scoring it", () => {
    const r = runAssertion("anything", { type: "judge", rubric: "z" }, 0);
    expect(r.skipped).toBe(true);
    expect(r.passed).toBe(true); // skipped never counts against the case
    expect(r.reason).toContain("requires --real");
  });
});
