#!/usr/bin/env node
/**
 * Single source of truth for the README count badges (QA audit F-04).
 *
 * The test count used to be hand-edited in four places; over one audit session
 * it drifted six times because every test-adding PR had to remember to bump it.
 * Prose mentions are now number-free; the badge is the only place a number
 * lives, and THIS script derives it from vitest's own total instead of a human
 * counting `it(` blocks (which misses `.each`, skips, and dynamic tests).
 *
 * The post-mortem count was NOT covered by that rule and drifted exactly the
 * same way: PM #98 landed and the README still said 97 — in the badge AND in
 * three prose claims, one of them the "engineering-led, every failure mode is
 * documented" paragraph, where a stale number is the most expensive kind.
 * So it is derived here too, and its prose mentions were de-numbered to match
 * the test badge's rule: ONE number, ONE place, derived not typed.
 *
 * Usage:
 *   npm run badge:sync            # sync both badges if they are stale
 *   npm run badge:sync -- --check # CI-friendly: exit 1 if either is stale
 *                                  # (prints the command to fix it; never edits)
 *
 * The post-mortem count is a file read. The test count runs the full suite
 * (~1 min) — that's deliberate: the badge should only ever claim a number the
 * suite actually produces, so we count what passes. The cheap check runs first
 * so a doc-only drift fails fast without paying for the suite.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const README = "README.md";
const POST_MORTEMS = "POST_MORTEMS.md";
const TESTS_BADGE_RE = /(tests-)(\d[\d,]*)(%20passing)/;
const PM_BADGE_RE = /(post--mortems-)(\d[\d,]*)(%20documented)/;
// Entry headings look like `## 98. Free Mode picked a tool-incapable brain…`.
// Anchored to line start so a `## 12.` inside a fenced block cannot inflate it.
const PM_ENTRY_RE = /^## \d+\./gm;

const checkOnly = process.argv.includes("--check");

/** Reads the badge's current number, or exits if the badge is missing. */
function readBadge(src, re, label) {
  const match = src.match(re);
  if (!match) {
    console.error(`✗ Could not find the ${label} badge (\`${re}\`) in ${README}.`);
    process.exit(1);
  }
  return Number(match[2].replace(/,/g, ""));
}

function countPostMortems() {
  const entries = readFileSync(POST_MORTEMS, "utf8").match(PM_ENTRY_RE);
  const n = entries ? entries.length : 0;
  if (n <= 0) {
    console.error(`✗ Found no \`## <n>.\` entries in ${POST_MORTEMS}.`);
    process.exit(1);
  }
  return n;
}

function countTests() {
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
  return total;
}

let src = readFileSync(README, "utf8");
const stale = [];

// Cheap check first — a doc-only drift should not cost a suite run.
const pmCurrent = readBadge(src, PM_BADGE_RE, "post-mortems");
const pmActual = countPostMortems();
if (pmCurrent !== pmActual) {
  stale.push({ label: "post-mortems", re: PM_BADGE_RE, current: pmCurrent, actual: pmActual });
} else {
  console.error(`✓ Badge already current: ${pmActual} post-mortems.`);
}

if (checkOnly && stale.length > 0) {
  // Fail before the ~1 min suite run — the fix command syncs both badges anyway.
  for (const s of stale) {
    console.error(`✗ ${s.label} badge is stale: README says ${s.current}, actual is ${s.actual}.`);
  }
  console.error("Run `npm run badge:sync` to fix.");
  process.exit(1);
}

const testsCurrent = readBadge(src, TESTS_BADGE_RE, "tests");
const testsActual = countTests();
if (testsCurrent !== testsActual) {
  stale.push({ label: "tests", re: TESTS_BADGE_RE, current: testsCurrent, actual: testsActual });
} else {
  console.error(`✓ Badge already current: ${testsActual} tests.`);
}

if (stale.length === 0) {
  process.exit(0);
}

if (checkOnly) {
  for (const s of stale) {
    console.error(`✗ ${s.label} badge is stale: README says ${s.current}, actual is ${s.actual}.`);
  }
  console.error("Run `npm run badge:sync` to fix.");
  process.exit(1);
}

for (const s of stale) {
  src = src.replace(s.re, `$1${s.actual}$3`);
  console.error(`✓ Badge synced: ${s.current} → ${s.actual} ${s.label}.`);
}
writeFileSync(README, src);
