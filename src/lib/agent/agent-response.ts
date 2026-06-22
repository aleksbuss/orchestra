/**
 * Agent message & response helpers (§10 decomposition, phase 1).
 *
 * Extracted verbatim from agent.ts: message-text extraction, the response-tool
 * unwrap (PM #61), thinking-tag stripping, the auto-continuation / forced
 * final-answer decision (PM #36 + PM #69). Pure + self-contained — no import
 * back into agent.ts — so it is unit-testable with a mock model
 * (final-answer-guard.test.ts) and shrinks the agent.ts hot file.
 */
import { generateText, type ModelMessage } from "ai";
import { resolveMaxOutputTokens } from "@/lib/providers/model-output-limits";
import type { AppSettings } from "@/lib/types";
import { mergeConsecutiveSameRole } from "@/lib/agent/history";

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * Strip thinking block from text to prevent leaking it to the user UI
 */
export function stripThinkingTags(text: string): string {
  if (!text) return text;
  return text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "").trim();
}

/**
 * Convert AI SDK ModelMessage to our ChatMessage format for storage.
 * Tool messages can contain multiple tool results, so this returns an array.
 */
/**
 * PM #61 — Models frequently emit the final `response` tool call as TEXT (a
 * JSON code block like `{"call":"response","arguments":{"message":"..."}}`)
 * instead of a native tool call — especially under heavy context (MoA) or on
 * mid-tier models. Orchestra has no parser for that, so the real answer gets
 * persisted as a raw JSON blob and the UI renders "no answer". This unwraps
 * that shape and returns the inner message; non-matching text passes through
 * unchanged (conservative — only unwraps when the WHOLE text is the call).
 */
export function unwrapSerializedResponseCall(text: string): string {
  if (!text || !text.includes("response")) return text;
  let body = text.trim();
  // Strip a single surrounding ```json ... ``` (or bare ```) fence.
  const fence = body.match(/^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```$/);
  if (fence) body = fence[1].trim();
  if (!body.startsWith("{") || !body.endsWith("}")) return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return text;
  }
  const rec = asRecord(parsed);
  if (!rec) return text;
  const toolName = rec.call ?? rec.name ?? rec.tool ?? rec.function;
  if (toolName !== "response") return text;
  const args =
    asRecord(rec.arguments) ?? asRecord(rec.input) ?? asRecord(rec.parameters) ?? rec;
  const message =
    typeof args.message === "string"
      ? args.message
      : typeof args.text === "string"
        ? args.text
        : typeof args.answer === "string"
          ? args.answer
          : null;
  return message && message.trim() ? message : text;
}

export function extractAssistantText(msg: ModelMessage): string {
  if (msg.role !== "assistant") return "";
  const content = msg.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  let text = "";
  for (const part of content) {
    if (
      typeof part === "object" &&
      part !== null &&
      "type" in part &&
      part.type === "text" &&
      "text" in part &&
      typeof (part as { text?: unknown }).text === "string"
    ) {
      text += (part as { text: string }).text;
    }
  }
  return text;
}

export function getLastAssistantText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const text = extractAssistantText(msg).trim();
    if (text) return text;
  }
  return "";
}

export function extractToolResultOutputText(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }
  const record = asRecord(output);
  if (!record) {
    if (output === null || output === undefined) {
      return "";
    }
    try {
      return JSON.stringify(output);
    } catch {
      return String(output);
    }
  }

  const value = "value" in record ? record.value : undefined;
  if (typeof value === "string") {
    return value;
  }
  if (value !== undefined) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  if (typeof record.message === "string") {
    return record.message;
  }

  try {
    return JSON.stringify(record);
  } catch {
    return String(record);
  }
}

export function getLastResponseToolText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];

    if (msg.role === "tool" && Array.isArray(msg.content)) {
      for (let j = msg.content.length - 1; j >= 0; j -= 1) {
        const part = msg.content[j];
        if (!(typeof part === "object" && part !== null)) continue;
        if (!("type" in part) || part.type !== "tool-result") continue;
        const toolName =
          "toolName" in part && typeof (part as { toolName?: unknown }).toolName === "string"
            ? ((part as { toolName: string }).toolName as string)
            : "";
        if (toolName !== "response") continue;

        const output =
          "output" in part ? (part as { output?: unknown }).output : (part as { result?: unknown }).result;
        const text = extractToolResultOutputText(output).trim();
        if (text) return text;
      }
    }

    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (let j = msg.content.length - 1; j >= 0; j -= 1) {
        const part = msg.content[j];
        if (!(typeof part === "object" && part !== null)) continue;
        if (!("type" in part) || part.type !== "tool-call") continue;
        const toolName =
          "toolName" in part && typeof (part as { toolName?: unknown }).toolName === "string"
            ? ((part as { toolName: string }).toolName as string)
            : "";
        if (toolName !== "response") continue;
        const input =
          "input" in part ? (part as { input?: unknown }).input : undefined;
        const inputRecord = asRecord(input);
        const message = typeof inputRecord?.message === "string" ? inputRecord.message.trim() : "";
        if (message) return message;
      }
    }
  }
  return "";
}

export function shouldAutoContinueAssistant(
  text: string,
  finishReason?: string
): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  const reason = (finishReason || "").toLowerCase();
  if (reason === "length" || reason === "max_tokens") {
    return true;
  }

  // Common abrupt cutoff pattern from prompt-generation turns.
  if (/(?:here is (?:the )?prompt|вот (?:твой )?(?:промпт|prompt))[:：]?\s*$/i.test(trimmed)) {
    return true;
  }

  return false;
}

/**
 * PM #69 — did this turn actually deliver an answer to the user? An answer
 * arrives either as a `response` tool call (the primary mechanism) or as plain
 * assistant text. A turn that ends with only tool calls + results — e.g. the
 * model called `search_web` and the loop stopped on a flaky
 * `finishReason: "other"` without a follow-up answer — delivered NOTHING, and
 * the caller must force a final-answer generation so the user always gets a
 * reply. Assistant text is checked AFTER `stripThinkingTags`: a turn whose only
 * text was a `<thinking>` block is persisted as empty, so it is not deliverable.
 */
export function turnHasDeliverableAnswer(messages: ModelMessage[]): boolean {
  if (getLastResponseToolText(messages).trim()) return true;
  return Boolean(stripThinkingTags(getLastAssistantText(messages)).trim());
}

export interface TurnContinuationResult {
  /** Extra assistant text to append (continuation tail or forced answer); "" when none needed. */
  text: string;
  usage?: import("@/lib/cost/accumulator").RawUsage;
  /** Non-fatal operator notice (a continuation/force attempt failed); caller publishes it. */
  uiNotice?: string;
}

/**
 * Persisted, user-visible message when a turn PAUSES at the per-turn step cap.
 * System-authored + deterministic ON PURPOSE: a model-authored "final answer"
 * forced after a step-cap stop reliably masquerades as completion ("Sprint 3
 * Complete ✅") and the operator can't tell a paused turn from a finished one.
 */
const STEP_LIMIT_PAUSE_MESSAGE =
  "⏸ **Reached the step limit for this turn.** The agent used the maximum number " +
  "of tool steps allowed in a single turn before finishing, so the work above may " +
  "be incomplete — this is a pause, not a completion. Press **Continue** to resume " +
  "from where it stopped.";

/** Short transient-toast variant of the pause message. */
const STEP_LIMIT_PAUSE_NOTICE =
  "[Agent] Reached the per-turn step limit — press Continue to resume the unfinished work.";

/**
 * PM #36 (truncation continuation) + PM #69 (forced final answer) — given a
 * finished turn, decide whether an EXTRA generation is needed and produce its
 * text + usage:
 *   - the reply was truncated (`shouldAutoContinueAssistant`) → continue from
 *     where it stopped (capped at 1200 tokens);
 *   - NO answer was delivered at all (`turnHasDeliverableAnswer` === false, the
 *     PM #69 failure) → force ONE tool-less final answer so the user always gets
 *     a reply. Tool-less ⇒ it can only emit text, never another tool call ⇒ no
 *     loop.
 * Returns `{ text: "" }` when the turn already delivered a complete answer.
 * Self-contained (only `generateText` + pure helpers) so it is unit-testable
 * with a mock model — see `final-answer-guard.test.ts`.
 */
export async function resolveTurnContinuation(args: {
  responseMessages: ModelMessage[];
  finishReason: string | undefined;
  model: Parameters<typeof generateText>[0]["model"];
  systemPrompt: string;
  baseMessages: ModelMessage[];
  providerOptions: Parameters<typeof generateText>[0]["providerOptions"];
  settings: AppSettings;
  abortSignal?: AbortSignal;
  /**
   * True when this turn ended because it EXHAUSTED the per-turn tool-step budget
   * (`stepCountIs(MAX_TOOL_STEPS_PER_TURN)`) rather than finishing. Drives the
   * deterministic pause notice instead of a forced (masquerading) completion.
   */
  stepLimitReached?: boolean;
}): Promise<TurnContinuationResult> {
  const {
    responseMessages,
    finishReason,
    model,
    systemPrompt,
    baseMessages,
    providerOptions,
    settings,
    abortSignal,
    stepLimitReached,
  } = args;
  const lastAssistantText = getLastAssistantText(responseMessages);
  const readUsage = (r: unknown) =>
    (r as { usage?: import("@/lib/cost/accumulator").RawUsage }).usage ?? undefined;

  if (shouldAutoContinueAssistant(lastAssistantText, finishReason)) {
    try {
      const continuation = await generateText({
        model,
        system: systemPrompt,
        messages: mergeConsecutiveSameRole([
          ...baseMessages,
          ...responseMessages,
          {
            role: "user",
            content:
              "Continue your previous answer from exactly where it stopped. " +
              "Output only the continuation text, without repeating earlier content.",
          },
        ]),
        providerOptions,
        temperature: settings.chatModel.temperature ?? 0.7,
        maxOutputTokens: Math.min(settings.chatModel.maxTokens ?? 4096, 1200),
        abortSignal,
      });
      return { text: (continuation.text || "").trim(), usage: readUsage(continuation) };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.warn("Auto-continuation failed:", error);
      return {
        text: "",
        uiNotice: `[Agent] Auto-continuation failed (truncated reply will ship as-is): ${errMsg}`,
      };
    }
  }

  if (!turnHasDeliverableAnswer(responseMessages)) {
    // Step-cap PAUSE (operator-requested). The turn ran out of its per-turn tool
    // budget without delivering an answer. Do NOT force a tool-less "final
    // answer" here — that yields a model-authored completion summary that
    // masquerades as "done". Return a DETERMINISTIC, system-authored pause
    // notice so the operator knows the turn paused at a limit (not finished),
    // and the work resumes on the next "Continue". No LLM call, no extra spend.
    if (stepLimitReached) {
      console.log(
        `[Agent] Turn paused at the per-turn step limit (finishReason=${finishReason}); emitting Continue notice.`
      );
      return { text: STEP_LIMIT_PAUSE_MESSAGE, uiNotice: STEP_LIMIT_PAUSE_NOTICE };
    }
    try {
      const forced = await generateText({
        model,
        system: systemPrompt,
        messages: mergeConsecutiveSameRole([
          ...baseMessages,
          ...responseMessages,
          {
            role: "user",
            content:
              "You have everything you need from the steps above. Write your " +
              "final answer to the user now, in plain prose. Do not call any tools.",
          },
        ]),
        providerOptions,
        temperature: settings.chatModel.temperature ?? 0.7,
        maxOutputTokens: resolveMaxOutputTokens(settings.chatModel),
        abortSignal,
      });
      const text = unwrapSerializedResponseCall((forced.text || "").trim());
      if (text) {
        console.log(
          `[Agent] PM #69 — forced final answer after a no-delivery turn (finishReason=${finishReason}).`
        );
      }
      return { text, usage: readUsage(forced) };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.warn("[Agent] PM #69 forced final answer failed:", error);
      return {
        text: "",
        uiNotice: `[Agent] Could not produce a final answer for this turn: ${errMsg}`,
      };
    }
  }

  return { text: "" };
}
