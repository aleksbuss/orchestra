import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import type { AgentContext } from "@/lib/agent/types";
import type { AppSettings } from "@/lib/types";
import { memorySave, memoryLoad, memoryDelete } from "@/lib/tools/memory-tools";
import { knowledgeQuery } from "@/lib/tools/knowledge-query";

/**
 * Persistent-memory + knowledge-base tool family. The memory trio is gated
 * on `settings.memory.enabled`; `knowledge_query` is always registered.
 * Extracted verbatim from `tool.ts` (§10 decomposition, PR 2).
 */
export function createMemoryKnowledgeTools(
  context: AgentContext,
  settings: AppSettings
): ToolSet {
  const tools: ToolSet = {};

  if (settings.memory.enabled) {
    tools.memory_save = tool({
      description:
        "Save important information to persistent memory. Use this to remember facts, user preferences, successful solutions, or any information that should persist across conversations.",
      inputSchema: z.object({
        text: z
          .string()
          .describe("The information to save to memory"),
        area: z
          .enum(["main", "fragments", "solutions", "instruments"])
          .default("main")
          .describe(
            "Memory area: 'main' for general facts, 'fragments' for conversation snippets, 'solutions' for successful solutions, 'instruments' for tool descriptions"
          ),
      }),
      execute: async ({ text, area }) => {
        return memorySave(text, area, context.memorySubdir, settings);
      },
    });

    tools.memory_load = tool({
      description:
        "Search persistent memory for relevant information. Use this to recall previously saved facts, solutions, or conversation context.",
      inputSchema: z.object({
        query: z
          .string()
          .describe("Search query to find relevant memories"),
        limit: z
          .number()
          .default(5)
          .describe("Maximum number of results to return"),
      }),
      execute: async ({ query, limit }) => {
        return memoryLoad(query, limit, context.memorySubdir, settings);
      },
    });

    tools.memory_delete = tool({
      description:
        "Delete specific entries from persistent memory.",
      inputSchema: z.object({
        query: z
          .string()
          .describe("Search query to find memories to delete"),
      }),
      execute: async ({ query }) => {
        return memoryDelete(query, context.memorySubdir, settings);
      },
    });
  }

  tools.knowledge_query = tool({
    description:
      "Search the knowledge base (uploaded documents) for relevant information using semantic search. Use this when you need information from the project's documents.",
    inputSchema: z.object({
      query: z
        .string()
        .describe("The search query to find relevant documents"),
      limit: z
        .number()
        .default(5)
        .describe("Maximum number of document chunks to return"),
    }),
    execute: async ({ query, limit }) => {
      return knowledgeQuery(query, limit, context.knowledgeSubdirs, settings);
    },
  });

  return tools;
}
