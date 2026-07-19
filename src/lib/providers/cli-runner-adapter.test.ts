import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "events";
import type { spawn as spawnType } from "child_process";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import type { ModelConfig } from "@/lib/types";

// The composed adapter's only side effect is child_process.spawn (via
// runCliModel -> runCliCommand). Mock it here so the whole glue path runs
// hermetically. This file is separate from cli-runner.test.ts on purpose:
// that file exercises runCliCommand against a REAL node spawn and must NOT
// see a mocked child_process.
vi.mock("child_process", () => ({ spawn: vi.fn() }));
vi.mock("@/lib/storage/project-store", () => ({
  getWorkDir: vi.fn(() => process.cwd()),
  loadProjectMcpServers: vi.fn(async () => []),
}));

import { spawn } from "child_process";
import { createCliLanguageModel } from "./cli-runner";

afterEach(() => {
  vi.clearAllMocks();
});

/** Queue one fake `gemini` invocation that streams a single assistant chunk. */
function mockGeminiStdout(text: string, code = 0): void {
  vi.mocked(spawn as typeof spawnType).mockImplementationOnce(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { write: () => void; end: () => void };
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: vi.fn(), end: vi.fn() };
    child.kill = vi.fn();
    // Emit after the current sync block so runCliCommand's .on handlers are
    // already attached.
    setImmediate(() => {
      child.stdout.emit(
        "data",
        Buffer.from(JSON.stringify({ type: "message", role: "assistant", content: text }))
      );
      child.emit("close", code);
    });
    return child as unknown as ReturnType<typeof spawnType>;
  });
}

function userPrompt(text: string): LanguageModelV3CallOptions {
  return {
    prompt: [{ role: "user", content: [{ type: "text", text }] }],
  } as LanguageModelV3CallOptions;
}

const geminiConfig = { model: "gemini-2.5-pro" } as ModelConfig;

describe("createCliLanguageModel (composed V3 adapter)", () => {
  it("doGenerate returns a valid V3 result carrying the parsed CLI text", async () => {
    mockGeminiStdout("Hello from the CLI");
    const model = createCliLanguageModel(
      "gemini-cli",
      geminiConfig,
      undefined
    ) as unknown as LanguageModelV3;

    expect(model.specificationVersion).toBe("v3");
    expect(model.provider).toBe("gemini-cli");
    expect(model.modelId).toBe("gemini-2.5-pro");

    const result: LanguageModelV3GenerateResult = await model.doGenerate(userPrompt("hi"));

    expect(result.content).toEqual([{ type: "text", text: "Hello from the CLI" }]);
    expect(result.finishReason).toEqual({ unified: "stop", raw: "stop" });
    expect(result.warnings).toEqual([]);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("doStream emits a well-formed V3 text stream ending in finish", async () => {
    mockGeminiStdout("streamed text");
    const model = createCliLanguageModel(
      "gemini-cli",
      geminiConfig,
      undefined
    ) as unknown as LanguageModelV3;

    const { stream } = await model.doStream(userPrompt("hi"));
    const parts: LanguageModelV3StreamPart[] = [];
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }

    expect(parts[0]).toEqual({ type: "stream-start", warnings: [] });
    expect(parts.some((p) => p.type === "text-start")).toBe(true);
    const delta = parts.find((p) => p.type === "text-delta");
    expect(delta && "delta" in delta ? delta.delta : undefined).toBe("streamed text");
    expect(parts.some((p) => p.type === "text-end")).toBe(true);

    const finish = parts.at(-1);
    expect(finish?.type).toBe("finish");
    expect(finish && "finishReason" in finish ? finish.finishReason : undefined).toEqual({
      unified: "stop",
      raw: "stop",
    });
  });
});
