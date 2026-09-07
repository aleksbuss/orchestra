/**
 * Agent message & response helpers (§10 decomposition, phase 1).
 *
 * Extracted verbatim from agent.ts: message-text extraction, the response-tool
 * unwrap (PM #61), thinking-tag stripping, the auto-continuation / forced
 * final-answer decision (PM #36 + PM #69). Pure + self-contained — no import
 * back into agent.ts — so it is unit-testable with a mock model
 * (final-answer-guard.test.ts) and shrinks the agent.ts hot file.
 */
import { callDeadlineSignal } from "@/lib/agent/stream-watchdog";
import { generateText, type ModelMessage } from "ai";
import type { AppSettings, ModelConfig } from "@/lib/types";
import { mergeConsecutiveSameRole } from "@/lib/agent/history";
import { generateFinalAnswerWithFailover, finalAnswerInstruction } from "@/lib/agent/final-answer-failover";
import type { DegradationPolicy } from "@/lib/agent/degradation-policy";
import { recordToolChannelDegradation } from "@/lib/agent/degradation-telemetry";
import { publishChatErrorEvent } from "@/lib/realtime/event-bus";

import {
  asRecord,
  extractHallucinatedToolCall,
  gateForcedAnswer,
  stripThinkingTags,
  type HallucinatedToolCall,
} from "@/lib/agent/printed-tool-call";

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

/**
 * Command patterns whose NON-ZERO exit unambiguously means "a verification
 * failed". Deliberately NARROW (PM #84 — the audit's hard requirement to bias to
 * false-NEGATIVES): `grep`, `test`/`[ ]`, and `git diff --exit-code` all exit
 * non-zero in normal use, so they are EXCLUDED — only real check commands whose
 * non-zero exit is always a failure are listed. Matched against the
 * `code_execution` `code` argument (the command the model actually ran).
 */
const VERIFICATION_COMMAND_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: "typecheck (tsc --noEmit)", re: /\btsc\b[^\n]*--no[-]?emit/i },
  { label: "typecheck (npm run typecheck)", re: /\bnpm\s+run\s+typecheck\b/i },
  { label: "build (npm run build)", re: /\bnpm\s+run\s+build\b/i },
  { label: "build (next build)", re: /\bnext\s+build\b/i },
  { label: "tests (vitest)", re: /\bvitest\b/i },
  { label: "tests (jest)", re: /\bjest\b/i },
  { label: "tests (pytest)", re: /\bpytest\b/i },
  { label: "tests (npm test)", re: /\bnpm\s+(?:run\s+)?test\b/i },
  { label: "lint (eslint)", re: /\beslint\b/i },
  { label: "lint (npm run lint)", re: /\bnpm\s+run\s+lint\b/i },
];

function matchVerificationCommand(code: string): string | null {
  for (const { label, re } of VERIFICATION_COMMAND_PATTERNS) {
    if (re.test(code)) return label;
  }
  return null;
}

/**
 * Parse the LAST `Exit code: N` line from a code_execution result, returning N
 * only when non-zero. `formatCommandResult` (code-execution.ts) appends this
 * line ONLY for a non-zero exit — a successful command prints no such line — so
 * its mere presence is the failure signal; we still require `!== 0` for safety
 * against a managed-session path that could print a zero.
 */
function parseLastNonZeroExit(resultText: string): number | null {
  const re = /Exit code:\s*(-?\d+)/g;
  let match: RegExpExecArray | null;
  let last: number | null = null;
  while ((match = re.exec(resultText)) !== null) {
    const n = Number.parseInt(match[1], 10);
    if (Number.isFinite(n)) last = n;
  }
  return last !== null && last !== 0 ? last : null;
}

function partToolName(part: unknown): string {
  if (!(typeof part === "object" && part !== null) || !("toolName" in part)) return "";
  const name = (part as { toolName?: unknown }).toolName;
  return typeof name === "string" ? name : "";
}

function partToolCallId(part: unknown): string {
  if (!(typeof part === "object" && part !== null) || !("toolCallId" in part)) return "";
  const id = (part as { toolCallId?: unknown }).toolCallId;
  return typeof id === "string" ? id : "";
}

/**
 * PM #84 — premature-completion visibility note. The agent sometimes calls the
 * `response` tool declaring a task "COMPLETED ✅" while its OWN last verification
 * FAILED (live, chat a8e1a43c: `npx tsc --noEmit` → Exit code 2, then "All the
 * TypeScript compiles without errors" + a `response("… COMPLETED ✅")`). The
 * PM #80 grounding signal IS in context and the model reacts to it mid-task, but
 * it IGNORES the failing check for its FINAL completion claim. Orchestra cannot
 * make a model reason honestly — but it CAN surface the contradiction.
 *
 * Returns an operator-facing notice when BOTH hold for THIS turn's messages:
 *   (a) a `response`-tool answer was delivered (the completion claim), AND
 *   (b) the LAST whitelisted verification command run this turn exited non-zero.
 * Otherwise null.
 *
 * DELIBERATELY false-negative-biased (the audit's requirement): the whitelist is
 * narrow (only commands whose non-zero exit is unambiguously a failure — never
 * grep/test/git-diff), "the LAST check" means a fix-then-rerun that passes
 * correctly suppresses it, and no-delivered-answer / no-whitelisted-check turns
 * stay silent. ADVISORY ONLY — it never blocks the `response` (a hard-gate was
 * REJECTED in the audit: unreliable detection → false-positive blocks,
 * nonsensical for non-code tasks). The behavioural lever is the system.md
 * hard_constraint #6 mandate; this is the deterministic visibility backstop.
 */
export function detectPrematureCompletion(messages: ModelMessage[]): string | null {
  // (a) a `response`-tool answer must have been delivered this turn — otherwise
  // there is no completion claim to contradict.
  if (!getLastResponseToolText(messages).trim()) return null;

  // code_execution tool-call id -> result output text.
  const resultById = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== "tool" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (!(typeof part === "object" && part !== null)) continue;
      if (!("type" in part) || part.type !== "tool-result") continue;
      if (partToolName(part) !== "code_execution") continue;
      const id = partToolCallId(part);
      if (!id) continue;
      const output =
        "output" in part
          ? (part as { output?: unknown }).output
          : (part as { result?: unknown }).result;
      resultById.set(id, extractToolResultOutputText(output));
    }
  }

  // The LAST whitelisted check call this turn (a fix-then-rerun overrides earlier
  // failures — only the final verification verdict matters).
  let lastCheck: { label: string; id: string } | null = null;
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (!(typeof part === "object" && part !== null)) continue;
      if (!("type" in part) || part.type !== "tool-call") continue;
      if (partToolName(part) !== "code_execution") continue;
      const input = asRecord("input" in part ? (part as { input?: unknown }).input : undefined);
      const code = typeof input?.code === "string" ? input.code : "";
      const label = matchVerificationCommand(code);
      const id = partToolCallId(part);
      if (label && id) lastCheck = { label, id };
    }
  }
  if (!lastCheck) return null;

  const exit = parseLastNonZeroExit(resultById.get(lastCheck.id) ?? "");
  if (exit === null) return null;

  return (
    `[Agent] ⚠️ Completion check — the last verification you ran this turn, ` +
    `${lastCheck.label}, exited ${exit} (non-zero), yet you delivered a final ` +
    `answer. If you reported this task complete, re-verify before claiming done — ` +
    `a green summary over a failing check misleads the user.`
  );
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

/** Does any message carry a native `tool-call` content part? */
function messagesContainToolCall(messages: ModelMessage[]): boolean {
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (part && typeof part === "object" && (part as { type?: string }).type === "tool-call") {
        return true;
      }
    }
  }
  return false;
}

/**
 * PM #97 (Layer 2) — did the provider DROP a native tool call (problem C)? The
 * model's final step reported finishReason `"tool-calls"` (it INTENDED to call a
 * tool) yet NO native tool call — of ANY kind, including the `response` answer
 * tool — materialized in the turn (OpenRouter's deepseek→OpenAI mapping
 * intermittently drops a large native call), and it did NOT print markup (so
 * PM #81's hallucination path did not fire).
 *
 * The signal is "finishReason=tool-calls AND zero tool-call parts", NOT
 * `!turnHasDeliverableAnswer` — a dropped-call turn usually carries a short PROSE
 * PREAMBLE ("Начинаю… 🚀") which `turnHasDeliverableAnswer` counts as delivered,
 * so that predicate would miss exactly this case. Keying on the ABSENCE of a
 * tool-call part is preamble-proof and still excludes a real answer (a `response`
 * answer IS a tool-call part) and any turn that actually executed a tool. Narrow
 * BY CONSTRUCTION: never fires on a real answer (`stop`), a step-cap pause,
 * plain-chat (no tools), a printed-markup hallucination, or a turn that ran any
 * tool. Pure; caller re-issues ONCE within the shared reissue budget.
 */
export function isDroppedNativeToolCall(args: {
  finishReason?: string;
  useTools: boolean;
  stepLimitReached: boolean;
  hallucinated: boolean;
  responseMessages: ModelMessage[];
}): boolean {
  if (!args.useTools || args.hallucinated || args.stepLimitReached) return false;
  if (args.finishReason !== "tool-calls") return false;
  return !messagesContainToolCall(args.responseMessages);
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
 * Delivered when even the forced final answer degraded into a printed ACTION
 * tool call — the model kept emitting tool markup as text under context pressure
 * (the free-model long-context tool-channel dropout; see
 * `orchestra-free-model-toolcall-limit`). Better an honest, actionable notice
 * than shipping kilobytes of un-executed markup as if it were the answer.
 */
/**
 * Honest, actionable notice shipped when the (forced) answer is still un-executed
 * tool markup — never the raw markup (PM #107/#108/#109). The steer is chosen by
 * the council-endorsed root cause (see memory `orchestra-free-model-toolcall-limit`):
 * the model is simply too weak for a long agentic build under a poisoned context,
 * so the highest-value guidance is "use your stronger model", made CONCRETE.
 *
 * Free-Mode-aware because that is the exact configuration the operator hits: Free
 * Mode overlays a FREE model onto the brain slot, and free models are the ones
 * that drop the tool-calling channel on long builds.
 *
 * CORRECTED (PM #134 follow-up). The paragraph here used to claim the overlay
 * held `chatModel` UNCHANGED, and the code read `settings.chatModel` on that
 * belief. Both were false: `applyFreeMode` (`free-mode.ts`) replaces the brain
 * slot, and every call site hands this function POST-overlay settings, so the
 * notice printed the RUNNING free brain under the label "your configured model …
 * NOT the one running right now" — wrong model AND wrong claim. It now reads
 * `freeModeDisplacedChatModel`, the carrier the overlay writes for exactly this.
 *
 * Second correction, same defect class one layer down: "turn off Free Mode, your
 * own model is stronger" is only true if the displaced brain IS stronger. The
 * operator's configured brain is itself a `:free` id
 * (`nvidia/nemotron-3-ultra-550b-a55b:free`, read from `data/settings` 2026-09-07),
 * so that advice lands them on another free model and the same dropout. When the
 * displaced brain is free we say so and point at a displaced PAID tier instead —
 * `freeModeDisplacedTiers` (PM #127) already carries those. Naming a model we
 * cannot verify is stronger is how this bug happened; the branches below only
 * ever claim what the settings actually support.
 *
 * Pure string builder in the failure branch — no hot-path logic, no behavioural
 * change to a healthy turn.
 *
 * The phrase "printed the call as text" is asserted by `final-answer-guard.test.ts`
 * — keep it in the base sentence.
 */
/** A `:free` OpenRouter id — the suffix is the whole signal (`free-mode.ts`). */
function isFreeModelId(model: string | undefined): boolean {
  return /:free$/i.test((model ?? "").trim());
}

export function buildToolMarkupDegradationNotice(settings?: AppSettings): string {
  const base =
    "⚠️ **The model tried to run a tool but printed the call as text instead of executing it**, so " +
    "nothing was changed. This is a known limit of some free models once the conversation grows long: an " +
    "accumulated context makes them drop the tool-calling channel.";

  if (settings?.freeMode?.enabled) {
    const preamble =
      " **You are in Free Mode**, which overlays a free model onto the brain slot — that free model, not " +
      "your configured one, is what degraded here.";
    const quickUnblock =
      " For a quick unblock without switching, ask for a **smaller, targeted change** (the agent will " +
      "use `replace_in_file` on a small span).";
    const displaced = settings.freeModeDisplacedChatModel?.model?.replace(/^~/, "");

    // The strongest concrete steer the settings actually support, in order.
    if (displaced && !isFreeModelId(displaced)) {
      return (
        base +
        preamble +
        ` To finish this build: your configured model \`${displaced}\` is stronger and is NOT the one ` +
        "running right now, so **turn off Free Mode** and resend the task in a **fresh chat** (a fresh chat " +
        "also drops the accumulated context that triggers this)." +
        quickUnblock
      );
    }

    if (displaced) {
      // The displaced brain is `:free` too — turning Free Mode off just swaps
      // one free model for another. Name a displaced PAID tier if one exists.
      const paidTier = [
        settings.freeModeDisplacedTiers?.frontier,
        settings.freeModeDisplacedTiers?.balanced,
        settings.freeModeDisplacedTiers?.fast,
      ].find((c) => c?.model && !isFreeModelId(c.model));
      const pointer = paidTier
        ? ` (you already have \`${paidTier.model.replace(/^~/, "")}\` configured in the proposer tiers)`
        : "";
      return (
        base +
        preamble +
        ` But turning Free Mode OFF will not fix this: your own chat model \`${displaced}\` is a \`:free\` ` +
        "model too, so you would land on the same dropout. To finish this build, point the **chat model at a " +
        `paid one**${pointer}, and resend the task in a **fresh chat** (a fresh chat also drops the ` +
        "accumulated context that triggers this)." +
        quickUnblock
      );
    }

    // No displaced record (settings never went through the overlay). Say only
    // what is true: a free model degraded, and context is the trigger.
    return (
      base +
      preamble +
      " To finish this build, switch the chat model to a paid one and resend the task in a **fresh chat** " +
      "(a fresh chat also drops the accumulated context that triggers this)." +
      quickUnblock
    );
  }

  return (
    base +
    " To get it working: ask for a **smaller, targeted change** (the agent will use `replace_in_file` on a " +
    "small span), start a **fresh chat** to shorten the context, or switch the chat model to a stronger one."
  );
}

// ── Loop-abort (2026-07-28, DoubleTake-reviewed) ──────────────────────────────
// The stable prefix `applyGlobalToolLoopGuard` (tool-guard.ts) emits when it
// BLOCKS an identical (tool+args) repeat. Shared here — NOT in tool-guard.ts —
// because tool-guard already imports this module (one-way agent-response ← never
// → tool-guard), so putting the marker here lets the guard reuse it with no
// import cycle. If you change the guard's message, keep this prefix identical.
export const LOOP_GUARD_REPEAT_MARKER = "[Loop guard] CRITICAL:";

/** True when a tool RESULT payload is a loop-guard repeat block (any output shape). */
export function isLoopGuardRepeatBlock(output: unknown): boolean {
  if (typeof output === "string") return output.includes(LOOP_GUARD_REPEAT_MARKER);
  try {
    return JSON.stringify(output ?? "").includes(LOOP_GUARD_REPEAT_MARKER);
  } catch {
    return false;
  }
}

/**
 * Count how many of the MOST RECENT steps were pure loop-guard blocks — a step
 * with ≥1 loop-block tool result and NO successful (non-block) tool result.
 * Counting stops at the first step that made any forward progress (a non-block
 * tool result, or a text-only / no-tool step), so ANY progress resets the run.
 *
 * Why this is the RIGHT signal (DoubleTake, 2026-07-28): a spiral is a FAILURE
 * state, not a "done" state, so we do not try to deduce completion from it — we
 * bound it. A STRONG model never issues the SAME blocked call 3× in a row (it
 * changes arguments or tactics after the first block), so a threshold of 3 has
 * zero regression surface for strong models; a WEAK model that compulsively
 * re-runs one passing command aborts in 3 steps instead of bleeding to the
 * per-turn step cap. It deliberately does NOT auto-submit the model's prose as an
 * answer (that would reopen the narration hole) — the caller emits an honest
 * PAUSE.
 */
export function countTrailingLoopBlockSteps(
  steps: ReadonlyArray<{ toolResults?: ReadonlyArray<{ output?: unknown }> }>
): number {
  let count = 0;
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const results = steps[i]?.toolResults;
    if (!results || results.length === 0) break; // text-only step = not spiralling
    const anyBlock = results.some((r) => isLoopGuardRepeatBlock(r.output));
    const anyProgress = results.some((r) => !isLoopGuardRepeatBlock(r.output));
    if (anyBlock && !anyProgress) count += 1;
    else break;
  }
  return count;
}

/**
 * Consecutive pure loop-block steps that trip the abort. 3 is safe: a strong
 * model does not repeat one identical BLOCKED call 3 times in a row.
 */
export const LOOP_ABORT_CONSECUTIVE = 3;

const LOOP_ABORT_PAUSE_MESSAGE =
  "⏸ **Paused — the agent was stuck in a tool loop.** It repeated the same tool " +
  "call with identical arguments several times without making progress, so the " +
  "turn was stopped early to avoid wasting steps. The work above may already be " +
  "complete (check it), or the agent may need a different instruction. Press " +
  "**Continue** to resume, or redirect it.";

/** Short transient-toast variant of the loop-abort pause. */
const LOOP_ABORT_PAUSE_NOTICE =
  "[Agent] Stopped early — caught in an identical-call tool loop. Review the work or redirect.";

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
  /**
   * True when this turn was stopped EARLY because the model got stuck repeating
   * an identical (tool+args) call the loop guard kept blocking (≥
   * LOOP_ABORT_CONSECUTIVE consecutive pure-block steps). Drives a distinct
   * honest PAUSE — never an auto-submitted "done". Takes precedence over the
   * step-cap check (it is the more specific stop reason, and it fires well
   * before the per-turn step cap).
   */
  loopAbortReached?: boolean;
  /**
   * The brain's ModelConfig. Free-tier track Sprint 3: lets the forced
   * final-answer path track this endpoint's health and substitute a healthy
   * model when it delivers nothing. Optional — without it the path degrades to
   * a single attempt (pre-Sprint-3 behaviour), which keeps existing callers and
   * tests working.
   */
  brainConfig?: ModelConfig;
  projectId?: string;
  currentPath?: string;
  /** Sprint 4 — may this turn substitute another configured model? */
  degradationPolicy?: DegradationPolicy;
  /**
   * PM #109 — needed so a degradation detected HERE (the forced-answer stage)
   * flags the chat and is recorded, exactly like one detected in the main turn.
   * Before this, the forced-answer stage was the one detection site that
   * recorded nothing, so the PM #82 compaction backstop never armed for it.
   */
  chatId?: string;
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
    loopAbortReached,
    brainConfig,
    projectId,
    currentPath,
    degradationPolicy,
    chatId,
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
  // failure was a step-cap-length turn ending on a dangling tool-call with NO pause notice.
  // At the step cap, ONLY a real `response`-tool answer counts as a genuine finish;
  // narration before an action tool does not. Deterministic + system-authored on
  // purpose (a forced model "final answer" masquerades as completion). No LLM call.
  // Loop-abort PAUSE (2026-07-28, DoubleTake-reviewed) — MORE SPECIFIC than the
  // step-cap, checked first. The turn was stopped EARLY because the model got
  // stuck repeating an identical blocked call; that is a FAILURE state, not a
  // finish, so we emit an honest pause — NOT an auto-submitted answer (which
  // would reopen the narration hole PM #82 guards). Same `!getLastResponseToolText`
  // guard as the step-cap: a genuine `response`-tool answer still counts as a
  // real finish even if the tail happened to be a block.
  if (loopAbortReached && !getLastResponseToolText(responseMessages).trim()) {
    console.log(
      `[Agent] Turn stopped early — identical-call tool loop (finishReason=${finishReason}); emitting loop-abort Continue notice.`
    );
    return { text: LOOP_ABORT_PAUSE_MESSAGE, uiNotice: LOOP_ABORT_PAUSE_NOTICE };
  }

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
        abortSignal: callDeadlineSignal(abortSignal),
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
    // (that is handled above, hoisted out of this gate). Force a tool-less final
    // answer so the user always gets a reply. Tool-less ⇒ text only ⇒ no loop.
    //
    // Free-tier track Sprint 3: this used to be ONE attempt on the SAME endpoint
    // that had just delivered nothing — so a throttled brain returned a second
    // empty body and this function returned `{ text: "" }` SILENTLY, rendering a
    // blank turn indistinguishable from an Orchestra bug. It now retries once
    // and then substitutes a healthy model from the operator's own settings,
    // and an undeliverable turn always carries an explanatory notice.
    // `generateFinalAnswerWithFailover` never replays the TOOL-CAPABLE stream —
    // every attempt is tool-less, so a retry can waste a generation but can
    // never repeat a side effect.
    //
    // PM #122 — same UX gap as `primary-stream-recovery.ts`: this ladder is
    // `generateText`-only, so it emits zero chunks for its whole duration and
    // the client's loading indicator is already gone (the original stream
    // already finished, just with no deliverable answer) by the time this
    // runs. Without a chatId there's no chat to scope the event to.
    if (chatId) {
      publishChatErrorEvent({
        chatId,
        projectId,
        payload: {
          kind: "recovering",
          message: `The configured model didn't answer — trying an alternate model. This can take a while on a degraded free tier.`,
          recoverable: true,
        },
      });
    }
    const attempt = await generateFinalAnswerWithFailover({
      model,
      systemPrompt,
      // PM #109 (2nd follow-up) — NEUTRALIZE the printed-markup before the forced
      // answer. `baseMessages` are already neutralized (agent.ts), but
      // `responseMessages` is the CURRENT turn's RAW output, which is exactly
      // where the fresh printed tool-call markup lives — and it is the most
      // recent context, so the recency prune KEEPS it. Measured live (chat
      // 9891bb43): after the context prune + output cap landed, the forced answer
      // STILL degraded — a 109-byte `read_text_file` printed as text at only 19K
      // tokens. Tiny argument, modest context: the dominant cause here is not
      // size, it is the model IMITATING the markup sitting in its own transcript
      // (the protake council's correction). Stripping that fodder removes the
      // example. Idempotent on the already-clean `baseMessages` (a placeholder is
      // not a hallucinated call), and it only rewrites assistant messages, so the
      // instruction below is untouched.
      messages: mergeConsecutiveSameRole([
        ...neutralizeHallucinatedHistory([...baseMessages, ...responseMessages]),
        {
          role: "user",
          content: finalAnswerInstruction(true),
        },
      ]),
      providerOptions,
      settings,
      // PM #121 — not the raw `abortSignal` param. Same reasoning as the
      // `onError` call site in `agent.ts`: this branch only runs once the
      // turn has already completed without a genuine client abort (an abort
      // exits via the SDK's own `onAbort`, never reaches "no answer was
      // delivered" here), and `req.signal` was observed to flip `aborted`
      // independently of client action during a downstream recovery window.
      // `undefined` still gets a real deadline bound inside the ladder.
      abortSignal: undefined,
      brainConfig,
      projectId,
      currentPath,
      degradationPolicy,
    });
    // If the forced answer ITSELF degraded into a printed ACTION tool call (the
    // model keeps emitting tool markup as text under context pressure), do NOT
    // ship the raw markup as the answer — that is the 16 KB-of-garbage failure.
    // A mis-emitted `response` call is recovered to prose inside the gate;
    // anything else printed as an action call is un-executed work. PM #132 moved
    // this detection into `gateForcedAnswer` so `primary-stream-recovery.ts`
    // runs the SAME check instead of its own (it had none).
    const gate = gateForcedAnswer(attempt.text);
    const text = gate.text;
    // PM #134 — the ladder now rejects printed markup itself and keeps
    // cascading, so a degradation can reach here two ways: as text this gate
    // catches (defence in depth — the ladder is not the only producer of
    // `attempt.text`), or as an EXHAUSTED ladder reporting the markup that
    // TRIGGERED the recovery. Both deserve the same specific notice; the generic
    // undeliverable one would drop the Free-Mode steer that tells the operator
    // what to actually do.
    //
    // The `!text` guard on the second branch is load-bearing (self-audit
    // 2026-09-07). Today no success path carries `markupDegradation`, so a
    // rescued turn cannot reach it — but without the guard, adding that field to
    // one success return for "telemetry completeness" would make this branch
    // throw away a substitute's real answer and ship the degradation notice in
    // its place. A cheap structural impossibility beats a convention nobody will
    // remember.
    const degraded: { toolName: string; endpoint?: ModelConfig; markupChars: number } | null =
      gate.degraded
        ? {
            toolName: gate.toolName,
            // Whoever actually produced the text — the brain on its retry, or a
            // substitute. Naming the brain slot here was harmless only while
            // the cascade never ran; it is a lie the moment it does.
            endpoint: attempt.endpoint ?? brainConfig,
            markupChars: text.length,
          }
        : !text && attempt.markupDegradation
          ? {
              toolName: attempt.markupDegradation.toolName,
              endpoint: attempt.markupDegradation.endpoint ?? brainConfig,
              markupChars: attempt.markupDegradation.markupChars,
            }
          : null;
    if (degraded) {
      // PM #109 — flag the chat AND record the conditions. This site used to do
      // neither: the notice shipped, the chat stayed un-flagged, so the next
      // turn ran at the same context and failed the same way (observed three
      // times in a row on chat 9891bb43).
      recordToolChannelDegradation({
        stage: "forced-answer",
        chatId,
        provider: degraded.endpoint?.provider,
        model: degraded.endpoint?.model,
        toolName: degraded.toolName,
        markupChars: degraded.markupChars,
        promptTokens: attempt.usage?.inputTokens ?? attempt.usage?.promptTokens,
      });
      return {
        text: buildToolMarkupDegradationNotice(settings),
        usage: attempt.usage,
        uiNotice: `[Agent] Forced answer still printed a '${degraded.toolName}' tool call as text; delivered an honest failure notice instead of raw markup.`,
      };
    }
    if (text) {
      console.log(
        `[Agent] PM #69 — forced final answer after a no-delivery turn (finishReason=${finishReason}).`
      );
    }
    return { text, usage: attempt.usage, uiNotice: attempt.notice };
  }

  return { text: "" };
}
