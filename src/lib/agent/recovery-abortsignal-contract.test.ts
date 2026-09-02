/**
 * PM #121 — CI gate: the recovery/failover ladder must never receive the raw
 * `req.signal`-derived `abortSignal`.
 *
 * WHY THIS EXISTS AS A SCAN. Verified from `node_modules/ai/dist/index.mjs`
 * (v6 stream read loop): `isAbortError2(error) && abortSignal.aborted` routes
 * to the stream's own `abort()` path — firing `onAbort`, closing the
 * controller — and ONLY a non-abort error reaches `controller.error()`, the
 * thing that feeds `onError`. So by construction, `agent.ts`'s `onError`
 * handler and `agent-response.ts`'s "no answer was delivered" branch can only
 * run once a genuine client abort has already been ruled out for this turn —
 * `onAbort` would have claimed it instead.
 *
 * Yet `req.signal` was observed LIVE to flip `aborted: true` ~42ms into a
 * recovery attempt that started from exactly that `onError` handler — with no
 * user action, caught by PM #120's own new logging. Most likely cause: the
 * primary stream's own error teardown touches the same signal. Threading that
 * contaminated signal into `recoverPrimaryStreamFailure` /
 * `generateFinalAnswerWithFailover` killed the substitute cascade on nearly
 * every occurrence — the ladder's five internal abort gates (correctly
 * designed: "don't waste a substitute call on an abandoned turn") were firing
 * on a signal that, in this window, does not mean what they assumed.
 *
 * The fix is at the two call sites, not the ladder's internals: stop passing
 * a live signal in. `callDeadlineSignal(undefined)` / `abortableSleep` still
 * apply a real `AbortSignal.timeout(...)` bound regardless — this does not
 * make any call unbounded (see `call-deadline-contract.test.ts`).
 *
 * If a genuine client-disconnect source for the recovery window is ever
 * built (a heartbeat, a dedicated app-owned `AbortController` NOT derived
 * from `req.signal` post-stream-start), wire it here deliberately and update
 * this gate — don't silently restore `options.abortSignal` / `abortSignal`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const AGENT_DIR = path.join(process.cwd(), "src/lib/agent");

/** Blank out comments so prose mentioning these identifiers can't skew the scan. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (c) => c.replace(/[^\n]/g, " "));
}

/** Walk from an opening `{` (already consumed) to its matching `}`. */
function readBalancedBlock(src: string, openBraceIndex: number): string {
  let depth = 1;
  let i = openBraceIndex + 1;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) break;
  }
  return src.slice(openBraceIndex, i + 1);
}

function findCallBlock(fileName: string, calleeName: string): string {
  const raw = readFileSync(path.join(AGENT_DIR, fileName), "utf-8");
  const src = stripComments(raw);
  const calleeRe = new RegExp(`\\b${calleeName}\\s*\\(\\s*\\{`);
  const m = calleeRe.exec(src);
  if (!m) throw new Error(`${calleeName}( ... ) not found in ${fileName} — scan is broken`);
  const openBrace = m.index + m[0].length - 1;
  return readBalancedBlock(src, openBrace);
}

describe("PM #121 — recovery ladder never receives the raw req.signal", () => {
  it("agent.ts's onError call to recoverPrimaryStreamFailure passes abortSignal: undefined", () => {
    const block = findCallBlock("agent.ts", "recoverPrimaryStreamFailure");
    expect(block).toContain("abortSignal: undefined");
    expect(block).not.toMatch(/abortSignal:\s*options\.abortSignal/);
  });

  it("agent-response.ts's forced-final-answer call to generateFinalAnswerWithFailover passes abortSignal: undefined", () => {
    const block = findCallBlock("agent-response.ts", "generateFinalAnswerWithFailover");
    expect(block).toContain("abortSignal: undefined");
    // The bare shorthand (`abortSignal,`) would silently re-thread the raw
    // param — assert it's gone, not just that `undefined` appears somewhere.
    expect(block).not.toMatch(/abortSignal\s*,/);
  });
});
