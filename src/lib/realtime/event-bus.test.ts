import { describe, it, expect } from "vitest";

/**
 * Test suite for the Event Bus (pub/sub system).
 * Inlined implementation to avoid globalThis pollution across tests.
 */

type EventListener = (event: any) => void;

function createEventBus() {
  let nextListenerId = 1;
  let nextEventId = 1;
  const listeners = new Map<number, EventListener>();

  function publish(input: { topic: string; reason?: string; chatId?: string }) {
    const event = {
      id: nextEventId++,
      topic: input.topic,
      at: new Date().toISOString(),
      reason: input.reason,
      chatId: input.chatId,
    };
    for (const listener of listeners.values()) {
      try {
        listener(event);
      } catch {
        // Keep bus resilient
      }
    }
    return event;
  }

  function subscribe(listener: EventListener): () => void {
    const id = nextListenerId++;
    listeners.set(id, listener);
    return () => {
      listeners.delete(id);
    };
  }

  return { publish, subscribe, listenerCount: () => listeners.size };
}

describe("Event Bus (Pub/Sub System)", () => {
  it("should deliver events to subscribers", () => {
    const bus = createEventBus();
    const received: any[] = [];
    bus.subscribe((e) => received.push(e));

    bus.publish({ topic: "chat", reason: "test" });

    expect(received).toHaveLength(1);
    expect(received[0].topic).toBe("chat");
    expect(received[0].reason).toBe("test");
  });

  it("should deliver events to multiple subscribers", () => {
    const bus = createEventBus();
    const r1: any[] = [];
    const r2: any[] = [];
    bus.subscribe((e) => r1.push(e));
    bus.subscribe((e) => r2.push(e));

    bus.publish({ topic: "files" });

    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
  });

  it("should stop delivering after unsubscribe", () => {
    const bus = createEventBus();
    const received: any[] = [];
    const unsub = bus.subscribe((e) => received.push(e));

    bus.publish({ topic: "chat" });
    unsub();
    bus.publish({ topic: "chat" });

    expect(received).toHaveLength(1);
  });

  it("should assign unique incrementing event IDs", () => {
    const bus = createEventBus();
    const e1 = bus.publish({ topic: "chat" });
    const e2 = bus.publish({ topic: "files" });
    expect(e2.id).toBe(e1.id + 1);
  });

  it("should survive a crashing listener without breaking other listeners", () => {
    const bus = createEventBus();
    const received: any[] = [];
    bus.subscribe(() => { throw new Error("Boom!"); });
    bus.subscribe((e) => received.push(e));

    // Should NOT throw
    bus.publish({ topic: "chat" });

    expect(received).toHaveLength(1);
  });

  it("should include timestamp in events", () => {
    const bus = createEventBus();
    const e = bus.publish({ topic: "chat" });
    expect(e.at).toBeTruthy();
    // Should be a valid ISO date
    expect(new Date(e.at).toISOString()).toBe(e.at);
  });
});
