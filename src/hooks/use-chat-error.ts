"use client";

/**
 * Subscribe a chat panel to structured chat-error events from the SSE bus.
 *
 * Closes the loop opened in Sprint 3 (PM #17 backend): the agent now publishes
 * `chat-error` events with `{traceId, kind, message, hint, recoverable}` when
 * a turn fails after MoA. Previously the user saw an empty pane. This hook
 * exposes the latest error so a banner can render it.
 *
 * Design split:
 *   - `pickChatErrorFromEvent` is a pure function — testable in node-only
 *     vitest without any React DOM testing infrastructure. It contains the
 *     ENTIRE event-filter logic so the React wrapper has nothing of substance
 *     left to break.
 *   - `useChatError` is a 10-line hook that pipes useUiSyncEvents through the
 *     pure picker and stores the last error in component state. Auto-dismiss
 *     hooks (e.g. when the user sends a new turn) live in the consumer, not
 *     here — keeping responsibility narrow.
 */
import { useState, useCallback } from "react";
import { useUiSyncEvents } from "@/hooks/use-background-sync";
import type { ChatErrorPayload, UiSyncEvent } from "@/lib/realtime/types";

/**
 * Returns the structured error payload from an event if it (a) belongs to
 * the given chat, and (b) carries a `chatError` payload. Returns null
 * otherwise — including for chat events without an error and for events
 * scoped to a different chat.
 *
 * Pure function — no AsyncLocalStorage, no React state, no I/O. The whole
 * decision logic of the chat-error path lives here so tests can pin it
 * down without an RTL stack.
 */
export function pickChatErrorFromEvent(
  event: UiSyncEvent,
  chatId: string | null | undefined
): ChatErrorPayload | null {
  if (!event.chatError) return null;
  // Defense in depth: backend currently only emits these on `topic: "chat"`,
  // but a future caller might forget the topic. The chatError payload is
  // the contract, the topic is a hint.
  if (event.topic !== "chat") return null;
  // Filter by chatId so two open tabs on different chats don't cross-render
  // each other's errors. A null chatId on the event matches any active
  // chat — keeps backwards-compat with handlers that didn't fan out by chat.
  if (chatId && event.chatId && event.chatId !== chatId) return null;
  return event.chatError;
}

export interface UseChatErrorResult {
  /** Most-recent unhandled chat error for this chat, or `null`. */
  error: ChatErrorPayload | null;
  /** Clear the banner (user dismissed, or new turn started). */
  dismiss: () => void;
}

/**
 * Subscribe the current chat panel to structured chat-error events.
 *
 * Pass the current `chatId` (the user's actively-rendered chat). When the
 * agent publishes a `chatError` event for this chat, the hook returns the
 * payload. Call `dismiss()` to clear it — typically on user action or
 * before a new turn is sent (so a stale error doesn't outlive its turn).
 */
export function useChatError(chatId: string | null | undefined): UseChatErrorResult {
  const [error, setError] = useState<ChatErrorPayload | null>(null);

  useUiSyncEvents(
    { topics: ["chat"], chatId: chatId ?? undefined },
    (event) => {
      const picked = pickChatErrorFromEvent(event, chatId);
      if (picked) setError(picked);
    }
  );

  const dismiss = useCallback(() => setError(null), []);
  return { error, dismiss };
}
