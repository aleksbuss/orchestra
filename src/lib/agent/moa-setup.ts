/**
 * MoA ensemble setup (Sprint 5 §10 — extracted from `moa.ts` to shrink
 * `runMoAEnsemble`). All the pure, synchronous per-run derivations that used to
 * be scattered through the head of `runMoAEnsemble` before the first side
 * effect: the operator's Skeptic model, the request-aware reflection toggle, the
 * memoized context-window resolver, the worker + router model configs, the
 * proposer-safe history slice, the search-usable gate, and the clamped swarm
 * size. None of these read or mutate anything but `settings`/`options`, so
 * computing them together up front is behaviour-preserving (they do not depend
 * on — and are not depended on by — the UI events / Router call they used to sit
 * between). The async trace-few-shot fetch and every `publishUiSyncEvent` stay
 * inline in `runMoAEnsemble`; only the pure derivations move here.
 */
import type { ModelMessage } from "ai";
import type { AppSettings } from "@/lib/types";
import type { PresetTier } from "@/lib/agent/presets";
import type { SkepticModelOverride } from "@/lib/agent/moa-personas";
import { getWorkerConfig } from "@/lib/agent/presets";
import {
  resolveSkepticModelConfig,
  resolveWorkerKey,
} from "@/lib/agent/moa-personas";
import { createWindowResolver } from "@/lib/agent/moa-window";
import { isSearchUsable } from "@/lib/tools/search-engine";

/**
 * The subset of `MoAOptions` the setup derivations read. A standalone interface
 * (rather than importing `MoAOptions` from `moa.ts`) keeps this a leaf module —
 * `moa.ts` imports the function, not the other way around, so there is no import
 * cycle. `MoAOptions` is structurally assignable to this, so `runMoAEnsemble`
 * passes its `options` straight through.
 */
export interface ResolveEnsembleSetupInput {
  settings: AppSettings;
  preset?: PresetTier;
  history: ModelMessage[];
  abortSignal?: AbortSignal;
  skepticModelOverride?: SkepticModelOverride | null;
  deepAudit?: boolean;
}

export interface EnsembleSetup {
  /** DDD — the operator's Skeptic model, resolved ONCE; feeds both surfaces. */
  skepticConfig: ReturnType<typeof resolveSkepticModelConfig>;
  /**
   * A8 — request-aware reflection: the Deep Audit toggle overrides the settings
   * default (kept OFF so inline-collapse survives normal turns). Feeds BOTH the
   * collapse gate and the reflection block in `runMoAEnsemble`.
   */
  reflectionEnabled: boolean;
  /**
   * Audit fix #4 — memoize context-window resolution for THIS ensemble run.
   * `resolveContextWindow` probes live Ollama (`/api/ps`) per call; without the
   * memo, N proposers + the aggregator fire up to N+1 redundant probes per turn
   * for the SAME config. Shared per `provider|model|baseUrl`.
   */
  resolveWindow: ReturnType<typeof createWindowResolver>;
  workerConfig: ReturnType<typeof resolveWorkerKey>;
  /**
   * Proposer-safe history: we cannot simply `slice(-N)` because it might break
   * tool-call sequences. Keep only text-based interactions for the proposers.
   */
  safeHistory: ModelMessage[];
  /**
   * The routing (DPG/Router) model config. Uses the cheaper utility model, and
   * falls back to `chatModel` when `utilityModel` is not properly configured
   * (e.g. a missing model string).
   */
  routerConfig: ReturnType<typeof resolveWorkerKey>;
  /**
   * PM #68 — proposer search tools gate on search being USABLE (key present),
   * not merely enabled, so the Skeptic/researcher aren't handed a `search_web`
   * that can only return "key not configured".
   */
  searchEnabled: boolean;
  /**
   * C3 — the operator's `maxSwarmSize`, clamped to [3, 7]. The clamp is
   * mandatory: the Router's zod schema is `.min(3).max(maxSwarmSize)`, so a
   * value < 3 makes min > max and crashes the Router every turn (R4). Non-finite
   * is guarded too: a corrupt settings value (e.g. a string) → NaN → `.max(NaN)`
   * also throws every turn; fall back to the default 5.
   */
  maxSwarmSize: number;
}

/**
 * Resolve the pure per-run setup for a MoA ensemble. See the file header for why
 * gathering these up front is behaviour-preserving.
 */
export function resolveEnsembleSetup(input: ResolveEnsembleSetupInput): EnsembleSetup {
  const { settings, preset, history, abortSignal, skepticModelOverride, deepAudit } = input;

  const skepticConfig = resolveSkepticModelConfig(settings, skepticModelOverride);
  const reflectionEnabled = deepAudit ?? settings.reflection?.enabled ?? false;
  const resolveWindow = createWindowResolver(abortSignal);

  const workerConfig = resolveWorkerKey(
    preset && preset !== "custom" ? getWorkerConfig(preset, settings.chatModel) : settings.utilityModel,
    settings
  );

  const safeHistory = history.filter((msg) =>
    msg.role === "user" ||
    (msg.role === "assistant" && typeof msg.content === "string")
  );

  const routingModelConfig = settings.utilityModel?.model
    ? settings.utilityModel
    : settings.chatModel;
  const routerConfig = resolveWorkerKey(routingModelConfig, settings);

  const searchEnabled = isSearchUsable(settings.search);

  const rawSwarmSize = settings.maxSwarmSize;
  const maxSwarmSize = Number.isFinite(rawSwarmSize)
    ? Math.min(7, Math.max(3, Math.floor(rawSwarmSize as number)))
    : 5;

  return {
    skepticConfig,
    reflectionEnabled,
    resolveWindow,
    workerConfig,
    safeHistory,
    routerConfig,
    searchEnabled,
    maxSwarmSize,
  };
}
