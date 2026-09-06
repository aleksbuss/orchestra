/**
 * Post-`protake`-review Sprint 0 — primary-stream failure recovery.
 *
 * Covers the 5 safety gates the council review forced onto the original
 * design: silent-failure-only (partial content already streamed must NOT
 * trigger recovery), conditional skipBrainRetry (not a blanket skip),
 * turn-scoped in-flight guard, breaker feeding, and the shared degradation-
 * policy gate.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/agent/final-answer-failover", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent/final-answer-failover")>();
  return {
    ...actual,
    generateFinalAnswerWithFailover: vi.fn(),
  };
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
vi.mock("@/lib/agent/tool-capable-retry", () => ({
  attemptToolCapableRetry: vi.fn(),
}));
// Spread the ORIGINAL for both of these: only one export is under observation,
// and replacing the whole module would hand every other importer in this graph
// an `undefined` where it expects a function.
vi.mock("@/lib/agent/degradation-telemetry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent/degradation-telemetry")>();
  return { ...actual, recordToolChannelDegradation: vi.fn() };
});
vi.mock("@/lib/cost/accumulator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cost/accumulator")>();
  return { ...actual, foldTurnUsage: vi.fn(actual.foldTurnUsage) };
});

import { generateFinalAnswerWithFailover } from "@/lib/agent/final-answer-failover";
import { recordToolChannelDegradation } from "@/lib/agent/degradation-telemetry";
import { foldTurnUsage } from "@/lib/cost/accumulator";
import { attemptToolCapableRetry } from "@/lib/agent/tool-capable-retry";
import { updateChat } from "@/lib/storage/chat-store";
import { publishChatErrorEvent } from "@/lib/realtime/event-bus";
import { publishOrchestratorFinished } from "@/lib/agent/agent-dag-events";
import { resetModelHealth, getModelHealthEntry } from "@/lib/agent/model-health";
import type { AppSettings, Chat, ModelConfig } from "@/lib/types";
import {
  recoverPrimaryStreamFailure,
  isDeterministicClientError,
  type PrimaryStreamRecoveryArgs,
} from "./primary-stream-recovery";

const mockedFailover = vi.mocked(generateFinalAnswerWithFailover);
const mockedToolRetry = vi.mocked(attemptToolCapableRetry);
const mockedUpdateChat = vi.mocked(updateChat);
const mockedPublishChatError = vi.mocked(publishChatErrorEvent);
const mockedPublishOrchestratorFinished = vi.mocked(publishOrchestratorFinished);
const mockedRecordDegradation = vi.mocked(recordToolChannelDegradation);
const mockedFoldTurnUsage = vi.mocked(foldTurnUsage);

const BRAIN: ModelConfig = { provider: "openrouter", model: "vendor/brain:free" };

function settings(): AppSettings {
  return {
    chatModel: { ...BRAIN },
    utilityModel: { provider: "openrouter", model: "vendor/utility:free" },
    embeddingsModel: { provider: "openai", model: "text-embedding-3-small", dimensions: 1536 },
    codeExecution: { enabled: true, timeout: 600, maxOutputLength: 120000 },
    memory: { enabled: true, similarityThreshold: 0.35, maxResults: 10, chunkSize: 400 },
    search: { enabled: false, provider: "none" },
    general: { darkMode: false, language: "en" },
    auth: { enabled: true, username: "a", passwordHash: "h", mustChangeCredentials: false },
  } as AppSettings;
}

/** A 4xx AI_APICallError shape, matching what postmortem.ts's own extractor reads. */
function apiError(statusCode: number, message = "Provider returned error"): Error {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

function baseArgs(overrides: Partial<PrimaryStreamRecoveryArgs> = {}): PrimaryStreamRecoveryArgs {
  return {
    error: apiError(400, "Provider returned error"),
    model: { __model: "brain-handle" } as never,
    brainConfig: BRAIN,
    systemPrompt: "sys",
    messages: [{ role: "user", content: "hi" }],
    providerOptions: undefined,
    settings: settings(),
    chatId: "chat-1",
    projectId: "proj-1",
    partialText: "",
    toolCallOccurred: true,
    swarmEnabled: true,
    maxToolSteps: 100,
    ...overrides,
  };
}

let chatState: Chat;

beforeEach(() => {
  vi.clearAllMocks();
  resetModelHealth();
  chatState = {
    id: "chat-1",
    title: "t",
    messages: [],
    createdAt: "",
    updatedAt: "",
    cumulativeUsage: undefined,
  };
  mockedUpdateChat.mockImplementation(async (_chatId, updater) => {
    chatState = await updater(chatState);
    return chatState;
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isDeterministicClientError", () => {
  it("true for a 400 (the real AtlasCloud shape)", () => {
    expect(isDeterministicClientError(apiError(400))).toBe(true);
  });
  it("true for other 4xx (401, 404, 422)", () => {
    expect(isDeterministicClientError(apiError(401))).toBe(true);
    expect(isDeterministicClientError(apiError(404))).toBe(true);
    expect(isDeterministicClientError(apiError(422))).toBe(true);
  });
  it("false for 429 — a same-endpoint retry can still resolve a rate limit", () => {
    expect(isDeterministicClientError(apiError(429))).toBe(false);
  });
  it("false for 5xx — transient, worth a retry", () => {
    expect(isDeterministicClientError(apiError(500))).toBe(false);
    expect(isDeterministicClientError(apiError(503))).toBe(false);
  });
  it("false when there is no status code at all", () => {
    expect(isDeterministicClientError(new Error("network blip"))).toBe(false);
    expect(isDeterministicClientError("not even an object")).toBe(false);
    expect(isDeterministicClientError(null)).toBe(false);
  });

  // PM #114's sibling bug (found in this same review) — `onError` usually
  // receives an `AI_RetryError` (the SDK's own retry loop exhausted), which has
  // no `statusCode` of its own; the real status sits at `.lastError`. Before
  // this fix, extractStatusCode always saw `undefined` here, so a deterministic
  // 400 could never skip the doomed same-endpoint retry once wrapped.
  it("unwraps an AI_RetryError's .lastError to find the real status", () => {
    const retryErr = Object.assign(new Error("Failed after 4 attempts. Last error: Provider returned error"), {
      name: "AI_RetryError",
      lastError: apiError(400),
    });
    expect(isDeterministicClientError(retryErr)).toBe(true);

    const retryErr429 = Object.assign(new Error("Failed after 4 attempts"), {
      name: "AI_RetryError",
      lastError: apiError(429),
    });
    expect(isDeterministicClientError(retryErr429)).toBe(false);
  });
});

describe("recoverPrimaryStreamFailure — gates", () => {
  it("gate: user abort short-circuits without touching the breaker or calling the ladder", async () => {
    const controller = new AbortController();
    controller.abort();

    const out = await recoverPrimaryStreamFailure(
      baseArgs({ abortSignal: controller.signal })
    );

    expect(out.recovered).toBe(false);
    expect(mockedFailover).not.toHaveBeenCalled();
    expect(getModelHealthEntry(BRAIN.provider, BRAIN.model)).toBeNull();
  });

  it("gate 1: non-empty partialText short-circuits — client already has visible content", async () => {
    const out = await recoverPrimaryStreamFailure(
      baseArgs({ partialText: "The answer starts here and then the stream died" })
    );

    expect(out.recovered).toBe(false);
    expect(mockedFailover).not.toHaveBeenCalled();
  });

  it("gate 1: whitespace-only partialText is treated as empty (still attempts recovery)", async () => {
    mockedFailover.mockResolvedValueOnce({ text: "recovered", usage: undefined });

    const out = await recoverPrimaryStreamFailure(baseArgs({ partialText: "   \n  " }));

    expect(out.recovered).toBe(true);
  });

  it("gate 3: a second concurrent call for the same chat is rejected while one is in flight", async () => {
    let releaseFirst!: (v: { text: string; usage?: undefined }) => void;
    mockedFailover.mockImplementationOnce(
      () => new Promise((resolve) => { releaseFirst = resolve; })
    );

    const firstCall = recoverPrimaryStreamFailure(baseArgs());
    // Second call starts while the first is still awaiting generateFinalAnswerWithFailover.
    const secondCall = recoverPrimaryStreamFailure(baseArgs());

    const second = await secondCall;
    expect(second.recovered).toBe(false);
    expect(mockedFailover).toHaveBeenCalledTimes(1); // the second call never reached the ladder

    releaseFirst({ text: "recovered", usage: undefined });
    const first = await firstCall;
    expect(first.recovered).toBe(true);
  });

  it("gate 4: a classifiable error is recorded into the circuit breaker", async () => {
    mockedFailover.mockResolvedValueOnce({ text: "recovered", usage: undefined });

    await recoverPrimaryStreamFailure(baseArgs({ error: apiError(500, "upstream 500") }));

    const entry = getModelHealthEntry(BRAIN.provider, BRAIN.model);
    expect(entry?.consecutiveFailures).toBe(1);
  });

  it("gate 4: an unclassifiable error (positive-evidence rule) is NOT recorded into the breaker", async () => {
    mockedFailover.mockResolvedValueOnce({ text: "recovered", usage: undefined });
    // "invalid request" is explicitly in classifyModelFailure's "ours, not
    // theirs" negative list — never counted against the endpoint.
    await recoverPrimaryStreamFailure(baseArgs({ error: new Error("invalid request: bad payload") }));

    expect(getModelHealthEntry(BRAIN.provider, BRAIN.model)).toBeNull();
  });

  it("gate 5: quality policy never substitutes — returns false WITHOUT calling the ladder at all", async () => {
    const out = await recoverPrimaryStreamFailure(
      baseArgs({ settings: { ...settings(), degradationPolicy: "quality" } })
    );

    expect(out.recovered).toBe(false);
    expect(mockedFailover).not.toHaveBeenCalled();
  });

  it("gate 5: ask policy never substitutes either", async () => {
    const out = await recoverPrimaryStreamFailure(
      baseArgs({ degradationPolicyOverride: "ask" })
    );

    expect(out.recovered).toBe(false);
    expect(mockedFailover).not.toHaveBeenCalled();
  });

  it("gate 2: a deterministic 4xx sets skipBrainRetry=true on the ladder call", async () => {
    mockedFailover.mockResolvedValueOnce({ text: "recovered", usage: undefined });

    await recoverPrimaryStreamFailure(baseArgs({ error: apiError(400) }));

    expect(mockedFailover).toHaveBeenCalledWith(
      expect.objectContaining({ skipBrainRetry: true })
    );
  });

  it("gate 2: a 429/5xx/unknown error sets skipBrainRetry=false — the retry may still help", async () => {
    mockedFailover.mockResolvedValueOnce({ text: "recovered", usage: undefined });

    await recoverPrimaryStreamFailure(baseArgs({ error: apiError(429) }));

    expect(mockedFailover).toHaveBeenCalledWith(
      expect.objectContaining({ skipBrainRetry: false })
    );
  });
});

// PM #119 — the instruction handed to the substitute must reflect whether
// THIS stream actually ran a tool call, not be unconditional. Live incident:
// the unconditional wording let a substitute confidently fabricate a
// completed task on a turn where nothing had actually run.
describe("recoverPrimaryStreamFailure — anti-fabrication wiring (PM #119)", () => {
  function lastMessageContent(): unknown {
    const call = mockedFailover.mock.calls.at(-1)?.[0];
    const msgs = (call as { messages: Array<{ content: unknown }> }).messages;
    return msgs.at(-1)?.content;
  }

  it("toolCallOccurred=false forces the honest non-completion instruction", async () => {
    mockedFailover.mockResolvedValueOnce({ text: "" });
    await recoverPrimaryStreamFailure(baseArgs({ toolCallOccurred: false }));
    expect(lastMessageContent()).toContain("You have NOT performed any actions this turn");
  });

  it("toolCallOccurred=true keeps the 'steps above' summarize framing", async () => {
    mockedFailover.mockResolvedValueOnce({ text: "" });
    await recoverPrimaryStreamFailure(baseArgs({ toolCallOccurred: true }));
    expect(lastMessageContent()).toContain("You have everything you need from the steps above");
  });
});

describe("recoverPrimaryStreamFailure — tool-capable retry gating", () => {
  const TOOLS = { read_text_file: { description: "x", inputSchema: {}, execute: async () => "" } };

  it("toolCallOccurred=true — tool-capable retry is never attempted, even with tools present", async () => {
    mockedFailover.mockResolvedValueOnce({ text: "" });
    await recoverPrimaryStreamFailure(baseArgs({ toolCallOccurred: true, tools: TOOLS as never }));
    expect(mockedToolRetry).not.toHaveBeenCalled();
  });

  it("toolCallOccurred=false but no tools provided — tool-capable retry is never attempted", async () => {
    mockedFailover.mockResolvedValueOnce({ text: "" });
    await recoverPrimaryStreamFailure(baseArgs({ toolCallOccurred: false, tools: undefined }));
    expect(mockedToolRetry).not.toHaveBeenCalled();
  });

  it("toolCallOccurred=false but tools is an empty object — tool-capable retry is never attempted", async () => {
    mockedFailover.mockResolvedValueOnce({ text: "" });
    await recoverPrimaryStreamFailure(baseArgs({ toolCallOccurred: false, tools: {} as never }));
    expect(mockedToolRetry).not.toHaveBeenCalled();
  });

  it("toolCallOccurred=false + tools present — attempted, and a success short-circuits the tool-less ladder entirely", async () => {
    mockedToolRetry.mockResolvedValueOnce({ recovered: true, toolCallOccurred: true });
    const out = await recoverPrimaryStreamFailure(baseArgs({ toolCallOccurred: false, tools: TOOLS as never }));
    expect(out.recovered).toBe(true);
    expect(mockedFailover).not.toHaveBeenCalled();
  });

  it("a failed retry that itself touched a tool flips the tool-less ladder's instruction to the summarize framing", async () => {
    mockedToolRetry.mockResolvedValueOnce({ recovered: false, toolCallOccurred: true });
    mockedFailover.mockResolvedValueOnce({ text: "" });
    await recoverPrimaryStreamFailure(baseArgs({ toolCallOccurred: false, tools: TOOLS as never }));
    const call = mockedFailover.mock.calls.at(-1)?.[0] as { messages: Array<{ content: unknown }> };
    expect(call.messages.at(-1)?.content).toContain("You have everything you need from the steps above");
  });

  it("a failed retry that touched NO tool keeps the honest non-completion instruction", async () => {
    mockedToolRetry.mockResolvedValueOnce({ recovered: false, toolCallOccurred: false });
    mockedFailover.mockResolvedValueOnce({ text: "" });
    await recoverPrimaryStreamFailure(baseArgs({ toolCallOccurred: false, tools: TOOLS as never }));
    const call = mockedFailover.mock.calls.at(-1)?.[0] as { messages: Array<{ content: unknown }> };
    expect(call.messages.at(-1)?.content).toContain("You have NOT performed any actions this turn");
  });
});

describe("recoverPrimaryStreamFailure — success path", () => {
  it("persists the recovered message, folds usage, and announces turn_recovered", async () => {
    mockedFailover.mockResolvedValueOnce({
      text: "the substitute's answer",
      usage: { totalTokens: 42 },
      notice: "[Agent] brain failed; substitute answered instead.",
    });

    const out = await recoverPrimaryStreamFailure(baseArgs());

    expect(out.recovered).toBe(true);
    expect(chatState.messages).toHaveLength(1);
    expect(chatState.messages[0]).toMatchObject({
      role: "assistant",
      content: "the substitute's answer",
    });
    expect(mockedPublishChatError).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "chat-1",
        payload: expect.objectContaining({
          kind: "turn_recovered",
          message: "[Agent] brain failed; substitute answered instead.",
          recoverable: true,
        }),
      })
    );
    expect(mockedPublishOrchestratorFinished).toHaveBeenCalledWith(
      "chat-1",
      "proj-1",
      "completed",
      "agent_stream_recovered"
    );
  });

  it("PM #122 — publishes 'recovering' BEFORE calling the ladder, so a slow substitute isn't silent to the UI", async () => {
    const callOrder: string[] = [];
    mockedPublishChatError.mockImplementation((input) => {
      callOrder.push(input.payload.kind);
      return {} as never;
    });
    mockedFailover.mockImplementationOnce(async () => {
      callOrder.push("ladder-ran");
      return { text: "the substitute's answer", usage: { totalTokens: 42 } };
    });

    await recoverPrimaryStreamFailure(baseArgs());

    expect(callOrder).toEqual(["recovering", "ladder-ran", "turn_recovered"]);
  });

  it("returns recovered:false when the ladder itself delivers nothing", async () => {
    mockedFailover.mockResolvedValueOnce({ text: "", usage: undefined, notice: "still undeliverable" });

    const out = await recoverPrimaryStreamFailure(baseArgs());

    expect(out.recovered).toBe(false);
    expect(chatState.messages).toHaveLength(0);
    // PM #122 — "recovering" fires once the ladder is ATTEMPTED, regardless of
    // outcome; only "turn_recovered" is gated on an actual success.
    expect(mockedPublishChatError).toHaveBeenCalledTimes(1);
    expect(mockedPublishChatError).not.toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ kind: "turn_recovered" }) })
    );
  });

  it("never claims a recovery the store did not durably persist", async () => {
    mockedFailover.mockResolvedValueOnce({ text: "recovered", usage: undefined });
    mockedUpdateChat.mockRejectedValueOnce(new Error("disk full"));

    const out = await recoverPrimaryStreamFailure(baseArgs());

    expect(out.recovered).toBe(false);
    // Same PM #122 distinction: the attempt was announced, success was not.
    expect(mockedPublishChatError).toHaveBeenCalledTimes(1);
    expect(mockedPublishChatError).not.toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ kind: "turn_recovered" }) })
    );
  });

  it("a cancel that lands mid-recovery is not persisted", async () => {
    const controller = new AbortController();
    mockedFailover.mockImplementationOnce(async () => {
      controller.abort(); // simulate the user cancelling while the substitute generates
      return { text: "recovered", usage: undefined };
    });

    const out = await recoverPrimaryStreamFailure(baseArgs({ abortSignal: controller.signal }));

    expect(out.recovered).toBe(false);
    expect(chatState.messages).toHaveLength(0);
  });
});

/**
 * PM #132 — the residual-markup gate this call site never had.
 *
 * The ladder it calls is tool-less, so a substitute that decides it needs a
 * tool has no channel and prints the call as text. This site persisted whatever
 * came back and shipped raw markup to a user.
 */
describe("recoverPrimaryStreamFailure — residual markup gate (PM #132)", () => {
  /**
   * VERBATIM from the live incident: `data/chats/560896d7-2b36-4877-b5b0-
   * 485bbe1c5e67.json`, message 750b19ea, written 2026-09-06T08:18:21Z by
   * `nvidia/nemotron-3-ultra-550b-a55b:free` after `z-ai/glm-5.2:free` returned
   * empty. Prose preamble first, then three Functionary-form calls, then two
   * closing tags from two OTHER dialects — kept exactly as stored, mangling
   * included, because the whole point is that this is what real degraded output
   * looks like.
   */
  const LIVE_MARKUP =
    "I'll search for recent interesting GitHub projects and trends from the last month.\n" +
    "<function=search_web>\n<parameter=query>\n" +
    "GitHub trending repositories last month 2026 interesting projects ideas\n" +
    "</parameter>\n</function>\n" +
    "<function=search_web>\n<parameter=query>\n" +
    "GitHub awesome projects 2026 September new repositories trending\n" +
    "</parameter>\n</function>\n" +
    "<function=search_web>\n<parameter=query>\n" +
    "site:github.com created:>2026-08-01 stars:>1000 interesting projects\n" +
    "</parameter>\n</function>\n</invoke>\n</minimax:tool_call>";

  const SUBSTITUTE: ModelConfig = {
    provider: "openrouter",
    model: "vendor/substitute:free",
  };

  it("never persists the raw markup — the user gets an honest notice instead", async () => {
    mockedFailover.mockResolvedValueOnce({
      text: LIVE_MARKUP,
      usage: { totalTokens: 275 },
      endpoint: SUBSTITUTE,
      notice: "[Agent] brain returned an empty response — substitute answered instead.",
    });

    const out = await recoverPrimaryStreamFailure(baseArgs());

    expect(out.recovered).toBe(true);
    expect(chatState.messages).toHaveLength(1);
    const content = chatState.messages[0].content;
    expect(content).not.toContain("<function=search_web>");
    expect(content).not.toContain("<parameter=");
    expect(content).not.toContain("minimax");
    // …and it must NAME the tool that did not run, so the user knows the answer
    // would not have been grounded.
    expect(content).toContain("search_web");
  });

  it("does NOT announce 'Answered by a different model' — nothing was answered", async () => {
    mockedFailover.mockResolvedValueOnce({
      text: LIVE_MARKUP,
      usage: undefined,
      endpoint: SUBSTITUTE,
    });

    await recoverPrimaryStreamFailure(baseArgs());

    expect(mockedPublishChatError).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ kind: "turn_degraded" }),
      })
    );
    expect(mockedPublishChatError).not.toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ kind: "turn_recovered" }),
      })
    );
    expect(mockedPublishOrchestratorFinished).toHaveBeenCalledWith(
      "chat-1",
      "proj-1",
      "completed",
      "agent_stream_recovery_degraded"
    );
  });

  it("records the degradation against the SUBSTITUTE, at its own stage", async () => {
    mockedFailover.mockResolvedValueOnce({
      text: LIVE_MARKUP,
      usage: { promptTokens: 15499 },
      endpoint: SUBSTITUTE,
    });

    await recoverPrimaryStreamFailure(baseArgs());

    expect(mockedRecordDegradation).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "stream-recovery",
        chatId: "chat-1",
        provider: SUBSTITUTE.provider,
        model: SUBSTITUTE.model,
        toolName: "search_web",
        promptTokens: 15499,
      })
    );
  });

  it("bills the substitute's tokens to the SUBSTITUTE, not to the brain slot", async () => {
    mockedFailover.mockResolvedValueOnce({
      text: "a perfectly good answer",
      usage: { totalTokens: 42 },
      endpoint: SUBSTITUTE,
    });

    await recoverPrimaryStreamFailure(baseArgs());

    expect(mockedFoldTurnUsage).toHaveBeenCalledWith(
      undefined,
      SUBSTITUTE.provider,
      SUBSTITUTE.model,
      expect.objectContaining({ continuationUsage: { totalTokens: 42 } })
    );
  });

  it("falls back to the brain for billing when the ladder reports no endpoint", async () => {
    mockedFailover.mockResolvedValueOnce({ text: "answer", usage: { totalTokens: 7 } });

    await recoverPrimaryStreamFailure(baseArgs());

    expect(mockedFoldTurnUsage).toHaveBeenCalledWith(
      undefined,
      BRAIN.provider,
      BRAIN.model,
      expect.anything()
    );
  });

  it("a clean answer is persisted verbatim and still announces turn_recovered", async () => {
    mockedFailover.mockResolvedValueOnce({
      text: "Here are three interesting repositories.",
      usage: undefined,
      endpoint: SUBSTITUTE,
      notice: "[Agent] substitute answered instead.",
    });

    const out = await recoverPrimaryStreamFailure(baseArgs());

    expect(out.recovered).toBe(true);
    expect(chatState.messages[0].content).toBe("Here are three interesting repositories.");
    expect(mockedRecordDegradation).not.toHaveBeenCalled();
    expect(mockedPublishChatError).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ kind: "turn_recovered" }),
      })
    );
  });

  it("a mis-emitted `response` call is an ANSWER — unwrapped to prose, not treated as degraded", async () => {
    mockedFailover.mockResolvedValueOnce({
      text: '{"call":"response","arguments":{"message":"The real answer."}}',
      usage: undefined,
      endpoint: SUBSTITUTE,
    });

    const out = await recoverPrimaryStreamFailure(baseArgs());

    expect(out.recovered).toBe(true);
    expect(chatState.messages[0].content).toBe("The real answer.");
    expect(mockedRecordDegradation).not.toHaveBeenCalled();
  });

  it("an answer that is ONLY a <thinking> block persists nothing (the pre-strip check cannot see it)", async () => {
    mockedFailover.mockResolvedValueOnce({
      text: "<thinking>I should probably search the web first.</thinking>",
      usage: undefined,
      endpoint: SUBSTITUTE,
    });

    const out = await recoverPrimaryStreamFailure(baseArgs());

    expect(out.recovered).toBe(false);
    expect(chatState.messages).toHaveLength(0);
    expect(mockedPublishChatError).not.toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ kind: "turn_recovered" }),
      })
    );
  });

  it("markup QUOTED inside a thinking block is not a printed call — the answer still ships", async () => {
    mockedFailover.mockResolvedValueOnce({
      text:
        "<thinking>I could emit <function=search_web><parameter=query>x</parameter></function> " +
        "but I have no tools.</thinking>Here is what I know without searching.",
      usage: undefined,
      endpoint: SUBSTITUTE,
    });

    const out = await recoverPrimaryStreamFailure(baseArgs());

    expect(out.recovered).toBe(true);
    expect(chatState.messages[0].content).toBe("Here is what I know without searching.");
    expect(mockedRecordDegradation).not.toHaveBeenCalled();
  });
});
