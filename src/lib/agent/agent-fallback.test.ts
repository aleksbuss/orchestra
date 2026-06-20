import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the leaf deps BEFORE importing the unit under test.
vi.mock("@/lib/providers/model-fallback", () => ({
  classifyModelError: vi.fn(),
  pickFallbackModel: vi.fn(),
  describeFallback: vi.fn(() => ({ message: "switched", hint: "fyi" })),
}));
vi.mock("@/lib/storage/settings-store", () => ({
  saveSettings: vi.fn(async () => {}),
}));
vi.mock("@/lib/realtime/event-bus", () => ({
  publishChatErrorEvent: vi.fn(),
}));
vi.mock("@/lib/observability/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn() },
  getCurrentTraceId: vi.fn(() => "trace-1"),
}));

import { attemptModelFallback } from "./agent-fallback";
import { classifyModelError, pickFallbackModel } from "@/lib/providers/model-fallback";
import { saveSettings } from "@/lib/storage/settings-store";
import { publishChatErrorEvent } from "@/lib/realtime/event-bus";
import { log } from "@/lib/observability/logger";
import type { AppSettings } from "@/lib/types";

const settingsWith = (provider = "openrouter", model = "broken/model") =>
  ({ chatModel: { provider, model, apiKey: "k" } } as unknown as AppSettings);

describe("attemptModelFallback (§10 agent-fallback seam)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does NOTHING for a non-model error (no settings write, no event)", async () => {
    vi.mocked(classifyModelError).mockReturnValue("rate_limit" as never);
    await attemptModelFallback(new Error("429"), settingsWith(), "c1", null);
    expect(pickFallbackModel).not.toHaveBeenCalled();
    expect(saveSettings).not.toHaveBeenCalled();
    expect(publishChatErrorEvent).not.toHaveBeenCalled();
  });

  it("returns early when settings carry no chatModel provider/model", async () => {
    vi.mocked(classifyModelError).mockReturnValue("model_not_found" as never);
    await attemptModelFallback(new Error("404"), {} as AppSettings, "c1", null);
    expect(pickFallbackModel).not.toHaveBeenCalled();
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("on model_not_found + a candidate: persists the new model and emits model_fallback", async () => {
    vi.mocked(classifyModelError).mockReturnValue("model_not_found" as never);
    vi.mocked(pickFallbackModel).mockResolvedValue({
      modelId: "good/model",
      source: "catalog",
      pricing: { isFree: false },
    } as never);

    await attemptModelFallback(new Error("404"), settingsWith(), "c1", "p1");

    // Only chatModel.model changes; provider/apiKey preserved.
    expect(saveSettings).toHaveBeenCalledWith({
      chatModel: { provider: "openrouter", model: "good/model", apiKey: "k" },
    });
    const evt = vi.mocked(publishChatErrorEvent).mock.calls[0][0];
    expect(evt.chatId).toBe("c1");
    expect(evt.projectId).toBe("p1");
    expect(evt.payload.kind).toBe("model_fallback");
    expect(evt.payload.modelFallback?.reason).toBe("model_not_found");
    expect(evt.payload.recoverable).toBe(true);
  });

  it("maps a no_tool_support failure to the matching reason (PM #17)", async () => {
    vi.mocked(classifyModelError).mockReturnValue("no_tool_support" as never);
    vi.mocked(pickFallbackModel).mockResolvedValue({
      modelId: "tools/ok",
      source: "catalog",
      pricing: { isFree: true },
    } as never);

    await attemptModelFallback(new Error("no tools"), settingsWith(), "c1", null);

    const evt = vi.mocked(publishChatErrorEvent).mock.calls[0][0];
    expect(evt.payload.modelFallback?.reason).toBe("no_tool_support");
  });

  it("when no candidate is found: logs, does NOT persist or emit", async () => {
    vi.mocked(classifyModelError).mockReturnValue("model_not_found" as never);
    vi.mocked(pickFallbackModel).mockResolvedValue({ modelId: "" } as never);

    await attemptModelFallback(new Error("404"), settingsWith(), "c1", null);

    expect(saveSettings).not.toHaveBeenCalled();
    expect(publishChatErrorEvent).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith("agent_fallback_no_candidate", expect.anything());
  });

  it("never throws — an internal failure is swallowed and logged", async () => {
    vi.mocked(classifyModelError).mockReturnValue("model_not_found" as never);
    vi.mocked(pickFallbackModel).mockRejectedValue(new Error("catalog down"));

    await expect(
      attemptModelFallback(new Error("404"), settingsWith(), "c1", null)
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith("agent_fallback_failed", expect.anything());
  });
});
