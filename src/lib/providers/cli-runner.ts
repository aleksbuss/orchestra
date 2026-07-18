/**
 * Shared subprocess CLI runner (extracted from llm-provider.ts, §10 decomposition PR3).
 *
 * The fallback transport for the codex-cli / gemini-cli providers (behind
 * ORCHESTRA_USE_SUBPROCESS_CLI): spawns the installed CLI binary, feeds the
 * prompt, and adapts its JSONL output into a LanguageModelV3. The native
 * OAuth transports live in codex.ts / gemini-code-assist.ts; llm-provider's
 * `createModel` calls `createCliLanguageModel` only when the native path
 * failed and the subprocess fallback is enabled.
 *
 * Imports only leaves (scrub-env, project-store's getWorkDir, codex.ts) and
 * NOTHING from llm-provider (one-way: llm-provider -> here), so no cycle.
 * Pure helpers are exported for unit testing — this surface was previously
 * untested (the §10 CLI/OAuth/SSE coverage gap).
 */

import path from "path";
import { spawn } from "child_process";
import type { LanguageModel } from "ai";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import type { ModelConfig } from "@/lib/types";
import { getWorkDir } from "@/lib/storage/project-store";
import { cliProviderEnv, scrubProcessEnv } from "@/lib/security/scrub-env";
import { parseCodexOutput, resolveCodexMcpOverrides } from "@/lib/providers/codex";

export type CliProviderName = "codex-cli" | "gemini-cli";

export interface ModelRuntimeContext {
  projectId?: string;
  currentPath?: string;
}

export interface CliCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const EMPTY_USAGE: LanguageModelV3Usage = {
  inputTokens: {
    total: undefined,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {
    total: undefined,
    text: undefined,
    reasoning: undefined,
  },
};

export function collectPromptText(options: LanguageModelV3CallOptions): string {
  const chunks: string[] = [];

  for (const message of options.prompt) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (
        part &&
        typeof part === "object" &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        const text = (part as { text: string }).text;
        if (text.trim()) {
          chunks.push(text);
        }
      }
    }
  }

  return chunks.join("\n\n").trim();
}

export function runCliCommand(
  command: string,
  args: string[],
  options?: { stdinText?: string; timeoutMs?: number; cwd?: string; provider?: CliProviderName }
): Promise<CliCommandResult> {
  const timeoutMs = options?.timeoutMs ?? 180000;

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    let timedOut = false;

    let child;
    try {
      child = spawn(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        // PM #70 — drop the app auth secret + unrelated providers' keys; the
        // CLI keeps only its own auth (and OAuth files via HOME).
        env: options?.provider ? cliProviderEnv(options.provider) : scrubProcessEnv(),
        cwd: options?.cwd,
      });
    } catch (error) {
      resolve({
        code: 1,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        timedOut: false,
      });
      return;
    }

    const timer = setTimeout(() => {
      if (!done) {
        timedOut = true;
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 200000) {
        stdout = stdout.slice(-200000);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 200000) {
        stderr = stderr.slice(-200000);
      }
    });

    child.on("error", (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({
        code: 1,
        stdout,
        stderr: `${stderr}\n${error instanceof Error ? error.message : String(error)}`.trim(),
        timedOut,
      });
    });

    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });

    if (options?.stdinText) {
      child.stdin.write(options.stdinText);
    }
    child.stdin.end();
  });
}

export function resolveCliWorkingDirectory(runtime: ModelRuntimeContext | undefined): string {
  const projectId = runtime?.projectId;
  if (!projectId) {
    return process.cwd();
  }

  const root = path.resolve(getWorkDir(projectId));
  const rawCurrentPath = (runtime.currentPath || "").trim();
  if (!rawCurrentPath) return root;

  const candidate = path.resolve(root, rawCurrentPath);
  if (candidate === root || candidate.startsWith(`${root}${path.sep}`)) {
    return candidate;
  }

  return root;
}

export function parseGeminiOutput(rawStdout: string, rawStderr: string): string {
  const lines = rawStdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let text = "";
  let explicitError = "";

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const eventType = typeof parsed.type === "string" ? parsed.type : "";

      if (eventType === "message") {
        const role = typeof parsed.role === "string" ? parsed.role : "";
        const content = typeof parsed.content === "string" ? parsed.content : "";
        if (role === "assistant" && content) {
          text += content;
        }
      }

      if (eventType === "error") {
        const message =
          typeof parsed.message === "string"
            ? parsed.message
            : typeof parsed.error === "string"
              ? parsed.error
              : "";
        if (message.trim()) {
          explicitError = message.trim();
        }
      }
    } catch {
      // Ignore non-JSON lines.
    }
  }

  if (text.trim()) {
    return text.trim();
  }
  if (explicitError) {
    return explicitError;
  }

  const fallback = `${rawStdout}\n${rawStderr}`.trim();
  return fallback || "Gemini CLI returned no output.";
}

async function runCliModel(
  provider: CliProviderName,
  model: string,
  prompt: string,
  runtime: ModelRuntimeContext | undefined
): Promise<string> {
  const cwd = resolveCliWorkingDirectory(runtime);

  if (provider === "codex-cli") {
    const command = process.env.CODEX_COMMAND || "codex";
    const args = ["exec", "--json", "--full-auto", "--skip-git-repo-check"];
    const codexMcpOverrides = await resolveCodexMcpOverrides(runtime?.projectId);
    for (const override of codexMcpOverrides) {
      args.push("-c", override);
    }
    if (model) {
      args.push("-m", model);
    }
    args.push("-");

    const result = await runCliCommand(command, args, {
      stdinText: `${prompt}\n`,
      timeoutMs: 240000,
      cwd,
      provider: "codex-cli",
    });

    if (result.timedOut) {
      throw new Error("Codex CLI timed out.");
    }
    if (result.code !== 0 && !result.stdout.trim()) {
      throw new Error((result.stderr || "Codex CLI execution failed.").trim());
    }

    return parseCodexOutput(result.stdout, result.stderr);
  }

  const command = process.env.GEMINI_CLI_COMMAND || "gemini";
  const args = ["-m", model, "-p", prompt, "--output-format", "stream-json", "--yolo"];
  const result = await runCliCommand(command, args, {
    timeoutMs: 240000,
    cwd,
    provider: "gemini-cli",
  });

  if (result.timedOut) {
    throw new Error("Gemini CLI timed out.");
  }
  if (result.code !== 0 && !result.stdout.trim()) {
    throw new Error((result.stderr || "Gemini CLI execution failed.").trim());
  }

  return parseGeminiOutput(result.stdout, result.stderr);
}

export function createCliLanguageModel(
  provider: CliProviderName,
  config: ModelConfig,
  runtime: ModelRuntimeContext | undefined
): LanguageModel {
  const modelId = config.model || (provider === "codex-cli" ? "gpt-5.2-codex" : "gemini-2.5-pro");

  const generate = async (
    options: LanguageModelV3CallOptions
  ): Promise<LanguageModelV3GenerateResult> => {
    const prompt = collectPromptText(options);
    const text = await runCliModel(
      provider,
      modelId,
      prompt || "Continue.",
      runtime
    );

    return {
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: EMPTY_USAGE,
      warnings: [],
      request: {
        body: {
          provider,
          model: modelId,
          promptLength: prompt.length,
        },
      },
    };
  };

  const model: LanguageModelV3 = {
    specificationVersion: "v3",
    provider,
    modelId,
    supportedUrls: {},
    doGenerate: generate,
    async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
      const generated = await generate(options);
      const textPart = generated.content.find(
        (part): part is { type: "text"; text: string } => part.type === "text"
      );
      const text = textPart?.text || "";
      const id = crypto.randomUUID();

      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id });
          if (text) {
            controller.enqueue({ type: "text-delta", id, delta: text });
          }
          controller.enqueue({ type: "text-end", id });
          controller.enqueue({
            type: "finish",
            finishReason: generated.finishReason,
            usage: generated.usage,
          });
          controller.close();
        },
      });

      return { stream };
    },
  };

  return model as unknown as LanguageModel;
}
