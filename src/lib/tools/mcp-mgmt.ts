import { tool } from "ai";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import type { AgentContext } from "@/lib/agent/types";
import { getProjectMcpServersPath, getProjectMcpDir } from "@/lib/storage/project-store";
import {
  readProjectMcpServersFileForMerge,
  quarantineProjectMcpServersFile,
} from "@/lib/storage/project-mcp";
import { safeWriteFile } from "@/lib/storage/fs-utils";
import type { McpServersFileCursor } from "@/lib/types";

/**
 * Creates a tool to inject default MCP servers into an existing project config.
 */
export function createMcpMgmtTools(context: AgentContext) {
  return {
    inject_mcp_defaults: tool({
      description: "Inject missing 'killer' MCP servers (Sequential Thinking, GitHub, SQLite) into the current project's configuration if they are not already present.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!context.projectId) {
          return "Error: No active project context. Please switch to a project first.";
        }

        const mcpPath = getProjectMcpServersPath(context.projectId);
        const mcpDir = getProjectMcpDir(context.projectId);

        try {
          await fs.mkdir(mcpDir, { recursive: true });

          // This tool MERGES into whatever is already on disk, so it must never
          // treat "I could not understand this file" as "this file is empty" —
          // that path silently replaced a whole working config with three
          // defaults and reported success (PM #126). Quarantine and refuse.
          const read = await readProjectMcpServersFileForMerge(context.projectId);

          if (read.state === "malformed") {
            const backupPath = await quarantineProjectMcpServersFile(context.projectId);
            const sizeBytes = Buffer.byteLength(read.raw, "utf-8");
            // PM #30 — a defensive catch arm with no log line is a bug, not a
            // feature. Corruption is news: leave something greppable behind.
            console.warn(
              `[mcp-mgmt] mcp_servers_file_malformed ${JSON.stringify({
                projectId: context.projectId,
                filePath: mcpPath,
                sizeBytes,
                reason: read.reason,
                backupPath,
              })}`
            );
            return (
              `Error: "${mcpPath}" exists but is not a usable MCP config — ${read.reason}. ` +
              `Nothing was written: refusing to overwrite ${sizeBytes} bytes of existing configuration. ` +
              `An exact copy is at "${backupPath}". Repair the original file (or delete it), then call this tool again.`
            );
          }

          // The intersection is the contract, not laziness: unknown top-level
          // keys (including a legacy `servers` array) survive the merge, so
          // they must be readable here without a cast.
          const config: McpServersFileCursor & Record<string, unknown> =
            read.state === "ok" ? read.config : { mcpServers: {} };

          const defaults: McpServersFileCursor["mcpServers"] = {
            "sequential-thinking": {
              command: "npx",
              args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
            },
            "sqlite-mcp": {
              command: "npx",
              args: ["-y", "@modelcontextprotocol/server-sqlite"],
              env: {
                SQLITE_DB_PATH: path.join(mcpDir, "project.db"),
              },
            },
            "github-mcp": {
              command: "npx",
              args: ["-y", "@modelcontextprotocol/server-github"],
              env: {
                GITHUB_PERSONAL_ACCESS_TOKEN: "",
              },
            },
          };

          let addedCount = 0;
          for (const [id, def] of Object.entries(defaults)) {
            if (!config.mcpServers[id]) {
              config.mcpServers[id] = def;
              addedCount++;
            }
          }

          // PM #127 audit — tool honesty. A legacy `{servers:[...]}` file is
          // preserved by the merge, but the loader prefers the `mcpServers`
          // branch, so those entries stay on disk and become invisible to the
          // app. Reporting a bare "Successfully added 3" while the operator's
          // own servers silently stop loading is the defect class this repo
          // already has a rule about — say it instead.
          const legacyEntries = Array.isArray(config.servers)
            ? (config.servers as unknown[]).length
            : 0;
          const legacyNotice =
            legacyEntries > 0
              ? ` WARNING: this file also has a legacy "servers" array with ${legacyEntries} entr${legacyEntries === 1 ? "y" : "ies"}. Orchestra loads the "mcpServers" object and IGNORES that array, so those servers are not active — migrate them into "mcpServers" or re-add them through the MCP dashboard.`
              : "";

          if (addedCount === 0) {
            return `Project already has all default 'killer' MCP servers configured.${legacyNotice}`;
          }

          await safeWriteFile(mcpPath, JSON.stringify(config, null, 2));
          return `Successfully added ${addedCount} default MCP servers to project "${context.projectId}". You may need to refresh the page or restart the agent to use them. Note: Some servers like GitHub require access tokens in the configuration file or Settings UI.${legacyNotice}`;
        } catch (err) {
          return `Error injecting defaults: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),
  };
}
