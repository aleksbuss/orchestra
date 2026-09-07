/**
 * PM #134 — who gets BLAMED when a forced answer degrades.
 *
 * Self-audit gap, 2026-09-07: the commit claimed "both call sites now attribute
 * the degradation to the endpoint that produced it rather than the brain slot",
 * and a mutation sweep proved nothing enforced it — replacing
 * `attempt.markupDegradation.endpoint ?? brainConfig` with a bare `brainConfig`
 * at EITHER call site left the whole suite green. The claim was true of the code
 * and untested, which is how it silently stops being true.
 *
 * The difference is reachable whenever the brain rungs are skipped (an open
 * circuit, or `skipBrainRetry`) and the FIRST markup therefore comes from a
 * substitute. Blaming the brain there sends the PM #82 compaction backstop at a
 * context that is not the one that degraded.
 *
 * The ladder is mocked here on purpose: this file is about the MAPPING from a
 * ladder result to telemetry, not about the ladder.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/agent/final-answer-failover", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent/final-answer-failover")>();
  return { ...actual, generateFinalAnswerWithFailover: vi.fn() };
});

vi.mock("@/lib/agent/degradation-telemetry", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/agent/degradation-telemetry")>();
  return { ...actual, recordToolChannelDegradation: vi.fn() };
});

vi.mock("@/lib/realtime/event-bus", () => ({
  publishChatErrorEvent: vi.fn(),
  publishUiSyncEvent: vi.fn(),
}));

import { generateFinalAnswerWithFailover } from "@/lib/agent/final-answer-failover";
import { recordToolChannelDegradation } from "@/lib/agent/degradation-telemetry";
import { resolveTurnContinuation } from "./agent-response";
import type { AppSettings, ModelConfig } from "@/lib/types";

const mockedFailover = vi.mocked(generateFinalAnswerWithFailover);
const mockedRecord = vi.mocked(recordToolChannelDegradation);

const BRAIN: ModelConfig = { provider: "openrouter", model: "vendor/brain:free" };
const SUBSTITUTE: ModelConfig = { provider: "openrouter", model: "vendor/substitute:free" };

function settings(): AppSettings {
  return {
    chatModel: { ...BRAIN },
    utilityModel: { ...SUBSTITUTE },
    general: { darkMode: false, language: "en" },
    freeMode: { enabled: true },
  } as unknown as AppSettings;
}

function continuationArgs() {
  return {
    responseMessages: [],
    finishReason: "stop",
    model: { __model: "brain-handle" } as never,
    systemPrompt: "sys",
    baseMessages: [{ role: "user" as const, content: "hi" }],
    providerOptions: undefined,
    settings: settings(),
    brainConfig: BRAIN,
    chatId: "chat-attribution",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("forced-answer degradation attribution (PM #134)", () => {
  it("names the SUBSTITUTE that printed the markup, not the brain slot", async () => {
    mockedFailover.mockResolvedValueOnce({
      text: "",
      usage: { totalTokens: 11 },
      markupDegradation: {
        toolName: "search_web",
        endpoint: SUBSTITUTE,
        markupChars: 219,
      },
    } as never);

    const out = await resolveTurnContinuation(continuationArgs() as never);

    expect(out.text).toContain("printed the call as text");
    expect(mockedRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "forced-answer",
        model: SUBSTITUTE.model,
        provider: SUBSTITUTE.provider,
        toolName: "search_web",
        markupChars: 219,
      })
    );
    // The brain slot must NOT be what gets blamed.
    expect(mockedRecord).not.toHaveBeenCalledWith(
      expect.objectContaining({ model: BRAIN.model })
    );
  });

  it("falls back to the brain slot only when the ladder could not name an endpoint", async () => {
    mockedFailover.mockResolvedValueOnce({
      text: "",
      usage: { totalTokens: 11 },
      markupDegradation: { toolName: "search_web", endpoint: undefined, markupChars: 40 },
    } as never);

    await resolveTurnContinuation(continuationArgs() as never);

    expect(mockedRecord).toHaveBeenCalledWith(
      expect.objectContaining({ model: BRAIN.model, toolName: "search_web" })
    );
  });

  it("a RESCUED answer is delivered even if a degradation is also reported", async () => {
    // Self-audit 2026-09-07: unreachable today (no success return carries
    // `markupDegradation`), but without the `!text` guard this branch would
    // discard a substitute's real answer and ship the degradation notice.
    mockedFailover.mockResolvedValueOnce({
      text: "the substitute rescued this turn",
      usage: { totalTokens: 11 },
      endpoint: SUBSTITUTE,
      markupDegradation: { toolName: "search_web", endpoint: BRAIN, markupChars: 219 },
    } as never);

    const out = await resolveTurnContinuation(continuationArgs() as never);

    expect(out.text).toBe("the substitute rescued this turn");
    expect(out.text).not.toContain("printed the call as text");
  });

  it("a clean answer records nothing — the degradation path must not fire on success", async () => {
    mockedFailover.mockResolvedValueOnce({
      text: "a real answer",
      usage: { totalTokens: 11 },
      endpoint: SUBSTITUTE,
    } as never);

    const out = await resolveTurnContinuation(continuationArgs() as never);

    expect(out.text).toBe("a real answer");
    expect(mockedRecord).not.toHaveBeenCalled();
  });
});
