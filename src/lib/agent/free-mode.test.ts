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

  // ── PM #98 — the brain slot is the thing that calls tools ────────────────
  // These four are the regression: the brain used to be `[0]` of an
  // ALPHABETICALLY sorted catalogue, so `google/gemma-4-…` won the slot on the
  // letter "g", `agent.ts` dropped to plain-chat mode, and a web-search
  // question was answered from stale weights with no tool call attempted.

  it("does not hand the brain to a tool-incapable model just because it sorts first", () => {
    seedCatalogue([
      // Alphabetically first AND structured-output capable — it won both of
      // the old heuristics. It matches `gemma-` in NO_TOOL_PATTERNS.
      ["google/gemma-4-26b-a4b-it:free", ["structured_outputs"]],
      ["nvidia/nemotron-nano-9b-v2:free", ["tools", "structured_outputs"]],
    ]);
    const s = selectFreeModels();
    expect(s.chatModel.model).toBe("nvidia/nemotron-nano-9b-v2:free");
    expect(s.brainSupportsTools).toBe(true);
  });

  it("prefers tools over structured outputs when it cannot have both", () => {
    seedCatalogue([
      ["google/gemma-4-26b-a4b-it:free", ["structured_outputs"]],
      ["nvidia/nemotron-nano-9b-v2:free", ["tools"]],
    ]);
    const s = selectFreeModels();
    // Losing tools loses web search and every file operation; losing structured
    // outputs on the BRAIN loses almost nothing, since `generateObject` is the
    // Router's job and the Router has its own slot.
    expect(s.chatModel.model).toBe("nvidia/nemotron-nano-9b-v2:free");
    expect(s.utilityModel.model).toBe("google/gemma-4-26b-a4b-it:free");
  });

  it("still runs — loudly — when NO free model supports tools", () => {
    seedCatalogue([
      ["google/gemma-4-26b-a4b-it:free", ["structured_outputs"]],
      ["mistralai/mistral-small:free", ["structured_outputs"]],
    ]);
    const s = selectFreeModels();
    // Honesty over exclusion: a filter here would empty the pool and hard-fail
    // Free Mode. We keep the model and report the degradation instead.
    expect(s.chatModel.model).toMatch(/:free$/);
    expect(s.brainSupportsTools).toBe(false);
    const described = describeFreeModeSelection(s);
    expect(described).toContain("NO tool support");
    expect(described).toContain("knowledge only");
  });

  it("keeps the brain's endpoint out of the first proposer slot when the brain is not pool[0]", () => {
    seedCatalogue([
      ["google/gemma-4-26b-a4b-it:free", ["tools"]], // sorts first, no tools
      ["nvidia/a:free", ["tools"]],
      ["nvidia/b:free", ["tools"]],
      ["nvidia/c:free", ["tools"]],
    ]);
    const s = selectFreeModels();
    // Rotation is by the BRAIN'S INDEX, not a hardcoded 1 — with the brain no
    // longer at position 0, rotating by 1 would have put it back in `fast`.
    expect(s.chatModel.model).toBe("nvidia/a:free");
    expect(s.proposerTiers.fast.model).not.toBe(s.chatModel.model);
  });

  it("puts a tool-capable model in the brain slot on the fallback path too", () => {
    // No catalogue at all — cold boot, no network, or Privacy Mode suppressed
    // the refresh. The curated list is ordered tool-capable-first for this.
    const s = selectFreeModels();
    expect(s.source).toBe("fallback-list");
    expect(s.brainSupportsTools).toBe(true);
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
