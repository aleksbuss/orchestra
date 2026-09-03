import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/observability/classify-error", () => ({
  classifyChatError: vi.fn(() => ({ kind: "provider_error", message: "boom", recoverable: false })),
}));
vi.mock("@/lib/realtime/event-bus", () => ({
  publishChatErrorEvent: vi.fn(),
}));
vi.mock("@/lib/observability/logger", () => ({
  log: { error: vi.fn() },
  getCurrentTraceId: vi.fn(() => "trace-xyz"),
}));
vi.mock("@/lib/observability/postmortem", () => ({
  dumpPostmortem: vi.fn(async () => {}),
}));
vi.mock("@/lib/storage/chat-store", () => ({
  updateChat: vi.fn(async () => {}),
}));

import { reportTurnError } from "./agent-stream";
import { classifyChatError } from "@/lib/observability/classify-error";
import { publishChatErrorEvent } from "@/lib/realtime/event-bus";
import { log, getCurrentTraceId } from "@/lib/observability/logger";
import { dumpPostmortem } from "@/lib/observability/postmortem";
import { updateChat } from "@/lib/storage/chat-store";
import type { AppSettings } from "@/lib/types";

const ctx = () => ({
  chatId: "c1",
  projectId: "p1" as string | undefined,
  request: {
    userMessage: "hi",
    swarmEnabled: false,
    preset: undefined,
    currentPath: undefined,
  },
  settings: {} as AppSettings,
});

describe("reportTurnError (§10 agent-stream error seam)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCurrentTraceId).mockReturnValue("trace-xyz");
    vi.mocked(dumpPostmortem).mockResolvedValue(undefined as never);
  });

  it("classifies, logs with the given event, publishes the chat-error event, and returns the payload", async () => {
    const err = new Error("upstream 404");
    const payload = await reportTurnError(err, ctx(), {
      logEvent: "agent_stream_error",
      awaitPostmortem: false,
    });

    expect(classifyChatError).toHaveBeenCalledWith(err, "trace-xyz");
    expect(log.error).toHaveBeenCalledWith(
      "agent_stream_error",
      expect.objectContaining({ chatId: "c1", projectId: "p1", kind: "provider_error", message: "boom" })
    );
    expect(publishChatErrorEvent).toHaveBeenCalledWith({
      chatId: "c1",
      projectId: "p1",
      payload,
    });
    expect(payload.kind).toBe("provider_error");
  });

  it("dumps a forensic postmortem with the request snapshot + classified payload", async () => {
    const err = new Error("x");
    await reportTurnError(err, ctx(), { logEvent: "agent_fatal_error", awaitPostmortem: true });
    expect(dumpPostmortem).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: "trace-xyz",
        chatId: "c1",
        projectId: "p1",
        request: expect.objectContaining({ userMessage: "hi", swarmEnabled: false }),
        errorClassification: expect.objectContaining({ kind: "provider_error" }),
        err,
      })
    );
  });

  it("skips the postmortem when there is no trace id", async () => {
    vi.mocked(getCurrentTraceId).mockReturnValue("");
    await reportTurnError(new Error("x"), ctx(), { logEvent: "agent_stream_error", awaitPostmortem: false });
    expect(dumpPostmortem).not.toHaveBeenCalled();
    // The chat-error event still fires — the UI must render regardless of tracing.
    expect(publishChatErrorEvent).toHaveBeenCalledTimes(1);
  });

  it("awaitPostmortem=true swallows a rejecting dump (never throws before a rethrow)", async () => {
    vi.mocked(dumpPostmortem).mockRejectedValue(new Error("disk full"));
    await expect(
      reportTurnError(new Error("x"), ctx(), { logEvent: "agent_fatal_error", awaitPostmortem: true })
    ).resolves.toMatchObject({ kind: "provider_error" });
  });

  it("awaitPostmortem=false fire-and-forgets a rejecting dump without an unhandled rejection", async () => {
    vi.mocked(dumpPostmortem).mockRejectedValue(new Error("disk full"));
    // Resolves immediately (does not await the dump) and the .catch prevents an
    // unhandled rejection that would otherwise poison the SSE onError path.
    await expect(
      reportTurnError(new Error("x"), ctx(), { logEvent: "agent_stream_error", awaitPostmortem: false })
    ).resolves.toBeDefined();
    await Promise.resolve(); // let the rejected dump settle under its .catch
  });

  // Post-review (protake council, 2026-08-31) — the SSE event is live-only; a
  // user who reloads (or wasn't watching when a free-tier retry ladder burned
  // 20-30s) must still be able to see the turn failed, not just their own
  // last message followed by silence.
  describe("durable persistence of the failure", () => {
    it("appends an assistant message carrying the classified message + hint", async () => {
      vi.mocked(classifyChatError).mockReturnValue({
        traceId: "trace-abc",
        kind: "upstream_5xx",
        message: "The model provider returned an error.",
        hint: "Retry, or switch models in Settings.",
        recoverable: true,
      });
      await reportTurnError(new Error("x"), ctx(), { logEvent: "agent_stream_error", awaitPostmortem: false });

      expect(updateChat).toHaveBeenCalledWith("c1", expect.any(Function));
      const updater = vi.mocked(updateChat).mock.calls[0][1] as (chat: {
        messages: unknown[];
        updatedAt: string;
      }) => unknown;
      const chat = { messages: [] as Array<Record<string, unknown>>, updatedAt: "old" };
      updater(chat);
      expect(chat.messages).toHaveLength(1);
      const msg = chat.messages[0];
      expect(msg.role).toBe("assistant");
      expect(msg.content).toContain("The model provider returned an error.");
      expect(msg.content).toContain("Retry, or switch models in Settings.");
      // The hint often says "check the server log for trace id" — self-defeating
      // unless the persisted record actually carries it.
      expect(msg.content).toContain("trace-abc");
      expect(chat.updatedAt).not.toBe("old");
    });

    it("does NOT persist a message for a user-initiated abort", async () => {
      vi.mocked(classifyChatError).mockReturnValue({
        kind: "abort",
        message: "Request was cancelled.",
        recoverable: false,
      });
      await reportTurnError(new Error("x"), ctx(), { logEvent: "agent_stream_error", awaitPostmortem: false });
      expect(updateChat).not.toHaveBeenCalled();
    });

    it("is best-effort — a failed persist does not make reportTurnError throw", async () => {
      vi.mocked(classifyChatError).mockReturnValue({ kind: "provider_error" as never, message: "boom", recoverable: false });
      vi.mocked(updateChat).mockRejectedValueOnce(new Error("disk full"));
      await expect(
        reportTurnError(new Error("x"), ctx(), { logEvent: "agent_stream_error", awaitPostmortem: false })
      ).resolves.toMatchObject({ kind: "provider_error" });
    });
  });
});
