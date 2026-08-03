import { describe, it, expect, beforeEach } from "vitest";
import {
  selectFreeModels,
  applyFreeMode,
  isFreeModeEnabled,
  describeFreeModeSelection,
  FREE_ROUTER_FALLBACKS,
} from "./free-mode";
import {
  __setOpenRouterSupportedParametersForTest,
  __resetOpenRouterPricingForTests,
} from "@/lib/cost/openrouter-pricing";
import type { AppSettings } from "@/lib/types";

/** Minimal settings — only what Free Mode reads or overlays. */
function settings(over: Partial<AppSettings> = {}): AppSettings {
  return {
    chatModel: { provider: "anthropic", model: "claude-paid" },
    utilityModel: { provider: "anthropic", model: "claude-paid-utility" },
    embeddingsModel: { provider: "openai", model: "text-embedding-3-small" },
    ...over,
  } as AppSettings;
}

function seedCatalogue(entries: Array<[string, string[]]>) {
  __setOpenRouterSupportedParametersForTest(new Map(entries));
}

describe("Free Mode — model selection", () => {
  beforeEach(() => {
    __resetOpenRouterPricingForTests();
  });

  it("falls back to the curated list when the catalogue has not loaded", () => {
    const s = selectFreeModels();
    expect(s.source).toBe("fallback-list");
    expect(s.candidateCount).toBe(0);
    expect(FREE_ROUTER_FALLBACKS).toContain(s.utilityModel.model);
    expect(s.chatModel.provider).toBe("openrouter");
  });

  it("picks a structured-output model for the Router when one exists", () => {
    seedCatalogue([
      ["vendor/plain:free", ["tools"]],
      ["vendor/structured:free", ["tools", "structured_outputs"]],
      ["vendor/paid", ["tools", "structured_outputs"]],
    ]);
    const s = selectFreeModels();
    expect(s.source).toBe("live-catalogue");
    expect(s.utilityModel.model).toBe("vendor/structured:free");
    expect(s.routerSupportsStructuredOutputs).toBe(true);
  });

  it("never selects a paid model, even when it is the only capable one", () => {
    seedCatalogue([
      ["vendor/plain:free", ["tools"]],
      ["vendor/paid", ["structured_outputs"]],
    ]);
    const s = selectFreeModels();
    // No free model advertises structured outputs -> fall back to the curated
    // FREE list rather than reaching for the capable PAID model. Free Mode
    // exists because $0 is a hard constraint; silently billing would break it.
    expect(s.utilityModel.model).not.toBe("vendor/paid");
    expect(FREE_ROUTER_FALLBACKS).toContain(s.utilityModel.model);
    expect(s.routerSupportsStructuredOutputs).toBe(false);
  });

  it("flags a Router without structured outputs instead of failing silently", () => {
    seedCatalogue([["vendor/plain:free", ["tools"]]]);
    const s = selectFreeModels();
    expect(s.routerSupportsStructuredOutputs).toBe(false);
    expect(describeFreeModeSelection(s)).toContain("NO structured_outputs");
  });

  it("spreads the proposer tiers across distinct endpoints when it can", () => {
    seedCatalogue([
      ["v/a:free", ["structured_outputs"]],
      ["v/b:free", ["tools"]],
      ["v/c:free", ["tools"]],
      ["v/d:free", ["tools"]],
    ]);
    const s = selectFreeModels();
    const tiers = [
      s.proposerTiers.fast.model,
      s.proposerTiers.balanced.model,
      s.proposerTiers.frontier.model,
    ];
    expect(new Set(tiers).size).toBe(3);
    expect(s.endpointSpread).toBe(3);
    // The brain's endpoint should not also be the first proposer's — the
    // rotation exists so the brain's quota is not the first one hammered.
    expect(tiers[0]).not.toBe(s.chatModel.model);
  });

  it("degrades to reuse when the pool is smaller than the tier count", () => {
    seedCatalogue([["v/only:free", ["structured_outputs"]]]);
    const s = selectFreeModels();
    expect(s.endpointSpread).toBe(1);
    expect(s.proposerTiers.fast.model).toBe("v/only:free");
  });

  it("is deterministic across calls for the same catalogue", () => {
    seedCatalogue([
      ["v/b:free", ["tools"]],
      ["v/a:free", ["structured_outputs"]],
      ["v/c:free", ["tools"]],
    ]);
    expect(selectFreeModels()).toEqual(selectFreeModels());
  });

  it("emits provider+model only — never a key or a baseUrl", () => {
    seedCatalogue([["v/a:free", ["structured_outputs"]]]);
    const s = selectFreeModels();
    for (const c of [s.chatModel, s.utilityModel, ...Object.values(s.proposerTiers)]) {
      expect(Object.keys(c).sort()).toEqual(["model", "provider"]);
    }
  });
});

describe("Free Mode — applying the overlay", () => {
  beforeEach(() => {
    __resetOpenRouterPricingForTests();
    seedCatalogue([
      ["v/a:free", ["structured_outputs"]],
      ["v/b:free", ["tools"]],
      ["v/c:free", ["tools"]],
    ]);
  });

  it("returns settings untouched when Free Mode is off", () => {
    const base = settings();
    const out = applyFreeMode(base);
    expect(out.settings).toBe(base);
    expect(out.selection).toBeNull();
    expect(isFreeModeEnabled(base)).toBe(false);
  });

  it("overlays chat, utility and proposer tiers when on", () => {
    const out = applyFreeMode(settings({ freeMode: { enabled: true } }));
    expect(out.selection).not.toBeNull();
    expect(out.settings.chatModel.provider).toBe("openrouter");
    expect(out.settings.chatModel.model).toMatch(/:free$/);
    expect(out.settings.utilityModel?.model).toMatch(/:free$/);
    expect(out.settings.proposerTiers?.fast?.model).toMatch(/:free$/);
  });

  it("does NOT mutate the caller's settings object", () => {
    const base = settings({ freeMode: { enabled: true } });
    applyFreeMode(base);
    expect(base.chatModel.model).toBe("claude-paid");
  });

  it("yields to Privacy Mode and reports the conflict", () => {
    const base = settings({
      freeMode: { enabled: true },
      privacyMode: { enabled: true },
    });
    const out = applyFreeMode(base);
    // Privacy Mode forbids cloud egress; Free Mode means OpenRouter. Silently
    // swapping in a cloud model here would turn a privacy guarantee into a
    // privacy breach, so the overlay yields — loudly, never silently.
    expect(out.settings).toBe(base);
    expect(out.selection).toBeNull();
    expect(out.suppressedByPrivacyMode).toBe(true);
    expect(out.settings.chatModel.model).toBe("claude-paid");
  });

  it("preserves a pinned Skeptic — who audits is orthogonal to tier models", () => {
    const out = applyFreeMode(
      settings({
        freeMode: { enabled: true },
        proposerTiers: { skeptic: { provider: "anthropic", model: "sonnet-pinned" } },
      })
    );
    expect(out.settings.proposerTiers?.skeptic?.model).toBe("sonnet-pinned");
    expect(out.settings.proposerTiers?.fast?.model).toMatch(/:free$/);
  });
});
