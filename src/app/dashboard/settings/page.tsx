"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Check, Loader2, Moon, Save, ShieldCheck, Sun } from "lucide-react";
import { ChatModelWizard, UtilityModelWizard, EmbeddingsModelWizard, SkepticModelFields } from "@/components/settings/model-wizards";
import { ApiKeyVault } from "@/components/settings/api-key-vault";
import { updateSettingsByPath } from "@/lib/settings/update-settings-path";
import type { AppSettings } from "@/lib/types";

export default function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [authUsername, setAuthUsername] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authPasswordConfirm, setAuthPasswordConfirm] = useState("");
  const [authSaving, setAuthSaving] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSaved, setAuthSaved] = useState(false);

  useEffect(() => {
    fetch("/api/settings")
      .then((response) => response.json())
      .then((data) => {
        setSettings(data);
        if (data?.auth?.username && typeof data.auth.username === "string") {
          setAuthUsername(data.auth.username);
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  // Theme is applied ONLY in response to the user toggling the checkbox —
  // never on load. The live theme's source of truth is the `dark` class +
  // `localStorage["orchestra-theme"]` (set pre-paint by layout.tsx and by
  // <ThemeSwitcher>); force-applying the server's possibly-stale darkMode on
  // mount used to override the header toggle every time Settings opened.
  const applyTheme = useCallback((dark: boolean) => {
    document.documentElement.classList.toggle("dark", dark);
    try {
      localStorage.setItem("orchestra-theme", dark ? "dark" : "light");
    } catch {
      // Private mode / quota — the class change still themes this session.
    }
  }, []);

  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSave = useCallback(async (overrideSettings?: typeof settings) => {
    const toSave = overrideSettings ?? settings;
    if (!toSave) return;
    await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toSave),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }, [settings]);

  function updateSettings(path: string, value: unknown, autoSave = false) {
    setSettings((prev) => {
      if (!prev) return null;
      const next = updateSettingsByPath(prev, path, value);
      if (autoSave) {
        // Debounced auto-save: triggers 800ms after the last keystroke
        if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = setTimeout(() => {
          void handleSave(next);
        }, 800);
      }
      return next;
    });
  }

  async function handleUpdateAuth() {
    const username = authUsername.trim();
    const password = authPassword.trim();
    const passwordConfirm = authPasswordConfirm.trim();

    if (!username) {
      setAuthError("Username is required.");
      return;
    }
    if (password.length < 8) {
      setAuthError("Password must be at least 8 characters.");
      return;
    }
    if (password !== passwordConfirm) {
      setAuthError("Password confirmation does not match.");
      return;
    }

    try {
      setAuthSaving(true);
      setAuthError(null);
      setAuthSaved(false);

      const response = await fetch("/api/auth/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: string; username?: string }
        | null;

      if (!response.ok) {
        throw new Error(payload?.error || "Failed to update credentials.");
      }

      const normalizedUsername = payload?.username || username;
      setAuthUsername(normalizedUsername);
      setAuthPassword("");
      setAuthPasswordConfirm("");
      setAuthSaved(true);
      setTimeout(() => setAuthSaved(false), 2000);

      setSettings((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          auth: {
            ...prev.auth,
            username: normalizedUsername,
            mustChangeCredentials: false,
          },
        };
      });
    } catch (error) {
      setAuthError(
        error instanceof Error ? error.message : "Failed to update credentials."
      );
    } finally {
      setAuthSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!settings) return null;

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 md:p-6 max-w-3xl mx-auto w-full overflow-y-auto">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-2xl font-semibold">Settings</h2>
                  <p className="text-sm text-muted-foreground">
                    Configure AI models, tools, and preferences.
                  </p>
                </div>
                <Button onClick={() => void handleSave()} className="gap-2">
                  {saved ? (
                    <>
                      <Check className="size-4" />
                      Saved
                    </>
                  ) : (
                    <>
                      <Save className="size-4" />
                      Save Settings
                    </>
                  )}
                </Button>
              </div>

              <ChatModelWizard settings={settings} updateSettings={updateSettings} />
              <UtilityModelWizard settings={settings} updateSettings={updateSettings} />
              <EmbeddingsModelWizard settings={settings} updateSettings={updateSettings} />

              <section className="border rounded-xl p-5 bg-card space-y-4">
                <h3 className="font-semibold text-lg">Deep Audit Mode (Skeptic)</h3>
                <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
                  <div>
                    <p className="text-sm font-medium">Skeptic Tier</p>
                    <p className="text-sm text-muted-foreground">
                      Choose which model tier the Skeptic uses for reviewing and auditing code.
                      Frontier is recommended for deep reasoning.
                    </p>
                  </div>
                  <select
                    value={settings.proposerTiers?.skepticTier || "balanced"}
                    onChange={(e) =>
                      updateSettings("proposerTiers.skepticTier", e.target.value, true)
                    }
                    className="rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  >
                    <option value="fast">Fast</option>
                    <option value="balanced">Balanced</option>
                    <option value="frontier">Frontier</option>
                  </select>
                </div>
                {settings.proposerTiers?.skepticTier &&
                  !settings.proposerTiers?.[settings.proposerTiers.skepticTier]?.model &&
                  !settings.proposerTiers?.skeptic?.model && (
                    <p className="text-sm text-amber-500">
                      The &quot;{settings.proposerTiers.skepticTier}&quot; tier has no model
                      configured (see Tier Models below) — this selector is currently inert and
                      the Skeptic falls back to the default worker model.
                    </p>
                  )}

                {/* DDD — direct Skeptic model. Overrides the tier selector above
                    AND the reviewer Swarm-Sandbox role, and governs BOTH skeptic
                    surfaces (reviewer proposer + reflection critic). Empty model =
                    fall back to the tier path. */}
                <div className="space-y-2 rounded-lg border p-4">
                  <div>
                    <p className="text-sm font-medium">Direct Skeptic Model (overrides the tier)</p>
                    <p className="text-sm text-muted-foreground">
                      Pin the exact model the Skeptic runs on — the reviewer proposer AND the
                      reflection critic. Takes precedence over the tier selector above and the
                      reviewer role in Swarm Sandbox. Leave the model blank to use the tier path.
                      API key inherits from the key vault / chat model for the same provider.
                    </p>
                  </div>
                  <SkepticModelFields
                    settings={settings}
                    provider={settings.proposerTiers?.skeptic?.provider || "openrouter"}
                    model={settings.proposerTiers?.skeptic?.model ?? ""}
                    onChange={(prov, mdl) => {
                      updateSettings("proposerTiers.skeptic.provider", prov, true);
                      updateSettings("proposerTiers.skeptic.model", mdl, true);
                    }}
                  />
                  {settings.proposerTiers?.skeptic?.model && (
                    <button
                      type="button"
                      onClick={() => updateSettings("proposerTiers.skeptic.model", "", true)}
                      className="text-xs text-muted-foreground underline hover:text-foreground"
                    >
                      Clear — fall back to the tier path
                    </button>
                  )}
                  {settings.proposerTiers?.skeptic?.model &&
                    settings.swarmSandbox?.reviewer && (
                      <p className="text-sm text-amber-500">
                        Both a direct Skeptic model and a Swarm-Sandbox &quot;reviewer&quot; tier are
                        set — the direct model wins (most specific). Clear one to remove the overlap.
                      </p>
                    )}
                </div>
                <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
                  <div>
                    <p className="text-sm font-medium">Reflection loop (Doubt-Driven audit)</p>
                    <p className="text-sm text-muted-foreground">
                      After the swarm synthesizes an answer, a Skeptic critic audits it (runs on
                      the Direct Skeptic Model above if set, else the chat model); flagged issues
                      trigger a revision pass. Adds latency and cost per turn. Can also be toggled
                      per-turn from the chat swarm panel (&quot;Deep Audit&quot;).
                    </p>
                  </div>
                  <input
                    type="checkbox"
                    checked={settings.reflection?.enabled ?? false}
                    onChange={(e) =>
                      updateSettings("reflection.enabled", e.target.checked, true)
                    }
                    className="rounded"
                  />
                </div>
                {settings.reflection?.enabled && (
                  <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
                    <div>
                      <p className="text-sm font-medium">Max reflection rounds</p>
                      <p className="text-sm text-muted-foreground">
                        Critic → revisor iterations per turn (hard cap 3).
                      </p>
                    </div>
                    <Input
                      type="number"
                      min="1"
                      max="3"
                      className="w-24"
                      value={settings.reflection?.maxRounds ?? 1}
                      onChange={(e) => {
                        const val = parseInt(e.target.value, 10);
                        if (!isNaN(val) && val >= 1 && val <= 3) {
                          updateSettings("reflection.maxRounds", val, true);
                        }
                      }}
                    />
                  </div>
                )}
              </section>

              <section className="border rounded-xl p-5 bg-card space-y-4">
                <h3 className="font-semibold text-lg">Swarm Sandbox</h3>
                <p className="text-sm text-muted-foreground">
                  Hardcode model tiers for specific roles in the swarm. Auto will use default behaviors.
                </p>
                <div className="space-y-3 rounded-lg border p-4">
                  <div>
                    <p className="text-sm font-medium">Tier Models</p>
                    <p className="text-sm text-muted-foreground">
                      The model behind each tier. A tier without a model falls back to the
                      default worker (utility model). API keys inherit from the key vault /
                      chat model for the same provider.
                    </p>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-3">
                    {(["fast", "balanced", "frontier"] as const).map((tierName) => (
                      <div key={tierName} className="flex flex-col gap-2 rounded-lg border p-3">
                        <Label className="capitalize">{tierName}</Label>
                        <select
                          value={settings.proposerTiers?.[tierName]?.provider || "openrouter"}
                          onChange={(e) =>
                            updateSettings(
                              `proposerTiers.${tierName}.provider`,
                              e.target.value,
                              true
                            )
                          }
                          className="rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                        >
                          <option value="openrouter">OpenRouter</option>
                          <option value="ollama">Ollama</option>
                          <option value="openai">OpenAI</option>
                          <option value="anthropic">Anthropic</option>
                          <option value="google">Google</option>
                        </select>
                        <Input
                          placeholder="model id (empty = unset)"
                          value={settings.proposerTiers?.[tierName]?.model ?? ""}
                          onChange={(e) =>
                            updateSettings(
                              `proposerTiers.${tierName}.model`,
                              e.target.value,
                              true
                            )
                          }
                        />
                      </div>
                    ))}
                  </div>
                </div>
                <div className="flex items-center justify-between gap-4 rounded-lg border p-4 mb-4">
                  <div>
                    <p className="text-sm font-medium">Max Swarm Size</p>
                    <p className="text-sm text-muted-foreground">
                      Maximum number of parallel experts to spawn (3 to 7).
                    </p>
                  </div>
                  <Input
                    type="number"
                    min="3"
                    max="7"
                    className="w-24"
                    value={settings.maxSwarmSize ?? 5}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10);
                      if (!isNaN(val) && val >= 3 && val <= 7) {
                        updateSettings("maxSwarmSize", val, true);
                      }
                    }}
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  {(["coder", "researcher", "reviewer", "tool"] as const).map((role) => (
                    <div key={role} className="flex flex-col gap-2 rounded-lg border p-3">
                      <Label className="capitalize">{role} Tier</Label>
                      <select
                        value={settings.swarmSandbox?.[role] || "default"}
                        onChange={(e) => {
                          const val = e.target.value === "default" ? undefined : e.target.value;
                          updateSettings(`swarmSandbox.${role}`, val, true);
                        }}
                        className="rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                      >
                        <option value="default">Auto (Default)</option>
                        <option value="fast">Fast</option>
                        <option value="balanced">Balanced</option>
                        <option value="frontier">Frontier</option>
                      </select>
                    </div>
                  ))}
                </div>
              </section>

              <section className="border rounded-xl p-5 bg-card">
                <ApiKeyVault />
              </section>

              <section className="border rounded-xl p-5 bg-card space-y-4">
                <h3 className="font-semibold text-lg">Appearance</h3>
                <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
                  <div>
                    <p className="text-sm font-medium">Dark mode</p>
                    <p className="text-sm text-muted-foreground">
                      Switch between light and dark theme.
                    </p>
                  </div>
                  <Label
                    htmlFor="dark-mode-enabled"
                    className="flex cursor-pointer items-center gap-2"
                  >
                    <Sun className="size-4 text-muted-foreground" />
                    <input
                      id="dark-mode-enabled"
                      type="checkbox"
                      checked={settings.general.darkMode}
                      onChange={(e) => {
                        // Keep all three theme surfaces in sync: the live
                        // class, localStorage (pre-paint bootstrap), and the
                        // canonical server setting.
                        applyTheme(e.target.checked);
                        updateSettings("general.darkMode", e.target.checked);
                      }}
                      className="rounded"
                    />
                    <Moon className="size-4 text-muted-foreground" />
                  </Label>
                </div>
              </section>

              <section className="border rounded-xl p-5 bg-card space-y-4">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="size-5 text-primary" />
                  <h3 className="font-semibold text-lg">Authentication</h3>
                </div>
                <p className="text-sm text-muted-foreground">
                  Change dashboard login username and password.
                </p>
                <div className="grid gap-4 sm:grid-cols-3">
                  <div className="space-y-2">
                    <Label htmlFor="auth-username">Username</Label>
                    <Input
                      id="auth-username"
                      value={authUsername}
                      onChange={(e) => setAuthUsername(e.target.value)}
                      autoComplete="username"
                      placeholder="admin"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="auth-password">New Password</Label>
                    <Input
                      id="auth-password"
                      type="password"
                      value={authPassword}
                      onChange={(e) => setAuthPassword(e.target.value)}
                      autoComplete="new-password"
                      placeholder="At least 8 characters"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="auth-password-confirm">Confirm Password</Label>
                    <Input
                      id="auth-password-confirm"
                      type="password"
                      value={authPasswordConfirm}
                      onChange={(e) => setAuthPasswordConfirm(e.target.value)}
                      autoComplete="new-password"
                      placeholder="Repeat password"
                    />
                  </div>
                </div>

                {authError && <p className="text-sm text-destructive">{authError}</p>}

                <div className="flex items-center gap-2">
                  <Button
                    onClick={handleUpdateAuth}
                    disabled={authSaving}
                    className="gap-2"
                  >
                    {authSaving ? (
                      <>
                        <Loader2 className="size-4 animate-spin" />
                        Updating...
                      </>
                    ) : authSaved ? (
                      <>
                        <Check className="size-4" />
                        Updated
                      </>
                    ) : (
                      "Update Credentials"
                    )}
                  </Button>
                </div>
              </section>

              <section className="border rounded-xl p-5 bg-card space-y-4">
                <h3 className="font-semibold text-lg">Code Execution</h3>
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    id="code-enabled"
                    checked={settings.codeExecution.enabled}
                    onChange={(e) =>
                      updateSettings("codeExecution.enabled", e.target.checked)
                    }
                    className="rounded"
                  />
                  <Label htmlFor="code-enabled">
                    Enable code execution (Python, Node.js, Shell)
                  </Label>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Timeout (seconds)</Label>
                    <Input
                      type="number"
                      value={settings.codeExecution.timeout}
                      onChange={(e) =>
                        updateSettings(
                          "codeExecution.timeout",
                          parseInt(e.target.value, 10)
                        )
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Max Output Length</Label>
                    <Input
                      type="number"
                      value={settings.codeExecution.maxOutputLength}
                      onChange={(e) =>
                        updateSettings(
                          "codeExecution.maxOutputLength",
                          parseInt(e.target.value, 10)
                        )
                      }
                    />
                  </div>
                </div>
              </section>

              <section className="border rounded-xl p-5 bg-card space-y-4">
                <h3 className="font-semibold text-lg">Memory</h3>
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    id="memory-enabled"
                    checked={settings.memory.enabled}
                    onChange={(e) => updateSettings("memory.enabled", e.target.checked)}
                    className="rounded"
                  />
                  <Label htmlFor="memory-enabled">
                    Enable persistent vector memory
                  </Label>
                </div>
                <div className="grid gap-4 sm:grid-cols-3">
                  <div className="space-y-2">
                    <Label>Similarity Threshold</Label>
                    <Input
                      type="number"
                      step="0.05"
                      min="0"
                      max="1"
                      value={settings.memory.similarityThreshold}
                      onChange={(e) =>
                        updateSettings(
                          "memory.similarityThreshold",
                          parseFloat(e.target.value)
                        )
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Max Results</Label>
                    <Input
                      type="number"
                      value={settings.memory.maxResults}
                      onChange={(e) =>
                        updateSettings("memory.maxResults", parseInt(e.target.value, 10))
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Knowledge Chunk Size</Label>
                    <Input
                      type="number"
                      min="100"
                      max="4000"
                      step="50"
                      value={settings.memory.chunkSize}
                      onChange={(e) =>
                        updateSettings("memory.chunkSize", parseInt(e.target.value, 10))
                      }
                    />
                  </div>
                </div>
              </section>

              <section className="border rounded-xl p-5 bg-card space-y-4">
                <h3 className="font-semibold text-lg">Web Search</h3>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Provider</Label>
                    <select
                      value={settings.search.provider}
                      onChange={(e) => {
                        updateSettings("search.provider", e.target.value);
                        updateSettings("search.enabled", e.target.value !== "none");
                      }}
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    >
                      <option value="none">Disabled</option>
                      <option value="searxng">SearXNG (self-hosted)</option>
                      <option value="tavily">Tavily API</option>
                    </select>
                  </div>
                  {settings.search.provider === "tavily" && (
                    <div className="space-y-2">
                      <Label>Tavily API Key</Label>
                      <Input
                        type="password"
                        value={settings.search.apiKey || ""}
                        onChange={(e) => updateSettings("search.apiKey", e.target.value, true)}
                        placeholder="tvly-..."
                      />
                      <p className="text-xs text-muted-foreground">Auto-saves after typing stops.</p>
                    </div>
                  )}
                  {settings.search.provider === "searxng" && (
                    <div className="space-y-2">
                      <Label>SearXNG URL</Label>
                      <Input
                        value={settings.search.baseUrl || ""}
                        onChange={(e) => updateSettings("search.baseUrl", e.target.value, true)}
                        placeholder="http://localhost:8080"
                      />
                    </div>
                  )}
                </div>
                {settings.search.provider !== "none" && (
                  <div className="flex items-center gap-3 pt-2">
                    <Button onClick={() => void handleSave()} size="sm" className="gap-2">
                      {saved ? (
                        <><Check className="size-4" /> Saved</>
                      ) : (
                        <><Save className="size-4" /> Save Search Settings</>
                      )}
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      {saved ? "✓ Settings saved successfully" : "Click to save or just type — auto-saves after 0.8s"}
                    </span>
                  </div>
                )}
              </section>
    </div>
  );
}
