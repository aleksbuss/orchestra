import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import type { AgentContext } from "@/lib/agent/types";
import type { McpServerConfig } from "@/lib/types";
import {
  upsertProjectMcpServer,
  deleteProjectMcpServer,
} from "@/lib/storage/project-mcp";

/**
 * Project MCP server-config tool family (project-scoped): CRUD on the
 * project's `.meta/mcp/servers.json`. Registered only when the context has
 * a projectId. NOTE: agent-writable MCP configs are why the PM #27 boundary
 * contracts exist — transport URLs go through `assertSafeOutboundUrl` at
 * connect time in `src/lib/mcp/client.ts`, not here. Extracted verbatim
 * from `tool.ts` (§10 decomposition, PR 2).
 */
export function createProjectMcpConfigTools(context: AgentContext): ToolSet {
  if (!context.projectId) {
    return {};
  }

  const tools: ToolSet = {};

  tools.upsert_mcp_server = tool({
    description:
      "Create or update one MCP server entry in this project's .meta/mcp/servers.json. Use this when the user asks to add/edit MCP server settings.",
    inputSchema: z
      .object({
        id: z
          .string()
          .describe("MCP server id (for example firecrawl-mcp or my-http-server)."),
        transport: z
          .enum(["stdio", "http"])
          .describe("Transport type: stdio or http."),
        command: z
          .string()
          .nullable()
          .optional()
          .describe("Required for stdio transport: executable command."),
        args: z
          .array(z.string())
          .nullable()
          .optional()
          .describe("Optional command arguments for stdio transport."),
        env: z
          .record(z.string(), z.string())
          .nullable()
          .optional()
          .describe("Optional environment variables for stdio transport."),
        cwd: z
          .string()
          .nullable()
          .optional()
          .describe("Optional working directory for stdio transport."),
        url: z
          .string()
          .nullable()
          .optional()
          .describe("Required for http transport: MCP endpoint URL."),
        headers: z
          .record(z.string(), z.string())
          .nullable()
          .optional()
          .describe("Optional HTTP headers for http transport."),
      })
      .superRefine((value, ctx) => {
        if (value.transport === "stdio" && !(value.command ?? "").trim()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "command is required when transport is stdio.",
            path: ["command"],
          });
        }
        if (value.transport === "http" && !(value.url ?? "").trim()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "url is required when transport is http.",
            path: ["url"],
          });
        }
      }),
    execute: async (payload) => {
      const server: McpServerConfig =
        payload.transport === "http"
          ? {
              id: payload.id,
              transport: "http",
              url: payload.url ?? "",
              headers: payload.headers ?? undefined,
            }
          : {
              id: payload.id,
              transport: "stdio",
              command: payload.command ?? "",
              args: payload.args ?? undefined,
              env: payload.env ?? undefined,
              cwd: payload.cwd ?? undefined,
            };
      const result = await upsertProjectMcpServer(
        context.projectId!,
        server
      );
      if (result.success) {
        return `MCP server "${payload.id}" ${result.action} in ${result.filePath}.`;
      }
      return `Failed to upsert MCP server: ${result.error}`;
    },
  });

  tools.delete_mcp_server = tool({
    description:
      "Delete one MCP server entry from this project's .meta/mcp/servers.json.",
    inputSchema: z.object({
      server_id: z.string().describe("Exact MCP server id to delete."),
    }),
    execute: async ({ server_id }) => {
      const result = await deleteProjectMcpServer(context.projectId!, server_id);
      if (result.success) {
        return `MCP server "${server_id}" deleted from ${result.filePath}.`;
      }
      return `Failed to delete MCP server: ${result.error}`;
    },
  });

  return tools;
}
