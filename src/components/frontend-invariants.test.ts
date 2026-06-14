/**
 * Structural CI gate for the two frontend invariants CLAUDE.md §5 / §"Realtime
 * Resilience" currently enforce with a HAND-RUN grep:
 *
 *   1. Zustand subscriptions MUST be narrow — never `useAppStore()` with no
 *      selector. A no-arg call subscribes to the WHOLE store, so the component
 *      re-renders on EVERY `set()` (e.g. a chats-list update from an SSE tick),
 *      even for fields it never reads. `chat-panel` was the heavy offender.
 *   2. Single shared `EventSource` — never `new EventSource(...)` in a component.
 *      Browsers cap at 6 HTTP/1.1 connections per origin; one runaway component
 *      takes the realtime bus down (PM #5). All SSE goes through
 *      `useBackgroundSync`, which owns the one allowed construction.
 *
 * Both rules are documented as "pre-merge grep" — the exact control that gets
 * skipped (see F-20/F-21). This makes them a build failure instead. Same
 * tree-scan posture: no file list to drift.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = "src";

// The ONE module allowed to construct the shared EventSource.
const EVENTSOURCE_ALLOWLIST = new Set([
  path.normalize("src/hooks/use-background-sync.ts"),
]);

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(full));
    } else if (
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
      !entry.name.includes(".test.")
    ) {
      out.push(full);
    }
  }
  return out;
}

/** Scan files for a regex, returning `file:line  text` for every match (in code, not comments). */
function scan(files: string[], re: RegExp, skip?: (file: string) => boolean): string[] {
  const hits: string[] = [];
  for (const file of files) {
    if (skip?.(file)) continue;
    fs.readFileSync(file, "utf8")
      .split("\n")
      .forEach((rawLine, i) => {
        const code = rawLine.replace(/\/\/.*$/, ""); // drop trailing line comments
        if (re.test(code)) hits.push(`${file}:${i + 1}  ${rawLine.trim()}`);
      });
  }
  return hits;
}

describe("frontend structural invariants (CLAUDE.md §5 — was a hand-run grep)", () => {
  const files = collectFiles(ROOT);

  it("scans a real number of files (guards against a vacuous pass)", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("no `useAppStore()` with no selector (whole-store subscription → re-render on every set)", () => {
    const offenders = scan(files, /useAppStore\(\s*\)/);
    expect(
      offenders,
      "Select narrowly: `useAppStore(useShallow((s) => ({ … })))`. A no-arg " +
        "call re-renders the component on EVERY store mutation — a PM-class " +
        "perf bug (chat-panel re-rendering on each SSE chats tick). Offenders:\n" +
        offenders.join("\n")
    ).toEqual([]);
  });

  it("no `new EventSource` outside use-background-sync.ts (single shared connection)", () => {
    const offenders = scan(files, /new\s+EventSource\b/, (f) =>
      EVENTSOURCE_ALLOWLIST.has(path.normalize(f))
    );
    expect(
      offenders,
      "Route all SSE through `useBackgroundSync`. A rogue EventSource can " +
        "exhaust the browser's 6-connection-per-origin cap and take the " +
        "realtime bus down (PM #5). Offenders:\n" + offenders.join("\n")
    ).toEqual([]);
  });
});
