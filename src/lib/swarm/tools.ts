import { tool } from "ai";
import { z } from "zod";
import type { SwarmRole } from "./types";

export function createCallAgentTool(
  onDelegate: (role: SwarmRole, taskDescription: string, context?: string) => Promise<string>
) {
  return tool({
    description: "Call a peer agent (coder, researcher, reviewer) to perform a dedicated subtask. You wait until they finish and return their result. Use this for peer-to-peer (P2P) routing.",
    inputSchema: z.object({
      role: z.enum(["coder", "researcher", "reviewer"] as const).describe("The specialized role of the peer agent."),
      taskDescription: z.string().describe("Clear, self-contained description of what the peer agent should do. Include all necessary details."),
      context: z.string().optional().describe("Optional constraints, code snippets, or notes the peer agent needs."),
    }),
    execute: async ({ role, taskDescription, context }) => {
      try {
        const result = await onDelegate(role, taskDescription, context);
        return result;
      } catch (err) {
        return `Sub-agent error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}
