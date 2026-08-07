/**
 * PM #98 — CI gate: every provider factory in `llm-provider.ts` gets a bounded
 * `fetch`.
 *
 * WHY A SOURCE SCAN AND NOT A BEHAVIOURAL TEST. The bound is applied at SEVEN
 * separate construction sites, because OpenRouter, Codex and Gemini-OAuth each
 * build their provider by hand instead of going through
 * `createOpenAICompatibleChatModel` (they need bespoke headers or an OAuth
 * fetch). A behavioural test would have to instantiate every provider with real
 * credentials to notice a missing one. A scan notices the eighth site the day
 * it is added — which is the actual failure mode here, since the site that hung
 * for seven minutes was precisely the one that had opted out of the shared
 * helper.
 *
 * If you add a provider: pass `fetch`. If it needs its own fetch (OAuth), wrap
 * or compose rather than dropping the bound.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const SOURCE = readFileSync(
  path.join(process.cwd(), "src/lib/providers/llm-provider.ts"),
  "utf-8"
);

const FACTORIES = ["createOpenAI", "createAnthropic", "createGoogleGenerativeAI"] as const;

/** Extract the balanced `{...}` config object for each factory call site. */
function configObjects(source: string, factory: string): string[] {
  const out: string[] = [];
  const needle = `${factory}({`;
  let from = 0;
  for (;;) {
    const at = source.indexOf(needle, from);
    if (at === -1) return out;
    let depth = 0;
    let i = at + needle.length - 1;
    for (; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}" && --depth === 0) break;
    }
    out.push(source.slice(at, i + 1));
    from = i + 1;
  }
}

describe("llm-provider — every provider factory has a bounded fetch", () => {
  it.each(FACTORIES)("%s call sites all pass a `fetch`", (factory) => {
    const sites = configObjects(SOURCE, factory);
    expect(sites.length).toBeGreaterThan(0); // the scan itself must not rot
    for (const site of sites) {
      expect(site).toMatch(/\bfetch:/);
    }
  });

  it("covers the OpenRouter site specifically — the one PM #98 hung on", () => {
    const openRouterSite = configObjects(SOURCE, "createOpenAI").find((s) =>
      s.includes('name: "openrouter"')
    );
    expect(openRouterSite).toBeDefined();
    expect(openRouterSite).toContain("createHeadersTimeoutFetch");
  });

  it("uses the shared helper rather than a hand-rolled AbortSignal.timeout", () => {
    // `AbortSignal.timeout` on a streaming fetch destroys the response BODY,
    // truncating every generation longer than the budget. The helper exists so
    // that trap is written down in one place instead of re-discovered.
    expect(SOURCE).not.toMatch(/fetch:\s*[^,\n]*AbortSignal\.timeout/);
  });
});
