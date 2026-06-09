/**
 * §10 integration scaffold — drives `runAgentText` (the non-streaming agent
 * entry; shares the settings → createModel → tool-assembly+loop-guard →
 * generateText → response-extraction machinery with the interactive `runAgent`)
 * END-TO-END against a mock model. A regression in any extracted seam
 * (agent-messages conversion, agent-tools assembly, the loop-guard wrap,
 * agent-response unwrap/extraction, createModel dispatch) blows up HERE before a
 * decomposition PR can merge. Network-free; isolated `ORCHESTRA_DATA_DIR`.
 *
 * NOTE: this covers the generateText path. The streamText path (the future
 * agent-stream seam) needs a streaming variant — build it alongside that
 * extraction.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";

// Hoisted, mutable so each test can script the model's single text output.
const modelOut = vi.hoisted(() => ({ text: "" }));

// Mock ONLY the model factory so the real generateText runs against a
// deterministic model — everything else (tools, prompt, conversion) is real.
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
