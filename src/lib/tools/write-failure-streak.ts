import path from "path";

/**
 * Per-file consecutive-syntax-failure STREAK breaker — the failure-keyed
 * cross-turn loop backstop for BOTH write tools (PM #80 follow-up; PM #83).
 *
 * PM #80 gave `write_text_file` two things: a post-write SYNTAX-grounding signal
 * (`verifyWrittenSource` → `syntaxValid`) and a chat-scoped raw-COUNT rewrite
 * budget (`write-rewrite-budget.ts`). `replace_in_file` got the grounding signal
 * but NOT the count budget — a prior doubt-driven review REJECTED extending the
 * count budget there: WARN 6 / BLOCK 10 never fires inside a ~6-edit loop, and a
 * raw count false-positives the legitimate iterative editing CLAUDE.md actively
 * encourages.
 *
 * This is the missing piece, keyed on the FAILURE SIGNAL rather than raw count.
 * It counts CONSECUTIVE writes whose post-write syntax check came back invalid
 * (`syntaxValid === false`) for one file within one chat. A single VALID write
 * resets the streak to zero — so legitimate iterative editing, and a
 * transient-invalid refactor that converges, never trip it; only a model that
 * writes broken syntax to the same file over and over does. At the threshold the
 * NEXT write to that file is refused ONCE (a recurring speed bump, not a wall)
 * with a directive to read / verify / ask instead of blindly rewriting, then the
 * streak resets into the band (THRESHOLD - 1) so a genuine fix keeps a one-write
 * runway while a true loop climbs back and re-trips immediately.
 *
 * Threshold 4 sits inside the 3–5 industry band for agent retry/loop-break
 * limits (Aider/Cline-style consecutive-failure circuit breakers default to ~3);
 * 4 is the lenient end, consistent with PM #80's "a false-positive block is
 * worse than a missed loop" stance, and still catches the observed ~6-edit
 * mangle loop well before it burns the per-turn step cap.
 *
 * SCOPE (intentional, documented): the streak only MOVES when the post-write
 * check produced a boolean — i.e. ts/tsx/js/jsx/json under `MAX_VERIFY_CHARS`.
 * For non-source extensions, oversized content, or a checker error
 * (`verifyWrittenSource` → null → `syntaxValid` ABSENT) the streak is left
 * UNCHANGED, so it never false-blocks a `.md`/`.csv`/etc. write. It also does
 * NOT catch an alternating valid→invalid loop (reset-on-valid by design). It
 * targets the OBSERVED consecutive-mangle loop, not every conceivable loop.
 *
 * State is in-memory, per-process (chatId → normalized path → streak),
 * evaporating on restart like the daemon's `autoPilotIterations` and the rewrite
 * budget. A FIFO cap bounds tracked chats. (Same-module-graph state read+written
 * only on the agent tool path — the PM #71 `globalThis` rule does not apply.)
 */

/** Consecutive invalid writes to one file that trip the breaker. */
const STREAK_BLOCK_THRESHOLD = 4;
/** FIFO bound on the number of chats tracked in memory. */
const MAX_TRACKED_CHATS = 500;

export type SyntaxStreakAction = "allow" | "block";

export interface SyntaxStreakDecision {
  /** Consecutive-failure streak for this (chat, file) at decision time. */
  streak: number;
  action: SyntaxStreakAction;
  /** Refusal directive for the model. Present only when blocked. */
  message?: string;
}

// chatId -> (normalized path -> consecutive syntaxValid:false count).
// Insertion order = FIFO age, used by the prune.
const failuresByChat = new Map<string, Map<string, number>>();

function pruneTrackedChats(): void {
  while (failuresByChat.size > MAX_TRACKED_CHATS) {
    const oldest = failuresByChat.keys().next().value;
    if (oldest === undefined) break;
    failuresByChat.delete(oldest);
  }
}

/**
 * PRE-WRITE decision. Returns `block` — and the caller MUST NOT execute its
 * write — when this file has already failed its syntax check
 * `STREAK_BLOCK_THRESHOLD` times in a row this chat. On block it drops the
 * stored streak to `THRESHOLD - 1`, guaranteeing exactly one subsequent write of
 * runway (which, if valid, resets to 0). `allow` otherwise, with NO mutation.
 * No-op `allow` when `chatId` is missing — tracking is best-effort.
 */
export function checkSyntaxFailureStreak(
  chatId: string | undefined,
  filePath: string
): SyntaxStreakDecision {
  if (!chatId) return { streak: 0, action: "allow" };

  const perPath = failuresByChat.get(chatId);
  const key = path.normalize(filePath);
  const streak = perPath?.get(key) ?? 0;

  if (streak >= STREAK_BLOCK_THRESHOLD && perPath) {
    // Speed bump, not a wall: drop back into the band so a real fix can land,
    // but a continued loop climbs back and re-trips after one more failure.
    perPath.set(key, STREAK_BLOCK_THRESHOLD - 1);
    return {
      streak,
      action: "block",
      message:
        `[Syntax loop] You have written invalid syntax to "${path.basename(key)}" ${streak} times in a row in this chat — ` +
        `this write was NOT executed. Stop rewriting this file. Do ONE of: ` +
        `(a) read_text_file the CURRENT content and fix ONLY the broken syntax at the reported line:col positions; ` +
        `(b) run a typecheck / the file (code_execution) to see the real error before editing again; or ` +
        `(c) report the blocker to the user and ask how to proceed. ` +
        `Rewriting the whole file again will keep producing the same broken output.`,
    };
  }

  return { streak, action: "allow" };
}

/**
 * POST-WRITE outcome. Call AFTER a successful write with the syntax verdict:
 * `false` → increment the streak; `true` → reset to 0; `undefined` (no signal:
 * non-source / empty / oversized / checker error) → leave UNCHANGED. No-op when
 * `chatId` is missing.
 */
export function recordSyntaxOutcome(
  chatId: string | undefined,
  filePath: string,
  syntaxValid: boolean | undefined
): void {
  if (!chatId || syntaxValid === undefined) return;

  const key = path.normalize(filePath);

  if (syntaxValid === true) {
    // Streak broken by a valid write; drop the entry to keep the map lean.
    failuresByChat.get(chatId)?.delete(key);
    return;
  }

  // syntaxValid === false → extend the streak.
  let perPath = failuresByChat.get(chatId);
  if (!perPath) {
    perPath = new Map();
    failuresByChat.set(chatId, perPath);
    pruneTrackedChats();
  }
  perPath.set(key, (perPath.get(key) ?? 0) + 1);
}

/** Clear tracked state — one chat, or all when no id is given. For tests. */
export function resetSyntaxFailureStreak(chatId?: string): void {
  if (chatId) failuresByChat.delete(chatId);
  else failuresByChat.clear();
}
