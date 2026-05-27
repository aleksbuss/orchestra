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
  loadAllCases,
  parseCaseFromJson,
  runCase,
  runSuite,
} from "./runner";
import type { EvalCase } from "./types";

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
