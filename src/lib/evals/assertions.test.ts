/**
 * PM #41 — eval-harness assertion contracts. The point of this layer is
 * stability: when an operator updates a case file, they should get a
 * clear yes/no + a human-readable reason. These tests pin the wording
 * AND the case-sensitivity defaults.
 */
import { describe, expect, it } from "vitest";
import { runAllAssertions, runAssertion } from "./assertions";

describe("PM #41 — runAssertion: contains", () => {
  it("default case-insensitive match passes", () => {
    const r = runAssertion(
      "The capital of Australia is CANBERRA.",
      { type: "contains", value: "canberra" },
      0
    );
    expect(r.passed).toBe(true);
    expect(r.reason).toBeUndefined();
  });

  it("missing substring fails with a clear reason", () => {
    const r = runAssertion(
      "The capital of Australia is Sydney.",
      { type: "contains", value: "canberra" },
      0
    );
    expect(r.passed).toBe(false);
    expect(r.reason).toContain('"canberra"');
    expect(r.reason).toContain("not found");
  });

  it("case_insensitive: false enforces exact case", () => {
    const r = runAssertion(
      "the answer is canberra",
      { type: "contains", value: "Canberra", case_insensitive: false },
      0
    );
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("case-sensitive");
  });
});

describe("PM #41 — runAssertion: not_contains", () => {
  it("absent substring passes", () => {
    const r = runAssertion(
      "Canberra is the capital.",
      { type: "not_contains", value: "sydney" },
      0
    );
    expect(r.passed).toBe(true);
  });

  it("present substring fails with reason", () => {
    const r = runAssertion(
      "Sydney is the capital, actually it's not.",
      { type: "not_contains", value: "sydney is the capital" },
      0
    );
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("NOT to contain");
  });
});

describe("PM #41 — runAssertion: matches", () => {
  it("regex match passes", () => {
    const r = runAssertion(
      "The version is 15.5.4 stable.",
      { type: "matches", pattern: "\\d+\\.\\d+\\.\\d+" },
      0
    );
    expect(r.passed).toBe(true);
  });

  it("no match fails with the pattern in the reason", () => {
    const r = runAssertion(
      "no numbers here",
      { type: "matches", pattern: "\\d+" },
      0
    );
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("\\d+");
  });

  it("default flag is case-insensitive", () => {
    const r = runAssertion(
      "OPENROUTER",
      { type: "matches", pattern: "openrouter" },
      0
    );
    expect(r.passed).toBe(true);
  });

  it("custom flags respected", () => {
    const r = runAssertion(
      "OPENROUTER",
      { type: "matches", pattern: "openrouter", flags: "" },
      0
    );
    // Empty flags = case-sensitive, so lowercase pattern doesn't match upper.
    expect(r.passed).toBe(false);
  });

  it("invalid regex fails cleanly with a reason instead of throwing", () => {
    const r = runAssertion(
      "anything",
      { type: "matches", pattern: "[unclosed" },
      0
    );
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("invalid regex");
  });
});

describe("PM #41 — runAllAssertions", () => {
  it("returns one result per assertion in order", () => {
    const results = runAllAssertions("Canberra is the capital.", [
      { type: "contains", value: "Canberra" },
      { type: "not_contains", value: "Sydney" },
      { type: "matches", pattern: "capital" },
    ]);
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.passed)).toEqual([true, true, true]);
    expect(results.map((r) => r.index)).toEqual([0, 1, 2]);
  });

  it("collects mixed pass/fail outcomes; does not short-circuit on failure", () => {
    const results = runAllAssertions("foo", [
      { type: "contains", value: "foo" },
      { type: "contains", value: "bar" }, // fails
      { type: "contains", value: "fo" }, // would pass — runner does NOT stop on first fail
    ]);
    expect(results.map((r) => r.passed)).toEqual([true, false, true]);
  });

  it("unknown assertion type fails cleanly (no throw)", () => {
    const results = runAllAssertions("text", [
      // @ts-expect-error — intentionally pass an unknown type to verify the
      // default-arm safety net.
      { type: "exists" },
    ]);
    expect(results[0].passed).toBe(false);
    expect(results[0].reason).toContain("unknown assertion type");
  });
});
