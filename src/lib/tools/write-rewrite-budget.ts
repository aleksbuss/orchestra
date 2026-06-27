import path from "path";

/**
 * Chat-scoped per-file rewrite budget — the cross-turn loop backstop (PM #80 follow-up).
 *
 * The per-turn loop guard (`tool-guard.ts`) builds its state in a fresh closure
 * every `runAgent` turn, so it CANNOT see a model that rewrites the SAME file
 * across many turns — the dominant real-world loop, where each turn is stitched
 * by a human pressing "continue" (or by auto-continuation). PM #80's grounding
 * signal makes a capable model CONVERGE in a couple of writes, but if it doesn't
 * (weak model, unfixable corruption, pathological churn) nothing bounded the
 * cross-turn rewrite loop. This caps how many times one file may be (re)written
 * within a single chat.
 *
 * The block is a recurring SPEED BUMP, not a permanent wall: on hitting the cap
 * it refuses ONE write (forcing the model to read / verify / ask instead of
 * blindly rewriting) and resets the counter into the warn band, so a genuine
 * targeted fix still has a short runway to land — but a true loop keeps getting
 * interrupted, bounding the waste.
 *
 * State is in-memory and per-process (chatId → path → count). Like the daemon's
 * `autoPilotIterations`, it intentionally evaporates on restart — a fresh
 * process starts every chat from a clean budget. A FIFO cap on tracked chats
 * keeps it from growing unbounded. (This is same-module-graph state read and
 * written entirely on the agent tool path, NOT boot-warmed/route-read, so the
 * PM #71 `globalThis` requirement does not apply.)
 */

/** Soft nudge — the write still happens, but the result carries a warning. */
const REWRITE_WARN_THRESHOLD = 6;
/** Hard stop — the write is refused; counter resets into the warn band afterward. */
const REWRITE_BLOCK_THRESHOLD = 10;
/** FIFO bound on the number of chats tracked in memory. */
const MAX_TRACKED_CHATS = 500;

export type RewriteBudgetAction = "allow" | "warn" | "block";

export interface RewriteBudgetResult {
  /** The write count for this (chat, file) AT the moment of the decision. */
  count: number;
  action: RewriteBudgetAction;
  /** Advisory (warn) or refusal (block) text for the model. Absent when allowed. */
  message?: string;
}

// chatId -> (normalized path -> write count). Module-level so it survives ACROSS
// turns within a process (the per-turn guard cannot). Insertion order = FIFO age.
const writesByChat = new Map<string, Map<string, number>>();

function pruneTrackedChats(): void {
  while (writesByChat.size > MAX_TRACKED_CHATS) {
    const oldest = writesByChat.keys().next().value;
    if (oldest === undefined) break;
    writesByChat.delete(oldest);
  }
}

/**
 * Record a write to `filePath` within `chatId` and decide allow / warn / block.
 * No-op (`allow`, count 0) when `chatId` is missing — tracking is best-effort.
 */
export function recordFileWrite(
  chatId: string | undefined,
  filePath: string
): RewriteBudgetResult {
  if (!chatId) {
    return { count: 0, action: "allow" };
  }

  const key = path.normalize(filePath);
  let perPath = writesByChat.get(chatId);
  if (!perPath) {
    perPath = new Map();
    writesByChat.set(chatId, perPath);
    pruneTrackedChats();
  }

  const count = (perPath.get(key) ?? 0) + 1;

  if (count >= REWRITE_BLOCK_THRESHOLD) {
    // Refuse this write and reset into the warn band so a genuine fix still has
    // a runway; a real loop will climb back to the cap and be interrupted again.
    perPath.set(key, REWRITE_WARN_THRESHOLD - 1);
    return {
      count,
      action: "block",
      message:
        `[Rewrite budget] You have written "${path.basename(key)}" ${count} times in this chat — ` +
        `this is a rewrite loop, and this write was NOT executed. ` +
        `Stop rewriting the whole file. Do ONE of: ` +
        `(a) read_text_file the CURRENT content and make a SINGLE minimal targeted edit; ` +
        `(b) run the file (code_execution / a typecheck) to see the real error before editing again; or ` +
        `(c) report the blocker to the user and ask how to proceed. ` +
        `Repeating the full rewrite will keep failing.`,
    };
  }

  perPath.set(key, count);

  if (count >= REWRITE_WARN_THRESHOLD) {
    return {
      count,
      action: "warn",
      message:
        `[Rewrite budget] You have now written "${path.basename(key)}" ${count} times in this chat. ` +
        `If you are looping, STOP rewriting the whole file — read it, make one minimal fix, or verify with a typecheck. ` +
        `If you are genuinely making progress, continue.`,
    };
  }

  return { count, action: "allow" };
}

/**
 * PM #81 Sprint 3 — soft nudge toward `replace_in_file` when OVERWRITING a large
 * EXISTING file. A big full regeneration is exactly what provokes format
 * degradation (the model has to re-emit hundreds of lines through the JSON
 * tool-call encoder — PM #80's corruption + PM #81's printed-markup both worsen
 * with output size). This is ADVISORY only (the write still proceeds — a
 * deliberate full rewrite is legitimate), NOT a fail-fast block: Gemini's
 * proposed hard "refuse to overwrite a >250-line file" would break legitimate
 * whole-file regeneration and duplicates what the rewrite-budget + syntax
 * grounding already bound. Returns the hint string when the existing file is at
 * or above the byte threshold, else null.
 */
export const LARGE_EXISTING_FILE_REWRITE_BYTES = 12_000;

export function largeFileRewriteHint(
  existed: boolean,
  existingBytes: number
): string | null {
  if (!existed || existingBytes < LARGE_EXISTING_FILE_REWRITE_BYTES) return null;
  return (
    `This existing file is large (~${Math.round(existingBytes / 1000)} KB). For a TARGETED change, ` +
    `prefer replace_in_file — regenerating the whole file risks truncation and format degradation ` +
    `on big outputs. A full rewrite is fine ONLY if you intend to replace the entire file.`
  );
}

/** Clear tracked state — one chat, or all when no id is given. For tests/maintenance. */
export function resetRewriteBudget(chatId?: string): void {
  if (chatId) {
    writesByChat.delete(chatId);
  } else {
    writesByChat.clear();
  }
}
