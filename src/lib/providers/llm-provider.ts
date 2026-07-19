import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import { isLoopbackUrl } from "@/lib/security/url-guard";
import { ModelConfig } from "@/lib/types";
import {
  resolveCliOAuthCredentialSync,
  getValidGeminiAccessToken,
} from "@/lib/providers/provider-auth";
import { MODEL_PROVIDERS } from "@/lib/providers/model-config";
import {
  createGeminiOauthFetch,
  resolveGeminiCodeAssistPlatform,
  GEMINI_CODE_ASSIST_BASE_URL,
} from "@/lib/providers/gemini-code-assist";
import {
  createCodexOauthFetch,
  CODEX_BACKEND_BASE_URL,
} from "@/lib/providers/codex";
import {
  createCliLanguageModel,
  type ModelRuntimeContext,
} from "@/lib/providers/cli-runner";

export type { ModelRuntimeContext } from "@/lib/providers/cli-runner";

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

const ENABLE_SUBPROCESS_CLI_FALLBACK = process.env.ORCHESTRA_USE_SUBPROCESS_CLI === "1";

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
