/**
 * PM #48 — Per-role tier model routing.
 *
 * Scope: pin the two pure helpers (`deriveTierFromRole`,
 * `resolveProposerModelConfig`) that decide which `ModelConfig` each
 * proposer actually uses. These are the chokepoints that determine
 * whether a Skeptic runs on a cheap fast model and a Coder runs on a
 * frontier model. Full ensemble dispatch is covered by `moa.test.ts`;
 * this file isolates the routing logic without the SDK mocks.
 *
 * Why a separate file: keeps `moa.test.ts` from growing beyond the
 * already-large suite, and lets these tests run without any of the AI
 * SDK / event-bus / semaphore module mocks the ensemble tests require.
 */
import { describe, it, expect } from "vitest";
import {
  deriveTierFromRole,
  resolveProposerModelConfig,
  resolveSkepticModelConfig,
  isValidSkepticOverride,
  type MoAProposer,
} from "./moa";
import type { AppSettings, ModelConfig } from "@/lib/types";

function fakeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    chatModel: {
      provider: "openai",
      model: "gpt-4o",
      apiKey: "chat-key",
      authMethod: "api_key",
    },
    utilityModel: { provider: "openai", model: "gpt-4o-mini", apiKey: "util-key" },
    embeddingsModel: {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
    },
    codeExecution: { enabled: true, timeout: 600, maxOutputLength: 120000 },
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
    ...overrides,
  };
}

const defaultWorker: ModelConfig = {
  provider: "openai",
  model: "gpt-4o-mini",
  apiKey: "worker-key",
};

describe("deriveTierFromRole — role → tier mapping (PM #48)", () => {
  it("maps reviewer → fast (cheap critique work)", () => {
    expect(deriveTierFromRole("reviewer")).toBe("fast");
  });

  it("maps researcher → balanced (clarity over depth)", () => {
    expect(deriveTierFromRole("researcher")).toBe("balanced");
  });

  it("maps tool → balanced (implementer, no design)", () => {
    expect(deriveTierFromRole("tool")).toBe("balanced");
  });

  it("maps coder → frontier (synthesis-heavy work)", () => {
    expect(deriveTierFromRole("coder")).toBe("frontier");
  });

  it("maps orchestrator → balanced (conservative default for unused-in-MoA role)", () => {
    expect(deriveTierFromRole("orchestrator")).toBe("balanced");
  });
});

describe("resolveProposerModelConfig — config selection (PM #48)", () => {
  const coderPersona: MoAProposer = {
    id: "coder-1",
    role: "Senior Coder",
    color: "violet",
    systemPrompt: "Write code with thorough design.",
  };

  const skepticPersona: MoAProposer = {
    id: "qa",
    role: "Adversarial Reviewer",
    color: "rose",
    systemPrompt: "Find faults and red-team this.",
  };

  it("no proposerTiers configured → falls back to defaultWorker (pre-PM-48 behavior)", () => {
    const settings = fakeSettings();
    const { config, tier } = resolveProposerModelConfig(
      coderPersona,
      defaultWorker,
      settings
    );
    expect(config).toBe(defaultWorker);
    expect(tier).toBe("frontier"); // derived from coder role
  });

  it("proposerTiers configured but slot for derived tier missing → falls back to defaultWorker", () => {
    const settings = fakeSettings({
      proposerTiers: {
        fast: {
          provider: "anthropic",
          model: "claude-haiku-4-5-20251001",
          apiKey: "anth-key",
        },
        // balanced + frontier left unset
      },
    });
    // coderPersona derives 'frontier' tier, which is unset → defaultWorker
    const { config, tier } = resolveProposerModelConfig(
      coderPersona,
      defaultWorker,
      settings
    );
    expect(config).toBe(defaultWorker);
    expect(tier).toBe("frontier");
  });

  it("derived tier slot configured → uses tier config", () => {
    const fastConfig: ModelConfig = {
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      apiKey: "anth-key",
    };
    const settings = fakeSettings({
      proposerTiers: { balanced: fastConfig },
    });
    // skepticPersona → reviewer → floored to "balanced" (R5); its tier config is used.
    const { config, tier } = resolveProposerModelConfig(
      skepticPersona,
      defaultWorker,
      settings
    );
    expect(config.provider).toBe("anthropic");
    expect(config.model).toBe("claude-haiku-4-5-20251001");
    expect(tier).toBe("balanced");
  });

  it("explicit persona.modelTier overrides role-derived tier", () => {
    const fastConfig: ModelConfig = {
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      apiKey: "anth-key",
    };
    const frontierConfig: ModelConfig = {
      provider: "anthropic",
      model: "claude-opus-4-7",
      apiKey: "anth-key",
    };
    const settings = fakeSettings({
      proposerTiers: { fast: fastConfig, frontier: frontierConfig },
    });
    // coderPersona would normally derive 'frontier', but explicit override → 'fast'
    const override: MoAProposer = { ...coderPersona, modelTier: "fast" };
    const { config, tier } = resolveProposerModelConfig(
      override,
      defaultWorker,
      settings
    );
    expect(config.model).toBe("claude-haiku-4-5-20251001");
    expect(tier).toBe("fast");
  });

  it("tier slot exists but model field empty → falls back to defaultWorker", () => {
    const emptyTier: ModelConfig = {
      provider: "anthropic",
      model: "", // operator left blank in UI
      apiKey: "anth-key",
    };
    const settings = fakeSettings({
      proposerTiers: { balanced: emptyTier },
    });
    const { config, tier } = resolveProposerModelConfig(
      skepticPersona,
      defaultWorker,
      settings
    );
    expect(config).toBe(defaultWorker);
    expect(tier).toBe("balanced"); // reviewer floored to balanced (R5)
  });

  // ── proposerTiers.skepticTier — the effect of the "Deep Audit Mode (Skeptic)"
  // UI selector (settings page). It writes settings.proposerTiers.skepticTier;
  // these pin that the Skeptic (reviewer role) actually routes to the chosen
  // tier and that the choice is honored OVER the R5 balanced-floor. Regression
  // guard for the feature "give the Skeptic a smarter model."
  it("skepticTier='frontier' routes the Skeptic to the frontier tier (selector honored)", () => {
    const frontierConfig: ModelConfig = {
      provider: "anthropic",
      model: "claude-opus-4-8",
      apiKey: "anth-key",
    };
    const settings = fakeSettings({
      proposerTiers: { skepticTier: "frontier", frontier: frontierConfig },
    });
    const { config, tier } = resolveProposerModelConfig(
      skepticPersona,
      defaultWorker,
      settings
    );
    expect(tier).toBe("frontier");
    expect(config.model).toBe("claude-opus-4-8");
  });

  it("skepticTier='fast' is honored — an EXPLICIT cheap choice bypasses the R5 balanced-floor", () => {
    // The R5 floor only bumps a would-be "fast" reviewer when the operator made
    // no explicit choice. skepticTier='fast' is explicit → floor must NOT fire.
    const fastConfig: ModelConfig = {
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      apiKey: "anth-key",
    };
    const settings = fakeSettings({
      proposerTiers: { skepticTier: "fast", fast: fastConfig },
    });
    const { config, tier } = resolveProposerModelConfig(
      skepticPersona,
      defaultWorker,
      settings
    );
    expect(tier).toBe("fast"); // NOT floored to balanced — operator's choice wins
    expect(config.model).toBe("claude-haiku-4-5-20251001");
  });

  it("skepticTier applies ONLY to the reviewer role — a coder ignores it", () => {
    const frontierConfig: ModelConfig = {
      provider: "anthropic",
      model: "claude-opus-4-8",
      apiKey: "anth-key",
    };
    const settings = fakeSettings({
      // skepticTier set to 'fast', but coder must still derive 'frontier'.
      proposerTiers: { skepticTier: "fast", frontier: frontierConfig },
    });
    const { config, tier } = resolveProposerModelConfig(
      coderPersona,
      defaultWorker,
      settings
    );
    expect(tier).toBe("frontier"); // skepticTier did NOT bleed into a non-reviewer
    expect(config.model).toBe("claude-opus-4-8");
  });

  it("skepticTier selects a tier with NO model configured → selector is inert, falls back to defaultWorker", () => {
    // Documents the current UI gap: the selector picks a tier LABEL, but there
    // is no UI to set the ModelConfig behind fast/balanced/frontier. Choosing
    // 'frontier' with proposerTiers.frontier unset yields the default worker.
    const settings = fakeSettings({
      proposerTiers: { skepticTier: "frontier" }, // no frontier ModelConfig
    });
    const { config, tier } = resolveProposerModelConfig(
      skepticPersona,
      defaultWorker,
      settings
    );
    expect(tier).toBe("frontier");
    expect(config).toBe(defaultWorker); // inert until a tier model is configured
  });

  it("API-key inheritance: tier config without apiKey inherits chatModel.apiKey via resolveWorkerKey", () => {
    // Tier config has provider/model but no apiKey — operator expects to
    // inherit from chatModel. Same provider as chatModel → inherits.
    const partialTier: ModelConfig = {
      provider: "openai",
      model: "gpt-4o-mini",
      apiKey: "",
    };
    const settings = fakeSettings({
      proposerTiers: { balanced: partialTier },
    });
    const { config, tier } = resolveProposerModelConfig(
      skepticPersona,
      defaultWorker,
      settings
    );
    expect(tier).toBe("balanced"); // reviewer floored to balanced (R5)
    // resolveWorkerKey backfills the chatModel apiKey for matching-provider tiers
    expect(config.apiKey).toBe("chat-key");
    expect(config.model).toBe("gpt-4o-mini");
  });

  it("heterogeneous tiers across providers are preserved (Anthropic balanced + local frontier)", () => {
    const settings = fakeSettings({
      proposerTiers: {
        // reviewer floors to "balanced" (R5), so configure the anthropic model there
        balanced: {
          provider: "anthropic",
          model: "claude-haiku-4-5-20251001",
          apiKey: "anth-key",
        },
        frontier: {
          provider: "ollama",
          model: "qwen2.5-coder:32b",
          baseUrl: "http://localhost:11434",
        },
      },
    });
    const reviewer = resolveProposerModelConfig(
      skepticPersona,
      defaultWorker,
      settings
    );
    const coder = resolveProposerModelConfig(coderPersona, defaultWorker, settings);
    expect(reviewer.config.provider).toBe("anthropic");
    expect(coder.config.provider).toBe("ollama");
    expect(coder.config.baseUrl).toBe("http://localhost:11434");
  });
});

describe("DDD — direct Skeptic model (resolveSkepticModelConfig + surface-1)", () => {
  const skepticPersona: MoAProposer = {
    id: "qa",
    role: "Adversarial Reviewer",
    color: "rose",
    systemPrompt: "Find faults and red-team this.",
  };
  const coderPersona: MoAProposer = {
    id: "coder-1",
    role: "Senior Coder",
    color: "violet",
    systemPrompt: "Write code with thorough design.",
  };

  it("nothing configured → undefined (callers keep pre-existing behavior)", () => {
    expect(resolveSkepticModelConfig(fakeSettings())).toBeUndefined();
  });

  it("settings slot set → returned with API-key inheritance (resolveWorkerKey)", () => {
    const settings = fakeSettings({
      proposerTiers: {
        skeptic: { provider: "openai", model: "o4-skeptic" },
      },
    });
    const cfg = resolveSkepticModelConfig(settings);
    expect(cfg?.model).toBe("o4-skeptic");
    // No apiKey on the slot → inherits chatModel key (same provider).
    expect(cfg?.apiKey).toBe("chat-key");
  });

  it("empty-model settings slot is inert → undefined", () => {
    const settings = fakeSettings({
      proposerTiers: { skeptic: { provider: "openai", model: "  " } },
    });
    expect(resolveSkepticModelConfig(settings)).toBeUndefined();
  });

  it("per-request override beats the settings slot", () => {
    const settings = fakeSettings({
      proposerTiers: {
        skeptic: { provider: "openai", model: "settings-skeptic" },
      },
    });
    const cfg = resolveSkepticModelConfig(settings, {
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
    expect(cfg?.provider).toBe("anthropic");
    expect(cfg?.model).toBe("claude-haiku-4-5");
  });

  it("INVALID per-request override (smuggled apiKey) is ignored → settings slot wins", () => {
    const settings = fakeSettings({
      proposerTiers: {
        skeptic: { provider: "openai", model: "settings-skeptic" },
      },
    });
    const hostile = {
      provider: "openrouter",
      model: "x",
      apiKey: "stolen",
    } as unknown as Parameters<typeof resolveSkepticModelConfig>[1];
    const cfg = resolveSkepticModelConfig(settings, hostile);
    expect(cfg?.model).toBe("settings-skeptic");
  });

  it("isValidSkepticOverride — boundary validator accepts ONLY {provider, model}", () => {
    expect(isValidSkepticOverride({ provider: "openrouter", model: "deepseek/x" })).toBe(true);
    expect(isValidSkepticOverride({ provider: "ollama", model: "qwen3:8b" })).toBe(true);
    // Injection shapes → rejected.
    expect(isValidSkepticOverride({ provider: "openrouter", model: "x", apiKey: "k" })).toBe(false);
    expect(isValidSkepticOverride({ provider: "custom", model: "x", baseUrl: "http://169.254.169.254" })).toBe(false);
    // Garbage shapes → rejected (route must 400, not throw mid-swarm).
    expect(isValidSkepticOverride({ provider: "not-a-provider", model: "x" })).toBe(false);
    expect(isValidSkepticOverride({ provider: "openai", model: "" })).toBe(false);
    expect(isValidSkepticOverride({ provider: "openai" })).toBe(false);
    expect(isValidSkepticOverride("openai/gpt-4o")).toBe(false);
    expect(isValidSkepticOverride(null)).toBe(false);
  });

  it("surface 1: reviewer gets the resolved skeptic config OUTRIGHT — beats sandbox AND skepticTier (A10, deliberate)", () => {
    const settings = fakeSettings({
      swarmSandbox: { reviewer: "fast" },
      proposerTiers: {
        fast: { provider: "openai", model: "fast-model", apiKey: "f" },
        frontier: { provider: "openai", model: "frontier-model", apiKey: "fr" },
        skepticTier: "frontier",
        skeptic: { provider: "anthropic", model: "operator-skeptic", apiKey: "a" },
      },
    });
    const resolved = resolveSkepticModelConfig(settings);
    const { config } = resolveProposerModelConfig(
      skepticPersona,
      defaultWorker,
      settings,
      resolved
    );
    expect(config.provider).toBe("anthropic");
    expect(config.model).toBe("operator-skeptic");
  });

  it("surface 1 (C2): tier LABEL is the honestly-resolved tier, not hardcoded 'frontier'", () => {
    // Operator pinned the reviewer role to the 'fast' sandbox tier AND set a
    // direct skeptic model. The CONFIG must be the override (precedence), but
    // the telemetry `tier` must reflect the resolved tier ('fast'), not a
    // cosmetic 'frontier' that mislabels a cheap skeptic in the DAG.
    const settings = fakeSettings({
      swarmSandbox: { reviewer: "fast" },
      proposerTiers: {
        skeptic: { provider: "ollama", model: "qwen3:1.7b", apiKey: "x" },
      },
    });
    const resolved = resolveSkepticModelConfig(settings);
    const { config, tier } = resolveProposerModelConfig(
      skepticPersona,
      defaultWorker,
      settings,
      resolved
    );
    expect(config.model).toBe("qwen3:1.7b"); // override wins the config
    expect(tier).toBe("fast"); // label honest, NOT "frontier"
  });

  it("surface 1: a coder persona IGNORES the skeptic config", () => {
    const settings = fakeSettings({
      proposerTiers: {
        skeptic: { provider: "anthropic", model: "operator-skeptic", apiKey: "a" },
      },
    });
    const resolved = resolveSkepticModelConfig(settings);
    const { config } = resolveProposerModelConfig(
      coderPersona,
      defaultWorker,
      settings,
      resolved
    );
    expect(config).toEqual(defaultWorker);
  });

  it("surface 1: no skeptic config passed → EXACT pre-change behavior (sandbox/skepticTier path)", () => {
    const settings = fakeSettings({
      proposerTiers: {
        frontier: { provider: "openai", model: "frontier-model", apiKey: "fr" },
        skepticTier: "frontier",
      },
    });
    const { config, tier } = resolveProposerModelConfig(
      skepticPersona,
      defaultWorker,
      settings,
      undefined
    );
    expect(tier).toBe("frontier");
    expect(config.model).toBe("frontier-model");
  });
});
