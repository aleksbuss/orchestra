/**
 * MoA prompt builders (Sprint 5 §10 — extracted from `moa.ts` to shrink
 * `runMoAEnsemble`'s host file below the §8 line). Pure string assembly with
 * ZERO closure over ensemble state, which is exactly why this is the safest,
 * lowest-risk leaf slice of the moa.ts decomposition. Re-exported from `moa.ts`
 * for back-compat with existing importers (`agent.ts`, `moa.test.ts`).
 */

import type { ModelMessage } from "ai";

// ── Aggregator Prompt ───────────────────────────────────────────────────
// PM #40 — synthesis prompt adapted from Together AI's MoA paper template
// (togethercomputer/MoA `prompts.py`), which was validated at 65.1% on
// AlpacaEval and beat GPT-4o (57.5%) using only open-source models.
//
// Key adaptations from the original:
//   - Orchestra-specific code-block preservation rule (genuinely useful
//     for the operator's primary workflows).
//   - "No meta-commentary" rule (cuts the "Based on the drafts above..."
//     preamble that bloats outputs).
//   - Cross-reference to the PM #39 disagreement marker — when present in
//     the user content, the synthesizer is reminded to follow its
//     instructions explicitly.
//
// The system role carries IDENTITY + RULES (stable across turns); the
// user content carries DATA (original request + numbered drafts). This
// is the cleaner split — previously the system was a one-liner and the
// rules were duplicated in the user content.

export const AGGREGATOR_SYSTEM_PROMPT = `You are the Aggregator at the final stage of a Mixture-of-Agents (MoA) pipeline. You have been provided with a set of responses from specialized expert agents who analyzed the user's request in parallel. Your task is to synthesize these responses into a single, high-quality reply.

It is crucial to critically evaluate the information in the expert responses, recognizing that some of it may be biased, incomplete, or incorrect. Your response should NOT simply replicate or vote-aggregate the drafts — it should offer a refined, accurate, and comprehensive reply that goes beyond any individual draft.

Strict rules:
1. PRESERVE TECHNICAL DETAIL. Specific version numbers, library names, API signatures, configuration values — keep them. Do NOT summarize them away.
2. CODE BLOCK INTEGRITY. Include all relevant code from the drafts. When drafts disagree on implementation, pick the most robust + production-ready version (or merge with explanatory comments). NEVER skip code to save space.
3. NO META-COMMENTARY. Start directly with the answer. Do NOT begin with "Based on the drafts" / "Here is the synthesis" / "Looking at the responses" / "After analyzing the experts".
4. CONFLICT RESOLUTION. If experts disagree on a factual claim (library version, API behavior, etc.), use your knowledge to pick the most accurate and modern choice. If you see a "<<DISAGREEMENT_DETECTED>>" marker in the user content, follow its additional instructions exactly — surface the conflict to the user, do not smooth it away.
5. MATCH USER'S FORMAT. Mirror the user's expected output structure (code-only, markdown with headers, JSON, plain prose) — don't add ceremony the user didn't ask for.
6. CORRECT SILENTLY. If you spot factual errors in the drafts, correct them in your synthesis without explicitly calling out the original mistake.

Adhere to the highest standards of accuracy and reliability.`;

export function buildAggregatorPrompt(userMessage: string, drafts: { role: string; text: string }[]): string {
  // Numbered format matches Together MoA's reference template — empirically
  // tuned for LLM synthesis quality. Role label stays as a hint, not a
  // hierarchy ("expert N (role: ...)") so the synthesizer doesn't infer
  // implicit priority from order.
  const draftBlock = drafts
    .map((d, i) => `${i + 1}. [Expert role: ${d.role}]\n${d.text}`)
    .join("\n\n");

  return `Original user request:
${userMessage}

Responses from expert agents (treat each as a candidate, not as authority):

${draftBlock}

Now produce the final synthesized response.`;
}

/**
 * Sprint 2 — MoA aggregator collapse (docs/moa-aggregator-collapse.md). Assemble
 * the block appended to the orchestrator system prompt on the collapsed synthesis
 * path: the ported synthesis `directive`, the optional PM #39 disagreement
 * `marker`, then the numbered expert drafts. The numbering/role-label format
 * mirrors `buildAggregatorPrompt` so the collapsed synthesizer sees the same
 * draft shape the standalone aggregator did. The drafts go in the SYSTEM prompt
 * (not a second user message) — a consecutive `user` turn crashes strict models
 * (PM #2). Pure + exported for unit testing.
 */
/**
 * Layer 0b (PM #94-follow-up) — bound a single draft's contribution to the
 * SYSTEM prompt. A reviewer draft was observed at ~14000 chars; injected raw,
 * a few such drafts push the (unprunable) system prompt past the reliable
 * window, squeezing the output budget until a `write_text_file` tool call
 * truncates mid-arguments. Cap keeps HEAD + TAIL rather than head-only: an LLM
 * draft puts its actionable conclusion / code at the END, so a pure head-slice
 * would keep the preamble and drop the payload (DoubleTake SEV5). Generous cap
 * (6000 chars) so normal drafts pass through verbatim; only the outliers fold.
 */
export const INLINE_SYNTHESIS_DRAFT_CHAR_CAP = 6000;

export function capDraftForInjection(
  text: string,
  cap = INLINE_SYNTHESIS_DRAFT_CHAR_CAP
): string {
  if (text.length <= cap) return text;
  const headLen = Math.floor(cap * 0.6);
  const tailLen = cap - headLen;
  const dropped = text.length - cap;
  return (
    text.slice(0, headLen) +
    `\n\n…[${dropped} chars elided to bound context — head+tail kept]…\n\n` +
    text.slice(text.length - tailLen)
  );
}

export function buildInlineSynthesisInjection(
  directive: string,
  drafts: { role: string; text: string }[],
  disagreementMarker: string
): string {
  const draftBlock = drafts
    .map((d, i) => `${i + 1}. [Expert role: ${d.role}]\n${capDraftForInjection(d.text)}`)
    .join("\n\n");
  const marker = disagreementMarker.trim()
    ? `\n\n${disagreementMarker.trim()}`
    : "";
  return `\n\n${directive.trim()}${marker}\n\n## Expert Drafts to Synthesize\n\n${draftBlock}`;
}

// ── Proposer Context Grounding (D1 / PM #94) ────────────────────────────────

/** Collapse any tool-result output envelope (`{ type, value }`) to its payload. */
function unwrapToolOutput(output: unknown): unknown {
  if (output && typeof output === "object" && "value" in (output as Record<string, unknown>)) {
    return (output as Record<string, unknown>).value;
  }
  return output;
}

/** One-line, whitespace-collapsed, length-capped summary of an arbitrary value. */
function summarizeValue(value: unknown, cap: number): string {
  if (value === null || value === undefined) return "";
  let s: string;
  if (typeof value === "string") {
    s = value;
  } else {
    try {
      s = JSON.stringify(value);
    } catch {
      s = String(value);
    }
  }
  s = s.replace(/\s+/g, " ").trim();
  return s.length > cap ? s.slice(0, cap) + "…" : s;
}

/**
 * Flatten one `ModelMessage`'s content — including tool-call and tool-result
 * parts — into a single plain-text line. Unlike the Router's flatten
 * (`moa-router.ts`), which extracts ONLY `.text` parts, this renders tool
 * activity (name + compact args/output) because that is exactly the task
 * context the proposers are missing.
 */
function flattenMessageContent(msg: ModelMessage, partCap: number): string {
  const content = msg.content as unknown;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const p = part as Record<string, unknown>;
    if (p.type === "text" && typeof p.text === "string") {
      parts.push(p.text);
    } else if (p.type === "tool-call") {
      const name = typeof p.toolName === "string" ? p.toolName : "tool";
      const args = summarizeValue(p.input ?? p.args, partCap);
      parts.push(`→ called ${name}(${args})`);
    } else if (p.type === "tool-result") {
      const name = typeof p.toolName === "string" ? p.toolName : "tool";
      const out = summarizeValue(unwrapToolOutput(p.output ?? p.result), partCap);
      parts.push(`${name} → ${out}`);
    }
    // image / file / reasoning parts carry no task-routing signal — skip.
  }
  return parts.join(" ");
}

/**
 * D1 / PM #94 — proposer context grounding.
 *
 * `safeHistory` (moa-setup.ts) strips ALL tool results + tool-call assistant
 * messages before the proposers see history, to avoid orphaned tool-call/result
 * pairs (a strict-provider 400 hazard). But that same strip ALSO removes the
 * active-task context that lives in tool activity — goal-tracker
 * `update_task_status` results, file reads, command output. So on a
 * context-dependent continuation ("continue" / "Продолжай"), proposers see only
 * plain chatter, cannot tell WHAT to continue, and each returns a "please
 * clarify" refusal — which the disagreement detector then reads as consensus
 * (identical drafts → ~0 distance) and lets poison the inline synthesis. The
 * Router already sidesteps this by flattening tool content to text
 * (`moa-router.ts`); the proposers did not — that asymmetry is the bug.
 *
 * This restores the SAME flattened recent-history view as a plain-text block for
 * the proposer SYSTEM prompt (NOT a re-inserted message — appending to the
 * system prompt has zero role-ordering / tool-pairing hazard, which is the whole
 * reason `safeHistory` stripped the messages instead of slicing them).
 *
 * Bounded by construction: last `maxMessages` messages, each capped at
 * `perMessageCharCap`, so the block stays small even though it is paid once per
 * proposer. Returns "" for empty history (first turn) so the caller can append
 * unconditionally. Pure + exported for unit testing.
 */
export function buildProposerContextBlock(
  history: readonly ModelMessage[],
  maxMessages = 8,
  perMessageCharCap = 500
): string {
  if (!history || history.length === 0) return "";

  const lines: string[] = [];
  for (const msg of history.slice(-maxMessages)) {
    const flat = flattenMessageContent(msg, perMessageCharCap).replace(/\s+/g, " ").trim();
    if (!flat) continue;
    const capped =
      flat.length > perMessageCharCap ? flat.slice(0, perMessageCharCap) + "…" : flat;
    lines.push(`[${msg.role.toUpperCase()}]: ${capped}`);
  }
  if (lines.length === 0) return "";

  return (
    "\n\n## Recent Conversation Context\n" +
    "The following is the recent history of THIS ongoing task, including tool " +
    "activity (file edits, command output, task-status updates). Use it to " +
    'understand what the user is referring to — especially for short follow-ups ' +
    'like "continue" / "Продолжай". Do NOT ask the user to repeat context that ' +
    "is already shown here; act on the task in progress.\n\n" +
    lines.join("\n")
  );
}
