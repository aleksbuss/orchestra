/**
 * Tool-capable retry-on-model-swap — see the module's own docstring for the
 * cap=1/no-dedup-needed argument this file assumes rather than re-proves.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, generateText: vi.fn() };
});
vi.mock("@/lib/providers/llm-provider", () => ({
  createModel: vi.fn((cfg: { model: string }) => ({ __model: cfg.model })),
}));
vi.mock("@/lib/providers/context-window", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/providers/context-window")>();
  return { ...actual, resolveContextWindow: vi.fn(async () => 32000) };
});
vi.mock("@/lib/storage/chat-store", () => ({
  updateChat: vi.fn(),
}));
vi.mock("@/lib/realtime/event-bus", () => ({
  publishChatErrorEvent: vi.fn(),
  publishUiSyncEvent: vi.fn(),
}));
vi.mock("@/lib/agent/agent-dag-events", () => ({
  publishOrchestratorFinished: vi.fn(),
}));

import { generateText } from "ai";
import { createModel } from "@/lib/providers/llm-provider";
import { updateChat } from "@/lib/storage/chat-store";
import { publishChatErrorEvent, publishUiSyncEvent } from "@/lib/realtime/event-bus";
import { publishOrchestratorFinished } from "@/lib/agent/agent-dag-events";
import { resetModelHealth, recordModelFailure, isModelCircuitOpen } from "@/lib/agent/model-health";
import {
  __setOpenRouterBenchmarkScoreForTest,
  __resetOpenRouterPricingForTests,
} from "@/lib/cost/openrouter-pricing";
import type { AppSettings, Chat, ModelConfig } from "@/lib/types";
import {
  selectToolCapableRetryCandidate,
  attemptToolCapableRetry,
  type ToolCapableRetryArgs,
} from "./tool-capable-retry";

const mockedGenerateText = vi.mocked(generateText);
const mockedCreateModel = vi.mocked(createModel);
const mockedUpdateChat = vi.mocked(updateChat);
const mockedPublishChatError = vi.mocked(publishChatErrorEvent);
const mockedPublishOrchestratorFinished = vi.mocked(publishOrchestratorFinished);

const BRAIN: ModelConfig = { provider: "openrouter", model: "vendor/brain:free" };
const TOOLS = {
  read_text_file: { description: "x", inputSchema: {}, execute: async () => "" },
} as never;

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    chatModel: { ...BRAIN },
    utilityModel: { provider: "openrouter", model: "vendor/utility:free" },
    embeddingsModel: { provider: "openai", model: "text-embedding-3-small", dimensions: 1536 },
    codeExecution: { enabled: true, timeout: 600, maxOutputLength: 120000 },
    memory: { enabled: true, similarityThreshold: 0.35, maxResults: 10, chunkSize: 400 },
    search: { enabled: false, provider: "none" },
    general: { darkMode: false, language: "en" },
    auth: { enabled: true, username: "a", passwordHash: "h", mustChangeCredentials: false },
    ...overrides,
  } as AppSettings;
}

let chatState: Chat;

beforeEach(() => {
  vi.clearAllMocks();
  resetModelHealth();
  __resetOpenRouterPricingForTests();
  chatState = { id: "chat-1", title: "t", messages: [], createdAt: "", updatedAt: "", cumulativeUsage: undefined };
  mockedUpdateChat.mockImplementation(async (_chatId, updater) => {
    chatState = await updater(chatState);
    return chatState;
  });
});

function args(overrides: Partial<ToolCapableRetryArgs> = {}): ToolCapableRetryArgs {
  return {
    brainConfig: BRAIN,
    systemPrompt: "sys",
    messages: [{ role: "user", content: "hi" }],
    tools: TOOLS,
    providerOptions: undefined,
    settings: settings(),
    chatId: "chat-1",
    projectId: "proj-1",
    swarmEnabled: true,
    maxToolSteps: 100,
    ...overrides,
  };
}

describe("selectToolCapableRetryCandidate", () => {
  it("picks the best-scoring tool-supporting, healthy candidate — excludes the brain itself", () => {
    __setOpenRouterBenchmarkScoreForTest(
      new Map([
        ["vendor/utility:free", { intelligence: 30, coding: 30, agentic: 30 }],
        ["vendor/frontier:free", { intelligence: 90, coding: 90, agentic: 90 }],
      ])
    );
    const s = settings({
      proposerTiers: {
        frontier: { provider: "openrouter", model: "vendor/frontier:free" },
        balanced: { provider: "openrouter", model: "vendor/balanced:free" },
        fast: { provider: "openrouter", model: "vendor/fast:free" },
      },
    });
    const pick = selectToolCapableRetryCandidate(s, BRAIN);
    expect(pick?.model).toBe("vendor/frontier:free");
  });

  it("excludes a candidate that is the brain itself, even if it scores highest", () => {
    __setOpenRouterBenchmarkScoreForTest(
      new Map([["vendor/brain:free", { intelligence: 99, coding: 99, agentic: 99 }]])
    );
    const s = settings({
      utilityModel: { ...BRAIN }, // same as brain — should be filtered out
      proposerTiers: {
        frontier: { provider: "openrouter", model: "vendor/frontier:free" },
        balanced: undefined as never,
        fast: undefined as never,
      },
    });
    const pick = selectToolCapableRetryCandidate(s, BRAIN);
    expect(pick?.model).not.toBe("vendor/brain:free");
  });

  it("excludes a circuit-open candidate even if it scores highest", () => {
    __setOpenRouterBenchmarkScoreForTest(
      new Map([
        ["vendor/throttled:free", { intelligence: 99, coding: 99, agentic: 99 }],
        ["vendor/healthy:free", { intelligence: 10, coding: 10, agentic: 10 }],
      ])
    );
    for (let i = 0; i < 3; i++) recordModelFailure("openrouter", "vendor/throttled:free", "throttle");
    expect(isModelCircuitOpen("openrouter", "vendor/throttled:free")).toBe(true);
    const s = settings({
      proposerTiers: {
        frontier: { provider: "openrouter", model: "vendor/throttled:free" },
        balanced: { provider: "openrouter", model: "vendor/healthy:free" },
        fast: undefined as never,
      },
    });
    const pick = selectToolCapableRetryCandidate(s, BRAIN);
    expect(pick?.model).toBe("vendor/healthy:free");
  });

  it("excludes a tool-incapable candidate even if it scores highest", () => {
    __setOpenRouterBenchmarkScoreForTest(
      new Map([
        ["vendor/gemma-blind:free", { intelligence: 99, coding: 99, agentic: 99 }],
        ["vendor/capable:free", { intelligence: 10, coding: 10, agentic: 10 }],
      ])
    );
    const s = settings({
      proposerTiers: {
        frontier: { provider: "openrouter", model: "vendor/gemma-blind:free" },
        balanced: { provider: "openrouter", model: "vendor/capable:free" },
        fast: undefined as never,
      },
    });
    const pick = selectToolCapableRetryCandidate(s, BRAIN);
    expect(pick?.model).toBe("vendor/capable:free");
  });

  it("returns null when the pool is empty", () => {
    const s = settings({
      utilityModel: { ...BRAIN },
      proposerTiers: { frontier: undefined as never, balanced: undefined as never, fast: undefined as never },
    });
    expect(selectToolCapableRetryCandidate(s, BRAIN)).toBeNull();
  });

  it("returns null when every candidate is disqualified", () => {
    for (let i = 0; i < 3; i++) recordModelFailure("openrouter", "vendor/only:free", "throttle");
    const s = settings({
      utilityModel: { ...BRAIN },
      proposerTiers: {
        frontier: { provider: "openrouter", model: "vendor/only:free" },
        balanced: undefined as never,
        fast: undefined as never,
      },
    });
    expect(selectToolCapableRetryCandidate(s, BRAIN)).toBeNull();
  });
});

describe("attemptToolCapableRetry", () => {
  it("no tools provided — never attempted", async () => {
    const out = await attemptToolCapableRetry(args({ tools: {} as never }));
    expect(out).toEqual({ recovered: false, toolCallOccurred: false });
    expect(mockedGenerateText).not.toHaveBeenCalled();
  });

  it("no tool-capable candidate available — never calls generateText", async () => {
    const s = settings({
      utilityModel: { ...BRAIN },
      proposerTiers: { frontier: undefined as never, balanced: undefined as never, fast: undefined as never },
    });
    const out = await attemptToolCapableRetry(args({ settings: s }));
    expect(out).toEqual({ recovered: false, toolCallOccurred: false });
    expect(mockedGenerateText).not.toHaveBeenCalled();
  });

  it("createModel throws — logged, recovered:false, toolCallOccurred:false", async () => {
    mockedCreateModel.mockImplementationOnce(() => {
      throw new Error("vault key missing");
    });
    const out = await attemptToolCapableRetry(args());
    expect(out).toEqual({ recovered: false, toolCallOccurred: false });
    expect(mockedGenerateText).not.toHaveBeenCalled();
  });

  it("generateText throws AFTER onStepFinish already saw a tool call — flag survives the failure", async () => {
    mockedGenerateText.mockImplementationOnce((async (opts: unknown) => {
      const o = opts as { onStepFinish?: (e: unknown) => unknown };
      await o.onStepFinish?.({ toolCalls: [{ toolName: "read_text_file" }], usage: undefined });
      throw new Error("upstream died mid-loop");
    }) as never);
    const out = await attemptToolCapableRetry(args());
    expect(out).toEqual({ recovered: false, toolCallOccurred: true });
  });

  it("no deliverable answer (e.g. hit the step cap with nothing produced) — recovered:false", async () => {
    mockedGenerateText.mockResolvedValueOnce({
      response: { messages: [] },
    } as never);
    const out = await attemptToolCapableRetry(args());
    expect(out.recovered).toBe(false);
    expect(mockedUpdateChat).not.toHaveBeenCalled();
  });

  it("a chat-store write failure never claims recovered:true", async () => {
    mockedGenerateText.mockResolvedValueOnce({
      response: { messages: [{ role: "assistant", content: "done" }] },
    } as never);
    mockedUpdateChat.mockRejectedValueOnce(new Error("disk full"));
    const out = await attemptToolCapableRetry(args());
    expect(out.recovered).toBe(false);
    expect(mockedPublishChatError).not.toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ kind: "turn_recovered_with_tools" }) })
    );
  });

  it("success — persists REAL tool-call/tool-result messages (not one text blob), folds usage, publishes turn_recovered_with_tools", async () => {
    mockedGenerateText.mockImplementationOnce((async (opts: unknown) => {
      const o = opts as { onStepFinish?: (e: unknown) => unknown };
      await o.onStepFinish?.({
        toolCalls: [{ toolName: "read_text_file" }],
        usage: { totalTokens: 10 },
      });
      return {
        response: {
          messages: [
            {
              role: "assistant",
              content: [
                { type: "tool-call", toolCallId: "c1", toolName: "read_text_file", input: { path: "x" } },
              ],
            },
            {
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  toolCallId: "c1",
                  toolName: "read_text_file",
                  output: { type: "json", value: "file contents" },
                },
              ],
            },
            { role: "assistant", content: "Done reading." },
          ],
        },
      };
    }) as never);

    const out = await attemptToolCapableRetry(args());

    expect(out).toEqual({ recovered: true, toolCallOccurred: true });
    expect(chatState.messages.some((m) => m.role === "tool" && m.toolName === "read_text_file")).toBe(true);
    expect(chatState.messages.some((m) => m.role === "assistant" && m.content?.includes("Done reading"))).toBe(
      true
    );
    // Not a single blob — the tool activity is its own persisted message.
    expect(chatState.messages.length).toBeGreaterThan(1);

    expect(mockedPublishChatError).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "chat-1",
        payload: expect.objectContaining({ kind: "turn_recovered_with_tools", recoverable: true }),
      })
    );
    expect(mockedPublishOrchestratorFinished).toHaveBeenCalledWith(
      "chat-1",
      "proj-1",
      "completed",
      "agent_stream_recovered_with_tools"
    );
    expect(vi.mocked(publishUiSyncEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ topic: "files", reason: "agent_turn_finished" })
    );
  });

  it("swarmEnabled:false — no per-tool Swarm-Activity emit", async () => {
    mockedGenerateText.mockImplementationOnce((async (opts: unknown) => {
      const o = opts as { onStepFinish?: (e: unknown) => unknown };
      await o.onStepFinish?.({ toolCalls: [{ toolName: "read_text_file" }], usage: undefined });
      return { response: { messages: [{ role: "assistant", content: "done" }] } };
    }) as never);
    await attemptToolCapableRetry(args({ swarmEnabled: false }));
    const chatTopicCalls = vi
      .mocked(publishUiSyncEvent)
      .mock.calls.filter((c) => c[0].topic === "chat" && c[0].reason?.includes("tool-capable retry"));
    expect(chatTopicCalls).toHaveLength(0);
  });
});
