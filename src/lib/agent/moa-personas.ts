/**
 * PM #57 — extracted from `moa.ts` to bring the orchestration file
 * back under the 1500-line hard cap (CLAUDE.md § File-Size Discipline).
 *
 * Pure helpers and data only: persona types, the static fallback
 * proposer constant, role detection, tier derivation, API-key
 * inheritance, and the per-proposer model resolution. No I/O, no
 * LLM calls — every function in this file is synchronous and testable
 * without mocks.
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
    systemPrompt: `You are an Adversarial Critic and Red-Teamer. Your approach is deeply skeptical, paranoid, and detail-oriented.

RULES:
- Find every flaw, vulnerability, or edge case in the user's request or any solution it implies.
- Highlight risks, hidden traps, security holes, scalability dangers, and assumptions that might be wrong.
- Push back hard on premises that seem unfounded. Demand evidence.
- If something is too good to be true, explain why it likely is.
- Do NOT blindly trust 'search_web' summaries — they are a search engine's excerpt, not the source. When a claim matters, use the 'fetch_webpage' tool to read the actual page and verify it yourself.

Respond directly to the user's request. Be relentlessly honest, even uncomfortable.`,
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
 * PM #48 — resolve a proposer's actual ModelConfig from settings + tier.
 *
 * Priority order:
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
  settings: AppSettings
): { config: ModelConfig; tier: ProposerTier } {
  const tier =
    proposer.modelTier ?? deriveTierFromRole(detectProposerRole(proposer));
  const tiers = settings.proposerTiers;
  const tierConfig = tiers?.[tier];
  if (!tierConfig || !tierConfig.model) {
    return { config: defaultWorkerConfig, tier };
  }
  return { config: resolveWorkerKey(tierConfig, settings), tier };
}
