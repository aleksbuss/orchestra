/**
 * PM #41 — runner contracts. Cases are loaded from disk, parsed, validated,
 * and dispatched. The mock-response path keeps these tests free of real
 * LLM calls so they live in the regular npm test suite.
 */
import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractDeliveredAnswer,
  loadAllCases,
  parseCaseFromJson,
  runCase,
  runSuite,
} from "./runner";
import type { EvalCase } from "./types";

// invokeRealAgent (the --real path) late-imports these; mock them so the
// precedence test can assert --real is taken WITHOUT booting the agent stack.
const { REAL_AGENT_OUTPUT } = vi.hoisted(() => ({
  REAL_AGENT_OUTPUT: "REAL-AGENT-OVERRIDE-OUTPUT",
}));
vi.mock("@/lib/agent/agent", () => ({
  runAgent: vi.fn(async () => ({
    toUIMessageStreamResponse: () => ({ body: null }),
  })),
}));
vi.mock("@/lib/storage/chat-store", () => ({
  createChat: vi.fn(async () => {}),
  getChat: vi.fn(async () => ({
    messages: [{ role: "assistant", content: REAL_AGENT_OUTPUT }],
  })),
  deleteChat: vi.fn(async () => {}),
  flushAllPendingChats: vi.fn(async () => {}),
}));

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-evals-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("PM #41 — parseCaseFromJson", () => {
  it("happy path parses a minimal valid case", () => {
    const raw = JSON.stringify({
      id: "01-trivia",
      description: "Skeptic catches a false premise",
      input: { message: "Is Sydney the capital of Australia?" },
      assertions: [{ type: "contains", value: "Canberra" }],
    });
    const c = parseCaseFromJson(raw, "01-trivia.json");
    expect(c.id).toBe("01-trivia");
    expect(c.assertions).toHaveLength(1);
  });

  it("invalid JSON surfaces a clear error including the source path", () => {
    expect(() => parseCaseFromJson("{not json", "broken.json")).toThrow(
      /broken\.json: invalid JSON/
    );
  });

  it.each([
    [{ description: "x", input: { message: "y" }, assertions: [{ type: "contains", value: "v" }] }, /missing or empty "id"/],
    [{ id: "x", input: { message: "y" }, assertions: [{ type: "contains", value: "v" }] }, /missing or empty "description"/],
    [{ id: "x", description: "x", assertions: [{ type: "contains", value: "v" }] }, /missing "input"/],
    [{ id: "x", description: "x", input: {}, assertions: [{ type: "contains", value: "v" }] }, /missing or empty input\.message/],
    [{ id: "x", description: "x", input: { message: "m" } }, /at least one assertion/],
  ] as const)("validation: %#", (obj, pattern) => {
    expect(() => parseCaseFromJson(JSON.stringify(obj), "x.json")).toThrow(pattern);
  });
});

describe("PM #41 — loadAllCases", () => {
  it("empty / missing directory → no cases, no errors", async () => {
    const out = await loadAllCases(path.join(tmpDir, "nonexistent"));
    expect(out.cases).toEqual([]);
    expect(out.errors).toEqual([]);
  });

  it("loads every .json in the directory; ignores other files; sorts by name", async () => {
    const dir = path.join(tmpDir, "cases");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "02-second.json"),
      JSON.stringify({
        id: "02-second",
        description: "two",
        input: { message: "m" },
        assertions: [{ type: "contains", value: "v" }],
      })
    );
    await fs.writeFile(
      path.join(dir, "01-first.json"),
      JSON.stringify({
        id: "01-first",
        description: "one",
        input: { message: "m" },
        assertions: [{ type: "contains", value: "v" }],
      })
    );
    await fs.writeFile(path.join(dir, "README.md"), "ignored");
    await fs.writeFile(path.join(dir, "draft.txt"), "also ignored");

    const out = await loadAllCases(dir);
    expect(out.cases.map((c) => c.id)).toEqual(["01-first", "02-second"]);
    expect(out.errors).toEqual([]);
  });

  it("invalid case in the directory is collected as an error, not thrown", async () => {
    const dir = path.join(tmpDir, "cases");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "good.json"), JSON.stringify({
      id: "good", description: "ok",
      input: { message: "m" },
      assertions: [{ type: "contains", value: "v" }],
    }));
    await fs.writeFile(path.join(dir, "bad.json"), "{not json");
    const out = await loadAllCases(dir);
    expect(out.cases).toHaveLength(1);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0].file).toBe("bad.json");
    expect(out.errors[0].error).toMatch(/invalid JSON/);
  });
});

describe("PM #41 — runCase (mock_response path)", () => {
  it("all assertions pass → case passed", async () => {
    const c: EvalCase = {
      id: "mock-pass",
      description: "happy path",
      input: { message: "m" },
      mock_response: "The capital of Australia is Canberra, not Sydney.",
      assertions: [
        { type: "contains", value: "Canberra" },
        { type: "not_contains", value: "Sydney is the capital" },
      ],
    };
    const r = await runCase(c);
    expect(r.passed).toBe(true);
    expect(r.assertions.every((a) => a.passed)).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it("any assertion failed → case failed; non-failing assertions still recorded", async () => {
    const c: EvalCase = {
      id: "mock-mixed",
      description: "mixed",
      input: { message: "m" },
      mock_response: "Sydney is the capital.",
      assertions: [
        { type: "contains", value: "Sydney" }, // pass
        { type: "contains", value: "Canberra" }, // fail
      ],
    };
    const r = await runCase(c);
    expect(r.passed).toBe(false);
    expect(r.assertions.map((a) => a.passed)).toEqual([true, false]);
  });

  it("durationMs is set", async () => {
    const r = await runCase({
      id: "x",
      description: "x",
      input: { message: "m" },
      mock_response: "v",
      assertions: [{ type: "contains", value: "v" }],
    });
    expect(typeof r.durationMs).toBe("number");
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("PM #41 — runSuite filtering", () => {
  const baseCases: EvalCase[] = [
    {
      id: "01-trivia",
      description: "t",
      tags: ["moa", "skeptic"],
      input: { message: "m" },
      mock_response: "ok",
      assertions: [{ type: "contains", value: "ok" }],
    },
    {
      id: "02-code",
      description: "c",
      tags: ["moa", "code"],
      input: { message: "m" },
      mock_response: "ok",
      assertions: [{ type: "contains", value: "ok" }],
    },
    {
      id: "10-refusal",
      description: "r",
      tags: ["refusal"],
      input: { message: "m" },
      mock_response: "ok",
      assertions: [{ type: "contains", value: "ok" }],
    },
  ];

  it("no filter → runs all cases, computes pass/fail/errored counts", async () => {
    const suite = await runSuite(baseCases);
    expect(suite.totalCases).toBe(3);
    expect(suite.passed).toBe(3);
    expect(suite.failed).toBe(0);
    expect(suite.errored).toBe(0);
    // Mock-mode cases never invoke the real agent, so none can be a delivery
    // (no-answer) failure — the field is present and zero.
    expect(suite.noAnswer).toBe(0);
    expect(suite.cases.every((c) => !c.noAnswer)).toBe(true);
  });

  it("tag filter restricts to matching cases", async () => {
    const suite = await runSuite(baseCases, { filter: { tag: "skeptic" } });
    expect(suite.cases.map((c) => c.id)).toEqual(["01-trivia"]);
  });

  it("idPrefix filter restricts by id prefix", async () => {
    const suite = await runSuite(baseCases, { filter: { idPrefix: "0" } });
    expect(suite.cases.map((c) => c.id)).toEqual(["01-trivia", "02-code"]);
  });

  it("filter that matches nothing → zero cases, zero pass/fail", async () => {
    const suite = await runSuite(baseCases, { filter: { tag: "nonexistent" } });
    expect(suite.totalCases).toBe(0);
    expect(suite.cases).toEqual([]);
  });
});

describe("PM #41 — runCase without mock_response + useRealAgent=false", () => {
  it("returns empty response, fails (no signal to assert against)", async () => {
    const r = await runCase({
      id: "no-mock",
      description: "no mock provided, real agent disabled",
      input: { message: "m" },
      assertions: [{ type: "contains", value: "anything" }],
    });
    // Empty string fails the contains assertion — case marked failed.
    expect(r.response).toBe("");
    expect(r.passed).toBe(false);
  });
});

describe("PM #41 — runCase precedence: --real overrides mock_response", () => {
  it("useRealAgent=true scores the real agent, not the recorded mock", async () => {
    const r = await runCase(
      {
        id: "precedence-override",
        description: "case ships a mock, but --real is on",
        input: { message: "anything" },
        mock_response: "MOCK-SHOULD-BE-IGNORED",
        assertions: [{ type: "contains", value: "OVERRIDE" }],
      },
      { useRealAgent: true }
    );
    expect(r.response).toBe(REAL_AGENT_OUTPUT);
    expect(r.response).not.toContain("MOCK");
    expect(r.passed).toBe(true);
  });

  it("useRealAgent=false still falls back to the recorded mock", async () => {
    const r = await runCase({
      id: "precedence-fallback",
      description: "mock used when real is disabled",
      input: { message: "anything" },
      mock_response: "MOCK-USED",
      assertions: [{ type: "contains", value: "MOCK-USED" }],
    });
    expect(r.response).toBe("MOCK-USED");
    expect(r.passed).toBe(true);
  });
});

describe("extractDeliveredAnswer — the delivery metric must measure the AGENT, not the harness", () => {
  // 2026-07-26: the old extraction was "last assistant message wins", which
  // scored a DELIVERED answer as empty whenever the model answered through the
  // `response` tool — the last assistant message is then the tool-CALL carrier
  // with content "". Every "free-tier delivery failure" in that day's eval runs
  // turned out to have a real answer persisted on disk (101-1181 chars), so the
  // metric was measuring its own bug.
  it("reads the answer out of the response-tool result (PM #61 delivery path)", () => {
    const msgs = [
      { role: "user", content: "q" },
      { role: "assistant", content: "" },
      { role: "tool", toolName: "code_execution", content: "stdout" },
      { role: "assistant", content: "" },
      { role: "tool", toolName: "response", content: "the real answer" },
    ];
    expect(extractDeliveredAnswer(msgs)).toBe("the real answer");
  });

  it("falls back to the last non-empty assistant text when no response tool ran", () => {
    const msgs = [
      { role: "user", content: "q" },
      { role: "assistant", content: "plain prose answer" },
    ];
    expect(extractDeliveredAnswer(msgs)).toBe("plain prose answer");
  });

  it("skips an empty trailing assistant message rather than reporting no delivery", () => {
    const msgs = [
      { role: "assistant", content: "earlier real answer" },
      { role: "assistant", content: "   " },
    ];
    expect(extractDeliveredAnswer(msgs)).toBe("earlier real answer");
  });

  it("prefers the response tool over an earlier assistant narration", () => {
    const msgs = [
      { role: "assistant", content: "Let me check that for you." },
      { role: "tool", toolName: "response", content: "final" },
    ];
    expect(extractDeliveredAnswer(msgs)).toBe("final");
  });

  it("returns empty ONLY when nothing was delivered (a genuine delivery failure)", () => {
    expect(extractDeliveredAnswer([{ role: "user", content: "q" }])).toBe("");
    expect(extractDeliveredAnswer([])).toBe("");
    expect(
      extractDeliveredAnswer([
        { role: "assistant", content: "" },
        { role: "tool", toolName: "code_execution", content: "output only" },
      ])
    ).toBe("");
  });

  it("ignores a non-string content payload instead of throwing", () => {
    const msgs = [
      { role: "assistant", content: { parts: [] } as unknown },
      { role: "assistant", content: "text" },
    ];
    expect(extractDeliveredAnswer(msgs)).toBe("text");
  });
});

describe("continuous scoring — the primary metric for the selection A/B", () => {
  const multiConstraint = (mock: string): EvalCase => ({
    id: "90-multi",
    description: "4 independent constraints",
    input: { message: "write it" },
    mock_response: mock,
    assertions: [
      { type: "contains", value: "alpha" },
      { type: "contains", value: "beta" },
      { type: "contains", value: "gamma" },
      { type: "contains", value: "delta" },
    ],
  });

  it("scores the FRACTION of constraints satisfied, not just pass/fail", async () => {
    const r = await runCase(multiConstraint("alpha beta gamma"));
    expect(r.passed).toBe(false);
    // Binary would throw this away; 0.75 is the signal the A/B needs.
    expect(r.score).toBe(0.75);
    expect(r.constraintsPassed).toBe(3);
    expect(r.constraintsTotal).toBe(4);
  });

  it("scores 1 when every constraint holds", async () => {
    const r = await runCase(multiConstraint("alpha beta gamma delta"));
    expect(r.passed).toBe(true);
    expect(r.score).toBe(1);
  });

  it("scores 0 for a case that errored before assertions ran", async () => {
    const broken = {
      ...multiConstraint("x"),
      assertions: null as unknown as EvalCase["assertions"],
    };
    const r = await runCase(broken);
    expect(r.error).toBeTruthy();
    expect(r.score).toBe(0);
    expect(r.constraintsTotal).toBe(0);
  });

  it("EXCLUDES skipped assertions from the denominator — a vacuous case scores 0, not 1", async () => {
    const judgeOnly: EvalCase = {
      id: "judge-only",
      description: "judge assertion in mock mode",
      input: { message: "q" },
      mock_response: "anything",
      assertions: [{ type: "judge", rubric: "is it right?" }],
    };
    const r = await runCase(judgeOnly);
    expect(r.vacuous).toBe(true);
    expect(r.passed).toBe(true); // legacy binary shape, deliberately unchanged
    expect(r.score).toBe(0); // but the continuous metric refuses to credit it
  });
});

describe("runSuite — repeats and per-case aggregates", () => {
  const cases: EvalCase[] = [
    {
      id: "a",
      description: "half the constraints",
      input: { message: "m" },
      mock_response: "alpha",
      assertions: [
        { type: "contains", value: "alpha" },
        { type: "contains", value: "omega" },
      ],
    },
    {
      id: "b",
      description: "all constraints",
      input: { message: "m" },
      mock_response: "alpha",
      assertions: [{ type: "contains", value: "alpha" }],
    },
  ];

  it("runs each case `repeat` times and reports one aggregate row per case", async () => {
    const suite = await runSuite(cases, { repeat: 3 });
    expect(suite.totalCases).toBe(6);
    expect(suite.repeats).toBe(3);
    expect(suite.aggregates).toHaveLength(2);
    const a = suite.aggregates.find((x) => x.id === "a")!;
    expect(a.runs).toBe(3);
    expect(a.scores).toEqual([0.5, 0.5, 0.5]);
    expect(a.meanScore).toBe(0.5);
    expect(a.passRate).toBe(0);
  });

  it("keeps every repeat's raw score so a paired test can run offline", async () => {
    const suite = await runSuite(cases, { repeat: 2 });
    for (const agg of suite.aggregates) {
      expect(agg.scores).toHaveLength(agg.runs);
    }
  });

  it("stamps repeatIndex only when repeating", async () => {
    const once = await runSuite(cases, {});
    expect(once.cases.every((r) => r.repeatIndex === undefined)).toBe(true);
    const thrice = await runSuite(cases, { repeat: 3 });
    expect(new Set(thrice.cases.map((r) => r.repeatIndex))).toEqual(new Set([1, 2, 3]));
  });

  it("interleaves repeats (all cases once, then again) so a mid-run condition change hits every case", async () => {
    const suite = await runSuite(cases, { repeat: 2 });
    expect(suite.cases.map((r) => `${r.id}${r.repeatIndex}`)).toEqual([
      "a1",
      "b1",
      "a2",
      "b2",
    ]);
  });

  it("reports the suite mean score across every run", async () => {
    const suite = await runSuite(cases, { repeat: 2 });
    // (0.5 + 1 + 0.5 + 1) / 4
    expect(suite.meanScore).toBe(0.75);
  });

  it("treats repeat < 1 as 1 rather than running nothing", async () => {
    const suite = await runSuite(cases, { repeat: 0 });
    expect(suite.totalCases).toBe(2);
    expect(suite.repeats).toBe(1);
  });

  it("stamps the active arms into the result so it cannot be mislabeled later", async () => {
    const suite = await runSuite(cases, {});
    expect(suite.arms).toBeNull(); // no flags set in the unit-test environment
    expect(Object.prototype.hasOwnProperty.call(suite, "arms")).toBe(true);
  });

  it("emits a progress callback per run", async () => {
    const seen: string[] = [];
    await runSuite(cases, { repeat: 2, onResult: (r) => seen.push(r.id) });
    expect(seen).toEqual(["a", "b", "a", "b"]);
  });
});
