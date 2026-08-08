/**
 * §10 integration scaffold — drives `runAgentText` (the non-streaming agent
 * entry; shares the settings → createModel → tool-assembly+loop-guard →
 * generateText → response-extraction machinery with the interactive `runAgent`)
 * END-TO-END against a mock model. A regression in any extracted seam
 * (agent-messages conversion, agent-tools assembly, the loop-guard wrap,
 * agent-response unwrap/extraction, createModel dispatch) blows up HERE before a
 * decomposition PR can merge. Network-free; isolated `ORCHESTRA_DATA_DIR`.
 *
 * Covers BOTH agent paths against the SAME mock model:
 *   - generateText (`runAgentText`) — asserts the returned answer.
 *   - streamText (`runAgent`, interactive) — asserts `onFinish` PERSISTS the
 *     assistant message to disk. This is the streamText variant the §10 plan
 *     named as the prerequisite for the `agent-stream` seam cut.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { MockLanguageModelV3 } from "ai/test";
import { simulateReadableStream } from "ai";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";

// Hoisted, mutable so each test can script the model's text output. `genText`
// (when set) is the `doGenerate` output ONLY — letting a test give the streamed
// turn (doStream) and a subsequent generateText (e.g. the PM #81 re-issue) DIFFERENT
// outputs. Defaults to `text` so existing tests are unaffected.
//
// `steps` is the MULTI-STEP extension. `doStream` is invoked once per agent
// step, so an array of scripted steps drives a real tool loop: each entry
// becomes one upstream response. Leave it undefined and the mock behaves
// exactly as before (one text step) — the four original tests are untouched.
//
// NOTE on usage shape — there are TWO shapes, one per layer, and mixing them
// silently yields zeros rather than an error:
//   - PROVIDER (`LanguageModelV3Usage`, what a `doStream` finish chunk carries)
//     is NESTED: `inputTokens: { total, noCache, cacheRead, cacheWrite }`.
//   - SDK (`LanguageModelUsage`, what `onStepFinish`'s `event.usage` carries)
//     is FLAT: `inputTokens: number | undefined`, details moved to
//     `inputTokenDetails`. The SDK flattens provider → SDK for us, which is why
//     the accumulator's `RawUsage` correctly reads flat numbers.
// A mock emits at the PROVIDER layer, so scripted usage is written nested here
// and asserted flat after the fold. Emitting flat numbers here makes the SDK
// read `.total` off a number, yielding `undefined` → a silent zero.
type ScriptedStep = {
  /** Emit a tool-call part — this is what makes the SDK run another step. */
  toolCall?: { toolName: string; input: Record<string, unknown> };
  /** Emit text deltas. */
  text?: string;
  /** Per-step usage, in the flat shape the accumulator actually reads. */
  usage?: { inputTokens: number; outputTokens: number };
  /** Defaults to "tool-calls" when `toolCall` is set, else "stop". */
  finishReason?: "stop" | "tool-calls" | "length";
  /** Emit an `error` part instead of finishing — the mid-loop crash case. */
  fail?: string;
};

const modelOut = vi.hoisted(() => ({
  text: "",
  genText: undefined as string | undefined,
  steps: undefined as unknown[] | undefined,
  stepCursor: 0,
}));

/** Build the provider-level chunk sequence for one scripted step. */
function chunksForStep(step: ScriptedStep): unknown[] {
  const chunks: unknown[] = [{ type: "stream-start", warnings: [] }];
  if (step.text) {
    chunks.push(
      { type: "text-start", id: "0" },
      { type: "text-delta", id: "0", delta: step.text },
      { type: "text-end", id: "0" }
    );
  }
  if (step.toolCall) {
    chunks.push({
      type: "tool-call",
      toolCallId: `call-${Math.random().toString(36).slice(2, 10)}`,
      toolName: step.toolCall.toolName,
      input: JSON.stringify(step.toolCall.input),
    });
  }
  if (step.fail) {
    chunks.push({ type: "error", error: new Error(step.fail) });
    return chunks;
  }
  const u = step.usage ?? { inputTokens: 5, outputTokens: 5 };
  chunks.push({
    type: "finish",
    finishReason: step.finishReason ?? (step.toolCall ? "tool-calls" : "stop"),
    // Provider-layer (nested) shape — see the note above.
    usage: {
      inputTokens: { total: u.inputTokens, noCache: u.inputTokens, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: u.outputTokens, reasoning: 0 },
      totalTokens: u.inputTokens + u.outputTokens,
    },
  });
  return chunks;
}

// Mock ONLY the model factory so the real generate/stream paths run against a
// deterministic model — everything else (tools, prompt, conversion, persistence)
// is real. One mock serves BOTH doGenerate (generateText path) and doStream
// (streamText path), both scripted from the same `modelOut.text`.
vi.mock("@/lib/providers/llm-provider", async (orig) => {
  const actual = await orig<typeof import("@/lib/providers/llm-provider")>();
  return {
    ...actual,
    createModel: () =>
      new MockLanguageModelV3({
        doGenerate: async () =>
          ({
            content: [{ type: "text", text: modelOut.genText ?? modelOut.text }],
            finishReason: "stop",
            usage: { inputTokens: { total: 5 }, outputTokens: { total: 5 } },
            warnings: [],
          }) as unknown as LanguageModelV3GenerateResult,
        doStream: async () => {
          // Scripted multi-step mode: one entry per agent step. Past the end we
          // repeat the last entry so a runaway loop terminates on a "stop"
          // rather than hanging the test.
          if (modelOut.steps) {
            const scripted = modelOut.steps as ScriptedStep[];
            const step = scripted[modelOut.stepCursor] ?? scripted[scripted.length - 1];
            modelOut.stepCursor += 1;
            return {
              stream: simulateReadableStream({ chunks: chunksForStep(step) as never[] }),
            } as never;
          }
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start", warnings: [] },
                { type: "text-start", id: "0" },
                { type: "text-delta", id: "0", delta: modelOut.text },
                { type: "text-end", id: "0" },
                {
                  type: "finish",
                  finishReason: "stop",
                  usage: { inputTokens: { total: 5 }, outputTokens: { total: 5 } },
                },
              ],
            }),
          } as never;
        },
      }),
  };
});

// ── Observation seams for the billing + watchdog contracts ──────────────────
//
// `foldTurnUsage` is the ONE place both callers fold spend, and they pass
// DISJOINT keys: `onStepFinish` passes `{ streamUsage }`, `onFinish` passes
// `{ continuationUsage, reissueUsage, turnExtraUsage }` and — deliberately —
// never `streamUsage` (agent.ts:1207 "We no longer extract it here to avoid
// double-counting"). Recording the `sources` shape therefore pins the
// EXCLUSION directly, instead of doing arithmetic over a mutable store where a
// double-count plus a compensating under-count would still sum correctly.
const foldCalls = vi.hoisted(() => ({ sources: [] as Array<Record<string, unknown>> }));

vi.mock("@/lib/cost/accumulator", async (orig) => {
  const actual = await orig<typeof import("@/lib/cost/accumulator")>();
  return {
    ...actual,
    foldTurnUsage: (
      base: Parameters<typeof actual.foldTurnUsage>[0],
      provider: string,
      modelId: string,
      sources: Parameters<typeof actual.foldTurnUsage>[3]
    ) => {
      foldCalls.sources.push(sources as unknown as Record<string, unknown>);
      return actual.foldTurnUsage(base, provider, modelId, sources);
    },
  };
});

// The watchdog is wrapped, not replaced — the real timers still run, we only
// count `noteStepBoundary`. A Proxy is required rather than a spread: the
// returned object exposes `stalled` as a GETTER, and spreading would snapshot
// it to a frozen value.
const watchdogCalls = vi.hoisted(() => ({ stepBoundaries: 0 }));

vi.mock("@/lib/agent/stream-watchdog", async (orig) => {
  const actual = await orig<typeof import("@/lib/agent/stream-watchdog")>();
  return {
    ...actual,
    createStreamWatchdog: (
      ...args: Parameters<typeof actual.createStreamWatchdog>
    ): ReturnType<typeof actual.createStreamWatchdog> => {
      const real = actual.createStreamWatchdog(...args);
      return new Proxy(real, {
        get(target, prop, receiver) {
          if (prop === "noteStepBoundary") {
            return () => {
              watchdogCalls.stepBoundaries += 1;
              return target.noteStepBoundary();
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    },
  };
});

// Fault injection for the "a billing write that fails must not kill the turn"
// contract. Default 0 → real behaviour, so the pre-existing tests are unaffected.
const chatStoreFaults = vi.hoisted(() => ({ failNextUpdateChat: 0 }));

vi.mock("@/lib/storage/chat-store", async (orig) => {
  const actual = await orig<typeof import("@/lib/storage/chat-store")>();
  return {
    ...actual,
    updateChat: (...args: Parameters<typeof actual.updateChat>) => {
      if (chatStoreFaults.failNextUpdateChat > 0) {
        chatStoreFaults.failNextUpdateChat -= 1;
        return Promise.reject(new Error("scripted updateChat failure"));
      }
      return actual.updateChat(...args);
    },
  };
});

/** Reset every scripted/observed bit of state between tests. */
function resetHarness() {
  modelOut.steps = undefined;
  modelOut.stepCursor = 0;
  modelOut.genText = undefined;
  foldCalls.sources.length = 0;
  watchdogCalls.stepBoundaries = 0;
  chatStoreFaults.failNextUpdateChat = 0;
}

/** Total prompt+completion tokens the accumulator recorded for a chat. */
function totalTokens(usage: { promptTokens?: number; completionTokens?: number } | undefined) {
  return (usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0);
}

/** Drain a runAgent result, tolerating a scripted mid-stream failure. */
async function drain(result: { textStream: AsyncIterable<string> }) {
  try {
    for await (const _chunk of result.textStream) void _chunk;
  } catch {
    // A scripted `error` part surfaces here; the assertions care about what
    // the agent PERSISTED before dying, not about the rejection itself.
  }
}

let tmpDir: string;
let originalDataDir: string | undefined;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-integ-"));
  originalDataDir = process.env.ORCHESTRA_DATA_DIR;
  process.env.ORCHESTRA_DATA_DIR = tmpDir;
  await fs.mkdir(path.join(tmpDir, "settings"), { recursive: true });
  await fs.writeFile(
    path.join(tmpDir, "settings", "settings.json"),
    JSON.stringify({
      chatModel: { provider: "openai", model: "gpt-4o", apiKey: "k", authMethod: "api_key" },
      utilityModel: { provider: "openai", model: "gpt-4o-mini", apiKey: "k" },
      embeddingsModel: {
        provider: "openai",
        model: "text-embedding-3-small",
        dimensions: 1536,
      },
      search: { enabled: false, provider: "none" },
      swarmEnabled: false,
    })
  );
});

afterAll(async () => {
  if (originalDataDir === undefined) delete process.env.ORCHESTRA_DATA_DIR;
  else process.env.ORCHESTRA_DATA_DIR = originalDataDir;
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

describe("agent integration — runAgentText end-to-end (mock model, no network)", () => {
  it("settings → createModel → tools+loop-guard → generateText → extraction returns the answer", async () => {
    modelOut.text = "INTEGRATION_OK";
    const { runAgentText } = await import("./agent");
    const text = await runAgentText({ chatId: `integ-${Date.now()}`, userMessage: "ping" });
    expect(text).toBe("INTEGRATION_OK");
  });

  it("exercises the agent-response seam — a text-serialized `response` call is unwrapped (PM #61)", async () => {
    // The model emits the answer as a serialized response-tool blob (the deepseek
    // -under-MoA failure shape). The real path must route it through
    // unwrapSerializedResponseCall (now in agent-response.ts) before returning.
    modelOut.text = '{"call":"response","arguments":{"message":"UNWRAPPED ANSWER"}}';
    const { runAgentText } = await import("./agent");
    const text = await runAgentText({ chatId: `integ-${Date.now()}`, userMessage: "ping" });
    expect(text).toBe("UNWRAPPED ANSWER");
  });
});

describe("agent integration — runAgent streamText path persists onFinish (mock model)", () => {
  it("interactive runAgent → consume stream → onFinish persists the assistant message to disk", async () => {
    modelOut.text = "STREAM_PERSISTED_OK";
    const chatId = `integ-stream-${Date.now()}`;
    const { runAgent } = await import("./agent");
    const { createChat, getChat, flushAllPendingChats } = await import("@/lib/storage/chat-store");

    // Mirror the route: the chat must exist on disk before runAgent, or its
    // `onFinish → updateChat` is a silent no-op (updateChat doesn't create).
    await createChat(chatId, "integ-stream");

    // Interactive (streamText) entry — returns a StreamTextResult.
    const result = await runAgent({ chatId, userMessage: "ping", swarmEnabled: false });

    // Consuming the stream to completion is what fires `onFinish` (the single
    // persistence chokepoint). Iterating textStream is the universally-available
    // way to drain it.
    for await (const _chunk of result.textStream) {
      void _chunk;
    }

    // `onFinish` is async + chat-store debounces disk writes (PM #29). Poll the
    // store (in-memory authoritative) until the assistant turn lands, then force
    // the debounced flush and assert it reached DISK.
    let persisted = false;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const chat = await getChat(chatId);
      if (chat?.messages.some((m) => m.role === "assistant" && m.content.includes("STREAM_PERSISTED_OK"))) {
        persisted = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(persisted, "onFinish must persist the assistant message").toBe(true);

    // Prove it survived to the on-disk JSON (the canonical source of truth),
    // not just the in-memory cache.
    await flushAllPendingChats();
    const raw = await fs.readFile(path.join(tmpDir, "chats", `${chatId}.json`), "utf8");
    const onDisk = JSON.parse(raw) as { messages: Array<{ role: string; content: string }> };
    expect(
      onDisk.messages.some((m) => m.role === "assistant" && m.content.includes("STREAM_PERSISTED_OK"))
    ).toBe(true);
  });

  it("PM #81: a streamed hallucinated tool call is SUPPRESSED and re-issued (onFinish wiring)", async () => {
    // The stream emits a printed-as-text tool call (the degradation). The
    // onFinish self-heal must: detect it, drop the markup so it never persists,
    // re-issue (doGenerate → a clean answer), and persist THAT. This is the
    // agent.ts plumbing the deleted live throwaway covered behaviorally but no
    // committed test exercised.
    modelOut.text =
      '<tool_call>{"name":"write_text_file","arguments":{"file_path":"x.ts","content":"y"}}</tool_call>';
    modelOut.genText = "Done — I created x.ts via the re-issue.";
    const chatId = `integ-pm81-${Date.now()}`;
    const { runAgent } = await import("./agent");
    const { createChat, getChat, flushAllPendingChats } = await import("@/lib/storage/chat-store");
    await createChat(chatId, "integ-pm81");

    try {
      const result = await runAgent({ chatId, userMessage: "write x.ts", swarmEnabled: false });
      for await (const _chunk of result.textStream) void _chunk;

      let chat = null as Awaited<ReturnType<typeof getChat>> | null;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        chat = await getChat(chatId);
        if (chat?.messages.some((m) => m.role === "assistant" && m.content.includes("re-issue"))) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      await flushAllPendingChats();
      const assistantText = (chat?.messages ?? [])
        .filter((m) => m.role === "assistant")
        .map((m) => m.content)
        .join("\n");

      // The raw markup must NOT reach the user …
      expect(assistantText).not.toContain("<tool_call>");
      // … and the re-issued clean answer must be persisted instead.
      expect(assistantText).toContain("re-issue");
    } finally {
      modelOut.genText = undefined; // don't leak into other tests
    }
  });
});

/**
 * The `onStepFinish` contract — the §10 seam plan's named prerequisite for
 * extracting the `streamText` call out of `runAgent`.
 *
 * `onStepFinish` (agent.ts:925-980) does three independent things, none of
 * which had a direct test: it re-arms the TTFT watchdog per step, it folds
 * that step's usage into the chat's cumulative (PM #81 incremental billing),
 * and it emits one Swarm-Activity line per tool call (PM #96). Its two
 * try/catch blocks exist so neither a failed billing write nor a failed
 * telemetry emit can kill a turn.
 *
 * The billing half is a TWO-SIDED contract: accumulate per step AND do not
 * re-count at the end. A regression on either side is silent and denominated
 * in money.
 */
describe("agent integration — onStepFinish contract (multi-step, mock model)", () => {
  const STEP_USAGE = [
    { inputTokens: 11, outputTokens: 3 },
    { inputTokens: 22, outputTokens: 7 },
    { inputTokens: 33, outputTokens: 13 },
  ];
  // Deliberately distinct per step: with equal values, an off-by-one in the
  // accumulation (2 of 3 steps counted) could coincide with a plausible total.
  const EXPECTED_TOTAL = STEP_USAGE.reduce((n, u) => n + u.inputTokens + u.outputTokens, 0);

  /** Two tool-call steps then a final text step → a real 3-step tool loop. */
  function threeStepScript(): ScriptedStep[] {
    return [
      { toolCall: { toolName: "read_text_file", input: { file_path: "no-such-file-1.txt" } }, usage: STEP_USAGE[0] },
      { toolCall: { toolName: "read_text_file", input: { file_path: "no-such-file-2.txt" } }, usage: STEP_USAGE[1] },
      { text: "MULTI_STEP_DONE", usage: STEP_USAGE[2] },
    ];
  }

  async function runScripted(script: ScriptedStep[], chatId: string, swarmEnabled = false) {
    resetHarness();
    modelOut.steps = script;
    const { runAgent } = await import("./agent");
    const { createChat } = await import("@/lib/storage/chat-store");
    await createChat(chatId, "onstepfinish");
    const result = await runAgent({ chatId, userMessage: "go", swarmEnabled });
    await drain(result);
    return result;
  }

  /** Poll until `predicate` holds on the stored chat, then return it. */
  async function waitForChat(
    chatId: string,
    predicate: (c: NonNullable<Awaited<ReturnType<typeof import("@/lib/storage/chat-store").getChat>>>) => boolean
  ) {
    const { getChat } = await import("@/lib/storage/chat-store");
    const deadline = Date.now() + 5000;
    let chat = await getChat(chatId);
    while (Date.now() < deadline) {
      if (chat && predicate(chat)) return chat;
      await new Promise((r) => setTimeout(r, 25));
      chat = await getChat(chatId);
    }
    return chat;
  }

  it("accumulates EVERY step's usage, not just the last (PM #81 incremental billing)", async () => {
    const chatId = `integ-bill-sum-${Date.now()}`;
    await runScripted(threeStepScript(), chatId);

    const chat = await waitForChat(chatId, (c) => totalTokens(c.cumulativeUsage) >= EXPECTED_TOTAL);
    expect(totalTokens(chat?.cumulativeUsage)).toBe(EXPECTED_TOTAL);
  });

  it("does NOT re-count the main stream in onFinish (agent.ts:1207 double-count exclusion)", async () => {
    const chatId = `integ-bill-once-${Date.now()}`;
    await runScripted(threeStepScript(), chatId);
    await waitForChat(chatId, (c) => totalTokens(c.cumulativeUsage) >= EXPECTED_TOTAL);

    // onStepFinish is the ONLY caller allowed to pass `streamUsage`, once per step.
    const streamFolds = foldCalls.sources.filter((s) => s.streamUsage != null);
    expect(streamFolds).toHaveLength(STEP_USAGE.length);

    // onFinish folds the OTHER surfaces — and must never carry streamUsage.
    // This pins the exclusion directly; summing the store could not tell a
    // double-count apart from a double-count plus a compensating under-count.
    const finishFolds = foldCalls.sources.filter(
      (s) => "continuationUsage" in s || "reissueUsage" in s || "turnExtraUsage" in s
    );
    expect(finishFolds.length).toBeGreaterThan(0);
    expect(finishFolds.every((s) => s.streamUsage == null)).toBe(true);
  });

  it("keeps the spend from completed steps when the loop CRASHES mid-flight", async () => {
    // Exactly the scenario the PM #81 comment names: "if a multi-step loop
    // crashes on step 3, onFinish might not fire or might drop usage".
    const chatId = `integ-bill-crash-${Date.now()}`;
    const survived = STEP_USAGE[0].inputTokens + STEP_USAGE[0].outputTokens
      + STEP_USAGE[1].inputTokens + STEP_USAGE[1].outputTokens;

    await runScripted(
      [
        { toolCall: { toolName: "read_text_file", input: { file_path: "a.txt" } }, usage: STEP_USAGE[0] },
        { toolCall: { toolName: "read_text_file", input: { file_path: "b.txt" } }, usage: STEP_USAGE[1] },
        { fail: "upstream exploded on step 3" },
      ],
      chatId
    );

    const chat = await waitForChat(chatId, (c) => totalTokens(c.cumulativeUsage) >= survived);

    // Assert on what onStepFinish itself folded, NOT on the chat total. A
    // crashed turn leaves no deliverable answer, so the recovery ladder runs a
    // generateText that legitimately bills on top — an exact-total assertion
    // would be pinning the recovery path's spend, not this contract.
    const streamed = foldCalls.sources
      .map((s) => s.streamUsage as { inputTokens?: number; outputTokens?: number } | null)
      .filter((u): u is { inputTokens?: number; outputTokens?: number } => u != null)
      .reduce((n, u) => n + (u.inputTokens ?? 0) + (u.outputTokens ?? 0), 0);
    expect(streamed).toBe(survived);

    // And it reached the chat: the completed steps' spend is not lost.
    expect(totalTokens(chat?.cumulativeUsage)).toBeGreaterThanOrEqual(survived);
  });

  it("re-arms the stall watchdog once per step, not once per turn (PM #98)", async () => {
    // Each step opens a FRESH upstream request that can hang exactly like the
    // first. Without the per-step re-arm the turn is unbounded from step 2 on.
    const chatId = `integ-watchdog-${Date.now()}`;
    await runScripted(threeStepScript(), chatId);
    await waitForChat(chatId, (c) => totalTokens(c.cumulativeUsage) >= EXPECTED_TOTAL);
    expect(watchdogCalls.stepBoundaries).toBe(3);
  });

  // ⚠️ NOT a test of agent.ts's try/catch, despite covering that line.
  // Mutation-verified 2026-08: making the `catch` around the step-usage write
  // rethrow leaves this test GREEN, because `ai@6` ALSO wraps the onStepFinish
  // invocation in its own try/catch and routes the rejection to `onError`. The
  // agent-side catch is a second line of defence, and no test written at this
  // level can distinguish it from the SDK's. What this DOES pin is the
  // end-to-end property — a chat-store write failing mid-stream must not cost
  // the user their answer — which holds today for two independent reasons and
  // would go red if either disappeared along with the other. Kept deliberately
  // under the "justify in writing" half of the mutation-verify rule.
  it("still delivers the answer when a chat-store write fails mid-stream", async () => {
    const chatId = `integ-bill-fault-${Date.now()}`;
    resetHarness();
    modelOut.steps = threeStepScript();

    const { runAgent } = await import("./agent");
    const { createChat } = await import("@/lib/storage/chat-store");
    await createChat(chatId, "bill-fault");
    const result = await runAgent({ chatId, userMessage: "go", swarmEnabled: false });
    // Arm the fault only AFTER runAgent has done its pre-stream writes (it
    // persists the user turn before returning the stream). Arming earlier hits
    // that write instead of the step-usage one and proves nothing about
    // onStepFinish.
    chatStoreFaults.failNextUpdateChat = 1; // the FIRST step's usage write throws
    await drain(result);

    // The turn still delivered and still persisted its answer.
    const chat = await waitForChat(chatId, (c) =>
      c.messages.some((m) => m.role === "assistant" && m.content.includes("MULTI_STEP_DONE"))
    );
    expect(
      chat?.messages.some((m) => m.role === "assistant" && m.content.includes("MULTI_STEP_DONE"))
    ).toBe(true);
  });

  it("tolerates a step that reports no usage without corrupting the total", async () => {
    // A step with absent usage must contribute zero — never NaN, which would
    // poison the cost banner and the per-chat USD cap for the whole chat.
    const chatId = `integ-bill-nousage-${Date.now()}`;
    resetHarness();
    modelOut.steps = [
      { toolCall: { toolName: "read_text_file", input: { file_path: "a.txt" } }, usage: { inputTokens: 0, outputTokens: 0 } },
      { text: "NO_USAGE_OK", usage: STEP_USAGE[0] },
    ];
    const { runAgent } = await import("./agent");
    const { createChat } = await import("@/lib/storage/chat-store");
    await createChat(chatId, "bill-nousage");
    const result = await runAgent({ chatId, userMessage: "go", swarmEnabled: false });
    await drain(result);

    const expected = STEP_USAGE[0].inputTokens + STEP_USAGE[0].outputTokens;
    const chat = await waitForChat(chatId, (c) => totalTokens(c.cumulativeUsage) >= expected);
    const total = totalTokens(chat?.cumulativeUsage);
    expect(Number.isNaN(total)).toBe(false);
    expect(total).toBe(expected);
  });
});
