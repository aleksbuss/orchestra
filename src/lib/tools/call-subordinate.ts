import type { ModelMessage } from "ai";
import {
  ChatBudgetExceededError,
  enforceChatBudget,
} from "@/lib/cost/budget-guard";

const MAX_SUBORDINATE_CONCURRENCY = 2;
const SUBORDINATE_RETRY_DELAYS_MS = [1000, 2500] as const;

/**
 * Sprint 8 follow-up — slot state extracted into an injectable shape so
 * unit tests can supply their own SemaphoreState and verify the
 * concurrency cap deterministically.
 *
 * Pre-Sprint-8 the slot was module-level globals (`activeSubordinateCalls`
 * + `subordinateWaitQueue`). That made the cap untestable from
 * `call-subordinate.test.ts` — the concurrency test had to operate on
 * the shared state, and flakes followed (other tests in the same file
 * could leak slot accounting in). The fix was deletion of the test +
 * a documented gap; THIS file closes the gap properly.
 *
 * Production callers use the module-level `defaultSlotState` and never
 * pass `slotState`. Tests construct their own via `createSlotState()`.
 */
export interface SubordinateSlotState {
  /** Set to the configured maximum at construction. */
  readonly maxConcurrency: number;
  /** Number of slots currently held by active subordinate calls. */
  activeCount: number;
  /** Waiters parked here when activeCount === maxConcurrency. */
  readonly waitQueue: Array<() => void>;
}

export function createSlotState(
  maxConcurrency: number = MAX_SUBORDINATE_CONCURRENCY
): SubordinateSlotState {
  return {
    maxConcurrency,
    activeCount: 0,
    waitQueue: [],
  };
}

const defaultSlotState = createSlotState();

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function getStatusCode(error: unknown): number | null {
  const queue = [error];
  const visited = new Set<unknown>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) {
      continue;
    }
    visited.add(current);

    const record = asRecord(current);
    if (!record) {
      continue;
    }

    const rawStatus = record.statusCode ?? record.status ?? record.status_code;
    if (typeof rawStatus === "number" && Number.isFinite(rawStatus)) {
      return rawStatus;
    }
    if (typeof rawStatus === "string") {
      const parsed = Number.parseInt(rawStatus, 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }

    if (record.cause) {
      queue.push(record.cause);
    }
    if (record.responseBody) {
      queue.push(record.responseBody);
    }
    if (record.data) {
      queue.push(record.data);
    }
    if (record.error) {
      queue.push(record.error);
    }
  }

  return null;
}

function getErrorCode(error: unknown): string | null {
  const queue = [error];
  const visited = new Set<unknown>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) {
      continue;
    }
    visited.add(current);

    const record = asRecord(current);
    if (!record) {
      continue;
    }

    const rawCode = record.code ?? record.type;
    if (typeof rawCode === "string" && rawCode.trim()) {
      return rawCode.trim();
    }

    if (record.cause) {
      queue.push(record.cause);
    }
    if (record.responseBody) {
      queue.push(record.responseBody);
    }
    if (record.data) {
      queue.push(record.data);
    }
    if (record.error) {
      queue.push(record.error);
    }
  }

  return null;
}

function getErrorDetail(error: unknown): string | null {
  const queue = [error];
  const visited = new Set<unknown>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) {
      continue;
    }
    visited.add(current);

    if (typeof current === "string" && current.trim()) {
      const detail = current.trim().replace(/\s+/g, " ");
      return detail.length > 280 ? `${detail.slice(0, 280)}...` : detail;
    }

    const record = asRecord(current);
    if (!record) {
      continue;
    }

    const rawMessage = record.message;
    if (typeof rawMessage === "string" && rawMessage.trim()) {
      const detail = rawMessage.trim().replace(/\s+/g, " ");
      return detail.length > 280 ? `${detail.slice(0, 280)}...` : detail;
    }

    if (record.cause) {
      queue.push(record.cause);
    }
    if (record.responseBody) {
      queue.push(record.responseBody);
    }
    if (record.data) {
      queue.push(record.data);
    }
    if (record.error) {
      queue.push(record.error);
    }
  }

  return null;
}

function isRetriableProviderError(error: unknown): boolean {
  const statusCode = getStatusCode(error);
  if (statusCode !== null) {
    return statusCode === 408 || statusCode === 409 || statusCode === 429 || statusCode >= 500;
  }

  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (!message) {
    return false;
  }

  return (
    message.includes("provider returned error") ||
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("temporarily unavailable") ||
    message.includes("overloaded") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("econnreset")
  );
}

function formatSubordinateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const statusCode = getStatusCode(error);
  const code = getErrorCode(error);
  const detail = getErrorDetail(error);

  const details: string[] = [];
  if (statusCode !== null) {
    details.push(`status=${statusCode}`);
  }
  if (code) {
    details.push(`code=${code}`);
  }

  const base = details.length > 0 ? `${message} (${details.join(", ")})` : message;
  if (!detail || detail === message) {
    return base;
  }
  return `${base}: ${detail}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireSubordinateSlot(
  state: SubordinateSlotState
): Promise<void> {
  if (state.activeCount < state.maxConcurrency) {
    state.activeCount += 1;
    return;
  }

  await new Promise<void>((resolve) => {
    state.waitQueue.push(() => resolve());
  });
}

function releaseSubordinateSlot(state: SubordinateSlotState): void {
  const next = state.waitQueue.shift();
  if (next) {
    next();
    return;
  }

  state.activeCount = Math.max(0, state.activeCount - 1);
}

export async function withSubordinateSlot<T>(
  fn: () => Promise<T>,
  state: SubordinateSlotState = defaultSlotState
): Promise<T> {
  await acquireSubordinateSlot(state);
  try {
    return await fn();
  } finally {
    releaseSubordinateSlot(state);
  }
}

async function runSubordinateWithRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt <= SUBORDINATE_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isLastAttempt = attempt === SUBORDINATE_RETRY_DELAYS_MS.length;
      if (isLastAttempt || !isRetriableProviderError(error)) {
        throw error;
      }
      const delay = SUBORDINATE_RETRY_DELAYS_MS[attempt] ?? 1000;
      await sleep(delay + Math.floor(Math.random() * 400));
    }
  }

  throw new Error("Subordinate retry loop exited unexpectedly");
}

/**
 * Delegate a task to a subordinate agent.
 *
 * Sprint 7 security follow-up — the `chatId` parameter was added to plumb
 * the parent's chat through so we can enforce the per-chat USD cap BEFORE
 * spinning up a subordinate. Pre-fix, a single parent turn could invoke
 * `call_subordinate` repeatedly, each invocation spending unbounded LLM
 * tokens against the chat's cap. With this gate, an over-cap chat refuses
 * to launch additional subordinates and surfaces the cap message as a
 * tool-error (caught by the loop-guard so the agent reports it).
 *
 * Sprint 8 update — subordinate token spend IS bubbled back to the parent
 * chat's `cumulativeUsage` via `addUsageToCumulative`. Pre-Sprint-8 the
 * `generateText.usage` returned by `runSubordinateAgent` was thrown away,
 * which meant the per-chat USD cap was BLIND to subordinate spend: a
 * chat at $0.50/$1 cap could invoke an expensive subordinate that
 * burned $5 in tokens, and the cap would never notice until the next
 * parent turn (which already had its own `enforceChatBudget` gate but
 * couldn't reach back in time). Now: usage accumulates immediately
 * after the subordinate returns, so the NEXT subordinate call in the
 * same turn (or the next parent turn) sees the real cumulative.
 *
 * Accumulation runs via `updateChat` with the same provider/model
 * identity the subordinate's `generateText` actually used (returned in
 * the SubordinateResult shape) — different providers price tokens
 * differently, so we can't just guess from `settings.chatModel`.
 */
export async function callSubordinate(
  task: string,
  projectId: string | undefined,
  parentAgentNumber: number,
  parentHistory: ModelMessage[],
  abortSignal?: AbortSignal,
  parentChatId?: string
): Promise<string> {
  try {
    // Budget gate first — cheap, no LLM call, fails fast on over-cap chats.
    if (parentChatId) {
      try {
        await enforceChatBudget(parentChatId);
      } catch (err) {
        if (err instanceof ChatBudgetExceededError) {
          return `Subordinate agent refused: ${err.message}`;
        }
        throw err;
      }
    }

    // Dynamic import to avoid circular dependency
    const { runSubordinateAgent } = await import("@/lib/agent/agent");

    const result = await withSubordinateSlot(() =>
      runSubordinateWithRetry(() =>
        runSubordinateAgent({
          task,
          projectId,
          parentAgentNumber,
          parentHistory,
          abortSignal,
          // Sprint 9 — propagate the real parent chat id all the way
          // down. Without this, the subordinate's `context.chatId`
          // gets the synthetic `subordinate-${Date.now()}` fallback,
          // and if the subordinate itself invokes `call_subordinate`
          // (allowed until agentNumber >= 3), the recursive level
          // bypasses budget enforcement AND spend bubble-up — both
          // would target a phantom chat.
          parentChatId,
        })
      )
    );

    // Sprint 8 — bubble subordinate token spend back into the parent's
    // cumulativeUsage. The accumulator + chat-store imports are dynamic
    // for the same reason as the agent import above (circular-dep avoidance).
    // Best-effort: a failure here doesn't fail the tool, just logs.
    if (parentChatId && result.usage) {
      try {
        const [{ updateChat }, { addUsageToCumulative }] = await Promise.all([
          import("@/lib/storage/chat-store"),
          import("@/lib/cost/accumulator"),
        ]);
        await updateChat(parentChatId, (chat) => {
          chat.cumulativeUsage = addUsageToCumulative(
            chat.cumulativeUsage,
            result.provider,
            result.model,
            result.usage
          );
          return chat;
        });
      } catch (accErr) {
        console.warn(
          "[callSubordinate] Failed to accumulate subordinate usage to parent:",
          accErr instanceof Error ? accErr.message : String(accErr)
        );
      }
    }

    return `Subordinate Agent ${parentAgentNumber + 1} completed the task:\n\n${result.text}`;
  } catch (error) {
    return `Subordinate agent error: ${formatSubordinateError(error)}`;
  }
}
