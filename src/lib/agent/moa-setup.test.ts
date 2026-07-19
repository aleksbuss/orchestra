/**
 * Unit tests for `resolveEnsembleSetup` (moa-setup.ts) — the pure per-run
 * derivations extracted from `runMoAEnsemble` (Sprint 5 §10). These pin the
 * deterministic logic that was previously only exercised indirectly through the
 * full ensemble: the maxSwarmSize clamp (R4 invariant), the reflection-toggle
 * precedence (A8), the proposer-safe history filter, and the router-model
 * fallback. Real deps (resolveWorkerKey / resolveSkepticModelConfig /
 * isSearchUsable / createWindowResolver) run unmocked against a fixture — same
 * as the ensemble does in moa.test.ts.
 */
import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import type { AppSettings } from "@/lib/types";
import { resolveEnsembleSetup } from "./moa-setup";

function fakeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    chatModel: { provider: "openai", model: "gpt-4o", apiKey: "k", authMethod: "api_key" },
    utilityModel: { provider: "openai", model: "gpt-4o-mini", apiKey: "k" },
    embeddingsModel: { provider: "openai", model: "text-embedding-3-small", dimensions: 1536 },
    codeExecution: { enabled: true, timeout: 600, maxOutputLength: 120000 },
    memory: { enabled: true, similarityThreshold: 0.35, maxResults: 10, chunkSize: 400 },
    search: { enabled: false, provider: "none" },
    general: { darkMode: false, language: "en" },
    auth: {
      enabled: true,
      username: "admin",
      passwordHash: "scrypt$x$y",
      mustChangeCredentials: false,
    },
    ...overrides,
  } as AppSettings;
}

const setup = (overrides: Partial<AppSettings> = {}, extra: Record<string, unknown> = {}) =>
  resolveEnsembleSetup({ settings: fakeSettings(overrides), history: [], ...extra });

describe("resolveEnsembleSetup — maxSwarmSize clamp (R4: Router zod .min(3).max(N))", () => {
  it("defaults to 5 when unset (non-finite)", () => {
    expect(setup().maxSwarmSize).toBe(5);
  });
  it("clamps below-range up to the floor of 3", () => {
    expect(setup({ maxSwarmSize: 2 } as Partial<AppSettings>).maxSwarmSize).toBe(3);
    expect(setup({ maxSwarmSize: 0 } as Partial<AppSettings>).maxSwarmSize).toBe(3);
  });
  it("clamps above-range down to the ceiling of 7", () => {
    expect(setup({ maxSwarmSize: 9 } as Partial<AppSettings>).maxSwarmSize).toBe(7);
  });
  it("floors a fractional value", () => {
    expect(setup({ maxSwarmSize: 4.7 } as Partial<AppSettings>).maxSwarmSize).toBe(4);
  });
  it("falls back to 5 on NaN / a corrupt non-numeric value", () => {
    expect(setup({ maxSwarmSize: NaN } as Partial<AppSettings>).maxSwarmSize).toBe(5);
    expect(setup({ maxSwarmSize: "5" as unknown as number } as Partial<AppSettings>).maxSwarmSize).toBe(5);
  });
});

describe("resolveEnsembleSetup — reflectionEnabled precedence (A8: deepAudit > settings > false)", () => {
  it("deepAudit=true wins even when settings.reflection is OFF/absent", () => {
    expect(setup({}, { deepAudit: true }).reflectionEnabled).toBe(true);
  });
  it("deepAudit=false wins even when settings.reflection is ON", () => {
    expect(
      setup({ reflection: { enabled: true } } as Partial<AppSettings>, { deepAudit: false }).reflectionEnabled
    ).toBe(false);
  });
  it("falls through to settings.reflection.enabled when deepAudit is undefined", () => {
    expect(setup({ reflection: { enabled: true } } as Partial<AppSettings>).reflectionEnabled).toBe(true);
  });
  it("defaults to false when neither is set", () => {
    expect(setup().reflectionEnabled).toBe(false);
  });
});

describe("resolveEnsembleSetup — safeHistory filter (drop tool-call sequences)", () => {
  it("keeps user turns and string-content assistant turns; drops the rest", () => {
    const history: ModelMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "a string reply" },
      { role: "assistant", content: [{ type: "text", text: "array content" }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "t", toolName: "x", output: { type: "text", value: "r" } }] },
      { role: "system", content: "system note" },
    ];
    const { safeHistory } = resolveEnsembleSetup({ settings: fakeSettings(), history });
    expect(safeHistory).toHaveLength(2);
    expect(safeHistory[0]).toMatchObject({ role: "user", content: "hello" });
    expect(safeHistory[1]).toMatchObject({ role: "assistant", content: "a string reply" });
  });
});

describe("resolveEnsembleSetup — router model fallback (utilityModel → chatModel)", () => {
  it("uses utilityModel when it carries a model string", () => {
    expect(setup().routerConfig.model).toBe("gpt-4o-mini");
  });
  it("falls back to chatModel when utilityModel has no model string", () => {
    const { routerConfig } = setup({
      utilityModel: { provider: "openai", model: "" },
    } as Partial<AppSettings>);
    expect(routerConfig.model).toBe("gpt-4o");
  });
});

describe("resolveEnsembleSetup — wiring of remaining derivations", () => {
  it("searchEnabled reflects isSearchUsable (disabled fixture → false)", () => {
    expect(setup().searchEnabled).toBe(false);
  });
  it("resolveWindow is a memoized resolver function; workerConfig is resolved", () => {
    const s = setup();
    expect(typeof s.resolveWindow).toBe("function");
    expect(s.workerConfig.model).toBe("gpt-4o-mini"); // preset undefined → utilityModel
    // skepticConfig is resolved (may be undefined when no operator override/tier is set).
    expect("skepticConfig" in s).toBe(true);
  });
});
