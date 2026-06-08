/**
 * PM #68 — isSearchUsable: web search is only "usable" when enabled, with a real
 * provider, AND (for key-requiring providers) a key present in env or settings.
 * Gating tool registration on this stops the agent being handed a `search_web`
 * that can only return "key not configured".
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isSearchUsable } from "./search-engine";
import type { AppSettings } from "@/lib/types";

const ORIGINAL_ENV = { ...process.env };
beforeEach(() => {
  delete process.env.TAVILY_API_KEY;
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function search(over: Partial<AppSettings["search"]>): AppSettings["search"] {
  return { enabled: true, provider: "tavily", ...over };
}

describe("PM #68 — isSearchUsable", () => {
  it("false when search is disabled", () => {
    expect(isSearchUsable(search({ enabled: false }))).toBe(false);
  });

  it("false when provider is 'none'", () => {
    expect(isSearchUsable(search({ provider: "none" }))).toBe(false);
  });

  it("searxng is usable with no key (self-hosted, no key required)", () => {
    expect(isSearchUsable(search({ provider: "searxng" }))).toBe(true);
  });

  it("tavily is usable when a settings key is present", () => {
    expect(isSearchUsable(search({ provider: "tavily", apiKey: "tvly-settings" }))).toBe(true);
  });

  it("tavily is usable when only the env key is present", () => {
    process.env.TAVILY_API_KEY = "tvly-env";
    expect(isSearchUsable(search({ provider: "tavily", apiKey: "" }))).toBe(true);
  });

  it("tavily is NOT usable when no key exists anywhere (the footgun PM #68 closes)", () => {
    expect(isSearchUsable(search({ provider: "tavily", apiKey: "" }))).toBe(false);
    expect(isSearchUsable(search({ provider: "tavily" }))).toBe(false);
  });
});
