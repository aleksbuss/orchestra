/**
 * Tool-capable retry-on-model-swap — see the module's own docstring for the
 * cap=1/no-dedup-needed argument this file assumes rather than re-proves.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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
  selectToolCapableRetryCandidates,
  attemptToolCapableRetry,
  toolRetryDeadlineMs,
  toolRetryCandidateDeadlineMs,
  recoveryToolStepBudget,
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

  describe("toolRetryDeadlineMs", () => {
    afterEach(() => {
      delete process.env.ORCHESTRA_TOOL_RETRY_DEADLINE_MS;
    });

    it("defaults to 60000ms", () => {
      delete process.env.ORCHESTRA_TOOL_RETRY_DEADLINE_MS;
      expect(toolRetryDeadlineMs()).toBe(60_000);
    });

    it("respects valid positive numeric override", () => {
      process.env.ORCHESTRA_TOOL_RETRY_DEADLINE_MS = "45000";
      expect(toolRetryDeadlineMs()).toBe(45_000);
    });

    it("safely falls back on NaN or negative values without throwing", () => {
      process.env.ORCHESTRA_TOOL_RETRY_DEADLINE_MS = "not-a-number";
      expect(toolRetryDeadlineMs()).toBe(60_000);

      process.env.ORCHESTRA_TOOL_RETRY_DEADLINE_MS = "-1000";
      expect(toolRetryDeadlineMs()).toBe(60_000);
    });
  });

  describe("toolRetryCandidateDeadlineMs", () => {
    afterEach(() => {
      delete process.env.ORCHESTRA_TOOL_RETRY_CANDIDATE_DEADLINE_MS;
    });

    it("defaults to 20000ms", () => {
      delete process.env.ORCHESTRA_TOOL_RETRY_CANDIDATE_DEADLINE_MS;
      expect(toolRetryCandidateDeadlineMs()).toBe(20_000);
    });

    it("respects valid positive numeric override", () => {
      process.env.ORCHESTRA_TOOL_RETRY_CANDIDATE_DEADLINE_MS = "15000";
      expect(toolRetryCandidateDeadlineMs()).toBe(15_000);
    });

    it("safely falls back on NaN or negative values without throwing", () => {
      process.env.ORCHESTRA_TOOL_RETRY_CANDIDATE_DEADLINE_MS = "invalid";
      expect(toolRetryCandidateDeadlineMs()).toBe(20_000);

      process.env.ORCHESTRA_TOOL_RETRY_CANDIDATE_DEADLINE_MS = "-500";
      expect(toolRetryCandidateDeadlineMs()).toBe(20_000);
    });
  });

  describe("multi-candidate cascade execution", () => {
    it("selectToolCapableRetryCandidates returns up to limit and prioritizes distinct vendor families", () => {
      __setOpenRouterBenchmarkScoreForTest(
        new Map([
          ["nvidia/frontier:free", { intelligence: 95, coding: 95, agentic: 95 }],
          ["nvidia/second:free", { intelligence: 90, coding: 90, agentic: 90 }],
          ["openai/balanced:free", { intelligence: 85, coding: 85, agentic: 85 }],
          ["qwen/fast:free", { intelligence: 80, coding: 80, agentic: 80 }],
        ])
      );
      const s = settings({
        utilityModel: { provider: "openrouter", model: "nvidia/second:free" },
        proposerTiers: {
          frontier: { provider: "openrouter", model: "nvidia/frontier:free" },
          balanced: { provider: "openrouter", model: "openai/balanced:free" },
          fast: { provider: "openrouter", model: "qwen/fast:free" },
        },
      });
      const candidates = selectToolCapableRetryCandidates(s, BRAIN, 3);
      expect(candidates).toHaveLength(3);
      // First is highest-scoring (nvidia/frontier)
      expect(candidates[0].model).toBe("nvidia/frontier:free");
      // Second and third should pick distinct families (openai, qwen) before second nvidia model
      expect(candidates[1].model).toBe("openai/balanced:free");
      expect(candidates[2].model).toBe("qwen/fast:free");
    });


    it("treats a NON-OpenRouter provider as the family, so one provider cannot fill every slot", () => {
      // Two OpenAI models whose bare NAMES share no prefix ("gpt-…" vs "o4-…").
      // Deriving the family from the model name alone reads those as two
      // different vendors and lets OpenAI take two of the three slots while
      // Anthropic — a genuinely independent upstream — is pushed out.
      __setOpenRouterBenchmarkScoreForTest(
        new Map([
          ["gpt-5.2", { intelligence: 95, coding: 95, agentic: 95 }],
          ["o4-mini", { intelligence: 90, coding: 90, agentic: 90 }],
          ["claude-sonnet-5", { intelligence: 85, coding: 85, agentic: 85 }],
        ])
      );
      const s = settings({
        utilityModel: { provider: "openai", model: "gpt-5.2" },
        proposerTiers: {
          frontier: { provider: "openai", model: "o4-mini" },
          balanced: { provider: "anthropic", model: "claude-sonnet-5" },
          fast: undefined as never,
        },
      });
      // limit 2 over a 3-model pool, so the diversity pass actually runs
      // (at `pool.length <= limit` every candidate is used regardless).
      // Deriving the family from the model name picks the two OpenAI models
      // and leaves the one independent upstream unused.
      const candidates = selectToolCapableRetryCandidates(s, BRAIN, 2);
      expect(candidates.map((c) => `${c.provider}/${c.model}`)).toEqual([
        "openai/gpt-5.2",
        "anthropic/claude-sonnet-5",
      ]);
    });

    it("Candidate #1 fails before executing tools -> Candidate #2 runs with tools and succeeds", async () => {
      const s = settings({
        utilityModel: { provider: "openrouter", model: "vendor1/cand1:free" },
        proposerTiers: {
          frontier: { provider: "openrouter", model: "vendor2/cand2:free" },
          balanced: undefined as never,
          fast: undefined as never,
        },
      });

      // Call 1 (Candidate 1): fails immediately with rate limit (0 tool calls executed)
      mockedGenerateText.mockRejectedValueOnce(new Error("429 Too Many Requests"));

      // Call 2 (Candidate 2): succeeds and executes read_text_file
      mockedGenerateText.mockImplementationOnce((async (opts: unknown) => {
        const o = opts as { onStepFinish?: (e: unknown) => unknown };
        await o.onStepFinish?.({
          toolCalls: [{ toolName: "read_text_file" }],
          usage: { totalTokens: 15 },
        });
        return {
          response: {
            messages: [
              {
                role: "assistant",
                content: [{ type: "tool-call", toolCallId: "c1", toolName: "read_text_file", input: { path: "a.txt" } }],
              },
              {
                role: "tool",
                content: [{ type: "tool-result", toolCallId: "c1", toolName: "read_text_file", output: "hello" }],
              },
              { role: "assistant", content: "File read successfully." },
            ],
          },
        };
      }) as never);

      const out = await attemptToolCapableRetry(args({ settings: s }));

      expect(out).toEqual({ recovered: true, toolCallOccurred: true });
      expect(mockedGenerateText).toHaveBeenCalledTimes(2);
      expect(chatState.messages.some((m) => m.content?.includes("File read successfully"))).toBe(true);
      expect(mockedPublishChatError).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            kind: "turn_recovered_with_tools",
            message: expect.stringContaining("vendor2/cand2:free"),
          }),
        })
      );
    });

    it("Candidate #1 fails, Candidate #2 fails, Candidate #3 succeeds in 3-failover cascade", async () => {
      const s = settings({
        utilityModel: { provider: "openrouter", model: "v1/cand1:free" },
        proposerTiers: {
          frontier: { provider: "openrouter", model: "v2/cand2:free" },
          balanced: { provider: "openrouter", model: "v3/cand3:free" },
          fast: undefined as never,
        },
      });

      // Candidate 1 fails (timeout)
      mockedGenerateText.mockRejectedValueOnce(new Error("Timeout waiting for first token"));
      // Candidate 2 fails (500 internal server error)
      mockedGenerateText.mockRejectedValueOnce(new Error("500 Internal Server Error"));
      // Candidate 3 succeeds!
      mockedGenerateText.mockImplementationOnce((async (opts: unknown) => {
        const o = opts as { onStepFinish?: (e: unknown) => unknown };
        await o.onStepFinish?.({ toolCalls: [{ toolName: "write_text_file" }] });
        return {
          response: {
            messages: [
              {
                role: "assistant",
                content: [{ type: "tool-call", toolCallId: "w1", toolName: "write_text_file", input: { path: "x" } }],
              },
              {
                role: "tool",
                content: [{ type: "tool-result", toolCallId: "w1", toolName: "write_text_file", output: "ok" }],
              },
              { role: "assistant", content: "File written by candidate 3." },
            ],
          },
        };
      }) as never);

      const out = await attemptToolCapableRetry(args({ settings: s }));

      expect(out).toEqual({ recovered: true, toolCallOccurred: true });
      expect(mockedGenerateText).toHaveBeenCalledTimes(3);
      expect(chatState.messages.some((m) => m.content?.includes("File written by candidate 3"))).toBe(true);
      expect(mockedPublishChatError).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            message: expect.stringContaining("v3/cand3:free"),
          }),
        })
      );
    });

    it("Candidate #1 executed tools and crashed -> stops cascade to prevent duplicate side effects", async () => {
      const s = settings({
        utilityModel: { provider: "openrouter", model: "v1/cand1:free" },
        proposerTiers: {
          frontier: { provider: "openrouter", model: "v2/cand2:free" },
          balanced: undefined as never,
          fast: undefined as never,
        },
      });

      // Candidate 1 executed tool calls and then crashed
      mockedGenerateText.mockImplementationOnce((async (opts: unknown) => {
        const o = opts as { onStepFinish?: (e: unknown) => unknown };
        await o.onStepFinish?.({ toolCalls: [{ toolName: "create_file" }] });
        throw new Error("Stream connection dropped mid-execution");
      }) as never);

      const out = await attemptToolCapableRetry(args({ settings: s }));

      // Cascade must STOP to prevent re-executing actions; returns recovered:false with toolCallOccurred:true
      expect(out).toEqual({ recovered: false, toolCallOccurred: true });
      expect(mockedGenerateText).toHaveBeenCalledTimes(1); // Candidate 2 was NOT called!
    });
  });
});

describe("recovery step budget is DERIVED from the attempt deadline (steps and time are one budget)", () => {
  it("never hands the turn's own 100-step allowance to a 20s recovery attempt", () => {
    // 20_000 / 2_000 = 10 affordable steps, clamped by the recovery ceiling.
    expect(recoveryToolStepBudget(100, 20_000)).toBe(8);
  });

  it("shrinks with the deadline, so lowering one budget cannot silently leave the other high", () => {
    expect(recoveryToolStepBudget(100, 6_000)).toBe(3);
    expect(recoveryToolStepBudget(100, 10_000)).toBe(5);
  });

  it("never RAISES what the caller asked for", () => {
    expect(recoveryToolStepBudget(2, 60_000)).toBe(2);
  });

  it("floors at one step — a budget of zero steps could never deliver an answer", () => {
    expect(recoveryToolStepBudget(100, 500)).toBe(1);
  });

  it("the retry DECLARES the derived budget to the model and to stopWhen, not maxToolSteps", async () => {
    __setOpenRouterBenchmarkScoreForTest(
      new Map([["vendor/utility:free", { intelligence: 90, coding: 90, agentic: 90 }]])
    );

    let captured: { stopWhen?: unknown[] } | undefined;
    mockedGenerateText.mockImplementationOnce((async (opts: unknown) => {
      captured = opts as { stopWhen?: unknown[] };
      return { response: { messages: [{ role: "assistant", content: "recovered" }] } };
    }) as never);

    await attemptToolCapableRetry(args({ maxToolSteps: 100 }));

    const stepStop = captured?.stopWhen?.[0] as (o: { steps: unknown[] }) => boolean;
    // The SDK's `stepCountIs(n)` is `steps.length === n` (verified in
    // `ai/dist/index.mjs`, not assumed), so probe the exact trip point rather
    // than reading a number the SDK does not expose.
    expect(stepStop({ steps: Array(8).fill({}) })).toBe(true);
    expect(stepStop({ steps: Array(7).fill({}) })).toBe(false);
    // Discriminates against the defect: with the turn's own budget the stop
    // would trip at 100 and NOT at 8.
    expect(stepStop({ steps: Array(100).fill({}) })).toBe(false);
  });
});
