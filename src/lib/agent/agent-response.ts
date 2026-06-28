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

/**
 * Extract the first BALANCED `{…}` JSON object from the start of `s` (ignoring a
 * leading run of whitespace), discarding any trailing junk (`</function>`,
 * `</tool_call>`, prose). Returns `s` unchanged when it doesn't start with `{`
 * or the braces never balance — letting the caller's JSON.parse fail cleanly.
 */
function extractLeadingJson(s: string): string {
  const str = s.trimStart();
  if (!str.startsWith("{")) return str;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) return str.slice(0, i + 1);
    }
  }
  return str;
}

export function extractHallucinatedToolCall(
  text: string
): HallucinatedToolCall | null {
  if (!text) return null;
  // Defang ONE fully-enclosing ```lang … ``` fence (a fenced block is a teaching
  // example, not the model's actual call). Leading/trailing prose is otherwise
  // ALLOWED below: the real long-context degradation is "Let me update X:\n\n
  // <tool_call>…" — prose, then the call — so anchoring to `^…$` (as the first
  // cut did) missed every real case (PM #81 deep-audit against chat a8e1a43c).
  const body = stripOneCodeFence(text.trim());
  if (!body) return null;

  // 1) Functionary form: `<function=NAME>` followed by `<parameter=…>` pairs or a
  //    `{json}` body. This covers the dominant real degradation
  //    `…<tool_call>\n<function=write_text_file>\n<parameter=file_path>…` (nested,
  //    prose-prefixed, often UNCLOSED to EOF) AND standalone `<function=…>{…}`.
  //    `<function=NAME>` immediately followed by a parameter/JSON body is
  //    unambiguous — normal prose never contains it — so we SEARCH (prose before
  //    it is fine) yet require the body so a bare mention never matches.
  const fn = body.match(/<function=([A-Za-z0-9_.\-]+)\s*>/i);
  if (fn) {
    const after = body.slice((fn.index ?? 0) + fn[0].length).trimStart();
    if (after.startsWith("<parameter=")) {
      const args: Record<string, unknown> = {};
      // A value runs until </parameter>, the next <parameter=, a closing
      // </function>/</tool_call>, or EOF (the real blocks are unclosed).
      for (const p of after.matchAll(
        /<parameter=([A-Za-z0-9_.\-]+)\s*>([\s\S]*?)(?=<\/parameter>|<parameter=|<\/function>|<\/tool_call>|$)/gi
      )) {
        args[p[1]] = p[2].trim();
      }
      return { name: fn[1], args, raw: body };
    }
    if (after.startsWith("{")) {
      const rec = (() => {
        try {
          return asRecord(JSON.parse(extractLeadingJson(after)));
        } catch {
          return null;
        }
      })();
      return { name: fn[1], args: rec ?? {}, raw: body };
    }
  }

  // 2) Qwen/Hermes `<tool_call>{json}</tool_call>` (closing optional; leading
  //    prose allowed). A bare `<tool_call>` MENTION (no `{`/`<function=` after)
  //    never matches — that distinguishes a real call from prose ABOUT one.
  const tc = body.match(/<tool_call>\s*(\{[\s\S]*)$/i);
  if (tc) {
    const call = parseCallObject(extractLeadingJson(tc[1]));
    if (call) return { ...call, raw: body };
  }

  // 3) Mistral `[TOOL_CALLS] <json>` (object or single-element array).
  const mistral = body.match(/\[TOOL_(?:CALLS?|REQUEST)\]\s*(\[?\s*\{[\s\S]*)$/i);
  if (mistral) {
    const call = parseCallObject(mistral[1]);
    if (call) return { ...call, raw: body };
  }

  // 4) bare JSON blob (no markup) — ONLY the `response` serialization (PM #61).
  //    Bare JSON is too ambiguous to treat as an ACTION-tool call: a legitimate
  //    final answer can BE bare JSON (e.g. "reply with only the tool-call JSON,
  //    no prose"), and the detect/suppress path would then DELETE that answer.
  //    For `response` a false match is harmless — it just recovers the message
  //    as prose. So bare JSON matches `response` only; every other tool requires
  //    the unambiguous markup of branches 1–3.
  if (body.startsWith("{") && body.endsWith("}")) {
    const call = parseCallObject(body);
    if (call && call.name === "response") {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(body);
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
      if (hasArgsContainer) return { ...call, raw: body };
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

/** Placeholder swapped in for a historical printed-tool-call message (PM #82). */
export const HALLUCINATED_HISTORY_PLACEHOLDER =
  "[Orchestra removed a tool call that an earlier turn printed as text instead of " +
  "executing. Issue tool calls through the native function-calling channel.]";

/**
 * PM #82 — neutralize printed-tool-call markup sitting in CHAT HISTORY. A degraded
 * model that prints `<tool_call>`/`<function=…>` as text poisons its OWN future
 * turns: those messages become few-shot examples it imitates, so the loop persists
 * even after the per-turn suppression (PM #81, which only governs the LAST message)
 * and even after compaction keeps them in the recent window. For every historical
 * ASSISTANT message whose text IS an action-tool hallucination (NOT `response` — a
 * printed answer carries content we keep), replace that text with a short neutral
 * placeholder. Pair-safe: printed calls are TEXT (no `toolCallId`), so swapping
 * them never orphans a native tool-call/result pair; non-text parts are preserved.
 */
export function neutralizeHallucinatedHistory(
  messages: ModelMessage[]
): ModelMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "assistant") return msg;
    const text = stripThinkingTags(extractAssistantText(msg)).trim();
    if (!text) return msg;
    const call = extractHallucinatedToolCall(text);
    if (!call || call.name === "response") return msg;

    const content = msg.content;
    if (typeof content === "string") {
      return { ...msg, content: HALLUCINATED_HISTORY_PLACEHOLDER };
    }
    if (!Array.isArray(content)) return msg;
    // Drop the text parts (they carry the markup), keep any non-text parts, and
    // prepend a single placeholder so the turn still reads as a neutralized reply.
    const nonText = content.filter(
      (p) =>
        !(typeof p === "object" && p !== null && "type" in p && p.type === "text")
    );
    return {
      ...msg,
      content: [{ type: "text", text: HALLUCINATED_HISTORY_PLACEHOLDER }, ...nonText],
    } as ModelMessage;
  });
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

  // Step-cap PAUSE (PM #82 follow-up — HOISTED above the deliverable-answer gate).
  // When the per-turn step budget was EXHAUSTED, the tool loop was CUT OFF
  // mid-work and the user MUST be told to press Continue. This check used to live
  // inside the `!turnHasDeliverableAnswer` block below, which made it UNREACHABLE
  // for a model that narrates before each tool call ("Now I understand. Let me
  // fix X"): that narration is non-empty assistant text, so `turnHasDeliverableAnswer`
  // returned true, the block was skipped, and the pause never fired — the live
  // failure was a 50-step turn ending on a dangling tool-call with NO pause notice.
  // At the step cap, ONLY a real `response`-tool answer counts as a genuine finish;
  // narration before an action tool does not. Deterministic + system-authored on
  // purpose (a forced model "final answer" masquerades as completion). No LLM call.
  if (stepLimitReached && !getLastResponseToolText(responseMessages).trim()) {
    console.log(
      `[Agent] Turn paused at the per-turn step limit (finishReason=${finishReason}); emitting Continue notice.`
    );
    return { text: STEP_LIMIT_PAUSE_MESSAGE, uiNotice: STEP_LIMIT_PAUSE_NOTICE };
  }

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
    // No answer was delivered at all (PM #69) and this was NOT a step-cap pause
    // (that is handled above, hoisted out of this gate). Force ONE tool-less final
    // answer so the user always gets a reply. Tool-less ⇒ text only ⇒ no loop.
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
