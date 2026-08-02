import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, statSync, readdirSync } from "fs";
import { fileURLToPath } from "url";

/**
 * CLAUDE.md size budget + line-count drift gate (§7 doc-as-code + §8 file-size discipline).
 *
 * WHY THIS EXISTS: a 2026-07 skeptical audit found the §8/§10 "god-file" line
 * counts had silently rotted — `tool.ts` was documented at 1919 LOC while the
 * real file was 2148 (+229), and `src/lib/mcp` coverage was cited as "~8%"
 * while the real figure was 69%. Nothing enforced those numbers, so they drifted
 * the moment a PM-fix touched the file. A stale CLAUDE.md actively misleads every
 * future LLM-assisted change (it is loaded into context as ground truth), so the
 * lesson from every other invariant in this repo applies: convert the hand-run
 * grep into a red build (see `abort-contract.test.ts`, `no-raw-process-env.test.ts`,
 * `frontend-invariants.test.ts`).
 *
 * WHAT IT GATES: only the structured `` `src/path/file.ts` (N LOC ...` `` claims in
 * the §10 decomposition plan — the drift-prone contract that names the exact
 * files over the §8 size caps. Coverage percentages are deliberately NOT gated
 * here: they need a full (~2min) coverage run, jitter run-to-run, and are already
 * loosely protected by the per-module floors in `vitest.config.ts`. This gate is
 * cheap (a `wc -l` per named file) and needs no coverage pass.
 *
 * TOLERANCE (deliberate, not brittle): a claim passes when the real line count is
 * within `max(50 lines, 5% of the claim)` of the documented number. That band
 * absorbs normal churn — a PM-fix that adds a dozen lines does NOT turn the build
 * red — while still catching the kind of gross, misleading drift the audit found
 * (tool.ts's +229 / +11.9% fails; a +27 / +1.5% edit does not). An exact-match gate
 * would be permanently red on these hottest files and would train everyone to
 * ignore it — the exact anti-pattern the repo calls out for the `audit:gate` and
 * `lint:strict` decisions. When you legitimately grow one of these files past the
 * band, update the number in CLAUDE.md §10 in the same PR (that is the point).
 */

const CLAUDE_MD = fileURLToPath(new URL("../CLAUDE.md", import.meta.url));
// Resolve against the URL OBJECT (not a `file://${string}` concat) so a repo
// checked out under a path with spaces / unicode still resolves correctly.
const REPO_ROOT_URL = new URL("../", import.meta.url);
const REFERENCES_DIR = fileURLToPath(new URL("../docs/references/", import.meta.url));

/**
 * Level 1 size budget (§ "How this document is organized").
 *
 * WHY: CLAUDE.md loads into EVERY session, so its size is a permanent tax on the
 * context the actual task needs — and it is over the instruction budget long
 * before it is over any byte limit (frontier models follow ~150-200 instructions
 * reliably; the harness's own system prompt already spends a chunk of that).
 * The file reached 169K chars carrying shipped-track narrative that duplicated
 * POST_MORTEMS.md, docs/ and git history. A hand-trim to 138K in 2026-07 regrew
 * past 150K within 15 commits BECAUSE NOTHING ENFORCED IT — same lesson as every
 * other invariant here: a control that depends on a human remembering is a
 * control that gets skipped. The detail lives in `docs/references/*.md` and is
 * loaded on demand via the trigger tables.
 *
 * The budget is deliberately well UNDER the harness limit: firing only at 150K
 * would let the file rot back to unusable first. When a genuinely new *rule*
 * needs Level 1 and pushes past the budget, move narrative out or raise this
 * number consciously in the same PR — do not let it drift silently.
 */
const LEVEL_1_BUDGET_CHARS = 40_000;

/**
 * Matches ONLY the structured §10 header form `` `src/lib/tools/tool.ts` (1919 LOC ``
 * (tilde optional: `` `...agent.ts` (~1614 LOC ``). This is a deliberate,
 * KNOWN-INCOMPLETE surface: a file whose size is mentioned in PROSE rather than
 * this `` `path` (N LOC `` header (e.g. "`moa.ts` is ~1510 after extracting …")
 * is NOT gated — it is silently not validated. That is acceptable because the
 * §10 headers are the drift-prone contract; if you want a prose-mentioned file
 * gated, give it a `` `path` (N LOC `` header. Do NOT read a green run as "every
 * line count in CLAUDE.md is current" — only the header-form ones are.
 */
const LOC_CLAIM = /`(src\/[^`]+\.tsx?)`\s*\(~?(\d+)\s*LOC/g;

interface Claim {
  file: string;
  claimed: number;
}

function parseLocClaims(doc: string): Claim[] {
  const claims: Claim[] = [];
  for (const m of doc.matchAll(LOC_CLAIM)) {
    claims.push({ file: m[1], claimed: Number(m[2]) });
  }
  return claims;
}

function realLineCount(absPath: string): number {
  // Match `wc -l` semantics closely enough for a drift check: count newlines.
  // A trailing-newline-or-not off-by-one is far inside the tolerance band.
  const text = readFileSync(absPath, "utf8");
  if (text.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
  return lines;
}

function toleranceFor(claimed: number): number {
  return Math.max(50, Math.ceil(claimed * 0.05));
}

/**
 * The §10 decomposition plan moved to `docs/references/file-size-decomposition.md`
 * when CLAUDE.md was split into Level 1 / Level 2. Scan BOTH surfaces — every
 * Level 2 reference, not just that one file — so a LOC claim is gated wherever it
 * is written and moving a section between files can never silently un-gate it.
 */
function docSurfaces(): string {
  const parts = [readFileSync(CLAUDE_MD, "utf8")];
  if (existsSync(REFERENCES_DIR)) {
    for (const name of readdirSync(REFERENCES_DIR)) {
      if (name.endsWith(".md")) {
        parts.push(readFileSync(fileURLToPath(new URL(name, new URL("../docs/references/", import.meta.url))), "utf8"));
      }
    }
  }
  return parts.join("\n");
}

describe("CLAUDE.md size budget", () => {
  it(`Level 1 stays under the ${LEVEL_1_BUDGET_CHARS.toLocaleString()}-char budget`, () => {
    const size = readFileSync(CLAUDE_MD, "utf8").length;
    expect(
      size <= LEVEL_1_BUDGET_CHARS,
      `CLAUDE.md is ${size.toLocaleString()} chars, over the ${LEVEL_1_BUDGET_CHARS.toLocaleString()} Level 1 budget ` +
        `(+${(size - LEVEL_1_BUDGET_CHARS).toLocaleString()}). CLAUDE.md loads into EVERY session. ` +
        `Move rationale, per-PM narrative, shipped-track history or edge cases into docs/references/*.md ` +
        `and leave a trigger-table row pointing at it — see "How this document is organized" in CLAUDE.md.`
    ).toBe(true);
  });

  it("every docs/references file linked from CLAUDE.md exists", () => {
    const doc = readFileSync(CLAUDE_MD, "utf8");
    const linked = [...doc.matchAll(/docs\/references\/([a-z0-9-]+\.md)/g)].map((m) => m[1]);
    expect(linked.length).toBeGreaterThanOrEqual(8);
    for (const name of new Set(linked)) {
      const abs = fileURLToPath(new URL(`../docs/references/${name}`, import.meta.url));
      expect(existsSync(abs), `CLAUDE.md links docs/references/${name} but it does not exist`).toBe(true);
    }
  });
});

describe("CLAUDE.md line-count drift gate", () => {
  const doc = docSurfaces();
  const claims = parseLocClaims(doc);

  it("finds the §10 god-file LOC claims to validate (guards against a broken parser)", () => {
    // If this drops to 0, the doc format changed and the gate silently stopped
    // protecting anything — fail loudly rather than pass vacuously.
    expect(claims.length).toBeGreaterThanOrEqual(4);
  });

  it.each(
    parseLocClaims(docSurfaces()).map((c) => [c.file, c.claimed] as const)
  )("`%s` documented at %i LOC matches the real file within tolerance", (file, claimed) => {
    const abs = fileURLToPath(new URL(file, REPO_ROOT_URL));
    expect(
      existsSync(abs),
      `The §10 decomposition plan references "${file}" but the file does not exist. ` +
        `Update or remove the LOC claim.`
    ).toBe(true);
    expect(statSync(abs).isFile(), `"${file}" is not a regular file`).toBe(true);

    const real = realLineCount(abs);
    const tol = toleranceFor(claimed);
    const drift = real - claimed;
    expect(
      Math.abs(drift) <= tol,
      `The docs say "${file}" is ${claimed} LOC; real is ${real} ` +
        `(drift ${drift >= 0 ? "+" : ""}${drift}, tolerance ±${tol}). ` +
        `Update the number in docs/references/file-size-decomposition.md (doc-as-code, Critical Rule §7).`
    ).toBe(true);
  });
});
