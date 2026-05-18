/**
 * Tests for GET / PUT / PATCH /api/settings.
 *
 * The route is the gatekeeper for the settings store. It carries three
 * security-sensitive responsibilities:
 *
 *   1. Mask every API key + the auth password hash in responses.
 *      (The browser must NEVER see the real value — once shown, it's
 *      potentially persisted in screenshots, error reports, etc.)
 *   2. Restore masked values on PUT/PATCH so a UI that didn't change a
 *      key doesn't accidentally erase it. The masked pattern must be
 *      precise enough to NOT accept a real user-entered key that happens
 *      to contain `****` as a substring.
 *   3. PATCH path validation — only top-level whitelisted roots, and
 *      forbid `__proto__` / `constructor` / `prototype` segments to
 *      stop prototype pollution.
 *
 * Coverage of `envApiKeys`:
 *   - GET surfaces it from `process.env` (server-derived, never persisted).
 *   - PUT strips it from the incoming body so a malicious / buggy client
 *     can't write it to disk.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/storage/settings-store", () => ({
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
}));

vi.mock("@/lib/settings/update-settings-path", () => ({
  updateSettingsByPath: vi.fn(),
}));

import { GET, PUT, PATCH } from "./route";
import {
  getSettings,
  saveSettings,
} from "@/lib/storage/settings-store";
import { updateSettingsByPath } from "@/lib/settings/update-settings-path";
import {
  DEFAULT_AUTH_PASSWORD_HASH,
  DEFAULT_AUTH_USERNAME,
} from "@/lib/auth/password";

const mockedGet = vi.mocked(getSettings);
const mockedSave = vi.mocked(saveSettings);
const mockedPath = vi.mocked(updateSettingsByPath);

const fakeSettings = (overrides: any = {}) => ({
  chatModel: {
    provider: "openrouter",
    model: "x",
    apiKey: "sk-real-chat-key-xxxxxx",
    authMethod: "api_key",
  },
  utilityModel: {
    provider: "openai",
    model: "y",
    apiKey: "sk-real-util-key-yyyyyy",
  },
  embeddingsModel: {
    provider: "openai",
    model: "z",
    apiKey: "sk-real-embed-key-zzzzz",
    dimensions: 1536,
  },
  codeExecution: { enabled: true, timeout: 600, maxOutputLength: 120000 },
  memory: { enabled: true, similarityThreshold: 0.4, maxResults: 10, chunkSize: 400 },
  search: { enabled: true, provider: "tavily", apiKey: "tvly-real-key-aaa" },
  general: { darkMode: false, language: "en" },
  auth: {
    enabled: true,
    username: DEFAULT_AUTH_USERNAME,
    passwordHash: DEFAULT_AUTH_PASSWORD_HASH,
    mustChangeCredentials: true,
  },
  providerApiKeys: {
    openai: "sk-OPENAI-vault-bbbbb",
    anthropic: "sk-ant-vault-ccccc",
  },
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mockedGet.mockResolvedValue(fakeSettings() as any);
  mockedSave.mockImplementation(async (s: any) => ({ ...fakeSettings(), ...s }));
});

function buildPut(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function buildPatch(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ────────────────────────────────────────────────────────────
// GET — masks keys, surfaces envApiKeys
// ────────────────────────────────────────────────────────────

describe("GET /api/settings — masking", () => {
  it("masks chatModel.apiKey + utilityModel.apiKey + embeddingsModel.apiKey", async () => {
    const res = await GET();
    const body = await res.json();
    expect(body.chatModel.apiKey).toMatch(/^.{4}\*{4}.{4}$/);
    expect(body.utilityModel.apiKey).toMatch(/^.{4}\*{4}.{4}$/);
    expect(body.embeddingsModel.apiKey).toMatch(/^.{4}\*{4}.{4}$/);
    // Original real values absent from response.
    expect(JSON.stringify(body)).not.toContain("sk-real-chat-key");
    expect(JSON.stringify(body)).not.toContain("sk-real-util-key");
  });

  it("masks search.apiKey (Tavily key) + auth.passwordHash", async () => {
    const res = await GET();
    const body = await res.json();
    expect(body.search.apiKey).toMatch(/^.{4}\*{4}.{4}$/);
    expect(body.auth.passwordHash).toMatch(/\*{4}/);
    expect(JSON.stringify(body)).not.toContain("tvly-real-key");
    // The real scrypt envelope must not appear in the response.
    expect(JSON.stringify(body)).not.toContain(DEFAULT_AUTH_PASSWORD_HASH);
  });

  it("masks each entry in the providerApiKeys vault", async () => {
    const res = await GET();
    const body = await res.json();
    expect(body.providerApiKeys.openai).toMatch(/\*{4}/);
    expect(body.providerApiKeys.anthropic).toMatch(/\*{4}/);
    expect(JSON.stringify(body)).not.toContain("sk-OPENAI-vault");
    expect(JSON.stringify(body)).not.toContain("sk-ant-vault");
  });

  it("uses **** (4 chars) for short keys (length ≤ 8)", async () => {
    mockedGet.mockResolvedValue(
      fakeSettings({
        chatModel: {
          provider: "openrouter",
          model: "x",
          apiKey: "shortkey", // 8 chars
        },
      }) as any
    );
    const res = await GET();
    const body = await res.json();
    expect(body.chatModel.apiKey).toBe("****");
  });
});

describe("GET /api/settings — envApiKeys", () => {
  it("flags providers whose env vars are SET", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-env-set");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-env");

    const res = await GET();
    const body = await res.json();
    expect(body.envApiKeys.openai).toBe(true);
    expect(body.envApiKeys.anthropic).toBe(true);
    // Values themselves NEVER appear.
    expect(JSON.stringify(body)).not.toContain("sk-env-set");
  });

  it("does NOT flag providers with empty env vars (the operator may be confused otherwise)", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const res = await GET();
    const body = await res.json();
    expect(body.envApiKeys.openai).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────
// PUT — masked-key restoration + envApiKeys strip
// ────────────────────────────────────────────────────────────

describe("PUT /api/settings — masked-key restoration", () => {
  it("restores chatModel.apiKey from current when client sends back the masked value", async () => {
    // The UI received the masked key in GET, didn't change it, sent it back
    // verbatim. The route must restore the REAL key from current state — not
    // persist `****` (which would clobber the actual key with mojibake).
    const res = await PUT(
      buildPut({
        chatModel: {
          provider: "openrouter",
          model: "new-model",
          apiKey: "sk-r****-key", // looks like a 4*4*4 mask
        },
      })
    );
    expect(res.status).toBe(200);
    expect(mockedSave).toHaveBeenCalledOnce();
    const arg = mockedSave.mock.calls[0][0] as any;
    expect(arg.chatModel.apiKey).toBe("sk-real-chat-key-xxxxxx"); // restored
    expect(arg.chatModel.model).toBe("new-model"); // user's other change preserved
  });

  it("does NOT restore — KEEPS — a fresh key the user typed (real key never matches mask regex)", async () => {
    await PUT(
      buildPut({
        chatModel: {
          provider: "openrouter",
          model: "x",
          apiKey: "sk-NEW-USER-KEY-abc1234567",
        },
      })
    );
    const arg = mockedSave.mock.calls[0][0] as any;
    expect(arg.chatModel.apiKey).toBe("sk-NEW-USER-KEY-abc1234567");
  });

  it("does NOT restore a real key that happens to contain '****' as a substring (mask regex is anchored)", async () => {
    // Pre-PM-#15 / -16 era this was the silent regression: `includes('****')`
    // would treat any user key with four asterisks in a row as masked and
    // silently overwrite it. The current MASK_RE is anchored — verify.
    await PUT(
      buildPut({
        chatModel: {
          provider: "openrouter",
          model: "x",
          apiKey: "sk-***-prefix-but-real-tail-zzzzz",
        },
      })
    );
    const arg = mockedSave.mock.calls[0][0] as any;
    // Whatever the user sent must be persisted — not restored.
    expect(arg.chatModel.apiKey).toBe("sk-***-prefix-but-real-tail-zzzzz");
  });

  it("restores **** (the short-mask form too)", async () => {
    await PUT(
      buildPut({
        chatModel: {
          provider: "openrouter",
          model: "x",
          apiKey: "****",
        },
      })
    );
    const arg = mockedSave.mock.calls[0][0] as any;
    expect(arg.chatModel.apiKey).toBe("sk-real-chat-key-xxxxxx");
  });

  it("restores masked auth.passwordHash so the UI can't accidentally clobber the password", async () => {
    await PUT(
      buildPut({
        auth: {
          enabled: true,
          username: "newname",
          passwordHash: "scry****ABCD", // 4 + 4 + 4 mask shape
          mustChangeCredentials: false,
        },
      })
    );
    const arg = mockedSave.mock.calls[0][0] as any;
    expect(arg.auth.passwordHash).toBe(DEFAULT_AUTH_PASSWORD_HASH);
  });

  it("strips envApiKeys from incoming body so it can NEVER be persisted", async () => {
    await PUT(
      buildPut({
        envApiKeys: { openai: true, anthropic: false },
        general: { darkMode: true, language: "en" },
      })
    );
    const arg = mockedSave.mock.calls[0][0] as any;
    expect(arg.envApiKeys).toBeUndefined();
    // Other body fields still flow through.
    expect(arg.general.darkMode).toBe(true);
  });

  it("returns 500 with sanitized message when saveSettings throws", async () => {
    mockedSave.mockRejectedValue(new Error("disk full"));
    const res = await PUT(buildPut({ general: { darkMode: true, language: "en" } }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/disk full/);
  });
});

// ────────────────────────────────────────────────────────────
// PATCH — path validation
// ────────────────────────────────────────────────────────────

describe("PATCH /api/settings — path validation", () => {
  beforeEach(() => {
    mockedPath.mockImplementation((current: any) => current);
    mockedSave.mockResolvedValue(fakeSettings() as any);
  });

  it("returns 400 when `path` is missing", async () => {
    const res = await PATCH(buildPatch({ value: "x" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/path/i);
  });

  it("returns 400 when `path` is not a string", async () => {
    const res = await PATCH(buildPatch({ path: 42, value: "x" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when the top-level segment is NOT in the allowed list (e.g., 'auth')", async () => {
    // Note: 'auth' is intentionally NOT in ALLOWED_PATCH_ROOTS — credential
    // changes go through the dedicated /api/auth/credentials route.
    const res = await PATCH(buildPatch({ path: "auth.username", value: "x" }));
    expect(res.status).toBe(400);
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it.each(["__proto__", "constructor", "prototype"])(
    "returns 400 when ANY segment is %s (prototype-pollution defense)",
    async (forbidden) => {
      const res = await PATCH(
        buildPatch({ path: `chatModel.${forbidden}.x`, value: "evil" })
      );
      expect(res.status).toBe(400);
    }
  );

  it("accepts allowed roots: chatModel/utilityModel/embeddingsModel/codeExecution/memory/search/general/providerApiKeys", async () => {
    for (const root of [
      "chatModel",
      "utilityModel",
      "embeddingsModel",
      "codeExecution",
      "memory",
      "search",
      "general",
      "providerApiKeys",
    ]) {
      const res = await PATCH(buildPatch({ path: `${root}.field`, value: "x" }));
      expect(res.status, `root=${root}`).toBe(200);
    }
  });

  it("forwards path + value to updateSettingsByPath", async () => {
    await PATCH(buildPatch({ path: "general.darkMode", value: true }));
    expect(mockedPath).toHaveBeenCalledOnce();
    expect(mockedPath).toHaveBeenCalledWith(
      expect.any(Object),
      "general.darkMode",
      true
    );
  });

  it("returns the saved settings (masked) on success", async () => {
    const res = await PATCH(buildPatch({ path: "general.darkMode", value: true }));
    const body = await res.json();
    expect(res.status).toBe(200);
    // Response is the masked shape of saved settings.
    expect(body.chatModel.apiKey).toMatch(/\*{4}/);
  });

  it("returns 500 on save failure", async () => {
    mockedSave.mockRejectedValue(new Error("disk full"));
    const res = await PATCH(buildPatch({ path: "general.darkMode", value: true }));
    expect(res.status).toBe(500);
  });
});
