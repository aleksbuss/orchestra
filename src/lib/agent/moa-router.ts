/**
 * PM #57 — extracted from `moa.ts`. Dynamic Persona Generation (DPG)
 * for the MoA Router. Calls `generateObject` against the utility model
 * to produce 3–5 hyper-specialized expert personas tailored to the
 * user's prompt; falls back to `MOA_PROPOSERS` (the static set in
 * `moa-personas.ts`) on any failure.
 *
 * Honors:
 *   - PM #37 — force-injects the canonical Adversarial Critic when the
 *     LLM omits a skeptic persona, capped at 5 personas total.
 *   - PM #42/#45 — skeptic detection goes through `detectProposerRole`
 *     so PM #42 tool-routing and PM #37 force-injection see the same
 *     "is this a reviewer?" answer.
 *   - PM #48 — passes the `modelTier` hint into the Zod schema so the
 *     LLM can suggest cheap-Haiku-for-Skeptic / Opus-for-Coder routing.
 *   - PM #51 — accepts an optional `fewShotsBlock` rendered from past
 *     successful traces, appended to the Router prompt to bias persona
 *     generation toward proven patterns.
 *
 * Re-exported from `./moa` for backward compat.
 */

import { callDeadlineSignal } from "@/lib/agent/stream-watchdog";
import { generateObject, type ModelMessage } from "ai";
import { z } from "zod";
import type { ModelConfig } from "@/lib/types";
import { createModel } from "@/lib/providers/llm-provider";
import { resolveMaxOutputTokens } from "@/lib/providers/model-output-limits";
import { log } from "@/lib/observability/logger";
import {
  detectProposerRole,
  MOA_PROPOSERS,
  type MoAProposer,
} from "@/lib/agent/moa-personas";
import { applyIdenticalPromptsArm } from "@/lib/agent/eval-arms";
import { abortableSleep, isFreeTierModel } from "@/lib/agent/proposer-pacing";

/**
 * How many RETRIES (not attempts) the Router gets, by tier.
 *
 * Free endpoints get more, but not many more. The instinct is "it costs $0, so
 * hammer it" — and the cost that actually binds is not money. OpenRouter's free
 * tier is 20 requests/MINUTE and buying credit does not raise it; failed
 * attempts still consume the daily quota. Within one turn, 3-5 proposers fire
 * in PARALLEL against the same endpoint seconds after the Router finishes, so a
 * Router that keeps retrying is spending the exact per-minute budget its own
 * proposers are about to need.
 *
 * Two retries also matches `PROPOSER_EMPTY_RETRIES` (the free-tier retry
 * constant already chosen elsewhere in this stack) and sits at the top of what
 * the evidence supports: one retry catches the large majority of structured-
 * output failures and the recommended ceiling is 2-3 attempts. Beyond that the
 * curve flattens hard while runtime keeps growing.
 */
const PAID_ROUTER_RETRIES = 1;
const FREE_ROUTER_RETRIES = 2;

function routerRetryBudget(modelConfig: ModelConfig): number {
  const override = Number(process.env.ORCHESTRA_ROUTER_RETRIES);
  if (Number.isFinite(override) && override >= 0) return Math.floor(override);
  return isFreeTierModel(modelConfig.model) ? FREE_ROUTER_RETRIES : PAID_ROUTER_RETRIES;
}

/** Same shape as the proposer empty-result backoff, and the same env knob. */
function routerBackoffMs(attempt: number): number {
  return Number(process.env.ORCHESTRA_PROPOSER_EMPTY_BACKOFF_MS ?? 2000) * (attempt + 1);
}

/**
 * A throttled or overloaded free endpoint is the one failure a plain re-send
 * genuinely fixes — waiting is the whole remedy. `classifyRouterError` buckets
 * 429 as "other" (its "auth" branch matches the word `quota`, which is a
 * different condition), so throttle is detected separately rather than by
 * widening that classifier and disturbing the telemetry it already feeds.
 */
function isThrottleError(err: unknown): boolean {
  const msg = describeRouterError(err).toLowerCase();
  return /429|rate.?limit|too many requests|overloaded|capacity|try again/.test(msg);
}

/**
 * Which failures are worth another call.
 *
 * - `schema` — always. A malformed draft is the defect this exists for, and the
 *   retry carries the validation error back to the model (see `repairHint`).
 * - throttle / `timeout` — FREE tier only. On a paid endpoint the same
 *   condition means the operator is paying twice to wait; on a free one it is
 *   the expected steady state the whole failover stack was built around.
 * - `auth` (401/402/credit) and `not_found` (404) — NEVER. No number of
 *   retries conjures credit, a key, or a model that is not deployed.
 */
function isRetryableRouterError(err: unknown, freeTier: boolean): boolean {
  const kind = classifyRouterError(err);
  if (kind === "auth" || kind === "not_found") return false;
  if (kind === "schema") return true;
  if (!freeTier) return false;
  return kind === "timeout" || isThrottleError(err);
}

/**
 * DDD / PM #89 — classify a Router failure so the fallback telemetry says WHY
 * the DPG degraded to static personas, not just that it did. Coarse by design
 * (the message shapes vary per provider); "other" is the honest catch-all.
 */
/**
 * Extract a RICH, greppable description from a Router error. The AI SDK's
 * `NoObjectGeneratedError` / `APICallError` frequently carry an EMPTY `.message`
 * (the useful detail lives in `.name`, `.finishReason`, `.text` (raw model
 * output), `.statusCode`, `.responseBody`, or `.cause`) — so logging bare
 * `err.message` produced `error=""` and mis-classified a schema failure as
 * "other" (observed live with a coder model as the Router). Surface all of them.
 */
export function describeRouterError(err: unknown): string {
  if (!(err instanceof Error)) return String(err) || "(non-error thrown)";
  const parts: string[] = [];
  if (err.name && err.name !== "Error") parts.push(err.name);
  if (err.message) parts.push(err.message);
  const anyErr = err as unknown as Record<string, unknown>;
  if (typeof anyErr.statusCode === "number") parts.push(`status=${anyErr.statusCode}`);
  if (typeof anyErr.finishReason === "string") parts.push(`finishReason=${anyErr.finishReason}`);
  if (typeof anyErr.text === "string" && anyErr.text) parts.push(`text=${anyErr.text.slice(0, 200)}`);
  if (typeof anyErr.responseBody === "string" && anyErr.responseBody) {
    parts.push(`body=${anyErr.responseBody.slice(0, 200)}`);
  }
  const cause = anyErr.cause;
  if (cause instanceof Error && cause.message) parts.push(`cause=${cause.message}`);
  else if (typeof cause === "string" && cause) parts.push(`cause=${cause}`);
  return parts.join(" | ") || "(no error detail)";
}

export function classifyRouterError(err: unknown): string {
  const name = (err instanceof Error ? err.name : "").toLowerCase();
  const msg = describeRouterError(err).toLowerCase();
  if (/401|403|unauthor|api key|no auth|invalid.*key|credit|402|quota|billing/.test(msg)) {
    return "auth";
  }
  if (/404|no endpoints|not found|no such model|unknown model/.test(msg)) {
    return "not_found";
  }
  if (/abort|timeout|timed out|etimedout|econnreset/.test(msg)) {
    return "timeout";
  }
  // A structured-output failure often has an EMPTY message — key on the AI SDK
  // error NAME too, not just the text, so an empty-message schema failure is not
  // mis-bucketed as "other".
  if (
    name.includes("noobjectgenerated") ||
    name.includes("typevalidation") ||
    name.includes("jsonparse") ||
    /schema|parse|invalid json|zod|validation|no object generated|could not parse/.test(msg)
  ) {
    return "schema";
  }
  return "other";
}

export interface DPGResult {
  requiresSwarm: boolean;
  personas: MoAProposer[];
  /** Router LLM usage so the caller can fold it into the chat cumulative (PM #36). */
  usage?: import("@/lib/cost/accumulator").RawUsage;
  /**
   * True when the Router could not produce personas and the STATIC set was
   * substituted. The fallback is fail-safe, which is exactly the problem: the
   * user still gets an answer, so a swarm that has silently lost role
   * specialisation and tournament judging looks identical to a healthy one.
   * The caller surfaces this on the Router's UI node — the alternative is a
   * degradation only visible by reading stdout.
   *
   * Callers must not infer this from `usage` being absent. That correlation
   * holds today by accident of where the fallback returns, not by contract.
   */
  degraded?: boolean;
}

/**
 * Dynamically generates 3-5 hyper-specialized expert personas tailored to the user's prompt.
 * Includes Intelligent Bypass: evaluates if the task actually needs a swarm.
 */
export async function generateDynamicSwarm(
  userMessage: string,
  history: ModelMessage[],
  modelConfig: ModelConfig,
  searchEnabled: boolean,
  abortSignal?: AbortSignal,
  // PM #51 — rendered past-trace fewshots block. Empty string when
  // trace memory is disabled or no relevant traces found. Appended
  // after the INSTRUCTIONS list so it biases persona generation
  // without interfering with the structured-output schema.
  fewShotsBlock: string = "",
  maxSwarmSize: number = 5
): Promise<DPGResult> {
  try {
    // Format the last 5 messages for context — content can be string or array (tool-calls)
    const recentContext = history.slice(-5).map(m => {
      const text = typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map(p => (typeof p === "object" && p !== null && "text" in p ? (p as {text: string}).text : "")).join(" ")
          : String(m.content);
      return `[${m.role.toUpperCase()}]: ${text.slice(0, 500)}`;
    }).join("\n");

    const routerModel = createModel(modelConfig, {});
    const runRouterCall = (repairHint: string = "") => generateObject({
      model: routerModel,
      // Every other LLM call in the agent/MoA path caps output via
      // resolveMaxOutputTokens(settings.<role>Model) (agent.ts, moa.ts). This
      // call was the one exception, so `generateObject` requested the
      // model's own default ceiling (e.g. 65535) — on an account near its
      // OpenRouter credit limit that 402s outright, and the catch below
      // unconditionally falls back to `requiresSwarm: true`. The Router then
      // ALWAYS fans out the full proposer ensemble (more expensive than the
      // failed Router call), silently defeating the "skip trivial prompts"
      // bypass it exists to provide. Confirmed live during forceSwarm
      // verification (2026-06).
      maxOutputTokens: resolveMaxOutputTokens(modelConfig),
      schema: z.object({
        requiresSwarm: z.boolean().describe("Set to false ONLY IF the user's message is a simple conversational reply (e.g. 'thanks', 'hello') or a trivial task that a single AI agent can handle easily without needing a committee of diverse experts."),
        personas: z.array(z.object({
          id: z.string().describe("A short snake_case id (e.g. 'tax_lawyer')"),
          role: z.string().describe("The human-readable Title/Role of the expert (e.g. 'Senior Tax Attorney')"),
          systemPrompt: z.string().describe("The specific system prompt Rules and Guidelines for this expert. MUST follow structure: [GOAL] ... [RULES] ... [FORMAT]"),
          color: z.enum(["slate", "gray", "zinc", "neutral", "stone", "red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal", "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink", "rose"]).describe("A distinct tailwind color for UI representation"),
          modelTier: z.enum(["fast", "balanced", "frontier"]).optional().describe("PM #48 — suggested model tier. 'fast' for skeptic/critic/QA personas (cheap, just evaluates). 'balanced' for analyst/researcher (mid quality). 'frontier' for coder/architect/synthesis-heavy personas (best quality). Omit to let Orchestra derive from the role automatically.")
        })).min(3).max(maxSwarmSize).describe(`List of exactly 3 to ${maxSwarmSize} highly specialized experts required to answer the user request. Only used if requiresSwarm is true.`)
      }),
      prompt: `You are the Orchestra Auto-Swarm Router.
The user has submitted a request. Your job is to determine if a "Dream Team" of experts is needed.

RECENT CONTEXT:
${recentContext}

CURRENT USER REQUEST (truncated if too long):
${userMessage.slice(0, 2000)}

INSTRUCTIONS:
1. If the request is trivial, conversational, or a simple code edit, set requiresSwarm to false.
2. If the request requires multi-faceted analysis, deep architecture, creative brainstorming, or complex problem solving, set requiresSwarm to true.
3. If true, assemble 3 to ${maxSwarmSize} hyper-specialized domain experts. Do NOT use generic roles.
4. For each expert, provide a highly specific systemPrompt using this exact structure:
   [GOAL] What they are trying to achieve from their narrow perspective.
   [RULES] 2-3 strict guidelines they must follow (e.g., "Always hunt for edge cases", "Never propose complex solutions").
   [FORMAT] How they should format their answer.
5. VERY IMPORTANT: One of your 3 to ${maxSwarmSize} experts MUST ALWAYS be a "QA Auditor / Fact-Checker" (e.g., \`skeptic_auditor\`). Their [GOAL] is to doubt the user's premise, search for potential pitfalls, verify library compatibilities via \`search_web\` (if available), and actively try to find edge cases where the proposed solution would fail. When a factual claim looks doubtful — or comes only from a search summary — their [RULES] MUST instruct them to call the \`fetch_webpage\` tool to read the RAW source page and verify it directly. A \`search_web\` snippet is a lead, NOT proof.
6. (PM #48 — model tier hint): for each expert, set \`modelTier\` to "fast" / "balanced" / "frontier":
   - "fast" for QA / Skeptic / Critic / Reviewer personas — they evaluate, not synthesize. Cheap reliable models are enough.
   - "balanced" for Analyst / Researcher / Domain-Expert / Tool-Operator personas — they need clarity, not maximum reasoning depth.
   - "frontier" for Coder / Architect / Implementation / Deep-Synthesis personas — output quality scales meaningfully with model size.
   This lets the operator route different personas to different models (e.g., Skeptic on cheap Haiku, Coder on premium Opus, with the Aggregator unchanged). If you can't decide, omit the field and Orchestra will pick from the role.${searchEnabled ? `
7. VERY IMPORTANT: You have access to the 'search_web' tool. If an expert requires real-time facts, news, documentation, or live data to solve the request, you MUST explicitly instruct them in their [RULES] to call the 'search_web' tool first before answering.` : ""}${fewShotsBlock}${repairHint}`,
      // PM #98 — the Router's generateObject had no time bound.
      abortSignal: callDeadlineSignal(abortSignal),
    });

    // Retry budget by TIER, and only for failures another call can fix.
    //
    // Observed live on `google/gemma-4-26b-a4b-it:free` — the model Free Mode
    // picks as Router, because it is one of the few free ids advertising
    // `structured_outputs`. It intermittently returns output the schema
    // rejects (once `personas: []` against `min(3)`, once unparseable text).
    // The fallback below is fail-safe, but the turn still LOOKS healthy: the
    // user gets an answer while the swarm has quietly lost role specialisation
    // and tournament judging.
    //
    // THE RETRY CARRIES THE ERROR BACK. Re-sending an identical prompt draws
    // from the same distribution that just failed, so a bare re-draw is close
    // to worthless for a constrained-decoding failure — feeding the validation
    // message in is what makes a second attempt worth its quota.
    const freeTier = isFreeTierModel(modelConfig.model);
    const maxRetries = routerRetryBudget(modelConfig);
    let routerResult: Awaited<ReturnType<typeof runRouterCall>> | undefined;
    let repairHint = "";

    for (let attempt = 0; ; attempt++) {
      try {
        routerResult = await runRouterCall(repairHint);
        if (attempt > 0) {
          log.info("moa_router_retry_rescued", {
            module: "moa-router",
            provider: modelConfig.provider,
            model: modelConfig.model,
            attempt,
          });
          console.warn(`[MoA] Router retry #${attempt} succeeded — DPG personas recovered.`);
        }
        break;
      } catch (err) {
        if (attempt >= maxRetries || !isRetryableRouterError(err, freeTier)) throw err;

        const kind = classifyRouterError(err);
        // Logged on every retry whether or not it rescues the turn, so the real
        // rate is readable from the logs alone — instrumenting and fixing are
        // the same change here, so the measurement comes free with the fix.
        log.warn("moa_router_retry", {
          module: "moa-router",
          provider: modelConfig.provider,
          model: modelConfig.model,
          attempt,
          maxRetries,
          freeTier,
          reason: kind,
          error: describeRouterError(err),
        });

        if (kind === "schema") {
          // Truncated: the useful part is the constraint that was violated, and
          // an unbounded error string would eat the Router's own token budget.
          repairHint =
            `\n\n[RETRY — YOUR PREVIOUS RESPONSE WAS REJECTED]\n` +
            `The last attempt did not satisfy the required output schema: ` +
            `${describeRouterError(err).slice(0, 500)}\n` +
            `Return ONLY valid output matching the schema. You MUST provide at ` +
            `least 3 personas.`;
          console.warn(
            `[MoA] Router returned malformed structured output on ${modelConfig.provider}/${modelConfig.model} — retrying with the validation error fed back (attempt ${attempt + 1}/${maxRetries}).`
          );
        } else {
          // Throttle / timeout: waiting IS the remedy, so back off rather than
          // re-sending immediately into the same closed window.
          const backoff = routerBackoffMs(attempt);
          console.warn(
            `[MoA] Router hit ${kind} on a free endpoint — backing off ${backoff}ms before retry ${attempt + 1}/${maxRetries}.`
          );
          await abortableSleep(backoff, abortSignal);
        }
      }
    }

    const { object, usage } = routerResult!;

    // PM #37 — guarantee the QA Auditor / Skeptic. CLAUDE.md §1 promises
    // "one DPG role is ALWAYS forced to be a QA Auditor / Skeptic", but
    // the previous implementation relied entirely on a prompt instruction.
    // A weak utility-model can ignore the instruction and produce 3-5
    // personas without a critic, leaving the swarm without the
    // zero-latency fact-checking mandate. We post-validate the LLM's
    // output and inject the canonical Adversarial Critic if missing.
    //
    // PM #45 — skeptic detection now goes through `detectProposerRole`
    // (the same helper PM #42's tool routing uses). Previously this site
    // had its own narrower SKEPTIC_PATTERN that missed "qa", "quality",
    // "review" — so a DPG-returned persona like "qa_engineer" would be
    // classified as a reviewer by PM #42 (gets search_web) but NOT seen
    // as a skeptic by PM #37 → critic was force-injected anyway, leaving
    // the swarm with two reviewer-shape personas competing for the same
    // role. Single source of truth fixes the inconsistency.
    const hasSkeptic = (object.personas as MoAProposer[]).some(
      (p) => detectProposerRole(p) === "reviewer"
    );
    let personas = object.personas as MoAProposer[];
    // PM #91 — inject UNCONDITIONALLY (was gated on `object.requiresSwarm`).
    // The old gate skipped injection whenever the Router judged the prompt
    // trivial (`requiresSwarm: false`). But `forceSwarm` (the user's "run the
    // swarm anyway" override) resurrects exactly that swarm at the fan-out site
    // in `moa.ts`, and the Router never receives `forceSwarm` — so it could not
    // know these personas would actually run. Gating here left the
    // `forceSwarm` + trivial-verdict corner fanning out with NO guaranteed
    // Skeptic, breaking the CLAUDE.md §1 invariant. Injecting always is FREE on
    // the genuine-bypass path: the personas are discarded before any proposer
    // runs, so no extra LLM call is made. It also mirrors the catch/fallback
    // branch below, which already guarantees a skeptic via the same
    // `!hasSkeptic` check with no `requiresSwarm` gate.
    if (!hasSkeptic) {
      console.warn(
        `[MoA] DPG output missing a Skeptic persona — force-injecting canonical 'critic' (PM #37). Roles received: ${object.personas.map((p) => p.id).join(", ")}`
      );
      const canonicalCritic = MOA_PROPOSERS.find((p) => p.id === "critic")!;
      // Cap at maxSwarmSize personas total to keep the cost envelope predictable.
      // If the LLM already returned maxSwarmSize, evict the LAST one (heuristic:
      // the LLM's tail picks are usually the weakest).
      personas = [...object.personas];
      if (personas.length >= maxSwarmSize) personas.pop();
      personas.push({
        id: canonicalCritic.id,
        role: canonicalCritic.role,
        systemPrompt: canonicalCritic.systemPrompt,
        color: canonicalCritic.color,
      });
    }
    // DDD / PM #89 — make the Router's resolved model permanently VISIBLE in
    // the turn log. The 2026-07-04 incident (utilityModel = openrouter/free →
    // degenerate personas) was invisible precisely because nothing said WHICH
    // model generated the personas. This line would have exposed it at once.
    console.log(
      `[MoA] Router (DPG) personas generated by ${modelConfig.provider}/${modelConfig.model} — ${personas.length} persona(s), requiresSwarm=${object.requiresSwarm}`
    );
    return {
      requiresSwarm: object.requiresSwarm,
      // Both wrappers are strict no-ops unless their dev-only eval flag is set.
      // Identical-prompts runs LAST because it replaces every persona outright
      // (the self-MoA arm has no roles at all, skeptic control included).
      personas: applyIdenticalPromptsArm(applySkepticControlArm(personas)),
      usage,
    };
  } catch (err) {
    // DDD / PM #89 — the fallback is fail-safe (never throws), but it must not
    // be SILENT. A structured event + a classified reason turns "the swarm
    // felt dumb" into a greppable signal naming the model and the failure kind.
    const reason = classifyRouterError(err);
    console.warn(
      `[MoA] Router fallback → static personas (reason=${reason}, model=${modelConfig.provider}/${modelConfig.model}). DPG did not run.`
    );
    log.warn("moa_router_fallback", {
      module: "moa-router",
      reason,
      provider: modelConfig.provider,
      model: modelConfig.model,
      error: describeRouterError(err),
    });

    const fallbackPersonas = MOA_PROPOSERS.slice(0, maxSwarmSize);
    const hasSkepticFallback = fallbackPersonas.some((p) => detectProposerRole(p) === "reviewer");
    if (!hasSkepticFallback) {
      fallbackPersonas.pop();
      fallbackPersonas.push(MOA_PROPOSERS.find((p) => p.id === "critic")!);
    }

    return {
      requiresSwarm: true,
      degraded: true,
      personas: applyIdenticalPromptsArm(applySkepticControlArm(fallbackPersonas)),
      // Usage is unknown when the Router crashes; the chat banner just
      // misses the Router's tokens for this turn (a small undercount).
    };
  }
}

// ---------------------------------------------------------------------------
// Skeptic-eval Step 2 — test/eval-only causal-isolation CONTROL ARM.
//
// Production is UNTOUCHED: `isSkepticControlArmActive()` is false with the flag
// unset (the default) OR in a production build, so `applySkepticControlArm` is
// a strict no-op on every real run and the PM #91 unconditional-Skeptic
// invariant holds. The flag exists ONLY so an operator can A/B the fact-trap
// eval suite (PR #51) with the guaranteed Skeptic ON vs swapped-out, isolating
// its causal contribution. NEVER enable in production.
// ---------------------------------------------------------------------------

const SKEPTIC_CONTROL_ENV = "ORCHESTRA_EVAL_SKEPTIC_CONTROL";

/** True ONLY in a non-production process with the eval flag set to "true". */
export function isSkepticControlArmActive(): boolean {
  return (
    process.env[SKEPTIC_CONTROL_ENV] === "true" &&
    process.env.NODE_ENV !== "production"
  );
}

/**
 * Neutral filler occupying a former Skeptic slot (same headcount). Two
 * properties matter, both pinned by tests:
 *   1. It avoids every `detectProposerRole` reviewer token (review / critic /
 *      audit / qa / quality / skeptic / adversar / red-team / fact-check) so it
 *      is NOT re-classified as a second skeptic downstream (moa.ts).
 *   2. Its "General Analyst" role classifies as `researcher`, and reviewer AND
 *      researcher get the SAME tools (search_web) in moa-proposer-tools.ts — so
 *      the A/B holds TOOLS CONSTANT and isolates ONLY the skeptic persona prompt
 *      (no search_web confound; raised by the doubt-driven review). Do NOT
 *      rename it to a role that drops out of the reviewer/researcher tool bucket.
 */
function genericControlPersona(index: number): MoAProposer {
  return {
    id: `control_analyst_${index}`,
    role: "General Analyst",
    color: "slate",
    systemPrompt:
      "You are a general analyst. Answer the user's request directly, " +
      "accurately, and completely from your own knowledge. Give your own " +
      "best, self-contained response.",
  };
}

/**
 * Replace EVERY reviewer-role persona (a DPG-produced skeptic OR the PM #37/#91
 * force-injected canonical critic) with a neutral analyst of the SAME slot,
 * yielding a swarm of identical headcount with NO guaranteed Skeptic. No-op
 * unless `isSkepticControlArmActive()` (see the banner above).
 */
export function applySkepticControlArm(personas: MoAProposer[]): MoAProposer[] {
  if (!isSkepticControlArmActive()) return personas;
  let swapped = 0;
  const controlled = personas.map((persona, index) => {
    if (detectProposerRole(persona) === "reviewer") {
      swapped++;
      return genericControlPersona(index);
    }
    return persona;
  });
  console.warn(
    `[MoA] ⚠️ Skeptic CONTROL ARM active (${SKEPTIC_CONTROL_ENV}) — swapped ${swapped} reviewer persona(s) for neutral analyst(s); this swarm has NO critic. FOR EVAL/A-B ONLY, never production.`
  );
  return controlled;
}
