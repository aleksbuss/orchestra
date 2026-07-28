/**
 * Degradation policy (free-tier failover, Sprint 4).
 *
 * Sprints 1–3 make Orchestra substitute a healthy model when the configured one
 * is dead. That is the right default, but it is NOT a universally right answer:
 * a substituted model is a DIFFERENT model, so the answer's quality changes.
 * "Same quality, just slower" would be a dishonest pitch. So the choice belongs
 * to the user, not to us.
 *
 *   - `speed` (default): substitute automatically, and always SAY which model
 *     answered instead of which. Fastest path to an answer; quality may vary.
 *   - `quality`: never substitute. Retry the configured model, and if it still
 *     will not answer, say so honestly rather than quietly swapping in another
 *     model the user did not choose.
 *   - `ask`: like `quality`, except the terminal notice is phrased as a CHOICE
 *     ("retry, or switch to speed mode") so the user can decide for the next
 *     turn.
 *
 * **Honest limitation of `ask`.** Orchestra has no mid-turn user-input
 * primitive — SSE is one-way and the chat surface is turn-based — so `ask`
 * cannot pause a running turn and pop a dialog. It asks at the only point where
 * asking is possible: the end of the turn, once the pool is exhausted. This is
 * deliberate: per-empty-body prompting was rejected outright (one observed run
 * logged 14 empty bodies — 14 modals would be unusable), and faking a blocking
 * prompt that the runtime cannot honour would be worse than not having one.
 *
 * **Background runs are always `speed`.** Auto-Pilot / cron / external triggers
 * have nobody to ask and nobody to read a "try again later" notice, so an
 * unattended run always takes the answer it can get (`resolveDegradationPolicy`
 * forces it).
 */

import type { AppSettings } from "@/lib/types";

export type DegradationPolicy = "speed" | "quality" | "ask";

export const DEFAULT_DEGRADATION_POLICY: DegradationPolicy = "speed";

const VALID: readonly DegradationPolicy[] = ["speed", "quality", "ask"];

/** Type guard for the wire boundary (`/api/chat` body, persisted queue entries). */
export function isDegradationPolicy(value: unknown): value is DegradationPolicy {
  return typeof value === "string" && (VALID as readonly string[]).includes(value);
}

/**
 * Resolve the policy in force for one run.
 *
 * Precedence: background override > per-request override > settings > default.
 * An invalid value anywhere falls back rather than throwing — a bad policy
 * string must never be able to fail a turn.
 */
export function resolveDegradationPolicy(
  settings: Pick<AppSettings, "degradationPolicy"> | undefined,
  override?: unknown,
  options?: { background?: boolean }
): DegradationPolicy {
  if (options?.background) return "speed";
  if (isDegradationPolicy(override)) return override;
  if (isDegradationPolicy(settings?.degradationPolicy)) return settings.degradationPolicy;
  return DEFAULT_DEGRADATION_POLICY;
}

/**
 * May this run swap in a different model when the configured one is unusable?
 *
 * Only `speed` may. `quality` and `ask` both keep the user's model and report
 * the failure — they differ in the WORDING of the terminal notice, not in the
 * substitution decision, because the runtime has no way to block a turn on a
 * user's answer (see the module docstring).
 */
export function allowsModelSubstitution(policy: DegradationPolicy): boolean {
  return policy === "speed";
}

/**
 * Operator-facing notice for a turn no model could answer, worded for `policy`.
 *
 * `speed` never reaches this with a substitution available — it only lands here
 * when the whole pool is exhausted too.
 */
export function undeliverableNotice(
  policy: DegradationPolicy,
  endpoint: string,
  substituteAvailable: boolean
): string {
  if (policy === "quality" && substituteAvailable) {
    return (
      `[Agent] ${endpoint} returned an empty response and quality mode is on, so no other ` +
      `model was substituted. Free/shared endpoints are commonly rate-limited under load — ` +
      `press Continue to retry the same model.`
    );
  }
  if (policy === "ask" && substituteAvailable) {
    return (
      `[Agent] ${endpoint} returned an empty response. Press Continue to retry the same ` +
      `model, or switch the degradation policy to "speed" in Settings to let Orchestra ` +
      `answer with another configured model automatically (its quality may differ).`
    );
  }
  return (
    `[Agent] Every configured model returned an empty response for this turn. Free/shared ` +
    `endpoints are commonly rate-limited under load — press Continue to retry, or switch to ` +
    `a more reliable model in Settings → Models.`
  );
}
