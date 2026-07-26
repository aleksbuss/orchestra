/**
 * Eval-only experiment arms for the selection-vs-averaging factorial run.
 *
 * SAME POSTURE AS `ORCHESTRA_EVAL_SKEPTIC_CONTROL` (moa-router.ts): every flag
 * here is honored ONLY when `NODE_ENV !== "production"`, defaults to OFF, is a
 * STRICT NO-OP when unset, and warns LOUDLY when it fires. Production behaviour
 * is byte-identical with the flags unset, which is the default.
 *
 * Why this module exists at all: the experiment needs to vary TWO independent
 * factors across the same eval cases without editing settings or case files
 * between arms (an edit between arms is a confound waiting to happen):
 *
 *   1. AGGREGATION: synthesis (blend N drafts into a new answer) vs tournament
 *      (K judges rank the drafts; the winner is carried forward verbatim).
 *      → `ORCHESTRA_EVAL_AGGREGATOR_MODE=synthesis|tournament`
 *   2. PROMPT DIVERSITY: DPG role personas vs N copies of ONE neutral prompt
 *      (plain self-MoA / Best-of-N sampling of the same model).
 *      → `ORCHESTRA_EVAL_IDENTICAL_PROMPTS=true`
 *
 * Crossing them gives the 5 arms (control / A / B / C / D) in
 * `docs/moa-selection-vs-averaging.md`. NEVER set either in production.
 *
 * The sibling Skeptic control arm (`applySkepticControlArm`) deliberately stays
 * in `moa-router.ts` next to persona generation — it is referenced here only so
 * the two are not enabled together by accident (see `warnOnArmConflict`).
 */

import type { MoAProposer } from "@/lib/agent/moa-personas";

const AGGREGATOR_MODE_ENV = "ORCHESTRA_EVAL_AGGREGATOR_MODE";
const IDENTICAL_PROMPTS_ENV = "ORCHESTRA_EVAL_IDENTICAL_PROMPTS";
const SKEPTIC_CONTROL_ENV = "ORCHESTRA_EVAL_SKEPTIC_CONTROL";

export type AggregatorMode = "synthesis" | "tournament";

/** Eval arms are dev-only. A production build ignores every flag in this file. */
function evalArmsHonored(): boolean {
  return process.env.NODE_ENV !== "production";
}

/**
 * Resolve the aggregator mode for this run, letting the eval override win over
 * `settings.aggregator.mode`.
 *
 * An UNKNOWN value is warned about and IGNORED (the configured mode stands) —
 * a library must not kill a live turn over an operator typo. The CLI
 * (`run-evals.ts`) validates the same variable and REFUSES to start, which is
 * the real gate: an experiment must never run under a mislabeled arm.
 */
export function resolveEvalAggregatorMode(configured: AggregatorMode): AggregatorMode {
  if (!evalArmsHonored()) return configured;
  const raw = process.env[AGGREGATOR_MODE_ENV];
  if (raw === undefined || raw === "") return configured;
  if (raw !== "synthesis" && raw !== "tournament") {
    console.warn(
      `[MoA] ⚠️ ${AGGREGATOR_MODE_ENV}="${raw}" is not "synthesis" or "tournament" — IGNORING it and using the configured mode "${configured}".`
    );
    return configured;
  }
  if (raw !== configured) {
    console.warn(
      `[MoA] ⚠️ EVAL ARM: ${AGGREGATOR_MODE_ENV}=${raw} overrides settings.aggregator.mode="${configured}". FOR EVAL/A-B ONLY, never production.`
    );
  }
  return raw;
}

/** True ONLY in a non-production process with the identical-prompts flag set. */
export function isIdenticalPromptsArmActive(): boolean {
  return process.env[IDENTICAL_PROMPTS_ENV] === "true" && evalArmsHonored();
}

/**
 * The ONE prompt every proposer gets in the self-MoA arm. Deliberately neutral
 * and role-free: this arm exists to measure what plain N-sampling of the same
 * model buys, with ZERO role specialization. Two properties are load-bearing
 * and pinned by tests:
 *
 *   1. It contains no reviewer token (review / critic / audit / qa / quality /
 *      skeptic / adversar / red-team / fact-check), so `detectProposerRole`
 *      cannot classify a sample as a skeptic and hand it different tools.
 *   2. The role string "General Analyst" classifies as `researcher`, the same
 *      bucket the Skeptic control arm uses — so tool availability is held
 *      CONSTANT across arms and only prompt DIVERSITY varies.
 */
export const IDENTICAL_PROMPT_TEXT =
  "You are a general analyst. Answer the user's request directly, " +
  "accurately, and completely from your own knowledge. Give your own " +
  "best, self-contained response.";

/**
 * Replace every persona with a copy of ONE neutral prompt, preserving the
 * HEADCOUNT the Router chose. Same-N is the point: arm A/B must differ from
 * arm C/D only in prompt diversity, not in how many samples were drawn.
 *
 * Ids stay DISTINCT (`sample_1..N`) because the proposer id keys the UI DAG
 * nodes, the per-draft telemetry and the tournament ballots — collapsing them
 * to one id would corrupt all three.
 *
 * No-op unless `isIdenticalPromptsArmActive()`.
 */
export function applyIdenticalPromptsArm(personas: MoAProposer[]): MoAProposer[] {
  if (!isIdenticalPromptsArmActive()) return personas;
  warnOnArmConflict();
  const samples = personas.map((persona, index) => ({
    id: `sample_${index + 1}`,
    role: "General Analyst",
    color: persona.color,
    systemPrompt: IDENTICAL_PROMPT_TEXT,
  }));
  console.warn(
    `[MoA] ⚠️ IDENTICAL-PROMPTS ARM active (${IDENTICAL_PROMPTS_ENV}) — replaced ${personas.length} DPG persona(s) with ${samples.length} copies of one neutral prompt (self-MoA / Best-of-N). No role specialization, no Skeptic. FOR EVAL/A-B ONLY, never production.`
  );
  return samples;
}

/**
 * The identical-prompts arm already removes every role INCLUDING the Skeptic,
 * so running it together with the Skeptic control arm confounds two factors
 * into one number. Warn rather than throw — the operator may have a reason,
 * but they should never discover the overlap while reading results.
 */
function warnOnArmConflict(): void {
  if (process.env[SKEPTIC_CONTROL_ENV] === "true") {
    console.warn(
      `[MoA] ⚠️ CONFOUND: ${IDENTICAL_PROMPTS_ENV} and ${SKEPTIC_CONTROL_ENV} are BOTH set. The identical-prompts arm already strips every role (Skeptic included), so the skeptic control arm changes nothing and the result cannot be attributed to either factor.`
    );
  }
}

/**
 * One-line description of the active arms, for the eval report header and the
 * results JSON. Returns `null` when no arm flag is set (the production shape),
 * so a caller can print nothing rather than "arms: none".
 */
export function describeActiveEvalArms(): string | null {
  if (!evalArmsHonored()) return null;
  const parts: string[] = [];
  // The swarm-mode arm lives in the runner (runner.ts), but it MUST appear here:
  // a results file labeled "(none)" for what was actually the single-agent
  // control arm is exactly the mislabeling this field exists to prevent.
  const swarm = process.env.ORCHESTRA_EVAL_SWARM_MODE;
  if (swarm) parts.push(`swarm=${swarm}`);
  const aggregator = process.env[AGGREGATOR_MODE_ENV];
  if (aggregator) parts.push(`aggregator=${aggregator}`);
  if (isIdenticalPromptsArmActive()) parts.push("prompts=identical");
  if (process.env[SKEPTIC_CONTROL_ENV] === "true") parts.push("skeptic=control");
  return parts.length > 0 ? parts.join(" ") : null;
}
