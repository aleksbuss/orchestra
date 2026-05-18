import type { AppSettings } from "@/lib/types";
import { combineWithTimeout } from "@/lib/util/abort-signal";

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

// Default cap on a single search HTTP roundtrip. Prevents a single hung
// upstream from blocking the agent indefinitely. PM #1 residual gap fix.
const SEARCH_FETCH_TIMEOUT_MS = 15_000;

/**
 * Search the web using configured provider.
 *
 * @param signal Optional AbortSignal from the caller (typically `abortSignal`
 *   passed by the AI SDK tool runtime). Always combined with an internal
 *   timeout — see PM #1 residual-gaps and § AbortSignal Propagation Contract.
 */
export async function searchWeb(
  query: string,
  limit: number,
  searchConfig: AppSettings["search"],
  signal?: AbortSignal
): Promise<string> {
  try {
    switch (searchConfig.provider) {
      case "searxng":
        return await searchSearxng(query, limit, searchConfig, signal);
      case "tavily":
        return await searchTavily(query, limit, searchConfig, signal);
      default:
        return "Search is not configured. Please set up a search provider in settings.";
    }
  } catch (error) {
    if ((error as Error)?.name === "AbortError") {
      // Disambiguate for the LLM: was this the parent (user/agent abort) or
      // our internal SEARCH_FETCH_TIMEOUT_MS firing? Without this the model
      // would treat both as "no results" and might retry, wasting tokens.
      if (signal?.aborted) {
        return "Search aborted by caller (user cancel or upstream stop).";
      }
      return `Search aborted: upstream did not respond within ${SEARCH_FETCH_TIMEOUT_MS / 1000}s. Try a more specific query or a different provider.`;
    }
    return `Search error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Search using SearXNG instance
 */
async function searchSearxng(
  query: string,
  limit: number,
  config: AppSettings["search"],
  signal?: AbortSignal
): Promise<string> {
  const baseUrl = config.baseUrl || "http://localhost:8080";
  const url = new URL("/search", baseUrl);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("categories", "general");

  const response = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
    signal: combineWithTimeout(signal, SEARCH_FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`SearXNG error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const results: SearchResult[] = (data.results || [])
    .slice(0, limit)
    .map((r: { title: string; url: string; content: string }) => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
    }));

  return formatResults(results, query);
}

/**
 * Search using Tavily API
 */
async function searchTavily(
  query: string,
  limit: number,
  config: AppSettings["search"],
  signal?: AbortSignal
): Promise<string> {
  // Env-vars win over the cleartext value persisted in settings.json
  // (see scripts/scrub-secrets.ts for migrating existing keys).
  const apiKey = process.env.TAVILY_API_KEY || config.apiKey;
  if (!apiKey) {
    return "Tavily API key not configured.";
  }

  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: limit,
      include_answer: true,
    }),
    signal: combineWithTimeout(signal, SEARCH_FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Tavily error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const results: SearchResult[] = (data.results || []).map(
    (r: { title: string; url: string; content: string }) => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
    })
  );

  let output = "";
  if (data.answer) {
    output += `**Quick Answer:** ${data.answer}\n\n`;
  }
  output += formatResults(results, query);
  return output;
}

function formatResults(results: SearchResult[], query: string): string {
  if (results.length === 0) {
    return `No search results found for: "${query}"`;
  }

  const formatted = results
    .map(
      (r, i) =>
        `[${i + 1}] **${r.title}**\n   URL: ${r.url}\n   ${r.snippet}`
    )
    .join("\n\n");

  return `Search results for "${query}":\n\n${formatted}`;
}
