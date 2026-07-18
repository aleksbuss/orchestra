/**
 * Codex CLI / ChatGPT-backend adapter (extracted from llm-provider.ts, §10 decomposition PR2).
 *
 * The Codex surface has two transports:
 * - Native OAuth against the ChatGPT backend (`createCodexOauthFetch` — a fetch
 *   override that injects the OAuth bearer + account id, forces `store:false`,
 *   defaults `instructions`, strips unsupported parameters, and retries a 400
 *   once after deleting the parameter the error names). llm-provider's
 *   `createCodexNativeOauthModel` wires this fetch into the @ai-sdk/openai
 *   factory.
 * - Subprocess `codex exec --json` (behind ORCHESTRA_USE_SUBPROCESS_CLI):
 *   `parseCodexOutput` parses its JSONL event stream, and the
 *   `buildCodexMcpOverrides` family renders a project's MCP servers as
 *   `-c mcp_servers.*` TOML override flags.
 *
 * This module imports only leaves (types, project-store's MCP loader) and
 * NOTHING from llm-provider (one-way: llm-provider -> here), so no cycle.
 * Pure helpers are exported for unit testing — this surface was previously
 * untested (the §10 CLI/OAuth/SSE coverage gap).
 */

import type { McpServerConfig, ProjectMcpConfig } from "@/lib/types";
import { loadProjectMcpServers } from "@/lib/storage/project-mcp";

export const CODEX_BACKEND_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const DEFAULT_CODEX_INSTRUCTIONS = "You are Orchestra, an AI coding assistant.";
const CODEX_UNSUPPORTED_FIELDS = new Set(["max_output_tokens"]);

export function extractCodexUnsupportedParameter(errorBody: string): string | null {
  const match = errorBody.match(/unsupported parameter:\s*([a-zA-Z0-9_.-]+)/i);
  const candidate = match?.[1]?.trim();
  return candidate || null;
}

function toEnvRecord(value: Record<string, string> | undefined): Record<string, string> {
  if (!value) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    const key = k.trim();
    if (!key) continue;
    out[key] = String(v);
  }
  return out;
}

export function tomlQuote(value: string): string {
  let out = "\"";
  for (const char of value) {
    switch (char) {
      case "\\":
        out += "\\\\";
        break;
      case "\"":
        out += "\\\"";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\t":
        out += "\\t";
        break;
      default:
        out += char;
    }
  }
  out += "\"";
  return out;
}

export function stableCodexServerKey(id: string, used: Set<string>): string {
  let base = id
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!base) base = "mcp";
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let index = 2;
  while (used.has(`${base}_${index}`)) index += 1;
  const withIndex = `${base}_${index}`;
  used.add(withIndex);
  return withIndex;
}

function pushCodexStdioOverrides(overrides: string[], key: string, server: McpServerConfig): void {
  if (server.transport !== "stdio") return;
  const command = server.command?.trim();
  if (!command) return;

  overrides.push(`mcp_servers.${key}.command=${tomlQuote(command)}`);

  const args = (server.args || []).map((arg) => arg.trim()).filter(Boolean);
  if (args.length > 0) {
    overrides.push(
      `mcp_servers.${key}.args=[${args.map((arg) => tomlQuote(arg)).join(", ")}]`
    );
  }

  const env = toEnvRecord(server.env);
  const envEntries = Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${tomlQuote(name)} = ${tomlQuote(value)}`);
  if (envEntries.length > 0) {
    overrides.push(`mcp_servers.${key}.env={${envEntries.join(", ")}}`);
  }

  if (server.cwd?.trim()) {
    overrides.push(`mcp_servers.${key}.cwd=${tomlQuote(server.cwd.trim())}`);
  }
}

function pushCodexHttpOverrides(overrides: string[], key: string, server: McpServerConfig): void {
  if (server.transport !== "http") return;
  const url = server.url?.trim();
  if (!url) return;

  overrides.push(`mcp_servers.${key}.url=${tomlQuote(url)}`);

  const headers = toEnvRecord(server.headers);
  const headerEntries = Object.entries(headers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${tomlQuote(name)} = ${tomlQuote(value)}`);
  if (headerEntries.length > 0) {
    overrides.push(`mcp_servers.${key}.headers={${headerEntries.join(", ")}}`);
  }
}

export function buildCodexMcpOverrides(config: ProjectMcpConfig | null): string[] {
  if (!config?.servers?.length) return [];
  const overrides: string[] = [];
  const used = new Set<string>();

  for (const server of config.servers) {
    const key = stableCodexServerKey(server.id, used);
    pushCodexStdioOverrides(overrides, key, server);
    pushCodexHttpOverrides(overrides, key, server);
  }

  return overrides;
}

export async function resolveCodexMcpOverrides(projectId: string | undefined): Promise<string[]> {
  if (!projectId) return [];
  try {
    const config = await loadProjectMcpServers(projectId);
    return buildCodexMcpOverrides(config);
  } catch {
    return [];
  }
}

export function parseCodexOutput(rawStdout: string, rawStderr: string): string {
  const lines = rawStdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const texts: string[] = [];
  let explicitError = "";

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const eventType = typeof parsed.type === "string" ? parsed.type : "";

      if (eventType === "item.completed") {
        const item = parsed.item as Record<string, unknown> | undefined;
        const itemType = typeof item?.type === "string" ? item.type : "";
        const text = typeof item?.text === "string" ? item.text : "";
        if (itemType === "agent_message" && text.trim()) {
          texts.push(text.trim());
        }
      }

      if (eventType === "error") {
        const message =
          typeof parsed.message === "string"
            ? parsed.message
            : typeof parsed.error === "string"
              ? parsed.error
              : "";
        if (message.trim()) {
          explicitError = message.trim();
        }
      }
    } catch {
      // Ignore non-JSON lines.
    }
  }

  if (texts.length > 0) {
    return texts.join("\n\n");
  }

  if (explicitError) {
    return explicitError;
  }

  const fallback = `${rawStdout}\n${rawStderr}`.trim();
  return fallback || "Codex CLI returned no output.";
}

export function createCodexOauthFetch(credential: {
  accessToken: string;
  accountId?: string;
}) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    headers.set("authorization", `Bearer ${credential.accessToken}`);
    headers.set("accept", "application/json");
    if (credential.accountId) {
      headers.set("chatgpt-account-id", credential.accountId);
    }

    if (request.method.toUpperCase() !== "POST") {
      return fetch(new Request(request, { headers }));
    }

    const rawBody = await request.text();
    if (!rawBody.trim()) {
      return fetch(new Request(request, { headers }));
    }

    try {
      const parsed = JSON.parse(rawBody) as Record<string, unknown>;
      if (parsed.store !== false) {
        parsed.store = false;
      }
      if (typeof parsed.instructions !== "string" || !parsed.instructions.trim()) {
        parsed.instructions = DEFAULT_CODEX_INSTRUCTIONS;
      }
      for (const key of CODEX_UNSUPPORTED_FIELDS) {
        if (key in parsed) {
          delete parsed[key];
        }
      }
      let response = await fetch(
        new Request(request, {
          headers,
          body: JSON.stringify(parsed),
        })
      );
      if (response.status === 400) {
        const errorBody = await response.clone().text().catch(() => "");
        const unsupportedField = extractCodexUnsupportedParameter(errorBody);
        if (unsupportedField && unsupportedField in parsed) {
          delete parsed[unsupportedField];
          response = await fetch(
            new Request(request, {
              headers,
              body: JSON.stringify(parsed),
            })
          );
        }
      }
      return response;
    } catch {
      return fetch(
        new Request(request, {
          headers,
          body: rawBody,
        })
      );
    }
  };
}
