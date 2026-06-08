import { NextRequest } from "next/server";
import { getCliProviderModels } from "@/lib/providers/cli-models";
import { MODEL_PROVIDERS } from "@/lib/providers/model-config";
import { getSettings } from "@/lib/storage/settings-store";
import {
  assertSafeOutboundUrl,
  UnsafeOutboundUrlError,
} from "@/lib/security/url-guard";

const MODELS_FETCH_TIMEOUT_MS = 5000;

export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url);
    const provider = searchParams.get("provider") || "";
    let apiKey = searchParams.get("apiKey") || "";
    const type = searchParams.get("type") || "chat"; // "chat" | "embedding"

    // A masked key (the UI's display placeholder containing "****") is NOT a
    // real credential. Treat it as absent so the resolution below restores the
    // real key from settings — otherwise the masked string was forwarded
    // upstream verbatim, the provider returned 400, and the route 500'd. This
    // is exactly what broke the Settings → embeddings model dropdown: the inner
    // resolution branches all gate on `!apiKey`, which a truthy masked string
    // never satisfies, so the key was never resolved.
    if (apiKey.includes("****")) {
        apiKey = "";
    }

    // If apiKey is missing, try to get it from server-side settings
    if (!apiKey) {
        try {
            const settings = await getSettings();
            
            // 1. Check Global API Key Vault first
            if (settings.providerApiKeys && settings.providerApiKeys[provider as keyof typeof settings.providerApiKeys]) {
                apiKey = settings.providerApiKeys[provider as keyof typeof settings.providerApiKeys] || "";
            }
            
            // 2. Check localized configured models
            if (!apiKey && type === "chat") {
                if (settings.chatModel.provider === provider && settings.chatModel.apiKey) {
                    apiKey = settings.chatModel.apiKey;
                } else if (settings.utilityModel.provider === provider && settings.utilityModel.apiKey) {
                    apiKey = settings.utilityModel.apiKey;
                }
            } else if (!apiKey && type === "embedding" && settings.embeddingsModel.provider === provider && settings.embeddingsModel.apiKey) {
                apiKey = settings.embeddingsModel.apiKey;
            }
            
            // 3. Fallback to process.env via the provider's documented envKey
            //    in MODEL_PROVIDERS. Single source of truth — see also
            //    settings/route.ts → getEnvApiKeyAvailability and the wizard UI.
            if (!apiKey) {
                const envKey = MODEL_PROVIDERS[provider]?.envKey;
                if (envKey) {
                    apiKey = process.env[envKey] || "";
                }
            }
        } catch (e) {
            console.error("Failed to load settings for API key lookup", e);
        }
    }

    try {
        let models: { id: string; name: string }[] = [];

        switch (provider) {
            case "openai": {
                const res = await fetch("https://api.openai.com/v1/models", {
                    headers: { Authorization: `Bearer ${apiKey}` },
                });
                if (!res.ok) throw new Error(`OpenAI API error: ${res.status}`);
                const data = await res.json();
                models = data.data
                    .filter((m: { id: string }) => {
                        if (type === "embedding") {
                            return m.id.includes("text-embedding") || m.id.includes("embedding");
                        }
                        return m.id.startsWith("gpt-") || m.id.startsWith("o1") || m.id.startsWith("o3") || m.id.startsWith("o4");
                    })
                    .map((m: { id: string }) => ({ id: m.id, name: m.id }))
                    .sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id));
                break;
            }

            case "openrouter": {
                let url = "https://openrouter.ai/api/v1/models";
                if (type === "embedding") {
                    url = "https://openrouter.ai/api/v1/embeddings/models";
                }

                const res = await fetch(url, {
                    headers: { Authorization: `Bearer ${apiKey}` },
                });
                if (!res.ok) throw new Error(`OpenRouter API error: ${res.status}`);
                const data = await res.json();

                // OpenRouter embeddings endpoint might return array directly or { data: [] }
                const rawModels = Array.isArray(data) ? data : (data.data || []);

                models = rawModels
                    .map((m: { id: string; name?: string }) => ({
                        id: m.id,
                        name: m.name || m.id,
                    }))
                    .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));
                break;
            }

            case "ollama": {
                const rawBaseUrl = (searchParams.get("baseUrl") || "http://localhost:11434").trim();
                const normalizedBaseUrl = rawBaseUrl
                    .replace(/\/+$/, "")
                    .replace(/\/v1$/, "");

                // PM #8 — SSRF guard. The default `http://localhost:11434` is
                // always allowed (loopback is intentional policy); user-supplied
                // baseUrl is validated against private/link-local ranges (incl.
                // cloud metadata at 169.254.169.254). Timeout caps long fetches.
                let safeUrl: URL;
                try {
                    safeUrl = assertSafeOutboundUrl(`${normalizedBaseUrl}/api/tags`);
                } catch (err) {
                    if (err instanceof UnsafeOutboundUrlError) {
                        return Response.json(
                            { error: `Refused to fetch from baseUrl: ${err.message}` },
                            { status: 400 }
                        );
                    }
                    throw err;
                }

                const res = await fetch(safeUrl, {
                    signal: AbortSignal.timeout(MODELS_FETCH_TIMEOUT_MS),
                });
                if (!res.ok) throw new Error(`Ollama API error: ${res.status}`);
                const data = await res.json();
                // Ollama returns all models. We can't reliably distinguish embedding vs chat without 'show' API
                // For now, return all.
                models = (data.models || []).map((m: { name: string; model?: string }) => ({
                    id: m.name,
                    name: m.name,
                }));
                break;
            }

            case "anthropic": {
                if (type === "embedding") {
                    models = []; // Anthropic API doesn't list embedding models (they don't have public ones via this API usually)
                    break;
                }
                const res = await fetch("https://api.anthropic.com/v1/models?limit=1000", {
                    headers: {
                        "x-api-key": apiKey,
                        "anthropic-version": "2023-06-01",
                    },
                });
                if (!res.ok) throw new Error(`Anthropic API error: ${res.status}`);
                const data = await res.json();
                models = (data.data || [])
                    .filter((m: { type: string; id: string }) => m.type === "model")
                    .map((m: { id: string; display_name?: string }) => ({
                        id: m.id,
                        name: m.display_name || m.id,
                    }))
                    .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));
                break;
            }

            case "google": {
                const res = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
                );
                if (!res.ok) throw new Error(`Google API error: ${res.status}`);
                const data = await res.json();
                models = (data.models || [])
                    .map((m: { name: string; displayName?: string }) => ({
                        id: m.name.replace("models/", ""),
                        name: m.displayName || m.name.replace("models/", ""),
                    }))
                    .filter((m: { id: string }) => {
                        if (type === "embedding") {
                            return m.id.includes("embedding");
                        }
                        return m.id.includes("gemini");
                    })
                    .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));
                break;
            }

            case "codex-cli": {
                if (type === "embedding") {
                    models = [];
                    break;
                }
                const fallback = MODEL_PROVIDERS["codex-cli"]?.models || [];
                try {
                    models = await getCliProviderModels("codex-cli", fallback);
                } catch {
                    models = [...fallback];
                }
                break;
            }

            case "gemini-cli": {
                if (type === "embedding") {
                    models = [];
                    break;
                }
                const fallback = MODEL_PROVIDERS["gemini-cli"]?.models || [];
                try {
                    models = await getCliProviderModels("gemini-cli", fallback);
                } catch {
                    models = [...fallback];
                }
                break;
            }

            default: {
                const providerConfig = MODEL_PROVIDERS[provider];
                if (providerConfig) {
                    models = [...providerConfig.models];
                }
                break;
            }
        }

        return Response.json({ models });
    } catch (error) {
        return Response.json(
            {
                error: error instanceof Error ? error.message : "Failed to fetch models",
                models: [],
            },
            { status: 500 }
        );
    }
}
