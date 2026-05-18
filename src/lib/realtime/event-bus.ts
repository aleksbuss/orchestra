import type {
  ChatErrorPayload,
  UiSyncEvent,
  UiSyncTopic,
} from "@/lib/realtime/types";

type UiSyncListener = (event: UiSyncEvent) => void;

// Cap the listener map to prevent memory leaks when browser tabs crash without
// triggering graceful SSE cleanup. Oldest listeners are evicted first.
const MAX_LISTENERS = 1000;

interface UiSyncBusState {
  nextListenerId: number;
  nextEventId: number;
  listeners: Map<number, UiSyncListener>;
}
const BUS_KEY = "__ORCHESTRA_UI_SYNC_BUS_STATE__";

function getBusState(): UiSyncBusState {
  const globalWithBus = globalThis as typeof globalThis & {
    [BUS_KEY]?: UiSyncBusState;
  };

  if (!globalWithBus[BUS_KEY]) {
    globalWithBus[BUS_KEY] = {
      nextListenerId: 1,
      nextEventId: 1,
      listeners: new Map<number, UiSyncListener>(),
    };
  }

  return globalWithBus[BUS_KEY];
}

export function publishUiSyncEvent(input: {
  topic: UiSyncTopic;
  projectId?: string | null;
  chatId?: string;
  reason?: string;
  parentId?: string;
  nodeType?: "agent_node" | "tool_node" | "system_node";
  swarmNode?: import("@/lib/realtime/types").SwarmNodeData;
  chatError?: ChatErrorPayload;
}): UiSyncEvent {
  const state = getBusState();
  // Safe integer rollover — prevents precision loss after 2^53 events
  state.nextEventId = (state.nextEventId % Number.MAX_SAFE_INTEGER) + 1;
  const event: UiSyncEvent = {
    id: state.nextEventId,
    topic: input.topic,
    at: new Date().toISOString(),
    projectId: input.projectId,
    chatId: input.chatId,
    reason: input.reason,
    parentId: input.parentId,
    nodeType: input.nodeType,
    swarmNode: input.swarmNode,
    chatError: input.chatError,
  };

  for (const listener of state.listeners.values()) {
    try {
      listener(event);
    } catch {
      // Keep bus resilient to listener failures.
    }
  }

  return event;
}

/**
 * Sprint 3 / PM #17 follow-up: surface a server-side error to the UI as a
 * structured event so the user sees something actionable instead of a
 * blank chat pane. Wraps `publishUiSyncEvent` so callers don't have to
 * remember the conventional shape (topic: "chat", chatError: {...}).
 *
 * Use this in EVERY catch block that absorbs an exception thrown after
 * the chat turn has been accepted — i.e., where returning a 500 is too
 * late because the SSE stream has already been promoted to the client.
 */
export function publishChatErrorEvent(input: {
  chatId: string;
  projectId?: string | null;
  payload: ChatErrorPayload;
}): UiSyncEvent {
  return publishUiSyncEvent({
    topic: "chat",
    chatId: input.chatId,
    projectId: input.projectId ?? null,
    reason: `[Error] ${input.payload.message}`,
    chatError: input.payload,
  });
}

export function subscribeUiSyncEvents(
  listener: UiSyncListener
): () => void {
  const state = getBusState();
  // Evict oldest listener if cap is reached (prevents memory leak from crashed tabs)
  if (state.listeners.size >= MAX_LISTENERS) {
    const oldestId = state.listeners.keys().next().value;
    if (oldestId !== undefined) {
      state.listeners.delete(oldestId);
      console.warn(`[EventBus] Listener cap (${MAX_LISTENERS}) reached. Evicted oldest listener #${oldestId}.`);
    }
  }
  const id = state.nextListenerId++;
  state.listeners.set(id, listener);
  return () => {
    state.listeners.delete(id);
  };
}
