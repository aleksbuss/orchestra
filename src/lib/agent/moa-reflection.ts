/**
 * MoA reflection loop (Sprint 5 §10 — extracted from `runMoAEnsemble`). The
 * generator-critic-revisor pass (PM #38 single-round + PM #46 multi-round) that
 * runs AFTER the synthesis aggregator when reflection is enabled. Pulled out of
 * moa.ts as a self-contained transform: given the aggregator's answer + the
 * running usage, it returns the (possibly-revised) answer, the updated usage,
 * and the two outcome signals the caller records in the trace
 * (`reflectionRevisionsExecuted`, `reflectionHitCap`). The other three exit
 * flags (criticCleanedUp / cannotFix / converged) stay internal — they only
 * feed the single `ddd_reflection_outcome` log event emitted here.
 *
 * The reflection PRIMITIVES (`reflectOnResponse` / `reviseWithCritique` /
 * `deriveReflectionOutcome`) already live in `reflection.ts`; this owns only the
 * loop orchestration + stopping conditions.
 */
import { reflectOnResponse, reviseWithCritique, deriveReflectionOutcome } from "@/lib/agent/reflection";
import { embedTexts } from "@/lib/memory/embeddings";
import { addUsageToCumulative } from "@/lib/cost/accumulator";
import { log } from "@/lib/observability/logger";
import type { AppSettings, ChatUsage } from "@/lib/types";

// The ModelConfig shape the reflection primitives accept for `modelOverride`.
// Derived from `reflectOnResponse` so we don't re-import the resolver types.
type ReflectionModelConfig = NonNullable<Parameters<typeof reflectOnResponse>[0]["modelOverride"]>;

// ── Local cosine similarity (PM #46 convergence check) ─────────────────
// Same algorithm as in `disagreement.ts` and `blackboard.ts`. Inlined here (the
// convergence check is now this file's sole caller in the MoA path) to keep the
// import surface tight; if a fourth caller materialises, extract to
// `src/lib/memory/embeddings.ts`.
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface ReflectionLoopParams {
  /** When false the loop is a no-op — returns the initial text/usage unchanged. */
  reflectionEnabled: boolean;
  /** The aggregator's answer to review (mutated by revisions). */
  initialText: string;
  /** Running MoA usage; reflection/revisor tokens are folded in (PM #36). */
  usage: ChatUsage | undefined;
  userMessage: string;
  settings: AppSettings;
  /** DDD — critic (judge) model: operator's Skeptic wins, else the brain. */
  skepticConfig: ReflectionModelConfig | undefined;
  /** The brain model — the revisor writes on it (only the judge is overridable). */
  brainConfig: ReflectionModelConfig;
  projectId?: string;
  chatId: string;
  abortSignal?: AbortSignal;
}

export interface ReflectionLoopResult {
  /** The final answer after any revisions (== initialText when clean/disabled). */
  finalText: string;
  /** Usage with reflection/revisor tokens folded in. */
  usage: ChatUsage | undefined;
  /** Number of times the revisor ran (0 == critic clean from round 1). */
  reflectionRevisionsExecuted: number;
  /** Ran out of rounds without the critic ever cleaning up. */
  reflectionHitCap: boolean;
}

/**
 * Run the generator-critic-revisor reflection loop. See the file header. The
 * body is a behaviour-preserving move of the block that used to live inline in
 * `runMoAEnsemble` after the synthesis aggregator.
 */
export async function runReflectionLoop(params: ReflectionLoopParams): Promise<ReflectionLoopResult> {
  const {
    reflectionEnabled,
    initialText,
    userMessage,
    settings,
    skepticConfig,
    brainConfig,
    projectId,
    chatId,
    abortSignal,
  } = params;

  let finalText = initialText;
  let usage = params.usage;

  // PM #51 — three locals track behavior for trace-memory capture:
  //   - reflectionRevisionsExecuted: number of times reviseWithCritique
  //     ran (== "rounds where something needed fixing"). Zero means the
  //     critic was clean from round 1 — strongest quality signal.
  //   - reflectionCriticCleanedUp: true when the loop exited because
  //     the critic said `shouldRevise=false` (not because of cap).
  //   - reflectionHitCap: derived after the loop. True means we ran
  //     out of rounds without the critic ever cleaning up.
  let reflectionRevisionsExecuted = 0;
  let reflectionCriticCleanedUp = false;
  let reflectionHitCap = false;
  // DDD Phase 1 (corrected) — two extra exit flags so the single
  // `ddd_reflection_outcome` log event can classify the run.
  let reflectionCannotFix = false;
  let reflectionConverged = false;
  if (reflectionEnabled) {
    const ABSOLUTE_MAX_REFLECTION_ROUNDS = 3;
    // A8 — read defensively: `settings.reflection` may be undefined when
    // reflection is on via the Deep Audit toggle alone.
    const requestedMaxRounds = Math.max(
      1,
      Math.floor(settings.reflection?.maxRounds ?? 1)
    );
    const effectiveMaxRounds = Math.min(
      requestedMaxRounds,
      ABSOLUTE_MAX_REFLECTION_ROUNDS
    );
    // DDD audit fix #9 — warn when operator's setting is capped.
    if (requestedMaxRounds > ABSOLUTE_MAX_REFLECTION_ROUNDS) {
      console.warn(
        `[MoA] Reflection maxRounds ${requestedMaxRounds} exceeds cap (${ABSOLUTE_MAX_REFLECTION_ROUNDS}), using ${effectiveMaxRounds}.`
      );
    }
    const convergenceThreshold = Math.min(
      1,
      Math.max(0, settings.reflection?.convergenceThreshold ?? 0.97)
    );

    try {
      let previousText: string | null = null;
      let round = 0;
      while (round < effectiveMaxRounds) {
        round += 1;
        // DDD surface 2 — critic = Skeptic: operator's model wins, else brain
        // (the revisor below stays on brain — it writes, only the judge audits).
        const reflection = await reflectOnResponse({
          userMessage,
          agentResponse: finalText,
          settings,
          modelOverride: skepticConfig ?? brainConfig,
          projectId,
          chatId,
          abortSignal,
        });
        if (reflection.usage && reflection.modelConfig) {
          usage = addUsageToCumulative(
            usage,
            reflection.modelConfig.provider,
            reflection.modelConfig.model,
            reflection.usage
          );
        }

        // Stopping condition 1: critic says we're done.
        if (!reflection.shouldRevise || !reflection.critique) {
          console.log(
            `[MoA] Reflection round ${round}/${effectiveMaxRounds}: critic clean, stopping.`
          );
          reflectionCriticCleanedUp = true;
          break;
        }

        console.log(
          `[MoA] Reflection round ${round}/${effectiveMaxRounds}: revising. Critique: ${reflection.critique.slice(0, 120)}`
        );

        const revision = await reviseWithCritique({
          userMessage,
          originalResponse: finalText,
          critique: reflection.critique,
          suggestion: reflection.suggestion,
          settings,
          modelOverride: brainConfig,
          projectId,
          chatId,
          abortSignal,
        });
        if (revision.usage && revision.modelConfig) {
          usage = addUsageToCumulative(
            usage,
            revision.modelConfig.provider,
            revision.modelConfig.model,
            revision.usage
          );
        }

        if (revision.status === "cannot_fix") {
          console.log(`[MoA] Reflection round ${round}/${effectiveMaxRounds}: Coder cannot fix issues (${revision.explanation}). Breaking loop.`);
          reflectionCannotFix = true;
          break;
        }

        previousText = finalText;
        finalText = revision.text;
        reflectionRevisionsExecuted += 1;

        // Stopping condition 2: convergence (successive revisions are
        // nearly identical). Skip the convergence check entirely when
        // maxRounds === 1 (no chance for oscillation; saves an embed).
        if (effectiveMaxRounds > 1 && previousText) {
          try {
            const [embA, embB] = await embedTexts(
              [
                previousText.slice(0, 4000),
                finalText.slice(0, 4000),
              ],
              {
                provider: settings.embeddingsModel.provider,
                model: settings.embeddingsModel.model,
                apiKey: settings.embeddingsModel.apiKey,
                baseUrl: settings.embeddingsModel.baseUrl,
                dimensions: settings.embeddingsModel.dimensions,
              },
              { abortSignal }
            );
            const similarity = cosineSimilarity(embA, embB);
            if (similarity >= convergenceThreshold) {
              console.log(
                `[MoA] Reflection round ${round}/${effectiveMaxRounds}: converged (cosine ${similarity.toFixed(3)} >= ${convergenceThreshold}), stopping.`
              );
              reflectionConverged = true;
              break;
            }
            console.log(
              `[MoA] Reflection round ${round}/${effectiveMaxRounds}: revision applied (cosine ${similarity.toFixed(3)} < ${convergenceThreshold}, continuing).`
            );
          } catch (embedErr) {
            // Embedding failure is non-fatal — drop the convergence
            // check for this round, keep looping on the critic signal.
            console.warn(
              "[MoA] Convergence check embedding failed (non-fatal):",
              embedErr instanceof Error ? embedErr.message : String(embedErr)
            );
          }
        }
      }
      if (round >= effectiveMaxRounds && effectiveMaxRounds > 1) {
        console.log(
          `[MoA] Reflection hit maxRounds cap (${effectiveMaxRounds}). Shipping current text.`
        );
        // PM #51 — hit the cap WITHOUT the critic ever cleaning up means
        // the model couldn't converge. Recorded for trace quality score.
        if (!reflectionCriticCleanedUp) reflectionHitCap = true;
      }

      // DDD Phase 1 (corrected) — ONE structured event per reflection run,
      // through the EXISTING logger (data/logs/*.jsonl), instead of the
      // originally-planned OpenTelemetry tracer module (rejected: no-APM
      // local-first; duplicates trace-memory + cost accumulator + SSE).
      // The roadmap's aggregate metrics are offline queries over this event:
      //   critic_rejection_rate  = share of events with revisionsExecuted > 0
      //   average_reflection_rounds = mean(rounds)
      log.info("ddd_reflection_outcome", {
        chatId,
        rounds: round,
        revisionsExecuted: reflectionRevisionsExecuted,
        outcome: deriveReflectionOutcome({
          criticCleanedUp: reflectionCriticCleanedUp,
          cannotFix: reflectionCannotFix,
          converged: reflectionConverged,
          hitCap: reflectionHitCap,
        }),
      });
    } catch (reflectionErr) {
      // Reflection is a quality-improvement pass, never a blocker — log
      // and continue with the un-revised aggregator output.
      console.warn(
        "[MoA] Reflection loop failed (non-fatal, keeping original):",
        reflectionErr
      );
    }
  }

  return { finalText, usage, reflectionRevisionsExecuted, reflectionHitCap };
}
