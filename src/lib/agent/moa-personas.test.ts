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

  it("floors a reviewer to 'balanced' when no explicit tier lifts it (R5)", () => {
    // skeptic → reviewer → would derive to "fast", but R5 floors the Skeptic
    // at "balanced" so the anti-sycophancy audit isn't run on the weakest model.
    const p = makePersona({ id: "skeptic" });
    const result = resolveProposerModelConfig(p, defaultWorker, baseSettings);
    expect(result.tier).toBe("balanced");
  });

  it("an explicit stronger persona modelTier still wins over the R5 floor", () => {
    // The floor only bumps a would-be "fast" reviewer; a persona that
    // explicitly asked for "frontier" is honored unchanged.
    const p = makePersona({ id: "skeptic", modelTier: "frontier" });
    const result = resolveProposerModelConfig(p, defaultWorker, baseSettings);
    expect(result.tier).toBe("frontier");
  });

  it("falls back to defaultWorkerConfig when no tier configuration exists", () => {
    const p = makePersona();
    const result = resolveProposerModelConfig(p, defaultWorker, baseSettings);
    expect(result.config).toBe(defaultWorker);
  });

  it("uses a configured tier model when present", () => {
    const balancedModel: ModelConfig = {
      provider: "anthropic",
      model: "claude-3-5-haiku",
      apiKey: "sk-bal",
    };
    const s = makeSettings({
      proposerTiers: {
        balanced: balancedModel,
      },
    } as Partial<AppSettings>);
    const p = makePersona({ id: "skeptic" }); // → reviewer → floored to "balanced" (R5)
    const result = resolveProposerModelConfig(p, defaultWorker, s);
    expect(result.config.model).toBe("claude-3-5-haiku");
    expect(result.tier).toBe("balanced");
  });

  it("falls back to default when the selected tier has an empty `model`", () => {
    const s = makeSettings({
      proposerTiers: {
        balanced: { provider: "anthropic", model: "" } as ModelConfig,
      },
    } as Partial<AppSettings>);
    const p = makePersona({ id: "skeptic" }); // → reviewer → floored to "balanced" (R5)
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

// ── DDD Sprint 8 (corrected) — in-breed sycophancy ADVISORY ───────────────────
// The forced Tripartite (three distinct providers, auto-switch the Skeptic) was
// rejected; these pin the advisory-only replacement: a model-FAMILY heuristic
// plus a pure overlap detector whose output moa.ts warns with (once) and
// NEVER acts on.
describe("modelFamily — vendor family heuristic (S8 advisory)", () => {
  it("direct cloud providers ARE the family", async () => {
    const { modelFamily } = await import("@/lib/agent/moa-personas");
    expect(modelFamily({ provider: "anthropic" as const, model: "claude-opus-4-8" })).toBe("anthropic");
    expect(modelFamily({ provider: "openai" as const, model: "gpt-4o" })).toBe("openai");
    expect(modelFamily({ provider: "google" as const, model: "gemini-2.5-pro" })).toBe("google");
  });

  it("OpenRouter path-prefixed ids take the vendor prefix (provider alone would be wrong)", async () => {
    const { modelFamily } = await import("@/lib/agent/moa-personas");
    expect(modelFamily({ provider: "openrouter" as const, model: "deepseek/deepseek-v4-flash" })).toBe("deepseek");
    expect(modelFamily({ provider: "openrouter" as const, model: "anthropic/claude-opus-4-8" })).toBe("anthropic");
  });

  it("local/self-hosted ids take the leading alpha run", async () => {
    const { modelFamily } = await import("@/lib/agent/moa-personas");
    expect(modelFamily({ provider: "ollama" as const, model: "qwen2.5:7b" })).toBe("qwen");
    expect(modelFamily({ provider: "vllm" as const, model: "llama-3-8b-instruct" })).toBe("llama");
  });

  it("degrades to the provider (or 'unknown') when the model id has no usable shape", async () => {
    const { modelFamily } = await import("@/lib/agent/moa-personas");
    expect(modelFamily({ provider: "custom" as const, model: "123" })).toBe("custom");
    expect(modelFamily({ provider: "" as unknown as import("@/lib/types").ModelConfig["provider"], model: "" })).toBe("unknown");
  });
});

describe("detectSkepticFamilyOverlap — advisory text, never a gate", () => {
  const or = (model: string) => ({ provider: "openrouter" as const, model });

  it("all three on one family → strongest advisory naming the family", async () => {
    const { detectSkepticFamilyOverlap } = await import("@/lib/agent/moa-personas");
    const msg = detectSkepticFamilyOverlap({
      skeptic: or("deepseek/deepseek-v4-flash"),
      worker: or("deepseek/deepseek-chat"),
      brain: or("deepseek/deepseek-v4-flash"),
    });
    expect(msg).toContain('"deepseek"');
    expect(msg).toContain("Skeptic, workers AND orchestrator");
    expect(msg).toContain("Advisory only");
  });

  it("skeptic matches only the workers → workers-specific advisory", async () => {
    const { detectSkepticFamilyOverlap } = await import("@/lib/agent/moa-personas");
    const msg = detectSkepticFamilyOverlap({
      skeptic: or("qwen/qwen3-coder"),
      worker: or("qwen/qwen-2.5-72b"),
      brain: or("deepseek/deepseek-v4-flash"),
    });
    expect(msg).toContain("as the workers");
  });

  it("skeptic matches only the orchestrator → orchestrator-specific advisory", async () => {
    const { detectSkepticFamilyOverlap } = await import("@/lib/agent/moa-personas");
    const msg = detectSkepticFamilyOverlap({
      skeptic: or("deepseek/deepseek-v4-flash"),
      worker: or("qwen/qwen-2.5-72b"),
      brain: or("deepseek/deepseek-chat"),
    });
    expect(msg).toContain("orchestrator/synthesizer");
  });

  it("three distinct families → null (no advisory)", async () => {
    const { detectSkepticFamilyOverlap } = await import("@/lib/agent/moa-personas");
    expect(
      detectSkepticFamilyOverlap({
        skeptic: { provider: "anthropic" as const, model: "claude-opus-4-8" },
        worker: or("qwen/qwen-2.5-72b"),
        brain: or("deepseek/deepseek-v4-flash"),
      })
    ).toBeNull();
  });

  it("cross-provider but SAME family is still flagged (openrouter anthropic/* vs direct anthropic)", async () => {
    const { detectSkepticFamilyOverlap } = await import("@/lib/agent/moa-personas");
    const msg = detectSkepticFamilyOverlap({
      skeptic: or("anthropic/claude-opus-4-8"),
      worker: or("qwen/qwen-2.5-72b"),
      brain: { provider: "anthropic" as const, model: "claude-sonnet-5" },
    });
    expect(msg).toContain('"anthropic"');
  });
});
