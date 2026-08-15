/**
 * Credential-aware model defaults for a fresh install (PM #101).
 *
 * `DEFAULT_SETTINGS` ships `openai/gpt-4o` + `gpt-4o-mini`. That is a fine
 * default for someone holding an OpenAI key and a dead end for everyone else:
 * a user who installs Orchestra and supplies only an OpenRouter key — the
 * documented BYOK path in the README — gets a working key, a working catalogue
 * fetch, and a chat that cannot answer, because every model slot still points
 * at a provider they have no credential for. The failure surfaces as a provider
 * auth error deep in a turn, which reads as "the app is broken", not as
 * "change two dropdowns in Settings".
 *
 * This module closes that gap WITHOUT guessing on the user's behalf once they
 * have made a choice. The overlay fires only when a slot is still byte-identical
 * to the shipped default (same provider, same model id, no inline key), so it
 * can never override an explicit selection — including a deliberate
 * `openai/gpt-4o` chosen by someone whose key lives somewhere this code cannot
 * see. If OpenAI has a credential anywhere (vault or env), nothing happens at all.
 *
 * Deliberately NOT retargeted:
 *   - `embeddingsModel`. Of the providers considered here only OpenAI and Ollama
 *     expose an embeddings API (`MODEL_PROVIDERS[p].embeddingModels`); OpenRouter
 *     has none. Pointing embeddings at a provider that cannot serve them would
 *     trade a clear failure for a confusing one. A fresh install's memory DB is
 *     empty, and `searchMemory` short-circuits on an empty DB before it embeds,
 *     so recall degrades rather than breaking the first turns.
 *   - `ollama` / `sglang` / `vllm`. They are `requiresApiKey: false`, so
 *     "has a credential" is meaningless for them — every install would look
 *     credentialed and get silently pointed at a local server that may not be
 *     running.
 */
import { MODEL_PROVIDERS } from "@/lib/providers/model-config";
import type { AppSettings, ModelConfig } from "@/lib/types";

type Provider = ModelConfig["provider"];

/**
 * The chat + utility pair to adopt for a provider the user actually holds a key
 * for. Every id here is also present in `STAR_MODELS` / `LIGHT_MODELS`
 * (`model-config.ts`) — the catalogue the wizard shows — and
 * `fresh-install-defaults.test.ts` asserts that, so renaming a catalogue entry
 * without updating this table fails the build instead of shipping a 404 model id
 * as somebody's first experience of Orchestra.
 */
export const STARTER_MODELS: Partial<
  Record<Provider, { chat: string; utility: string }>
> = {
  openrouter: { chat: "anthropic/claude-4.6-sonnet", utility: "openai/gpt-4o-mini" },
  anthropic: { chat: "claude-4.6-sonnet-20260217", utility: "claude-3-5-haiku-20241022" },
  google: { chat: "gemini-3.1-pro-preview", utility: "gemini-2.5-flash" },
};

/**
 * Order in which a credentialed provider is adopted when the user holds several.
 * OpenRouter first because it is the broadest catalogue (and the only one of the
 * three that can reach the other two's models), then the direct APIs.
 */
export const STARTER_PROVIDER_PRIORITY: readonly Provider[] = [
  "openrouter",
  "anthropic",
  "google",
];

export type EnvLike = Record<string, string | undefined>;

/**
 * Does a usable key exist for this provider? Mirrors what `createModel`
 * can actually see at call time (PM #99): the API Keys Vault first, then the
 * provider's documented env var. An empty string is not a credential.
 */
export function hasProviderCredential(
  provider: Provider,
  settings: Pick<AppSettings, "providerApiKeys">,
  env: EnvLike
): boolean {
  if (settings.providerApiKeys?.[provider]) return true;
  const envKey = MODEL_PROVIDERS[provider]?.envKey;
  return Boolean(envKey && env[envKey]);
}

/**
 * The provider to adopt, or `null` to leave the shipped defaults alone.
 * `null` when OpenAI is credentialed (the defaults already work) and when no
 * provider in the priority list is credentialed (nothing better to offer).
 */
export function resolveStarterProvider(
  settings: Pick<AppSettings, "providerApiKeys">,
  env: EnvLike
): Provider | null {
  if (hasProviderCredential("openai", settings, env)) return null;
  for (const provider of STARTER_PROVIDER_PRIORITY) {
    if (!STARTER_MODELS[provider]) continue;
    if (hasProviderCredential(provider, settings, env)) return provider;
  }
  return null;
}

/** A slot the user has demonstrably never touched: shipped provider, shipped model, no inline key. */
function isUntouched(slot: ModelConfig, shipped: ModelConfig): boolean {
  return (
    slot.provider === shipped.provider &&
    slot.model === shipped.model &&
    !slot.apiKey
  );
}

let alreadyLogged = false;

/**
 * Point untouched model slots at a provider the user actually holds a key for.
 * Pure apart from a one-shot log line; returns `settings` unchanged (same
 * reference) when nothing applies, so callers can cheaply detect a no-op.
 *
 * NOTE ON PERSISTENCE: this runs inside `getSettings()`, which is also what
 * `saveSettings()` reads before merging a patch — so the first settings write of
 * any kind bakes the overlay onto disk. That is intended: at that point it stops
 * being a derived default and becomes the user's stored configuration, and the
 * `isUntouched` guard then correctly declines to touch it ever again.
 */
export function applyCredentialAwareModelDefaults(
  settings: AppSettings,
  shippedDefaults: AppSettings,
  env: EnvLike
): AppSettings {
  // The CHAT slot is the signal. If the user has picked a chat model, this
  // module stays out of the way entirely — retargeting the utility slot alone
  // would silently split their setup across two providers, which is stranger
  // than leaving a deliberate configuration alone.
  if (!isUntouched(settings.chatModel, shippedDefaults.chatModel)) return settings;
  const utilityUntouched = isUntouched(
    settings.utilityModel,
    shippedDefaults.utilityModel
  );

  const provider = resolveStarterProvider(settings, env);
  if (!provider) return settings;

  const starter = STARTER_MODELS[provider];
  if (!starter) return settings;

  const authMethod = MODEL_PROVIDERS[provider]?.defaultAuthMethod ?? "api_key";
  const next: AppSettings = { ...settings };

  next.chatModel = {
    ...settings.chatModel,
    provider,
    model: starter.chat,
    authMethod,
  };
  if (utilityUntouched) {
    next.utilityModel = {
      ...settings.utilityModel,
      provider,
      model: starter.utility,
    };
  }

  if (!alreadyLogged) {
    alreadyLogged = true;
    console.info(
      JSON.stringify({
        event: "settings.credential_aware_defaults",
        provider,
        chatModel: next.chatModel.model,
        utilityModel: next.utilityModel.model,
        reason:
          "no OpenAI credential found; model slots were still at shipped defaults",
      })
    );
  }

  return next;
}

/** Test seam — the one-shot log is per-process, which a test asserting on it must reset. */
export function __resetCredentialAwareDefaultsLogForTests(): void {
  alreadyLogged = false;
}
