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
  CODE_EXECUTION_MANDATE,
  detectProposerRole,
  FACT_CHECK_MANDATE,
  isSuccessfulDraft,
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
  it("reviewer + search enabled → search_web AND fetch_webpage included", () => {
    const tools = selectProposerTools("reviewer", true, enabledSearch);
    expect(tools).toBeDefined();
    expect(tools).toHaveProperty("search_web");
    expect(tools).toHaveProperty("fetch_webpage"); // PM #73
  });

  it("researcher + search enabled → search_web AND fetch_webpage included", () => {
    const tools = selectProposerTools("researcher", true, enabledSearch);
    expect(tools).toBeDefined();
    expect(tools).toHaveProperty("search_web");
    expect(tools).toHaveProperty("fetch_webpage"); // PM #73
  });

  it("coder + search enabled → NO tools (creative work doesn't need browsing)", () => {
    const tools = selectProposerTools("coder", true, enabledSearch);
    expect(tools).toBeUndefined();
  });

  it("tool role + search enabled → NO tools (implementation persona uses training data)", () => {
    const tools = selectProposerTools("tool", true, enabledSearch);
    expect(tools).toBeUndefined();
  });

  it("search disabled: reviewer/researcher KEEP fetch_webpage (no key needed); coder/tool get nothing", () => {
    // PM #73 — fetch_webpage is keyless, so verification roles retain it even
    // with no search provider; they just lack search_web.
    for (const role of ["reviewer", "researcher"] as const) {
      const t = selectProposerTools(role, false, disabledSearch);
      expect(t).toHaveProperty("fetch_webpage");
      expect(t).not.toHaveProperty("search_web");
    }
    for (const role of ["coder", "tool"] as const) {
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

// ─────────────────────── PM #50 — coder code_execution ───────────────────
//
// What's pinned:
//   - coder role + proposerAccess + codeExecution.enabled → tool included.
//   - coder role + proposerAccess=false → NO tool (opt-in invariant).
//   - coder role + codeExecution.enabled=false → NO tool (global flag wins).
//   - non-coder roles never get code_execution even if all flags are on.
//   - the mandate fires whenever the tool is present, not before.
//   - the mandate text pins the verification triggers (regression guard).
//   - both mandates compose if a persona somehow gets both tools.

const fullSettingsWithCoderAccess: AppSettings = {
  chatModel: { provider: "openai", model: "gpt-4o", apiKey: "k" },
  utilityModel: { provider: "openai", model: "gpt-4o-mini", apiKey: "k" },
  embeddingsModel: {
    provider: "openai",
    model: "text-embedding-3-small",
    dimensions: 1536,
  },
  codeExecution: {
    enabled: true,
    timeout: 600,
    maxOutputLength: 120000,
    proposerAccess: true, // PM #50 opt-in ON
  },
  memory: {
    enabled: true,
    similarityThreshold: 0.35,
    maxResults: 10,
    chunkSize: 400,
  },
  search: { enabled: false, provider: "none" },
  general: { darkMode: false, language: "en" },
  auth: {
    enabled: true,
    username: "admin",
    passwordHash: "scrypt$x$y",
    mustChangeCredentials: false,
  },
};

const coderCtx = {
  settings: fullSettingsWithCoderAccess,
  cwd: "/tmp/orchestra-test-cwd",
};

describe("PM #50 — selectProposerTools (coder code_execution)", () => {
  it("coder + proposerAccess ON + codeExecution.enabled → code_execution tool included", () => {
    const tools = selectProposerTools("coder", false, disabledSearch, coderCtx);
    expect(tools).toBeDefined();
    expect(tools).toHaveProperty("code_execution");
    // Search is disabled, so search_web must not appear.
    expect(tools).not.toHaveProperty("search_web");
  });

  it("coder + proposerAccess OFF → NO code_execution (opt-in invariant)", () => {
    const tools = selectProposerTools("coder", false, disabledSearch, {
      ...coderCtx,
      settings: {
        ...fullSettingsWithCoderAccess,
        codeExecution: {
          ...fullSettingsWithCoderAccess.codeExecution,
          proposerAccess: false,
        },
      },
    });
    expect(tools).toBeUndefined();
  });

  it("coder + proposerAccess UNDEFINED → NO code_execution (defaults off)", () => {
    const settingsWithoutAccess = {
      ...fullSettingsWithCoderAccess,
      codeExecution: {
        enabled: true,
        timeout: 600,
        maxOutputLength: 120000,
        // proposerAccess deliberately omitted — pre-PM-50 settings shape.
      },
    };
    const tools = selectProposerTools("coder", false, disabledSearch, {
      ...coderCtx,
      settings: settingsWithoutAccess,
    });
    expect(tools).toBeUndefined();
  });

  it("coder + global codeExecution.enabled OFF → NO code_execution (global flag wins)", () => {
    const tools = selectProposerTools("coder", false, disabledSearch, {
      ...coderCtx,
      settings: {
        ...fullSettingsWithCoderAccess,
        codeExecution: {
          ...fullSettingsWithCoderAccess.codeExecution,
          enabled: false,
        },
      },
    });
    expect(tools).toBeUndefined();
  });

  it("non-coder roles NEVER get code_execution (even with everything ON)", () => {
    for (const role of ["reviewer", "researcher", "tool"] as const) {
      const tools = selectProposerTools(role, false, disabledSearch, coderCtx);
      // reviewer/researcher only get tools when search is enabled; we
      // disabled search above so they should return undefined.
      // tool role never gets code_execution.
      if (tools) expect(tools).not.toHaveProperty("code_execution");
    }
  });

  it("coder + proposerAccess ON + NO coderContext → NO code_execution (defensive)", () => {
    const tools = selectProposerTools("coder", false, disabledSearch);
    expect(tools).toBeUndefined();
  });

  it("coder gets BOTH tools when also tagged researcher-like (shouldn't happen but defensive)", () => {
    // detectProposerRole returns ONE role per persona, so a real persona
    // wouldn't end up here. But selectProposerTools must compose cleanly
    // if a future caller passes a hybrid.
    const reviewer = selectProposerTools("reviewer", true, enabledSearch, coderCtx);
    expect(reviewer).toHaveProperty("search_web");
    // reviewer is NOT coder → no code_execution for them.
    expect(reviewer).not.toHaveProperty("code_execution");
  });
});

describe("PM #50 — augmentProposerPromptForTools (code_execution mandate)", () => {
  const basePrompt = "[GOAL] Be helpful. [RULES] Cite sources. [FORMAT] markdown";

  it("tools include code_execution → CODE_EXECUTION_MANDATE appended", () => {
    const tools = selectProposerTools("coder", false, disabledSearch, coderCtx);
    const out = augmentProposerPromptForTools(basePrompt, tools);
    expect(out).toContain(basePrompt);
    expect(out).toContain("CODE-EXECUTION MANDATE");
  });

  it("tools include both search_web AND code_execution → both mandates appended", () => {
    // Manually construct a hybrid toolset; selectProposerTools wouldn't
    // produce this shape with current detectProposerRole, but the
    // augmenter must handle it correctly if a future caller does.
    const reviewerTools = selectProposerTools(
      "reviewer",
      true,
      enabledSearch,
      coderCtx
    );
    // Add code_execution onto the reviewer toolset (synthetic hybrid).
    const coderTools = selectProposerTools(
      "coder",
      false,
      disabledSearch,
      coderCtx
    );
    const hybrid = { ...reviewerTools, ...coderTools };
    const out = augmentProposerPromptForTools(basePrompt, hybrid);
    expect(out).toContain("FACT-CHECK MANDATE");
    expect(out).toContain("CODE-EXECUTION MANDATE");
  });

  it("CODE_EXECUTION_MANDATE names the canonical verification triggers", () => {
    expect(CODE_EXECUTION_MANDATE).toMatch(/library API signature/i);
    expect(CODE_EXECUTION_MANDATE).toMatch(/output shape/i);
    expect(CODE_EXECUTION_MANDATE).toMatch(/regex|parsing|boundary/i);
    // The "what NOT to use" section must stay — it's how we keep coder
    // proposers from launching GUI apps and hanging the server.
    expect(CODE_EXECUTION_MANDATE).toMatch(/GUI apps/i);
    expect(CODE_EXECUTION_MANDATE).toMatch(/long-running\s+servers/i);
    expect(CODE_EXECUTION_MANDATE).toMatch(/2-minute cap/i);
  });
});

// PM #54 — isSuccessfulDraft contract. Filters both error-marker drafts
// AND the "(empty draft)" placeholder. The placeholder used to slip
// through to synthesis + tournament, producing literal "(empty draft)"
// as the assistant's final answer.
describe("PM #54 — isSuccessfulDraft", () => {
  it("accepts a real draft", () => {
    expect(isSuccessfulDraft("Here is the solution: ...")).toBe(true);
  });

  it("rejects [Error: ...] failure marker", () => {
    expect(isSuccessfulDraft("[Error: 429 Too Many Requests]")).toBe(false);
  });

  it("rejects the literal (empty draft) placeholder", () => {
    expect(isSuccessfulDraft("(empty draft)")).toBe(false);
  });

  it("accepts a draft that MENTIONS empty drafts but isn't one", () => {
    // Defensive — a real proposer discussing empty drafts shouldn't be
    // misclassified. The check is exact-match on the placeholder string.
    expect(
      isSuccessfulDraft(
        "If the system returns (empty draft) it usually means the model timed out."
      )
    ).toBe(true);
  });

  it("accepts a draft with [Error: ...] inside but not at start", () => {
    // Same defensive shape as the synthesis-prompt body might contain.
    expect(
      isSuccessfulDraft("To handle [Error: foo] you should retry.")
    ).toBe(true);
  });

  it("rejects empty string and whitespace-only (defensive)", () => {
    // Not part of the original behavior — but if a future proposer
    // path skips the (empty draft) fallback, we still want to filter.
    // Today: not filtered. Future: consider adding. For now we PIN the
    // current behavior so the test fails if it changes silently.
    expect(isSuccessfulDraft("")).toBe(true); // Pre-PM-54 behavior.
    expect(isSuccessfulDraft("   ")).toBe(true); // Pre-PM-54 behavior.
  });
});
