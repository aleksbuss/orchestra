import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import type { AgentContext } from "@/lib/agent/types";
import { writeFactToBlackboard, searchBlackboardFacts } from "@/lib/memory/blackboard";

/**
 * Project Blackboard tool family (project-scoped): shared vector-memory
 * facts across the swarm. Registered only when the context has a projectId.
 * Extracted verbatim from `tool.ts` (§10 decomposition, PR 2).
 */
export function createBlackboardTools(context: AgentContext): ToolSet {
  if (!context.projectId) {
    return {};
  }

  const tools: ToolSet = {};

  tools.write_to_blackboard = tool({
    description: "Permanently store critical project-wide facts, architecture rules, or state into the vector memory. Use this to share knowledge across the LangGraph P2P swarm.",
    inputSchema: z.object({
      topic: z.string().describe("Topic or category of the factual knowledge (e.g. 'Project Architecture', 'Database Schema')."),
      content: z.string().describe("The dense, factual content to store."),
    }),
    execute: async ({ topic, content }, { abortSignal }) => {
      try {
        await writeFactToBlackboard({
          projectId: context.projectId!,
          topic,
          content,
          author: "agent",
          abortSignal,
        });
        return `Fact successfully written to Blackboard memory under topic '${topic}'.`;
      } catch (e: any) {
        return `Failed to write to Blackboard: ${e.message}`;
      }
    },
  });

  tools.search_blackboard = tool({
    description: "Perform semantic search across the project's vector memory (Blackboard) to find architectural rules, snippets, or facts stored by other peers.",
    inputSchema: z.object({
      query: z.string().describe("Semantic query string to search for."),
    }),
    execute: async ({ query }, { abortSignal }) => {
      try {
        const results = await searchBlackboardFacts({
          projectId: context.projectId!,
          query,
          topK: 5,
          abortSignal,
        });
        if (results.length === 0) return "No matching facts found in Blackboard.";
        return results.map(r => `[Topic: ${r.topic}] ${r.content} (Score: ${r.score.toFixed(2)})`).join("\n\n");
      } catch (e: any) {
        return `Failed to search Blackboard: ${e.message}`;
      }
    },
  });

  return tools;
}
