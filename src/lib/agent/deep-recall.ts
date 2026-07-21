/**
 * Deep-memory recall injection bounding (PM #94-follow-up).
 *
 * WHY: `runAgent` injects a passive `<deep_memory_recall>` block into the SYSTEM
 * prompt — the top-N RAG hits over the chat's memory pool (PM #85). The count is
 * capped (`deepRecallLimit = 3`), but each hit's `.text` is UNBOUNDED. The
 * compaction path auto-archives a chat's evicted history VERBATIM (PM #85,
 * `formatVerbatimArchive`), and those archive chunks run tens of thousands of
 * tokens each. As a chat ages, recall pulls 3 huge verbatim archives back into
 * EVERY turn's system prompt.
 *
 * MEASURED LIVE (chat d2618698, [CtxDiag]): the recall block was 82711 tokens of
 * a 114053-token system prompt — 72% — pushing total input to ~135K, over the
 * model's reliable window, which mode-collapsed the brain into a narrate-stop /
 * truncated-write (the file the user asked for was never written). The in-flight
 * token governor can't help: the bloat is in the SYSTEM prompt, which it never
 * prunes.
 *
 * FIX: the passive injection is a CONTINUITY aid, not a full transcript. Bound it
 * — per-chunk (head+tail, so exact artifacts at both ends survive) AND total — so
 * it stays a few thousand tokens. The full verbatim archive remains reachable via
 * an explicit `searchMemory`/`memory_load` tool call when the model actually needs
 * it. This is model-preserving: it keeps a weak local model inside its working
 * window instead of forcing a bigger/cloud model.
 */

/** Per-chunk char cap for the passive recall injection (~1150 tokens at 3.5 c/tok). */
export const DEEP_RECALL_PER_CHUNK_CHARS = 4000;

/** Total char cap for the whole recall block (~4600 tokens). */
export const DEEP_RECALL_TOTAL_CHARS = 16000;

/**
 * PM #95 cross-model refinement — a FIXED char budget is safe but under-uses a
 * big window: on a Claude 200K / Gemini 1M model the passive recall could carry
 * far more relevant history inline instead of forcing an explicit tool call. The
 * budget is therefore WINDOW-RELATIVE — a small fraction of the model's EFFECTIVE
 * (reliable-capped) window — so it scales with the model's real capacity.
 *
 * `RECALL_WINDOW_FRACTION` (8%) keeps recall a minority of the window (the bug was
 * 72%); `[MIN,MAX]` bound it so a tiny window never overflows and a 1M window
 * never injects absurd amounts. At the operator's ~120K reliable window the total
 * lands ~33.6K chars — above the old fixed 16K, but the cap rarely BINDS (typical
 * recall is a few thousand chars), so no behavioural change on normal traffic;
 * it only allows more headroom when there is genuinely more relevant history.
 */
export const RECALL_WINDOW_FRACTION = 0.08;
const RECALL_CHARS_PER_TOKEN = 3.5;
export const DEEP_RECALL_MIN_TOTAL_CHARS = 4000;
export const DEEP_RECALL_MAX_TOTAL_CHARS = 200000;

/**
 * Resolve the per-chunk + total char budget for the recall injection from the
 * model's EFFECTIVE (reliable-capped) context window in TOKENS. Pure; the caller
 * passes the already-clamped window (`effectiveContextWindow(...)`).
 */
export function resolveRecallBudgetChars(effectiveWindowTokens: number): {
  perChunkChars: number;
  totalChars: number;
} {
  const raw = Math.round(
    Math.max(0, effectiveWindowTokens) * RECALL_WINDOW_FRACTION * RECALL_CHARS_PER_TOKEN
  );
  const totalChars = Math.min(
    DEEP_RECALL_MAX_TOTAL_CHARS,
    Math.max(DEEP_RECALL_MIN_TOTAL_CHARS, raw)
  );
  // A single chunk may take up to ~35% of the total so one big archive can't
  // swallow the whole budget, but chunks still grow with the window.
  const perChunkChars = Math.max(2000, Math.round(totalChars * 0.35));
  return { perChunkChars, totalChars };
}

/**
 * Keep the head and tail of an over-long chunk (an LLM/archive chunk carries
 * exact artifacts — stack traces, file contents — at both ends; a pure head-slice
 * drops the tail). 60% head / 40% tail, with an elision marker.
 */
export function capChunkHeadTail(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const headLen = Math.floor(cap * 0.6);
  const tailLen = Math.max(0, cap - headLen);
  const dropped = text.length - cap;
  return (
    text.slice(0, headLen) +
    `\n…[${dropped} chars elided — head+tail kept; full text via explicit memory search]…\n` +
    (tailLen > 0 ? text.slice(text.length - tailLen) : "")
  );
}

export interface RecallHit {
  score: number;
  text: string;
  /** Loose to match the memory-search result shape (`metadata: Record<string, unknown>`). */
  metadata: Record<string, unknown>;
}

/**
 * Build the bounded body of the `<deep_memory_recall>` injection. Formats each hit
 * as `[Relevance Score: x] (Area: y)\n<capped text>`, per-chunk-capped and
 * stopping once the total budget is spent (highest-relevance hits come first, so
 * the cap drops the least-relevant tail — the caller passes results already
 * ordered by score). Returns "" for no hits so the caller can guard.
 */
export function buildBoundedRecallBlock(
  results: RecallHit[],
  perChunkChars: number = DEEP_RECALL_PER_CHUNK_CHARS,
  totalChars: number = DEEP_RECALL_TOTAL_CHARS
): string {
  if (!results || results.length === 0) return "";
  const parts: string[] = [];
  let used = 0;
  for (const r of results) {
    if (used >= totalChars) break;
    const remaining = totalChars - used;
    const chunkCap = Math.min(perChunkChars, remaining);
    const capped = capChunkHeadTail(r.text ?? "", chunkCap);
    const area = typeof r.metadata?.area === "string" ? r.metadata.area : "unknown";
    const block = `[Relevance Score: ${r.score.toFixed(2)}] (Area: ${area})\n${capped}`;
    parts.push(block);
    used += block.length;
  }
  return parts.join("\n\n");
}
