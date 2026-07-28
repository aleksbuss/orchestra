#!/usr/bin/env node
/**
 * Does proposer DISAGREEMENT predict an INCORRECT answer?
 *
 * The escalation thesis this tests: run N cheap heterogeneous samples; if they
 * agree, ship the cheap answer; if they disagree, escalate to an expensive
 * model. That is only worth building if agreement actually carries information
 * about correctness. This script measures whether it does.
 *
 * Two questions, deliberately separated:
 *
 *   Q-A (the routing question): among runs where the drafts AGREED, how often
 *        was the cheap draft answer correct? A high number means agreement is a
 *        safe ship signal. This does NOT depend on the final answer at all.
 *   Q-B (the audit question):   does the disagreement distance separate runs
 *        where the FINAL answer was wrong from runs where it was right?
 *
 * Delivery failures are excluded from "wrong answer" counts. A proposer that
 * timed out did not give a wrong answer, it gave no answer — counting those as
 * errors would inflate any correlation with a signal that is itself computed
 * only over the surviving drafts.
 *
 * Usage: node scripts/disagreement-stats.mjs [labelSubstring]
 */
import fs from "fs";
import path from "path";

const DIR = path.join(process.cwd(), "evals", "results");
const LABEL = process.argv[2] ?? "disagree";

const files = fs.readdirSync(DIR).filter((f) => f.includes(LABEL) && f.endsWith(".json"));
if (!files.length) {
  console.error(`no results matching "${LABEL}" in ${DIR}`);
  process.exit(1);
}

const runs = [];
for (const f of files) {
  const suite = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
  for (const c of suite.cases) if (c.swarm) runs.push(c);
}
if (!runs.length) {
  console.error("results contain no swarm telemetry (was ORCHESTRA_EVAL_CAPTURE_SWARM=true set?)");
  process.exit(1);
}

/** A draft that never delivered: an error stub, not a wrong answer. */
const isDelivered = (d) => d.chars >= 60;

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (x) => `${(x * 100).toFixed(1)}%`;

console.log(`\nRuns with swarm telemetry: ${runs.length}  (from ${files.length} results file(s))\n`);

// ── Heterogeneity check — the run is meaningless if the "different" models
// silently collapsed onto one. Report it before any inference.
const distinct = runs.map((r) => r.swarm.distinctModels);
const modelCounts = new Map();
for (const r of runs) {
  for (const d of r.swarm.drafts) {
    const key = `${d.provider}/${d.model}`;
    modelCounts.set(key, (modelCounts.get(key) ?? 0) + 1);
  }
}
console.log("=== HETEROGENEITY (verified from resolved per-draft models) ===\n");
console.log(`distinct models per run: min ${Math.min(...distinct)}, max ${Math.max(...distinct)}, mean ${mean(distinct).toFixed(2)}`);
for (const [model, n] of [...modelCounts].sort((a, b) => b[1] - a[1])) {
  console.log(`   ${String(n).padStart(3)} drafts  ${model}`);
}

// ── Draft delivery + correctness
const allDrafts = runs.flatMap((r) => r.swarm.drafts);
const delivered = allDrafts.filter(isDelivered);
console.log(`\n=== DRAFTS ===\n`);
console.log(`total ${allDrafts.length} | delivered ${delivered.length} | undelivered ${allDrafts.length - delivered.length}`);
console.log(`delivered drafts correct: ${delivered.filter((d) => d.correct).length}/${delivered.length} (${pct(delivered.filter((d) => d.correct).length / (delivered.length || 1))})`);

// ── Q-A: is agreement a safe ship signal?
// Cheap-path answer = majority of delivered drafts (what a router would ship
// without calling the expensive model).
const rows = runs
  .filter((r) => r.swarm.disagreementRan)
  .map((r) => {
    const ds = r.swarm.drafts.filter(isDelivered);
    const correct = ds.filter((d) => d.correct).length;
    return {
      id: r.id,
      dist: r.swarm.disagreementMaxDistance,
      detected: r.swarm.disagreementDetected,
      draftsDelivered: ds.length,
      draftsCorrect: correct,
      allDraftsCorrect: ds.length > 0 && correct === ds.length,
      anyDraftWrong: ds.some((d) => !d.correct),
      majorityCorrect: ds.length > 0 && correct / ds.length > 0.5,
      finalCorrect: r.passed,
      finalScore: r.score,
    };
  });

if (!rows.length) {
  console.error("\nno run had a usable disagreement measurement (needs >= 2 delivered drafts)");
  process.exit(1);
}

// Split at the product's own threshold, and also at the median distance so the
// analysis is not hostage to a threshold that may never fire.
const threshold = runs[0].swarm.disagreementThreshold;
const sortedDist = [...rows.map((r) => r.dist)].sort((a, b) => a - b);
const median = sortedDist[Math.floor(sortedDist.length / 2)];

function table(label, predicate) {
  const hi = rows.filter((r) => predicate(r));
  const lo = rows.filter((r) => !predicate(r));
  const rate = (rs, key) => (rs.length ? rs.filter((r) => r[key]).length / rs.length : NaN);
  console.log(`\n-- split: ${label}`);
  console.log(`   disagreeing runs: ${hi.length} | agreeing runs: ${lo.length}`);
  for (const [key, name] of [
    ["majorityCorrect", "cheap-path (majority of drafts) correct"],
    ["allDraftsCorrect", "every delivered draft correct"],
    ["finalCorrect", "FINAL answer correct"],
  ]) {
    const a = rate(lo, key);
    const b = rate(hi, key);
    const lift = a - b;
    console.log(
      `   ${name.padEnd(40)} agree ${Number.isNaN(a) ? " n/a " : pct(a).padStart(6)} | disagree ${
        Number.isNaN(b) ? " n/a " : pct(b).padStart(6)
      } | gap ${Number.isNaN(lift) ? "n/a" : (lift >= 0 ? "+" : "") + pct(lift)}`
    );
  }
}

console.log(`\n=== Q-A / Q-B: does disagreement predict error? ===`);
table(`product threshold (distance > ${threshold})`, (r) => r.detected);
table(`median distance (> ${median.toFixed(3)})`, (r) => r.dist > median);

// ── Point-biserial correlation between distance and correctness.
function corr(xs, ys) {
  const n = xs.length;
  if (n < 3) return NaN;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  return dx === 0 || dy === 0 ? NaN : num / Math.sqrt(dx * dy);
}

const dists = rows.map((r) => r.dist);
console.log(`\n=== CORRELATION (distance vs correctness; negative = disagreement predicts error) ===\n`);
for (const [key, name] of [
  ["majorityCorrect", "cheap-path correct"],
  ["allDraftsCorrect", "all drafts correct"],
  ["finalCorrect", "final answer correct"],
]) {
  const ys = rows.map((r) => (r[key] ? 1 : 0));
  const r = corr(dists, ys);
  const variance = new Set(ys).size > 1;
  console.log(
    `   distance vs ${name.padEnd(22)} r = ${Number.isNaN(r) ? "n/a" : r.toFixed(3)}${
      variance ? "" : "   (NO VARIANCE — outcome constant, nothing to predict)"
    }`
  );
}

console.log(`\n=== PER-RUN ===\n`);
console.log("   dist   drafts  correct  final  case");
for (const r of [...rows].sort((a, b) => b.dist - a.dist)) {
  console.log(
    `   ${r.dist.toFixed(3)}  ${String(r.draftsDelivered).padStart(6)}  ${String(r.draftsCorrect).padStart(7)}  ${
      r.finalCorrect ? " OK  " : "WRONG"
    }  ${r.id}`
  );
}
console.log("");
