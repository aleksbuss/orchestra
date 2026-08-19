/**
 * Tool-channel degradation telemetry (PM #109).
 *
 * A weak model under context pressure stops emitting NATIVE tool calls and
 * prints the call as text instead. Orchestra already detects that at three
 * separate places, but before this module only ONE of them recorded anything,
 * and what it recorded was a single in-memory boolean. Two consequences, both
 * observed live on chat `9891bb43` (dots-3-note-preview:free):
 *
 *  1. The PM #82 backstop (a degraded chat compacts at HALF the normal
 *     threshold) never armed for the two degradations that happened at the
 *     forced-answer stage, so the chat kept re-entering the same failure.
 *  2. There was NO record of the conditions — context size, argument size,
 *     which upstream served the request — so every proposal to move the
 *     compaction threshold was a guess. A council review (2026-08-19) rejected
 *     the hardcoded-clamp proposal for exactly this reason: measure first.
 *
 * So this module is BOTH halves: it owns the degraded-chat flag (moved here
 * from `agent-tool-reissue.ts`, which owns the retry budget and nothing else
 * now) and it emits one structured log event per degradation carrying the
 * variables needed to LEARN the real boundary per model instead of hardcoding
 * one.
 *
 * Where the events land: BOTH the structured logger (stdout, and the daily
 * `data/logs/` JSONL when `ORCHESTRA_LOG_TO_FILE=1`) and a dedicated
 * `data/telemetry/tool-channel-degradation.jsonl`. The dedicated file exists
 * because the logger's file sink is OPT-IN and off on a normal `npm run dev`
 * install — checked, `data/logs/` is empty here — so "just log it" would have
 * meant the measurement lived in terminal scrollback and evaporated. These
 * events are rare (a handful per degraded chat) and the file is a self-pruning
 * ring of the last `MAX_PERSISTED_EVENTS`, so it cannot grow unbounded.
 *
 *   jq . data/telemetry/tool-channel-degradation.jsonl
 *
 * The flag state is in-memory + per-process (evaporating on restart, like the
 * reissue budget). It is read/written entirely on the agent path (NOT
 * boot-warmed / route-read), so the PM #71 `globalThis` requirement does not
 * apply. NOTE the known limitation this leaves: a restart clears the flag, so a
 * chat that degraded yesterday starts today un-flagged. Persisting it belongs
 * with the adaptive-clamp work, which is what the logged events are for.
 */
import { promises as fs } from "node:fs";
import { log } from "@/lib/observability/logger";
import { dataPath } from "@/lib/storage/data-dir";
import { safeWriteFile, withFileLock } from "@/lib/storage/fs-utils";

/** FIFO bound on tracked chats. */
const MAX_TRACKED_CHATS = 500;

/** Ring size for the persisted event file — old events age out, never accumulate. */
export const MAX_PERSISTED_EVENTS = 500;

/**
 * PM #82 — chats where the model has printed a tool call as TEXT (the degradation
 * symptom). A flagged chat compacts more aggressively on its next pre-flight pass
 * to escape the long-context hallucination loop — a behavior-triggered backstop
 * that needs no window number, so it catches any model/provider that degrades
 * BELOW the static reliable-window cap. Self-limiting: the tighter threshold only
 * fires when the chat is actually large, so a flag on a now-small chat is inert.
 */
const degradedChats = new Set<string>();

/** Flag `chatId` as degraded (a tool call was printed as text). */
export function recordChatDegradation(chatId?: string): void {
  if (!chatId) return;
  degradedChats.add(chatId);
  while (degradedChats.size > MAX_TRACKED_CHATS) {
    const oldest = degradedChats.values().next().value;
    if (oldest === undefined) break;
    degradedChats.delete(oldest);
  }
}

/** Has this chat shown the printed-tool-call degradation symptom? */
export function isChatDegraded(chatId?: string): boolean {
  return chatId ? degradedChats.has(chatId) : false;
}

/** Clear the degradation flag — one chat, or all when no id is given (tests). */
export function resetChatDegradation(chatId?: string): void {
  if (chatId) degradedChats.delete(chatId);
  else degradedChats.clear();
}

/**
 * Which detection site saw the degradation. All three MUST report — the
 * forced-answer stage is where the live incident actually surfaced, and it was
 * the one site that recorded nothing.
 */
export type DegradationStage =
  /** The main tool-loop turn ended with printed markup (PM #81 detector). */
  | "main-turn"
  /** The bounded re-issue degraded into markup again instead of calling natively. */
  | "reissue"
  /** The forced final answer itself came back as markup (PM #108 notice path). */
  | "forced-answer";

export interface ToolChannelDegradationEvent {
  stage: DegradationStage;
  chatId?: string;
  /** Provider id (e.g. "openrouter") of the brain that degraded. */
  provider?: string;
  /** Model id of the brain that degraded. */
  model?: string;
  /** The tool the model tried to call as text. */
  toolName?: string;
  /** Serialized size of the parsed arguments — the suspected causal variable. */
  argBytes?: number;
  /** Size of the whole printed markup block. */
  markupChars?: number;
  /** Our own pre-flight estimate of the context we sent, when known. */
  contextTokensEstimate?: number;
  /** Provider-REPORTED prompt tokens — ground truth, unlike the estimate. */
  promptTokens?: number;
  /**
   * Which upstream actually served an aggregated request (OpenRouter routes a
   * `:free` model across several). A boundary may be upstream-specific rather
   * than model-specific, and without this the two are indistinguishable.
   */
  upstreamProvider?: string;
}

/**
 * Record one tool-channel degradation: flag the chat (so the next pre-flight
 * pass compacts harder) AND emit the structured event. Call this INSTEAD of
 * `recordChatDegradation` at a detection site — the flag alone loses the
 * measurement, which is how the boundary stayed unknown through three
 * post-mortems.
 *
 * Never throws: telemetry must not be able to fail a turn.
 */
export function recordToolChannelDegradation(
  event: ToolChannelDegradationEvent
): void {
  recordChatDegradation(event.chatId);
  const fields = {
    module: "agent",
    chatId: event.chatId,
    stage: event.stage,
    provider: event.provider,
    model: event.model,
    toolName: event.toolName,
    argBytes: event.argBytes,
    markupChars: event.markupChars,
    contextTokensEstimate: event.contextTokensEstimate,
    promptTokens: event.promptTokens,
    upstreamProvider: event.upstreamProvider,
  };
  try {
    log.warn("tool_channel_degradation", fields);
  } catch {
    // Logging must never break the turn it is describing.
  }
  // Fire-and-forget: the turn must not wait on (or fail with) telemetry I/O.
  void persistDegradationEvent({ ts: new Date().toISOString(), ...fields }).catch(
    () => {}
  );
}

/** Path of the persisted ring. Resolved per call — never captured at import. */
function degradationLogPath(): string {
  return dataPath("telemetry", "tool-channel-degradation.jsonl");
}

/**
 * Keep only the newest `max` events. Pure + exported so the ring is testable
 * without touching the filesystem (a test that writes through a storage module
 * against the LIVE data dir is PM #100).
 */
export function capEventLines(lines: string[], max: number): string[] {
  return lines.filter((l) => l.trim()).slice(-max);
}

/**
 * Append one event to the persisted ring. Skipped under test runners: this
 * writes into the real `data/` tree, and a unit test must never do that
 * (PM #100). Never throws.
 */
async function persistDegradationEvent(record: Record<string, unknown>): Promise<void> {
  if (process.env.VITEST || process.env.NODE_ENV === "test") return;
  const file = degradationLogPath();
  try {
    await withFileLock(file, async () => {
      let existing = "";
      try {
        existing = await fs.readFile(file, "utf-8");
      } catch {
        existing = ""; // first event — the file does not exist yet
      }
      const lines = capEventLines(
        [...existing.split("\n"), JSON.stringify(record)],
        MAX_PERSISTED_EVENTS
      );
      await safeWriteFile(file, `${lines.join("\n")}\n`);
    });
  } catch {
    // A telemetry write that fails is a lost measurement, never a failed turn.
  }
}

/**
 * Best-effort read of WHICH upstream actually served an aggregated request.
 *
 * OpenRouter routes one model id (especially a `:free` one) across several
 * upstreams whose effective limits differ, and it reports the chosen one in
 * `providerMetadata.openrouter.provider`. Without this field a boundary learned
 * per MODEL silently averages over upstreams — the difference between "dots-3
 * collapses at 50 K" and "the AtlasCloud deployment of dots-3 does". Shape is
 * provider-specific and undocumented as a contract, so this is defensive and
 * returns undefined rather than guessing.
 */
export function readUpstreamProvider(event: unknown): string | undefined {
  const meta = (event as { providerMetadata?: unknown } | null)?.providerMetadata;
  if (!meta || typeof meta !== "object") return undefined;
  for (const block of Object.values(meta as Record<string, unknown>)) {
    if (!block || typeof block !== "object") continue;
    const provider = (block as Record<string, unknown>).provider;
    if (typeof provider === "string" && provider) return provider;
  }
  return undefined;
}

/** Byte size of a parsed argument record, best-effort (never throws). */
export function argumentByteSize(args: unknown): number | undefined {
  try {
    return JSON.stringify(args ?? null)?.length;
  } catch {
    return undefined;
  }
}
