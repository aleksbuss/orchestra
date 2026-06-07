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
  const isExpired = typeof expiresAt === "number" && Date.now() >= expiresAt;

  if (!accessToken) {
    throw new Error("Gemini OAuth access token is missing. Re-login with `gemini`.");
  }

  if (isExpired) {
    throw new Error("Gemini OAuth access token is expired. Re-login with `gemini`.");
  }

  return {
    provider: "gemini-cli",
    accessToken,
    refreshToken,
    expiresAt,
  };
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
