/**
 * Tests for GET /api/diagnostics — full system probe.
 *
 * The endpoint hits 5 LLM-provider APIs in parallel (Google, OpenRouter,
 * OpenAI, Anthropic, Ollama) using each provider's resolved API key, and
 * surfaces per-provider status + actionable recommendations.
 *
 * Pinned invariants:
 *   - Key resolution precedence: vault > chatModel.apiKey (when same
 *     provider) > env var. (Mirrors `runAgent`'s key resolution; if these
 *     drift, diagnostics will lie about which key is actually being used.)
 *   - Provider key NEVER appears verbatim in the response — only the
 *     `XXXXXX...YYYY` masked prefix.
 *   - `apiTestResult: "skipped"` (NOT "error") when no key is present —
 *     "skipped" maps to a yellow indicator in the UI, "error" is red.
 *   - Ollama is the special case: `keyPresent: true` always, `keyPrefix:
 *     "(local)"`, but the test result reflects whether the daemon is up.
 *   - The recommendation list is ordered: critical-red first, then yellow.
 *   - When everything is OK, recommendations contains the "✅ All systems
 *     nominal" message — important for the UI's "all clear" state.
 *   - envVars is a presence-only map (booleans). Values themselves never
 *     appear in the response.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/storage/settings-store", () => ({
  getSettings: vi.fn(),
}));

vi.mock("@/lib/agent/presets", async () => {
  const actual = await vi.importActual<typeof import("@/lib/agent/presets")>(
    "@/lib/agent/presets"
  );
  return { ...actual };
});

import { GET } from "./route";
import { getSettings } from "@/lib/storage/settings-store";

const mockedSettings = vi.mocked(getSettings);

let fetchSpy: any;

function fakeSettings(override: any = {}) {
  return {
    chatModel: {
      provider: "openrouter",
      model: "claude-3-5-haiku",
      apiKey: "",
      authMethod: "api_key",
    },
    utilityModel: { provider: "openai", model: "gpt-4o-mini" },
    embeddingsModel: { provider: "openai", model: "text-embedding-3-small" },
    codeExecution: { enabled: true, timeout: 600, maxOutputLength: 120000 },
    memory: { enabled: true, similarityThreshold: 0.4, maxResults: 10, chunkSize: 400 },
    search: { enabled: true, provider: "tavily" },
    general: { darkMode: false, language: "en" },
    auth: {
      enabled: true,
      username: "admin",
      passwordHash: "scrypt$x$y",
      mustChangeCredentials: false,
    },
    providerApiKeys: {},
    ...override,
  };
}

function fakeFetchOk(body: unknown = { models: [] }) {
  return new Response(JSON.stringify(body), { status: 200 });
}

function fakeFetchFail(status: number, body = "{}") {
  return new Response(body, { status });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  // Clear all env vars that diagnostics looks at, by default.
  for (const v of ["GOOGLE_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY"]) {
    vi.stubEnv(v, "");
  }
  // Restore any previous spy first so we don't accumulate call-stacked
  // implementations across tests. `vi.clearAllMocks()` clears call history
  // but NOT implementations; without restore + re-spy, a `mockImplementation`
  // from one test bleeds into the next as a stacked mock.
  fetchSpy?.mockRestore();
  // CRITICAL: use mockImplementation, NOT mockResolvedValue. Diagnostics
  // calls 5 providers in parallel, and each calls `res.json()` to consume
  // the body. A SHARED Response object's body stream can only be read
  // once — the first parallel call wins, the other four throw with
  // "body already consumed" → bogus "provider offline" results.
  // mockImplementation gives each call a fresh Response with its own
  // body stream.
  fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async () => fakeFetchOk());
  mockedSettings.mockResolvedValue(fakeSettings() as any);
});

afterEach(() => {
  fetchSpy?.mockRestore();
});

async function callDiagnostics() {
  const res = await GET({} as any);
  return (await res.json()) as {
    providers: Array<{
      provider: string;
      keySource: string;
      keyPresent: boolean;
      keyPrefix: string;
      apiTestResult: string;
      apiTestMessage: string;
      latencyMs: number | null;
    }>;
    envVars: Record<string, boolean>;
    recommendations: string[];
    timestamp: string;
  };
}

describe("GET /api/diagnostics — shape", () => {
  it("returns providers, envVars, recommendations, timestamp", async () => {
    const body = await callDiagnostics();
    expect(Array.isArray(body.providers)).toBe(true);
    expect(typeof body.envVars).toBe("object");
    expect(Array.isArray(body.recommendations)).toBe(true);
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
  });

  it("probes 5 providers: google, openrouter, openai, anthropic, ollama", async () => {
    const body = await callDiagnostics();
    expect(body.providers.map((p) => p.provider).sort()).toEqual([
      "anthropic",
      "google",
      "ollama",
      "openai",
      "openrouter",
    ]);
  });
});

describe("GET /api/diagnostics — key resolution precedence", () => {
  it("vault > chatModel > env (vault wins when set)", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "env-key-aaaaaaaaaaaa");
    mockedSettings.mockResolvedValue(
      fakeSettings({
        chatModel: {
          provider: "openrouter",
          model: "x",
          apiKey: "chatmodel-key-bbbbbb",
        },
        providerApiKeys: { openrouter: "vault-key-cccccccccccc" },
      }) as any
    );
    const body = await callDiagnostics();
    const openrouter = body.providers.find((p) => p.provider === "openrouter")!;
    expect(openrouter.keySource).toBe("vault");
    // The mask prefix is the FIRST 6 chars + "..." + last 4. Verify it's
    // derived from the vault key, not from env or chatModel.
    expect(openrouter.keyPrefix).toMatch(/^vault-/);
  });

  it("chatModel.apiKey wins over env when same provider", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "env-aaaaaaaaaaaaaaa");
    mockedSettings.mockResolvedValue(
      fakeSettings({
        chatModel: {
          provider: "openrouter",
          model: "x",
          apiKey: "chatmodel-bbbbbbbbbbbbb",
        },
      }) as any
    );
    const body = await callDiagnostics();
    const openrouter = body.providers.find((p) => p.provider === "openrouter")!;
    expect(openrouter.keySource).toBe("chatModel");
  });

  it("env wins when nothing else is set", async () => {
    vi.stubEnv("OPENAI_API_KEY", "env-openai-key-aaaaaa");
    const body = await callDiagnostics();
    const openai = body.providers.find((p) => p.provider === "openai")!;
    expect(openai.keySource).toBe("env");
    expect(openai.keyPresent).toBe(true);
  });

  it('keySource: "none" + apiTestResult: "skipped" when nothing configured', async () => {
    const body = await callDiagnostics();
    const openai = body.providers.find((p) => p.provider === "openai")!;
    expect(openai.keySource).toBe("none");
    expect(openai.keyPresent).toBe(false);
    expect(openai.apiTestResult).toBe("skipped");
    expect(openai.apiTestMessage).toMatch(/No API key configured/i);
    // 'skipped' (NOT 'error') is the yellow-not-red signal.
    expect(openai.latencyMs).toBeNull();
  });
});

describe("GET /api/diagnostics — key masking (no leaks)", () => {
  it("masks long keys to FIRST 6 + '...' + LAST 4 (the documented format)", async () => {
    vi.stubEnv(
      "OPENAI_API_KEY",
      "sk-real-VERY-LONG-secret-XYZ"
    );
    const body = await callDiagnostics();
    const openai = body.providers.find((p) => p.provider === "openai")!;
    expect(openai.keyPrefix).toBe("sk-rea..."+"l-XYZ".slice(-4)); // sk-rea...-XYZ
  });

  it("uses **** for keys ≤ 8 chars", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "shortk");
    const body = await callDiagnostics();
    const ant = body.providers.find((p) => p.provider === "anthropic")!;
    expect(ant.keyPrefix).toBe("****");
  });

  it("the FULL response body never contains a real key value", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-LEAK-DETECT-aaaaaaaaaaaa");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-LEAK-bbbbbbbbbbbbb");
    mockedSettings.mockResolvedValue(
      fakeSettings({
        providerApiKeys: { google: "AIza-LEAK-cccccccccccccccccccccc" },
      }) as any
    );
    const res = await GET({} as any);
    const text = await res.text();
    expect(text).not.toContain("sk-LEAK-DETECT");
    expect(text).not.toContain("sk-ant-LEAK");
    expect(text).not.toContain("AIza-LEAK");
  });
});

describe("GET /api/diagnostics — Ollama special-case", () => {
  it("keyPresent=true + keyPrefix=(local) regardless of env", async () => {
    fetchSpy.mockImplementation((url: string) => {
      if (String(url).includes("/api/tags")) {
        return Promise.resolve(fakeFetchOk({ models: [{ name: "llama3" }, { name: "qwen3" }] }));
      }
      return Promise.resolve(fakeFetchOk());
    });
    const body = await callDiagnostics();
    const ollama = body.providers.find((p) => p.provider === "ollama")!;
    expect(ollama.keyPresent).toBe(true);
    expect(ollama.keyPrefix).toBe("(local)");
  });

  it("ok with model count when /api/tags returns 200", async () => {
    fetchSpy.mockImplementation((url: string) => {
      if (String(url).includes("/api/tags")) {
        return Promise.resolve(fakeFetchOk({ models: [{}, {}, {}] }));
      }
      return Promise.resolve(fakeFetchOk());
    });
    const body = await callDiagnostics();
    const ollama = body.providers.find((p) => p.provider === "ollama")!;
    expect(ollama.apiTestResult).toBe("ok");
    expect(ollama.apiTestMessage).toMatch(/3 local models/);
  });

  it("error when Ollama is offline (fetch throws)", async () => {
    fetchSpy.mockImplementation((url: string) => {
      if (String(url).includes("/api/tags")) {
        return Promise.reject(new Error("ECONNREFUSED"));
      }
      return Promise.resolve(fakeFetchOk());
    });
    const body = await callDiagnostics();
    const ollama = body.providers.find((p) => p.provider === "ollama")!;
    expect(ollama.apiTestResult).toBe("error");
    expect(ollama.apiTestMessage).toMatch(/offline/i);
  });
});

describe("GET /api/diagnostics — envVars (presence-only)", () => {
  it("flags exactly the env vars that ARE set; no values leak", async () => {
    vi.stubEnv("OPENAI_API_KEY", "x-secret-y");
    vi.stubEnv("GOOGLE_API_KEY", "y-secret-z");
    const body = await callDiagnostics();
    expect(body.envVars).toEqual({
      OPENAI_API_KEY: true,
      GOOGLE_API_KEY: true,
      OPENROUTER_API_KEY: false,
      ANTHROPIC_API_KEY: false,
    });
    // Sanity: values themselves don't appear.
    const text = JSON.stringify(body);
    expect(text).not.toContain("x-secret-y");
    expect(text).not.toContain("y-secret-z");
  });
});

describe("GET /api/diagnostics — provider API tests (per-vendor wire)", () => {
  it("Google: GET to generativelanguage.googleapis.com/v1beta/models", async () => {
    vi.stubEnv("GOOGLE_API_KEY", "AIzaTest-aaaaaaaaaaaaaaaaaa");
    fetchSpy.mockImplementation((url: string) => {
      if (String(url).includes("generativelanguage.googleapis.com")) {
        return Promise.resolve(fakeFetchOk({ models: [] }));
      }
      return Promise.resolve(fakeFetchOk());
    });
    await callDiagnostics();
    const calls = fetchSpy.mock.calls.map((c: any[]) => String(c[0]));
    expect(calls.some((u: string) => u.includes("generativelanguage.googleapis.com/v1beta/models"))).toBe(true);
  });

  it("Anthropic: POST to api.anthropic.com (the only POST in the diagnostic set)", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test-aaaaaaaaaaa");
    fetchSpy.mockImplementation((url: string) => {
      if (String(url).includes("api.anthropic.com")) {
        return Promise.resolve(fakeFetchOk());
      }
      return Promise.resolve(fakeFetchOk());
    });
    await callDiagnostics();
    const anthCall = fetchSpy.mock.calls.find((c: any[]) =>
      String(c[0]).includes("api.anthropic.com")
    );
    expect(anthCall).toBeDefined();
    expect(anthCall![1].method).toBe("POST");
  });

  it("OpenRouter / OpenAI use GET on /models", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-openai-test-aaaaaaa");
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test-aaaaaaaaaa");
    await callDiagnostics();
    const calls = fetchSpy.mock.calls.map((c: any[]) => ({
      url: String(c[0]),
      method: c[1]?.method,
    }));
    const orCall = calls.find((c: { url: string }) =>
      c.url.includes("openrouter.ai/api/v1/models")
    );
    const oaiCall = calls.find((c: { url: string }) =>
      c.url.includes("api.openai.com/v1/models")
    );
    expect(orCall?.method).toBe("GET");
    expect(oaiCall?.method).toBe("GET");
  });
});

describe("GET /api/diagnostics — recommendations", () => {
  it("'no Google key' is rendered as 🔴 CRITICAL (Google is required for the presets)", async () => {
    const body = await callDiagnostics();
    const rec = body.recommendations.join("\n");
    expect(rec).toMatch(/🔴.*CRITICAL.*Google/i);
  });

  it("'Google key fails' is 🟡 yellow (less severe than missing)", async () => {
    vi.stubEnv("GOOGLE_API_KEY", "AIza-bad-key-aaaaaaaaaaaaaa");
    fetchSpy.mockImplementation((url: string) => {
      if (String(url).includes("generativelanguage.googleapis.com")) {
        return Promise.resolve(fakeFetchFail(403, '{"error":{"message":"key disabled"}}'));
      }
      return Promise.resolve(fakeFetchOk());
    });
    const body = await callDiagnostics();
    const rec = body.recommendations.join("\n");
    expect(rec).toMatch(/🟡/);
  });

  it("'Ollama offline' is 🟡 yellow (workers depend on it but it's recoverable)", async () => {
    vi.stubEnv("GOOGLE_API_KEY", "AIza-good-aaaaaaaaaaaaaaaaaa");
    fetchSpy.mockImplementation((url: string) => {
      if (String(url).includes("/api/tags")) {
        return Promise.reject(new Error("ECONNREFUSED"));
      }
      return Promise.resolve(fakeFetchOk());
    });
    const body = await callDiagnostics();
    const rec = body.recommendations.join("\n");
    expect(rec).toMatch(/🟡.*Ollama is offline/i);
  });

  it("✅ all-clear when everything passes", async () => {
    vi.stubEnv("GOOGLE_API_KEY", "AIza-good-aaaaaaaaaaaaaaaaaa");
    // mockImplementation (NOT mockResolvedValue): each parallel provider
    // call gets a fresh Response with an unconsumed body stream.
    fetchSpy.mockImplementation(async () => fakeFetchOk({ models: [{}] }));
    const body = await callDiagnostics();
    const rec = body.recommendations.join("\n");
    expect(rec).toMatch(/✅.*All systems nominal/i);
  });
});
