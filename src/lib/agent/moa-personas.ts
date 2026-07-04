/**
 * PM #57 — extracted from `moa.ts` to bring the orchestration file
 * back under the 1500-line hard cap (CLAUDE.md § File-Size Discipline).
 *
 * Pure helpers and data only: persona types, the static fallback
 * proposer constant, role detection, tier derivation, API-key
 * inheritance, and the per-proposer model resolution. No I/O, no
 * LLM calls — every function in this file is synchronous and testable
 * without mocks. (Single deliberate exception: the once-per-process
 * S8 advisory `console.warn` in `warnSkepticFamilyOverlapOnce`.)
 *
 * Re-exported from `./moa` (no breaking changes for callers or tests).
 */

import type { ModelConfig, AppSettings } from "@/lib/types";

/**
 * PM #48 — model tier hint. The DPG Router can suggest a tier per
 * persona (skeptic → fast, analyst → balanced, coder → frontier).
 * If omitted, Orchestra derives one from the persona's detected role.
 */
export type ProposerTier = "fast" | "balanced" | "frontier";

export interface MoAProposer {
  id: string;
  role: string;
  systemPrompt: string;
  /** Color accent for UI (tailwind) */
  color: string;
  /** PM #48 — optional tier hint. See `resolveProposerModelConfig`. */
  modelTier?: ProposerTier;
}

/**
 * Static fallback proposer set. Used by the MoA path when the dynamic
 * Router (DPG) fails to produce a valid persona list. The CLAUDE.md
 * "3-5 proposers" rule (§1 MoA) is enforced here as the lower bound.
 */
export const MOA_PROPOSERS: MoAProposer[] = [
  {
    id: "analyst",
    role: "First-Principles Analyst",
    color: "violet",
    systemPrompt: `You are a First-Principles Analyst. Your approach is structured, logical, and deeply truth-seeking.

RULES:
- Break down the user's request into its fundamental truths and constraints.
- Strip away assumptions and focus only on verified facts and core logic.
- Do NOT jump to the simplest solution; instead, dissect the problem space thoroughly.
- Define clearly what is known, what is unknown, and what is required to solve the task.

Respond directly to the user's request. Keep your output highly structured, analytical, and devoid of emotional language.`,
  },
  {
    id: "creative",
    role: "Lateral-Thinking Creative",
    color: "amber",
    systemPrompt: `You are a Lateral-Thinking Creative. Your approach is unorthodox, brainstorm-heavy, and paradigm-shifting.

RULES:
- Do NOT settle for the obvious, standard answer.
- Connect the user's request to seemingly unrelated fields or metaphors to find non-obvious solutions.
- Brainstorm multiple outside-the-box approaches.
- If writing code or designing a system, propose bleeding-edge, highly innovative, or extremely elegant patterns.

Respond directly to the user's request. Be bold, visionary, and expansive in your thinking.`,
  },
  {
    id: "pragmatist",
    role: "Pragmatic Executor",
    color: "emerald",
    systemPrompt: `You are a Pragmatic Executor. Your philosophy is "Occam's Razor" and "You Aren't Gonna Need It" (YAGNI).

RULES:
- Find the absolute maximum-leverage, lowest-complexity path to the user's goal.
- Ruthlessly eliminate boilerplate, over-engineering, and unnecessary steps.
- Explain the simplest, most direct way to get the job done right now.
- If providing code or a plan, make it concise, stupidly simple, and immediately actionable.

Respond directly to the user's request. Cut the fluff. Show the fastest working path.`,
  },
  {
    id: "critic",
    role: "Adversarial Critic",
    color: "rose",
    systemPrompt: `You are a relentless Adversarial Critic and Red-Teamer.
RULE 1 (No Sycophancy): Do NOT praise the premise. Do NOT use polite fillers. Assume the proposed code/idea will break in production. Do not agree with the Coder simply because they provided a detailed answer.
RULE 2 (Chain of Doubt): Reason through the CLAIM -> EXTRACT -> DOUBT framework — restate the key claim, extract the risky assumption, then construct a concrete scenario where the proposed architecture fails.
RULE 3 (Second-Order Thinking): Do not focus purely on syntax. Analyze scaling, race conditions, memory leaks, and security vulnerabilities.
RULE 4 (No fabrication): If the solution is genuinely robust, say so plainly and explain WHY it holds up. Do not invent edge cases just to be contrarian.
RULE 5: Do NOT blindly trust 'search_web' summaries — use 'fetch_webpage' to verify.
Write your critique as prose. Do NOT emit control tags like <doubt> or <approval> — nothing parses them, and they only pollute the downstream synthesis. Respond directly, relentlessly honest, even uncomfortable.`,
  },
  {
    id: "chameleon",
    role: "Adaptive Domain Expert",
    color: "blue",
    systemPrompt: `You are an Adaptive Domain Expert (Chameleon). Your approach is to instantly become the world's leading expert in the SPECIFIC field the user's request touches on.

RULES:
- Identify the SINGLE most relevant domain (e.g., embedded systems, art history, FDA regulations, etc.).
- Speak with the depth, precision, and terminology of a top-1% expert in that field.
- If multiple domains apply, pick the one with the highest stakes for the user's goal.
- Apply that expert's typical mental models, tools, and failure-mode catalog.

Respond directly to the user's request. Be authoritative and specific.`,
  },
];

export type ProposerRole = "coder" | "researcher" | "reviewer" | "tool" | "orchestrator";

/**
 * PM #48 — derive a tier hint from the persona's detected role. Used as
 * fallback when the LLM didn't pick a `modelTier` explicitly.
 *
 * Mapping rationale:
 *   - reviewer (skeptic/critic/QA) → fast: their job is to find faults,
 *     not produce long deep synthesis. Cheap reliable models suffice.
 *   - researcher (analyst/domain-expert/architect) → balanced: clarity
 *     + factual accuracy matter more than raw reasoning depth.
 *   - tool (deploy/devops/implementer-without-design) → balanced: same.
 *   - coder (the fallback / design-heavy / synthesis-heavy) → frontier:
 *     output quality scales with model size on these tasks.
 */
export function deriveTierFromRole(role: ProposerRole): ProposerTier {
  switch (role) {
    case "reviewer":
      return "fast";
    case "researcher":
    case "tool":
      return "balanced";
    case "coder":
      return "frontier";
    case "orchestrator":
      // Orchestrator personas don't run as proposers in current MoA, but
      // if a future flow uses them, default conservatively to balanced.
      return "balanced";
    default:
      return "balanced";
  }
}

export function detectProposerRole(proposer: MoAProposer): ProposerRole {
  // PM #45 — include `role` in the blob. Previously this helper looked
  // only at id + systemPrompt, but personas like `{ id: "beta", role:
  // "Code Reviewer", systemPrompt: "..." }` would slip through if the
  // role keyword appeared only in `role`. The pre-PM-45 SKEPTIC_PATTERN
  // (which this helper replaces in `generateDynamicSwarm`) explicitly
  // checked id || role, so the migration must too.
  const blob = (proposer.id + " " + proposer.role + " " + proposer.systemPrompt).toLowerCase();
  if (/review|critic|audit|qa|quality|skeptic|adversar|red.?team|fact.?check/.test(blob)) {
    return "reviewer";
  }
  if (/research|analys|architect|domain|expert|chameleon|first.?prin/.test(blob)) {
    return "researcher";
  }
  if (/tool|executor|pragmat|deploy|infra|devops|implement/.test(blob)) {
    return "tool";
  }
  return "coder";
}

/**
 * Resolve the API key for a given model config — mirrors the key
 * resolution logic from runAgent. Used by tier resolution so a
 * partial `ModelConfig` in `settings.proposerTiers.fast` (just
 * provider + model, no apiKey) inherits the key from either the
 * provider-key vault or the matching chatModel.
 */
export function resolveWorkerKey(
  config: ModelConfig,
  settings: AppSettings
): ModelConfig {
  if (config.apiKey) return config;

  const provider = config.provider;
  const vaultKey = settings.providerApiKeys?.[provider];
  if (vaultKey) {
    return { ...config, apiKey: vaultKey };
  }
  if (settings.chatModel.provider === provider && settings.chatModel.apiKey) {
    return { ...config, apiKey: settings.chatModel.apiKey };
  }
  // Fall through to env vars (handled by createModel)
  return config;
}

/**
 * DDD "operator owns the Skeptic" — the wire shape of a per-request
 * Skeptic override. DELIBERATELY only `provider` + `model`: the request
 * body must never carry an `apiKey` (key-injection) or `baseUrl` (SSRF —
 * `createModel` does not run `assertSafeOutboundUrl`). Keys resolve
 * server-side via `resolveWorkerKey`.
 */
export type SkepticModelOverride = Pick<ModelConfig, "provider" | "model">;

/** Providers a per-request Skeptic override may name. Mirrors the ModelConfig
 * provider union; validated at the API boundary so a garbage payload is a 400,
 * not a mid-swarm `createModel` throw. */
const KNOWN_PROVIDERS: ReadonlySet<string> = new Set([
  "openai",
  "anthropic",
  "google",
  "openrouter",
  "ollama",
  "sglang",
  "vllm",
  "custom",
  "mock",
]);

/**
 * Boundary validator for a per-request Skeptic override. Accepts ONLY the
 * two-field shape with a known provider and a non-empty model; anything
 * else (extra keys like apiKey/baseUrl, unknown provider, empty model)
 * is rejected so the route can 400 instead of letting a hostile/buggy
 * client shape reach `createModel`.
 */
export function isValidSkepticOverride(
  value: unknown
): value is SkepticModelOverride {
  if (typeof value !== "object" || value === null) return false;
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length !== 2 || !keys.includes("provider") || !keys.includes("model")) {
    return false;
  }
  const { provider, model } = value as Record<string, unknown>;
  return (
    typeof provider === "string" &&
    KNOWN_PROVIDERS.has(provider) &&
    typeof model === "string" &&
    model.trim().length > 0
  );
}

/**
 * DDD — resolve the operator's Skeptic model, if any. Single source of
 * truth (PM #17 posture) consumed by BOTH skeptic surfaces:
 *   - the DPG reviewer proposer (`resolveProposerModelConfig` below), and
 *   - the reflection critic (`moa.ts` → `reflectOnResponse.modelOverride`).
 *
 * Precedence: per-request override (panel) > `proposerTiers.skeptic`
 * (settings) > undefined (callers keep their pre-existing behavior).
 * Keys inherit server-side via `resolveWorkerKey`; a per-request override
 * carries provider+model ONLY (see `SkepticModelOverride`).
 */
export function resolveSkepticModelConfig(
  settings: AppSettings,
  perRequestOverride?: SkepticModelOverride | null
): ModelConfig | undefined {
  if (perRequestOverride && isValidSkepticOverride(perRequestOverride)) {
    return resolveWorkerKey(
      { provider: perRequestOverride.provider, model: perRequestOverride.model },
      settings
    );
  }
  const direct = settings.proposerTiers?.skeptic;
  if (direct?.model && direct.model.trim().length > 0) {
    return resolveWorkerKey(direct, settings);
  }
  return undefined;
}

/**
 * PM #48 — resolve a proposer's actual ModelConfig from settings + tier.
 *
 * Priority order:
 *   0. DDD — for reviewer/Skeptic personas, a resolved direct Skeptic
 *      config (per-request override or `proposerTiers.skeptic`) wins
 *      outright. DELIBERATE (audit A10): the direct-model knob beats the
 *      role→tier knob (`swarmSandbox.reviewer`) — both are operator
 *      intent; most-specific wins. The settings UI warns when both are set.
 *   1. If `settings.proposerTiers[picked]` has a configured model →
 *      use it (with API-key inheritance via `resolveWorkerKey`).
 *   2. Otherwise fall back to `defaultWorkerConfig` (the pre-PM-48
 *      uniform behavior — exact backward compat for operators who
 *      don't configure tiers).
 *
 * `picked` = persona's explicit `modelTier` (if LLM provided one), else
 * the tier derived from `detectProposerRole(persona)`.
 */
export function resolveProposerModelConfig(
  proposer: MoAProposer,
  defaultWorkerConfig: ModelConfig,
  settings: AppSettings,
  resolvedSkepticConfig?: ModelConfig
): { config: ModelConfig; tier: ProposerTier } {
  const role = detectProposerRole(proposer);
  const sandboxTier = settings.swarmSandbox?.[role];
  const skepticTierOverride = role === "reviewer" ? settings.proposerTiers?.skepticTier : undefined;

  let tier = sandboxTier ?? skepticTierOverride ?? proposer.modelTier ?? deriveTierFromRole(role);

  // R5 — floor the Skeptic at "balanced". The DPG hints skeptics as "fast"
  // (PM #48) and reviewer derives to "fast", so without this the anti-sycophancy
  // audit runs on the cheapest model by default. Only bumps a would-be "fast"
  // reviewer; explicit operator controls (swarmSandbox, skepticTier) and an
  // explicit stronger persona modelTier already resolved above and are honored.
  if (
    role === "reviewer" &&
    tier === "fast" &&
    sandboxTier === undefined &&
    skepticTierOverride === undefined
  ) {
    tier = "balanced";
  }

  // DDD surface 1 — the operator's direct Skeptic model wins the CONFIG
  // outright (precedence over every tier path — audit A10). The `tier` label
  // stays the honestly-resolved tier for telemetry/DAG (QA audit C2 — the old
  // hardcoded "frontier" mislabelled a cheap operator skeptic as frontier).
  if (role === "reviewer" && resolvedSkepticConfig?.model) {
    return { config: resolvedSkepticConfig, tier };
  }

  const tiers = settings.proposerTiers;
  const tierConfig = tiers?.[tier];
  if (!tierConfig || !tierConfig.model) {
    return { config: defaultWorkerConfig, tier };
  }
  return { config: resolveWorkerKey(tierConfig, settings), tier };
}

/**
 * DDD Sprint 8 (corrected) — model-FAMILY heuristic for the in-breed
 * sycophancy advisory.
 *
 * The original Tripartite plan FORCED three distinct providers (orchestrator /
 * workers / skeptic) and auto-switched the Skeptic to a third vendor. Rejected:
 * it breaks single-provider setups (everything-via-OpenRouter — this operator's
 * real config), breaks Privacy Mode (all-local = one "provider" by
 * construction), and silently overrides operator model choice (the PM #22
 * anti-pattern). The corrected design is ADVISORY ONLY: detect the overlap,
 * warn once, change nothing.
 *
 * Comparing `provider` alone is wrong for exactly the setups that matter:
 * on OpenRouter every model has provider "openrouter" while the underlying
 * vendor differs (`deepseek/…` vs `anthropic/…`). So we derive a vendor FAMILY:
 *   - direct cloud providers ARE the family (anthropic / openai / google);
 *   - path-prefixed ids (OpenRouter) take the prefix: "deepseek/x" → "deepseek";
 *   - local/self-hosted ids take the leading alpha run: "qwen2.5:7b" → "qwen".
 * Heuristic by design — good enough for an advisory, never used to gate.
 */
const DIRECT_PROVIDER_FAMILIES: Record<string, string> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
};

export function modelFamily(
  config: Pick<ModelConfig, "provider" | "model">
): string {
  const provider = (config.provider ?? "").toLowerCase();
  if (DIRECT_PROVIDER_FAMILIES[provider]) {
    return DIRECT_PROVIDER_FAMILIES[provider];
  }
  const model = (config.model ?? "").toLowerCase().trim();
  if (model.includes("/")) return model.split("/")[0];
  const leadingAlpha = model.match(/^([a-z]+)/);
  if (leadingAlpha) return leadingAlpha[1];
  return provider || "unknown";
}

/**
 * Returns a one-line in-breed sycophancy advisory when the Skeptic's model
 * family overlaps the workers' and/or the orchestrator's, or null when the
 * families are distinct. Pure — the caller decides where/whether to surface
 * it (moa.ts warns once per process per combo).
 */
export function detectSkepticFamilyOverlap(params: {
  skeptic: Pick<ModelConfig, "provider" | "model">;
  worker: Pick<ModelConfig, "provider" | "model">;
  brain: Pick<ModelConfig, "provider" | "model">;
}): string | null {
  const skeptic = modelFamily(params.skeptic);
  const worker = modelFamily(params.worker);
  const brain = modelFamily(params.brain);

  const advice =
    "In-breed sycophancy risk: an auditor from the same model family shares the blind spots " +
    "of the code it audits. Consider pointing proposerTiers.skepticTier at a different-family model. " +
    "Advisory only — nothing was changed.";

  if (skeptic === worker && skeptic === brain) {
    return `Skeptic, workers AND orchestrator all run on the "${skeptic}" model family. ${advice}`;
  }
  if (skeptic === worker) {
    return `Skeptic runs on the same model family ("${skeptic}") as the workers whose drafts it audits. ${advice}`;
  }
  if (skeptic === brain) {
    return `Skeptic runs on the same model family ("${skeptic}") as the orchestrator/synthesizer. ${advice}`;
  }
  return null;
}

// DDD Sprint 8 (corrected) — dedup for the in-breed sycophancy advisory:
// warn once per process per (skeptic, worker, brain) model combo, not on
// every swarm run. Bounded by construction (distinct combos are few).
// Extracted here from moa.ts (§8 zero-net-growth offset).
const warnedSkepticFamilyCombos = new Set<string>();

/** Test-only: reset the once-per-process S8 dedup between test cases. */
export function resetSkepticFamilyWarnDedup(): void {
  warnedSkepticFamilyCombos.clear();
}

/**
 * S8 advisory, warn-once wrapper. Detects skeptic/worker/brain family
 * overlap and `console.warn`s ONCE per process per model combo. Changes
 * nothing — advisory only (the forced Tripartite switch was rejected;
 * see `detectSkepticFamilyOverlap` docs). Returns the advisory string
 * when one was emitted (new combo), else null.
 */
export function warnSkepticFamilyOverlapOnce(params: {
  skeptic: Pick<ModelConfig, "provider" | "model">;
  worker: Pick<ModelConfig, "provider" | "model">;
  brain: Pick<ModelConfig, "provider" | "model">;
}): string | null {
  const overlap = detectSkepticFamilyOverlap(params);
  if (!overlap) return null;
  const comboKey = [
    `${params.skeptic.provider}/${params.skeptic.model}`,
    `${params.worker.provider}/${params.worker.model}`,
    `${params.brain.provider}/${params.brain.model}`,
  ].join("|");
  if (warnedSkepticFamilyCombos.has(comboKey)) return null;
  warnedSkepticFamilyCombos.add(comboKey);
  console.warn(`[MoA] S8 advisory — ${overlap}`);
  return overlap;
}
