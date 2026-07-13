import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import path from "path";
import { isLoopbackUrl } from "@/lib/security/url-guard";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import { spawn } from "child_process";
import { ModelConfig } from "@/lib/types";
import { getWorkDir } from "@/lib/storage/project-store";
import {
  resolveCliOAuthCredentialSync,
  getValidGeminiAccessToken,
} from "@/lib/providers/provider-auth";
import { cliProviderEnv, scrubProcessEnv } from "@/lib/security/scrub-env";
import { MODEL_PROVIDERS } from "@/lib/providers/model-config";
import {
  createGeminiOauthFetch,
  resolveGeminiCodeAssistPlatform,
  GEMINI_CODE_ASSIST_BASE_URL,
} from "@/lib/providers/gemini-code-assist";
import {
  createCodexOauthFetch,
  resolveCodexMcpOverrides,
  parseCodexOutput,
  CODEX_BACKEND_BASE_URL,
} from "@/lib/providers/codex";

type OpenAICompatibleSettings = {
  providerName: string;
  apiKey: string;
  baseUrl?: string;
  fallbackBaseUrl?: string;
  baseUrlRequired?: boolean;
  defaultPath?: string;
};

/**
 * Resolve a provider API key with env-vars taking precedence over the
 * settings.json value. This is the security-default ordering: when an
 * operator sets a key in `.env.local`, it must override any stale
 * cleartext value persisted in `data/settings/settings.json`.
 *
 * Run `npm run scrub:secrets` to migrate existing settings.json keys
 * into `.env.local` and delete them from disk.
 */
function resolveProviderApiKey(
  config: { apiKey?: string },
  envKeyName: string | undefined
): string {
  if (envKeyName) {
    const fromEnv = process.env[envKeyName];
    if (fromEnv && fromEnv.trim().length > 0) {
      if (config.apiKey && config.apiKey !== fromEnv) {
        const masked = `${fromEnv.slice(0, 4)}…${fromEnv.slice(-4)}`;
        console.warn(
          `[Provider] ${envKeyName} (env, ${masked}) overrides cleartext key in settings.json. Run \`npm run scrub:secrets\` to migrate.`
        );
      }
      return fromEnv;
    }
  }
  return config.apiKey ?? "";
}

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

type CliProviderName = "codex-cli" | "gemini-cli";

export interface ModelRuntimeContext {
  projectId?: string;
  currentPath?: string;
}

interface CliCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const ENABLE_SUBPROCESS_CLI_FALLBACK = process.env.ORCHESTRA_USE_SUBPROCESS_CLI === "1";

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

function collectPromptText(options: LanguageModelV3CallOptions): string {
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

function runCliCommand(
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

function resolveCliWorkingDirectory(runtime: ModelRuntimeContext | undefined): string {
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

function parseGeminiOutput(rawStdout: string, rawStderr: string): string {
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

function createCliLanguageModel(
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

function createCodexNativeOauthModel(config: ModelConfig): LanguageModel {
  const credential = resolveCliOAuthCredentialSync("codex-cli");
  const baseURL =
    normalizeBaseUrl(config.baseUrl, {
      providerName: "codex-cli",
      fallbackBaseUrl: CODEX_BACKEND_BASE_URL,
      defaultPath: "/backend-api/codex",
    }) ?? CODEX_BACKEND_BASE_URL;
  const sanitizedBaseURL = baseURL.replace(/\/responses\/?$/, "");
  const provider = createOpenAI({
    apiKey: credential.accessToken,
    baseURL: sanitizedBaseURL,
    headers: credential.accountId
      ? {
          "ChatGPT-Account-Id": credential.accountId,
        }
      : undefined,
    fetch: createCodexOauthFetch(credential),
    name: "openai-codex",
  });
  const modelId = config.model || "gpt-5.3-codex";
  return provider.responses(modelId);
}

function createGeminiNativeOauthModel(config: ModelConfig): LanguageModel {
  const credential = resolveCliOAuthCredentialSync("gemini-cli");
  const metadata = JSON.stringify({
    ideType: "ANTIGRAVITY",
    platform: resolveGeminiCodeAssistPlatform(),
    pluginType: "GEMINI",
  });
  const baseURL =
    normalizeBaseUrl(config.baseUrl, {
      providerName: "gemini-cli",
      fallbackBaseUrl: GEMINI_CODE_ASSIST_BASE_URL,
      defaultPath: "/v1beta",
    }) ?? GEMINI_CODE_ASSIST_BASE_URL;
  const provider = createGoogleGenerativeAI({
    apiKey: "__oauth__",
    baseURL,
    headers: {
      Authorization: `Bearer ${credential.accessToken}`,
      "X-Goog-Api-Client": `gl-node/${process.versions.node}`,
      "Client-Metadata": metadata,
    },
    // Refresh the OAuth access token per-request via the stored refresh_token
    // (the on-disk token expires ~hourly). sessionKey stays stable across
    // refreshes so the conversational session id survives.
    fetch: createGeminiOauthFetch({
      getAccessToken: () => getValidGeminiAccessToken(),
      sessionKey: credential.refreshToken || credential.accessToken || "gemini-cli",
    }),
    name: "google-gemini-cli",
  });
  const modelId = config.model || "gemini-2.5-pro";
  return provider(modelId);
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function normalizeBaseUrl(rawBaseUrl: string | undefined, settings: {
  providerName: string;
  fallbackBaseUrl?: string;
  baseUrlRequired?: boolean;
  defaultPath?: string;
}): string | undefined {
  const rawValue = (rawBaseUrl || settings.fallbackBaseUrl || "").trim();

  if (!rawValue) {
    if (settings.baseUrlRequired) {
      throw new Error(
        `${settings.providerName}: baseUrl is required. Example: https://api.example.com/v1`
      );
    }
    return undefined;
  }

  const hasScheme = /^[a-z][a-z\d+\-.]*:\/\//i.test(rawValue);
  const withScheme = hasScheme
    ? rawValue
    : `${LOCAL_HOSTNAMES.has(rawValue.split("/")[0] || "") ? "http" : "https"}://${rawValue}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(
      `${settings.providerName}: invalid baseUrl "${rawValue}". Use absolute URL, e.g. https://api.example.com/v1`
    );
  }

  if (settings.defaultPath && (parsed.pathname === "" || parsed.pathname === "/")) {
    parsed.pathname = settings.defaultPath;
  }

  return parsed.toString().replace(/\/$/, "");
}

function createOpenAICompatibleChatModel(
  config: ModelConfig,
  settings: OpenAICompatibleSettings
): LanguageModel {
  const baseURL = normalizeBaseUrl(config.baseUrl, settings);
  const provider = createOpenAI({
    apiKey: settings.apiKey,
    baseURL,
    name: settings.providerName,
  });
  return provider.chat(config.model);
}

function createOpenAICompatibleEmbeddingModel(config: {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}, settings: OpenAICompatibleSettings) {
  const baseURL = normalizeBaseUrl(config.baseUrl, settings);
  const provider = createOpenAI({
    apiKey: settings.apiKey,
    baseURL,
    name: settings.providerName,
  });
  return provider.embedding(config.model);
}

/**
 * PM #47 — Privacy Mode predicate. Returns true if this ModelConfig
 * targets a backend that lives on this machine (no outbound network).
 *
 * Local-by-definition providers: ollama, sglang, vllm. Always local
 * regardless of baseUrl override (the baseUrl is a port choice, not a
 * remote-host opt-out — if an operator sets ollama with a public-IP
 * baseUrl in privacy mode, they're routing around the guarantee, and
 * we explicitly check loopback below for clarity).
 *
 * `custom`: only local if `baseUrl` resolves to a loopback host. The
 * operator can run any OpenAI-compatible local server through `custom`;
 * we just need the baseUrl to be loopback.
 *
 * Everything else (openai, anthropic, google, openrouter, codex-cli,
 * gemini-cli): NOT local — these speak to vendor APIs.
 */
export function isLocalProvider(config: ModelConfig): boolean {
  const provider = config.provider;
  if (provider === "ollama" || provider === "sglang" || provider === "vllm") {
    // For the local-by-default providers, also enforce loopback if
    // baseUrl was explicitly set — otherwise an operator could point
    // "ollama" at a public IP and silently leak data. The default
    // (no baseUrl) inherits the per-provider loopback fallback.
    if (!config.baseUrl) return true;
    return isLoopbackUrl(config.baseUrl);
  }
  if (provider === "custom") {
    return !!config.baseUrl && isLoopbackUrl(config.baseUrl);
  }
  return false;
}

/**
 * Whether `config` can authenticate WITHOUT createModel/createEmbeddingModel
 * throwing: a provider that doesn't require a key (local ollama/sglang/vllm), an
 * explicit `apiKey`, or the provider's env key. Mirrors the guard inside both
 * factories so a caller (e.g. `/api/health`) can detect a SILENTLY unusable
 * model — an unconfigured embeddings model disables RAG memory search, MoA
 * disagreement detection, and trace-memory with only a per-request log line.
 */
export function isModelKeyConfigured(config: {
  provider: string;
  apiKey?: string;
}): boolean {
  const providerDef = MODEL_PROVIDERS[config.provider];
  if (!providerDef?.requiresApiKey) return true; // local / keyless provider
  if (config.apiKey) return true;
  const envKeyName = providerDef.envKey;
  return envKeyName ? !!process.env[envKeyName] : false;
}

/**
 * Create an AI SDK language model from our ModelConfig
 */
export function createModel(
  config: ModelConfig,
  runtime?: ModelRuntimeContext
): LanguageModel {
  const providerDef = MODEL_PROVIDERS[config.provider];
  if (providerDef?.requiresApiKey) {
    const envKeyName = providerDef.envKey;
    const hasEnvKey = envKeyName ? !!process.env[envKeyName] : false;
    const hasConfigKey = !!config.apiKey;

    if (!hasConfigKey && !hasEnvKey) {
      throw new Error(
        `API Key is missing for ${providerDef.name} (${config.model}). Please add your API key in Settings -> API Keys Vault.`
      );
    }
  }

  switch (config.provider) {
    case "openai": {
      return createOpenAICompatibleChatModel(config, {
        providerName: "openai",
        apiKey: resolveProviderApiKey(config, "OPENAI_API_KEY"),
      });
    }

    case "anthropic": {
      const baseURL = normalizeBaseUrl(config.baseUrl, {
        providerName: "anthropic",
        fallbackBaseUrl: "https://api.anthropic.com",
        defaultPath: "/v1",
      });
      const anthropic = createAnthropic({
        apiKey: resolveProviderApiKey(config, "ANTHROPIC_API_KEY"),
        baseURL,
      });
      return anthropic(config.model);
    }

    case "google": {
      const baseURL = normalizeBaseUrl(config.baseUrl, {
        providerName: "google",
        fallbackBaseUrl: "https://generativelanguage.googleapis.com",
        defaultPath: "/v1beta",
      });
      const google = createGoogleGenerativeAI({
        apiKey: resolveProviderApiKey(config, "GOOGLE_API_KEY"),
        baseURL,
      });
      return google(config.model);
    }

    case "openrouter": {
      const baseURL = normalizeBaseUrl(config.baseUrl, {
        providerName: "openrouter",
        fallbackBaseUrl: "https://openrouter.ai/api/v1",
      });
      const provider = createOpenAI({
        apiKey: resolveProviderApiKey(config, "OPENROUTER_API_KEY"),
        baseURL,
        name: "openrouter",
        headers: {
          "HTTP-Referer": "https://github.com/cocktailpeanut/orchestra",
          "X-Title": "Orchestra",
          "OR-Models": "free", // Tells openrouter we strongly prefer free
          "OR-Route": "fallback", // Tells openrouter to fallback on outage
        },
      });
      return provider.chat(config.model);
    }

    case "ollama": {
      return createOpenAICompatibleChatModel(config, {
        providerName: "ollama",
        apiKey: "ollama",
        fallbackBaseUrl: "http://localhost:11434",
        defaultPath: "/v1",
      });
    }

    // PM #43 — SGLang OpenAI-compatible endpoint, default port 30000.
    case "sglang": {
      return createOpenAICompatibleChatModel(config, {
        providerName: "sglang",
        // SGLang doesn't require auth on its OpenAI endpoint by default;
        // pass a sentinel so the OpenAI SDK doesn't reject the request.
        apiKey: config.apiKey || "sglang",
        fallbackBaseUrl: "http://localhost:30000",
        defaultPath: "/v1",
      });
    }

    // PM #43 — vLLM OpenAI-compatible endpoint, default port 8000.
    case "vllm": {
      return createOpenAICompatibleChatModel(config, {
        providerName: "vllm",
        apiKey: config.apiKey || "vllm",
        fallbackBaseUrl: "http://localhost:8000",
        defaultPath: "/v1",
      });
    }

    case "custom": {
      return createOpenAICompatibleChatModel(config, {
        providerName: "custom",
        apiKey: config.apiKey || "",
        baseUrlRequired: true,
        defaultPath: "/v1",
      });
    }

    case "codex-cli": {
      try {
        return createCodexNativeOauthModel(config);
      } catch (cause) {
        if (ENABLE_SUBPROCESS_CLI_FALLBACK) {
          return createCliLanguageModel("codex-cli", config, runtime);
        }
        throw new Error(
          `Codex OAuth transport is not ready: ${describeError(cause)}`
        );
      }
    }

    case "gemini-cli": {
      try {
        return createGeminiNativeOauthModel(config);
      } catch (cause) {
        if (ENABLE_SUBPROCESS_CLI_FALLBACK) {
          return createCliLanguageModel("gemini-cli", config, runtime);
        }
        throw new Error(
          `Gemini OAuth transport is not ready: ${describeError(cause)}`
        );
      }
    }

    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}

/**
 * Create an embeddings model.
 */
export function createEmbeddingModel(config: {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}) {
  const providerDef = MODEL_PROVIDERS[config.provider];
  if (providerDef?.requiresApiKey) {
    const envKeyName = providerDef.envKey;
    const hasEnvKey = envKeyName ? !!process.env[envKeyName] : false;
    const hasConfigKey = !!config.apiKey;

    if (!hasConfigKey && !hasEnvKey) {
      throw new Error(
        `API Key is missing for ${providerDef.name} (${config.model}). Please add your API key in Settings -> API Keys Vault.`
      );
    }
  }

  switch (config.provider) {
    case "openai":
      return createOpenAICompatibleEmbeddingModel(config, {
        providerName: "openai",
        apiKey: resolveProviderApiKey(config, "OPENAI_API_KEY"),
      });

    case "openrouter":
      return createOpenAICompatibleEmbeddingModel(config, {
        providerName: "openrouter",
        apiKey: resolveProviderApiKey(config, "OPENROUTER_API_KEY"),
        fallbackBaseUrl: "https://openrouter.ai/api/v1",
      });

    case "ollama":
      return createOpenAICompatibleEmbeddingModel(config, {
        providerName: "ollama",
        apiKey: "ollama",
        fallbackBaseUrl: "http://localhost:11434",
        defaultPath: "/v1",
      });

    // PM #43 — operator may run an embedding model on SGLang/vLLM too
    // (some serving stacks support both chat + embedding endpoints).
    case "sglang":
      return createOpenAICompatibleEmbeddingModel(config, {
        providerName: "sglang",
        apiKey: config.apiKey || "sglang",
        fallbackBaseUrl: "http://localhost:30000",
        defaultPath: "/v1",
      });

    case "vllm":
      return createOpenAICompatibleEmbeddingModel(config, {
        providerName: "vllm",
        apiKey: config.apiKey || "vllm",
        fallbackBaseUrl: "http://localhost:8000",
        defaultPath: "/v1",
      });

    case "custom":
      return createOpenAICompatibleEmbeddingModel(config, {
        providerName: "custom",
        apiKey: config.apiKey || "",
        baseUrlRequired: true,
        defaultPath: "/v1",
      });

    case "google": {
      const baseURL = normalizeBaseUrl(config.baseUrl, {
        providerName: "google",
        fallbackBaseUrl: "https://generativelanguage.googleapis.com",
        defaultPath: "/v1beta",
      });
      const google = createGoogleGenerativeAI({
        apiKey: resolveProviderApiKey(config, "GOOGLE_API_KEY"),
        baseURL,
      });
      return google.embedding(config.model);
    }

    default:
      throw new Error(`Unsupported embeddings provider: ${config.provider}`);
  }
}
