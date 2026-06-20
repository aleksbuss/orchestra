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

import { reportTurnError } from "./agent-stream";
import { classifyChatError } from "@/lib/observability/classify-error";
import { publishChatErrorEvent } from "@/lib/realtime/event-bus";
import { log, getCurrentTraceId } from "@/lib/observability/logger";
import { dumpPostmortem } from "@/lib/observability/postmortem";
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
});
