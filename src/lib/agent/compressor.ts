import { generateText, type ModelMessage } from "ai";
import { encode } from "gpt-tokenizer/encoding/cl100k_base";
import { createModel } from "@/lib/providers/llm-provider";
import type { AppSettings, ChatMessage } from "@/lib/types";

const COMPRESSOR_SYSTEM_PROMPT = `You are a Context Archivist Agent.
Your task is to analyze the following sequence of old chat messages and create a single, highly dense "Working Memory" summary.
You MUST preserve:
1. Any factual information provided by the user (API keys, constraints, URLs).
2. All technical decisions made during the conversation.
3. File paths and the state of the codebase discussed.
4. Any unresolved bugs or pending tasks.

Remove all conversational filler (e.g., "hello", "let me do that", "here is the result").
Format your output as a concise markdown list of facts and states.`;

/**
 * Sprint A4 — sliding-window + anchors partition for pre-flight compaction.
 *
 * Splits a chat history into three byte-for-byte slices:
 *  - `anchors`  — leading `system` messages (task framing / system context).
 *                 Pinned to the live context VERBATIM; never evicted.
 *  - `recent`   — the last `keepRecent` non-anchor messages. Kept VERBATIM.
 *  - `evicted`  — the middle tail. Archived to RAG (verbatim + summary), then
 *                 dropped from the live context.
 *
 * For a short history (`messages.length <= anchors + keepRecent`) `evicted` is
 * EMPTY — the caller skips archival entirely, which also kills the old
 * negative-slice footgun (a 2-message paste must not emit a bogus archive event
 * nor an empty RAG insert).
 */
export function partitionForCompaction(
  messages: ChatMessage[],
  keepRecent: number
): { anchors: ChatMessage[]; evicted: ChatMessage[]; recent: ChatMessage[] } {
  let anchorEnd = 0;
  while (anchorEnd < messages.length && messages[anchorEnd].role === "system") {
    anchorEnd++;
  }
  const anchors = messages.slice(0, anchorEnd);
  const rest = messages.slice(anchorEnd);

  const keep = Math.max(0, keepRecent);
  const recentStart = Math.max(0, rest.length - keep);
  const evicted = rest.slice(0, recentStart);
  const recent = rest.slice(recentStart);

  return { anchors, evicted, recent };
}

/**
 * Sprint A4 — render messages to a byte-for-byte archive string for RAG. Unlike
 * `compressChatHistory` (an LLM paraphrase), this preserves exact artifacts —
 * stack traces, file contents, API keys — so they stay retrievable verbatim
 * after compaction.
 */
export function formatVerbatimArchive(messages: ChatMessage[]): string {
  return messages
    .map((m) => `[${m.role.toUpperCase()}]: ${m.content}`)
    .join("\n\n");
}

/**
 * Audit fix #3 — the evicted compaction tail is always archived VERBATIM, but
 * the extra dense LLM summary (`compressChatHistory` = an `utilityModel`
 * round-trip + a 2nd embed) only earns its cost above this many tokens. Below
 * it the verbatim copy already IS the summary, so a frequently-compacting
 * small-window model (Ollama 4096) isn't taxed with an LLM call + a duplicate
 * RAG record on every compaction.
 */
export const SUMMARY_MIN_EVICTED_TOKENS = 2000;

/** Whether an eviction of `evictedTokens` warrants the extra dense LLM summary. */
export function shouldSummarizeEviction(evictedTokens: number): boolean {
  return evictedTokens >= SUMMARY_MIN_EVICTED_TOKENS;
}

export async function compressChatHistory(
  messages: ChatMessage[],
  settings: AppSettings,
  projectId?: string,
  abortSignal?: AbortSignal
): Promise<string> {
  if (messages.length === 0) return "";

  // Convert ChatMessage to a readable string format
  const formattedLogs = messages
    .filter((msg) => msg.role !== "system" || msg.content.includes("Working Memory")) // Skip internal system prompts except old memory
    .map((msg) => `[${msg.role.toUpperCase()}]: ${msg.content}`)
    .join("\n\n");

  const promptText = `Please compress this chat history into a dense summary:\n\n${formattedLogs}`;

  try {
    const modelConfig = { ...(settings.utilityModel ?? settings.chatModel) };
    if (!modelConfig.apiKey && settings.providerApiKeys?.[modelConfig.provider]) {
      modelConfig.apiKey = settings.providerApiKeys[modelConfig.provider];
    }
    const model = createModel(modelConfig, {
      projectId,
    });

    const result = await generateText({
      model,
      system: COMPRESSOR_SYSTEM_PROMPT,
      messages: [{ role: "user", content: promptText }],
      abortSignal,
    });
    return result.text.trim();
  } catch (err) {
    console.error("Compression failed:", err);
    return `[Context Compression Failed: ${err}]`;
  }
}

/**
 * Estimate the token count of a message array.
 *
 * Sprint "real tokenizer" (context-management track): replaces the old
 * `Math.ceil(chars / 3.5)` heuristic with a real BPE tokenizer
 * (`gpt-tokenizer`, OpenAI `cl100k_base` — pure JS, edge-safe, no native deps).
 *
 * Sprint A1 invariant (KEPT): `content` on a `ModelMessage` is NOT always a
 * string — tool-call / tool-result / multimodal turns carry an ARRAY of parts.
 * The old `(m.content as string)?.length` counted the ARRAY LENGTH (`1` for a
 * 50 KB tool-result), so a file-reading tool-loop estimated near-zero tokens and
 * never compacted — the root mid-loop-overflow bug. We still traverse every part
 * and tokenize its text/serialized payload.
 *
 * Two deliberate caveats:
 *  - `cl100k_base` is exact for OpenAI only; Llama/Gemini/Qwen tokenize denser,
 *    especially on non-Latin scripts and code. We multiply by `SAFETY_MARGIN`
 *    so the PRE-FLIGHT estimate never UNDER-counts (under-counting = late
 *    compaction = overflow; over-counting only compacts a little early).
 *  - For GROUND TRUTH, callers should prefer the provider-reported `usage`
 *    (already surfaced in `onStepFinish`); this estimate is for the pre-flight /
 *    in-flight-governor path where no usage is available yet.
 *
 * Per-message results are memoized in a `WeakMap` keyed on the message object,
 * because the in-flight governor (`token-governor.ts`) calls this repeatedly over
 * overlapping suffixes of the SAME message objects while sliding the window — a
 * naive re-encode each call would be O(n²) over the (potentially large) payload.
 */
const SAFETY_MARGIN = 1.15;

const messageTokenCache = new WeakMap<object, number>();

export function estimateTokenCount(messages: ModelMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += messageTokens(m);
  }
  return total;
}

function messageTokens(message: ModelMessage): number {
  if (message != null && typeof message === "object") {
    const cached = messageTokenCache.get(message);
    if (cached !== undefined) return cached;
  }
  const raw = contentTokenLength(message?.content);
  // Margin applied per message; empty content ⇒ 0 (ceil(0 * margin) = 0), which
  // preserves the "empty/null content ⇒ 0 tokens" contract.
  const withMargin = Math.ceil(raw * SAFETY_MARGIN);
  if (message != null && typeof message === "object") {
    messageTokenCache.set(message, withMargin);
  }
  return withMargin;
}

/**
 * Token count of a `ModelMessage["content"]`, robust to both the string form and
 * the array-of-parts form (text / tool-call / tool-result / file / image).
 */
function contentTokenLength(content: unknown): number {
  if (typeof content === "string") return countTokens(content);
  if (!Array.isArray(content)) return 0;

  let total = 0;
  for (const part of content) {
    if (part == null || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if (typeof p.text === "string") {
      // { type: "text", text }
      total += countTokens(p.text);
    } else if (p.type === "tool-call") {
      // { type: "tool-call", toolName, input }
      total += countTokens(asString(p.toolName)) + countTokens(serialize(p.input));
    } else if (p.type === "tool-result") {
      // { type: "tool-result", toolName, output: { type, value } }
      total += countTokens(asString(p.toolName)) + countTokens(serialize(p.output));
    } else {
      // Unknown/multimodal part (image/file/etc.) — tokenize its serialized form
      // so large inline payloads still register as context pressure.
      total += countTokens(serialize(part));
    }
  }
  return total;
}

/**
 * Above this many characters, skip exact BPE and use the char heuristic.
 *
 * BPE cost is O(length); a single 200 KB tool-result dump costs one full encode
 * per governor step (memoized per message, but still one encode). Two reasons the
 * exact count is pointless past this size: (1) the payload is already far over any
 * real context window, so it WILL be pruned/compacted/capped regardless of the
 * exact number; (2) `capToolResultSize` truncates string tool-results to 24 KB
 * before they reach the model anyway. The char heuristic OVER-counts vs BPE
 * (~chars/3.5 vs ~chars/4), i.e. it errs toward MORE pressure — the safe
 * direction (prune earlier, never overflow). This also keeps estimation bounded
 * under v8 coverage instrumentation, where a 40 KB encode can exceed a 15 s
 * per-test timeout.
 */
const EXACT_BPE_CHAR_CAP = 20_000;

/**
 * BPE token count of a string. Uses the char heuristic for oversized strings
 * (see `EXACT_BPE_CHAR_CAP`) and falls back to it if the tokenizer throws on a
 * pathological input — never let estimation crash or stall the run.
 */
function countTokens(text: string): number {
  if (!text) return 0;
  if (text.length > EXACT_BPE_CHAR_CAP) return Math.ceil(text.length / 3.5);
  try {
    return encode(text).length;
  } catch {
    return Math.ceil(text.length / 3.5);
  }
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function serialize(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
}
