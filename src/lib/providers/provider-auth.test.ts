/**
 * Tests for `provider-auth.ts` — CLI OAuth detection for `codex-cli` and
 * `gemini-cli` providers. The file reads two sets of auth artifacts from
 * disk (`$HOME/.codex/auth.json` and `$HOME/.gemini/oauth_creds.json` +
 * `settings.json`) and translates them into a `ProviderAuthStatus`
 * shape consumed by the wizard UI.
 *
 * Strategy: point `os.homedir()` at a tmpdir per test so we can plant
 * fixture files freely without touching the real `~`. Everything else
 * is synchronous-fs reads inside the SUT.
 *
 * What this pins:
 *   - `checkProviderAuthStatus({ method: "api_key" })` rejects both CLI
 *     providers with provider-specific guidance (use OpenAI / Google).
 *   - `checkProviderAuthStatus({ method: "oauth" })` for Codex:
 *     * missing file       → connected=false, "token file was not found"
 *     * auth_mode != chatgpt → connected=false, "not in OAuth mode"
 *     * missing tokens     → connected=false, "tokens are missing"
 *     * fully configured   → connected=true, account/refresh metadata
 *       surfaced in detail
 *   - `checkProviderAuthStatus({ method: "oauth" })` for Gemini:
 *     * missing settings.json + missing creds → connected=false
 *     * settings.json says selectedAuthType != oauth → connected=false
 *     * fully configured                    → connected=true
 *   - `connectProviderAuth({ method: "oauth" })` returns terminal-command
 *     instructions; never starts a flow itself (Orchestra doesn't drive
 *     the browser, the CLI does).
 *   - `resolveCliOAuthCredentialSync` throws when the file is missing
 *     OR `auth_mode` is wrong OR tokens are absent; returns a complete
 *     `ResolvedCliOAuthCredential` on success.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpHome: string;
let homedirSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-providerauth-"));
  homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
});

afterEach(() => {
  homedirSpy.mockRestore();
  fs.rmSync(tmpHome, { recursive: true, force: true });
  // Drop any env vars the tests set.
  delete process.env.CODEX_AUTH_FILE;
  delete process.env.GEMINI_SETTINGS_FILE;
  delete process.env.GEMINI_OAUTH_CREDS_FILE;
});

function plant(filePath: string, json: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(json), "utf-8");
}

function codexAuthPath(): string {
  return path.join(tmpHome, ".codex", "auth.json");
}

// Deliberately NOT under `tmpHome/.gemini` — that equals the SUT's
// `os.homedir()/.gemini` default, and resolveAuthPath only treats the env
// override as "configured" (skipping the /Users/* discovery scan) when the
// override path DIFFERS from the default. A distinct subdir keeps these tests
// hermetic on a host that has the operator's own ~/.gemini creds.
function geminiSettingsPath(): string {
  return path.join(tmpHome, "gemini-cli", "settings.json");
}

function geminiCredsPath(): string {
  return path.join(tmpHome, "gemini-cli", "oauth_creds.json");
}

// Imports happen after spy setup to avoid the module caching a real
// `os.homedir` snapshot before the test patches it. Re-import per test
// where the env vars matter.
async function loadModule() {
  return await import("./provider-auth");
}

describe("checkProviderAuthStatus — unsupported method", () => {
  it("rejects codex-cli + method='api_key' with OpenAI guidance", async () => {
    const { checkProviderAuthStatus } = await loadModule();
    const r = await checkProviderAuthStatus({
      provider: "codex-cli",
      method: "api_key",
    });
    expect(r.connected).toBe(false);
    expect(r.message).toMatch(/Only OAuth/i);
    expect(r.detail).toMatch(/OpenAI/);
  });

  it("rejects gemini-cli + method='api_key' with Google guidance", async () => {
    const { checkProviderAuthStatus } = await loadModule();
    const r = await checkProviderAuthStatus({
      provider: "gemini-cli",
      method: "api_key",
    });
    expect(r.connected).toBe(false);
    expect(r.detail).toMatch(/Google/);
  });
});

describe("checkProviderAuthStatus — codex-cli OAuth branches", () => {
  it("missing auth.json → connected=false with 'token file was not found'", async () => {
    const { checkProviderAuthStatus } = await loadModule();
    const r = await checkProviderAuthStatus({
      provider: "codex-cli",
      method: "oauth",
    });
    expect(r.connected).toBe(false);
    expect(r.message).toMatch(/token file was not found/i);
    // The expected-path hint is part of detail so the operator knows
    // where Codex is looking.
    expect(r.detail).toMatch(/\.codex\/auth\.json/);
  });

  it("auth_mode != 'chatgpt' → connected=false with 'not in OAuth mode'", async () => {
    plant(codexAuthPath(), { auth_mode: "api_key" });
    const { checkProviderAuthStatus } = await loadModule();
    const r = await checkProviderAuthStatus({
      provider: "codex-cli",
      method: "oauth",
    });
    expect(r.connected).toBe(false);
    expect(r.message).toMatch(/not in OAuth mode/i);
    expect(r.detail).toMatch(/auth_mode=api_key/);
  });

  it("missing access/refresh tokens → connected=false 'tokens are missing'", async () => {
    plant(codexAuthPath(), {
      auth_mode: "chatgpt",
      tokens: { access_token: "", refresh_token: "" },
    });
    const { checkProviderAuthStatus } = await loadModule();
    const r = await checkProviderAuthStatus({
      provider: "codex-cli",
      method: "oauth",
    });
    expect(r.connected).toBe(false);
    expect(r.message).toMatch(/tokens are missing/i);
  });

  it("fully configured → connected=true; detail surfaces account_id + last_refresh", async () => {
    const lastRefreshMs = Date.parse("2026-03-01T12:00:00.000Z");
    plant(codexAuthPath(), {
      auth_mode: "chatgpt",
      tokens: {
        access_token: "at-1",
        refresh_token: "rt-1",
        account_id: "acc-42",
      },
      last_refresh: lastRefreshMs,
    });
    const { checkProviderAuthStatus } = await loadModule();
    const r = await checkProviderAuthStatus({
      provider: "codex-cli",
      method: "oauth",
    });
    expect(r.connected).toBe(true);
    expect(r.message).toMatch(/configured/i);
    expect(r.detail).toMatch(/account_id=acc-42/);
    expect(r.detail).toMatch(/last_refresh=2026-03-01T12:00:00.000Z/);
  });

  it("respects CODEX_AUTH_FILE env override (operator-controlled path)", async () => {
    const custom = path.join(tmpHome, "custom", "codex.json");
    plant(custom, {
      auth_mode: "chatgpt",
      tokens: { access_token: "at", refresh_token: "rt" },
    });
    process.env.CODEX_AUTH_FILE = custom;
    vi.resetModules(); // re-evaluate the env at import time
    const { checkProviderAuthStatus } = await loadModule();
    const r = await checkProviderAuthStatus({
      provider: "codex-cli",
      method: "oauth",
    });
    expect(r.connected).toBe(true);
  });
});

describe("checkProviderAuthStatus — gemini-cli OAuth branches", () => {
  // Hermetic isolation. The SUT's `discoverPath()` scans `/Users/*` and
  // `/home/*` (for Docker / multi-user homes) IN ADDITION to the `os.homedir()`
  // spy — so on a real macOS box where the operator has their own
  // `~/.gemini/oauth_creds.json`, the scan finds the REAL creds and reports
  // `connected=true` no matter what `os.homedir()` is mocked to. Point the
  // documented env overrides at tmpHome: a non-default path makes the SUT use it
  // directly and skip discovery entirely, so these tests no longer depend on the
  // host's home contents. (Outer `afterEach` already deletes these vars.)
  beforeEach(() => {
    process.env.GEMINI_OAUTH_CREDS_FILE = geminiCredsPath();
    process.env.GEMINI_SETTINGS_FILE = geminiSettingsPath();
  });

  it("no settings.json AND no oauth_creds → connected=false", async () => {
    const { checkProviderAuthStatus } = await loadModule();
    const r = await checkProviderAuthStatus({
      provider: "gemini-cli",
      method: "oauth",
    });
    expect(r.connected).toBe(false);
  });

  it("settings.json says security.auth.selectedType != oauth → connected=false", async () => {
    // Gemini settings.json shape is nested: `security.auth.selectedType`.
    plant(geminiSettingsPath(), { security: { auth: { selectedType: "api_key" } } });
    plant(geminiCredsPath(), { access_token: "at", refresh_token: "rt" });
    const { checkProviderAuthStatus } = await loadModule();
    const r = await checkProviderAuthStatus({
      provider: "gemini-cli",
      method: "oauth",
    });
    expect(r.connected).toBe(false);
  });

  it("settings.json + oauth_creds + tokens present → connected=true", async () => {
    plant(geminiSettingsPath(), {
      security: { auth: { selectedType: "oauth-personal" } },
    });
    plant(geminiCredsPath(), {
      access_token: "at-g",
      refresh_token: "rt-g",
      token_type: "Bearer",
      expiry_date: Date.now() + 3600_000,
    });
    const { checkProviderAuthStatus } = await loadModule();
    const r = await checkProviderAuthStatus({
      provider: "gemini-cli",
      method: "oauth",
    });
    expect(r.connected).toBe(true);
  });
});

describe("connectProviderAuth — terminal-command instructions", () => {
  it("codex-cli + oauth → returns `codex login` command", async () => {
    const { connectProviderAuth } = await loadModule();
    const r = await connectProviderAuth({
      provider: "codex-cli",
      method: "oauth",
    });
    expect(r.started).toBe(false); // Orchestra never starts the flow itself
    expect(r.connected).toBe(false); // browser hasn't run yet
    expect(r.command).toBe("codex login");
    expect(r.detail).toMatch(/codex login/);
  });

  it("gemini-cli + oauth → returns `gemini` command + login instructions", async () => {
    const { connectProviderAuth } = await loadModule();
    const r = await connectProviderAuth({
      provider: "gemini-cli",
      method: "oauth",
    });
    expect(r.command).toBe("gemini");
    expect(r.detail).toMatch(/Login with Google/i);
  });

  it("any method other than 'oauth' → same unsupported-method rejection as check", async () => {
    const { connectProviderAuth } = await loadModule();
    const r = await connectProviderAuth({
      provider: "codex-cli",
      method: "api_key",
    });
    expect(r.connected).toBe(false);
    expect(r.started).toBe(false);
    expect(r.message).toMatch(/Only OAuth/i);
  });
});

describe("resolveCliOAuthCredentialSync — throw/return contracts", () => {
  it("codex: throws with a 'run `codex login`' hint when the auth file is absent", async () => {
    const { resolveCliOAuthCredentialSync } = await loadModule();
    expect(() => resolveCliOAuthCredentialSync("codex-cli")).toThrow(
      /codex login/
    );
  });

  it("codex: throws when auth_mode is not 'chatgpt'", async () => {
    plant(codexAuthPath(), { auth_mode: "api_key" });
    const { resolveCliOAuthCredentialSync } = await loadModule();
    expect(() => resolveCliOAuthCredentialSync("codex-cli")).toThrow(
      /OAuth mode|auth_mode=chatgpt/
    );
  });

  it("codex: throws when tokens are missing even with auth_mode=chatgpt", async () => {
    plant(codexAuthPath(), {
      auth_mode: "chatgpt",
      tokens: { access_token: "" },
    });
    const { resolveCliOAuthCredentialSync } = await loadModule();
    expect(() => resolveCliOAuthCredentialSync("codex-cli")).toThrow(
      /tokens are missing/
    );
  });

  it("codex: returns the resolved credential shape when fully configured", async () => {
    plant(codexAuthPath(), {
      auth_mode: "chatgpt",
      tokens: {
        access_token: "at-x",
        refresh_token: "rt-x",
        account_id: "acc-9",
      },
    });
    const { resolveCliOAuthCredentialSync } = await loadModule();
    const cred = resolveCliOAuthCredentialSync("codex-cli");
    expect(cred).toEqual({
      provider: "codex-cli",
      accessToken: "at-x",
      refreshToken: "rt-x",
      accountId: "acc-9",
    });
  });
});
