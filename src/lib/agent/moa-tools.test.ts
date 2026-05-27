/**
 * PM #42 — role-based proposer tooling.
 *
 * Pinned contracts:
 *   - detectProposerRole maps persona id/role regex to one of
 *     "reviewer" | "researcher" | "tool" | "coder" (default).
 *   - selectProposerTools returns search_web only for reviewer + researcher.
 *   - selectProposerTools returns undefined when searchEnabled is false,
 *     regardless of role.
 *   - augmentProposerPromptForTools appends Fact-Check Mandate when tools
 *     include search_web; passes prompt through unchanged otherwise.
 */
import { describe, expect, it } from "vitest";
import type { AppSettings } from "@/lib/types";
import {
  augmentProposerPromptForTools,
  detectProposerRole,
  FACT_CHECK_MANDATE,
  selectProposerTools,
} from "./moa";
import type { MoAProposer } from "./moa";

function makePersona(
  id: string,
  systemPromptHint: string = ""
): MoAProposer {
  return {
    id,
    role: id.replace(/_/g, " "),
    systemPrompt: systemPromptHint || `[GOAL] Test persona ${id}. [RULES] - [FORMAT] markdown`,
    color: "blue",
  };
}

const enabledSearch: AppSettings["search"] = {
  enabled: true,
  provider: "tavily",
  apiKey: "test",
};

const disabledSearch: AppSettings["search"] = {
  enabled: false,
  provider: "none",
};

describe("PM #42 — detectProposerRole", () => {
  it.each([
    ["critic", "reviewer"],
    ["skeptic_auditor", "reviewer"],
    ["red_team", "reviewer"],
    ["qa_engineer", "reviewer"],
    ["fact_checker", "reviewer"],
    ["adversarial_critic", "reviewer"],
  ])("id %s → reviewer (search-eligible)", (id, expected) => {
    expect(detectProposerRole(makePersona(id))).toBe(expected);
  });

  it.each([
    ["research_lead", "researcher"],
    ["data_analyst", "researcher"],
    ["solutions_architect", "researcher"],
    ["domain_expert", "researcher"],
    ["chameleon", "researcher"],
    ["first_principles_thinker", "researcher"],
  ])("id %s → researcher (search-eligible)", (id, expected) => {
    expect(detectProposerRole(makePersona(id))).toBe(expected);
  });

  // Note: regex precedence is reviewer → researcher → tool → coder. An id like
  // "tooling_expert" matches BOTH "expert" (researcher) and "tool" — researcher
  // wins because it's checked first. The test ids below avoid that overlap.
  it.each([
    ["deployment_engineer", "tool"],
    ["devops_lead", "tool"],
    ["pragmatist", "tool"],
    ["infrastructure_owner", "tool"],
    ["build_executor", "tool"],
  ])("id %s → tool (no search)", (id, expected) => {
    expect(detectProposerRole(makePersona(id))).toBe(expected);
  });

  it("unrecognised id falls through to coder default", () => {
    expect(detectProposerRole(makePersona("creative_brainstormer"))).toBe("coder");
    expect(detectProposerRole(makePersona("storyteller"))).toBe("coder");
  });

  it("role detection ALSO inspects systemPrompt keywords (not just id)", () => {
    // id doesn't contain a role keyword, but systemPrompt does.
    expect(
      detectProposerRole({
        id: "generic_helper_1",
        role: "Generic Helper",
        systemPrompt: "[GOAL] Audit the proposed solution for security flaws.",
        color: "blue",
      })
    ).toBe("reviewer");
  });
});

describe("PM #42 — selectProposerTools", () => {
  it("reviewer + search enabled → search_web tool included", () => {
    const tools = selectProposerTools("reviewer", true, enabledSearch);
    expect(tools).toBeDefined();
    expect(tools).toHaveProperty("search_web");
  });

  it("researcher + search enabled → search_web tool included", () => {
    const tools = selectProposerTools("researcher", true, enabledSearch);
    expect(tools).toBeDefined();
    expect(tools).toHaveProperty("search_web");
  });

  it("coder + search enabled → NO tools (creative work doesn't need browsing)", () => {
    const tools = selectProposerTools("coder", true, enabledSearch);
    expect(tools).toBeUndefined();
  });

  it("tool role + search enabled → NO tools (implementation persona uses training data)", () => {
    const tools = selectProposerTools("tool", true, enabledSearch);
    expect(tools).toBeUndefined();
  });

  it("search disabled overrides role → NO tools for any role", () => {
    for (const role of ["reviewer", "researcher", "coder", "tool"] as const) {
      expect(selectProposerTools(role, false, disabledSearch)).toBeUndefined();
    }
  });
});

describe("PM #42 — augmentProposerPromptForTools", () => {
  const basePrompt = "[GOAL] Be helpful. [RULES] Cite sources. [FORMAT] markdown";

  it("tools include search_web → Fact-Check Mandate appended", () => {
    const tools = selectProposerTools("reviewer", true, enabledSearch);
    const out = augmentProposerPromptForTools(basePrompt, tools);
    expect(out).toContain(basePrompt);
    expect(out).toContain(FACT_CHECK_MANDATE.trim());
  });

  it("undefined tools → prompt unchanged", () => {
    const out = augmentProposerPromptForTools(basePrompt, undefined);
    expect(out).toBe(basePrompt);
  });

  it("tools without search_web → prompt unchanged (mandate is search-specific)", () => {
    // Empty toolset (defensive — not currently producible by selectProposerTools,
    // but if a future caller passes a non-search ToolSet, the mandate must NOT fire).
    const out = augmentProposerPromptForTools(basePrompt, {} as never);
    expect(out).toBe(basePrompt);
  });

  it("Fact-Check Mandate names the canonical verification triggers", () => {
    // Pin the wording so a future "quick prompt tweak" can't silently
    // drop the library-version / API-signature / real-time-fact triggers.
    expect(FACT_CHECK_MANDATE).toMatch(/Library or framework versions/i);
    expect(FACT_CHECK_MANDATE).toMatch(/API signatures/i);
    expect(FACT_CHECK_MANDATE).toMatch(/Real-time facts/i);
    expect(FACT_CHECK_MANDATE).toMatch(/explicitly|state that explicitly/i);
  });
});
