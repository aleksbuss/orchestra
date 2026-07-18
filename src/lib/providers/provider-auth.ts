import fs from "fs";
import os from "os";
import path from "path";
import type { ChatAuthMethod } from "@/lib/types";
import { getDataDir } from "@/lib/storage/data-dir";

export type CliProvider = "codex-cli" | "gemini-cli";

export interface ProviderAuthStatus {
  provider: CliProvider;
  method: ChatAuthMethod;
  connected: boolean;
  message: string;
  detail?: string;
}

export interface ProviderAuthConnectResult extends ProviderAuthStatus {
  started?: boolean;
  command?: string;
}

export interface ResolvedCliOAuthCredential {
  provider: CliProvider;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  accountId?: string;
}

interface CodexAuthFile {
  auth_mode?: unknown;
  tokens?: {
    access_token?: unknown;
    refresh_token?: unknown;
    account_id?: unknown;
  };
  last_refresh?: unknown;
}

interface GeminiOauthCreds {
  access_token?: unknown;
  refresh_token?: unknown;
  expiry_date?: unknown;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asEpochMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function resolveAuthPath(envName: string, defaultPath: string): string {
  const envValue = process.env[envName];
  if (typeof envValue !== "string") {
    return defaultPath;
  }
  const trimmed = envValue.trim();
  return trimmed ? trimmed : defaultPath;
}

function isReadableFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function listChildDirs(baseDir: string): string[] {
  try {
    return fs
      .readdirSync(baseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => path.join(baseDir, entry.name));
  } catch {
    return [];
  }
}

function collectHomeCandidates(): string[] {
  const candidates = new Set<string>();

  const addCandidate = (value: string | undefined | null) => {
    if (!value) return;
    const trimmed = value.trim();
    if (!trimmed) return;
    candidates.add(trimmed);
  };

  addCandidate(os.homedir());
  addCandidate(process.env.HOME);
  addCandidate("/home/node");
  addCandidate("/root");
  addCandidate(getDataDir());

  for (const dir of listChildDirs("/home")) {
    addCandidate(dir);
  }
  for (const dir of listChildDirs("/Users")) {
    addCandidate(dir);
  }

  return Array.from(candidates);
}

function firstExistingFile(paths: string[]): string | null {
  for (const filePath of paths) {
    if (isReadableFile(filePath)) {
      return filePath;
    }
  }
  return null;
}

function discoverPath(defaultPath: string, relativePath: string): string {
  if (isReadableFile(defaultPath)) {
    return defaultPath;
  }
  const discovered =
    firstExistingFile(
      collectHomeCandidates().map((homeDir) => path.join(homeDir, relativePath))
    ) || null;
  return discovered || defaultPath;
}

function deriveGeminiSettingsPathFromCreds(credsPath: string): string | null {
  const parsed = path.parse(credsPath);
  if (parsed.base !== "oauth_creds.json") return null;
  if (path.basename(parsed.dir) !== ".gemini") return null;
  return path.join(parsed.dir, "settings.json");
}

function readCodexAuth(): { path: string; parsed: CodexAuthFile | null } {
  const defaultPath = path.join(os.homedir(), ".codex", "auth.json");
  const configuredPath = resolveAuthPath(
    "CODEX_AUTH_FILE",
    defaultPath
  );
  const authPath =
    configuredPath === defaultPath
      ? discoverPath(defaultPath, path.join(".codex", "auth.json"))
      : configuredPath;
  const parsed = readJsonObject(authPath) as CodexAuthFile | null;
  return { path: authPath, parsed };
}

function resolveCodexCredential(): ResolvedCliOAuthCredential {
  const { parsed } = readCodexAuth();
  if (!parsed) {
    throw new Error("Codex OAuth file is missing. Run `codex login`.");
  }

  const authMode = asNonEmptyString(parsed.auth_mode)?.toLowerCase() || "";
  const accessToken = asNonEmptyString(parsed.tokens?.access_token);
  const refreshToken = asNonEmptyString(parsed.tokens?.refresh_token);
  const accountId = asNonEmptyString(parsed.tokens?.account_id) || undefined;

  if (authMode !== "chatgpt") {
    throw new Error("Codex CLI is not in OAuth mode (`auth_mode=chatgpt` required).");
  }
  if (!accessToken || !refreshToken) {
    throw new Error("Codex OAuth tokens are missing. Run `codex login`.");
  }

  return {
    provider: "codex-cli",
    accessToken,
    refreshToken,
    accountId,
  };
}

function checkCodexOauthStatus(): ProviderAuthStatus {
  const { path: authPath, parsed } = readCodexAuth();

  if (!parsed) {
    return {
      provider: "codex-cli",
      method: "oauth",
      connected: false,
      message: "Codex CLI OAuth token file was not found.",
      detail: `Expected: ${authPath}`,
    };
  }

  const authMode = asNonEmptyString(parsed.auth_mode)?.toLowerCase() || "";
  const accessToken = asNonEmptyString(parsed.tokens?.access_token);
  const refreshToken = asNonEmptyString(parsed.tokens?.refresh_token);
  const accountId = asNonEmptyString(parsed.tokens?.account_id);
  const lastRefresh = asEpochMs(parsed.last_refresh);

  if (authMode !== "chatgpt") {
    return {
      provider: "codex-cli",
      method: "oauth",
      connected: false,
      message: "Codex CLI is not in OAuth mode.",
      detail: authMode
        ? `auth_mode=${authMode}. Run \`codex login\` with ChatGPT.`
        : `auth_mode is missing in ${authPath}`,
    };
  }

  if (!accessToken || !refreshToken) {
    return {
      provider: "codex-cli",
      method: "oauth",
      connected: false,
      message: "Codex CLI OAuth tokens are missing.",
      detail: "Run `codex login` and complete browser authorization.",
    };
  }

  const detailParts: string[] = [];
  if (accountId) detailParts.push(`account_id=${accountId}`);
  if (lastRefresh) detailParts.push(`last_refresh=${new Date(lastRefresh).toISOString()}`);

  return {
    provider: "codex-cli",
    method: "oauth",
    connected: true,
    message: "Codex CLI OAuth is configured.",
    detail: detailParts.length > 0 ? detailParts.join("; ") : undefined,
  };
}

function readGeminiSettings(): { path: string; parsed: Record<string, unknown> | null } {
  const defaultPath = path.join(os.homedir(), ".gemini", "settings.json");
  const settingsPath = resolveAuthPath(
    "GEMINI_SETTINGS_FILE",
    defaultPath
  );
  const resolvedSettingsPath =
    settingsPath === defaultPath
      ? discoverPath(defaultPath, path.join(".gemini", "settings.json"))
      : settingsPath;
  return { path: resolvedSettingsPath, parsed: readJsonObject(resolvedSettingsPath) };
}

function readGeminiOauthCreds(): { path: string; parsed: GeminiOauthCreds | null } {
  const defaultPath = path.join(os.homedir(), ".gemini", "oauth_creds.json");
  const credsPath = resolveAuthPath(
    "GEMINI_OAUTH_CREDS_FILE",
    defaultPath
  );
  const resolvedCredsPath =
    credsPath === defaultPath
      ? discoverPath(defaultPath, path.join(".gemini", "oauth_creds.json"))
      : credsPath;
  const parsed = readJsonObject(resolvedCredsPath) as GeminiOauthCreds | null;
  return { path: resolvedCredsPath, parsed };
}

function resolveGeminiCredential(): ResolvedCliOAuthCredential {
  const { path: credsPath, parsed: creds } = readGeminiOauthCreds();
  const settingsFromCreds = deriveGeminiSettingsPathFromCreds(credsPath);
  const settingsConfigured = process.env.GEMINI_SETTINGS_FILE?.trim();
  const { path: discoveredSettingsPath, parsed: discoveredSettings } = readGeminiSettings();
  const settingsPath =
    !settingsConfigured &&
    settingsFromCreds &&
    isReadableFile(settingsFromCreds)
      ? settingsFromCreds
      : discoveredSettingsPath;
  const settings =
    settingsPath === discoveredSettingsPath
      ? discoveredSettings
      : readJsonObject(settingsPath);
  if (!creds) {
    throw new Error("Gemini OAuth file is missing. Run `gemini` and login with Google.");
  }

  const selectedType = (
    (settings?.security as Record<string, unknown> | undefined)?.auth as
      | Record<string, unknown>
      | undefined
  )?.selectedType;

  const selectedTypeValue =
    typeof selectedType === "string" ? selectedType.trim().toLowerCase() : "";
  const selectedOauth =
    selectedTypeValue === "oauth-personal" ||
    selectedTypeValue === "login_with_google" ||
    selectedTypeValue.startsWith("oauth");

  if (!selectedOauth) {
    throw new Error(
      `Gemini CLI is not in OAuth mode. Switch auth to OAuth in Gemini CLI (settings: ${settingsPath}).`
    );
  }

  const accessToken = asNonEmptyString(creds.access_token);
  const refreshToken = asNonEmptyString(creds.refresh_token) || undefined;
  const expiresAt = asEpochMs(creds.expiry_date) ?? undefined;

  // An EXPIRED access token is no longer fatal here: the fetch layer refreshes
  // it per-request via the refresh_token (getValidGeminiAccessToken). We only
  // fail when there is nothing to authenticate OR refresh with. This lets the
  // sync model factory construct even when the on-disk access token is stale.
  if (!accessToken && !refreshToken) {
    throw new Error(
      "Gemini OAuth has no access or refresh token. Re-login with `gemini`."
    );
  }

  return {
    provider: "gemini-cli",
    accessToken: accessToken ?? "",
    refreshToken,
    expiresAt,
  };
}

/**
 * gemini-cli's installed-app OAuth client (client_id + client_secret) is NOT
 * embedded in Orchestra's source. It is PUBLIC (identical for every user, part
 * of the published `@google/gemini-cli` package — an installed-app "secret" is
 * public by OAuth design), but pinning it here trips secret-scanners and rots
 * whenever Google rotates the app. Resolve it at runtime instead:
 *   1. `GEMINI_OAUTH_CLIENT_ID` + `GEMINI_OAUTH_CLIENT_SECRET` env (operator
 *      override + hermetic tests), else
 *   2. extract it from the operator's installed gemini-cli bundle — the same
 *      client the CLI itself uses, version-matched.
 * A gemini-cli install exists by construction (the creds file comes from it),
 * so extraction succeeds whenever this provider is usable.
 */
let cachedGeminiOAuthClient: { clientId: string; clientSecret: string } | null = null;

/** Test-only: drop the cached gemini-cli OAuth client resolution. */
export function __resetGeminiOAuthClientCacheForTests(): void {
  cachedGeminiOAuthClient = null;
}

function findGeminiCliBundleDir(): string | null {
  const pathEnv = process.env.PATH || "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    try {
      const bin = path.join(dir, "gemini");
      if (fs.existsSync(bin)) return path.dirname(fs.realpathSync(bin));
    } catch {
      // unreadable PATH entry — skip
    }
  }
  return null;
}

function resolveGeminiCliOAuthClient(): { clientId: string; clientSecret: string } {
  const envId = process.env.GEMINI_OAUTH_CLIENT_ID?.trim();
  const envSecret = process.env.GEMINI_OAUTH_CLIENT_SECRET?.trim();
  if (envId && envSecret) return { clientId: envId, clientSecret: envSecret };
  if (cachedGeminiOAuthClient) return cachedGeminiOAuthClient;

  const bundleDir = findGeminiCliBundleDir();
  if (bundleDir) {
    try {
      const chunks = fs
        .readdirSync(bundleDir)
        .filter((f) => f.startsWith("chunk-") && f.endsWith(".js"));
      for (const file of chunks) {
        const text = fs.readFileSync(path.join(bundleDir, file), "utf8");
        const id = text.match(
          /OAUTH_CLIENT_ID\s*=\s*["']([^"']+\.apps\.googleusercontent\.com)["']/
        );
        const secret = text.match(/OAUTH_CLIENT_SECRET\s*=\s*["']([^"']{10,})["']/);
        if (id && secret) {
          cachedGeminiOAuthClient = { clientId: id[1], clientSecret: secret[1] };
          return cachedGeminiOAuthClient;
        }
      }
    } catch {
      // fall through to the actionable error
    }
  }
  throw new Error(
    "Could not resolve the gemini-cli OAuth client. Install the Gemini CLI " +
      "(`npm i -g @google/gemini-cli`) or set GEMINI_OAUTH_CLIENT_ID + " +
      "GEMINI_OAUTH_CLIENT_SECRET."
  );
}
const GOOGLE_OAUTH_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GEMINI_TOKEN_REFRESH_TIMEOUT_MS = 15_000;
/** Treat a token as expired this long before its real expiry (skew + in-flight). */
const GEMINI_TOKEN_EXPIRY_SKEW_MS = 60_000;

let geminiTokenCache:
  | { refreshToken: string; accessToken: string; expiresAt: number }
  | null = null;

/** Test-only: drop the in-memory refreshed-token cache. */
export function __resetGeminiTokenCacheForTests(): void {
  geminiTokenCache = null;
}

/**
 * Exchange a Gemini refresh_token for a fresh access token. Fixed Google
 * endpoint (no user-supplied URL → no SSRF surface). Never logs the token.
 */
async function refreshGeminiAccessToken(
  refreshToken: string,
  signal?: AbortSignal
): Promise<{ accessToken: string; expiresAt: number }> {
  const { clientId, clientSecret } = resolveGeminiCliOAuthClient();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch(GOOGLE_OAUTH_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: signal ?? AbortSignal.timeout(GEMINI_TOKEN_REFRESH_TIMEOUT_MS),
  });
  if (!res.ok) {
    // Google returns e.g. {"error":"invalid_grant"} on a revoked refresh_token
    // — no token material in the error body, safe to surface a short slice.
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(
      `Gemini OAuth token refresh failed (HTTP ${res.status}). Re-login with \`gemini\`. ${detail}`
    );
  }
  const json = (await res.json().catch(() => null)) as
    | { access_token?: unknown; expires_in?: unknown }
    | null;
  const accessToken = asNonEmptyString(json?.access_token);
  if (!accessToken) {
    throw new Error("Gemini OAuth token refresh returned no access_token.");
  }
  const expiresInSec =
    typeof json?.expires_in === "number" && Number.isFinite(json.expires_in)
      ? json.expires_in
      : 3600;
  return { accessToken, expiresAt: Date.now() + expiresInSec * 1000 };
}

/**
 * Return a currently-valid Gemini access token, refreshing via the stored
 * refresh_token when the on-disk token is expired. In-memory cache only (no
 * file write-back — avoids corrupting the CLI's creds file; a fresh process
 * simply refreshes once). Throws only when there is no way to obtain a token.
 */
export async function getValidGeminiAccessToken(
  signal?: AbortSignal
): Promise<string> {
  const { parsed: creds } = readGeminiOauthCreds();
  if (!creds) {
    throw new Error(
      "Gemini OAuth file is missing. Run `gemini` and login with Google."
    );
  }
  const diskToken = asNonEmptyString(creds.access_token);
  const refreshToken = asNonEmptyString(creds.refresh_token);
  const diskExpiry = asEpochMs(creds.expiry_date);
  const now = Date.now();

  // 1) On-disk token still valid (the gemini CLI may have rewritten it): use it.
  if (
    diskToken &&
    typeof diskExpiry === "number" &&
    now < diskExpiry - GEMINI_TOKEN_EXPIRY_SKEW_MS
  ) {
    return diskToken;
  }

  if (!refreshToken) {
    if (diskToken) return diskToken; // no refresh material; try the stale token
    throw new Error(
      "Gemini OAuth access token is expired and no refresh_token is present. Re-login with `gemini`."
    );
  }

  // 2) Cached refreshed token still valid.
  if (
    geminiTokenCache &&
    geminiTokenCache.refreshToken === refreshToken &&
    now < geminiTokenCache.expiresAt - GEMINI_TOKEN_EXPIRY_SKEW_MS
  ) {
    return geminiTokenCache.accessToken;
  }

  // 3) Refresh via the refresh_token.
  const refreshed = await refreshGeminiAccessToken(refreshToken, signal);
  geminiTokenCache = {
    refreshToken,
    accessToken: refreshed.accessToken,
    expiresAt: refreshed.expiresAt,
  };
  return refreshed.accessToken;
}

function checkGeminiOauthStatus(): ProviderAuthStatus {
  const { path: credsPath, parsed: creds } = readGeminiOauthCreds();
  const settingsFromCreds = deriveGeminiSettingsPathFromCreds(credsPath);
  const settingsConfigured = process.env.GEMINI_SETTINGS_FILE?.trim();
  const { path: discoveredSettingsPath, parsed: discoveredSettings } = readGeminiSettings();
  const settingsPath =
    !settingsConfigured &&
    settingsFromCreds &&
    isReadableFile(settingsFromCreds)
      ? settingsFromCreds
      : discoveredSettingsPath;
  const settings =
    settingsPath === discoveredSettingsPath
      ? discoveredSettings
      : readJsonObject(settingsPath);

  if (!creds) {
    return {
      provider: "gemini-cli",
      method: "oauth",
      connected: false,
      message: "Gemini CLI OAuth token file was not found.",
      detail: `Expected: ${credsPath}`,
    };
  }

  const selectedType = (
    (settings?.security as Record<string, unknown> | undefined)?.auth as
      | Record<string, unknown>
      | undefined
  )?.selectedType;

  const selectedTypeValue =
    typeof selectedType === "string" ? selectedType.trim().toLowerCase() : "";
  const selectedOauth =
    selectedTypeValue === "oauth-personal" ||
    selectedTypeValue === "login_with_google" ||
    selectedTypeValue.startsWith("oauth");

  const accessToken = asNonEmptyString(creds.access_token);
  const refreshToken = asNonEmptyString(creds.refresh_token);
  const expiresAt = asEpochMs(creds.expiry_date);
  const isExpired = typeof expiresAt === "number" && Date.now() >= expiresAt;

  if (!selectedOauth) {
    return {
      provider: "gemini-cli",
      method: "oauth",
      connected: false,
      message: "Gemini CLI is not in OAuth mode.",
      detail: selectedTypeValue
        ? `selectedType=${selectedTypeValue}; switch to OAuth in Gemini CLI`
        : `selectedType is missing in ${settingsPath}`,
    };
  }

  if (!accessToken && !refreshToken) {
    return {
      provider: "gemini-cli",
      method: "oauth",
      connected: false,
      message: "Gemini CLI OAuth tokens are missing.",
      detail: "Run `gemini` and complete Login with Google.",
    };
  }

  if (isExpired && !refreshToken) {
    return {
      provider: "gemini-cli",
      method: "oauth",
      connected: false,
      message: "Gemini OAuth token is expired and cannot be refreshed.",
      detail: "Run `gemini` and complete Login with Google again.",
    };
  }

  const detailParts: string[] = [];
  if (typeof expiresAt === "number") {
    detailParts.push(
      `expires_at=${new Date(expiresAt).toISOString()}${isExpired ? " (expired)" : ""}`
    );
  }
  if (refreshToken) {
    detailParts.push("refresh_token=present");
  }

  return {
    provider: "gemini-cli",
    method: "oauth",
    connected: !isExpired,
    message: isExpired
      ? "Gemini OAuth token is expired."
      : "Gemini CLI OAuth is configured.",
    detail: detailParts.length > 0 ? detailParts.join("; ") : undefined,
  };
}

export function resolveCliOAuthCredentialSync(
  provider: CliProvider
): ResolvedCliOAuthCredential {
  if (provider === "codex-cli") {
    return resolveCodexCredential();
  }
  return resolveGeminiCredential();
}

function unsupportedMethodStatus(provider: CliProvider, method: ChatAuthMethod): ProviderAuthStatus {
  return {
    provider,
    method,
    connected: false,
    message: "Only OAuth is supported for this CLI provider in Orchestra.",
    detail:
      provider === "codex-cli"
        ? "Use provider OpenAI for API key mode, or Codex CLI with OAuth."
        : "Use provider Google for API key mode, or Gemini CLI with OAuth.",
  };
}

export async function checkProviderAuthStatus(input: {
  provider: CliProvider;
  method: ChatAuthMethod;
  hasApiKey?: boolean;
}): Promise<ProviderAuthStatus> {
  const { provider, method } = input;

  if (method !== "oauth") {
    return unsupportedMethodStatus(provider, method);
  }

  if (provider === "codex-cli") {
    return checkCodexOauthStatus();
  }
  return checkGeminiOauthStatus();
}

export async function connectProviderAuth(input: {
  provider: CliProvider;
  method: ChatAuthMethod;
  apiKey?: string;
}): Promise<ProviderAuthConnectResult> {
  const { provider, method } = input;

  if (method !== "oauth") {
    return {
      ...unsupportedMethodStatus(provider, method),
      started: false,
    };
  }

  if (provider === "codex-cli") {
    return {
      provider,
      method,
      connected: false,
      started: false,
      message: "OAuth must be completed in your terminal.",
      command: "codex login",
      detail:
        "Run `codex login`, complete browser authorization, then click Check connection.",
    };
  }

  return {
    provider,
    method,
    connected: false,
    started: false,
    message: "OAuth must be completed in your terminal.",
    command: "gemini",
    detail:
      "Run `gemini`, choose Login with Google, complete browser flow, then click Check connection.",
  };
}
