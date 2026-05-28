/**
 * PM #51 — Persistent successful-trace memory.
 *
 * The shape. After each MoA run, we have a bundle of behavioral signals
 * that correlate with "the swarm naturally converged on a good answer":
 *   - high proposer success ratio (5/5 finished without erroring),
 *   - PM #39 disagreement detector said "consensus" (drafts agreed),
 *   - PM #38/#46 critic returned `shouldRevise=false` on round 1 (or
 *     never needed to run if reflection wasn't enabled),
 *   - the reflection loop didn't hit its hard cap.
 *
 * Combine those into a deterministic quality score, gate capture on a
 * threshold, persist the (prompt, output, signals) triple under
 * `data/traces/<id>.json` keyed by a hash of the user prompt. At
 * inference time on a new prompt, embed it, scan stored traces, and
 * return the top-K most-similar passing traces. Inject them as
 * few-shots into the Router system prompt so persona generation gets
 * biased toward proven patterns.
 *
 * This is DSPy's bootstrap-fewshot idea adapted for Orchestra's MoA
 * runtime: instead of needing an external eval harness to label
 * "successful" runs, we lean on the *internal* signals the swarm
 * already produces and treat strong consensus + clean critic as proxy
 * for correctness.
 *
 * Privacy posture. Traces stay on disk; nothing is ever sent to the
 * network from this module directly. Retrieval embeds the user
 * prompt — under Privacy Mode the embeddings model is forced local
 * (PM #47), so no text leaves the machine. Capture + retrieval are
 * therefore both Privacy-Mode-safe by construction.
 *
 * Single-process invariant. We use `safeWriteFile` (atomic write) for
 * each trace file. There's no cross-trace locking — concurrent writes
 * are independent files. The in-memory cache is a single-process
 * Map; cluster mode would require external coordination (same caveat
 * as chat-store / cron service, see CLAUDE.md § Data Persistence).
 */

import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import { safeWriteFile } from "@/lib/storage/fs-utils";
import { embedTexts } from "@/lib/memory/embeddings";
import type { AppSettings, ModelConfig } from "@/lib/types";

export interface TraceSignals {
  /** Fraction of proposers that returned a non-error draft. 0-1. */
  proposerSuccessRatio: number;
  /** PM #39 disagreement detector result. `false` = consensus = good signal. */
  disagreementDetected: boolean;
  /** Max pairwise cosine distance across proposer drafts. 0-2 (typically 0-1). */
  disagreementMaxDistance: number;
  /**
   * PM #38/#46 reflection rounds executed. 0 = critic clean / reflection
   * not enabled (both score the same: nothing needed to be revised).
   * Higher = more revision rounds, weaker signal.
   */
  reflectionRounds: number;
  /** True when the reflection loop exited because it hit `maxRounds`. Bad signal. */
  reflectionHitCap: boolean;
  /** Total wall-clock for the MoA run in milliseconds. */
  totalLatencyMs: number;
}

export interface SuccessfulTrace {
  id: string;
  userPrompt: string;
  finalText: string;
  signals: TraceSignals;
  qualityScore: number;
  /** Brain (aggregator) model that produced finalText. */
  modelConfig: { provider: string; model: string };
  capturedAt: string;
  embedding: number[];
}

/**
 * Deterministic quality score from observed MoA signals. Pure function
 * so unit tests pin the weighting and the boundary behavior. Returns a
 * value in [0, 1].
 *
 * Weighting choices:
 *   - 0.4 proposer success ratio (the foundation — if proposers errored,
 *     the answer is built on partial drafts and trust is shaky).
 *   - 0.3 consensus (PM #39 "disagreement detected" inverts to 0; else 1).
 *   - 0.2 critic clean (0 rounds = full weight; 1 round = half;
 *     2+ rounds = zero — too much revision means the first answer was
 *     not actually good).
 *   - 0.1 not-hit-reflection-cap (hitting the loop cap is a clear
 *     "couldn't converge" signal — worst case).
 *
 * The weights sum to 1.0 so the output is a clean fraction. The
 * threshold for storage (default 0.7) translates to "at least three of
 * four soft criteria fully satisfied".
 */
export function computeQualityScore(s: TraceSignals): number {
  const successPart = 0.4 * clamp01(s.proposerSuccessRatio);
  const consensusPart = 0.3 * (s.disagreementDetected ? 0 : 1);
  let critic: number;
  if (s.reflectionRounds <= 0) critic = 1;
  else if (s.reflectionRounds === 1) critic = 0.5;
  else critic = 0;
  const criticPart = 0.2 * critic;
  const capPart = 0.1 * (s.reflectionHitCap ? 0 : 1);
  return successPart + consensusPart + criticPart + capPart;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** Stable ID per user prompt. Hash-of-normalized-prompt → same prompt deduplicates. */
export function computeTraceId(userPrompt: string): string {
  const normalized = userPrompt.trim().toLowerCase();
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

function dataDir(): string {
  return process.env.ORCHESTRA_DATA_DIR || path.join(process.cwd(), "data");
}

function tracesDir(): string {
  return path.join(dataDir(), "traces");
}

function tracePath(id: string): string {
  return path.join(tracesDir(), `${id}.json`);
}

let inMemoryTraces: Map<string, SuccessfulTrace> | null = null;

async function loadAllTraces(): Promise<Map<string, SuccessfulTrace>> {
  if (inMemoryTraces) return inMemoryTraces;
  const cache = new Map<string, SuccessfulTrace>();
  let dirEntries: string[];
  try {
    dirEntries = await fs.readdir(tracesDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      inMemoryTraces = cache;
      return cache;
    }
    throw err;
  }
  for (const entry of dirEntries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(tracesDir(), entry), "utf-8");
      const parsed = JSON.parse(raw) as SuccessfulTrace;
      if (
        typeof parsed?.id !== "string" ||
        typeof parsed?.userPrompt !== "string" ||
        typeof parsed?.finalText !== "string" ||
        typeof parsed?.qualityScore !== "number" ||
        !Array.isArray(parsed?.embedding)
      ) {
        continue;
      }
      cache.set(parsed.id, parsed);
    } catch {
      // Skip corrupt individual files — don't poison the whole cache.
      continue;
    }
  }
  inMemoryTraces = cache;
  return cache;
}

export interface CaptureTraceInput {
  userPrompt: string;
  finalText: string;
  signals: TraceSignals;
  brainConfig: ModelConfig;
  settings: AppSettings;
}

export interface CaptureTraceResult {
  captured: boolean;
  reason?: string;
  qualityScore: number;
  traceId?: string;
}

/**
 * Capture a successful MoA run as a trace, gated by quality score.
 * Skipped silently when:
 *   - traceMemory feature flag is off,
 *   - score < threshold,
 *   - embedding fails (logged but doesn't throw — the run already
 *     succeeded for the user, capturing is best-effort).
 *
 * Returns metadata about what happened so callers can log it.
 */
export async function captureSuccessfulTrace(
  input: CaptureTraceInput
): Promise<CaptureTraceResult> {
  const { settings, userPrompt, finalText, signals, brainConfig } = input;
  if (!settings.traceMemory?.enabled) {
    return { captured: false, reason: "trace-memory disabled", qualityScore: 0 };
  }
  const score = computeQualityScore(signals);
  const threshold = clamp01(settings.traceMemory.qualityThreshold ?? 0.7);
  if (score < threshold) {
    return {
      captured: false,
      reason: `score ${score.toFixed(3)} < threshold ${threshold.toFixed(3)}`,
      qualityScore: score,
    };
  }

  // PM #54 — score-regression guard. Trace id is a hash of the
  // normalized prompt, so the same prompt rerun overwrites the previous
  // trace. If the previous trace had a HIGHER score, the rerun is a
  // strict degradation of the pool. Skip the write in that case so a
  // good capture is not silently replaced by a worse one. (We DO write
  // when scores are equal — that handles the no-op rerun and keeps
  // `capturedAt` fresh on the most recent observation.)
  const id = computeTraceId(userPrompt);
  try {
    const cache = await loadAllTraces();
    const existing = cache.get(id);
    if (existing && existing.qualityScore > score) {
      return {
        captured: false,
        reason: `score ${score.toFixed(3)} < existing ${existing.qualityScore.toFixed(3)} (no regression overwrite)`,
        qualityScore: score,
        traceId: id,
      };
    }
  } catch {
    // Cache load failed → proceed with capture; worst case we overwrite,
    // which is no worse than the pre-PM-54 behavior.
  }

  // Embed the user prompt for future retrieval. If embedding fails,
  // skip capture — a trace without an embedding is unusable for retrieval.
  let embedding: number[];
  try {
    const [vec] = await embedTexts([userPrompt.slice(0, 8000)], {
      provider: settings.embeddingsModel.provider,
      model: settings.embeddingsModel.model,
      apiKey: settings.embeddingsModel.apiKey,
      baseUrl: settings.embeddingsModel.baseUrl,
      dimensions: settings.embeddingsModel.dimensions,
    });
    if (!Array.isArray(vec) || vec.length === 0) {
      return {
        captured: false,
        reason: "embedding returned empty vector",
        qualityScore: score,
      };
    }
    embedding = vec;
  } catch (err) {
    return {
      captured: false,
      reason: `embedding failed: ${err instanceof Error ? err.message : String(err)}`,
      qualityScore: score,
    };
  }

  const trace: SuccessfulTrace = {
    id,
    userPrompt,
    finalText,
    signals,
    qualityScore: score,
    modelConfig: { provider: brainConfig.provider, model: brainConfig.model },
    capturedAt: new Date().toISOString(),
    embedding,
  };

  try {
    await fs.mkdir(tracesDir(), { recursive: true });
    await safeWriteFile(tracePath(id), JSON.stringify(trace, null, 2));
  } catch (err) {
    return {
      captured: false,
      reason: `disk write failed: ${err instanceof Error ? err.message : String(err)}`,
      qualityScore: score,
    };
  }

  // Update the in-memory cache so this trace is retrievable immediately.
  if (inMemoryTraces) inMemoryTraces.set(id, trace);
  return { captured: true, qualityScore: score, traceId: id };
}

export interface RetrievedTrace {
  trace: SuccessfulTrace;
  similarity: number;
}

/**
 * Return up to `k` past traces most similar to `userPrompt` by cosine
 * similarity over the stored embeddings. Filtered to traces at or
 * above the configured `qualityThreshold` (so a sub-threshold trace
 * that somehow ended up on disk isn't surfaced).
 *
 * On any failure (embedding error, disk missing, no traces yet)
 * returns []. Retrieval is best-effort: an empty result means
 * "Router runs without few-shots", which is the pre-PM-51 behavior —
 * exact backward compat.
 */
export async function retrieveRelevantTraces(
  userPrompt: string,
  settings: AppSettings,
  options: { k?: number } = {}
): Promise<RetrievedTrace[]> {
  if (!settings.traceMemory?.enabled) return [];
  const k = Math.max(0, Math.floor(options.k ?? settings.traceMemory.retrievalK ?? 3));
  if (k === 0) return [];
  const threshold = clamp01(settings.traceMemory.qualityThreshold ?? 0.7);

  let cache: Map<string, SuccessfulTrace>;
  try {
    cache = await loadAllTraces();
  } catch {
    return [];
  }
  if (cache.size === 0) return [];

  let queryEmbedding: number[];
  try {
    const [vec] = await embedTexts([userPrompt.slice(0, 8000)], {
      provider: settings.embeddingsModel.provider,
      model: settings.embeddingsModel.model,
      apiKey: settings.embeddingsModel.apiKey,
      baseUrl: settings.embeddingsModel.baseUrl,
      dimensions: settings.embeddingsModel.dimensions,
    });
    if (!Array.isArray(vec) || vec.length === 0) return [];
    queryEmbedding = vec;
  } catch {
    return [];
  }

  const scored: RetrievedTrace[] = [];
  for (const trace of cache.values()) {
    if (trace.qualityScore < threshold) continue;
    if (trace.embedding.length !== queryEmbedding.length) continue;
    const sim = cosine(queryEmbedding, trace.embedding);
    scored.push({ trace, similarity: sim });
  }
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, k);
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Render retrieved traces into a Router-prompt-injectable block. Each
 * past trace becomes a `<past_successful_run>` element with the user
 * prompt and the final answer summary. Truncates aggressively — the
 * Router prompt budget is precious and the goal is biasing persona
 * generation, not feeding the LLM the whole answer verbatim.
 */
export function formatTracesAsFewShots(traces: RetrievedTrace[]): string {
  if (traces.length === 0) return "";
  const parts: string[] = [];
  parts.push("\n<past_successful_runs>");
  parts.push(
    "These are abbreviated examples of prior MoA runs on similar prompts that produced high-confidence answers (proposer consensus, clean critic). Use them as informal pattern hints when generating personas for the current request, NOT as content to copy."
  );
  for (let i = 0; i < traces.length; i++) {
    const { trace, similarity } = traces[i];
    parts.push(
      `\n<example index="${i + 1}" similarity="${similarity.toFixed(3)}" quality="${trace.qualityScore.toFixed(3)}">`
    );
    parts.push(`<prompt>${truncate(trace.userPrompt, 500)}</prompt>`);
    parts.push(`<answer_summary>${truncate(trace.finalText, 800)}</answer_summary>`);
    parts.push(`</example>`);
  }
  parts.push("</past_successful_runs>\n");
  return parts.join("\n");
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

/* Test-only seams — never used in production. */
export function __resetTraceMemoryForTests(): void {
  inMemoryTraces = null;
}

export function __seedTraceMemoryForTests(traces: SuccessfulTrace[]): void {
  inMemoryTraces = new Map(traces.map((t) => [t.id, t]));
}
