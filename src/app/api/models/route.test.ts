/**
 * Tests for GET /api/models — the provider-aware model directory.
 *
 * For each provider the route hits a different upstream endpoint with a
 * different shape and filtering rule. The key invariants tested here are:
 *
 *   - Per-provider URL: openai/openrouter/anthropic/google/ollama each
 *     get the documented path. (regression risk: a path change makes
 *     the wizard's model picker silently empty)
 *   - Per-provider auth: Bearer for openai/openrouter, x-api-key +
 *     anthropic-version for anthropic, ?key= for google.
 *   - Per-provider filter: openai keeps only gpt- / o1 / o3 / o4 for
 *     chat, text-embedding- for embeddings. Google keeps only gemini- for
 *     chat, embedding for embeddings. Anthropic embeddings = [].
 *   - API-key resolution waterfall: query-string → providerApiKeys vault
 *     → chatModel/utilityModel/embeddingsModel → process.env (envKey
 *     from MODEL_PROVIDERS). Masked key ("****") triggers the waterfall.
 *   - Ollama: SSRF guard (PM #8). Loopback default is allowed; private
 *     ranges are rejected with 400. /v1 suffix is stripped; trailing
 *     slashes are stripped. Timeout is set via AbortSignal.
 *   - codex-cli / gemini-cli: type=embedding → []; otherwise resolved
 *     via getCliProviderModels with the MODEL_PROVIDERS fallback list.
 *   - Unknown provider: falls back to MODEL_PROVIDERS[provider]?.models
 *     or empty array.
 *   - Upstream non-OK / fetch throw → 500 with `error` + `models: []`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/storage/settings-store", () => ({
  getSettings: vi.fn(),
}));

vi.mock("@/lib/providers/cli-models", () => ({
  getCliProviderModels: vi.fn(),
}));

import { GET } from "./route";
import { getSettings } from "@/lib/storage/settings-store";
import { getCliProviderModels } from "@/lib/providers/cli-models";

const mockedSettings = vi.mocked(getSettings);
const mockedCli = vi.mocked(getCliProviderModels);

let fetchSpy: any;
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ data: [] }), { status: 200 })
  );
  // Default: no settings, no env keys — each test that needs them sets explicitly.
  mockedSettings.mockResolvedValue({
    providerApiKeys: {},
    chatModel: { provider: "openai", model: "gpt-4o", apiKey: "" },
    utilityModel: { provider: "openai", model: "gpt-4o-mini", apiKey: "" },
    embeddingsModel: { provider: "openai", model: "text-embedding-3-small", apiKey: "" },
  } as any);
  process.env = { ...ORIGINAL_ENV };
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
});

afterEach(() => {
  fetchSpy?.mockRestore();
  process.env = { ...ORIGINAL_ENV };
});

function buildReq(query: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/models${query}`);
}

function fakeResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status });
}

describe("GET /api/models — OpenAI", () => {
  it("filters to gpt-*/o1/o3/o4 for chat type and sorts by id", async () => {
    fetchSpy.mockResolvedValue(
      fakeResponse({
        data: [
          { id: "gpt-4o" },
          { id: "o1-preview" },
          { id: "text-embedding-3-small" },
          { id: "dall-e-3" },
          { id: "o3-mini" },
        ],
      })
    );
    const res = await GET(buildReq("?provider=openai&apiKey=sk-test"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.models.map((m: any) => m.id)).toEqual([
      "gpt-4o",
      "o1-preview",
      "o3-mini",
    ]);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe("https://api.openai.com/v1/models");
    expect((init as any).headers.Authorization).toBe("Bearer sk-test");
  });

  it("filters to embeddings when type=embedding", async () => {
    fetchSpy.mockResolvedValue(
      fakeResponse({
        data: [
          { id: "gpt-4o" },
          { id: "text-embedding-3-small" },
          { id: "text-embedding-ada-002" },
        ],
      })
    );
    const res = await GET(
      buildReq("?provider=openai&apiKey=sk-test&type=embedding")
    );
    const body = await res.json();
    expect(body.models.map((m: any) => m.id)).toEqual([
      "text-embedding-3-small",
      "text-embedding-ada-002",
    ]);
  });

  it("propagates upstream non-OK as 500 + empty models", async () => {
    fetchSpy.mockResolvedValue(new Response("nope", { status: 401 }));
    const res = await GET(buildReq("?provider=openai&apiKey=bad"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.models).toEqual([]);
    expect(body.error).toMatch(/OpenAI API error: 401/);
  });
});

describe("GET /api/models — OpenRouter", () => {
  it("hits /api/v1/models for chat and sorts by name", async () => {
    fetchSpy.mockResolvedValue(
      fakeResponse({
        data: [
          { id: "anthropic/claude-3-5-haiku", name: "Claude 3.5 Haiku" },
          { id: "openai/gpt-4o", name: "GPT-4o" },
        ],
      })
    );
    const res = await GET(
      buildReq("?provider=openrouter&apiKey=sk-or-test")
    );
    const body = await res.json();
    expect(body.models[0].name).toBe("Claude 3.5 Haiku");
    expect(body.models[1].name).toBe("GPT-4o");
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe("https://openrouter.ai/api/v1/models");
    expect((init as any).headers.Authorization).toBe("Bearer sk-or-test");
  });

  it("hits the /embeddings/models endpoint for embeddings", async () => {
    fetchSpy.mockResolvedValue(fakeResponse({ data: [] }));
    await GET(
      buildReq("?provider=openrouter&apiKey=sk-or-test&type=embedding")
    );
    const [url] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe(
      "https://openrouter.ai/api/v1/embeddings/models"
    );
  });

  it("falls back to id when name is missing", async () => {
    fetchSpy.mockResolvedValue(
      fakeResponse({ data: [{ id: "x/y" }] })
    );
    const res = await GET(buildReq("?provider=openrouter&apiKey=k"));
    const body = await res.json();
    expect(body.models[0]).toEqual({ id: "x/y", name: "x/y" });
  });

  it("accepts an array payload (some embedding endpoints return [] directly)", async () => {
    fetchSpy.mockResolvedValue(
      fakeResponse([{ id: "emb-1", name: "Emb 1" }])
    );
    const res = await GET(
      buildReq("?provider=openrouter&apiKey=k&type=embedding")
    );
    const body = await res.json();
    expect(body.models).toHaveLength(1);
    expect(body.models[0].id).toBe("emb-1");
  });
});

describe("GET /api/models — Anthropic", () => {
  it("uses x-api-key + anthropic-version and filters type='model'", async () => {
    fetchSpy.mockResolvedValue(
      fakeResponse({
        data: [
          { id: "claude-3-5-sonnet", type: "model", display_name: "Sonnet 3.5" },
          { id: "deprecated", type: "deprecated" },
          { id: "claude-3-5-haiku", type: "model" },
        ],
      })
    );
    const res = await GET(buildReq("?provider=anthropic&apiKey=sk-ant"));
    const body = await res.json();
    expect(body.models.map((m: any) => m.id).sort()).toEqual([
      "claude-3-5-haiku",
      "claude-3-5-sonnet",
    ]);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe(
      "https://api.anthropic.com/v1/models?limit=1000"
    );
    expect((init as any).headers["x-api-key"]).toBe("sk-ant");
    expect((init as any).headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("returns empty list for embeddings (Anthropic has no public embeddings)", async () => {
    const res = await GET(
      buildReq("?provider=anthropic&apiKey=sk-ant&type=embedding")
    );
    const body = await res.json();
    expect(body.models).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses display_name when present, else id", async () => {
    fetchSpy.mockResolvedValue(
      fakeResponse({
        data: [
          { id: "x", type: "model" },
          { id: "y", type: "model", display_name: "Why" },
        ],
      })
    );
    const res = await GET(buildReq("?provider=anthropic&apiKey=k"));
    const body = await res.json();
    const byId = Object.fromEntries(body.models.map((m: any) => [m.id, m.name]));
    expect(byId.x).toBe("x");
    expect(byId.y).toBe("Why");
  });
});

describe("GET /api/models — Google (Gemini)", () => {
  it("strips models/ prefix and filters chat models to 'gemini'", async () => {
    fetchSpy.mockResolvedValue(
      fakeResponse({
        models: [
          { name: "models/gemini-1.5-pro", displayName: "Gemini 1.5 Pro" },
          { name: "models/embedding-001", displayName: "Embedding" },
          { name: "models/text-bison-001" }, // not gemini-* → filtered out
        ],
      })
    );
    const res = await GET(buildReq("?provider=google&apiKey=goog-key"));
    const body = await res.json();
    expect(body.models.map((m: any) => m.id)).toEqual(["gemini-1.5-pro"]);
    const [url] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models?key=goog-key"
    );
  });

  it("filters to *embedding* when type=embedding", async () => {
    fetchSpy.mockResolvedValue(
      fakeResponse({
        models: [
          { name: "models/gemini-1.5-pro" },
          { name: "models/text-embedding-004" },
        ],
      })
    );
    const res = await GET(
      buildReq("?provider=google&apiKey=k&type=embedding")
    );
    const body = await res.json();
    expect(body.models.map((m: any) => m.id)).toEqual(["text-embedding-004"]);
  });
});

describe("GET /api/models — Ollama (loopback + SSRF guard)", () => {
  it("uses default localhost:11434/api/tags when baseUrl is omitted", async () => {
    fetchSpy.mockResolvedValue(
      fakeResponse({ models: [{ name: "llama3" }, { name: "mistral" }] })
    );
    const res = await GET(buildReq("?provider=ollama"));
    expect(res.status).toBe(200);
    const [url] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe("http://localhost:11434/api/tags");
    const body = await res.json();
    expect(body.models).toEqual([
      { id: "llama3", name: "llama3" },
      { id: "mistral", name: "mistral" },
    ]);
  });

  it("strips trailing slashes and /v1 from the supplied baseUrl", async () => {
    fetchSpy.mockResolvedValue(fakeResponse({ models: [] }));
    await GET(
      buildReq(
        "?provider=ollama&baseUrl=" +
          encodeURIComponent("http://localhost:11434/v1/")
      )
    );
    const [url] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe("http://localhost:11434/api/tags");
  });

  it("rejects an RFC1918 baseUrl (SSRF guard, PM #8)", async () => {
    const res = await GET(
      buildReq(
        "?provider=ollama&baseUrl=" +
          encodeURIComponent("http://10.0.0.5:11434")
      )
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Refused to fetch from baseUrl/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects cloud-metadata 169.254.169.254 (the canary case)", async () => {
    const res = await GET(
      buildReq(
        "?provider=ollama&baseUrl=" +
          encodeURIComponent("http://169.254.169.254:80")
      )
    );
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("passes an AbortSignal to the upstream fetch (timeout guard)", async () => {
    fetchSpy.mockResolvedValue(fakeResponse({ models: [] }));
    await GET(buildReq("?provider=ollama"));
    const [, init] = fetchSpy.mock.calls[0];
    expect((init as any).signal).toBeInstanceOf(AbortSignal);
  });
});

describe("GET /api/models — codex-cli / gemini-cli", () => {
  it("codex-cli embedding → empty + no upstream call", async () => {
    const res = await GET(buildReq("?provider=codex-cli&type=embedding"));
    expect(res.status).toBe(200);
    expect((await res.json()).models).toEqual([]);
    expect(mockedCli).not.toHaveBeenCalled();
  });

  it("codex-cli chat → resolved via getCliProviderModels", async () => {
    mockedCli.mockResolvedValue([{ id: "x", name: "X" }]);
    const res = await GET(buildReq("?provider=codex-cli"));
    const body = await res.json();
    expect(body.models).toEqual([{ id: "x", name: "X" }]);
    expect(mockedCli).toHaveBeenCalledWith("codex-cli", expect.any(Array));
  });

  it("codex-cli falls back to MODEL_PROVIDERS list if CLI lookup throws", async () => {
    mockedCli.mockRejectedValue(new Error("codex not installed"));
    const res = await GET(buildReq("?provider=codex-cli"));
    expect(res.status).toBe(200);
    const body = await res.json();
    // The fallback array is non-empty (defined in MODEL_PROVIDERS).
    expect(body.models.length).toBeGreaterThan(0);
  });

  it("gemini-cli embedding → empty list", async () => {
    const res = await GET(buildReq("?provider=gemini-cli&type=embedding"));
    expect((await res.json()).models).toEqual([]);
  });
});

describe("GET /api/models — API key waterfall", () => {
  it("uses query-string apiKey verbatim (no settings call needed)", async () => {
    fetchSpy.mockResolvedValue(fakeResponse({ data: [] }));
    await GET(buildReq("?provider=openai&apiKey=sk-direct"));
    const [, init] = fetchSpy.mock.calls[0];
    expect((init as any).headers.Authorization).toBe("Bearer sk-direct");
    expect(mockedSettings).not.toHaveBeenCalled();
  });

  it("masked '****' apiKey triggers the settings waterfall", async () => {
    mockedSettings.mockResolvedValue({
      providerApiKeys: { openai: "sk-from-vault" },
      chatModel: { provider: "x", model: "x", apiKey: "" },
      utilityModel: { provider: "x", model: "x", apiKey: "" },
      embeddingsModel: { provider: "x", model: "x", apiKey: "" },
    } as any);
    fetchSpy.mockResolvedValue(fakeResponse({ data: [] }));
    await GET(buildReq("?provider=openai&apiKey=sk-****-masked"));
    const [, init] = fetchSpy.mock.calls[0];
    expect((init as any).headers.Authorization).toBe("Bearer sk-from-vault");
  });

  it("masked '****' key NOT in the vault still resolves via embeddingsModel — never forwarded verbatim (regression)", async () => {
    // Bug: a masked key is truthy, so the `!apiKey`-gated chatModel/
    // utilityModel/embeddingsModel/env branches never fired when the provider
    // was absent from the vault. The masked placeholder was then forwarded
    // upstream → provider 400 → route 500. This broke the Settings embeddings
    // dropdown (google key, not in vault, lives in embeddingsModel).
    mockedSettings.mockResolvedValue({
      providerApiKeys: {}, // NOT in vault → must fall through to embeddingsModel
      chatModel: { provider: "x", model: "x", apiKey: "" },
      utilityModel: { provider: "x", model: "x", apiKey: "" },
      embeddingsModel: {
        provider: "google",
        model: "text-embedding-004",
        apiKey: "goog-real-key",
      },
    } as any);
    fetchSpy.mockResolvedValue(fakeResponse({ models: [] }));
    const res = await GET(
      buildReq("?provider=google&type=embedding&apiKey=AIza****h_yE")
    );
    expect(res.status).toBe(200);
    const [url] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain("key=goog-real-key");
    expect(String(url)).not.toContain("****");
  });

  it("falls through providerApiKeys → chatModel.apiKey when vault missing", async () => {
    mockedSettings.mockResolvedValue({
      providerApiKeys: {},
      chatModel: { provider: "openai", model: "gpt", apiKey: "sk-chat-key" },
      utilityModel: { provider: "x", model: "x", apiKey: "" },
      embeddingsModel: { provider: "x", model: "x", apiKey: "" },
    } as any);
    fetchSpy.mockResolvedValue(fakeResponse({ data: [] }));
    await GET(buildReq("?provider=openai"));
    const [, init] = fetchSpy.mock.calls[0];
    expect((init as any).headers.Authorization).toBe("Bearer sk-chat-key");
  });

  it("falls through to embeddingsModel.apiKey when type=embedding", async () => {
    mockedSettings.mockResolvedValue({
      providerApiKeys: {},
      chatModel: { provider: "x", model: "x", apiKey: "" },
      utilityModel: { provider: "x", model: "x", apiKey: "" },
      embeddingsModel: {
        provider: "openai",
        model: "text-embedding-3-small",
        apiKey: "sk-embed-key",
      },
    } as any);
    fetchSpy.mockResolvedValue(fakeResponse({ data: [] }));
    await GET(buildReq("?provider=openai&type=embedding"));
    const [, init] = fetchSpy.mock.calls[0];
    expect((init as any).headers.Authorization).toBe("Bearer sk-embed-key");
  });

  it("falls back to process.env via envKey when settings have nothing", async () => {
    process.env.OPENAI_API_KEY = "sk-env-final";
    mockedSettings.mockResolvedValue({
      providerApiKeys: {},
      chatModel: { provider: "x", model: "x", apiKey: "" },
      utilityModel: { provider: "x", model: "x", apiKey: "" },
      embeddingsModel: { provider: "x", model: "x", apiKey: "" },
    } as any);
    fetchSpy.mockResolvedValue(fakeResponse({ data: [] }));
    await GET(buildReq("?provider=openai"));
    const [, init] = fetchSpy.mock.calls[0];
    expect((init as any).headers.Authorization).toBe("Bearer sk-env-final");
  });

  it("if getSettings throws, request still proceeds (with empty apiKey)", async () => {
    mockedSettings.mockRejectedValue(new Error("settings JSON corrupt"));
    fetchSpy.mockResolvedValue(fakeResponse({ data: [] }));
    const res = await GET(buildReq("?provider=openai"));
    expect(res.status).toBe(200);
    const [, init] = fetchSpy.mock.calls[0];
    expect((init as any).headers.Authorization).toBe("Bearer ");
  });
});

describe("GET /api/models — error handling & unknown provider", () => {
  it("returns 500 + empty models when fetch throws", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await GET(buildReq("?provider=openai&apiKey=k"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.models).toEqual([]);
    expect(body.error).toMatch(/ECONNREFUSED/);
  });

  it("unknown provider with no MODEL_PROVIDERS entry → empty models, no fetch", async () => {
    const res = await GET(buildReq("?provider=nonexistent-provider"));
    expect(res.status).toBe(200);
    expect((await res.json()).models).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
