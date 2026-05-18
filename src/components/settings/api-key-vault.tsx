"use client";

import { useState, useEffect, useCallback } from "react";
import { Key, Eye, EyeOff, Check, Save, AlertCircle } from "lucide-react";

interface ProviderKeyEntry {
  id: string;
  label: string;
  envHint: string;
  placeholder: string;
}

const PROVIDERS: ProviderKeyEntry[] = [
  { id: "google", label: "Google AI", envHint: "GOOGLE_API_KEY", placeholder: "AIzaSy..." },
  { id: "openrouter", label: "OpenRouter", envHint: "OPENROUTER_API_KEY", placeholder: "sk-or-v1-..." },
  { id: "openai", label: "OpenAI", envHint: "OPENAI_API_KEY", placeholder: "sk-..." },
  { id: "anthropic", label: "Anthropic", envHint: "ANTHROPIC_API_KEY", placeholder: "sk-ant-..." },
];

export function ApiKeyVault() {
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [visibility, setVisibility] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [hasSavedKey, setHasSavedKey] = useState<Record<string, boolean>>({});

  // Load current keys from settings
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => {
        const vault: Record<string, string> = {};
        const saved: Record<string, boolean> = {};

        // Check provider vault
        if (data?.providerApiKeys) {
          for (const [provider, key] of Object.entries(data.providerApiKeys)) {
            if (key && typeof key === "string" && key.includes("****")) {
              // Masked = key exists on server, don't show masked value
              saved[provider] = true;
            } else if (key && typeof key === "string") {
              vault[provider] = key;
            }
          }
        }

        // Also check existing model configs for pre-fill
        if (!vault.openrouter && !saved.openrouter && data?.chatModel?.provider === "openrouter" && data.chatModel.apiKey && !data.chatModel.apiKey.includes("****")) {
          vault.openrouter = data.chatModel.apiKey;
        }

        setKeys(vault);
        setHasSavedKey(saved);
      })
      .catch((err) => console.error("Failed to load settings:", err));
  }, []);

  const updateKey = useCallback((provider: string, value: string) => {
    setKeys((prev) => ({ ...prev, [provider]: value }));
    setSaved(false);
  }, []);

  const toggleVisibility = useCallback((provider: string) => {
    setVisibility((prev) => ({ ...prev, [provider]: !prev[provider] }));
  }, []);

  const saveKeys = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "providerApiKeys", value: keys }),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }, [keys]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 mb-3">
        <div className="p-2 rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 text-white shadow-md shadow-amber-500/20">
          <Key className="w-5 h-5" />
        </div>
        <div>
          <h3 className="text-sm font-bold text-foreground">API Key Vault</h3>
          <p className="text-xs text-muted-foreground">
            Store API keys per provider. Presets use these keys automatically.
          </p>
        </div>
      </div>

      <div className="space-y-3">
        {PROVIDERS.map((p) => (
          <div key={p.id} className="group">
            <label className="text-xs font-semibold text-muted-foreground mb-1.5 flex items-center gap-1.5">
              <span>{p.label}</span>
              <span className="text-[10px] text-muted-foreground/50 font-mono">
                ({p.envHint})
              </span>
            </label>
            <div className="relative flex items-center">
              <input
                type={visibility[p.id] ? "text" : "password"}
                value={keys[p.id] || ""}
                onChange={(e) => updateKey(p.id, e.target.value)}
                placeholder={hasSavedKey[p.id] ? "••••• (saved, type to replace)" : p.placeholder}
                className={`
                  w-full px-3 py-2 pr-10 rounded-lg text-sm font-mono
                  bg-muted/30 border
                  ${hasSavedKey[p.id] && !keys[p.id] ? "border-emerald-500/30" : "border-white/5"}
                  text-foreground placeholder:text-muted-foreground/30
                  focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/40
                  transition-all duration-200
                `}
              />
              <button
                type="button"
                onClick={() => toggleVisibility(p.id)}
                className="absolute right-2 p-1 rounded text-muted-foreground/50 hover:text-muted-foreground transition-colors"
              >
                {visibility[p.id] ? (
                  <EyeOff className="w-4 h-4" />
                ) : (
                  <Eye className="w-4 h-4" />
                )}
              </button>
            </div>
          </div>
        ))}
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-red-400">
          <AlertCircle className="w-3.5 h-3.5" />
          {error}
        </div>
      )}

      <button
        onClick={saveKeys}
        disabled={saving}
        className={`
          flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold
          transition-all duration-300
          ${saved
            ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
            : "bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20"
          }
          disabled:opacity-50
        `}
      >
        {saving ? (
          <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
        ) : saved ? (
          <Check className="w-4 h-4" />
        ) : (
          <Save className="w-4 h-4" />
        )}
        {saving ? "Saving..." : saved ? "Saved!" : "Save API Keys"}
      </button>
    </div>
  );
}
