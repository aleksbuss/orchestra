import { NextRequest } from "next/server";
import { getSettings, saveSettings } from "@/lib/storage/settings-store";
import { updateSettingsByPath } from "@/lib/settings/update-settings-path";
import { MODEL_PROVIDERS } from "@/lib/providers/model-config";
import { publishUiSyncEvent } from "@/lib/realtime/event-bus";
import type { AppSettings, ModelConfig } from "@/lib/types";

const ALLOWED_PATCH_ROOTS = new Set([
  "chatModel", "utilityModel", "embeddingsModel",
  "codeExecution", "memory", "search", "general", "providerApiKeys",
]);

const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Probe `process.env` for each provider's documented env var (`envKey` in
 * MODEL_PROVIDERS — the single source of truth, also used by llm-provider.ts
 * and the wizard UI). Adding a new provider with an `envKey` to model-config
 * automatically flows here, the wizard, and the models endpoint.
 */
function getEnvApiKeyAvailability(): Partial<Record<ModelConfig["provider"], boolean>> {
  const result: Partial<Record<ModelConfig["provider"], boolean>> = {};
  for (const [provider, def] of Object.entries(MODEL_PROVIDERS)) {
    if (def.envKey && process.env[def.envKey]) {
      result[provider as ModelConfig["provider"]] = true;
    }
  }
  return result;
}

export async function GET() {
  const settings = await getSettings();
  const masked = maskSettingsKeys(settings);
  // envApiKeys is server-derived, never persisted — strip on every PUT.
  masked.envApiKeys = getEnvApiKeyAvailability();
  return Response.json(masked);
}

export async function PUT(req: NextRequest) {
  try {
    const body = (await req.json()) as Partial<AppSettings>;
    // envApiKeys is server-derived only — if the client echoed it back,
    // strip it so it can never be persisted to disk and confuse later reads.
    if (body.envApiKeys !== undefined) {
      delete body.envApiKeys;
    }
    const current = await getSettings();
    const sanitized = restoreMaskedKeys(body, current);
    const updated = await saveSettings(sanitized);
    const masked = maskSettingsKeys(updated);
    masked.envApiKeys = getEnvApiKeyAvailability();
    // Multi-tab: editing settings in Tab A used to leave Tab B's view stale
    // until the next focus event. Settings affect every screen, so broadcast
    // on "global" — the catch-all topic every consumer subscribes to.
    publishUiSyncEvent({ topic: "global", reason: "[Settings] Settings saved." });
    return Response.json(masked);
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to save settings",
      },
      { status: 500 }
    );
  }
}

/**
 * PATCH: Update a single settings field by path.
 * Body: { path: string, value: unknown }
 */
export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const { path, value } = body as { path: string; value: unknown };

    if (!path || typeof path !== "string") {
      return Response.json({ error: "Missing 'path' field" }, { status: 400 });
    }

    const segments = path.split(".");
    if (segments.length === 0 || segments.some((s) => FORBIDDEN_SEGMENTS.has(s))) {
      return Response.json({ error: "Invalid settings path" }, { status: 400 });
    }
    if (!ALLOWED_PATCH_ROOTS.has(segments[0])) {
      return Response.json({ error: "Invalid settings path" }, { status: 400 });
    }

    const current = await getSettings();
    const updated = updateSettingsByPath(current, path, value);

    const saved = await saveSettings(updated);
    publishUiSyncEvent({ topic: "global", reason: "[Settings] Settings patched." });
    return Response.json(maskSettingsKeys(saved));
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to patch settings",
      },
      { status: 500 }
    );
  }
}

function maskSettingsKeys(settings: AppSettings): AppSettings {
  const masked: AppSettings = structuredClone(settings);

  if (masked.chatModel.apiKey) {
    masked.chatModel.apiKey = maskKey(masked.chatModel.apiKey);
  }
  if (masked.utilityModel?.apiKey) {
    masked.utilityModel.apiKey = maskKey(masked.utilityModel.apiKey);
  }
  if (masked.embeddingsModel.apiKey) {
    masked.embeddingsModel.apiKey = maskKey(masked.embeddingsModel.apiKey);
  }
  if (masked.search.apiKey) {
    masked.search.apiKey = maskKey(masked.search.apiKey);
  }
  if (masked.auth.passwordHash) {
    masked.auth.passwordHash = maskKey(masked.auth.passwordHash);
  }

  // Mask provider API keys in the vault
  if (masked.providerApiKeys) {
    const maskedVault: Record<string, string> = {};
    for (const [provider, key] of Object.entries(masked.providerApiKeys)) {
      if (key) {
        maskedVault[provider] = maskKey(key);
      }
    }
    masked.providerApiKeys = maskedVault;
  }

  return masked;
}

function restoreMaskedKeys(
  incoming: Partial<AppSettings>,
  current: AppSettings
): Partial<AppSettings> {
  const next: Partial<AppSettings> = structuredClone(incoming);

  if (isMaskedKey(next.chatModel?.apiKey)) {
    next.chatModel = {
      ...(next.chatModel || {}),
      apiKey: current.chatModel.apiKey,
    };
  }

  if (isMaskedKey(next.utilityModel?.apiKey)) {
    next.utilityModel = {
      ...(next.utilityModel || {}),
      apiKey: current.utilityModel?.apiKey,
    };
  }

  if (isMaskedKey(next.embeddingsModel?.apiKey)) {
    next.embeddingsModel = {
      ...(next.embeddingsModel || {}),
      apiKey: current.embeddingsModel.apiKey,
    };
  }

  if (isMaskedKey(next.search?.apiKey)) {
    next.search = {
      ...(next.search || {}),
      apiKey: current.search.apiKey,
    };
  }
  if (isMaskedKey(next.auth?.passwordHash)) {
    next.auth = {
      ...(next.auth || {}),
      passwordHash: current.auth.passwordHash,
    };
  }

  // Restore masked vault keys
  if (next.providerApiKeys && current.providerApiKeys) {
    for (const [provider, key] of Object.entries(next.providerApiKeys)) {
      if (isMaskedKey(key)) {
        (next.providerApiKeys as Record<string, string>)[provider] =
          (current.providerApiKeys as Record<string, string>)[provider] || "";
      }
    }
  }

  return next;
}

/**
 * The two exact shapes `maskKey` produces — either the short fallback `****`
 * (key length ≤ 8) or `XXXX****YYYY` (4 + 4 + 4 chars). Anchored to avoid
 * false positives where a real API key happens to contain `****` as a
 * substring (`includes("****")` would otherwise treat the user's actual key
 * as masked and silently restore the persisted value on save, blowing away
 * the new key the user just typed).
 */
const MASK_RE = /^(?:\*{4}|.{4}\*{4}.{4})$/;

function isMaskedKey(value: unknown): value is string {
  return typeof value === "string" && MASK_RE.test(value);
}

function maskKey(key: string): string {
  if (key.length <= 8) return "****";
  return key.slice(0, 4) + "****" + key.slice(-4);
}
