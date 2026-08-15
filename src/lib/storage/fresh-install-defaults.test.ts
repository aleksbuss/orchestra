/**
 * Tests for the credential-aware fresh-install model defaults (PM #101).
 *
 * The defect these guard: `DEFAULT_SETTINGS` ships `openai/gpt-4o`, so an
 * install whose only credential is an OpenRouter key is dead on arrival — the
 * key works, the catalogue loads, and every turn fails provider auth.
 *
 * Every case here passes an explicit `env` object. The production caller hands
 * in `process.env`, which on a developer machine carries whatever is in
 * `.env.local`; a test that read ambient env would pass or fail depending on
 * whose laptop it ran on, which is precisely the class of silently-degrading
 * instrument this repo keeps getting bitten by.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  STARTER_MODELS,
  STARTER_PROVIDER_PRIORITY,
  hasProviderCredential,
  resolveStarterProvider,
  applyCredentialAwareModelDefaults,
  __resetCredentialAwareDefaultsLogForTests,
} from "./fresh-install-defaults";
import { STAR_MODELS, LIGHT_MODELS } from "@/lib/providers/model-config";
import type { AppSettings, ModelConfig } from "@/lib/types";

/** The shipped slots, mirrored from DEFAULT_SETTINGS. */
const SHIPPED_CHAT: ModelConfig = {
  provider: "openai",
  model: "gpt-4o",
  authMethod: "api_key",
  temperature: 0.7,
  maxTokens: 4096,
};
const SHIPPED_UTILITY: ModelConfig = {
  provider: "openai",
  model: "gpt-4o-mini",
  temperature: 0.3,
  maxTokens: 2048,
};

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    chatModel: { ...SHIPPED_CHAT },
    utilityModel: { ...SHIPPED_UTILITY },
    ...overrides,
  } as AppSettings;
}

const SHIPPED_DEFAULTS = makeSettings();

beforeEach(() => {
  __resetCredentialAwareDefaultsLogForTests();
});

describe("STARTER_MODELS — coupled to the shipped catalogue", () => {
  // Without this the table can drift into recommending a model id the provider
  // no longer serves, and the victim is a first-time user who has no way to
  // tell a bad default from a broken app.
  it("every starter chat model is a model the wizard also offers (STAR_MODELS)", () => {
    for (const [provider, starter] of Object.entries(STARTER_MODELS)) {
      expect(
        STAR_MODELS[provider],
        `no STAR_MODELS entry for provider ${provider}`
      ).toBeDefined();
      expect(
        STAR_MODELS[provider],
        `starter chat model for ${provider} is not in STAR_MODELS`
      ).toContain(starter!.chat);
    }
  });

  it("every starter utility model is a model the wizard also offers (LIGHT_MODELS)", () => {
    for (const [provider, starter] of Object.entries(STARTER_MODELS)) {
      expect(
        LIGHT_MODELS[provider],
        `no LIGHT_MODELS entry for provider ${provider}`
      ).toBeDefined();
      expect(
        LIGHT_MODELS[provider],
        `starter utility model for ${provider} is not in LIGHT_MODELS`
      ).toContain(starter!.utility);
    }
  });

  it("only key-requiring remote providers are eligible — never a local server", () => {
    // ollama/sglang/vllm are `requiresApiKey: false`, so "is credentialed" is
    // vacuously true for them; adopting one would point a fresh install at a
    // server that probably is not running.
    for (const provider of STARTER_PROVIDER_PRIORITY) {
      expect(["openrouter", "anthropic", "google"]).toContain(provider);
    }
  });
});

describe("hasProviderCredential", () => {
  it("finds a key in the vault", () => {
    expect(
      hasProviderCredential("openrouter", { providerApiKeys: { openrouter: "sk-or-x" } }, {})
    ).toBe(true);
  });

  it("finds a key in the provider's documented env var", () => {
    expect(
      hasProviderCredential("openrouter", {}, { OPENROUTER_API_KEY: "sk-or-x" })
    ).toBe(true);
  });

  it("an empty string is NOT a credential", () => {
    expect(
      hasProviderCredential("openrouter", { providerApiKeys: { openrouter: "" } }, {
        OPENROUTER_API_KEY: "",
      })
    ).toBe(false);
  });

  it("a key for a DIFFERENT provider does not count", () => {
    expect(
      hasProviderCredential("openai", { providerApiKeys: { openrouter: "sk-or-x" } }, {})
    ).toBe(false);
  });
});

describe("resolveStarterProvider", () => {
  it("returns null when OpenAI is credentialed — the shipped defaults already work", () => {
    expect(
      resolveStarterProvider({ providerApiKeys: { openai: "sk-x", openrouter: "sk-or-x" } }, {})
    ).toBeNull();
    expect(
      resolveStarterProvider({ providerApiKeys: { openrouter: "sk-or-x" } }, {
        OPENAI_API_KEY: "sk-x",
      })
    ).toBeNull();
  });

  it("returns null when nothing is credentialed", () => {
    expect(resolveStarterProvider({}, {})).toBeNull();
  });

  it("prefers OpenRouter when several providers are credentialed", () => {
    expect(
      resolveStarterProvider(
        { providerApiKeys: { anthropic: "sk-ant", google: "g", openrouter: "sk-or" } },
        {}
      )
    ).toBe("openrouter");
  });

  it("falls through the priority list when OpenRouter is absent", () => {
    expect(
      resolveStarterProvider({ providerApiKeys: { google: "g", anthropic: "sk-ant" } }, {})
    ).toBe("anthropic");
    expect(resolveStarterProvider({ providerApiKeys: { google: "g" } }, {})).toBe("google");
  });
});

describe("applyCredentialAwareModelDefaults", () => {
  it("THE DEFECT: an OpenRouter-only install gets OpenRouter model slots", () => {
    const settings = makeSettings({ providerApiKeys: { openrouter: "sk-or-x" } });
    const out = applyCredentialAwareModelDefaults(settings, SHIPPED_DEFAULTS, {});

    expect(out.chatModel.provider).toBe("openrouter");
    expect(out.chatModel.model).toBe(STARTER_MODELS.openrouter!.chat);
    expect(out.utilityModel.provider).toBe("openrouter");
    expect(out.utilityModel.model).toBe(STARTER_MODELS.openrouter!.utility);
  });

  it("works when the key exists only in .env.local (never pasted into the vault)", () => {
    const out = applyCredentialAwareModelDefaults(makeSettings(), SHIPPED_DEFAULTS, {
      OPENROUTER_API_KEY: "sk-or-x",
    });
    expect(out.chatModel.provider).toBe("openrouter");
  });

  it("preserves the non-model fields of the slot it retargets", () => {
    const out = applyCredentialAwareModelDefaults(
      makeSettings({ providerApiKeys: { anthropic: "sk-ant" } }),
      SHIPPED_DEFAULTS,
      {}
    );
    expect(out.chatModel.temperature).toBe(SHIPPED_CHAT.temperature);
    expect(out.chatModel.maxTokens).toBe(SHIPPED_CHAT.maxTokens);
    expect(out.utilityModel.temperature).toBe(SHIPPED_UTILITY.temperature);
  });

  it("does NOTHING when OpenAI is credentialed", () => {
    const settings = makeSettings({
      providerApiKeys: { openai: "sk-x", openrouter: "sk-or-x" },
    });
    expect(applyCredentialAwareModelDefaults(settings, SHIPPED_DEFAULTS, {})).toBe(settings);
  });

  it("does NOTHING when no provider is credentialed", () => {
    const settings = makeSettings();
    expect(applyCredentialAwareModelDefaults(settings, SHIPPED_DEFAULTS, {})).toBe(settings);
  });

  it("NEVER overrides an explicit chat-model choice, even a deliberate OpenAI one", () => {
    // Someone who picked gpt-5.4 on purpose keeps it — their key may live
    // somewhere this module cannot see, and second-guessing them is worse than
    // an honest provider error.
    const settings = makeSettings({
      chatModel: { ...SHIPPED_CHAT, model: "gpt-5.4" },
      providerApiKeys: { openrouter: "sk-or-x" },
    });
    const out = applyCredentialAwareModelDefaults(settings, SHIPPED_DEFAULTS, {});
    expect(out).toBe(settings);
    expect(out.chatModel.model).toBe("gpt-5.4");
    // …and the utility slot is left alone too, rather than splitting the setup
    // across two providers behind the user's back.
    expect(out.utilityModel.provider).toBe("openai");
  });

  it("treats a slot carrying an inline apiKey as an explicit choice", () => {
    const settings = makeSettings({
      chatModel: { ...SHIPPED_CHAT, apiKey: "sk-inline" },
      providerApiKeys: { openrouter: "sk-or-x" },
    });
    expect(applyCredentialAwareModelDefaults(settings, SHIPPED_DEFAULTS, {})).toBe(settings);
  });

  it("retargets chat but leaves an explicitly chosen utility model alone", () => {
    const settings = makeSettings({
      utilityModel: { ...SHIPPED_UTILITY, model: "gpt-4.1-nano" },
      providerApiKeys: { openrouter: "sk-or-x" },
    });
    const out = applyCredentialAwareModelDefaults(settings, SHIPPED_DEFAULTS, {});
    expect(out.chatModel.provider).toBe("openrouter");
    expect(out.utilityModel.model).toBe("gpt-4.1-nano");
    expect(out.utilityModel.provider).toBe("openai");
  });

  it("is idempotent — a second pass over its own output changes nothing", () => {
    const once = applyCredentialAwareModelDefaults(
      makeSettings({ providerApiKeys: { openrouter: "sk-or-x" } }),
      SHIPPED_DEFAULTS,
      {}
    );
    const twice = applyCredentialAwareModelDefaults(once, SHIPPED_DEFAULTS, {});
    expect(twice).toBe(once);
  });

  it("does not mutate the settings object it was handed", () => {
    const settings = makeSettings({ providerApiKeys: { openrouter: "sk-or-x" } });
    applyCredentialAwareModelDefaults(settings, SHIPPED_DEFAULTS, {});
    expect(settings.chatModel.provider).toBe("openai");
    expect(settings.chatModel.model).toBe("gpt-4o");
  });

  it("leaves embeddings pointed at OpenAI — OpenRouter has no embeddings API", () => {
    const settings = makeSettings({
      embeddingsModel: { provider: "openai", model: "text-embedding-3-small", dimensions: 1536 },
      providerApiKeys: { openrouter: "sk-or-x" },
    });
    const out = applyCredentialAwareModelDefaults(settings, SHIPPED_DEFAULTS, {});
    expect(out.embeddingsModel.provider).toBe("openai");
  });

  describe("the one-shot log", () => {
    let infoSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    });
    afterEach(() => {
      infoSpy.mockRestore();
    });

    it("says which provider was adopted, once per process", () => {
      const settings = makeSettings({ providerApiKeys: { openrouter: "sk-or-x" } });
      applyCredentialAwareModelDefaults(settings, SHIPPED_DEFAULTS, {});
      applyCredentialAwareModelDefaults(settings, SHIPPED_DEFAULTS, {});

      expect(infoSpy).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(infoSpy.mock.calls[0][0] as string);
      expect(payload.event).toBe("settings.credential_aware_defaults");
      expect(payload.provider).toBe("openrouter");
    });

    it("stays silent when it does nothing", () => {
      applyCredentialAwareModelDefaults(makeSettings(), SHIPPED_DEFAULTS, {});
      expect(infoSpy).not.toHaveBeenCalled();
    });
  });
});
