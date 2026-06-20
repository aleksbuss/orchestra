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

// Hoisted, mutable so each test can script the model's single text output.
const modelOut = vi.hoisted(() => ({ text: "" }));

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
            content: [{ type: "text", text: modelOut.text }],
            finishReason: "stop",
            usage: { inputTokens: { total: 5 }, outputTokens: { total: 5 } },
            warnings: [],
          }) as unknown as LanguageModelV3GenerateResult,
        doStream: async () =>
          ({
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
          }) as never,
      }),
  };
});

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
});
