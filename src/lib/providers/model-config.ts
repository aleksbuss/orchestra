/**
 * Available model providers and their models
 */

import type { ChatAuthMethod } from "@/lib/types";

export const STAR_MODELS: Record<string, string[]> = {
  openrouter: [
    "anthropic/claude-4.6-opus",
    "anthropic/claude-4.6-sonnet",
    "anthropic/claude-3.7-sonnet",
    "openai/gpt-5.4-pro",
    "openai/gpt-5.4",
    "openai/o3-mini",
    "google/gemini-3.1-pro",
    "deepseek/deepseek-chat",
    "x-ai/grok-3-pro",
  ],
  openai: ["gpt-5.4", "gpt-5.4-pro", "o3-mini", "o1"],
  anthropic: ["claude-4.6-opus-20260205", "claude-4.6-sonnet-20260217", "claude-3.7-sonnet-20250219"],
  google: ["gemini-3.1-pro-preview"],
  ollama: ["phi-5", "llama3.2", "qwen2.5-coder"],
};

export const CODING_MODELS: Record<string, string[]> = {
  openrouter: [
    "anthropic/claude-3.5-sonnet",
    "qwen/qwen-2.5-coder-32b-instruct",
    "deepseek/deepseek-coder",
  ],
  ollama: ["qwen2.5-coder"],
};

export const LIGHT_MODELS: Record<string, string[]> = {
  openrouter: [
    "openai/gpt-4o-mini",
    "google/gemini-2.5-flash",
    "anthropic/claude-3.5-haiku",
    "meta-llama/llama-3.3-70b-instruct",
    "qwen/qwen-2.5-coder-32b-instruct",
  ],
  openai: ["gpt-4o-mini"],
  anthropic: ["claude-3-5-haiku-20241022"],
  google: ["gemini-2.5-flash", "gemini-3.1-flash"],
  ollama: ["qwen2.5:7b-coder", "llama-3.2-3b"],
};

export const FREE_TOOL_MODELS: Record<string, string[]> = {
  openrouter: [
    "openrouter/free",
    "meta-llama/llama-3.3-70b-instruct:free",
    "google/gemma-3-27b-it:free",
    "nvidia/llama-3.1-nemotron-70b-instruct:free",
    "qwen/qwen-2.5-coder-32b-instruct:free",
    "mistralai/mistral-small-24b-instruct-2501:free",
    "microsoft/phi-4:free",
    "deepseek/deepseek-chat:free",
    "google/gemini-2.0-flash-exp:free",
    "meta-llama/llama-3.1-70b-instruct:free",
  ],
};

export interface ProviderConfig {
  name: string;
  models: { id: string; name: string }[];
  embeddingModels?: { id: string; name: string; dimensions: number }[];
  envKey?: string;
  baseUrl?: string;
  requiresApiKey: boolean;
  authMethods?: ChatAuthMethod[];
  defaultAuthMethod?: ChatAuthMethod;
  connectionHelp?: {
    apiKey?: {
      title: string;
      steps: string[];
      command?: string;
    };
    oauth?: {
      title: string;
      steps: string[];
      command?: string;
    };
  };
}

export const MODEL_PROVIDERS: Record<string, ProviderConfig> = {
  openai: {
    name: "OpenAI",
    models: [],
    embeddingModels: [
      { id: "text-embedding-3-small", name: "Embedding 3 Small", dimensions: 1536 },
      { id: "text-embedding-3-large", name: "Embedding 3 Large", dimensions: 3072 },
    ],
    envKey: "OPENAI_API_KEY",
    requiresApiKey: true,
    authMethods: ["api_key"],
    defaultAuthMethod: "api_key",
  },
  anthropic: {
    name: "Anthropic",
    models: [],
    envKey: "ANTHROPIC_API_KEY",
    requiresApiKey: true,
    authMethods: ["api_key"],
    defaultAuthMethod: "api_key",
  },
  google: {
    name: "Google",
    models: [],
    envKey: "GOOGLE_API_KEY",
    requiresApiKey: true,
    authMethods: ["api_key"],
    defaultAuthMethod: "api_key",
  },
  openrouter: {
    name: "OpenRouter",
    models: [],
    envKey: "OPENROUTER_API_KEY",
    requiresApiKey: true,
    authMethods: ["api_key"],
    defaultAuthMethod: "api_key",
  },
  ollama: {
    name: "Ollama",
    models: [],
    embeddingModels: [
      { id: "nomic-embed-text", name: "Nomic Embed Text", dimensions: 768 },
      { id: "mxbai-embed-large", name: "MxBai Embed Large", dimensions: 1024 },
    ],
    baseUrl: "http://localhost:11434",
    requiresApiKey: false,
    authMethods: ["api_key"],
    defaultAuthMethod: "api_key",
  },
  "codex-cli": {
    name: "Codex CLI",
    models: [
      { id: "gpt-5.3-codex", name: "gpt-5.3-codex" },
      { id: "gpt-5.4", name: "gpt-5.4" },
      { id: "gpt-5.2-codex", name: "gpt-5.2-codex" },
      { id: "gpt-5.1-codex-max", name: "gpt-5.1-codex-max" },
      { id: "gpt-5.2", name: "gpt-5.2" },
      { id: "gpt-5.1-codex-mini", name: "gpt-5.1-codex-mini" },
    ],
    requiresApiKey: false,
    authMethods: ["oauth"],
    defaultAuthMethod: "oauth",
    connectionHelp: {
      oauth: {
        title: "Connect with OAuth via Codex CLI",
        command: "codex login",
        steps: [
          "Install Codex CLI if needed: npm i -g @openai/codex",
          "Run codex login in your terminal.",
          "Complete browser authorization.",
          "Return here and click Check connection.",
        ],
      },
    },
  },
  "gemini-cli": {
    name: "Gemini CLI",
    models: [
      { id: "gemini-3.1-pro-preview", name: "gemini-3.1-pro-preview" },
      { id: "gemini-3-flash-preview", name: "gemini-3-flash-preview" },
      { id: "gemini-2.5-pro", name: "gemini-2.5-pro" },
      { id: "gemini-2.5-flash", name: "gemini-2.5-flash" },
      { id: "gemini-2.5-flash-lite", name: "gemini-2.5-flash-lite" },
    ],
    requiresApiKey: false,
    authMethods: ["oauth"],
    defaultAuthMethod: "oauth",
    connectionHelp: {
      oauth: {
        title: "Connect with OAuth via Gemini CLI",
        command: "gemini",
        steps: [
          "Install Gemini CLI if needed: npm i -g @google/gemini-cli",
          "Run gemini in your terminal.",
          "Choose Login with Google and complete browser authorization.",
          "Return here and click Check connection.",
        ],
      },
    },
  },
};
