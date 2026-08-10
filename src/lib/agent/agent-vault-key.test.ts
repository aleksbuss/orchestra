/**
 * Regression: the brain's API key must resolve from the Settings → API Keys
 * Vault on the ORDINARY path — no preset involved.
 *
 * THE BUG THIS PINS. `runAgent` resolved the vault key inside
 *
 *     if (options.preset && options.preset !== "custom" && !cfg.apiKey) { … }
 *
 * and `PresetTier` has exactly ONE member: `"custom"`. The second clause could
 * therefore never be true, so the block was unreachable and the vault was never
 * consulted for the brain. `createModel` only knows two sources — an explicit
 * `config.apiKey` and `process.env[…]` — so a user whose key lived ONLY in the
 * vault got `API Key is missing for <provider>` on every single turn. Free Mode
 * always lands here: its overlay produces `{ provider, model }` with no key by
 * design, which is why "the free models button does nothing" and "swarm always
 * errors" were one defect, not two (swarm builds the brain first and threw
 * before MoA ever started).
 *
 * WHY THE ASSERTION IS ON `createModel`'s ARGUMENT. That is the boundary where
 * the key either exists or does not; asserting on a thrown message instead
 * would pass just as well if the key arrived from the environment, which is
 * the exact confound that hid the bug for the whole life of the repo.
 * `OPENROUTER_API_KEY` is therefore deleted for the duration of each test.
 *
 * Network-free; isolated `ORCHESTRA_DATA_DIR`.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { MockLanguageModelV3 } from "ai/test";
import { simulateReadableStream } from "ai";
import type { ModelConfig } from "@/lib/types";

/** Every ModelConfig handed to `createModel`, in call order. */
const created = vi.hoisted(() => ({ configs: [] as ModelConfig[] }));

vi.mock("@/lib/providers/llm-provider", async (orig) => {
  const actual = await orig<typeof import("@/lib/providers/llm-provider")>();
  return {
    ...actual,
    createModel: (config: ModelConfig) => {
      created.configs.push(config);
      return new MockLanguageModelV3({
        // `runAgentText` takes the non-streaming path; the streaming one is
        // scripted too so this file keeps working if the caller changes.
        doGenerate: async () =>
          ({
            content: [{ type: "text", text: "VAULT_OK" }],
            finishReason: "stop",
            usage: { inputTokens: { total: 5 }, outputTokens: { total: 5 } },
            warnings: [],
          }) as never,
        doStream: async () =>
          ({
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start", warnings: [] },
                { type: "text-start", id: "0" },
                { type: "text-delta", id: "0", delta: "VAULT_OK" },
                { type: "text-end", id: "0" },
                {
                  type: "finish",
                  finishReason: "stop",
                  usage: { inputTokens: { total: 5 }, outputTokens: { total: 5 } },
                },
              ],
            }),
          }) as never,
      });
    },
  };
});

let tmpDir: string;
let originalDataDir: string | undefined;
let originalEnvKey: string | undefined;

/** Rewrite the settings file the agent will read on the next turn. */
async function writeSettings(extra: Record<string, unknown>): Promise<void> {
  await fs.writeFile(
    path.join(tmpDir, "settings", "settings.json"),
    JSON.stringify({
      utilityModel: { provider: "openai", model: "gpt-4o-mini", apiKey: "k" },
      embeddingsModel: { provider: "openai", model: "text-embedding-3-small", dimensions: 1536 },
      search: { enabled: false, provider: "none" },
      swarmEnabled: false,
      ...extra,
    })
  );
}

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-vault-"));
  originalDataDir = process.env.ORCHESTRA_DATA_DIR;
  process.env.ORCHESTRA_DATA_DIR = tmpDir;
  await fs.mkdir(path.join(tmpDir, "settings"), { recursive: true });
});

beforeEach(() => {
  created.configs.length = 0;
  // The whole point: with the env key present, a broken vault lookup is
  // invisible because `createModel` falls through to `process.env`.
  originalEnvKey = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
});

afterAll(async () => {
  if (originalDataDir === undefined) delete process.env.ORCHESTRA_DATA_DIR;
  else process.env.ORCHESTRA_DATA_DIR = originalDataDir;
  if (originalEnvKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalEnvKey;
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

describe("runAgent — brain key resolution (no preset)", () => {
  it("takes the key from the provider vault when the model config carries none", async () => {
    await writeSettings({
      chatModel: { provider: "openrouter", model: "nvidia/nemotron-nano-9b-v2:free" },
      providerApiKeys: { openrouter: "vault-key-123" },
    });

    const { runAgentText } = await import("./agent");
    await runAgentText({ chatId: `vault-${Date.now()}`, userMessage: "ping" });

    const brain = created.configs[0];
    expect(brain?.provider).toBe("openrouter");
    expect(brain?.apiKey).toBe("vault-key-123");
  });

  it("prefers an explicit config key over the vault", async () => {
    await writeSettings({
      chatModel: {
        provider: "openrouter",
        model: "nvidia/nemotron-nano-9b-v2:free",
        apiKey: "explicit-key",
      },
      providerApiKeys: { openrouter: "vault-key-123" },
    });

    const { runAgentText } = await import("./agent");
    await runAgentText({ chatId: `vault-${Date.now()}`, userMessage: "ping" });

    expect(created.configs[0]?.apiKey).toBe("explicit-key");
  });

  // `runAgentText` and `runAgent` resolve the brain SEPARATELY — the streaming
  // entry is the one the chat UI and the Free Mode button actually use, and it
  // carried its own copy of the defect. Asserting only through `runAgentText`
  // leaves that copy unpinned: verified by mutation — reverting the `runAgent`
  // fix alone kept the text-path tests green.
  it("resolves the vault key on the STREAMING entry too (this is the path the chat UI uses)", async () => {
    await writeSettings({
      chatModel: { provider: "openrouter", model: "nvidia/nemotron-nano-9b-v2:free" },
      providerApiKeys: { openrouter: "vault-key-123" },
    });

    const chatId = `vault-stream-${Date.now()}`;
    const { createChat } = await import("@/lib/storage/chat-store");
    await createChat(chatId, "vault-stream");

    const { runAgent } = await import("./agent");
    const result = await runAgent({ chatId, userMessage: "ping", swarmEnabled: false });
    for await (const _chunk of result.textStream) void _chunk;

    expect(created.configs[0]?.apiKey).toBe("vault-key-123");
  });

  it("leaves the key undefined when neither vault nor config has one, so createModel's env fallback still owns that case", async () => {
    await writeSettings({
      chatModel: { provider: "openrouter", model: "nvidia/nemotron-nano-9b-v2:free" },
    });

    const { runAgentText } = await import("./agent");
    await runAgentText({ chatId: `vault-${Date.now()}`, userMessage: "ping" });

    expect(created.configs[0]?.apiKey).toBeUndefined();
  });
});
