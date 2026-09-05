/**
 * PM #131 — the Router's CONTEXT layer, extracted from `moa-router.ts` when
 * that file crossed the 800-line soft cap (CLAUDE.md rule 25). Everything here
 * is pure: no LLM call, no filesystem, no network. It answers one question —
 * "what work is this turn about?" — from three sources, in order of how
 * trustworthy each proved when measured against a real chat:
 *
 *   1. the active goal record (`RouterGoalContext`, read by `moa.ts`),
 *   2. the recent transcript, bounded in TOKENS and cut head+tail,
 *   3. a deterministic reading of the message itself (bare continuation?).
 *
 * `moa-router.ts` re-exports the public names, so importers may use either
 * module.
 */
import type { ModelMessage } from "ai";
import { flattenMessageContent, capHeadTail } from "@/lib/agent/moa-prompts";
import { estimateTokenCount } from "@/lib/agent/compressor";

// ── Continuation handling (PM #129) ─────────────────────────────────────────
//
// A bare "продолжай" / "continue" carries NO complexity signal of its own. The
// Router was asked "does THIS message need a committee?" about a single word,
// against a recent-context window that (before this PM) rendered every
// tool-call and tool-result message as an EMPTY string — so on exactly the
// turns that matter (a long agentic run the operator wants continued) the
// Router judged one word against a blank page and answered `false`. The swarm
// then never fanned out and only the manual Force pill brought it back.
//
// Three things fix that, in increasing order of how much they depend on the
// model cooperating:
//   1. Show the Router the real recent history (shared `flattenMessageContent`).
//   2. Tell it, in the prompt, that a continuation inherits the complexity of
//      the work being continued, and hand it the ORIGINAL request.
//   3. A deterministic FLOOR that does not depend on the model at all: a bare
//      continuation of demonstrated task activity may not be judged trivial.
//
// The floor is narrow on purpose. It fires only when the message is a bare
// continuation AND the conversation shows real work in progress, because a
// false `requiresSwarm: true` fans out 3-5 proposers against a shared free-tier
// quota. "Продолжай" after idle chatter still bypasses.

/** Longest a message can be and still count as a BARE continuation. */
const CONTINUATION_MAX_CHARS = 40;

/**
 * Tokens that on their own mean "keep doing what you were doing". A message
 * qualifies as a continuation only if at least one strong token is present.
 */
const CONTINUATION_STRONG: RegExp[] = [
  /^продолж/, // продолжай / продолжи / продолжаем / продолжить / продолжайте
  /^дальше$/,
  /^далее$/,
  /^ещ[её]$/,
  /^доделай/,
  /^continue$/,
  /^proceed$/,
  /^resume$/,
];

/**
 * Strong ONLY inside a phrase ("go on", "keep going", "carry on"). Alone these
 * are ordinary English words with a different meaning — a cross-model review
 * flagged them and it reproduced: bare "next" is pagination, bare "more" is
 * "more examples", bare "go" is an approval. Each would have forced a swarm and
 * spent shared free-tier quota on a request that never asked for one. Requiring
 * a second token keeps every real phrasing and drops every bare one.
 */
const CONTINUATION_PHRASAL: RegExp[] = [
  /^go$/,
  /^keep$/,
  /^carry$/,
  /^next$/,
  /^more$/,
  /^finish$/,
];

/**
 * Connectors and politeness that may accompany a continuation without changing
 * it into a new instruction ("go on", "keep going", "continue please",
 * "давай дальше"). Anything OUTSIDE strong ∪ filler means the user said
 * something substantive — then it is not a bare continuation and the Router
 * judges it on its own merits, as it should.
 */
const CONTINUATION_FILLER = new Set([
  "on",
  "ahead",
  "going",
  "please",
  "pls",
  "ok",
  "okay",
  "then",
  "it",
  "пожалуйста",
  "плиз",
  "давай",
  "давайте",
  "ок",
  "окей",
  "го",
  "погнали",
]);

/**
 * True when the message is a BARE continuation — no task description of its
 * own. Deterministic: no LLM, no heuristic scoring. Pure + exported so the
 * lexicon is pinned by tests rather than by whatever the Router felt like today.
 */
export function isContinuationMessage(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized || normalized.length > CONTINUATION_MAX_CHARS) return false;

  const tokens = normalized.split(" ");
  let strong = 0;
  for (const token of tokens) {
    if (CONTINUATION_STRONG.some((re) => re.test(token))) {
      strong++;
      continue;
    }
    // A phrasal token counts only when something else accompanies it, so
    // "go on" / "keep going" / "carry on" pass and bare "go" / "next" / "more"
    // do not.
    if (tokens.length > 1 && CONTINUATION_PHRASAL.some((re) => re.test(token))) {
      strong++;
      continue;
    }
    if (!CONTINUATION_FILLER.has(token)) return false;
  }
  return strong > 0;
}

/** How far back to look for the request a continuation refers to. */
const CONTINUATION_LOOKBACK = 40;
/** Bound the injected original request — the Router's own budget is small. */
const CONTINUATION_SUBJECT_CHAR_CAP = 1200;
/**
 * A resolved subject at least this long counts as "real work in progress" on
 * its own, even with no tool activity in the window (e.g. a long analytical
 * request answered in prose).
 */
export const CONTINUATION_SUBJECT_MIN_CHARS = 80;

/**
 * Walk back to the last user message that actually stated a task — skipping
 * earlier continuations and the current message itself (the caller's `history`
 * may or may not already include it, and this must behave the same either way).
 * Returns "" when there is nothing to inherit.
 */
export function resolveContinuationSubject(
  userMessage: string,
  history: readonly ModelMessage[]
): string {
  const current = userMessage.trim();
  const window = history.slice(-CONTINUATION_LOOKBACK);
  for (let i = window.length - 1; i >= 0; i--) {
    const msg = window[i];
    if (msg.role !== "user") continue;
    const flat = flattenMessageContent(msg, CONTINUATION_SUBJECT_CHAR_CAP)
      .replace(/\s+/g, " ")
      .trim();
    if (!flat || flat === current) continue;
    if (isContinuationMessage(flat)) continue;
    return capHeadTail(flat, CONTINUATION_SUBJECT_CHAR_CAP);
  }
  return "";
}

/**
 * Evidence that a real task is in flight: any tool call or tool result in the
 * recent window. This is the deterministic half of the floor — a continuation
 * of tool-driven work is by definition a continuation of work.
 */
export function hasRecentTaskActivity(
  history: readonly ModelMessage[],
  windowSize: number
): boolean {
  for (const msg of history.slice(-windowSize)) {
    if (msg.role === "tool") return true;
    const content = msg.content as unknown;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part !== "object" || part === null) continue;
      const type = (part as Record<string, unknown>).type;
      if (type === "tool-call" || type === "tool-result") return true;
    }
  }
  return false;
}

// ── The goal record: a first-class statement of the work in flight (PM #131) ──
//
// Measured on a real 84-message chat: the last USER message sat 26 messages
// back, so the recency window NEVER contained the request the Router was being
// asked to judge, and 69% of what the window did carry was thrown away by the
// per-message cap. Meanwhile `data/goals/<chatId>.json` — written by the
// agent's own goal tools — states the task, its progress and the next pending
// step in 147 tokens, against 1055 for the truncated transcript.
//
// So the transcript is the FALLBACK and the goal is the primary signal. It is
// not a replacement: only a minority of chats have a goal tree, and a goal can
// be stale (an abandoned chat keeps `status: "active"`), which is why it is
// rendered as description, never as a claim about what is happening right now.

export interface RouterGoalContext {
  title: string;
  objective: string;
  /** First task still pending / in_progress — what a continuation refers to. */
  nextTask?: string;
  completed: number;
  total: number;
}

const GOAL_FIELD_CHAR_CAP = 600;

function capField(text: string): string {
  return capHeadTail(text.replace(/\s+/g, " ").trim(), GOAL_FIELD_CHAR_CAP);
}

/** Render the active goal for the Router prompt. "" when there is no goal. */
export function buildRouterGoalBlock(goal: RouterGoalContext | undefined): string {
  if (!goal) return "";
  return (
    `\n\nACTIVE GOAL (what this chat is working toward — the task any continuation refers to):\n` +
    `Title: ${capField(goal.title)}\n` +
    `Objective: ${capField(goal.objective)}\n` +
    `Progress: ${goal.completed}/${goal.total} tasks completed\n` +
    (goal.nextTask ? `Next unfinished task: ${capField(goal.nextTask)}\n` : "")
  );
}

/**
 * The subject a bare continuation inherits, taken from the goal. Prefers the
 * next unfinished task (that IS "продолжай"), falling back to the objective.
 */
export function goalContinuationSubject(goal: RouterGoalContext | undefined): string {
  if (!goal) return "";
  const next = goal.nextTask?.trim();
  if (next) return capField(next);
  const objective = goal.objective?.trim();
  return objective ? capField(objective) : "";
}

// ── The Router's recent-history block, bounded in TOKENS (PM #131) ──────────
//
// The old bound was "last 8 messages × 500 chars". Three things were wrong
// with it, all measured on a real 84-message chat:
//   - Wrong unit. The constraint is the Router's context window (clamped to
//     `MAX_RELIABLE_CONTEXT_WINDOW` = 120 000 tokens); the bound was in
//     characters, and this call has no other input bound at all — only
//     `maxOutputTokens`. The shipped block came to 1055 tokens, i.e. 0.9% of
//     the pessimistic window, while the cap discarded 69% of the content it
//     was given (tool results survived at 14% / 20% / 21%).
//   - Wrong axis. A fixed message count samples whatever the tail happens to
//     hold — on that chat, four tool round-trips and no user request at all.
//   - Wrong direction (see `capHeadTail`).
// A token budget spends the same money on more signal: small messages cost
// little and many fit, one huge tool dump is folded instead of crowding
// everything else out.

/** Whole-block budget. Generous — it is under 3% of the clamped window. */
const ROUTER_CONTEXT_TOKEN_BUDGET = 3000;
/** No single message may take more than this share of the block. */
const ROUTER_CONTEXT_PER_MESSAGE_TOKENS = 500;
/**
 * Hard ceiling on messages INSPECTED, not on messages kept. Bounds the BPE
 * work per turn; the token budget is what actually decides the depth.
 */
const ROUTER_CONTEXT_MAX_MESSAGES = 24;
/** Window used for the "is real work in flight?" evidence check. */
export const ROUTER_CONTEXT_MESSAGES = 8;

/** Token count of a plain string, through the same estimator the governor uses. */
function textTokens(text: string): number {
  return estimateTokenCount([{ role: "user", content: text }]);
}

/**
 * Shrink `text` until it fits `maxTokens`, keeping head AND tail. Chars are a
 * poor proxy for tokens (Cyrillic and serialized JSON both run far denser than
 * English prose), so the ratio is re-measured rather than assumed — three
 * passes converge comfortably and the loop is bounded either way.
 */
function capToTokens(text: string, maxTokens: number): string {
  let out = text;
  for (let pass = 0; pass < 3; pass++) {
    const tokens = textTokens(out);
    if (tokens <= maxTokens) return out;
    const targetChars = Math.max(16, Math.floor((out.length * maxTokens) / tokens * 0.95));
    out = capHeadTail(out, targetChars);
  }
  return out;
}

/**
 * Render the recent history for the Router with tool activity VISIBLE, newest
 * first while spending the budget, emitted oldest-first for reading.
 * Pure + exported: the emptiness of this block was the PM #129 mechanism, so
 * it is pinned by a test rather than trusted.
 */
export function buildRouterContextBlock(history: readonly ModelMessage[]): string {
  const lines: string[] = [];
  let spent = 0;
  for (const msg of history.slice(-ROUTER_CONTEXT_MAX_MESSAGES).reverse()) {
    if (spent >= ROUTER_CONTEXT_TOKEN_BUDGET) break;
    const flat = flattenMessageContent(msg, Number.MAX_SAFE_INTEGER)
      .replace(/\s+/g, " ")
      .trim();
    if (!flat) continue;
    // Three things keep this inside the budget. A cross-model review found the
    // overrun (measured 3016 against 3000) and named the prefix; mutation
    // testing then showed which of the three actually does the work — recorded
    // here so nobody "simplifies" the load-bearing one:
    //
    //   1. The join separators — LOAD-BEARING, proven. `spent` sums PER-LINE
    //      estimates while the finished block is measured as ONE string, so the
    //      "\n" between lines is billed to nobody. Removing this `+1` makes the
    //      budget test go red on its own.
    //   2. Charging the role prefix against the per-message share, and
    //      3. re-measuring the FINISHED line before accepting it (BPE does not
    //      add across a concatenation boundary, and `capToTokens` exits a
    //      bounded loop that may sit marginally over).
    //
    // (2) and (3) are defence-in-depth: mutating either one out leaves the
    // suite green, so they are unfalsified belief, not demonstrated necessity.
    // They are cheap and they fail in the safe direction, so they stay — but
    // do not cite them as the reason the bound holds.
    //
    // The one deliberate exception is a FIRST line that alone exceeds the
    // budget: a truncated message beats an empty context block, which is the
    // PM #129 failure this whole module exists to fix.
    const prefix = `[${msg.role.toUpperCase()}]: `;
    const perMessage = Math.min(
      ROUTER_CONTEXT_PER_MESSAGE_TOKENS,
      ROUTER_CONTEXT_TOKEN_BUDGET - spent
    ) - textTokens(prefix);
    if (perMessage <= 0) break;
    const line = prefix + capToTokens(flat, perMessage);
    const lineTokens = textTokens(line) + (lines.length > 0 ? 1 : 0);
    if (lines.length > 0 && spent + lineTokens > ROUTER_CONTEXT_TOKEN_BUDGET) break;
    spent += lineTokens;
    lines.push(line);
  }
  return lines.reverse().join("\n");
}
