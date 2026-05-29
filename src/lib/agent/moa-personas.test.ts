/**
 * Tests for `moa-personas.ts` — pure helpers extracted from `moa.ts`
 * during PM #57 to bring the orchestration file back under the 1500-line
 * cap. Every export here is synchronous and side-effect-free, so the
 * test surface is straight branch coverage with no mocks.
 *
 * Pinned invariants:
 *   - MOA_PROPOSERS satisfies the CLAUDE.md "3-5 proposers" lower bound
 *     and every persona has a non-empty id / role / systemPrompt / color.
 *   - `deriveTierFromRole` and `detectProposerRole` are stable on every
 *     documented input — adding a new persona type elsewhere in the code
 *     MUST add a branch here, not silently fall through to "coder".
 *   - `detectProposerRole` checks the `role` field too (PM #45 fix);
 *     personas like `{ id: "beta", role: "Code Reviewer" }` get classed
 *     as reviewers, not coders.
 *   - `resolveWorkerKey` precedence is correct: explicit apiKey wins,
 *     then provider vault, then same-provider chatModel inheritance.
 *   - `resolveProposerModelConfig` honours an explicit `modelTier` over
 *     a derived one, and falls back to `defaultWorkerConfig` when the
 *     selected tier has no `model` configured.
 */
import { describe, expect, it } from "vitest";
import {
  MOA_PROPOSERS,
  deriveTierFromRole,
  detectProposerRole,
  resolveWorkerKey,
  resolveProposerModelConfig,
  type MoAProposer,
  type ProposerRole,
  type ProposerTier,
} from "./moa-personas";
import type { AppSettings, ModelConfig } from "@/lib/types";

const STUB_CHAT_MODEL: ModelConfig = {
  provider: "openrouter",
  model: "anthropic/claude-3-5-haiku",
  apiKey: "sk-chat",
};

const STUB_UTILITY_MODEL: ModelConfig = {
  provider: "openrouter",
  model: "anthropic/claude-3-5-haiku",
  apiKey: "sk-utility",
};

function makeSettings(
  override: Partial<AppSettings> = {}
): AppSettings {
  return {
    chatModel: STUB_CHAT_MODEL,
    utilityModel: STUB_UTILITY_MODEL,
    embeddingsModel: {
      provider: "openai",
      model: "text-embedding-3-small",
    },
    codeExecution: { enabled: false, timeout: 30, maxOutputLength: 10000 },
    memory: {
      enabled: false,
      similarityThreshold: 0.7,
      maxResults: 5,
      chunkSize: 1000,
    },
    search: { enabled: false, provider: "none" },
    general: { darkMode: false, language: "en" },
    auth: {
      enabled: false,
      username: "",
      passwordHash: "",
      mustChangeCredentials: false,
    },
    ...override,
  };
}

describe("MOA_PROPOSERS — static fallback set shape", () => {
  it("contains 3-5 proposers (CLAUDE.md §1 MoA lower bound)", () => {
    expect(MOA_PROPOSERS.length).toBeGreaterThanOrEqual(3);
    expect(MOA_PROPOSERS.length).toBeLessThanOrEqual(5);
  });

  it("every persona has a non-empty id / role / systemPrompt / color", () => {
    for (const p of MOA_PROPOSERS) {
      expect(p.id).toBeTruthy();
      expect(p.role).toBeTruthy();
      expect(p.systemPrompt).toBeTruthy();
      expect(p.color).toBeTruthy();
    }
  });

  it("ids are unique across the static set", () => {
    const ids = MOA_PROPOSERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("at least one persona reads as 'reviewer' under detectProposerRole (covers the skeptic mandate)", () => {
    // CLAUDE.md §1 — "One of the DPG roles is always forced to be a
    // QA Auditor / Skeptic". The static fallback must include one too so
    // a Router failure doesn't drop the skeptic guarantee.
    const roles = MOA_PROPOSERS.map(detectProposerRole);
    expect(roles).toContain("reviewer");
  });
});

describe("deriveTierFromRole — every documented role maps to a tier", () => {
  const cases: Array<[ProposerRole, ProposerTier]> = [
    ["reviewer", "fast"],
    ["researcher", "balanced"],
    ["tool", "balanced"],
    ["coder", "frontier"],
    ["orchestrator", "balanced"],
  ];

  for (const [role, tier] of cases) {
    it(`${role} → ${tier}`, () => {
      expect(deriveTierFromRole(role)).toBe(tier);
    });
  }

  it("unknown role defaults to balanced (safety net)", () => {
    // TS prevents this at compile-time; the default branch is the
    // runtime safety net we never want to hit.
    expect(deriveTierFromRole("totally-new" as ProposerRole)).toBe("balanced");
  });
});

describe("detectProposerRole — keyword matching across id + role + systemPrompt (PM #45)", () => {
  function persona(over: Partial<MoAProposer>): MoAProposer {
    return {
      id: "x",
      role: "Generic",
      color: "blue",
      systemPrompt: "do work",
      ...over,
    };
  }

  it("classifies skeptic / critic / red-team / fact-check as reviewer", () => {
    expect(detectProposerRole(persona({ id: "skeptic" }))).toBe("reviewer");
    expect(detectProposerRole(persona({ role: "Adversarial Critic" }))).toBe(
      "reviewer"
    );
    expect(detectProposerRole(persona({ id: "red-team" }))).toBe("reviewer");
    expect(detectProposerRole(persona({ id: "fact-checker" }))).toBe(
      "reviewer"
    );
    expect(detectProposerRole(persona({ role: "QA Auditor" }))).toBe(
      "reviewer"
    );
  });

  it("PM #45 — picks up keywords in the `role` field, not just id (regression)", () => {
    // The pre-PM-45 bug: a persona with `{ id: "beta", role: "Code
    // Reviewer" }` would slip past id-only matching. The check below
    // would have been "coder" before the fix; it MUST be "reviewer".
    expect(
      detectProposerRole(
        persona({ id: "beta", role: "Code Reviewer", systemPrompt: "review" })
      )
    ).toBe("reviewer");
  });

  it("classifies analyst / architect / domain-expert / first-principles as researcher", () => {
    expect(detectProposerRole(persona({ id: "analyst" }))).toBe("researcher");
    expect(detectProposerRole(persona({ role: "Software Architect" }))).toBe(
      "researcher"
    );
    expect(
      detectProposerRole(persona({ systemPrompt: "domain expert in FDA" }))
    ).toBe("researcher");
    expect(detectProposerRole(persona({ id: "chameleon" }))).toBe(
      "researcher"
    );
    expect(detectProposerRole(persona({ role: "First-Principles" }))).toBe(
      "researcher"
    );
  });

  it("classifies executor / pragmatic / deploy / devops as tool", () => {
    expect(detectProposerRole(persona({ id: "pragmatist" }))).toBe("tool");
    expect(detectProposerRole(persona({ role: "Deploy Engineer" }))).toBe(
      "tool"
    );
    expect(detectProposerRole(persona({ systemPrompt: "infra + devops" }))).toBe(
      "tool"
    );
  });

  it("defaults to coder when no keyword matches", () => {
    expect(
      detectProposerRole(
        persona({ id: "delta", role: "Generalist", systemPrompt: "do code" })
      )
    ).toBe("coder");
  });

  it("matching is case-insensitive", () => {
    expect(detectProposerRole(persona({ role: "CRITIC" }))).toBe("reviewer");
    expect(detectProposerRole(persona({ id: "ANALYST" }))).toBe("researcher");
  });

  it("reviewer keyword wins when both reviewer AND researcher patterns appear", () => {
    // First check in the function is the reviewer regex; ordering is
    // intentional — the skeptic mandate trumps researcher.
    expect(
      detectProposerRole(
        persona({ role: "Skeptical Analyst", systemPrompt: "review research" })
      )
    ).toBe("reviewer");
  });
});

describe("resolveWorkerKey — API-key inheritance precedence", () => {
  const settings = makeSettings({
    providerApiKeys: {
      anthropic: "sk-vault-anthropic",
      google: "sk-vault-google",
    },
    chatModel: {
      provider: "openai",
      model: "gpt-4o-mini",
      apiKey: "sk-chat-openai",
    },
  });

  it("returns the config unchanged when apiKey is already set", () => {
    const cfg: ModelConfig = {
      provider: "anthropic",
      model: "claude-3-5-haiku",
      apiKey: "sk-explicit",
    };
    expect(resolveWorkerKey(cfg, settings)).toBe(cfg);
  });

  it("inherits from providerApiKeys vault when no explicit key", () => {
    const cfg: ModelConfig = {
      provider: "anthropic",
      model: "claude-3-5-sonnet",
    };
    const resolved = resolveWorkerKey(cfg, settings);
    expect(resolved.apiKey).toBe("sk-vault-anthropic");
    expect(resolved).not.toBe(cfg); // returns a new object
  });

  it("falls through to chatModel.apiKey when vault has nothing AND providers match", () => {
    const cfg: ModelConfig = {
      provider: "openai",
      model: "gpt-4o-mini",
    };
    expect(resolveWorkerKey(cfg, settings).apiKey).toBe("sk-chat-openai");
  });

  it("returns the original (key-less) config when no source has a matching key", () => {
    // openrouter is neither in the vault nor matched by chatModel.provider
    // (which is "openai" in this fixture).
    const cfg: ModelConfig = {
      provider: "openrouter",
      model: "anthropic/claude-3-haiku",
    };
    const resolved = resolveWorkerKey(cfg, settings);
    expect(resolved.apiKey).toBeUndefined();
  });

  it("vault wins over chatModel inheritance when both could apply", () => {
    const s = makeSettings({
      providerApiKeys: { openai: "sk-vault-openai" },
      chatModel: {
        provider: "openai",
        model: "gpt-4o-mini",
        apiKey: "sk-chat-openai",
      },
    });
    expect(
      resolveWorkerKey({ provider: "openai", model: "gpt-4o" }, s).apiKey
    ).toBe("sk-vault-openai");
  });
});

describe("resolveProposerModelConfig — tier-aware model selection (PM #48)", () => {
  const baseSettings = makeSettings({
    chatModel: STUB_CHAT_MODEL,
  });
  const defaultWorker: ModelConfig = {
    provider: "openrouter",
    model: "default/worker-model",
    apiKey: "sk-default",
  };

  function makePersona(over: Partial<MoAProposer> = {}): MoAProposer {
    return {
      id: "x",
      role: "Worker",
      color: "blue",
      systemPrompt: "...",
      ...over,
    };
  }

  it("explicit modelTier overrides the role-derived tier", () => {
    // Persona reads as "reviewer" by role (would derive to "fast"), but
    // the explicit tier is "frontier" — that's what should propagate.
    const p = makePersona({ role: "Critic", modelTier: "frontier" });
    const result = resolveProposerModelConfig(p, defaultWorker, baseSettings);
    expect(result.tier).toBe("frontier");
  });

  it("falls back to derived tier when modelTier is missing", () => {
    const p = makePersona({ id: "skeptic" });
    const result = resolveProposerModelConfig(p, defaultWorker, baseSettings);
    expect(result.tier).toBe("fast"); // derived from "skeptic" → reviewer
  });

  it("falls back to defaultWorkerConfig when no tier configuration exists", () => {
    const p = makePersona();
    const result = resolveProposerModelConfig(p, defaultWorker, baseSettings);
    expect(result.config).toBe(defaultWorker);
  });

  it("uses a configured tier model when present", () => {
    const fastModel: ModelConfig = {
      provider: "anthropic",
      model: "claude-3-5-haiku",
      apiKey: "sk-fast",
    };
    const s = makeSettings({
      proposerTiers: {
        fast: fastModel,
        balanced: { provider: "openai", model: "" }, // empty model → falls through
      },
    } as Partial<AppSettings>);
    const p = makePersona({ id: "skeptic" }); // → reviewer → fast
    const result = resolveProposerModelConfig(p, defaultWorker, s);
    expect(result.config.model).toBe("claude-3-5-haiku");
    expect(result.tier).toBe("fast");
  });

  it("falls back to default when the selected tier has an empty `model`", () => {
    const s = makeSettings({
      proposerTiers: {
        fast: { provider: "anthropic", model: "" } as ModelConfig,
      },
    } as Partial<AppSettings>);
    const p = makePersona({ id: "skeptic" });
    const result = resolveProposerModelConfig(p, defaultWorker, s);
    expect(result.config).toBe(defaultWorker);
  });

  it("tier-configured model inherits API key from the vault", () => {
    const s = makeSettings({
      providerApiKeys: { anthropic: "sk-vault-anth" },
      proposerTiers: {
        frontier: {
          provider: "anthropic",
          model: "claude-3-5-sonnet",
        } as ModelConfig,
      },
    } as Partial<AppSettings>);
    const p = makePersona({ modelTier: "frontier" });
    const result = resolveProposerModelConfig(p, defaultWorker, s);
    expect(result.config.apiKey).toBe("sk-vault-anth");
    expect(result.config.model).toBe("claude-3-5-sonnet");
  });
});
