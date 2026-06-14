/**
 * Structural CI gate for the AbortSignal Propagation Contract (PM #1 / #23,
 * and the QA-audit F-12/F-13 embeddings extension).
 *
 * PM #1 was a P0 outage from zombie streams; PM #23 found a `generateObject`
 * call that leaked for six months. CLAUDE.md documents a bracket-balanced
 * "pre-merge audit" grep over a HARDCODED list of files — but a fixed list
 * drifts: F-13 caught `blackboard.ts` calling the SDK outside the list, and a
 * fresh measurement for this gate caught three MORE unlisted callers
 * (`agent-response.ts`, `tournament-aggregator.ts`, `web-task.ts`). A list you
 * have to remember to extend is the exact control that fails.
 *
 * This test removes the list entirely: it scans EVERY non-test source file and
 * asserts that every AI-SDK call which streams/generates/embeds (and therefore
 * holds a cancellable network request) is passed an `abortSignal`. A new
 * callsite in a new file is covered automatically — there is nothing to keep
 * in sync.
 *
 * Mechanism is the same bracket-balanced scanner CLAUDE.md documents, ported
 * verbatim so the test and the doc can't disagree.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOTS = ["src/lib", "src/app"];

// Call-starts that open a cancellable AI-SDK request. `await embed(` is matched
// precisely so `embedTexts(` / `createEmbeddingModel(` don't trip it.
const CALL_START =
  /(await\s+generateText|await\s+generateObject|streamText|await\s+embedMany|await\s+embed)\s*\(/;

interface MissingCall {
  file: string;
  line: number;
}

/** Bracket-balanced scan — the exact logic from CLAUDE.md's PM #23 audit. */
function findCallsMissingAbortSignal(file: string): { total: number; missing: MissingCall[] } {
  const src = fs.readFileSync(file, "utf8").split("\n");
  let inCall = false;
  let depth = 0;
  let callStart = 0;
  let hasSignal = false;
  let total = 0;
  const missing: MissingCall[] = [];

  for (let i = 0; i < src.length; i++) {
    const line = src[i];
    if (!inCall && CALL_START.test(line)) {
      inCall = true;
      depth = 0;
      callStart = i + 1;
      hasSignal = false;
      total++;
    }
    if (inCall) {
      if (/abortSignal/.test(line)) hasSignal = true;
      for (const ch of line) {
        if (ch === "(") depth++;
        else if (ch === ")") {
          depth--;
          if (depth === 0) {
            if (!hasSignal) missing.push({ file, line: callStart });
            inCall = false;
            break;
          }
        }
      }
    }
  }
  return { total, missing };
}

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".test.tsx")
    ) {
      out.push(full);
    }
  }
  return out;
}

describe("PM #1/#23 — AbortSignal forwarded on every AI-SDK call (tree-wide)", () => {
  const files = ROOTS.flatMap((r) => (fs.existsSync(r) ? collectTsFiles(r) : []));
  const scanned = files.map(findCallsMissingAbortSignal);
  const totalCalls = scanned.reduce((n, s) => n + s.total, 0);
  const missing = scanned.flatMap((s) => s.missing);

  it("actually finds the SDK callsites (guards against a vacuous pass)", () => {
    // If the scanner silently matches nothing (broken regex/glob), the gate
    // below passes for the wrong reason — the F-13 false-confidence trap.
    // We have ~17 such calls across ~10 files today; floor well under that.
    expect(totalCalls).toBeGreaterThan(8);
  });

  it("passes abortSignal to every generate/stream/embed call", () => {
    expect(
      missing,
      "AI-SDK calls that don't forward abortSignal leak a cancellable network " +
        "request when the turn aborts (PM #1/#23). Add `abortSignal` to:\n" +
        missing.map((m) => `  ${m.file}:${m.line}`).join("\n")
    ).toEqual([]);
  });
});
