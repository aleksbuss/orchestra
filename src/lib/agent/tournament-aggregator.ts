/**
 * PM #52 — Tournament aggregator (Borda count).
 *
 * The synthesis aggregator (PM #40, togethercomputer/MoA shape) merges
 * N drafts into a new answer. This is the right shape for open-ended
 * writing where each proposer brings a unique angle. It is the WRONG
 * shape for code / math / factual prompts where one proposer got the
 * right answer and the others were wrong — synthesis smooths the
 * correct draft into a worse Frankenstein.
 *
 * Tournament mode skips synthesis. K judges (LLM calls) each rank the
 * drafts. Borda count picks the winner. The winning draft (verbatim)
 * is the final answer.
 *
 * Borda count refresher. For each judge's ranking of N candidates,
 * the i-th-ranked candidate gets `N - i` points (1st = N-1, last = 0).
 * Sum points across judges. Highest sum wins. Ties broken by lower
 * sum-of-rank-positions (closer-to-top ranks beat lower ones).
 *
 * Why K judges instead of 1. A single judge has its own biases (model
 * preferences, prompt drift). K=3 with the same model gives variance
 * smoothing; K=3 with different models gives even more (cf.
 * AlpacaEval's multi-judge protocol). K=1 with Borda count degenerates
 * to "judge picks the best draft" — still useful, just no consensus
 * signal. Operators set K via `settings.aggregator.tournamentJudgeCount`.
 *
 * Cost shape. Each judge gets the prompt + every draft, but emits only
 * a short JSON ranking (the draft IDs in rank order). So one judge ≈
 * one synthesis-aggregator's INPUT but ≈ 1% of its OUTPUT. K=3 ≈
 * 3× input tokens, ~3% output tokens — typically cheaper than
 * synthesis when drafts are long.
 *
 * Privacy posture. Same as synthesis aggregator: the judge model is a
 * regular LLM call, which under Privacy Mode is forced local via
 * `assertPrivacyModeAllowsSettings`. No new network surface.
 */

import { generateObject } from "ai";
import { z } from "zod";
import { addUsageToCumulative } from "@/lib/cost/accumulator";
import { createModel } from "@/lib/providers/llm-provider";
import type { ChatUsage } from "@/lib/types";
import type { ModelConfig } from "@/lib/types";

export interface TournamentDraft {
  proposerId: string;
  role: string;
  text: string;
}

export interface TournamentJudgeRanking {
  /** Draft proposerIds in order from best (index 0) to worst (last index). */
  rankedProposerIds: string[];
  /** Optional one-line rationale from the judge. */
  rationale?: string;
}

export interface BordaResult {
  /** Per-draft Borda points, descending by points then ascending by sum-of-positions. */
  scores: Array<{
    proposerId: string;
    points: number;
    sumOfPositions: number;
  }>;
  /** The winner's proposerId (head of `scores`). Empty string when no valid rankings. */
  winnerProposerId: string;
}

/**
 * Pure Borda count over K judge rankings.
 *
 * Each judge contributes a permutation of the draft IDs. For a draft
 * placed at zero-indexed rank position `i` in a ranking of N drafts,
 * we award `N - 1 - i` points (1st = N-1, last = 0). Per-judge
 * positions are summed to break ties — the draft that appeared higher
 * on average wins a tie.
 *
 * Drafts the judge omitted are silently dropped from that judge's
 * contribution (no negative points). This handles judges that fail to
 * list every draft (mis-counted ID, dropped ID, etc.).
 */
export function bordaCount(
  rankings: TournamentJudgeRanking[],
  allDraftIds: string[]
): BordaResult {
  const validIds = new Set(allDraftIds);
  const points = new Map<string, number>();
  const sumOfPositions = new Map<string, number>();
  for (const id of allDraftIds) {
    points.set(id, 0);
    sumOfPositions.set(id, 0);
  }

  for (const ranking of rankings) {
    const seen = new Set<string>();
    const valid = ranking.rankedProposerIds.filter((id) => {
      if (!validIds.has(id)) return false;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    const N = valid.length;
    for (let i = 0; i < N; i++) {
      const id = valid[i];
      const pts = N - 1 - i;
      points.set(id, (points.get(id) ?? 0) + pts);
      // Position weight is the zero-indexed rank — lower = better.
      sumOfPositions.set(id, (sumOfPositions.get(id) ?? 0) + i);
    }
  }

  const scores = Array.from(points.entries())
    .map(([proposerId, pts]) => ({
      proposerId,
      points: pts,
      sumOfPositions: sumOfPositions.get(proposerId) ?? 0,
    }))
    .sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      return a.sumOfPositions - b.sumOfPositions;
    });

  return {
    scores,
    winnerProposerId: scores[0]?.proposerId ?? "",
  };
}

const JUDGE_SYSTEM_PROMPT = `You are a tournament judge in a Mixture-of-Agents pipeline. Multiple expert agents have produced candidate answers to a user request. Your job: rank them strictly by quality.

Quality criteria, in order of importance:
  1. Correctness — do the facts / code / math hold up?
  2. Directness — does it answer what was actually asked?
  3. Completeness — does it cover what the user needs to act?
  4. Clarity — is it well-structured and easy to understand?

DO NOT rewrite, synthesize, or merge the candidates. Only RANK them.
Return a strict JSON object matching the schema you were given.`;

function buildJudgePrompt(
  userMessage: string,
  drafts: TournamentDraft[]
): string {
  const draftBlocks = drafts
    .map(
      (d, idx) =>
        `<candidate id="${d.proposerId}" index="${idx + 1}" role="${escapeAttr(d.role)}">\n${d.text.slice(0, 6000)}\n</candidate>`
    )
    .join("\n\n");
  return `Original user request:
"""
${userMessage.slice(0, 3000)}
"""

Candidate answers from ${drafts.length} expert agents:

${draftBlocks}

Rank ALL ${drafts.length} candidates from best to worst. List each candidate's id exactly once.`;
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, "&quot;");
}

export interface RunTournamentInput {
  drafts: TournamentDraft[];
  userMessage: string;
  judgeConfig: ModelConfig;
  judgeCount: number;
  abortSignal?: AbortSignal;
}

export interface RunTournamentResult {
  winnerProposerId: string;
  winningText: string;
  borda: BordaResult;
  judgeRankings: TournamentJudgeRanking[];
  /** Cumulative LLM usage across all judges. */
  cumulativeUsage: ChatUsage | undefined;
  /** Number of judges that successfully produced a valid ranking. */
  successfulJudgeCount: number;
  /** Wall-clock latency for the tournament step. */
  latencyMs: number;
}

/**
 * Run the K judges in parallel, parse rankings, apply Borda count.
 *
 * Failure modes (any of these silently degrade — we never throw to the
 * MoA caller; the worst case is "pick the longest draft" fallback):
 *   - All judges fail → winner = longest successful draft.
 *   - Some judges fail → Borda runs over the successful subset.
 *   - Judge returns invalid IDs → those entries are dropped from the
 *     judge's contribution (see bordaCount filter).
 *
 * The caller (`runMoAEnsemble`) is responsible for the fallback. This
 * module returns whatever it could compute; an empty `winnerProposerId`
 * signals "give up, fall back".
 */
export async function runTournamentAggregation(
  input: RunTournamentInput
): Promise<RunTournamentResult> {
  const start = Date.now();
  const { drafts, userMessage, judgeConfig, judgeCount, abortSignal } = input;
  const k = Math.max(1, Math.floor(judgeCount));

  const draftIds = drafts.map((d) => d.proposerId);
  const prompt = buildJudgePrompt(userMessage, drafts);
  const judgeModel = createModel(judgeConfig, {});

  // Same `AbortSignal.any()` graceful fallback pattern used by proposer
  // dispatch — cap each judge at 60s.
  const JUDGE_TIMEOUT_MS = 60_000;
  let judgeSignal: AbortSignal;
  if (typeof AbortSignal.any === "function" && abortSignal) {
    judgeSignal = AbortSignal.any([abortSignal, AbortSignal.timeout(JUDGE_TIMEOUT_MS)]);
  } else {
    judgeSignal = AbortSignal.timeout(JUDGE_TIMEOUT_MS);
  }

  const judgePromises = Array.from({ length: k }, (_, idx) =>
    runSingleJudge({
      idx,
      prompt,
      judgeModel,
      judgeConfig,
      draftIds,
      abortSignal: judgeSignal,
    })
  );
  const results = await Promise.all(judgePromises);

  let cumulativeUsage: ChatUsage | undefined;
  const rankings: TournamentJudgeRanking[] = [];
  for (const r of results) {
    if (r.usage) {
      cumulativeUsage = addUsageToCumulative(
        cumulativeUsage,
        judgeConfig.provider,
        judgeConfig.model,
        r.usage
      );
    }
    if (r.ranking) rankings.push(r.ranking);
  }

  const borda = bordaCount(rankings, draftIds);
  // When zero judges succeeded, bordaCount degenerates to "first draft
  // by insertion order" (all scores are 0). That's not a real winner —
  // emit an explicit empty winnerProposerId so the caller knows to
  // fall back to synthesis instead of silently picking a random draft.
  const hasAnyValidRanking = rankings.length > 0;
  const winnerId = hasAnyValidRanking ? borda.winnerProposerId : "";
  const winningDraft = drafts.find((d) => d.proposerId === winnerId);
  return {
    winnerProposerId: winnerId,
    winningText: winningDraft?.text ?? "",
    borda,
    judgeRankings: rankings,
    cumulativeUsage,
    successfulJudgeCount: rankings.length,
    latencyMs: Date.now() - start,
  };
}

interface JudgeOutcome {
  ranking: TournamentJudgeRanking | null;
  usage:
    | {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
      }
    | undefined;
}

async function runSingleJudge(args: {
  idx: number;
  prompt: string;
  judgeModel: ReturnType<typeof createModel>;
  judgeConfig: ModelConfig;
  draftIds: string[];
  abortSignal: AbortSignal;
}): Promise<JudgeOutcome> {
  const { idx, prompt, judgeModel, draftIds, abortSignal } = args;
  try {
    const { object, usage } = await generateObject({
      model: judgeModel,
      schema: z.object({
        rankedProposerIds: z
          .array(z.string())
          .describe(
            "Draft proposerIds in order from best (first) to worst (last). Each id MUST appear exactly once and MUST be one of the provided candidate ids."
          ),
        rationale: z
          .string()
          .max(280)
          .optional()
          .describe("One-line reason for the top pick. Optional."),
      }),
      system: JUDGE_SYSTEM_PROMPT,
      prompt: prompt + `\n\nValid ids: ${JSON.stringify(draftIds)}`,
      abortSignal,
    });
    return {
      ranking: {
        rankedProposerIds: object.rankedProposerIds,
        rationale: object.rationale,
      },
      usage,
    };
  } catch (err) {
    console.warn(
      `[Tournament] Judge #${idx + 1} failed (non-fatal):`,
      err instanceof Error ? err.message : err
    );
    return { ranking: null, usage: undefined };
  }
}
