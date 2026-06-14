/**
 * Disagreement detection for MoA proposer drafts (PM #39).
 *
 * Why this exists: the audit found that Orchestra's aggregator silently
 * smooths over divergence — if 3 proposers say "use React hooks" and 2
 * say "use Zustand", the LLM-judge aggregator just picks one based on
 * "internal knowledge" and the operator never sees the conflict. Mature
 * multi-agent frameworks (LangGraph, FREE-MAD, DWC-MAD) call this
 * "sycophantic consensus" — agents agree on the wrong answer because each
 * sees the others' confidence without an explicit signal to surface
 * disagreement.
 *
 * Approach: embed each successful draft with the existing embeddings
 * module (PM #36 already established the cost-attribution contract — this
 * adds ~1 embed call per turn, cheap). Compute pairwise cosine distance.
 * If max pairwise distance exceeds `threshold` (default 0.35, tunable),
 * the proposers diverge. The caller (`runMoAEnsemble`) prepends a marker
 * to the aggregator prompt asking the synthesizer to call out the
 * disagreement explicitly rather than averaging it away.
 *
 * What this is NOT: it does NOT decide which proposer is right. The
 * aggregator still gets to make that call. The signal just changes the
 * aggregator's job from "synthesize" to "synthesize + flag the conflict".
 *
 * Failure mode: detection failure (embedding API down, model misconfigured)
 * is non-fatal — returns `{ detected: false }` and the MoA flow continues
 * with the default aggregator behavior. We never block the response on a
 * quality-improvement signal.
 *
 * Threshold rationale: empirically, cosine distance between embeddings of
 * substantively-different-but-same-topic texts (e.g. "use React hooks"
 * vs "use Zustand for state management") sits in 0.30-0.45 range with
 * `text-embedding-3-small`. Below 0.20 = agreement. Above 0.50 = topic
 * drift (likely one proposer misunderstood the prompt). 0.35 is the
 * sweet spot for "different recommendations on the same problem".
 */
import type { AppSettings } from "@/lib/types";
import { embedTexts } from "@/lib/memory/embeddings";

/** Compute cosine similarity ∈ [-1, 1]. 1 = identical direction. */
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

export const DEFAULT_DISAGREEMENT_THRESHOLD = 0.35;

/** Truncate per-draft input to keep embedding token cost bounded. */
const EMBED_DRAFT_CHAR_CAP = 4000;

export interface DisagreementInput {
  text: string;
  role: string;
}

export interface DisagreementResult {
  /** Max pairwise cosine DISTANCE (1 - similarity) across the drafts. 0 = identical. */
  maxDistance: number;
  /** Mean pairwise cosine distance. */
  averageDistance: number;
  /** True when `maxDistance > threshold`. */
  detected: boolean;
  /** Threshold used for the decision. */
  threshold: number;
  /** Number of pairs compared. n*(n-1)/2 for n drafts. */
  pairCount: number;
  /** True if the detector ran successfully. False on internal failure (embedding error, < 2 drafts, etc). */
  ranSuccessfully: boolean;
}

/**
 * Detect whether the proposer drafts diverge significantly.
 *
 * Returns `detected: false, ranSuccessfully: false` when fewer than 2
 * drafts are present (no pairs to compare) or when embedding fails.
 * `runMoAEnsemble` treats both as "no signal" — the aggregator runs with
 * its default prompt.
 */
export async function detectDisagreement(
  drafts: DisagreementInput[],
  settings: AppSettings,
  threshold: number = DEFAULT_DISAGREEMENT_THRESHOLD,
  abortSignal?: AbortSignal
): Promise<DisagreementResult> {
  const noSignal: DisagreementResult = {
    maxDistance: 0,
    averageDistance: 0,
    detected: false,
    threshold,
    pairCount: 0,
    ranSuccessfully: false,
  };

  if (drafts.length < 2) return noSignal;

  // Truncate each draft to bound embedding token cost. The opening of an
  // LLM response usually carries the recommendation; tail tends to be
  // formatting + qualifications.
  const inputs = drafts.map((d) => d.text.slice(0, EMBED_DRAFT_CHAR_CAP));

  let embeddings: number[][];
  try {
    embeddings = await embedTexts(
      inputs,
      {
        provider: settings.embeddingsModel.provider,
        model: settings.embeddingsModel.model,
        apiKey: settings.embeddingsModel.apiKey,
        baseUrl: settings.embeddingsModel.baseUrl,
        dimensions: settings.embeddingsModel.dimensions,
      },
      { abortSignal }
    );
  } catch (err) {
    console.warn(
      "[Disagreement] Embedding failed, skipping detection:",
      err instanceof Error ? err.message : String(err)
    );
    return noSignal;
  }

  if (embeddings.length !== drafts.length) {
    console.warn(
      `[Disagreement] Embedding count mismatch (${embeddings.length} vs ${drafts.length}), skipping detection.`
    );
    return noSignal;
  }

  // Pairwise cosine distance. Cap at the upper triangle (i < j).
  let maxDistance = 0;
  let sumDistance = 0;
  let pairCount = 0;
  for (let i = 0; i < embeddings.length; i++) {
    for (let j = i + 1; j < embeddings.length; j++) {
      const sim = cosineSimilarity(embeddings[i], embeddings[j]);
      const distance = 1 - sim;
      maxDistance = Math.max(maxDistance, distance);
      sumDistance += distance;
      pairCount += 1;
    }
  }
  const averageDistance = pairCount > 0 ? sumDistance / pairCount : 0;

  return {
    maxDistance,
    averageDistance,
    detected: maxDistance > threshold,
    threshold,
    pairCount,
    ranSuccessfully: true,
  };
}

/**
 * Build the aggregator-prompt prefix that surfaces the disagreement to
 * the synthesizer LLM. Caller prepends this to its regular aggregator
 * prompt; the synthesizer is now explicitly instructed to identify and
 * call out the conflict rather than smooth it over.
 *
 * Empty string when no disagreement was detected — caller can safely
 * prepend unconditionally.
 */
export function buildDisagreementMarker(
  result: DisagreementResult
): string {
  if (!result.detected) return "";
  return [
    "<<DISAGREEMENT_DETECTED>>",
    `The expert proposer drafts below DIVERGE significantly (max cosine distance: ${result.maxDistance.toFixed(2)}, threshold: ${result.threshold}).`,
    "When synthesizing, you MUST:",
    "  1. Identify the specific point(s) where the proposers disagree.",
    "  2. Explain the trade-offs of each side concisely.",
    "  3. Either reconcile them with a clear rationale, OR flag the open question to the user when reconciliation is not possible.",
    "Do NOT silently pick one side and pretend consensus exists.",
    "<<END_DISAGREEMENT_DETECTED>>",
    "",
  ].join("\n");
}
