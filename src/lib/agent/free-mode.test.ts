import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  selectFreeModels,
  isGeneralChatModel,
  applyFreeMode,
  isFreeModeEnabled,
  describeFreeModeSelection,
  sortFreeModelsByScore,
  FREE_ROUTER_FALLBACKS,
} from "./free-mode";
import {
  __setOpenRouterSupportedParametersForTest,
  __setOpenRouterBenchmarkScoreForTest,
  __resetOpenRouterPricingForTests,
} from "@/lib/cost/openrouter-pricing";
import { resetModelHealth, recordModelFailure, isModelCircuitOpen } from "@/lib/agent/model-health";
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

  // ── PM #128 — the scoreless-pool → alphabetical Router bug ────────────────
  // Live, every structured-capable free id was UNSCORED (0/5 carried an
  // artificial_analysis intelligence score), so `sortFreeModelsByScore` fell to
  // its alphabetical tiebreak and seated a 2.6B (`liquid/lfm-2.5-2.6b`) as the
  // swarm Router ahead of a 120B — which returned requiresSwarm:false on hard
  // tasks and silently disabled the swarm.

  it("floors a KNOWN sub-8B id out of the Router slot even when it sorts first (PM #128)", () => {
    // All three structured+tools and ALL unscored → the sort is purely
    // alphabetical. This is the exact production pool (brain=dots-3, and without
    // the floor router=lfm-2.6b because `liquid/…` sorts right after it).
    seedCatalogue([
      ["dots-studio/dots-3-note-preview:free", ["tools", "structured_outputs"]],
      ["liquid/lfm-2.5-2.6b:free", ["tools", "structured_outputs"]],
      ["nvidia/nemotron-3-super-120b-a12b:free", ["tools", "structured_outputs"]],
    ]);
    const s = selectFreeModels();
    expect(s.utilityModel.model).not.toBe("liquid/lfm-2.5-2.6b:free");
    // the 120B is the only KNOWN-large structured id that is not the brain
    expect(s.utilityModel.model).toBe("nvidia/nemotron-3-super-120b-a12b:free");
    expect(s.routerFloorDroppedSmall).toBe(true);
    expect(describeFreeModeSelection(s)).toContain("floored out of the Router pool");
  });

  it("does not empty the Router pool when EVERY structured id is sub-8B — soft floor (PM #128)", () => {
    // A HARD floor would leave no Router on a bad catalogue week; the soft floor
    // falls back to the unfiltered pool rather than deadlock the slot.
    seedCatalogue([
      ["liquid/lfm-2.5-2.6b:free", ["tools", "structured_outputs"]],
      ["vendor/tiny-3b:free", ["tools", "structured_outputs"]],
    ]);
    const s = selectFreeModels();
    expect(s.utilityModel.model).toMatch(/:free$/);
    expect(s.routerSupportsStructuredOutputs).toBe(true);
  });

  it("seats the benchmark-scored ids over unscored ones once the null-intelligence fix lands them a score (PM #128)", () => {
    seedCatalogue([
      ["dots-studio/dots-3-note-preview:free", ["tools", "structured_outputs"]],
      ["z-ai/glm-5.2:free", ["tools", "structured_outputs"]],
      ["nvidia/nemotron-3-super-120b-a12b:free", ["tools", "structured_outputs"]],
    ]);
    // What the fixed ingestion produces from the live catalogue: agentic/coding
    // present, intelligence defaulted 0; dots-3 stays genuinely unscored.
    __setOpenRouterBenchmarkScoreForTest(
      new Map([
        ["z-ai/glm-5.2:free", { intelligence: 0, coding: 68.8, agentic: 39.7 }],
        ["nvidia/nemotron-3-super-120b-a12b:free", { intelligence: 0, coding: 37.7, agentic: 4.2 }],
      ])
    );
    const s = selectFreeModels();
    // brain = strongest structured+tools = glm-5.2 (agentic 39.7 > 4.2);
    // router = next = nemotron-120b. dots-3 (unscored) takes NEITHER slot.
    expect(s.chatModel.model).toBe("z-ai/glm-5.2:free");
    expect(s.utilityModel.model).toBe("nvidia/nemotron-3-super-120b-a12b:free");
  });
});

/**
 * PM #113 — the brain used to be picked by plain alphabetical sort with no
 * notion of capability. Live-verified real numbers (2026-08-30): a 550B free
 * model (`nvidia/nemotron-3-ultra-550b-a55b:free`) scores WORSE
 * (intelligence 38.3) than several smaller free models — this is why the
 * ranking metric is a measured score, not parameter count.
 */
describe("sortFreeModelsByScore — real benchmark data, strongest first", () => {
  const originalRank = process.env.ORCHESTRA_FREE_MODE_RANK;

  beforeEach(() => {
    __resetOpenRouterPricingForTests();
    delete process.env.ORCHESTRA_FREE_MODE_RANK;
  });

  afterEach(() => {
    if (originalRank === undefined) delete process.env.ORCHESTRA_FREE_MODE_RANK;
    else process.env.ORCHESTRA_FREE_MODE_RANK = originalRank;
  });

  function seedScores(entries: Array<[string, { intelligence: number; coding: number; agentic: number }]>) {
    __setOpenRouterBenchmarkScoreForTest(new Map(entries));
  }

  it("ranks by intelligence_index, highest first — real live numbers", () => {
    seedScores([
      ["nvidia/nemotron-3-ultra-550b-a55b:free", { intelligence: 38.3, coding: 49.3, agentic: 27.5 }],
      ["z-ai/glm-5.2:free", { intelligence: 52.6, coding: 68.8, agentic: 45.7 }],
      ["minimax/minimax-m3:free", { intelligence: 45.4, coding: 58.6, agentic: 36.1 }],
    ]);
    const ranked = sortFreeModelsByScore([
      "nvidia/nemotron-3-ultra-550b-a55b:free",
      "z-ai/glm-5.2:free",
      "minimax/minimax-m3:free",
    ]);
    // The 550B model does NOT win, despite being the largest — it scores worst.
    expect(ranked).toEqual([
      "z-ai/glm-5.2:free",
      "minimax/minimax-m3:free",
      "nvidia/nemotron-3-ultra-550b-a55b:free",
    ]);
  });

  it("tie-breaks on agentic_index before coding_index (Orchestra is a tool-calling agent)", () => {
    seedScores([
      ["v/a:free", { intelligence: 50, coding: 90, agentic: 30 }],
      ["v/b:free", { intelligence: 50, coding: 40, agentic: 70 }],
    ]);
    // Same intelligence; v/b wins on agentic despite a much lower coding score.
    expect(sortFreeModelsByScore(["v/a:free", "v/b:free"])).toEqual(["v/b:free", "v/a:free"]);
  });

  it("sinks unscored ids to the bottom — no evidence, no credit — and tie-breaks them alphabetically", () => {
    seedScores([["v/scored:free", { intelligence: 10, coding: 10, agentic: 10 }]]);
    expect(sortFreeModelsByScore(["v/z-unscored:free", "v/a-unscored:free", "v/scored:free"])).toEqual([
      "v/scored:free",
      "v/a-unscored:free",
      "v/z-unscored:free",
    ]);
  });

  it("with NO scores seeded anywhere, degrades to plain alphabetical (identical to the old behavior)", () => {
    expect(sortFreeModelsByScore(["v/c:free", "v/a:free", "v/b:free"])).toEqual([
      "v/a:free",
      "v/b:free",
      "v/c:free",
    ]);
  });

  it("ORCHESTRA_FREE_MODE_RANK=legacy restores plain alphabetical even with scores seeded", () => {
    seedScores([["v/weak:free", { intelligence: 1, coding: 1, agentic: 1 }]]);
    process.env.ORCHESTRA_FREE_MODE_RANK = "legacy";
    expect(sortFreeModelsByScore(["v/strong:free", "v/weak:free"])).toEqual([
      "v/strong:free",
      "v/weak:free",
    ]);
  });
});

describe("Free Mode — score ranking picks the actually-strongest capable brain", () => {
  beforeEach(() => {
    __resetOpenRouterPricingForTests();
    delete process.env.ORCHESTRA_FREE_MODE_RANK;
  });

  it("brain is the highest-scoring tool+structured id, not the alphabetically-first one", () => {
    seedCatalogue([
      ["aaa/weak:free", ["tools", "structured_outputs"]],
      ["zzz/strong:free", ["tools", "structured_outputs"]],
    ]);
    __setOpenRouterBenchmarkScoreForTest(
      new Map([
        ["aaa/weak:free", { intelligence: 20, coding: 20, agentic: 20 }],
        ["zzz/strong:free", { intelligence: 80, coding: 80, agentic: 80 }],
      ])
    );
    const s = selectFreeModels();
    // Alphabetically "aaa/weak" would win under the old behavior — the whole
    // point of this feature is that it does not.
    expect(s.chatModel.model).toBe("zzz/strong:free");
  });

  it("frontier proposer tier gets a stronger-scored model than the fast tier", () => {
    seedCatalogue([
      ["v/brain:free", ["tools", "structured_outputs"]],
      ["v/strongest:free", ["tools"]],
      ["v/middle:free", ["tools"]],
      ["v/weakest:free", ["tools"]],
    ]);
    __setOpenRouterBenchmarkScoreForTest(
      new Map([
        ["v/brain:free", { intelligence: 90, coding: 90, agentic: 90 }],
        ["v/strongest:free", { intelligence: 70, coding: 70, agentic: 70 }],
        ["v/middle:free", { intelligence: 50, coding: 50, agentic: 50 }],
        ["v/weakest:free", { intelligence: 10, coding: 10, agentic: 10 }],
      ])
    );
    const s = selectFreeModels();
    expect(s.chatModel.model).toBe("v/brain:free");
    // frontier should be the strongest of the three non-brain models.
    expect(s.proposerTiers.frontier.model).toBe("v/strongest:free");
    expect(s.proposerTiers.fast.model).toBe("v/weakest:free");
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

describe("non-chat model exclusion (found by a live 0/5 swarm collapse)", () => {
  it("rejects the two ids that actually broke a real run", () => {
    // Not hypothetical. Free Mode handed both to proposers; both answered
    // "Provider returned error" instantly and the ensemble reported
    // "0/5 proposers produced a usable draft".
    expect(isGeneralChatModel("nvidia/nemotron-3.5-content-safety:free")).toBe(false);
    expect(isGeneralChatModel("nvidia/nemotron-nano-12b-v2-vl:free")).toBe(false);
  });

  it("keeps every OTHER id from the same live catalogue", () => {
    // The whole 14-model free catalogue as observed on 2026-08-10, minus the
    // two above. Over-matching would shrink the pool and push every slot onto
    // one endpoint — the exact failure being fixed, in the other direction.
    for (const id of [
      "cohere/north-mini-code:free",
      "google/gemma-4-26b-a4b-it:free",
      "google/gemma-4-31b-it:free",
      "inclusionai/ling-3.0-tiny:free",
      "nvidia/nemotron-3-nano-30b-a3b:free",
      "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
      "nvidia/nemotron-3-super-120b-a12b:free",
      "nvidia/nemotron-3-ultra-550b-a55b:free",
      "nvidia/nemotron-nano-9b-v2:free",
      "openai/gpt-oss-20b:free",
      "poolside/laguna-s-2.1:free",
      "poolside/laguna-xs-2.1:free",
    ]) {
      expect(isGeneralChatModel(id), `${id} must stay in the pool`).toBe(true);
    }
  });

  it("matches -vl only as a SUFFIX, never inside a name", () => {
    expect(isGeneralChatModel("vendor/model-vl:free")).toBe(false);
    // A substring match here would wrongly drop an ordinary model.
    expect(isGeneralChatModel("vendor/vlad-chat-7b:free")).toBe(true);
    expect(isGeneralChatModel("vendor/model-vl-instruct:free")).toBe(true);
  });

  it("covers the adjacent non-chat classes", () => {
    for (const id of [
      "meta/llama-guard-3-8b:free",
      "vendor/text-embedding-3:free",
      "vendor/bge-rerank-v2:free",
      "vendor/some-moderation-model:free",
    ]) {
      expect(isGeneralChatModel(id), `${id} must be excluded`).toBe(false);
    }
  });
});

describe("exclusion is a preference, not a hard filter (council review gaps)", () => {
  beforeEach(() => __resetOpenRouterPricingForTests());

  it("keeps the ROUTER out of the non-chat set too", () => {
    // A moderation classifier can legitimately advertise `structured_outputs` —
    // emitting a JSON verdict is its job — so the Router slot was reachable by
    // exactly the class the proposer fix excludes. A dead proposer is dropped
    // and the ensemble degrades; a Router that cannot write personas takes the
    // swarm's role specialisation with it.
    // The classifier is named so it sorts FIRST. Selection is
    // alphabetical-stable, so with an unfiltered Router pool it WOULD be
    // picked — which is what makes this test discriminate. An earlier draft
    // named it "some-..." and passed whether or not the fix was present.
    seedCatalogue([
      ["vendor/aaa-content-safety:free", ["structured_outputs", "response_format"]],
      ["vendor/zzz-good-chat:free", ["structured_outputs", "response_format", "tools"]],
    ]);

    const s = selectFreeModels();
    expect(s.utilityModel.model).toBe("vendor/zzz-good-chat:free");
    expect(s.chatModel.model).toBe("vendor/zzz-good-chat:free");
  });

  it("falls back to the raw catalogue when EVERY id looks non-chat, and says so", () => {
    // Availability beats correctness here — Free Mode must not fail shut
    // because a week's free list looks unusual. But the run is then back to the
    // behaviour the filter exists to prevent, so it cannot be silent.
    seedCatalogue([
      ["vendor/a-content-safety:free", ["temperature"]],
      ["vendor/b-rerank:free", ["temperature"]],
    ]);

    const s = selectFreeModels();
    expect(s.exclusionEmptiedPool).toBe(true);
    expect(s.chatModel.model).toContain("vendor/");
    expect(describeFreeModeSelection(s)).toContain("ABANDONED");
  });

  it("does not claim an exclusion happened on the fallback-list path", () => {
    const s = selectFreeModels();
    expect(s.source).toBe("fallback-list");
    expect(s.excludedNonChat).toBe(0);
    expect(s.exclusionEmptiedPool).toBe(false);
  });
});

/**
 * PM #116 — protake council round 2 (2026-08-31), triggered by a live 9-hour
 * sustained repro: the breaker existed but was only ever consulted for
 * WITHIN-turn substitution, after the doomed top-scored model had already been
 * picked. A fresh `selectFreeModels()` call for the NEXT turn had no memory of
 * that model's own recent failures and picked it again — every operator
 * independently converges on the same globally-throttled "best" free model.
 */
describe("PM #116 — a circuit-open id is excluded from selection, not just within-turn substitution", () => {
  beforeEach(() => {
    __resetOpenRouterPricingForTests();
    resetModelHealth();
  });
  afterEach(() => {
    resetModelHealth();
  });

  it("skips a circuit-open top-scored model for both brain AND router", () => {
    seedCatalogue([
      ["vendor/aaa-throttled:free", ["tools", "structured_outputs"]],
      ["vendor/zzz-healthy:free", ["tools", "structured_outputs"]],
    ]);
    for (let i = 0; i < 3; i++) recordModelFailure("openrouter", "vendor/aaa-throttled:free", "throttle");
    expect(isModelCircuitOpen("openrouter", "vendor/aaa-throttled:free")).toBe(true);

    const s = selectFreeModels();
    expect(s.chatModel.model).toBe("vendor/zzz-healthy:free");
    expect(s.utilityModel.model).toBe("vendor/zzz-healthy:free");
    expect(s.excludedUnhealthyIds).toEqual(["vendor/aaa-throttled:free"]);
    expect(s.healthyPoolEmptied).toBe(false);
  });

  it("falls back to the raw catalogue when EVERY scored id is circuit-open, and says so — never a silent empty pool", () => {
    const ids = ["vendor/aaa-throttled:free", "vendor/bbb-also-throttled:free"];
    seedCatalogue(ids.map((id) => [id, ["tools", "structured_outputs"]]));
    for (const id of ids) {
      for (let i = 0; i < 3; i++) recordModelFailure("openrouter", id, "throttle");
    }

    const s = selectFreeModels();
    expect(s.healthyPoolEmptied).toBe(true);
    expect(s.chatModel.model).toContain("vendor/");
    expect(describeFreeModeSelection(s)).toContain("ABANDONED");
  });

  it("does not claim a health exclusion on the fallback-list path", () => {
    const s = selectFreeModels();
    expect(s.source).toBe("fallback-list");
    expect(s.excludedUnhealthy).toBe(0);
    expect(s.healthyPoolEmptied).toBe(false);
  });
});

describe("dropped ids are named, not just counted", () => {
  beforeEach(() => __resetOpenRouterPricingForTests());

  it("names the excluded ids in the selection and the log line", () => {
    // A count tells you something shrank; it does not tell you whether the
    // heuristic was right. Diagnosing that from a number means rebuilding the
    // catalogue by hand.
    seedCatalogue([
      ["vendor/aaa-content-safety:free", ["temperature"]],
      ["vendor/zzz-good-chat:free", ["temperature", "tools"]],
    ]);

    const s = selectFreeModels();
    expect(s.excludedNonChatIds).toEqual(["vendor/aaa-content-safety:free"]);
    expect(describeFreeModeSelection(s)).toContain("vendor/aaa-content-safety:free");
  });
});

/**
 * PM #112 — constraint 3 ("slots should NOT share one endpoint") was written
 * about the proposer fan-out and left the brain/Router pair out. Both resolve to
 * "the first structured-capable id, sorted", so they landed on the SAME model by
 * construction. When that upstream started rejecting requests, it took the
 * brain, the Router and the fallback probe with it.
 */
describe("Free Mode — the Router must not sit on the brain's endpoint", () => {
  beforeEach(() => {
    __resetOpenRouterPricingForTests();
  });

  it("gives the Router a DIFFERENT model when another structured-capable id exists", () => {
    seedCatalogue([
      ["aaa/first:free", ["tools", "structured_outputs"]],
      ["bbb/second:free", ["tools", "structured_outputs"]],
    ]);
    const s = selectFreeModels();
    // The brain takes the first tool+structured id; the Router must skip it.
    expect(s.chatModel.model).toBe("aaa/first:free");
    expect(s.utilityModel.model).toBe("bbb/second:free");
    expect(s.routerSharesBrainEndpoint).toBe(false);
  });

  it("shares rather than leaving the Router empty when it is the ONLY structured id", () => {
    seedCatalogue([
      ["aaa/only-structured:free", ["tools", "structured_outputs"]],
      ["bbb/plain:free", ["tools"]],
    ]);
    const s = selectFreeModels();
    expect(s.chatModel.model).toBe("aaa/only-structured:free");
    expect(s.utilityModel.model).toBe("aaa/only-structured:free");
    // A Router on the brain's endpoint still works; no Router does not. But the
    // concentration must be REPORTED, not inferred from two matching strings.
    expect(s.routerSharesBrainEndpoint).toBe(true);
    expect(describeFreeModeSelection(s)).toMatch(/SHARES the brain's endpoint/);
  });

  it("says nothing about sharing when the slots are already split", () => {
    seedCatalogue([
      ["aaa/first:free", ["tools", "structured_outputs"]],
      ["bbb/second:free", ["tools", "structured_outputs"]],
    ]);
    expect(describeFreeModeSelection(selectFreeModels())).not.toMatch(/SHARES/);
  });
});

/**
 * PM #127 — the overlay used to REPLACE `proposerTiers` outright, so the
 * operator's own (usually paid, usually working) tiers were gone before the
 * fan-out built its failover pool from them. When every free candidate was
 * refused there was nothing left to substitute to. The displaced originals are
 * now carried, so the pool can at minimum NAME them.
 */
describe("PM #127 — the overlay preserves the tiers it displaces", () => {
  beforeEach(() => {
    __resetOpenRouterPricingForTests();
    seedCatalogue([
      ["v/a:free", ["structured_outputs"]],
      ["v/b:free", ["tools"]],
      ["v/c:free", ["tools"]],
    ]);
  });

  it("carries the operator's paid tiers into freeModeDisplacedTiers", () => {
    const base = settings({
      freeMode: { enabled: true },
      proposerTiers: {
        fast: { provider: "openrouter", model: "deepseek/deepseek-chat" },
        balanced: { provider: "openrouter", model: "deepseek/deepseek-chat" },
        frontier: { provider: "openrouter", model: "anthropic/claude-sonnet-4.6" },
      },
    });
    const out = applyFreeMode(base);

    // The live tiers are free…
    expect(out.settings.proposerTiers?.fast?.model).toMatch(/:free$/);
    // …and the displaced paid originals survive alongside them.
    expect(out.settings.freeModeDisplacedTiers?.fast?.model).toBe("deepseek/deepseek-chat");
    expect(out.settings.freeModeDisplacedTiers?.frontier?.model).toBe(
      "anthropic/claude-sonnet-4.6"
    );
  });

  it("still does not mutate the caller's settings", () => {
    const base = settings({
      freeMode: { enabled: true },
      proposerTiers: { fast: { provider: "openrouter", model: "paid/one" } },
    });
    applyFreeMode(base);
    expect(base.proposerTiers?.fast?.model).toBe("paid/one");
    expect(base.freeModeDisplacedTiers).toBeUndefined();
  });
});
