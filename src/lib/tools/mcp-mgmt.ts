import { tool } from "ai";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import type { AgentContext } from "@/lib/agent/types";
import { getProjectMcpServersPath, getProjectMcpDir } from "@/lib/storage/project-store";

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
          let config: any = { mcpServers: {} };
          
          try {
            const content = await fs.readFile(mcpPath, "utf-8");
            config = JSON.parse(content);
            if (!config.mcpServers) config.mcpServers = {};
          } catch {
            // file missing or invalid, start fresh
          }

          const defaults: any = {
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

          if (addedCount === 0) {
            return "Project already has all default 'killer' MCP servers configured.";
          }

          await fs.writeFile(mcpPath, JSON.stringify(config, null, 2), "utf-8");
          return `Successfully added ${addedCount} default MCP servers to project "${context.projectId}". You may need to refresh the page or restart the agent to use them. Note: Some servers like GitHub require access tokens in the configuration file or Settings UI.`;
        } catch (err) {
          return `Error injecting defaults: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),
  };
}
