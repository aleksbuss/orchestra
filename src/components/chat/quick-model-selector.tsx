"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { ChevronDown, Zap, Check, Loader2, KeyRound } from "lucide-react";
import { MODEL_PROVIDERS } from "@/lib/providers/model-config";
import { useAppStore } from "@/store/app-store";

interface QuickModelSelectorProps {
  disabled?: boolean;
}

interface SettingsPayload {
  chatModel?: {
    provider?: string;
    model?: string;
    apiKey?: string;
    authMethod?: string;
    baseUrl?: string;
    temperature?: number;
    maxTokens?: number;
  };
}

interface ModelItem {
  id: string;
  name: string;
}

const POPULAR_MODELS: Record<string, string[]> = {
  openrouter: [
    "anthropic/claude-sonnet-4",
    "anthropic/claude-3.5-sonnet",
    "openai/gpt-4o",
    "openai/gpt-4o-mini",
    "google/gemini-2.5-pro-preview",
    "google/gemini-2.5-flash-preview",
    "deepseek/deepseek-chat-v3",
    "meta-llama/llama-4-maverick",
  ],
  openai: ["gpt-4o", "gpt-4o-mini", "o3-mini", "o4-mini"],
  anthropic: [
    "claude-sonnet-4-20250514",
    "claude-3-5-sonnet-20241022",
    "claude-3-haiku-20240307",
  ],
  google: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"],
};

function getProviderColor(provider: string): string {
  switch (provider) {
    case "openrouter":
      return "from-violet-500 to-fuchsia-500";
    case "openai":
      return "from-emerald-500 to-teal-500";
    case "anthropic":
      return "from-amber-500 to-orange-500";
    case "google":
      return "from-blue-500 to-cyan-500";
    case "ollama":
      return "from-gray-500 to-slate-500";
    case "codex-cli":
      return "from-green-500 to-emerald-500";
    case "gemini-cli":
      return "from-indigo-500 to-blue-500";
    default:
      return "from-gray-500 to-gray-600";
  }
}

function getProviderLabel(provider: string): string {
  const config = MODEL_PROVIDERS[provider];
  return config?.name || provider;
}

function getModelShortName(model: string): string {
  // For OpenRouter models like "anthropic/claude-3.5-sonnet", show "claude-3.5-sonnet"
  const parts = model.split("/");
  const name = parts[parts.length - 1];
  // Trim long names
  if (name.length > 22) return name.slice(0, 20) + "…";
  return name;
}

export function QuickModelSelector({ disabled }: QuickModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [currentProvider, setCurrentProvider] = useState("");
  const [currentModel, setCurrentModel] = useState("");
  const [saving, setSaving] = useState(false);
  const [showApiKeyInput, setShowApiKeyInput] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [models, setModels] = useState<ModelItem[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);
  const activePreset = useAppStore((s) => s.activePreset);
  const setActivePreset = useAppStore((s) => s.setActivePreset);

  // Load current settings on mount
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data: SettingsPayload) => {
        setCurrentProvider(data.chatModel?.provider || "ollama");
        setCurrentModel(data.chatModel?.model || "");
      })
      .catch(() => {});
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
        setShowApiKeyInput(false);
      }
    }
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () =>
        document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen]);

  // Load models when provider is selected
  const loadModels = useCallback(async (provider: string) => {
    setLoadingModels(true);
    try {
      const params = new URLSearchParams({ provider, type: "chat" });
      const res = await fetch(`/api/models?${params}`);
      const data = (await res.json()) as { models?: ModelItem[] };
      setModels(data.models || []);
    } catch {
      setModels([]);
    } finally {
      setLoadingModels(false);
    }
  }, []);

  const handleProviderSelect = useCallback(
    (provider: string) => {
      setSelectedProvider(provider);
      const providerConfig = MODEL_PROVIDERS[provider];
      const requiresApiKey = providerConfig?.requiresApiKey ?? true;

      if (
        requiresApiKey &&
        provider !== currentProvider &&
        provider !== "ollama"
      ) {
        setShowApiKeyInput(true);
      } else {
        setShowApiKeyInput(false);
        void loadModels(provider);
      }
    },
    [currentProvider, loadModels]
  );

  const handleApiKeySave = useCallback(() => {
    setShowApiKeyInput(false);
    void loadModels(selectedProvider);
  }, [selectedProvider, loadModels]);

  const handleModelSelect = useCallback(
    async (provider: string, model: string) => {
      setSaving(true);
      try {
        // Get current full settings first
        const settingsRes = await fetch("/api/settings");
        const fullSettings = (await settingsRes.json()) as Record<
          string,
          unknown
        >;

        // Prepare the update
        const providerConfig = MODEL_PROVIDERS[provider];
        const isOllama = provider === "ollama";
        const updatedSettings = {
          ...fullSettings,
          chatModel: {
            ...(typeof fullSettings.chatModel === "object" &&
            fullSettings.chatModel !== null
              ? fullSettings.chatModel
              : {}),
            provider,
            model,
            authMethod:
              providerConfig?.defaultAuthMethod ||
              providerConfig?.authMethods?.[0] ||
              "api_key",
            ...(apiKeyInput.trim() ? { apiKey: apiKeyInput.trim() } : {}),
            // Critical: reset baseUrl when switching away from Ollama,
            // otherwise requests go to localhost:11434 instead of the provider's API
            baseUrl: isOllama ? "http://localhost:11434/v1" : "",
            ...(isOllama ? { apiKey: "" } : {}),
          },
        };

        const saveRes = await fetch("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(updatedSettings),
        });

        if (saveRes.ok) {
          setCurrentProvider(provider);
          setCurrentModel(model);
          setIsOpen(false);
          setApiKeyInput("");
          setShowApiKeyInput(false);
          // CRITICAL: Switch to "custom" preset so the model selector
          // isn't overridden by an active preset (e.g. Core → Google)
          setActivePreset("custom");
        }
      } catch (err) {
        console.error("Failed to switch model:", err);
      } finally {
        setSaving(false);
      }
    },
    [apiKeyInput]
  );

  const providerKeys = Object.keys(MODEL_PROVIDERS);

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Trigger Button */}
      <button
        type="button"
        onClick={() => {
          setIsOpen(!isOpen);
          if (!isOpen) {
            setSelectedProvider("");
            setShowApiKeyInput(false);
          }
        }}
        disabled={disabled || saving}
        className={`
          flex items-center gap-1.5 rounded-full px-3 py-1.5
          text-[11px] font-medium tracking-wide
          transition-all duration-200
          border border-white/10 hover:border-white/20
          ${isOpen ? "bg-white/15 shadow-lg" : "bg-white/5 hover:bg-white/10"}
          text-muted-foreground hover:text-foreground
          disabled:opacity-50 disabled:cursor-not-allowed
          backdrop-blur-sm
        `}
        title={`Current: ${getProviderLabel(currentProvider)} / ${currentModel}`}
      >
        <span
          className={`size-2 rounded-full bg-gradient-to-r ${getProviderColor(currentProvider)} shrink-0`}
        />
        <span className="max-w-[120px] truncate">
          {activePreset !== "custom" 
            ? `Preset: ${activePreset}`
            : currentModel
              ? getModelShortName(currentModel)
              : getProviderLabel(currentProvider)}
        </span>
        <ChevronDown
          className={`size-3 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
        />
      </button>

      {/* Dropdown Panel */}
      {isOpen && (
        <div
          className="
            absolute bottom-full left-0 mb-2 z-50
            w-[340px] max-h-[420px]
            rounded-2xl border border-white/15
            bg-background/95 dark:bg-[#0a0a1a]/95
            backdrop-blur-2xl shadow-2xl
            overflow-hidden
            animate-in fade-in slide-in-from-bottom-2 duration-200
          "
        >
          {/* Header */}
          <div className="px-4 py-3 border-b border-white/10">
            <div className="flex items-center gap-2">
              <Zap className="size-4 text-violet-400" />
              <span className="text-sm font-semibold text-foreground">
                Quick Model Switch
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Change provider & model instantly
            </p>
          </div>

          {/* Provider Chips */}
          <div className="px-3 py-2.5 border-b border-white/10">
            <div className="flex flex-wrap gap-1.5">
              {providerKeys.map((key) => {
                const isActive = selectedProvider === key;
                const isCurrent = currentProvider === key && !selectedProvider;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => handleProviderSelect(key)}
                    className={`
                      flex items-center gap-1.5 rounded-full px-2.5 py-1
                      text-[11px] font-medium transition-all duration-150
                      ${
                        isActive
                          ? "bg-white/15 text-foreground ring-1 ring-white/20"
                          : isCurrent
                            ? "bg-white/10 text-foreground/80"
                            : "bg-white/5 text-muted-foreground hover:bg-white/10 hover:text-foreground"
                      }
                    `}
                  >
                    <span
                      className={`size-1.5 rounded-full bg-gradient-to-r ${getProviderColor(key)}`}
                    />
                    {getProviderLabel(key)}
                    {currentProvider === key && !selectedProvider && (
                      <Check className="size-3 text-emerald-400" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* API Key Input (if needed) */}
          {showApiKeyInput && (
            <div className="px-3 py-2.5 border-b border-white/10">
              <div className="flex items-center gap-2">
                <KeyRound className="size-3.5 text-amber-400 shrink-0" />
                <input
                  type="password"
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  placeholder={`${getProviderLabel(selectedProvider)} API key...`}
                  className="
                    flex-1 rounded-lg border border-white/10 bg-white/5
                    px-2.5 py-1.5 text-xs text-foreground
                    placeholder:text-muted-foreground/60
                    focus:outline-none focus:border-violet-500/50
                  "
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && apiKeyInput.trim()) {
                      handleApiKeySave();
                    }
                  }}
                />
                <button
                  type="button"
                  onClick={handleApiKeySave}
                  disabled={!apiKeyInput.trim()}
                  className="
                    rounded-lg bg-violet-500/20 hover:bg-violet-500/30
                    px-2.5 py-1.5 text-[11px] font-medium text-violet-300
                    disabled:opacity-40 transition-colors
                  "
                >
                  OK
                </button>
              </div>
              <p className="text-[10px] text-muted-foreground/60 mt-1 pl-5">
                Or set via .env / Settings page
              </p>
            </div>
          )}

          {/* Models List */}
          <div className="overflow-y-auto max-h-[260px] overscroll-contain">
            {!selectedProvider && !showApiKeyInput && (
              <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                <Zap className="size-5 mx-auto mb-2 text-violet-400/50" />
                Pick a provider above to see models
              </div>
            )}

            {loadingModels && (
              <div className="px-4 py-6 text-center">
                <Loader2 className="size-4 mx-auto animate-spin text-muted-foreground" />
                <p className="text-xs text-muted-foreground mt-2">
                  Loading models...
                </p>
              </div>
            )}

            {selectedProvider &&
              !loadingModels &&
              !showApiKeyInput &&
              (() => {
                // Show popular models first, then the rest
                const popular = POPULAR_MODELS[selectedProvider] || [];
                const popularSet = new Set(popular);
                const fetchedIds = new Set(models.map((m) => m.id));

                // Popular models that exist in the fetched list (or show anyway for OpenRouter)
                const topModels = popular
                  .filter(
                    (id) =>
                      fetchedIds.has(id) || selectedProvider === "openrouter"
                  )
                  .map((id) => ({
                    id,
                    name: models.find((m) => m.id === id)?.name || id,
                  }));

                // The rest, excluding popular ones already shown
                const otherModels = models.filter(
                  (m) => !popularSet.has(m.id)
                );

                const allModels = [...topModels, ...otherModels];

                if (allModels.length === 0) {
                  return (
                    <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                      No models found. Check your API key.
                    </div>
                  );
                }

                return (
                  <>
                    {topModels.length > 0 && (
                      <div className="px-3 pt-2 pb-1">
                        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                          ⭐ Recommended
                        </span>
                      </div>
                    )}
                    {topModels.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() =>
                          void handleModelSelect(selectedProvider, m.id)
                        }
                        disabled={saving}
                        className={`
                          w-full flex items-center gap-2 px-4 py-2 text-left
                          text-xs transition-colors duration-100
                          hover:bg-white/8 active:bg-white/12
                          ${
                            currentProvider === selectedProvider &&
                            currentModel === m.id
                              ? "bg-white/10 text-foreground"
                              : "text-foreground/80"
                          }
                        `}
                      >
                        <span
                          className={`size-1.5 rounded-full bg-gradient-to-r ${getProviderColor(selectedProvider)} shrink-0`}
                        />
                        <span className="flex-1 truncate">
                          {getModelShortName(m.id)}
                        </span>
                        {currentProvider === selectedProvider &&
                          currentModel === m.id && (
                            <Check className="size-3 text-emerald-400 shrink-0" />
                          )}
                      </button>
                    ))}

                    {otherModels.length > 0 && (
                      <>
                        <div className="px-3 pt-3 pb-1">
                          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                            All models
                          </span>
                        </div>
                        {otherModels.map((m) => (
                          <button
                            key={m.id}
                            type="button"
                            onClick={() =>
                              void handleModelSelect(selectedProvider, m.id)
                            }
                            disabled={saving}
                            className={`
                              w-full flex items-center gap-2 px-4 py-2 text-left
                              text-xs transition-colors duration-100
                              hover:bg-white/8 active:bg-white/12
                              ${
                                currentProvider === selectedProvider &&
                                currentModel === m.id
                                  ? "bg-white/10 text-foreground"
                                  : "text-foreground/80"
                              }
                            `}
                          >
                            <span className="size-1.5 rounded-full bg-white/20 shrink-0" />
                            <span className="flex-1 truncate">
                              {m.name || m.id}
                            </span>
                            {currentProvider === selectedProvider &&
                              currentModel === m.id && (
                                <Check className="size-3 text-emerald-400 shrink-0" />
                              )}
                          </button>
                        ))}
                      </>
                    )}
                  </>
                );
              })()}
          </div>

          {/* Footer: saving indicator */}
          {saving && (
            <div className="px-4 py-2 border-t border-white/10 flex items-center gap-2">
              <Loader2 className="size-3 animate-spin text-violet-400" />
              <span className="text-[11px] text-muted-foreground">
                Switching model...
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
