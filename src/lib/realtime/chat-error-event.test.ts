/**
 * Tests for `publishChatErrorEvent` — the structured surface that the
 * agent error paths use to tell the UI "something broke, here's what."
 *
 * The existing `event-bus.test.ts` tests an INLINED copy of the bus to
 * avoid globalThis pollution across tests. This file targets the REAL
 * exported helper because it has its own contract (event shape, default
 * topic, reason auto-population) that must not regress silently.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  publishChatErrorEvent,
  publishUiSyncEvent,
  subscribeUiSyncEvents,
} from "./event-bus";

beforeEach(() => {
  // Wipe any listeners that might have leaked from previous tests in this
  // worker. The bus uses globalThis state by design — we cooperate.
  const g = globalThis as typeof globalThis & {
    __ORCHESTRA_UI_SYNC_BUS_STATE__?: { listeners: Map<number, unknown> };
  };
  g.__ORCHESTRA_UI_SYNC_BUS_STATE__?.listeners.clear();
});

describe("publishChatErrorEvent", () => {
  it("emits a topic:'chat' event with the chatError payload attached", () => {
    const captured: unknown[] = [];
    const unsub = subscribeUiSyncEvents((e) => captured.push(e));

    publishChatErrorEvent({
      chatId: "c-1",
      projectId: "p-1",
      payload: {
        traceId: "T-1",
        kind: "upstream_no_tools",
        message: "tool calls not supported",
        hint: "switch model",
        recoverable: false,
      },
    });

    unsub();

    expect(captured).toHaveLength(1);
    const event = captured[0] as {
      topic: string;
      chatId: string;
      chatError?: { kind: string; recoverable: boolean };
      reason?: string;
    };

    expect(event.topic).toBe("chat");
    expect(event.chatId).toBe("c-1");
    expect(event.chatError?.kind).toBe("upstream_no_tools");
    expect(event.chatError?.recoverable).toBe(false);
    // The auto-generated `reason` is what frontends WITHOUT chatError
    // support fall back to in their toast — make sure it's not empty.
    expect(event.reason).toMatch(/error/i);
  });

  it("includes the trace id so operators can grep logs by the same key", () => {
    const captured: unknown[] = [];
    const unsub = subscribeUiSyncEvents((e) => captured.push(e));

    publishChatErrorEvent({
      chatId: "c-2",
      payload: {
        traceId: "T-grep-me-please",
        kind: "internal",
        message: "something broke",
        recoverable: false,
      },
    });

    unsub();

    const event = captured[0] as { chatError?: { traceId?: string } };
    expect(event.chatError?.traceId).toBe("T-grep-me-please");
  });

  it("does not interfere with non-error chat events on the same bus", () => {
    const captured: unknown[] = [];
    const unsub = subscribeUiSyncEvents((e) => captured.push(e));

    publishUiSyncEvent({
      topic: "chat",
      chatId: "c-3",
      reason: "agent_started",
    });
    publishChatErrorEvent({
      chatId: "c-3",
      payload: {
        traceId: "T",
        kind: "abort",
        message: "user cancelled",
        recoverable: false,
      },
    });

    unsub();

    expect(captured).toHaveLength(2);
    const [first, second] = captured as Array<{
      reason?: string;
      chatError?: unknown;
    }>;
    expect(first.chatError).toBeUndefined();
    expect(first.reason).toBe("agent_started");
    expect(second.chatError).toBeDefined();
  });
});
