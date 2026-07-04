/**
 * PM #47/#58 — Privacy Mode air-gap guards.
 *
 * Extracted from `agent.ts` (§8 zero-net-growth offset, DDD Skeptic-override
 * track): a pure leaf — no agent/moa imports, so any entry point (agent,
 * daemon, routes) can enforce the air-gap without an import cycle.
 * Re-exported from `./agent` for existing callers and tests.
 */

import { isLocalProvider } from "@/lib/providers/llm-provider";
import type { AppSettings, ModelConfig } from "@/lib/types";
import type { SkepticModelOverride } from "@/lib/agent/moa-personas";

/**
 * PM #47 — Privacy Mode runtime guard. Throws when the operator has
 * enabled `settings.privacyMode.enabled` but any of `chatModel`,
 * `utilityModel`, or `embeddingsModel` resolves to a non-local backend.
 * Exported so the runtime check has its own focused test suite
 * (`agent-privacy.test.ts`) without booting the full runAgent path.
 */
export function assertPrivacyModeAllowsSettings(
  settings: AppSettings
): void {
  if (!settings.privacyMode?.enabled) return;
  const violations: string[] = [];
  if (!isLocalProvider(settings.chatModel)) {
    violations.push(
      `chatModel = ${settings.chatModel.provider}/${settings.chatModel.model}`
    );
  }
  // utilityModel is used by the Router + reflection critic. If it's
  // not local, the swarm leaks the user prompt to a vendor regardless
  // of whether the chatModel is local.
  if (
    settings.utilityModel?.model &&
    !isLocalProvider(settings.utilityModel)
  ) {
    violations.push(
      `utilityModel = ${settings.utilityModel.provider}/${settings.utilityModel.model}`
    );
  }
  // embeddingsModel is used by Blackboard + PM #39 disagreement
  // detection + PM #46 convergence. Same threat — text leaves the box.
  // Note: the embeddingsModel union includes "mock", which is non-network.
  if (
    settings.embeddingsModel?.provider &&
    settings.embeddingsModel.provider !== "mock" &&
    !isLocalProvider({
      provider: settings.embeddingsModel.provider as ModelConfig["provider"],
      model: settings.embeddingsModel.model,
      baseUrl: settings.embeddingsModel.baseUrl,
    })
  ) {
    violations.push(
      `embeddingsModel = ${settings.embeddingsModel.provider}/${settings.embeddingsModel.model}`
    );
  }
  // PM #48 — proposerTiers also leak the user prompt if any configured
  // tier resolves to a non-local backend. The MoA dispatch path uses
  // `resolveProposerModelConfig` which falls back to `chatModel`/worker
  // when a tier is unset, so we only check tiers the operator actually
  // configured (has a `model` set). DDD (audit A5) — the direct
  // `skeptic` slot is a full ModelConfig and leaks exactly like a tier;
  // it MUST stay in this list.
  const tiers = settings.proposerTiers;
  if (tiers) {
    for (const tierName of ["fast", "balanced", "frontier", "skeptic"] as const) {
      const tierCfg = tiers[tierName];
      if (tierCfg?.model && !isLocalProvider(tierCfg)) {
        violations.push(
          `proposerTiers.${tierName} = ${tierCfg.provider}/${tierCfg.model}`
        );
      }
    }
  }
  // PM #54 — `settings.aggregator.tournamentJudgeModel` (PM #52) was the
  // last LLM call path that bypassed the Privacy Mode guard. When the
  // operator picks tournament mode + a cloud judge model, every MoA call
  // shipped the user prompt + every draft to that judge provider — the
  // exact air-gap violation PM #47 was supposed to prevent. Closing the
  // hole here makes the threat model honest: ALL LLM call paths reachable
  // from runAgent are now gated by this single guard.
  const judgeCfg = settings.aggregator?.tournamentJudgeModel;
  if (judgeCfg?.model && !isLocalProvider(judgeCfg)) {
    violations.push(
      `aggregator.tournamentJudgeModel = ${judgeCfg.provider}/${judgeCfg.model}`
    );
  }
  if (violations.length > 0) {
    throw new Error(
      `Privacy Mode is enabled, but these models target a non-local backend:\n  ` +
        violations.map((v) => `• ${v}`).join("\n  ") +
        `\n\nTo proceed, either: (a) disable Privacy Mode in Settings, or ` +
        `(b) switch the violating models to a local backend (ollama, ` +
        `sglang, vllm, or custom with a loopback baseUrl).`
    );
  }
}

/**
 * DDD (audit A5) — Privacy Mode guard for the PER-REQUEST Skeptic override.
 * The override rides the request body, NOT settings, so
 * `assertPrivacyModeAllowsSettings` cannot see it — a cloud override under
 * Privacy Mode would silently bypass the air-gap. Called at run time by
 * every entry point that accepts the override (route + runAgent — defense
 * in depth, PM #58 posture). No-op when Privacy Mode is off or no override.
 */
export function assertPrivacyModeAllowsSkepticOverride(
  settings: AppSettings,
  override?: SkepticModelOverride | null
): void {
  if (!settings.privacyMode?.enabled || !override?.model) return;
  if (!isLocalProvider({ provider: override.provider, model: override.model })) {
    throw new Error(
      `Privacy Mode is enabled, but the per-request Skeptic override targets ` +
        `a non-local backend: ${override.provider}/${override.model}. ` +
        `Pick a local Skeptic model (ollama, sglang, vllm) or disable Privacy Mode.`
    );
  }
}
