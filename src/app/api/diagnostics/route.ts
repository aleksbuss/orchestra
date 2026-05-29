/**
 * /api/diagnostics — Full system health diagnostics
 *
 * Tests every provider's API key by making a real (minimal) API call.
 * Returns detailed status for each provider + preset readiness.
 */
import { NextRequest } from "next/server";
import { getSettings } from "@/lib/storage/settings-store";
import { PRESETS, PRESET_ORDER, type PresetTier } from "@/lib/agent/presets";
import {
  assertSafeOutboundUrl,
  UnsafeOutboundUrlError,
} from "@/lib/security/url-guard";

interface ProviderDiagnostic {
  provider: string;
  keySource: "vault" | "chatModel" | "env" | "none";
  keyPresent: boolean;
  keyPrefix: string; // first 8 chars masked
  apiTestResult: "ok" | "error" | "skipped";
  apiTestMessage: string;
  latencyMs: number | null;
}

interface PresetDiagnostic {
  tier: string;
  label: string;
  brainProvider: string;
  brainKeyReady: boolean;
  workerProvider: string;
  workerKeyReady: boolean;
  ready: boolean;
  issue: string | null;
}

interface DiagnosticsResult {
  timestamp: string;
  providers: ProviderDiagnostic[];
  presets: PresetDiagnostic[];
  envVars: Record<string, boolean>;
  recommendations: string[];
}

// Real API test functions per provider
async function testGoogleApi(apiKey: string): Promise<{ ok: boolean; message: string; latencyMs: number }> {
  const start = Date.now();
  try {
    // Use the list models endpoint — lightest possible call
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
      { method: "GET", signal: AbortSignal.timeout(15000) }
    );
    const latencyMs = Date.now() - start;

    if (res.ok) {
      const data = await res.json() as { models?: unknown[] };
      const count = Array.isArray(data.models) ? data.models.length : 0;
      return { ok: true, message: `Connected. ${count} models available.`, latencyMs };
    }

    const body = await res.text().catch(() => "");
    if (res.status === 400 && body.includes("API_KEY_INVALID")) {
      return { ok: false, message: "API key is invalid. Check the key in Google AI Studio.", latencyMs };
    }
    if (res.status === 403) {
      return { ok: false, message: `Forbidden (403): ${extractGoogleError(body)}. Enable the Generative Language API in Google Cloud Console.`, latencyMs };
    }
    if (res.status === 429) {
      return { ok: true, message: "Key valid but rate limited (429). Wait and retry.", latencyMs };
    }
    return { ok: false, message: `HTTP ${res.status}: ${extractGoogleError(body)}`, latencyMs };
  } catch (err) {
    return { ok: false, message: `Network error: ${err instanceof Error ? err.message : String(err)}`, latencyMs: Date.now() - start };
  }
}

async function testOpenRouterApi(apiKey: string): Promise<{ ok: boolean; message: string; latencyMs: number }> {
  const start = Date.now();
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15000),
    });
    const latencyMs = Date.now() - start;

    if (res.ok) {
      const data = await res.json() as { data?: unknown[] };
      const count = Array.isArray(data.data) ? data.data.length : 0;
      return { ok: true, message: `Connected. ${count} models available.`, latencyMs };
    }
    if (res.status === 401) {
      return { ok: false, message: "Invalid API key (401). Check your OpenRouter dashboard.", latencyMs };
    }
    if (res.status === 402) {
      return { ok: false, message: "No credits remaining (402). Add credits at openrouter.ai.", latencyMs };
    }
    return { ok: false, message: `HTTP ${res.status}`, latencyMs };
  } catch (err) {
    return { ok: false, message: `Network error: ${err instanceof Error ? err.message : String(err)}`, latencyMs: Date.now() - start };
  }
}

async function testOpenAiApi(apiKey: string): Promise<{ ok: boolean; message: string; latencyMs: number }> {
  const start = Date.now();
  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15000),
    });
    const latencyMs = Date.now() - start;

    if (res.ok) {
      return { ok: true, message: "Connected successfully.", latencyMs };
    }
    if (res.status === 401) {
      return { ok: false, message: "Invalid API key (401).", latencyMs };
    }
    return { ok: false, message: `HTTP ${res.status}`, latencyMs };
  } catch (err) {
    return { ok: false, message: `Network error: ${err instanceof Error ? err.message : String(err)}`, latencyMs: Date.now() - start };
  }
}

async function testAnthropicApi(apiKey: string): Promise<{ ok: boolean; message: string; latencyMs: number }> {
  const start = Date.now();
  try {
    // Anthropic doesn't have a /models endpoint, use a minimal completion
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-3-haiku-20240307",
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
      signal: AbortSignal.timeout(15000),
    });
    const latencyMs = Date.now() - start;

    if (res.ok) {
      return { ok: true, message: "Connected successfully.", latencyMs };
    }
    if (res.status === 401) {
      return { ok: false, message: "Invalid API key (401).", latencyMs };
    }
    if (res.status === 429) {
      return { ok: true, message: "Key valid but rate limited (429).", latencyMs };
    }
    return { ok: false, message: `HTTP ${res.status}`, latencyMs };
  } catch (err) {
    return { ok: false, message: `Network error: ${err instanceof Error ? err.message : String(err)}`, latencyMs: Date.now() - start };
  }
}

async function testOllamaApi(baseUrl?: string): Promise<{ ok: boolean; message: string; latencyMs: number }> {
  const start = Date.now();
  const url = (baseUrl || "http://localhost:11434").replace(/\/v1\/?$/, "");

  // PM #8 — SSRF guard. `baseUrl` originates from operator settings
  // (settings.chatModel.baseUrl), but the same defense-in-depth posture used
  // in /api/models/route.ts applies: anything that could resolve to a
  // private/link-local range (incl. cloud metadata 169.254.169.254) is
  // rejected. Loopback is intentionally allowed — local Ollama is the
  // primary use case.
  let safeUrl: URL;
  try {
    safeUrl = assertSafeOutboundUrl(`${url}/api/tags`);
  } catch (err) {
    if (err instanceof UnsafeOutboundUrlError) {
      return {
        ok: false,
        message: `Refused to probe baseUrl: ${err.message}`,
        latencyMs: Date.now() - start,
      };
    }
    throw err;
  }

  try {
    const res = await fetch(safeUrl, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });
    const latencyMs = Date.now() - start;

    if (res.ok) {
      const data = await res.json() as { models?: unknown[] };
      const count = Array.isArray(data.models) ? data.models.length : 0;
      return { ok: true, message: `Connected. ${count} local models.`, latencyMs };
    }
    return { ok: false, message: `HTTP ${res.status}`, latencyMs };
  } catch (err) {
    return { ok: false, message: `Ollama offline: ${err instanceof Error ? err.message : String(err)}`, latencyMs: Date.now() - start };
  }
}

function extractGoogleError(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    return parsed.error?.message || body.slice(0, 200);
  } catch {
    return body.slice(0, 200);
  }
}

function maskKey(key: string): string {
  if (!key) return "(empty)";
  if (key.length <= 8) return "****";
  return key.slice(0, 6) + "..." + key.slice(-4);
}

export async function GET(_req: NextRequest) {
  const settings = await getSettings();
  const vault = settings.providerApiKeys || {};

  // Resolve the actual key that would be used per provider
  function resolveKey(provider: string): { key: string; source: "vault" | "chatModel" | "env" | "none" } {
    // 1. Vault
    const vaultKey = vault[provider as keyof typeof vault];
    if (vaultKey) return { key: vaultKey, source: "vault" };

    // 2. Same provider as chatModel
    if (settings.chatModel.provider === provider && settings.chatModel.apiKey) {
      return { key: settings.chatModel.apiKey, source: "chatModel" };
    }

    // 3. Environment variable
    const envMap: Record<string, string> = {
      google: "GOOGLE_API_KEY",
      openai: "OPENAI_API_KEY",
      openrouter: "OPENROUTER_API_KEY",
      anthropic: "ANTHROPIC_API_KEY",
    };
    const envKey = envMap[provider] ? process.env[envMap[provider]] : undefined;
    if (envKey) return { key: envKey, source: "env" };

    return { key: "", source: "none" };
  }

  // Test all providers in parallel
  const providers = ["google", "openrouter", "openai", "anthropic", "ollama"];
  const diagnostics: ProviderDiagnostic[] = await Promise.all(
    providers.map(async (provider): Promise<ProviderDiagnostic> => {
      const resolved = resolveKey(provider);

      if (provider === "ollama") {
        const test = await testOllamaApi(settings.chatModel.baseUrl);
        return {
          provider,
          keySource: "none",
          keyPresent: true, // Ollama doesn't need keys
          keyPrefix: "(local)",
          apiTestResult: test.ok ? "ok" : "error",
          apiTestMessage: test.message,
          latencyMs: test.latencyMs,
        };
      }

      if (!resolved.key) {
        return {
          provider,
          keySource: resolved.source,
          keyPresent: false,
          keyPrefix: "(empty)",
          apiTestResult: "skipped",
          apiTestMessage: "No API key configured. Add one in Settings → API Key Vault.",
          latencyMs: null,
        };
      }

      // Run actual API test
      let test: { ok: boolean; message: string; latencyMs: number };
      switch (provider) {
        case "google":
          test = await testGoogleApi(resolved.key);
          break;
        case "openrouter":
          test = await testOpenRouterApi(resolved.key);
          break;
        case "openai":
          test = await testOpenAiApi(resolved.key);
          break;
        case "anthropic":
          test = await testAnthropicApi(resolved.key);
          break;
        default:
          test = { ok: false, message: "Unknown provider", latencyMs: 0 };
      }

      return {
        provider,
        keySource: resolved.source,
        keyPresent: true,
        keyPrefix: maskKey(resolved.key),
        apiTestResult: test.ok ? "ok" : "error",
        apiTestMessage: test.message,
        latencyMs: test.latencyMs,
      };
    })
  );

  // Check preset readiness
  const presetDiags: PresetDiagnostic[] = PRESET_ORDER
    .filter((t) => t !== "custom")
    .map((tier) => {
      const preset = PRESETS[tier as Exclude<PresetTier, "custom">];
      const brainKey = resolveKey(preset.brain.provider);
      const workerKey = preset.worker.provider === "ollama"
        ? { key: "ollama", source: "none" as const }
        : resolveKey(preset.worker.provider);

      const brainReady = !!brainKey.key;
      const workerReady = preset.worker.provider === "ollama" || !!workerKey.key;
      const issues: string[] = [];

      if (!brainReady) {
        issues.push(`Missing API key for brain (${preset.brain.provider})`);
      }
      if (!workerReady) {
        issues.push(`Missing API key for worker (${preset.worker.provider})`);
      }

      return {
        tier,
        label: preset.label,
        brainProvider: preset.brain.provider,
        brainKeyReady: brainReady,
        workerProvider: preset.worker.provider,
        workerKeyReady: workerReady,
        ready: brainReady && workerReady,
        issue: issues.length > 0 ? issues.join("; ") : null,
      };
    });

  // Environment check
  const envVars: Record<string, boolean> = {
    GOOGLE_API_KEY: !!process.env.GOOGLE_API_KEY,
    OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
    OPENROUTER_API_KEY: !!process.env.OPENROUTER_API_KEY,
    ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
  };

  // Generate recommendations
  const recommendations: string[] = [];

  const googleDiag = diagnostics.find((d) => d.provider === "google");
  if (!googleDiag?.keyPresent) {
    recommendations.push(
      "🔴 CRITICAL: No Google API key found. Presets Prime, Core, and Open all need it. " +
      "Get a free key at https://aistudio.google.com/apikey and add it in Settings → API Key Vault → Google AI."
    );
  } else if (googleDiag.apiTestResult === "error") {
    recommendations.push(
      `🟡 Google API key exists but test failed: ${googleDiag.apiTestMessage}`
    );
  }

  const ollamaDiag = diagnostics.find((d) => d.provider === "ollama");
  if (ollamaDiag?.apiTestResult === "error") {
    recommendations.push(
      "🟡 Ollama is offline. The 'Open' preset uses Ollama for workers. Start Ollama with: ollama serve"
    );
  }

  if (recommendations.length === 0) {
    recommendations.push("✅ All systems nominal. All presets are ready to use.");
  }

  const result: DiagnosticsResult = {
    timestamp: new Date().toISOString(),
    providers: diagnostics,
    presets: presetDiags,
    envVars,
    recommendations,
  };

  return Response.json(result, { status: 200 });
}
