"use client";

import { useCallback, useEffect, useState, useRef } from "react";
import { AlertCircle, Check, Loader2, RefreshCw, ChevronDown, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MODEL_PROVIDERS, STAR_MODELS, CODING_MODELS, LIGHT_MODELS, FREE_TOOL_MODELS } from "@/lib/providers/model-config";
import type { AppSettings, ChatAuthMethod } from "@/lib/types";

export type UpdateSettingsFn = (path: string, value: unknown) => void;

function StepIndicator({
  step,
  currentStep,
  label,
}: {
  step: number;
  currentStep: number;
  label: string;
}) {
  const completed = currentStep > step;
  const active = currentStep === step;

  return (
    <div className="flex items-center gap-2">
      <div
        className={`
          flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold
          transition-all duration-300 shrink-0
          ${
            completed
              ? "bg-emerald-500 text-white shadow-md shadow-emerald-500/30"
              : active
                ? "bg-primary text-primary-foreground shadow-md shadow-primary/30 ring-2 ring-primary/20"
                : "bg-muted text-muted-foreground"
          }
        `}
      >
        {completed ? <Check className="size-3.5" /> : step}
      </div>
      <span
        className={`text-sm transition-colors duration-200 ${
          active
            ? "text-foreground font-medium"
            : completed
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-muted-foreground"
        }`}
      >
        {label}
      </span>
    </div>
  );
}

function ModelSelect({
  value,
  models,
  loading,
  error,
  disabled,
  onChange,
  placeholder,
}: {
  value: string;
  models: { id: string; name: string; _sortWeight?: number }[];
  loading: boolean;
  error: string | null;
  disabled: boolean;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  const filtered = models.filter(m => 
    m.name.toLowerCase().includes(search.toLowerCase()) || 
    m.id.toLowerCase().includes(search.toLowerCase())
  );

  const selectedModelName = models.find(m => m.id === value)?.name || value;

  return (
    <div className="space-y-1.5 w-full relative" ref={dropdownRef}>
      <div 
        onClick={() => !disabled && !loading && setOpen(!open)}
        className={`
          flex items-center justify-between w-full rounded-md border bg-background px-3 py-2 text-sm
          ${disabled || loading ? "opacity-50 cursor-not-allowed" : "cursor-pointer hover:bg-muted/50"}
          ${error ? "border-red-400 dark:border-red-500" : ""}
          transition-all duration-200
        `}
      >
        <div className="truncate pr-4 flex-1">
          {loading ? "Loading models..." : (selectedModelName || placeholder || "Select a model...")}
        </div>
        <div className="shrink-0 text-muted-foreground flex items-center gap-2">
           {loading ? <Loader2 className="size-4 animate-spin" /> : <ChevronDown className={`size-4 transition-transform ${open ? "rotate-180" : ""}`} />}
        </div>
      </div>

      {open && (
        <div className="absolute z-50 w-full mt-1 bg-background border rounded-md shadow-lg overflow-hidden animate-in fade-in-0 zoom-in-95">
          <div className="flex items-center px-3 border-b sticky top-0 bg-background/95 backdrop-blur z-10">
            <Search className="size-4 mr-2 text-muted-foreground shrink-0" />
            <input 
              autoFocus
              className="flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
              placeholder="Search models..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="max-h-[300px] overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground">No models found.</div>
            ) : (
              <div className="px-1 flex flex-col gap-0.5">
                {filtered.map((model) => (
                  <div
                    key={model.id}
                    onClick={() => {
                      onChange(model.id);
                      setOpen(false);
                      setSearch("");
                    }}
                    className={`
                      flex flex-col px-2 py-1.5 cursor-pointer rounded-sm text-sm
                      transition-colors hover:bg-accent hover:text-accent-foreground
                      ${model.id === value ? "bg-accent/50 font-medium" : ""}
                    `}
                  >
                    <div className="flex items-center gap-2">
                      <span className="truncate">{model.name}</span>
                    </div>
                    {model.name !== model.id && (
                      <span className="text-[10px] text-muted-foreground truncate opacity-70">
                        {model.id}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-1.5 text-xs text-red-500 mt-1.5">
          <AlertCircle className="size-3" />
          {error}
        </div>
      )}
    </div>
  );
}

/**
 * API-key input + env-key affordances. Used by both ChatModelWizard and
 * EmbeddingsModelWizard so the env-key UX (green "Key detected in X" banner,
 * conditional hint) stays consistent across the two surfaces — divergence
 * here was the bug class behind PM #10.
 */
function ApiKeyInput({
  apiKey,
  onChange,
  envKey,
  envApiKeyAvailable,
  disabled,
}: {
  apiKey: string;
  onChange: (value: string) => void;
  envKey?: string;
  envApiKeyAvailable: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-2">
      {envApiKeyAvailable && !apiKey && (
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300">
          ✓ Key detected in{" "}
          <code className="bg-muted px-1 py-0.5 rounded text-[11px]">
            {envKey || ".env.local"}
          </code>
          . You can leave the field blank — backend will use the environment
          value. Type a value here only if you want to override it.
        </div>
      )}
      <Input
        type="password"
        value={apiKey}
        onChange={(event) => onChange(event.target.value)}
        placeholder={
          envApiKeyAvailable
            ? "Using key from environment (override here if needed)"
            : envKey
              ? `Enter key or set ${envKey} in .env`
              : "sk-..."
        }
        disabled={disabled}
      />
      {envKey && !envApiKeyAvailable && (
        <p className="text-xs text-muted-foreground">
          Or set{" "}
          <code className="bg-muted px-1 py-0.5 rounded text-[11px]">
            {envKey}
          </code>{" "}
          as an environment variable
        </p>
      )}
    </div>
  );
}

function useModels(
  provider: string,
  apiKey: string,
  requiresApiKey: boolean,
  type: "chat" | "embedding" = "chat",
  baseUrl?: string,
  envApiKeyAvailable: boolean = false
) {
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchModels = useCallback(async () => {
    if (!provider) return;
    // Allow the fetch when an env-supplied key is available even without a
    // settings-stored apiKey: backend resolves `process.env.<PROVIDER>_API_KEY`
    // server-side. Without this, users who only configured `.env.local`
    // saw the Custom Swarm Configuration model list grayed out.
    if (requiresApiKey && !apiKey && !envApiKeyAvailable) return;
    const providerConfig = MODEL_PROVIDERS[provider];

    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({ provider, type });
      if (apiKey) params.set("apiKey", apiKey);
      if (baseUrl) {
        params.set("baseUrl", baseUrl);
      } else if (providerConfig?.baseUrl) {
        params.set("baseUrl", providerConfig.baseUrl);
      }

      const response = await fetch(`/api/models?${params}`);
      const payload = (await response.json()) as {
        models?: Array<{ id: string; name: string }>;
        error?: string;
      };

      if (!response.ok) {
        throw new Error(payload.error || "Failed to fetch models");
      }

      if (payload.models?.length) {
        let finalModels = payload.models;
        const starIds = STAR_MODELS[provider] || [];
        const codingIds = CODING_MODELS[provider] || [];
        const lightIds = LIGHT_MODELS[provider] || [];
        const freeIds = FREE_TOOL_MODELS[provider] || [];
        
        if (starIds.length > 0 || codingIds.length > 0 || lightIds.length > 0 || freeIds.length > 0) {
          finalModels = finalModels.map((m) => {
            const isStar = starIds.includes(m.id);
            const isCode = codingIds.includes(m.id);
            const isLight = lightIds.includes(m.id);
            const isFree = freeIds.includes(m.id);
            const isAutoFree = m.id === "openrouter/free";
            
            let sortWeight = 0;
            let displayName = m.name;
            
            if (isAutoFree) {
              sortWeight = 5;
              displayName = `🤖 ${m.name} (Auto-Free Router)`;
            } else if (isStar) {
              sortWeight = 4;
              displayName = `⭐ ${m.name} (Top Intelligence)`;
            } else if (isCode) {
              sortWeight = 3;
              displayName = `💻 ${m.name} (Coding Expert)`;
            } else if (isFree) {
              sortWeight = 2;
              displayName = `🎁 ${m.name} (Free + Tool Calling)`;
            } else if (isLight) {
              sortWeight = 1;
              displayName = `⚡ ${m.name} (Fast & Light)`;
            }
            
            return {
              ...m,
              name: displayName,
              _sortWeight: sortWeight,
            };
          }).sort((a, b) => {
            if (a._sortWeight !== b._sortWeight) return b._sortWeight - a._sortWeight;
            return a.name.localeCompare(b.name);
          }).map(m => ({ id: m.id, name: m.name, _sortWeight: m._sortWeight }));
        }
        setModels(finalModels);
      } else {
        const dynamicProviders = [
          "openai",
          "openrouter",
          "ollama",
          "anthropic",
          "google",
        ];
        if (!dynamicProviders.includes(provider) && providerConfig?.models?.length) {
          setModels([...providerConfig.models]);
        } else {
          setModels([]);
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load models");

      const providerConfig = MODEL_PROVIDERS[provider];
      const dynamicProviders = [
        "openai",
        "openrouter",
        "ollama",
        "anthropic",
        "google",
      ];
      if (!dynamicProviders.includes(provider) && providerConfig?.models?.length) {
        setModels([...providerConfig.models]);
      } else {
        setModels([]);
      }
    } finally {
      setLoading(false);
    }
  }, [provider, apiKey, requiresApiKey, type, baseUrl, envApiKeyAvailable]);

  useEffect(() => {
    void fetchModels();
  }, [fetchModels]);

  return { models, loading, error };
}

export function ModelConfigWizard({
  settings,
  updateSettings,
  configKey,
  title = "Model Configuration",
}: {
  settings: AppSettings;
  updateSettings: UpdateSettingsFn;
  configKey: "chatModel" | "utilityModel";
  title?: string;
}) {
  const config = settings[configKey];
  const otherConfig = settings[configKey === "chatModel" ? "utilityModel" : "chatModel"];
  const provider = config.provider;
  const apiKey = config.apiKey || "";
  
  // Resolve the most sensible API key: local > vault > other config (if same provider)
  let effectiveApiKey = apiKey || settings.providerApiKeys?.[provider as keyof typeof settings.providerApiKeys] || "";
  if (!effectiveApiKey && otherConfig.provider === provider) {
    effectiveApiKey = otherConfig.apiKey || "";
  }
  // Whether the server told us this provider has a key in `process.env.*`.
  // When true, the wizard treats the connection as ready even if the user
  // never typed a key into the UI — backend will resolve the env value.
  const envApiKeyAvailable =
    settings.envApiKeys?.[provider as keyof NonNullable<AppSettings["envApiKeys"]>] === true;

  const model = config.model;
  const providerConfig = MODEL_PROVIDERS[provider];
  const availableAuthMethods = providerConfig?.authMethods || ["api_key"];
  const selectedAuthMethod = (
    availableAuthMethods.includes((config.authMethod || "") as ChatAuthMethod)
      ? config.authMethod
      : providerConfig?.defaultAuthMethod || availableAuthMethods[0]
  ) as ChatAuthMethod;
  const requiresApiKey =
    selectedAuthMethod === "api_key" && (providerConfig?.requiresApiKey ?? true);
  const isCliProvider = provider === "codex-cli" || provider === "gemini-cli";
  const hasProvider = !!provider;
  const hasModel = !!model;

  const [connectionLoading, setConnectionLoading] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<{
    connected: boolean;
    message: string;
    detail?: string;
  } | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  const { models, loading, error } = useModels(
    provider,
    effectiveApiKey,
    requiresApiKey,
    "chat",
    config.baseUrl,
    envApiKeyAvailable
  );

  const checkConnection = useCallback(async () => {
    if (!isCliProvider) {
      setConnectionStatus(null);
      setConnectionError(null);
      return;
    }

    setConnectionLoading(true);
    setConnectionError(null);
    try {
      const params = new URLSearchParams({
        provider,
        method: selectedAuthMethod,
      });
      if (effectiveApiKey.trim()) {
        params.set("hasApiKey", "1");
      }
      const response = await fetch(`/api/provider-auth/status?${params.toString()}`, {
        method: "GET",
      });
      const payload = (await response.json()) as {
        connected?: boolean;
        message?: string;
        detail?: string;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error || "Failed to check connection");
      }
      setConnectionStatus({
        connected: Boolean(payload.connected),
        message: payload.message || "Status updated",
        detail: payload.detail,
      });
    } catch (cause) {
      setConnectionStatus(null);
      setConnectionError(
        cause instanceof Error ? cause.message : "Failed to check connection"
      );
    } finally {
      setConnectionLoading(false);
    }
  }, [apiKey, isCliProvider, provider, selectedAuthMethod]);

  useEffect(() => {
    if (!provider) {
      setConnectionStatus(null);
      setConnectionError(null);
      return;
    }
    if (!isCliProvider) {
      setConnectionStatus(null);
      setConnectionError(null);
      return;
    }
    void checkConnection();
  }, [checkConnection, isCliProvider, provider, selectedAuthMethod]);

  useEffect(() => {
    if (!provider) return;
    if (config.authMethod === selectedAuthMethod) return;
    updateSettings(`${configKey}.authMethod`, selectedAuthMethod);
  }, [
    provider,
    selectedAuthMethod,
    config.authMethod,
    updateSettings,
  ]);

  const apiKeyConnectionReady =
    !requiresApiKey || !!effectiveApiKey.trim() || envApiKeyAvailable;
  const hasConnection = isCliProvider
    ? Boolean(connectionStatus?.connected)
    : selectedAuthMethod === "oauth"
      ? Boolean(connectionStatus?.connected)
      : apiKeyConnectionReady;
  const currentStep = !hasProvider
    ? 1
    : !selectedAuthMethod
      ? 2
      : !hasConnection
        ? 3
        : !hasModel
          ? 4
          : 5;
  const showApiKeyInput = selectedAuthMethod === "api_key" && requiresApiKey;
  const connectionHelp =
    selectedAuthMethod === "oauth"
      ? providerConfig?.connectionHelp?.oauth
      : providerConfig?.connectionHelp?.apiKey;

  return (
    <section className="border rounded-xl p-5 bg-card space-y-5 transition-all duration-300">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-lg">{title}</h3>
        <div className="flex items-center gap-4">
          <StepIndicator step={1} currentStep={currentStep} label="Provider" />
          <StepIndicator step={2} currentStep={currentStep} label="Method" />
          <StepIndicator step={3} currentStep={currentStep} label="Connect" />
          <StepIndicator step={4} currentStep={currentStep} label="Model" />
        </div>
      </div>

      <div className="space-y-2">
        <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Step 1 — Provider
        </Label>
        <select
          value={provider}
          onChange={(event) => {
            const nextProvider = event.target.value;
            updateSettings(`${configKey}.provider`, nextProvider);
            updateSettings(`${configKey}.model`, "");
            const nextProviderConfig = MODEL_PROVIDERS[nextProvider];
            const nextAuthMethod =
              nextProviderConfig?.defaultAuthMethod ||
              nextProviderConfig?.authMethods?.[0] ||
              "api_key";
            updateSettings(`${configKey}.authMethod`, nextAuthMethod);

            if (nextProvider === "ollama") {
              updateSettings(`${configKey}.baseUrl`, "http://localhost:11434/v1");
              updateSettings(`${configKey}.apiKey`, "");
            } else if (nextProvider === "codex-cli" || nextProvider === "gemini-cli") {
              updateSettings(`${configKey}.baseUrl`, "");
            } else {
              updateSettings(`${configKey}.baseUrl`, "");
            }

            setConnectionStatus(null);
            setConnectionError(null);
          }}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
        >
          <option value="">Select provider...</option>
          {Object.entries(MODEL_PROVIDERS).map(([key, providerOption]) => (
            <option key={key} value={key}>
              {providerOption.name}
            </option>
          ))}
          <option value="custom">Custom (OpenAI-compatible)</option>
        </select>
      </div>

      <div
        className={`space-y-2 transition-all duration-300 ${
          !hasProvider ? "opacity-40 pointer-events-none" : ""
        }`}
      >
        <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Step 2 — Connection Method
        </Label>
        <select
          value={selectedAuthMethod}
          onChange={(event) => {
            const method = event.target.value as ChatAuthMethod;
            updateSettings(`${configKey}.authMethod`, method);
            updateSettings(`${configKey}.model`, "");
            if (method === "oauth") {
              updateSettings(`${configKey}.apiKey`, "");
            }
            setConnectionStatus(null);
            setConnectionError(null);
          }}
          disabled={!hasProvider}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
        >
          {availableAuthMethods.map((authMethod) => (
            <option key={authMethod} value={authMethod}>
              {authMethod === "oauth" ? "OAuth" : "API key"}
            </option>
          ))}
        </select>
      </div>

      <div
        className={`space-y-3 transition-all duration-300 ${
          !hasProvider || !selectedAuthMethod ? "opacity-40 pointer-events-none" : ""
        }`}
      >
        <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Step 3 — Connection
        </Label>

        {showApiKeyInput ? (
          <ApiKeyInput
            apiKey={apiKey}
            onChange={(value) => updateSettings(`${configKey}.apiKey`, value)}
            envKey={providerConfig?.envKey}
            envApiKeyAvailable={envApiKeyAvailable}
            disabled={!hasProvider}
          />
        ) : (
          <div className="text-sm text-muted-foreground rounded-lg border bg-muted/30 p-3">
            API key input is not required for this connection mode.
          </div>
        )}

        {connectionHelp && (
          <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
            <p className="text-sm font-medium">{connectionHelp.title}</p>
            <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
              {connectionHelp.steps.map((step, idx) => (
                <li key={`${provider}-${selectedAuthMethod}-help-${idx}`}>{step}</li>
              ))}
            </ul>
            {connectionHelp.command && (
              <p className="text-sm">
                Command:{" "}
                <code className="bg-muted px-1 py-0.5 rounded text-[11px]">
                  {connectionHelp.command}
                </code>
              </p>
            )}
          </div>
        )}

        {isCliProvider && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
            OAuth tokens are read from local CLI auth files.
          </div>
        )}

        {isCliProvider && (
          <button
            type="button"
            onClick={() => void checkConnection()}
            disabled={connectionLoading}
            className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-muted disabled:opacity-60"
          >
            {connectionLoading ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            Check connection
          </button>
        )}

        {provider === "ollama" && selectedAuthMethod === "api_key" && (
          <div className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/30 rounded-lg px-3 py-2">
            <Check className="size-4" />
            API Key not required — connecting to local Ollama
          </div>
        )}

        {isCliProvider && connectionStatus && (
          <div
            className={`rounded-lg border px-3 py-2 text-sm ${
              connectionStatus.connected
                ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300"
                : "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300"
            }`}
          >
            <p>{connectionStatus.message}</p>
            {connectionStatus.detail && (
              <p className="mt-1 text-xs opacity-80">{connectionStatus.detail}</p>
            )}
          </div>
        )}

        {connectionError && (
          <div className="flex items-center gap-1.5 text-xs text-red-500">
            <AlertCircle className="size-3" />
            {connectionError}
          </div>
        )}
      </div>

      {(provider === "custom" || provider === "ollama") && selectedAuthMethod === "api_key" && (
        <div
          className={`space-y-2 transition-all duration-300 ${
            !apiKeyConnectionReady ? "opacity-40 pointer-events-none" : ""
          }`}
        >
          <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Base URL
          </Label>
          <Input
            value={config.baseUrl || ""}
            onChange={(event) => updateSettings(`${configKey}.baseUrl`, event.target.value)}
            placeholder={
              provider === "ollama"
                ? "http://localhost:11434/v1"
                : "https://api.example.com/v1"
            }
            disabled={!apiKeyConnectionReady}
          />
        </div>
      )}

      <div
        className={`space-y-2 transition-all duration-300 ${
          !hasConnection ? "opacity-40 pointer-events-none" : ""
        }`}
      >
        <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Step 4 — Model
        </Label>
        <ModelSelect
          value={model}
          models={models}
          loading={loading}
          error={error}
          disabled={!hasConnection}
          onChange={(value) => updateSettings(`${configKey}.model`, value)}
          placeholder="Select model..."
        />
      </div>

      <div
        className={`space-y-2 transition-all duration-300 ${
          !model ? "opacity-40 pointer-events-none" : ""
        }`}
      >
        <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Temperature
        </Label>
        <Input
          type="number"
          step="0.1"
          min="0"
          max="2"
          value={config.temperature || 0.7}
          onChange={(event) =>
            updateSettings(`${configKey}.temperature`, parseFloat(event.target.value))
          }
          disabled={!model}
          className="max-w-[120px]"
        />
      </div>
    </section>
  );
}


export function ChatModelWizard({ settings, updateSettings }: { settings: AppSettings; updateSettings: UpdateSettingsFn; }) {
  return <ModelConfigWizard settings={settings} updateSettings={updateSettings} configKey="chatModel" title="Chat Model (Orchestrator / Brain)" />;
}

export function UtilityModelWizard({ settings, updateSettings }: { settings: AppSettings; updateSettings: UpdateSettingsFn; }) {
  return <ModelConfigWizard settings={settings} updateSettings={updateSettings} configKey="utilityModel" title="Swarm Worker Model (Background & Agents)" />;
}

export function EmbeddingsModelWizard({
  settings,
  updateSettings,
}: {
  settings: AppSettings;
  updateSettings: UpdateSettingsFn;
}) {
  const provider = settings.embeddingsModel.provider;
  const apiKey = settings.embeddingsModel.apiKey || "";
  const model = settings.embeddingsModel.model;

  // Embedding-specific UI metadata (which providers we list in the dropdown,
  // plus their requiresApiKey / baseUrl defaults). The `envKey` is NOT stored
  // here — it's read from MODEL_PROVIDERS at the call site so the env-var
  // mapping has a single source of truth across the codebase.
  const embeddingProviders: Record<
    string,
    { name: string; requiresApiKey: boolean; baseUrl?: string }
  > = {
    openai: { name: "OpenAI", requiresApiKey: true },
    openrouter: { name: "OpenRouter", requiresApiKey: true },
    ollama: {
      name: "Ollama",
      requiresApiKey: false,
      baseUrl: "http://localhost:11434",
    },
    google: { name: "Google", requiresApiKey: true },
    custom: { name: "Custom (OpenAI-compatible)", requiresApiKey: true },
  };

  const embeddingMeta =
    embeddingProviders[provider] || embeddingProviders.openai;
  // Pull the env-var name from MODEL_PROVIDERS — single source of truth shared
  // with settings/route.ts, models/route.ts, and the chat-model wizard.
  const envKeyName = MODEL_PROVIDERS[provider]?.envKey;
  const providerConfig: typeof embeddingMeta & { envKey?: string } = {
    ...embeddingMeta,
    envKey: envKeyName,
  };
  const requiresApiKey = providerConfig.requiresApiKey;
  const envApiKeyAvailable =
    settings.envApiKeys?.[provider as keyof NonNullable<AppSettings["envApiKeys"]>] === true;

  const hasProvider = !!provider && provider !== "mock";
  const hasApiKey = !requiresApiKey || !!apiKey || envApiKeyAvailable;
  const hasModel = !!model;
  const currentStep = !hasProvider
    ? 1
    : !hasApiKey
      ? 2
      : !hasModel
        ? requiresApiKey
          ? 3
          : 2
        : requiresApiKey
          ? 4
          : 3;

  const { models, loading, error } = useModels(
    provider,
    apiKey,
    requiresApiKey,
    "embedding",
    settings.embeddingsModel.baseUrl,
    envApiKeyAvailable
  );

  const knownDimensions: Record<string, number> = {
    "text-embedding-3-small": 1536,
    "text-embedding-3-large": 3072,
    "text-embedding-ada-002": 1536,
    "text-embedding-004": 768,
    "nomic-embed-text": 768,
    "mxbai-embed-large": 1024,
    "all-minilm": 384,
    "bge-m3": 1024,
    "bge-large": 1024,
    "bge-base": 768,
    "e5-large": 1024,
    "e5-base": 768,
    "multilingual-e5": 1024,
    "mistral-embed": 1024,
    "gte-large": 1024,
    "gte-base": 768,
    "mpnet-base": 768,
  };

  return (
    <section className="border rounded-xl p-5 bg-card space-y-5 transition-all duration-300">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-lg">Embeddings Model</h3>
        <div className="flex items-center gap-4">
          <StepIndicator step={1} currentStep={currentStep} label="Provider" />
          {requiresApiKey && (
            <StepIndicator step={2} currentStep={currentStep} label="API Key" />
          )}
          <StepIndicator
            step={requiresApiKey ? 3 : 2}
            currentStep={currentStep}
            label="Model"
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Step 1 — Provider
        </Label>
        <select
          value={provider}
          onChange={(event) => {
            const nextProvider = event.target.value;
            updateSettings("embeddingsModel.provider", nextProvider);
            updateSettings("embeddingsModel.model", "");
            if (nextProvider === "ollama") {
              updateSettings("embeddingsModel.baseUrl", "http://localhost:11434/v1");
              updateSettings("embeddingsModel.apiKey", "");
            } else {
              updateSettings("embeddingsModel.baseUrl", "");
            }
          }}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
        >
          <option value="">Select provider...</option>
          {Object.entries(embeddingProviders).map(([key, providerOption]) => (
            <option key={key} value={key}>
              {providerOption.name}
            </option>
          ))}
        </select>
      </div>

      <div
        className={`space-y-2 transition-all duration-300 ${
          !hasProvider ? "opacity-40 pointer-events-none" : ""
        } ${!requiresApiKey ? "hidden" : ""}`}
      >
        <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Step 2 — API Key
        </Label>
        <ApiKeyInput
          apiKey={apiKey}
          onChange={(value) => updateSettings("embeddingsModel.apiKey", value)}
          envKey={providerConfig.envKey}
          envApiKeyAvailable={envApiKeyAvailable}
          disabled={!hasProvider}
        />
      </div>

      {hasProvider && !requiresApiKey && provider === "ollama" && (
        <div className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/30 rounded-lg px-3 py-2">
          <Check className="size-4" />
          API Key not required — connecting to local Ollama
        </div>
      )}

      {provider === "ollama" && (
        <div
          className={`space-y-2 transition-all duration-300 ${
            !hasProvider ? "opacity-40 pointer-events-none" : ""
          }`}
        >
          <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Base URL
          </Label>
          <Input
            value={settings.embeddingsModel.baseUrl || ""}
            onChange={(event) =>
              updateSettings("embeddingsModel.baseUrl", event.target.value)
            }
            placeholder="http://localhost:11434/v1"
            disabled={!hasProvider}
          />
        </div>
      )}

      <div
        className={`space-y-2 transition-all duration-300 ${
          !hasApiKey ? "opacity-40 pointer-events-none" : ""
        }`}
      >
        <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {requiresApiKey ? "Step 3" : "Step 2"} — Model
        </Label>
        <div className="flex gap-2">
          <div className="flex-1">
            <ModelSelect
              value={model}
              models={models}
              loading={loading}
              error={error}
              disabled={!hasApiKey}
              onChange={(value) => {
                updateSettings("embeddingsModel.model", value);
                let dimensions = 1536;
                for (const [pattern, knownValue] of Object.entries(knownDimensions)) {
                  if (value.includes(pattern)) {
                    dimensions = knownValue;
                    break;
                  }
                }
                updateSettings("embeddingsModel.dimensions", dimensions);
              }}
              placeholder="Select embedding model..."
            />
          </div>
          <div className="w-24">
            <Input
              type="number"
              value={settings.embeddingsModel.dimensions || 1536}
              onChange={(event) =>
                updateSettings(
                  "embeddingsModel.dimensions",
                  parseInt(event.target.value, 10)
                )
              }
              placeholder="Dims"
              title="Embedding Dimensions"
              disabled={!hasApiKey}
            />
          </div>
        </div>
        <p className="text-[10px] text-muted-foreground">
          Dimensions are auto-detected for known models. Adjust if necessary.
        </p>
      </div>
    </section>
  );
}
