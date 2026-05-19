// @vitest-environment happy-dom
/**
 * Regression tests for PM #5 ("SSE Stream Persisted, UI Showed Empty Response").
 *
 * The fix in `useBackgroundSync` covers three pieces of behavior that this
 * file pins:
 *
 *   1. Server `ready` event triggers a synthetic resync broadcast →
 *      every subscriber's `tick` increments. (chat-panel's `useEffect`
 *      depending on `syncTick` then re-fetches `/api/chat/history`.)
 *   2. `document.visibilitychange === "visible"` AND `window.focus`
 *      force an immediate EventSource reconnect AND bump the tick.
 *      Without this, the SSE socket may stay dropped indefinitely after
 *      a backgrounded tab returns.
 *   3. Synthetic resync events bypass scope filtering — a subscriber
 *      with `topics: ["chat"]` MUST receive a `topic: "global"` resync.
 *      Pre-fix, the scope filter dropped it (PM #5 Defect #1) and
 *      consumers never refetched.
 *
 * happy-dom doesn't ship a usable `EventSource`, so we install a
 * controllable mock as the GLOBAL constructor. The mock lets us:
 *   - assert how many sockets the hook created (`MockEventSource.instances`)
 *   - fire `ready` / `sync` / `error` events programmatically
 *   - flip `readyState` between OPEN / CLOSED
 *
 * The hook keeps shared singleton state at module scope
 * (`sharedEventSource`, `syncSubscribers`, etc.). Each test resets that
 * state via `vi.resetModules()` so prior subscriptions don't leak
 * across cases.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

/* ─────────────────────── MockEventSource ─────────────────────── */

type EventListenerLike = (event: MessageEvent<string> | Event) => void;

/**
 * Minimal EventSource shim that supports the small surface the hook touches:
 *   - constructor(url)
 *   - addEventListener("sync" | "ready" | "error", listener)
 *   - removeEventListener
 *   - close()
 *   - readyState (settable from tests)
 *   - onerror (assigned by the hook)
 *
 * Test helpers (`fire*`) let us trigger events on demand.
 */
class MockEventSource {
  static instances: MockEventSource[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readonly url: string;
  readyState: number = MockEventSource.OPEN;
  onerror: ((this: MockEventSource, ev: Event) => void) | null = null;

  private listeners = new Map<string, Set<EventListenerLike>>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerLike): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: EventListenerLike): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.readyState = MockEventSource.CLOSED;
  }

  // ── test helpers ────────────────────────────────────────────────

  fireReady(): void {
    for (const fn of this.listeners.get("ready") ?? []) {
      fn(new Event("ready"));
    }
  }

  fireSync(payload: unknown): void {
    const me = new MessageEvent<string>("sync", { data: JSON.stringify(payload) });
    for (const fn of this.listeners.get("sync") ?? []) {
      fn(me);
    }
  }

  fireError(): void {
    if (this.onerror) {
      this.onerror.call(this, new Event("error"));
    }
  }
}

/* ─────────────────────── shared setup ─────────────────────── */

beforeEach(() => {
  // Reset module state — the hook caches `sharedEventSource` and
  // `syncSubscribers` at module scope, and we don't want them to
  // leak between tests.
  vi.resetModules();
  MockEventSource.instances = [];
  (globalThis as unknown as { EventSource: typeof MockEventSource }).EventSource =
    MockEventSource;
});

afterEach(() => {
  // Clean up document-level listeners that the hook installs.
  MockEventSource.instances.length = 0;
});

async function importHook() {
  return await import("./use-background-sync");
}

/* ─────────────────────── tests ─────────────────────── */

describe("useBackgroundSync — first subscription creates a single shared EventSource", () => {
  it("creates exactly one EventSource even when multiple components subscribe", async () => {
    const { useBackgroundSync } = await importHook();

    renderHook(() => useBackgroundSync({ topics: ["chat"], chatId: "c-1" }));
    renderHook(() => useBackgroundSync({ topics: ["files"], projectId: "p-1" }));
    renderHook(() => useBackgroundSync({ topics: ["projects"] }));

    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toBe("/api/events");
  });
});

describe("useBackgroundSync — server `ready` event broadcasts resync to ALL subscribers", () => {
  it("bumps tick on every subscriber regardless of topic filter (PM #5 Defect #1)", async () => {
    // The pre-fix scope filter dropped the global-topic resync for any
    // subscriber that hadn't explicitly opted into "global" topic. This
    // test pins the bypass: even a narrow `topics: ["chat"]` subscriber
    // must see the resync tick.
    const { useBackgroundSync } = await importHook();

    const a = renderHook(() => useBackgroundSync({ topics: ["chat"], chatId: "c-1" }));
    const b = renderHook(() => useBackgroundSync({ topics: ["files"], projectId: "p-1" }));
    const c = renderHook(() => useBackgroundSync({ topics: ["projects"] }));

    // Initial tick is 0 for everyone.
    expect(a.result.current).toBe(0);
    expect(b.result.current).toBe(0);
    expect(c.result.current).toBe(0);

    const es = MockEventSource.instances[0];
    act(() => {
      es.fireReady();
    });

    expect(a.result.current).toBe(1);
    expect(b.result.current).toBe(1);
    expect(c.result.current).toBe(1);
  });

  it("subsequent `ready` events (after reconnect) bump tick again", async () => {
    const { useBackgroundSync } = await importHook();
    const { result } = renderHook(() => useBackgroundSync({ topics: ["chat"] }));

    const es = MockEventSource.instances[0];
    act(() => es.fireReady());
    expect(result.current).toBe(1);
    act(() => es.fireReady());
    expect(result.current).toBe(2);
    act(() => es.fireReady());
    expect(result.current).toBe(3);
  });
});

describe("useBackgroundSync — scoped sync events still respect topic filtering", () => {
  it("only subscribers whose topics match the event topic see a non-resync bump", async () => {
    // The resync bypass is specific to synthetic events. Regular sync
    // events (the bulk of bus traffic) still respect the scope filter.
    const { useBackgroundSync } = await importHook();

    const chatSub = renderHook(() => useBackgroundSync({ topics: ["chat"], chatId: "c-1" }));
    const filesSub = renderHook(() => useBackgroundSync({ topics: ["files"], projectId: "p-1" }));

    const es = MockEventSource.instances[0];
    // Drain the initial `ready` bump so both subscribers start at the
    // same baseline after the EventSource opens.
    act(() => es.fireReady());
    const chatBase = chatSub.result.current;
    const filesBase = filesSub.result.current;

    // Fire a chat-scoped event — only chatSub should bump.
    act(() => {
      es.fireSync({
        id: 1,
        topic: "chat",
        chatId: "c-1",
        at: new Date().toISOString(),
      });
    });

    expect(chatSub.result.current).toBe(chatBase + 1);
    expect(filesSub.result.current).toBe(filesBase); // unchanged
  });
});

describe("useBackgroundSync — visibilitychange recovery (PM #5 core fix)", () => {
  it("flipping document.visibilityState to 'visible' bumps tick", async () => {
    const { useBackgroundSync } = await importHook();
    const { result } = renderHook(() => useBackgroundSync({ topics: ["chat"] }));
    const es = MockEventSource.instances[0];
    act(() => es.fireReady());
    const baseline = result.current;

    // Simulate tab being backgrounded → foregrounded.
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    // While hidden, bump() is a no-op (see hook line 304).
    expect(result.current).toBe(baseline);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    // Tick bumped on visibility return.
    expect(result.current).toBeGreaterThan(baseline);
  });

  it("when the existing EventSource is CLOSED, visibilitychange forces a fresh connection", async () => {
    const { useBackgroundSync } = await importHook();
    renderHook(() => useBackgroundSync({ topics: ["chat"] }));
    expect(MockEventSource.instances).toHaveLength(1);

    // Mark the existing socket as CLOSED — emulates the browser giving
    // up auto-retry while the tab was hidden.
    MockEventSource.instances[0].readyState = MockEventSource.CLOSED;

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    // The hook must have built a second EventSource instance.
    expect(MockEventSource.instances.length).toBeGreaterThanOrEqual(2);
    const fresh = MockEventSource.instances[MockEventSource.instances.length - 1];
    expect(fresh.readyState).toBe(MockEventSource.OPEN);
  });
});

describe("useBackgroundSync — window.focus recovery", () => {
  it("window.focus bumps tick", async () => {
    const { useBackgroundSync } = await importHook();
    const { result } = renderHook(() => useBackgroundSync({ topics: ["chat"] }));
    const es = MockEventSource.instances[0];
    act(() => es.fireReady());
    const baseline = result.current;

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    expect(result.current).toBeGreaterThan(baseline);
  });
});

describe("useBackgroundSync — EventSource onerror with CLOSED state", () => {
  it("does not crash when the EventSource fails", async () => {
    // The onerror path schedules a reconnect with backoff. Without fake
    // timers we can't assert the reconnect happens at the right wall-time;
    // here we just verify the error doesn't propagate as an unhandled
    // exception (which would crash the React tree in a real app).
    const { useBackgroundSync } = await importHook();
    const { result } = renderHook(() => useBackgroundSync({ topics: ["chat"] }));
    const es = MockEventSource.instances[0];
    act(() => es.fireReady());
    const baseline = result.current;

    es.readyState = MockEventSource.CLOSED;
    act(() => {
      es.fireError();
    });

    // No throw, hook state intact.
    expect(result.current).toBe(baseline);
  });
});

describe("useBackgroundSync — chat-panel resync contract", () => {
  it("a 'chat'-topic subscriber sees a tick bump from a 'global'-topic resync (PM #5)", async () => {
    // This is THE bug PM #5 fixed. Without the synthetic-resync bypass,
    // chat-panel (topics: ["chat", "global"]) would never refetch
    // `/api/chat/history` after a reconnect, leaving the user with a
    // stale blank pane while the disk JSON held the full message.
    const { useBackgroundSync } = await importHook();
    const { result } = renderHook(() =>
      useBackgroundSync({ topics: ["chat"], chatId: "c-1" })
    );
    const es = MockEventSource.instances[0];

    // Drain initial ready bump.
    act(() => es.fireReady());
    const baseline = result.current;

    // Simulate the server's `ready` event after a reconnect — broadcasts
    // a synthetic resync with topic="global". Pre-fix scope filter would
    // have dropped this for the chat-only subscriber.
    act(() => es.fireReady());

    expect(result.current).toBeGreaterThan(baseline);
  });
});
