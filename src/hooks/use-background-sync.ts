"use client";

import { useEffect, useRef, useState } from "react";
import type { UiSyncEvent, UiSyncTopic } from "@/lib/realtime/types";

export interface BackgroundSyncOptions {
  topics?: UiSyncTopic[];
  projectId?: string | null;
  chatId?: string | null;
}

export type UiSyncScope = Pick<BackgroundSyncOptions, "topics" | "projectId" | "chatId">;

type SyncSubscriber = (event: UiSyncEvent) => void;

let sharedEventSource: EventSource | null = null;
let sharedSyncListener: ((event: MessageEvent<string>) => void) | null = null;
let nextSubscriberId = 1;
const syncSubscribers = new Map<number, SyncSubscriber>();
let disconnectTimeout: ReturnType<typeof setTimeout> | null = null;
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;
/**
 * Stop the auto-retry loop after this many failures so we don't pin the
 * browser indefinitely on a stalled upstream (e.g., auth secret rotated and
 * every connection 401s). Recovery path: visibilitychange/focus reset the
 * counter — the user re-engaging with the tab is the right signal that
 * "something might have changed, try again." 30 × 15 s ≈ 7 minutes of
 * polite retries before yielding.
 */
const MAX_RECONNECT_ATTEMPTS = 30;

/**
 * Marker reason for the synthetic resync event. The actual discriminator
 * is the WeakSet membership (see `syntheticEvents`); this string is
 * informational only — useful when inspecting the event in DevTools.
 */
const RESYNC_REASON = "reconnect-resync";

/**
 * Discriminator for synthetic events. We use a WeakSet of object references
 * rather than a sentinel field on `UiSyncEvent` because the type is shared
 * with the server contract (see `lib/realtime/types.ts`) — a magic field
 * like `id === -1` is fragile (any future server change emitting negative
 * ids would silently collide), and a bool field on the type would leak
 * frontend-internal state into the wire format. WeakSet keeps the marker
 * purely client-side: only events constructed by `broadcastResync` are in
 * it, and they get GC'd along with the event object.
 */
const syntheticEvents = new WeakSet<UiSyncEvent>();

function isResyncEvent(event: UiSyncEvent): boolean {
  return syntheticEvents.has(event);
}

function broadcastResync(): void {
  // Synthetic event delivered after every connect/reconnect so subscribers
  // (and through them, components like chat-panel that rebuild from
  // /api/chat/history on syncTick changes) reconcile against the canonical
  // on-disk store. The bus is fire-and-forget — without this, any sync
  // events emitted while we were disconnected are lost forever (PM #5).
  const event: UiSyncEvent = {
    id: -1,
    topic: "global",
    at: new Date().toISOString(),
    reason: RESYNC_REASON,
  };
  syntheticEvents.add(event);
  for (const subscriber of syncSubscribers.values()) {
    try {
      subscriber(event);
    } catch {
      // Keep fan-out resilient to individual listener failures.
    }
  }
}

function teardownEventSource(): void {
  if (sharedEventSource && sharedSyncListener) {
    sharedEventSource.removeEventListener(
      "sync",
      sharedSyncListener as EventListener
    );
  }
  if (sharedEventSource) {
    sharedEventSource.close();
  }
  sharedEventSource = null;
  sharedSyncListener = null;
}

function scheduleReconnect(): void {
  if (reconnectTimeout) return;
  if (syncSubscribers.size === 0) return;
  if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
    // Yield. The error has been fatal for long enough that further auto-
    // retries are wasted CPU/battery. visibilitychange / focus will reset
    // the counter via `forceImmediateReconnect()` and try once more. If
    // the underlying issue (auth, network, server) was fixed in the
    // meantime, the next attempt succeeds and `ready` zeroes the counter.
    console.warn(
      `[Sync] Stopped auto-retrying after ${MAX_RECONNECT_ATTEMPTS} failed attempts. Will resume on tab focus / visibility change.`
    );
    return;
  }
  const delay = Math.min(
    RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt),
    RECONNECT_MAX_MS
  );
  reconnectAttempt += 1;
  reconnectTimeout = setTimeout(() => {
    reconnectTimeout = null;
    if (syncSubscribers.size === 0) return;
    ensureSharedEventSource();
  }, delay);
}

/**
 * Treat the user re-engaging with the tab as a signal that "the underlying
 * issue might have been fixed" — clear the back-off counter and try a fresh
 * connection immediately. Safe to call on healthy connections too:
 * `ensureSharedEventSource` is idempotent.
 */
function forceImmediateReconnect(): void {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  reconnectAttempt = 0;
  ensureSharedEventSource();
}

function ensureSharedEventSource(): void {
  if (disconnectTimeout) {
    clearTimeout(disconnectTimeout);
    disconnectTimeout = null;
  }

  if (
    sharedEventSource &&
    sharedEventSource.readyState !== EventSource.CLOSED
  ) {
    return;
  }

  // Either no socket yet, or browser gave up retrying. Build a fresh one.
  if (sharedEventSource) {
    teardownEventSource();
  }

  sharedEventSource = new EventSource("/api/events");
  sharedSyncListener = (event: MessageEvent<string>) => {
    let parsed: UiSyncEvent | null = null;
    try {
      parsed = JSON.parse(event.data) as UiSyncEvent;
    } catch {
      return;
    }

    for (const subscriber of syncSubscribers.values()) {
      try {
        subscriber(parsed);
      } catch {
        // Keep fan-out resilient to individual listener failures.
      }
    }
  };

  sharedEventSource.addEventListener("sync", sharedSyncListener as EventListener);

  // The server emits a `ready` event on connection. We use it as the signal
  // to broadcast a synthetic resync — covers both initial connect and
  // recovery after the browser auto-retried out of CONNECTING state.
  sharedEventSource.addEventListener("ready", () => {
    reconnectAttempt = 0;
    broadcastResync();
  });

  sharedEventSource.onerror = () => {
    // The browser auto-retries while readyState === CONNECTING. We only
    // intervene once it gives up (CLOSED), to schedule our own backoff.
    if (sharedEventSource?.readyState === EventSource.CLOSED) {
      teardownEventSource();
      scheduleReconnect();
    }
  };
}

function subscribeSharedSync(subscriber: SyncSubscriber): () => void {
  ensureSharedEventSource();
  const subscriberId = nextSubscriberId++;
  syncSubscribers.set(subscriberId, subscriber);

  return () => {
    syncSubscribers.delete(subscriberId);
    if (syncSubscribers.size === 0 && sharedEventSource) {
      disconnectTimeout = setTimeout(() => {
        if (syncSubscribers.size === 0) {
          if (reconnectTimeout) {
            clearTimeout(reconnectTimeout);
            reconnectTimeout = null;
          }
          teardownEventSource();
        }
      }, 1000); // 1-second debounce for React Strict Mode unmount/mount cycles
    }
  };
}

function matchesScope(
  event: UiSyncEvent,
  options: BackgroundSyncOptions
): boolean {
  if (options.topics && options.topics.length > 0) {
    if (!options.topics.includes(event.topic)) {
      return false;
    }
  }

  if (event.topic === "projects" || event.topic === "global") {
    return true;
  }

  const expectedProject = options.projectId ?? null;
  if (options.projectId !== undefined) {
    const eventProject = event.projectId ?? null;
    if (eventProject !== expectedProject) {
      return false;
    }
  }

  if (options.chatId !== undefined && options.chatId !== null) {
    if (!event.chatId || event.chatId !== options.chatId) {
      return false;
    }
  }

  return true;
}

/**
 * Subscribe a component to the shared `/api/events` EventSource and receive
 * the parsed `UiSyncEvent` payload (filtered by `scope`). Use this when a
 * component needs the actual event data — e.g. swarm DAG nodes, trace logs —
 * rather than just a re-render trigger.
 *
 * Why this exists: prior code constructed `new EventSource("/api/events")`
 * directly inside components, which (a) breached the browser 6-socket cap
 * once two such components rendered alongside the shared sync connection,
 * and (b) re-opened the socket on every `chatId` change. This hook routes
 * through the same shared socket as `useBackgroundSync`.
 */
export function useUiSyncEvents(
  scope: UiSyncScope,
  handler: (event: UiSyncEvent) => void
): void {
  const topicsKey = scope.topics?.join(",") ?? "";
  const projectId = scope.projectId;
  const chatId = scope.chatId;
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const localScope: BackgroundSyncOptions = {
      topics: topicsKey
        ? (topicsKey.split(",").filter(Boolean) as UiSyncTopic[])
        : undefined,
      projectId,
      chatId,
    };

    const onSync = (parsed: UiSyncEvent) => {
      // Synthetic resync events carry no typed payload (no swarmNode etc.) —
      // route them only through useBackgroundSync (which uses tick-based
      // reconciliation), not through typed-payload consumers like swarm-dag.
      if (isResyncEvent(parsed)) return;
      if (!matchesScope(parsed, localScope)) return;
      handlerRef.current(parsed);
    };

    return subscribeSharedSync(onSync);
  }, [chatId, projectId, topicsKey]);
}

export function useBackgroundSync(options: BackgroundSyncOptions = {}): number {
  const topicsKey = options.topics?.join(",") ?? "";
  const projectId = options.projectId;
  const chatId = options.chatId;
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const scope: BackgroundSyncOptions = {
      topics: topicsKey
        ? (topicsKey.split(",").filter(Boolean) as UiSyncTopic[])
        : undefined,
      projectId,
      chatId,
    };

    const bump = () => {
      if (document.visibilityState !== "visible") return;
      setTick((value) => value + 1);
    };

    const onSync = (parsed: UiSyncEvent) => {
      // Resync events bypass scope filtering by design (PM #5 Defect #1):
      // a subscriber with `topics: ["chat"]` would otherwise reject a
      // global resync ("global" not in ["chat"]) and silently miss the
      // post-reconnect refetch trigger. Every useBackgroundSync consumer
      // wants to know when the connection rebuilt — that's the whole point.
      if (isResyncEvent(parsed)) {
        bump();
        return;
      }
      if (!matchesScope(parsed, scope)) {
        return;
      }
      bump();
    };

    const unsubscribeSync = subscribeSharedSync(onSync);

    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      // Force a fresh socket if the browser dropped it while we were hidden,
      // and reset the reconnect budget — user re-engagement is the recovery
      // path out of the circuit-breaker yield (see MAX_RECONNECT_ATTEMPTS).
      forceImmediateReconnect();
      setTick((value) => value + 1);
    };

    const onWindowFocus = () => {
      forceImmediateReconnect();
      setTick((value) => value + 1);
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onWindowFocus);

    return () => {
      unsubscribeSync();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onWindowFocus);
    };
  }, [chatId, projectId, topicsKey]);

  return tick;
}
