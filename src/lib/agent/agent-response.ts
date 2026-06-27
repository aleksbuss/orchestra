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
  if (!text) return text;
  // PM #81 — the response call may arrive wrapped in RAW tool-call markup
  // (`<tool_call>{…}</tool_call>`, `<function=response>{…}`, `[TOOL_CALLS]…`),
  // not just a bare JSON blob. extractHallucinatedToolCall normalizes every
  // shape; recover the inner message when the mis-emitted call is `response`.
  const markupCall = extractHallucinatedToolCall(text);
  if (markupCall && markupCall.name === "response") {
    const recovered = readResponseMessage(markupCall.args);
    if (recovered) return recovered;
  }
  if (!text.includes("response")) return text;
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

/**
 * PM #81 — a tool call the model emitted as RAW TEXT instead of a native tool
 * call. Degraded models (notably Qwen via Ollama/OpenRouter under long context)
 * stop using the native tool-calling channel and PRINT the call as markup:
 *   - Qwen/Hermes:   `<tool_call>{"name":"t","arguments":{…}}</tool_call>`
 *   - Functionary:   `<function=t>{…}</function>` or `<function=t><parameter=k>v</parameter>`
 *   - Mistral:       `[TOOL_CALLS]{…}` / `[TOOL_CALLS][{…}]`
 *   - bare JSON:     `{"name":"response",…}` ONLY (PM #61) — see branch 4 for why
 *                    action tools require markup, never ambiguous bare JSON.
 * Orchestra only ever parsed the `response`-tool JSON shape
 * (`unwrapSerializedResponseCall`), so ANY other such call was persisted
 * verbatim — the user saw XML garbage and the intended action never ran.
 *
 * Returns the normalized `{ name, args, raw }` when the WHOLE trimmed text is a
 * single such call, else null. Conservative on purpose: an answer that merely
 * quotes `<tool_call>` inside surrounding prose must NOT match (a false positive
 * would suppress a real answer), so the markup must DOMINATE the message — every
 * branch below anchors with `^…$`.
 */
export interface HallucinatedToolCall {
  name: string;
  args: Record<string, unknown>;
  /** The matched markup span (for "does this dominate the message" checks). */
  raw: string;
}

/** Strip ONE surrounding ```lang … ``` fence; no fence ⇒ returned unchanged. */
function stripOneCodeFence(s: string): string {
  const fence = s.match(/^```(?:[a-zA-Z0-9_-]+)?\s*\n?([\s\S]*?)\n?```$/);
  return fence ? fence[1].trim() : s;
}

/** Read a final-answer string out of a `response`-call arg bag. */
function readResponseMessage(args: Record<string, unknown>): string | null {
  for (const key of ["message", "text", "answer", "response", "content"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

/**
 * Parse a JSON tool-call object (or a single-element array of them) into
 * `{ name, args }`. Handles the OpenAI nested `{ function: { name, arguments } }`
 * shape and an `arguments` field that is itself a JSON STRING. Returns null when
 * no tool name can be resolved.
 */
function parseCallObject(
  jsonText: string
): { name: string; args: Record<string, unknown> } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText.trim());
  } catch {
    return null;
  }
  if (Array.isArray(parsed)) parsed = parsed[0];
  const rec = asRecord(parsed);
  if (!rec) return null;

  // OpenAI-style nesting: { type:"function", function:{ name, arguments } }.
  const fnRec = asRecord(rec.function);
  const name: unknown =
    fnRec && typeof fnRec.name === "string"
      ? fnRec.name
      : (rec.name ?? rec.tool ?? rec.call ?? rec.function);
  if (typeof name !== "string" || !name.trim()) return null;

  const rawArgs =
    (fnRec ? fnRec.arguments ?? fnRec.parameters : undefined) ??
    rec.arguments ??
    rec.input ??
    rec.parameters;
  let args: Record<string, unknown> = {};
  if (typeof rawArgs === "string") {
    // OpenAI serializes arguments as a JSON string.
    try {
      args = asRecord(JSON.parse(rawArgs)) ?? {};
    } catch {
      args = {};
    }
  } else {
    args = asRecord(rawArgs) ?? {};
  }
  return { name: name.trim(), args };
}

export function extractHallucinatedToolCall(
  text: string
): HallucinatedToolCall | null {
  if (!text) return null;
  const trimmed = stripOneCodeFence(text.trim());
  if (!trimmed) return null;

  // 1) <tool_call>{…}</tool_call> (Qwen/Hermes); closing tag optional.
  let m = trimmed.match(/^<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>)?\s*$/i);
  if (m) {
    const call = parseCallObject(m[1]);
    if (call) return { ...call, raw: trimmed };
  }

  // 2) <function=NAME>{…}</function> | <function=NAME><parameter=k>v</parameter>…
  m = trimmed.match(/^<function=([a-zA-Z0-9_.-]+)\s*>\s*([\s\S]*?)\s*(?:<\/function>)?\s*$/i);
  if (m) {
    const name = m[1];
    const inner = m[2].trim();
    let args: Record<string, unknown> = {};
    let jsonInner: unknown = null;
    try {
      jsonInner = JSON.parse(inner);
    } catch {
      jsonInner = null;
    }
    const innerRec = asRecord(jsonInner);
    if (innerRec) {
      args = innerRec;
    } else {
      for (const p of inner.matchAll(
        /<parameter=([a-zA-Z0-9_.-]+)\s*>([\s\S]*?)<\/parameter>/gi
      )) {
        args[p[1]] = p[2];
      }
    }
    return { name, args, raw: trimmed };
  }

  // 3) [TOOL_CALLS] / [TOOL_CALL] / [TOOL_REQUEST] <json> (Mistral-style).
  m = trimmed.match(/^\[TOOL_(?:CALLS?|REQUEST)\]\s*([\s\S]+)$/i);
  if (m) {
    const call = parseCallObject(m[1]);
    if (call) return { ...call, raw: trimmed };
  }

  // 4) bare JSON blob (no markup) — ONLY the `response` serialization (PM #61).
  //    Bare JSON is too ambiguous to treat as an ACTION-tool call: a legitimate
  //    final answer can BE bare JSON (e.g. "reply with only the tool-call JSON,
  //    no prose"), and the detect/suppress path would then DELETE that answer.
  //    For `response` a false match is harmless — it just recovers the message
  //    as prose. So bare JSON matches `response` only; every other tool requires
  //    the unambiguous markup of branches 1–3 (where surrounding prose breaks the
  //    `^…$` anchor, so a teaching example never matches).
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const call = parseCallObject(trimmed);
    if (call && call.name === "response") {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        parsed = null;
      }
      const rec = asRecord(parsed);
      const hasArgsContainer = !!(
        rec &&
        ("arguments" in rec ||
          "input" in rec ||
          "parameters" in rec ||
          asRecord(rec.function))
      );
      if (hasArgsContainer) return { ...call, raw: trimmed };
    }
  }

  return null;
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
  const text = stripThinkingTags(getLastAssistantText(messages)).trim();
  if (!text) return false;
  // PM #81 — text that is ONLY a hallucinated tool call (raw `<tool_call>` markup,
  // not a native call) delivered no real answer. A mis-emitted `response` call is
  // still recoverable to prose by the persistence-layer unwrap, so it counts as
  // delivered; any OTHER tool printed as markup (write_text_file, search_web…) is
  // a failed action — return false so resolveTurnContinuation forces a clean
  // final answer instead of persisting XML garbage to the user.
  const hallucinated = extractHallucinatedToolCall(text);
  if (hallucinated && hallucinated.name !== "response") return false;
  return true;
}

/**
 * PM #81 Sprint 2 — was this turn's only "answer" a hallucinated ACTION tool
 * call printed as text (not the `response` tool, and no real answer delivered)?
 * Returns the parsed call so the caller can re-issue it natively, else null.
 * Mirrors turnHasDeliverableAnswer's logic: a real `response` tool result, or a
 * mis-emitted `response` (unwrap recovers it), both count as delivered.
 */
export function detectActionHallucination(
  messages: ModelMessage[]
): HallucinatedToolCall | null {
  if (getLastResponseToolText(messages).trim()) return null;
  const text = stripThinkingTags(getLastAssistantText(messages)).trim();
  if (!text) return null;
  const call = extractHallucinatedToolCall(text);
  return call && call.name !== "response" ? call : null;
}

/**
 * PM #81 Sprint 2 — drop the trailing assistant message when its text is an
 * action-tool hallucination, so the raw `<tool_call>` markup is NEVER persisted
 * to the chat (the user must not see XML garbage). Only the LAST message is
 * considered, and only when it is an assistant message whose stripped text is a
 * non-`response` hallucinated call — everything else passes through untouched.
 */
export function stripHallucinatedTrailingText(
  messages: ModelMessage[]
): ModelMessage[] {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  if (last.role !== "assistant") return messages;
  const text = stripThinkingTags(extractAssistantText(last)).trim();
  const call = extractHallucinatedToolCall(text);
  if (call && call.name !== "response") return messages.slice(0, -1);
  return messages;
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
