#!/usr/bin/env node
/**
 * Single source of truth for the README "tests" badge count (QA audit F-04).
 *
 * The test count used to be hand-edited in four places; over one audit session
 * it drifted six times because every test-adding PR had to remember to bump it.
 * Prose mentions are now number-free; the badge is the only place a number
 * lives, and THIS script derives it from vitest's own total instead of a human
 * counting `it(` blocks (which misses `.each`, skips, and dynamic tests).
 *
 * Usage:
 *   npm run badge:sync            # run the suite, rewrite the badge if changed
 *   npm run badge:sync -- --check # CI-friendly: exit 1 if the badge is stale
 *                                  # (prints the command to fix it; never edits)
 *
 * It runs the full suite (~1 min). That's deliberate: the badge should only
 * ever claim a number the suite actually produces, so we count what passes.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const README = "README.md";
const BADGE_RE = /(tests-)(\d[\d,]*)(%20passing)/;
const checkOnly = process.argv.includes("--check");

const outFile = path.join(os.tmpdir(), `vitest-badge-${Date.now()}.json`);

console.error("› Counting tests via the full vitest run (~1 min)…");
try {
  execFileSync(
    "npx",
    ["vitest", "run", "--reporter=json", `--outputFile=${outFile}`],
    { stdio: ["ignore", "ignore", "inherit"] }
  );
} catch {
  // vitest exits non-zero on any failure. A red suite means the badge would
  // lie about "passing", so refuse to sync until the suite is green.
  console.error("✗ Suite is not green — fix the failing tests before syncing.");
  process.exit(1);
}

let total;
try {
  total = JSON.parse(readFileSync(outFile, "utf8")).numTotalTests;
} catch {
  console.error(`✗ Could not read the vitest JSON report at ${outFile}.`);
  process.exit(1);
}
if (!Number.isInteger(total) || total <= 0) {
  console.error(`✗ vitest reported an implausible test total: ${String(total)}`);
  process.exit(1);
}

const src = readFileSync(README, "utf8");
const match = src.match(BADGE_RE);
if (!match) {
  console.error(`✗ Could not find the tests badge (\`${BADGE_RE}\`) in ${README}.`);
  process.exit(1);
}
const current = Number(match[2].replace(/,/g, ""));

if (current === total) {
  console.error(`✓ Badge already current: ${total} tests.`);
  process.exit(0);
}

if (checkOnly) {
  console.error(
    `✗ Badge is stale: README says ${current}, suite has ${total}. ` +
      `Run \`npm run badge:sync\` to fix.`
  );
  process.exit(1);
}

writeFileSync(README, src.replace(BADGE_RE, `$1${total}$3`));
console.error(`✓ Badge synced: ${current} → ${total} tests.`);
