/**
 * PM #47/#58 — Privacy Mode air-gap guards.
 *
 * Extracted from `agent.ts` (§8 zero-net-growth offset, DDD Skeptic-override
 * track): a pure leaf — no agent/moa imports, so any entry point (agent,
 * daemon, routes) can enforce the air-gap without an import cycle.
 * Re-exported from `./agent` for existing callers and tests.
 */

import { isLocalProvider } from "@/lib/providers/llm-provider";
import { getSettings } from "@/lib/storage/settings-store";
import type { AppSettings, ModelConfig } from "@/lib/types";
import type { SkepticModelOverride } from "@/lib/agent/moa-personas";
import { applyFreeMode, describeFreeModeSelection } from "@/lib/agent/free-mode";
import { log } from "@/lib/observability/logger";

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

/**
 * Sprint 4 (guarded AgentSession) — acquire settings for an agent run AND
 * enforce the Privacy-Mode air-gap in ONE atomic step. Every agent entry point
 * (`runAgent`, `runAgentText`, `runSubordinateAgent`, and any future one) MUST
 * acquire settings through this, NEVER through a bare `getSettings()` followed
 * by a hand-copied `assertPrivacyModeAllowsSettings(settings)`.
 *
 * Why: PM #58 was a P0 data-egress leak caused by exactly that hand-copied
 * line being present at the interactive `runAgent` but FORGOTTEN at
 * `runAgentText` (cron + the unauthenticated Telegram webhook) and
 * `runSubordinateAgent` — so cron ticks and Telegram messages shipped prompts
 * to cloud vendors while the UI showed Privacy Mode ON. Folding the guard into
 * settings acquisition makes it structurally impossible to obtain agent
 * settings that have not passed the air-gap: a new entry point that copies the
 * existing pattern inherits the guard for free instead of inheriting ZERO
 * guards.
 *
 * Scope: this guards the SETTINGS-resolved models (chatModel, utilityModel,
 * embeddingsModel, proposerTiers, tournament judge). A per-request Skeptic
 * override is NOT in settings — guard it separately via
 * `assertPrivacyModeAllowsSkepticOverride` (runAgent + the `/api/chat` route).
 */
export async function resolveGuardedAgentSettings(): Promise<AppSettings> {
  const raw = await getSettings();

  // Free Mode overlays the model slots with free OpenRouter models. It belongs
  // HERE, at the same chokepoint as the air-gap, for the same PM #58 reason:
  // every agent entry point already acquires settings through this function
  // (CI-enforced — no `src/lib/agent` module may import `getSettings`
  // directly), so a new `runAgent`-like path inherits Free Mode without anyone
  // remembering to thread it. Cron, Auto-Pilot and the external-message path
  // are covered by construction.
  const { settings, selection, suppressedByPrivacyMode } = applyFreeMode(raw);

  if (selection) {
    // LOUD by design. A model the user did not choose is answering, and the
    // Router may have silently lost structured outputs — the operator must be
    // able to see both without reading the code.
    log.info("free_mode_active", {
      module: "agent-privacy",
      source: selection.source,
      brain: selection.chatModel.model,
      router: selection.utilityModel.model,
      routerStructuredOutputs: selection.routerSupportsStructuredOutputs,
      endpointSpread: selection.endpointSpread,
      candidates: selection.candidateCount,
    });
    console.log(`[FreeMode] ${describeFreeModeSelection(selection)}`);
  } else if (suppressedByPrivacyMode) {
    // Not an error: Privacy Mode wins on purpose. But a user who switched Free
    // Mode on and sees their own paid models running deserves to know why.
    log.warn("free_mode_suppressed_by_privacy_mode", { module: "agent-privacy" });
    console.warn(
      "[FreeMode] suppressed — Privacy Mode is ON, which forbids cloud egress. " +
        "Your configured local models are being used instead."
    );
  }

  // Asserted on the FINAL settings, after any overlay. `applyFreeMode` already
  // yields to Privacy Mode, so this is defence in depth: were that ever to
  // regress, the air-gap still refuses the run rather than shipping data out.
  assertPrivacyModeAllowsSettings(settings);
  return settings;
}
