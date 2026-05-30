/**
 * Per-chat USD budget enforcement entry-point.
 *
 * Sprint 2 introduced `assertChatBudget(usage, cap)` in `accumulator.ts`
 * but wired it ONLY into `/api/chat/route.ts`. The security review of
 * Sprint 1-7 (commit `1ef80d3` follow-up) found that **every other path
 * that reaches `runAgent`/`runAgentText`/`runSubordinateAgent` bypassed
 * the cap**:
 *
 *   - `src/lib/external/handle-external-message.ts` (Telegram webhook)
 *   - `src/lib/cron/service.ts` (scheduled runs)
 *   - `src/lib/tools/call-subordinate.ts` → `runSubordinateAgent`
 *   - `src/lib/agent/daemon.ts` auto-pilot re-dispatch
 *
 * Each is a CRITICAL billing-leak path: an unbounded loop of LLM calls
 * on the operator's API key, with no signal until the bill arrives.
 *
 * This helper centralises the check so every entry-point applies the
 * SAME contract. Callers wrap in try/catch — the action on
 * `ChatBudgetExceededError` is context-dependent:
 *
 *   - `/api/chat/route.ts` returns 402.
 *   - cron + external relay write a failure status + skip the run.
 *   - call_subordinate returns a tool-error string (caught by the
 *     loop-guard so the agent self-heals or reports to the user).
 *   - auto-pilot daemon aborts the iteration.
 *
 * The settings read uses a dynamic import so this file stays
 * dep-light (avoids the cost layer pulling in the full settings-store
 * cycle at module-import time).
 */

import type { Chat } from "@/lib/types";
import { assertChatBudget, ChatBudgetExceededError } from "./accumulator";

export { ChatBudgetExceededError };

/**
 * Throw `ChatBudgetExceededError` if `chatId`'s cumulative spend has
 * reached the configured cap. No-op when no cap is configured.
 *
 * Returns early without throwing when:
 *   - `settings.costGuard.maxUsdPerChat` is missing / non-positive
 *   - `chatId` is empty (defensive — callers should always supply one)
 *   - settings or chat read fails (caller falls through; the soft
 *     banner from PM #36 is the runtime safety net)
 *
 * Throws `ChatBudgetExceededError` when:
 *   - cap is positive AND `chat.cumulativeUsage.costUsd >= cap`
 *
 * Settings-read failures are LOGGED via `console.warn` here (we can't
 * pull in the `log` helper without a deeper import — every entry-point
 * already has its own logger context).
 */
export async function enforceChatBudget(chatId: string): Promise<void> {
  if (!chatId) return;
  let settings;
  let chat: Chat | null;
  try {
    // Dynamic imports keep this file's import graph independent of the
    // settings + chat-store modules (which install their own SIGTERM
    // handlers + read the filesystem at module load).
    const { getSettings } = await import("@/lib/storage/settings-store");
    settings = await getSettings();
  } catch (err) {
    console.warn(
      "[budget-guard] Could not read settings; budget check skipped:",
      err instanceof Error ? err.message : String(err)
    );
    return;
  }

  const cap = settings.costGuard?.maxUsdPerChat;
  if (typeof cap !== "number" || !Number.isFinite(cap) || cap <= 0) {
    return;
  }

  try {
    const { getChat } = await import("@/lib/storage/chat-store");
    chat = await getChat(chatId);
  } catch (err) {
    console.warn(
      "[budget-guard] Could not read chat for budget check; skipped:",
      err instanceof Error ? err.message : String(err)
    );
    return;
  }

  assertChatBudget(chat?.cumulativeUsage, cap);
}
