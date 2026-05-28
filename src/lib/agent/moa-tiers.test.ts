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
      proposerTiers: { fast: fastConfig },
    });
    // skepticPersona role keywords ("review", "red-team") → reviewer → fast
    const { config, tier } = resolveProposerModelConfig(
      skepticPersona,
      defaultWorker,
      settings
    );
    expect(config.provider).toBe("anthropic");
    expect(config.model).toBe("claude-haiku-4-5-20251001");
    expect(tier).toBe("fast");
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
      proposerTiers: { fast: emptyTier },
    });
    const { config, tier } = resolveProposerModelConfig(
      skepticPersona,
      defaultWorker,
      settings
    );
    expect(config).toBe(defaultWorker);
    expect(tier).toBe("fast");
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
      proposerTiers: { fast: partialTier },
    });
    const { config, tier } = resolveProposerModelConfig(
      skepticPersona,
      defaultWorker,
      settings
    );
    expect(tier).toBe("fast");
    // resolveWorkerKey backfills the chatModel apiKey for matching-provider tiers
    expect(config.apiKey).toBe("chat-key");
    expect(config.model).toBe("gpt-4o-mini");
  });

  it("heterogeneous tiers across providers are preserved (Anthropic fast + local frontier)", () => {
    const settings = fakeSettings({
      proposerTiers: {
        fast: {
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
