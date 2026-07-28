/**
 * Eval-arm flags (selection-vs-averaging experiment). The load-bearing property
 * is NEGATIVE: with the flags unset — the production shape — every helper here
 * must be a strict no-op. A flag that leaks into production would silently
 * change how real users' swarms aggregate.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  applyIdenticalPromptsArm,
  describeActiveEvalArms,
  IDENTICAL_PROMPT_TEXT,
  isIdenticalPromptsArmActive,
  resolveEvalAggregatorMode,
} from "./eval-arms";
import { detectProposerRole, type MoAProposer } from "./moa-personas";

const ENV_KEYS: string[] = [
  "ORCHESTRA_EVAL_AGGREGATOR_MODE",
  "ORCHESTRA_EVAL_IDENTICAL_PROMPTS",
  "ORCHESTRA_EVAL_SKEPTIC_CONTROL",
  "ORCHESTRA_EVAL_SWARM_MODE",
];

const saved: Record<string, string | undefined> = {};

function personas(): MoAProposer[] {
  return [
    { id: "tax_lawyer", role: "Senior Tax Attorney", color: "blue", systemPrompt: "[GOAL] tax" },
    { id: "critic", role: "Adversarial Critic", color: "red", systemPrompt: "[GOAL] doubt" },
    { id: "coder", role: "Systems Engineer", color: "green", systemPrompt: "[GOAL] code" },
  ];
}

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("resolveEvalAggregatorMode", () => {
  it("is a no-op with the flag unset (production shape)", () => {
    expect(resolveEvalAggregatorMode("synthesis")).toBe("synthesis");
    expect(resolveEvalAggregatorMode("tournament")).toBe("tournament");
  });

  it("overrides the configured mode when the flag is set", () => {
    process.env.ORCHESTRA_EVAL_AGGREGATOR_MODE = "tournament";
    expect(resolveEvalAggregatorMode("synthesis")).toBe("tournament");
  });

  it("can also force synthesis over a tournament-configured operator", () => {
    process.env.ORCHESTRA_EVAL_AGGREGATOR_MODE = "synthesis";
    expect(resolveEvalAggregatorMode("tournament")).toBe("synthesis");
  });

  it("IGNORES an unknown value rather than killing the turn, and warns", () => {
    process.env.ORCHESTRA_EVAL_AGGREGATOR_MODE = "borda";
    expect(resolveEvalAggregatorMode("synthesis")).toBe("synthesis");
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("borda"));
  });

  it("is inert under NODE_ENV=production even with the flag set", () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.ORCHESTRA_EVAL_AGGREGATOR_MODE = "tournament";
    expect(resolveEvalAggregatorMode("synthesis")).toBe("synthesis");
  });

  it("warns when it actually changes the mode", () => {
    process.env.ORCHESTRA_EVAL_AGGREGATOR_MODE = "tournament";
    resolveEvalAggregatorMode("synthesis");
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("EVAL ARM"));
  });

  it("does not warn when the override matches the configured mode", () => {
    process.env.ORCHESTRA_EVAL_AGGREGATOR_MODE = "synthesis";
    resolveEvalAggregatorMode("synthesis");
    expect(console.warn).not.toHaveBeenCalled();
  });
});

describe("applyIdenticalPromptsArm", () => {
  it("returns the personas untouched with the flag unset", () => {
    const input = personas();
    expect(applyIdenticalPromptsArm(input)).toBe(input);
    expect(isIdenticalPromptsArmActive()).toBe(false);
  });

  it("is inert under NODE_ENV=production even with the flag set", () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.ORCHESTRA_EVAL_IDENTICAL_PROMPTS = "true";
    const input = personas();
    expect(applyIdenticalPromptsArm(input)).toBe(input);
  });

  it("only honors the exact string \"true\"", () => {
    process.env.ORCHESTRA_EVAL_IDENTICAL_PROMPTS = "1";
    const input = personas();
    expect(applyIdenticalPromptsArm(input)).toBe(input);
  });

  it("replaces every prompt with ONE identical text, preserving headcount", () => {
    process.env.ORCHESTRA_EVAL_IDENTICAL_PROMPTS = "true";
    const out = applyIdenticalPromptsArm(personas());
    expect(out).toHaveLength(3);
    expect(new Set(out.map((p) => p.systemPrompt)).size).toBe(1);
    expect(out[0].systemPrompt).toBe(IDENTICAL_PROMPT_TEXT);
  });

  it("keeps ids DISTINCT — they key the DAG nodes, telemetry and ballots", () => {
    process.env.ORCHESTRA_EVAL_IDENTICAL_PROMPTS = "true";
    const out = applyIdenticalPromptsArm(personas());
    expect(new Set(out.map((p) => p.id)).size).toBe(3);
    expect(out.map((p) => p.id)).toEqual(["sample_1", "sample_2", "sample_3"]);
  });

  it("strips the Skeptic — no sample classifies as a reviewer", () => {
    process.env.ORCHESTRA_EVAL_IDENTICAL_PROMPTS = "true";
    const out = applyIdenticalPromptsArm(personas());
    expect(out.some((p) => detectProposerRole(p) === "reviewer")).toBe(false);
  });

  it("classifies every sample into the SAME role, holding tools constant", () => {
    process.env.ORCHESTRA_EVAL_IDENTICAL_PROMPTS = "true";
    const roles = new Set(applyIdenticalPromptsArm(personas()).map(detectProposerRole));
    expect(roles.size).toBe(1);
    // Same bucket the Skeptic control arm uses, so tool availability does not
    // vary between arms (only prompt diversity does).
    expect([...roles][0]).toBe("researcher");
  });

  it("warns about the CONFOUND when the skeptic control arm is also on", () => {
    process.env.ORCHESTRA_EVAL_IDENTICAL_PROMPTS = "true";
    process.env.ORCHESTRA_EVAL_SKEPTIC_CONTROL = "true";
    applyIdenticalPromptsArm(personas());
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("CONFOUND"));
  });
});

describe("describeActiveEvalArms", () => {
  it("returns null in the production shape (no flags)", () => {
    expect(describeActiveEvalArms()).toBeNull();
  });

  it("names every active arm so a result can never be mislabeled", () => {
    process.env.ORCHESTRA_EVAL_AGGREGATOR_MODE = "tournament";
    process.env.ORCHESTRA_EVAL_IDENTICAL_PROMPTS = "true";
    expect(describeActiveEvalArms()).toBe("aggregator=tournament prompts=identical");
  });

  it("records the swarm-mode arm too — a control run must not be labeled '(none)'", () => {
    process.env.ORCHESTRA_EVAL_SWARM_MODE = "single";
    expect(describeActiveEvalArms()).toBe("swarm=single");
  });

  it("returns null under NODE_ENV=production — nothing is honored there", () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.ORCHESTRA_EVAL_AGGREGATOR_MODE = "tournament";
    expect(describeActiveEvalArms()).toBeNull();
  });
});
