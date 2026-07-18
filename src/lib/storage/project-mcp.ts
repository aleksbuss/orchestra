/**
 * Project MCP server config storage (§8 decomposition — extracted from
 * `project-store.ts`). Load / upsert / delete / save the per-project
 * `.meta/mcp/servers.json` (both Cursor `mcpServers` and legacy `servers`
 * shapes). The MCP path helpers (`getProjectMcpDir` / `getProjectMcpServersPath`)
 * + `ensureDir` are imported one-way from `project-store` — project-store does
 * NOT import this module (callers were rewired to import the MCP functions from
 * here), so there is no cycle. Security: the audited-route `assertPathInside`
 * push-downs stay at the route layer (PM #16/#27).
 */
import fs from "fs/promises";
import { safeWriteFile } from "./fs-utils";
import {
  getProjectMcpDir,
  getProjectMcpServersPath,
  ensureDir,
} from "./project-store";
import { McpServersFileCursorSchema } from "@/lib/types";
import type {
  ProjectMcpConfig,
  McpServerConfig,
  McpServersFileCursor,
} from "@/lib/types";

/**
 * Normalize Cursor-style mcpServers object to ProjectMcpConfig.
 * Entry with `url` → http; otherwise `command` → stdio.
 */
function normalizeMcpServersFile(parsed: unknown): ProjectMcpConfig | null {
  // Cursor format: { mcpServers: { [id]: { command, args?, env? } | { url, headers? } } }
  const cursor = parsed as McpServersFileCursor;
  if (cursor?.mcpServers && typeof cursor.mcpServers === "object") {
    const servers: McpServerConfig[] = [];
    for (const [id, val] of Object.entries(cursor.mcpServers)) {
      if (!val || typeof val !== "object") continue;
      if ("url" in val && typeof val.url === "string") {
        servers.push({
          id,
          transport: "http",
          url: val.url,
          headers: val.headers,
        });
      } else if ("command" in val && typeof val.command === "string") {
        servers.push({
          id,
          transport: "stdio",
          command: val.command,
          args: Array.isArray(val.args) ? val.args : [],
          env: val.env,
          cwd: val.cwd,
        });
      }
    }
    if (servers.length === 0) return null;
    return { servers };
  }
  // Legacy format: { servers: [ { id, transport, ... } ] }
  const legacy = parsed as ProjectMcpConfig;
  if (Array.isArray(legacy?.servers) && legacy.servers.every((s) => s?.id && s?.transport)) {
    return legacy;
  }
  return null;
}

/**
 * Load MCP servers config for a project. Returns null if file missing or invalid.
 * Supports Cursor format (mcpServers object) and legacy format (servers array).
 */
export async function loadProjectMcpServers(
  projectId: string
): Promise<ProjectMcpConfig | null> {
  const filePath = getProjectMcpServersPath(projectId);
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(content) as unknown;
    return normalizeMcpServersFile(parsed);
  } catch {
    return null;
  }
}

function normalizeStringRecord(
  value: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!value) return undefined;
  const normalized: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    const key = k.trim();
    if (!key) continue;
    normalized[key] = String(v);
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function toCursorMcpServersFile(config: ProjectMcpConfig): McpServersFileCursor {
  const mcpServers: McpServersFileCursor["mcpServers"] = {};
  for (const server of config.servers) {
    if (server.transport === "http") {
      const headers = normalizeStringRecord(server.headers);
      mcpServers[server.id] = headers
        ? { url: server.url, headers }
        : { url: server.url };
      continue;
    }

    const args = Array.isArray(server.args)
      ? server.args.filter((a): a is string => typeof a === "string")
      : undefined;
    const env = normalizeStringRecord(server.env);
    const stdioEntry: {
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
    } = { command: server.command };
    if (args && args.length > 0) stdioEntry.args = args;
    if (env) stdioEntry.env = env;
    if (server.cwd?.trim()) stdioEntry.cwd = server.cwd.trim();
    mcpServers[server.id] = stdioEntry;
  }
  return { mcpServers };
}

async function loadProjectMcpServersFileCursor(
  projectId: string
): Promise<McpServersFileCursor> {
  const filePath = getProjectMcpServersPath(projectId);
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(content);
    
    // Validate strict Cursor shape
    const validatedCursor = McpServersFileCursorSchema.safeParse(parsed);
    if (validatedCursor.success) {
      return validatedCursor.data as McpServersFileCursor;
    }

    // Fallback: try legacy normalization if parse failed
    const normalized = normalizeMcpServersFile(parsed);
    if (normalized) return toCursorMcpServersFile(normalized);
    return { mcpServers: {} };
  } catch {
    return { mcpServers: {} };
  }
}

function validateMcpServerId(value: string): string | null {
  const id = value.trim();
  if (!id) return "MCP server id is required.";
  if (id.length > 120) return "MCP server id must be at most 120 characters.";
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) {
    return "MCP server id may contain only letters, numbers, dots, underscores, and hyphens.";
  }
  return null;
}

export async function upsertProjectMcpServer(
  projectId: string,
  server: McpServerConfig
): Promise<
  | { success: true; filePath: string; action: "created" | "updated" }
  | { success: false; error: string }
> {
  const id = server.id.trim();
  const idErr = validateMcpServerId(id);
  if (idErr) return { success: false, error: idErr };

  const cursor = await loadProjectMcpServersFileCursor(projectId);
  const existed = Object.prototype.hasOwnProperty.call(cursor.mcpServers, id);

  if (server.transport === "http") {
    const url = server.url.trim();
    if (!url) return { success: false, error: "HTTP MCP server url is required." };
    const headers = normalizeStringRecord(server.headers);
    cursor.mcpServers[id] = headers ? { url, headers } : { url };
  } else {
    const command = server.command.trim();
    if (!command) {
      return { success: false, error: "STDIO MCP server command is required." };
    }
    const args = Array.isArray(server.args)
      ? server.args.map((a) => a.trim()).filter((a) => a.length > 0)
      : undefined;
    const env = normalizeStringRecord(server.env);
    const stdioEntry: {
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
    } = { command };
    if (args && args.length > 0) stdioEntry.args = args;
    if (env) stdioEntry.env = env;
    if (server.cwd?.trim()) stdioEntry.cwd = server.cwd.trim();
    cursor.mcpServers[id] = stdioEntry;
  }

  await ensureDir(getProjectMcpDir(projectId));
  const filePath = getProjectMcpServersPath(projectId);
  await safeWriteFile(filePath, JSON.stringify(cursor, null, 2));
  return { success: true, filePath, action: existed ? "updated" : "created" };
}

export async function deleteProjectMcpServer(
  projectId: string,
  serverId: string
): Promise<{ success: true; filePath: string } | { success: false; error: string }> {
  const id = serverId.trim();
  const idErr = validateMcpServerId(id);
  if (idErr) return { success: false, error: idErr };

  const cursor = await loadProjectMcpServersFileCursor(projectId);
  if (!Object.prototype.hasOwnProperty.call(cursor.mcpServers, id)) {
    return { success: false, error: `MCP server "${id}" not found.` };
  }

  delete cursor.mcpServers[id];
  await ensureDir(getProjectMcpDir(projectId));
  const filePath = getProjectMcpServersPath(projectId);
  await safeWriteFile(filePath, JSON.stringify(cursor, null, 2));
  return { success: true, filePath };
}

export async function saveProjectMcpServersContent(
  projectId: string,
  rawContent: string
): Promise<
  | {
      success: true;
      filePath: string;
      content: string;
      servers: McpServerConfig[];
    }
  | { success: false; error: string }
> {
  const trimmed = rawContent.trim();
  const defaultContent = JSON.stringify({ mcpServers: {} }, null, 2);
  const parseTarget = trimmed ? rawContent : defaultContent;

  let parsed: unknown;
  try {
    parsed = JSON.parse(parseTarget);
  } catch {
    return {
      success: false,
      error: "Invalid JSON. Provide a valid servers.json object.",
    };
  }

  // Check strict validity against Zod Schema
  const validatedCursor = McpServersFileCursorSchema.safeParse(parsed);
  
  const normalized = normalizeMcpServersFile(parsed);
  if (!normalized && !validatedCursor.success) {
    return {
      success: false,
      error:
        "Unsupported format. Use { \"mcpServers\": { ... } } (Cursor format) or { \"servers\": [ ... ] }.",
    };
  }

  const servers = normalized?.servers ?? [];
  for (const server of servers) {
    const idError = validateMcpServerId(server.id);
    if (idError) {
      return { success: false, error: `Invalid server id "${server.id}": ${idError}` };
    }

    if (server.transport === "http" && !server.url.trim()) {
      return { success: false, error: `HTTP server "${server.id}" requires a non-empty url.` };
    }
    if (server.transport === "stdio" && !server.command.trim()) {
      return {
        success: false,
        error: `STDIO server "${server.id}" requires a non-empty command.`,
      };
    }
  }

  const cursor = normalized ? toCursorMcpServersFile(normalized) : { mcpServers: {} };
  const content = JSON.stringify(cursor, null, 2);

  await ensureDir(getProjectMcpDir(projectId));
  const filePath = getProjectMcpServersPath(projectId);
  await safeWriteFile(filePath, content);

  return {
    success: true,
    filePath,
    content,
    servers,
  };
}
