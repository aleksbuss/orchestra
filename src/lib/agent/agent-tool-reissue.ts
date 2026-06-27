/**
 * PM #81 Sprint 2 — active self-heal for hallucinated tool calls.
 *
 * When a degraded model (qwen3-coder via OpenRouter under long context) PRINTS a
 * tool call as raw text instead of calling it natively, Sprint 1 detects it and
 * stops the XML reaching the user. This module recovers the INTENT: re-prompt
 * the model WITH tools + a deterministic correction so it re-issues the call as
 * a real native call and the action actually runs.
 *
 * Bounded by design (the correction itself can degrade again):
 *   - one bounded tool loop per re-issue (`stopWhen` stepCountIs cap), and
 *   - a chat-scoped retry budget (circuit breaker) so a model that keeps
 *     printing markup falls back to a plain answer instead of looping forever.
 *
 * The decision to RE-PROMPT rather than blind-execute the parsed markup is
 * deliberate (operator-chosen): a model degrades because something is off, and
 * the parsed args may be mangled (quote-heavy content — see PM #80). Executing
 * the model's own re-issued NATIVE call keeps the SDK's validation + the
 * loop-guard in the path; we never hand-execute a string we scraped from prose.
 *
 * Budget state is in-memory + per-process (chatId → attempt count), evaporating
 * on restart like the daemon's `autoPilotIterations` and the write-rewrite
 * budget. It is read/written entirely on the agent path (NOT boot-warmed /
 * route-read), so the PM #71 `globalThis` requirement does not apply.
 */
import {
  generateText,
  stepCountIs,
  hasToolCall,
  type ModelMessage,
  type ToolSet,
} from "ai";
import { resolveMaxOutputTokens } from "@/lib/providers/model-output-limits";
import { mergeConsecutiveSameRole } from "@/lib/agent/history";
import {
  extractHallucinatedToolCall,
  getLastAssistantText,
  getLastResponseToolText,
  stripThinkingTags,
} from "@/lib/agent/agent-response";
import type { AppSettings } from "@/lib/types";
import type { RawUsage } from "@/lib/cost/accumulator";

/** Max re-issue attempts per chat before falling back to a plain forced answer. */
const REISSUE_MAX_RETRIES = 2;
/** Step bound for the single re-issue tool loop (native call → result → answer). */
const REISSUE_STEP_CAP = 8;
/** FIFO bound on tracked chats. */
const MAX_TRACKED_CHATS = 500;

const attemptsByChat = new Map<string, number>();

function pruneTrackedChats(): void {
  while (attemptsByChat.size > MAX_TRACKED_CHATS) {
    const oldest = attemptsByChat.keys().next().value;
    if (oldest === undefined) break;
    attemptsByChat.delete(oldest);
  }
}

/**
 * Record a re-issue attempt for `chatId`; returns whether it is still within the
 * per-chat budget. Missing chatId ⇒ always allowed (best-effort tracking).
 */
export function recordReissueAttempt(chatId?: string): {
  allowed: boolean;
  count: number;
} {
  if (!chatId) return { allowed: true, count: 1 };
  const count = (attemptsByChat.get(chatId) ?? 0) + 1;
  attemptsByChat.set(chatId, count);
  pruneTrackedChats();
  return { allowed: count <= REISSUE_MAX_RETRIES, count };
}

/** Clear the budget — one chat, or all when no id is given (success / tests). */
export function resetReissueBudget(chatId?: string): void {
  if (chatId) attemptsByChat.delete(chatId);
  else attemptsByChat.clear();
}

/** Deterministic, Orchestra-authored correction injected for the re-issue. */
export const REISSUE_CORRECTION =
  "SYSTEM CORRECTION: Your previous message PRINTED a tool call as plain text " +
  "(e.g. `<tool_call>…</tool_call>`, `<function=…>`, or a raw JSON blob). That " +
  "text was NOT executed — it never reaches the tools. Re-issue the SAME action " +
  "now as a NATIVE tool/function call through the proper tool-calling channel. " +
  "Do NOT print tool-call markup again. If you genuinely cannot call the tool, " +
  "explain the situation to the user in plain prose instead.";

export interface ToolReissueResult {
  /** The re-issue's response messages (native tool call + result + final text). */
  responseMessages: ModelMessage[];
  /**
   * The delivered answer text. May be "" when the re-issue EXECUTED a tool but
   * produced no final text — the caller still persists `responseMessages` and
   * lets resolveTurnContinuation force the answer. A null return (not this) is
   * the "nothing useful happened" signal.
   */
  text: string;
  usage?: RawUsage;
}

/**
 * Run ONE bounded, tool-capable generation that asks the model to re-issue a
 * hallucinated tool call natively. Returns the result when it DELIVERED (a real
 * answer that is not itself another hallucination), else null — caller then
 * falls back to the plain forced answer. Never throws (returns null on error).
 */
export async function attemptToolReissue(args: {
  model: Parameters<typeof generateText>[0]["model"];
  systemPrompt: string;
  baseMessages: ModelMessage[];
  priorMessages: ModelMessage[];
  tools: ToolSet;
  providerOptions: Parameters<typeof generateText>[0]["providerOptions"];
  prepareStep: Parameters<typeof generateText>[0]["prepareStep"];
  settings: AppSettings;
  abortSignal?: AbortSignal;
}): Promise<ToolReissueResult | null> {
  try {
    const result = await generateText({
      model: args.model,
      system: args.systemPrompt,
      messages: mergeConsecutiveSameRole([
        ...args.baseMessages,
        ...args.priorMessages,
        { role: "user", content: REISSUE_CORRECTION },
      ]),
      providerOptions: args.providerOptions,
      tools: args.tools,
      prepareStep: args.prepareStep,
      stopWhen: [stepCountIs(REISSUE_STEP_CAP), hasToolCall("response")],
      temperature: args.settings.chatModel.temperature ?? 0.7,
      maxOutputTokens: resolveMaxOutputTokens(args.settings.chatModel),
      abortSignal: args.abortSignal,
    });

    const responseMessages = (
      (result as { response?: { messages?: ModelMessage[] } }).response?.messages ?? []
    ) as ModelMessage[];
    const responseToolText = getLastResponseToolText(responseMessages).trim();
    const text =
      responseToolText || stripThinkingTags(getLastAssistantText(responseMessages)).trim();
    // A re-issue that EXECUTED a native tool (call → tool-result message) is real
    // progress worth persisting even if it produced no final text — the caller
    // persists these messages and resolveTurnContinuation then forces the answer.
    // Without this, the executed write would be discarded (lost from history AND
    // unbilled) and a redundant forced generation would run. A tool message
    // (role "tool") only exists when a native call actually ran.
    const executedTool = responseMessages.some((m) => m.role === "tool");

    // Nothing useful happened: empty output, OR degraded into markup again with
    // no tool executed. Either way the caller falls back to a plain answer.
    if (!text && !executedTool) return null;
    if (!responseToolText && !executedTool && extractHallucinatedToolCall(text)) {
      return null;
    }

    return {
      responseMessages,
      text,
      usage: (result as { usage?: RawUsage }).usage,
    };
  } catch (err) {
    console.warn(
      "[Agent] PM #81 tool re-issue failed (non-fatal, falling back to forced answer):",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}
