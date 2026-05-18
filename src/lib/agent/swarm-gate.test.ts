/**
 * Regression guard for POST_MORTEMS.md PM #9.
 *
 * The bug: an earlier `queryNeedsMoA(msg)` regex acted as a second gate on
 * the entry path. With it, `if (swarmEnabled !== false && queryNeedsMoA(msg))`
 * silently overrode the UI toggle for messages whose verbs weren't on a
 * hard-coded whitelist. Users enabling "Swarm" got single-agent answers and
 * couldn't tell the difference.
 *
 * The fix: the UI toggle (`swarmEnabled`) is the single source of truth at
 * the entry path. The Router *inside* `runMoAEnsemble` may still decide
 * `requiresSwarm: false` for trivial prompts — that's an internal MoA
 * optimization, not an entry-path override.
 *
 * This test is a source-level invariant rather than a behavioural test
 * because mocking `runAgent` (~1700 LOC, dozens of dependencies) is
 * disproportionate for guarding a one-line gate. Source-level checks are
 * imperfect (false negatives are possible) but they catch the exact shape
 * of the historical regression cheaply.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const AGENT_SRC_RAW = fs.readFileSync(
  path.resolve(__dirname, "agent.ts"),
  "utf-8"
);

/**
 * Naive comment stripper — handles `//` and block `/* * /` comments. Does NOT
 * handle the (extremely rare) case of those tokens inside string literals,
 * which is acceptable for the patterns we're searching for. We MUST strip
 * comments before our regex tests because the file legitimately documents
 * the forbidden names in its history-note comments.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

const AGENT_CODE = stripComments(AGENT_SRC_RAW);

describe("PM #9 — swarmEnabled is the single source of truth on the entry path", () => {
  it("agent.ts does not reintroduce a queryNeedsMoA function or call", () => {
    // The original regression's literal name. Catches a copy-paste revert.
    expect(AGENT_CODE).not.toMatch(/queryNeedsMoA/);
  });

  it("agent.ts does not introduce a renamed twin of queryNeedsMoA", () => {
    // Common renames a future refactor might reach for.
    const forbiddenNames = [
      /queryRequiresMoA/,
      /queryNeedsSwarm/,
      /shouldRunMoA(?!Ensemble)/, // "shouldRunMoAEnsemble" would be a fine extracted helper
      /messageNeedsSwarm/,
      /isMoARequired/,
    ];
    for (const pattern of forbiddenNames) {
      expect(AGENT_CODE).not.toMatch(pattern);
    }
  });

  it("runMoAEnsemble is invoked from exactly one place in agent.ts", () => {
    // Multiple invocation sites would mean multiple entry-path policies — the
    // exact shape of the original PM #9 bug, just spread across more lines.
    const matches = AGENT_CODE.match(/\brunMoAEnsemble\s*\(/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("the runMoAEnsemble call is preceded by the unconditional swarmEnabled gate", () => {
    // We slice the 800 chars before the runMoAEnsemble call — generous window
    // to account for prompt-string preamble and a try/catch wrapper. The
    // closest preceding `if (...)` clause must be the canonical gate, not a
    // compound condition involving anything other than `options.swarmEnabled`.
    const callIndex = AGENT_CODE.indexOf("runMoAEnsemble(");
    expect(callIndex).toBeGreaterThan(0);
    const preamble = AGENT_CODE.slice(Math.max(0, callIndex - 800), callIndex);

    // Find the LAST `if (` before the call.
    const ifMatches = [...preamble.matchAll(/if\s*\(([^)]+)\)/g)];
    expect(ifMatches.length).toBeGreaterThan(0);
    const closestIfCondition = ifMatches[ifMatches.length - 1][1];

    // The condition must mention swarmEnabled and must not contain a `&&`
    // joining swarmEnabled to another predicate (PM #9 shape).
    expect(closestIfCondition).toMatch(/swarmEnabled/);
    // Forbid compound gates of the form `swarmEnabled ... && <other>`.
    // `&&` joining sub-expressions WITHIN swarmEnabled (none currently exist)
    // would also flag — fine, since none should be needed.
    expect(closestIfCondition).not.toMatch(/&&/);
  });
});
