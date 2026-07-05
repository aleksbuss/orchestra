import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import type { AppSettings } from "@/lib/types";
import { searchWeb, isSearchUsable } from "@/lib/tools/search-engine";
import { createWebTaskTool } from "@/lib/tools/web-task";
import { createFetchWebpageTool } from "@/lib/tools/fetch-webpage";

/**
 * Web tool family: search_web (gated), web_task, fetch_webpage.
 * Extracted verbatim from `tool.ts` (§10 decomposition, PR 2).
 */
export function createWebTools(settings: AppSettings): ToolSet {
  const tools: ToolSet = {};

  // Search engine tool — PM #68: only register it when search is actually
  // usable (a key-requiring provider with no key offers a tool that can only
  // return "not configured").
  if (isSearchUsable(settings.search)) {
    tools.search_web = tool({
      description:
        "Search the internet for current information. Use this when you need up-to-date information, facts you're unsure about, or any web-based research.",
      inputSchema: z.object({
        query: z
          .string()
          .describe("The search query"),
        limit: z
          .number()
          .default(5)
          .describe("Maximum number of search results"),
      }),
      execute: async ({ query, limit }, { abortSignal }) => {
        return searchWeb(query, limit, settings.search, abortSignal);
      },
    });
  }

  // web_task — autonomous browser automation. Always registered; the heavy
  // dep (chromium) is only spawned when the tool is actually invoked, so
  // this is cheap to include. Sits next to search_web because the parent
  // agent picks one or the other for "fetch info from the web" tasks.
  tools.web_task = createWebTaskTool(settings);

  // fetch_webpage (PM #73) — lightweight raw-text read of a single URL for
  // source verification (SSRF-guarded, <UNTRUSTED_WEBPAGE>-wrapped). Always
  // registered; no key needed. The fast path between search_web (snippets) and
  // web_task (full browser). See src/lib/tools/fetch-webpage.ts.
  tools.fetch_webpage = createFetchWebpageTool();

  return tools;
}
