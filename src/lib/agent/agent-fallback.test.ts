import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the leaf deps BEFORE importing the unit under test.
vi.mock("@/lib/providers/model-fallback", () => ({
  classifyModelError: vi.fn(),
  pickFallbackModel: vi.fn(),
  describeFallback: vi.fn(() => ({ message: "switched", hint: "fyi" })),
  describeUpstreamFailure: vi.fn(() => "HTTP 400 — Provider returned error"),
}));
vi.mock("@/lib/storage/settings-store", () => ({
  saveSettings: vi.fn(async () => {}),
}));
vi.mock("@/lib/realtime/event-bus", () => ({
  publishChatErrorEvent: vi.fn(),
  publishUiSyncEvent: vi.fn(),
}));
vi.mock("@/lib/storage/chat-store", () => ({
  getChat: vi.fn(),
  updateChat: vi.fn(),
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

  /**
   * PM #112 / PM #99 family — the key was read straight off
   * `settings.chatModel.apiKey`, so a vault-only install (and every Free Mode
   * run, whose overlay carries provider+model ONLY) handed `pickFallbackModel`
   * no key at all. `pickFromOpenRouterCatalog` then bailed before its first
   * request and the turn wrote a "no candidate" notice, having searched nothing.
   */
  it("resolves the key from the vault, not just from chatModel.apiKey", async () => {
    vi.mocked(classifyModelError).mockReturnValue("model_not_found" as never);
    vi.mocked(pickFallbackModel).mockResolvedValue({ modelId: "" } as never);
    const vaultOnly = {
      chatModel: { provider: "openrouter", model: "broken/model" },
      providerApiKeys: { openrouter: "vault-key" },
    } as unknown as AppSettings;

    await attemptModelFallback(new Error("404"), vaultOnly, "c1", null);

    expect(pickFallbackModel).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "vault-key" })
    );
  });

  it("still attempts the search when no key exists anywhere (the catalogue is public)", async () => {
    vi.mocked(classifyModelError).mockReturnValue("model_not_found" as never);
    vi.mocked(pickFallbackModel).mockResolvedValue({ modelId: "" } as never);
    const keyless = {
      chatModel: { provider: "openrouter", model: "broken/model" },
    } as unknown as AppSettings;

    await attemptModelFallback(new Error("404"), keyless, "c1", null);

    // The point is that the search RUNS — an env-only key is invisible here and
    // must not be mistaken for "nothing to try".
    expect(pickFallbackModel).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openrouter", apiKey: undefined })
    );
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

describe("no fallback candidate — the user must not be left with silence", () => {
  beforeEach(() => vi.clearAllMocks());

  /**
   * Measured 2026-08-25: with Free Mode on and every free endpoint's circuit
   * already OPEN, a 15-turn run wrote 15 user messages and ZERO assistant
   * messages. Every step was correct — upstream 4xx detected, failover
   * attempted, no healthy substitute found, no answer invented — and the chat
   * simply stayed silent, which is indistinguishable from a hang.
   */
  async function runNoCandidate(lastRole: "user" | "assistant" | null) {
    const { getChat, updateChat } = await import("@/lib/storage/chat-store");
    vi.mocked(classifyModelError).mockReturnValue("unknown_4xx" as never);
    vi.mocked(pickFallbackModel).mockResolvedValue({ modelId: null } as never);
    const messages = lastRole ? [{ id: "m1", role: lastRole, content: "x" }] : [];
    vi.mocked(getChat).mockResolvedValue({ id: "c1", messages } as never);
    vi.mocked(updateChat).mockImplementation((async (_id: string, fn: (c: unknown) => unknown) => {
      fn({ messages });
    }) as never);
    await attemptModelFallback(new Error("Provider returned error"), settingsWith(), "c1", "p1");
    return { updateChat, messages };
  }

  it("appends an assistant message explaining that no model was available", async () => {
    const { updateChat, messages } = await runNoCandidate("user");
    expect(updateChat).toHaveBeenCalledOnce();
    const appended = messages[messages.length - 1] as { role: string; content: string };
    expect(appended.role).toBe("assistant");
    expect(appended.content).toMatch(/no answer this turn/i);
    // Must name the failing endpoint and offer a way out, not just apologise.
    expect(appended.content).toContain("openrouter/broken/model");
    expect(appended.content).toMatch(/free mode/i);
  });

  it("does NOT fabricate an answer — it says so explicitly", async () => {
    const { messages } = await runNoCandidate("user");
    const appended = messages[messages.length - 1] as { content: string };
    expect(appended.content).toMatch(/does not fabricate/i);
  });

  /**
   * PM #112 — the notice used to assert "every alternative endpoint is currently
   * circuit-broken (usually: the free tier is exhausted or rate-limited)". This
   * path consults NO circuit breaker, and the real failure was an upstream 400
   * on a `max_tokens` Orchestra itself picked. The operator followed the
   * message's advice and waited for a recovery that could never arrive.
   */
  it("reports the upstream's own words and never invents a cause it did not check", async () => {
    const { messages } = await runNoCandidate("user");
    const appended = messages[messages.length - 1] as { content: string };
    expect(appended.content).toContain("HTTP 400 — Provider returned error");
    expect(appended.content).not.toMatch(/circuit[- ]broken/i);
    expect(appended.content).not.toMatch(/free tier is exhausted/i);
  });

  it("says so plainly when the provider gave no detail, rather than guessing one", async () => {
    const { describeUpstreamFailure } = await import("@/lib/providers/model-fallback");
    vi.mocked(describeUpstreamFailure).mockReturnValueOnce(null);
    const { messages } = await runNoCandidate("user");
    const appended = messages[messages.length - 1] as { content: string };
    expect(appended.content).toMatch(/no detail from the provider/i);
  });

  it("stays quiet when something already answered — no talking over a real reply", async () => {
    const { updateChat } = await runNoCandidate("assistant");
    expect(updateChat).not.toHaveBeenCalled();
  });

  it("stays quiet when the chat has no messages at all", async () => {
    const { updateChat } = await runNoCandidate(null);
    expect(updateChat).not.toHaveBeenCalled();
  });

  it("a failing notice never breaks the error path it reports on", async () => {
    const { getChat } = await import("@/lib/storage/chat-store");
    vi.mocked(classifyModelError).mockReturnValue("unknown_4xx" as never);
    vi.mocked(pickFallbackModel).mockResolvedValue({ modelId: null } as never);
    vi.mocked(getChat).mockRejectedValue(new Error("disk gone"));
    await expect(
      attemptModelFallback(new Error("Provider returned error"), settingsWith(), "c1", null)
    ).resolves.toBeUndefined();
  });
});
