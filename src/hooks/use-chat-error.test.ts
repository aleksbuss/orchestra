/**
 * Tests for `pickChatErrorFromEvent` — the pure event-filter that decides
 * whether an incoming SSE event should drive the chat-error banner.
 *
 * The React wrapper (`useChatError`) is a 10-line passthrough; full
 * RTL/jsdom coverage of it is a separate Sprint (the codebase doesn't
 * have @testing-library/react today). The picker tests below pin every
 * decision the banner depends on.
 */
import { describe, it, expect } from "vitest";
import { pickChatErrorFromEvent } from "./use-chat-error";
import type { UiSyncEvent, ChatErrorPayload } from "@/lib/realtime/types";

function event(overrides: Partial<UiSyncEvent>): UiSyncEvent {
  return {
    id: 1,
    topic: "chat",
    at: new Date().toISOString(),
    ...overrides,
  } as UiSyncEvent;
}

const samplePayload: ChatErrorPayload = {
  traceId: "T-1",
  kind: "upstream_no_tools",
  message: "Tool calls not supported",
  hint: "Switch model",
  recoverable: false,
};

describe("pickChatErrorFromEvent", () => {
  it("returns the payload for a topic:'chat' event with chatError set, scoped to this chatId", () => {
    const e = event({ topic: "chat", chatId: "c-1", chatError: samplePayload });
    expect(pickChatErrorFromEvent(e, "c-1")).toBe(samplePayload);
  });

  it("returns null when chatError is absent (regular chat events)", () => {
    expect(pickChatErrorFromEvent(event({ chatId: "c-1", reason: "agent_started" }), "c-1")).toBeNull();
  });

  it("returns null when topic is not 'chat' (defense-in-depth)", () => {
    const e = event({ topic: "files", chatId: "c-1", chatError: samplePayload });
    expect(pickChatErrorFromEvent(e, "c-1")).toBeNull();
  });

  it("filters out events scoped to a DIFFERENT chat (cross-tab isolation)", () => {
    const e = event({ topic: "chat", chatId: "c-other", chatError: samplePayload });
    expect(pickChatErrorFromEvent(e, "c-1")).toBeNull();
  });

  it("accepts events with no chatId when the active chatId is set (backwards-compat)", () => {
    const e = event({ topic: "chat", chatError: samplePayload });
    expect(pickChatErrorFromEvent(e, "c-1")).toBe(samplePayload);
  });

  it("accepts ANY chat-error when active chatId is null/undefined (no filter applied)", () => {
    const e = event({ topic: "chat", chatId: "c-anything", chatError: samplePayload });
    expect(pickChatErrorFromEvent(e, null)).toBe(samplePayload);
    expect(pickChatErrorFromEvent(e, undefined)).toBe(samplePayload);
  });

  it("preserves the entire payload — does not narrow or strip fields", () => {
    const full: ChatErrorPayload = {
      traceId: "T-full",
      kind: "upstream_5xx",
      message: "Provider returned 503",
      hint: "Retry shortly",
      recoverable: true,
    };
    const e = event({ topic: "chat", chatId: "c-1", chatError: full });
    const picked = pickChatErrorFromEvent(e, "c-1");
    expect(picked).toEqual(full);
  });

  it("does not crash on malformed events (defensive)", () => {
    expect(() =>
      pickChatErrorFromEvent({ id: 0, topic: "chat", at: "" } as UiSyncEvent, "c-1")
    ).not.toThrow();
  });
});
