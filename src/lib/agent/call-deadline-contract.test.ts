/**
 * PM #98 — CI gate: every LLM call in the agent layer has a TIME BOUND, not
 * just an `abortSignal`.
 *
 * WHY THIS EXISTS AS A SCAN. `abort-contract.test.ts` already proves every
 * callsite passes an `abortSignal`, and it passed throughout PM #98 — because a
 * caller's signal answers "how does someone stop this", never "what ends this
 * if the provider never answers". The correct pattern
 * (`AbortSignal.any([caller, AbortSignal.timeout(N)])`) had existed in
 * `moa-proposers.ts` for months and was applied at 2 of 9 callsites. Nobody
 * noticed, because nothing was counting. This counts.
 *
 * If you add an LLM call: wrap the signal in `callDeadlineSignal(...)`, or use
 * a stream watchdog for a streaming call. If a call is legitimately unbounded,
 * it needs a comment saying why AND an entry here — not silence.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const AGENT_DIR = path.join(process.cwd(), "src/lib/agent");
const CALL_RE = /\b(generateText|generateObject|streamText)\s*\(\s*\{/g;

/** Anything that proves the call cannot run forever. */
const BOUND_MARKERS = [
  "callDeadlineSignal", // the shared helper
  "AbortSignal.timeout", // the original hand-rolled pattern
  "watchdog.signal", // the streaming watchdog
  "judgeSignal", // tournament-aggregator's pre-built bounded signal
  "proposerSignal", // moa-proposers' pre-built bounded signal
];

interface Callsite {
  file: string;
  line: number;
  body: string;
}

/** Every `generate*`/`stream*` call in the agent layer, with its options object. */
function findCallsites(): Callsite[] {
  const out: Callsite[] = [];
  for (const name of readdirSync(AGENT_DIR)) {
    if (!name.endsWith(".ts") || name.includes(".test.")) continue;
    // Blank out comments rather than deleting them, so line numbers survive.
    // Without this the scan reports doc-comment examples as real callsites —
    // `stream-watchdog.ts` documents the very call shape it bounds.
    const src = readFileSync(path.join(AGENT_DIR, name), "utf-8").replace(
      /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
      (c) => c.replace(/[^\n]/g, " ")
    );
    for (const m of src.matchAll(CALL_RE)) {
      // Walk to the matching brace of the options object.
      let depth = 0;
      let i = m.index! + m[0].length - 1;
      for (; i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}" && --depth === 0) break;
      }
      out.push({
        file: name,
        line: src.slice(0, m.index).split("\n").length,
        body: src.slice(m.index!, i + 1),
      });
    }
  }
  return out;
}

describe("PM #98 — every agent LLM call is time-bounded", () => {
  const callsites = findCallsites();

  it("finds callsites at all (guards against a broken parser)", () => {
    // If this ever drops to zero the gate is silently passing on nothing —
    // the exact failure mode of a scan nobody re-reads.
    expect(callsites.length).toBeGreaterThanOrEqual(7);
  });

  it("every callsite carries a bound", () => {
    const unbounded = callsites
      .filter((c) => !BOUND_MARKERS.some((marker) => c.body.includes(marker)))
      .map((c) => `${c.file}:${c.line}`);
    expect(unbounded, `Unbounded LLM calls:\n  ${unbounded.join("\n  ")}`).toEqual([]);
  });

  it("the streaming call listens on onAbort — the seam neither test suite covers", () => {
    // `stream-watchdog.live.test.ts` proves `onAbort` fires and `onError` does
    // not; `agent-abort.test.ts` proves `handleStreamAbort` does the right
    // thing. Neither proves they are WIRED together, and that wiring being
    // absent IS the round-1 defect. Deleting `onAbort` from `agent.ts` would
    // leave both suites green and the product silent again.
    const agent = readFileSync(path.join(AGENT_DIR, "agent.ts"), "utf-8");
    const streamCall = findCallsites().find(
      (c) => c.file === "agent.ts" && c.body.startsWith("streamText")
    );
    expect(streamCall).toBeDefined();
    expect(streamCall!.body).toContain("onAbort");
    expect(streamCall!.body).toContain("handleStreamAbort");
    expect(agent).toContain("createPartialTextBuffer");
  });

  it("the streaming call uses the watchdog, not a total-duration cap", () => {
    // A wall-clock cap on the interactive stream would kill legitimately long
    // agentic turns — `install-orchestrator` alone permits ten minutes.
    const streaming = callsites.filter((c) => c.body.startsWith("streamText"));
    expect(streaming.length).toBeGreaterThan(0);
    for (const c of streaming) {
      expect(c.body).toContain("watchdog.signal");
      expect(c.body).not.toContain("callDeadlineSignal");
    }
  });
});
