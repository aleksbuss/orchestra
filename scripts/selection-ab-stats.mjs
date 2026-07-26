#!/usr/bin/env node
/**
 * Analysis for the selection-vs-averaging factorial run
 * (`docs/moa-selection-vs-averaging.md`).
 *
 * Reads every results file whose name carries an arm label
 * (`<timestamp>-<arm>-r<round>.json`), groups runs by arm, and computes the
 * pre-registered contrasts with a PAIRED bootstrap over CASES.
 *
 * Paired-over-cases is the point: the cases differ wildly in difficulty, so an
 * unpaired comparison of arm means is mostly measuring which cases happened to
 * land where. Pairing removes case difficulty from the contrast entirely, which
 * is what makes N=11 usable at all.
 *
 * Usage: node scripts/selection-ab-stats.mjs [resultsDir]
 */
import fs from "fs";
import path from "path";

const RESULTS_DIR = process.argv[2] ?? path.join(process.cwd(), "evals", "results");
const ARMS = ["control", "armA", "armB", "armC", "armD"];
const ARM_LABEL = {
  control: "control  (single agent)",
  armA: "A  identical prompts + synthesis",
  armB: "B  identical prompts + tournament",
  armC: "C  DPG personas    + synthesis  (today's default)",
  armD: "D  DPG personas    + tournament",
};
/** Pre-registered minimum interesting effect, absolute mean score. */
const MIN_EFFECT = 0.05;
const BOOTSTRAP_N = 20000;

function loadRuns() {
  const byArm = new Map(ARMS.map((a) => [a, []]));
  for (const file of fs.readdirSync(RESULTS_DIR).sort()) {
    if (!file.endsWith(".json")) continue;
    const arm = ARMS.find((a) => file.includes(`-${a}-r`));
    if (!arm) continue; // pilot / ad-hoc runs are deliberately excluded
    const suite = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, file), "utf8"));
    byArm.get(arm).push({ file, suite });
  }
  return byArm;
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Per-case mean score for one arm: Map<caseId, mean over that arm's repeats>. */
function perCaseMeans(files) {
  const byCase = new Map();
  for (const { suite } of files) {
    for (const r of suite.cases) {
      if (!byCase.has(r.id)) byCase.set(r.id, []);
      byCase.get(r.id).push(r.score);
    }
  }
  return new Map([...byCase].map(([id, scores]) => [id, mean(scores)]));
}

/**
 * Paired bootstrap over cases. Resamples CASE IDS with replacement (not
 * individual runs) — the unit of pairing is the case.
 */
function pairedBootstrap(aMeans, bMeans) {
  const ids = [...aMeans.keys()].filter((id) => bMeans.has(id));
  const diffs = ids.map((id) => bMeans.get(id) - aMeans.get(id));
  const observed = mean(diffs);
  const samples = new Array(BOOTSTRAP_N);
  for (let i = 0; i < BOOTSTRAP_N; i++) {
    let sum = 0;
    for (let j = 0; j < diffs.length; j++) {
      sum += diffs[(Math.random() * diffs.length) | 0];
    }
    samples[i] = sum / diffs.length;
  }
  samples.sort((a, b) => a - b);
  return {
    n: ids.length,
    observed,
    lo: samples[Math.floor(BOOTSTRAP_N * 0.025)],
    hi: samples[Math.floor(BOOTSTRAP_N * 0.975)],
    perCase: ids.map((id) => ({ id, diff: bMeans.get(id) - aMeans.get(id) })),
  };
}

function armSummary(files) {
  const runs = files.flatMap(({ suite }) => suite.cases);
  const ttfts = runs.filter((r) => typeof r.ttftMs === "number").map((r) => r.ttftMs);
  return {
    runs: runs.length,
    meanScore: mean(runs.map((r) => r.score)),
    passRate: runs.filter((r) => r.passed).length / (runs.length || 1),
    noAnswer: runs.filter((r) => r.noAnswer).length,
    errored: runs.filter((r) => r.error).length,
    meanDurationS: mean(runs.map((r) => r.durationMs)) / 1000,
    meanTtftS: ttfts.length ? mean(ttfts) / 1000 : null,
    costUsd: runs.reduce((s, r) => s + (r.costUsd ?? 0), 0),
    arms: files[0]?.suite.arms ?? null,
  };
}

const byArm = loadRuns();
const missing = ARMS.filter((a) => byArm.get(a).length === 0);
if (missing.length) {
  console.error(`No results found for: ${missing.join(", ")} (looked in ${RESULTS_DIR})`);
  if (missing.length === ARMS.length) process.exit(1);
}

console.log("\n=== ARM SUMMARIES ===\n");
console.log(
  ["arm", "runs", "meanScore", "pass%", "noAns", "err", "sec/run", "TTFT s", "cost $"]
    .map((h, i) => (i === 0 ? h.padEnd(52) : h.padStart(10)))
    .join("")
);
const summaries = {};
for (const arm of ARMS) {
  const files = byArm.get(arm);
  if (!files.length) continue;
  const s = armSummary(files);
  summaries[arm] = s;
  console.log(
    ARM_LABEL[arm].padEnd(52) +
      String(s.runs).padStart(10) +
      s.meanScore.toFixed(4).padStart(10) +
      (s.passRate * 100).toFixed(0).padStart(10) +
      String(s.noAnswer).padStart(10) +
      String(s.errored).padStart(10) +
      s.meanDurationS.toFixed(1).padStart(10) +
      (s.meanTtftS === null ? "—" : s.meanTtftS.toFixed(1)).padStart(10) +
      s.costUsd.toFixed(3).padStart(10)
  );
}

const means = Object.fromEntries(
  ARMS.filter((a) => byArm.get(a).length).map((a) => [a, perCaseMeans(byArm.get(a))])
);

const CONTRASTS = [
  ["Q1 selection vs averaging", "armA", "armB", "B − A (identical prompts)"],
  ["Q1 selection vs averaging", "armC", "armD", "D − C (DPG personas)"],
  ["Q2 roles vs identical", "armA", "armC", "C − A (synthesis)"],
  ["Q2 roles vs identical", "armB", "armD", "D − B (tournament)"],
  ["vs control", "control", "armA", "A − control"],
  ["vs control", "control", "armB", "B − control"],
  ["vs control", "control", "armC", "C − control"],
  ["vs control", "control", "armD", "D − control"],
];

console.log("\n=== PAIRED CONTRASTS (bootstrap over cases, 95% CI) ===");
console.log(`Pre-registered minimum interesting effect: ${MIN_EFFECT.toFixed(2)} absolute mean score\n`);
let lastGroup = "";
const contrastResults = {};
for (const [group, base, other, label] of CONTRASTS) {
  if (!means[base] || !means[other]) continue;
  if (group !== lastGroup) {
    console.log(`-- ${group}`);
    lastGroup = group;
  }
  const bs = pairedBootstrap(means[base], means[other]);
  contrastResults[label] = bs;
  const sig = bs.lo > 0 || bs.hi < 0 ? "CI excludes 0" : "CI includes 0";
  const big = Math.abs(bs.observed) >= MIN_EFFECT ? "≥ threshold" : "< threshold";
  console.log(
    `   ${label.padEnd(28)} ${bs.observed >= 0 ? "+" : ""}${bs.observed.toFixed(4)}` +
      `  [${bs.lo.toFixed(4)}, ${bs.hi.toFixed(4)}]  n=${bs.n}  ${sig}, ${big}`
  );
}

// Pre-committed kill criterion: the BEST swarm arm vs control.
const swarmArms = ["armA", "armB", "armC", "armD"].filter((a) => summaries[a]);
if (summaries.control && swarmArms.length) {
  const best = swarmArms.reduce((a, b) =>
    summaries[a].meanScore >= summaries[b].meanScore ? a : b
  );
  const bs = pairedBootstrap(means.control, means[best]);
  console.log("\n=== PRE-COMMITTED KILL CRITERION ===\n");
  console.log(
    `Best swarm arm: ${best} (${summaries[best].meanScore.toFixed(4)}) vs control (${summaries.control.meanScore.toFixed(4)})`
  );
  console.log(
    `Effect: ${bs.observed >= 0 ? "+" : ""}${bs.observed.toFixed(4)}  95% CI [${bs.lo.toFixed(4)}, ${bs.hi.toFixed(4)}]`
  );
  const latencyMultiple = summaries[best].meanDurationS / summaries.control.meanDurationS;
  console.log(`Latency cost: ${latencyMultiple.toFixed(2)}× control wall clock per run`);
  if (bs.observed >= MIN_EFFECT && bs.lo > 0) {
    console.log(
      `\nVERDICT: the swarm CLEARS the pre-registered bar (≥ +${MIN_EFFECT} and CI excludes 0).`
    );
  } else if (bs.observed >= MIN_EFFECT) {
    console.log(
      `\nVERDICT: effect ≥ +${MIN_EFFECT} but the CI includes 0 — underpowered, NOT a pass. Report as inconclusive.`
    );
  } else {
    console.log(
      `\nVERDICT: KILL CRITERION MET — no swarm arm beats control by the declared +${MIN_EFFECT}. The MoA feature does not earn its place on this task class.`
    );
  }
}

// Per-case detail for the biggest contrast, so a single dominant case is visible
// rather than hidden inside a mean.
const headline = contrastResults["D − C (DPG personas)"];
if (headline) {
  console.log("\n=== PER-CASE DETAIL: D − C ===\n");
  for (const { id, diff } of headline.perCase.sort((a, b) => b.diff - a.diff)) {
    console.log(`   ${(diff >= 0 ? "+" : "") + diff.toFixed(3)}  ${id}`);
  }
}
console.log("");
