#!/usr/bin/env node
/**
 * Eval-suite CLI (PM #41). Loads every case under `evals/cases/`, runs
 * them, and prints a structured report to stdout.
 *
 * Usage:
 *   npm run evals                       # mock-response cases only (no LLM)
 *   npm run evals -- --real             # use real agent (operator API key)
 *   npm run evals -- --tag skeptic      # filter by tag
 *   npm run evals -- --case 01-trivia   # filter by id prefix
 *   npm run evals -- --json             # JSON output (default is colored TTY)
 *
 * Exit codes:
 *   0 — every case passed
 *   1 — at least one case failed
 *   2 — at least one case file failed to parse / load
 *
 * Results are also written to `evals/results/<timestamp>.json` so the
 * operator can diff successive runs.
 */
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { loadAllCases, runSuite } from "../src/lib/evals/runner";

/**
 * Load `.env.local` the way `next dev` does.
 *
 * This script runs under plain tsx, which does NOT read `.env.local` — only the
 * Next.js runtime does. Without this, `resolveProviderApiKey` never sees
 * `OPENROUTER_API_KEY` and silently falls back to whatever cleartext value is
 * left in `data/settings/settings.json`. A stale value there produced a 401
 * ("Missing Authentication header") on every case, which the agent's PM #17
 * auto-fallback then classified as `unknown_4xx` and "recovered" from by
 * PERSISTING a different chatModel — so a whole eval run silently changed the
 * model under test. Loading the env file is the fix at the source.
 *
 * Existing process env WINS (shell exports are more specific than the file).
 */
function loadEnvLocal(): void {
  const envPath = path.join(process.cwd(), ".env.local");
  if (!fsSync.existsSync(envPath)) return;
  const before = new Set(Object.keys(process.env));
  const snapshot = { ...process.env };
  process.loadEnvFile(envPath);
  for (const key of before) {
    // Restore anything the file overwrote — an explicit shell export must win.
    if (snapshot[key] !== undefined) process.env[key] = snapshot[key];
  }
}

interface CliOptions {
  useRealAgent: boolean;
  tag?: string;
  idPrefix?: string;
  jsonOnly: boolean;
  repeat: number;
  label?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { useRealAgent: false, jsonOnly: false, repeat: 1 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--real") opts.useRealAgent = true;
    else if (arg === "--json") opts.jsonOnly = true;
    else if (arg === "--tag") opts.tag = argv[++i];
    else if (arg === "--case") opts.idPrefix = argv[++i];
    else if (arg === "--label") opts.label = argv[++i];
    else if (arg === "--repeat") {
      const raw = argv[++i];
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1) {
        console.error(
          `${c.red}--repeat expects a positive integer, got "${raw}".${c.reset}`
        );
        process.exit(2);
      }
      opts.repeat = parsed;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage: npm run evals -- [options]",
          "",
          "  --real           Invoke real agent against operator-configured LLM (default: mock-only)",
          "  --tag <name>     Filter to cases with this tag",
          "  --case <prefix>  Filter to cases whose id starts with the prefix",
          "  --repeat <n>     Run every case n times (default 1) — required to see past run-to-run variance",
          "  --label <name>   Tag the results filename with an arm label (e.g. arm-d)",
          "  --json           Emit JSON only (no human-readable summary)",
          "  -h, --help       This help",
          "",
          "Eval-arm env flags (dev-only, validated below, never set in production):",
          "  ORCHESTRA_EVAL_SWARM_MODE=swarm|single",
          "  ORCHESTRA_EVAL_AGGREGATOR_MODE=synthesis|tournament",
          "  ORCHESTRA_EVAL_IDENTICAL_PROMPTS=true",
          "  ORCHESTRA_EVAL_SKEPTIC_CONTROL=true",
        ].join("\n")
      );
      process.exit(0);
    }
  }
  return opts;
}

/**
 * Validate one eval-arm env var against its allowed values. An unknown value
 * would silently fall through to the configured default and quietly corrupt one
 * arm of the experiment, so we REFUSE to start rather than produce a result
 * that is mislabeled in the write-up.
 */
function validateArmEnv(name: string, allowed: string[]): void {
  const value = process.env[name];
  if (value === undefined || value === "") return;
  if (!allowed.includes(value)) {
    console.error(
      `${c.red}${name}="${value}" is invalid — expected ${allowed
        .map((a) => `"${a}"`)
        .join(" or ")} (or unset).${c.reset}`
    );
    process.exit(2);
  }
  if (process.env.NODE_ENV === "production") {
    console.error(
      `${c.red}${name} is dev-only and ignored under NODE_ENV=production — refusing to run a mislabeled arm.${c.reset}`
    );
    process.exit(2);
  }
}

const c = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
};

/**
 * Read the currently configured chat model straight off disk.
 *
 * The agent's auto-fallback (PM #17, `agent-fallback.ts`) PERSISTS a new
 * `chatModel` when it classifies a failure as a model-availability problem — and
 * a plain 401 classifies as `unknown_4xx`, so an auth problem is enough to swap
 * the model mid-run. An A/B whose model changed halfway through is worse than no
 * A/B, so the run compares this before and after and refuses to report a result
 * it knows is mislabeled.
 */
function readConfiguredChatModel(): string | null {
  try {
    const raw = fsSync.readFileSync(
      path.join(process.cwd(), "data", "settings", "settings.json"),
      "utf-8"
    );
    const parsed = JSON.parse(raw) as { chatModel?: { provider?: string; model?: string } };
    if (!parsed.chatModel?.model) return null;
    return `${parsed.chatModel.provider ?? "?"}/${parsed.chatModel.model}`;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  loadEnvLocal();
  const opts = parseArgs(process.argv.slice(2));
  const modelAtStart = readConfiguredChatModel();

  // Warm the OpenRouter pricing map. `instrumentation-node.ts` does this at boot
  // for the server, but this script has no boot hook — without it every run
  // reports `costUsd: 0, fullyPriced: false`, i.e. the cost column of an A/B
  // silently reads zero for every arm.
  if (opts.useRealAgent) {
    const { refreshOpenRouterPricingCache } = await import(
      "../src/lib/cost/openrouter-pricing"
    );
    const pricing = await refreshOpenRouterPricingCache().catch(() => null);
    if (!opts.jsonOnly) {
      console.log(
        `${c.dim}Pricing cache: ${
          pricing ? `${pricing.entryCount} models (${pricing.source})` : "unavailable — costs will read 0"
        }${c.reset}`
      );
    }
  }

  // A/B arm overrides. Validate LOUDLY — see validateArmEnv.
  const armMode = process.env.ORCHESTRA_EVAL_SWARM_MODE;
  validateArmEnv("ORCHESTRA_EVAL_SWARM_MODE", ["swarm", "single"]);
  validateArmEnv("ORCHESTRA_EVAL_AGGREGATOR_MODE", ["synthesis", "tournament"]);
  validateArmEnv("ORCHESTRA_EVAL_IDENTICAL_PROMPTS", ["true", "false"]);
  validateArmEnv("ORCHESTRA_EVAL_SKEPTIC_CONTROL", ["true", "false"]);
  // A selection arm on a SINGLE-agent run is a contradiction: no proposers are
  // fanned out, so there is nothing to aggregate and the flag would silently
  // describe an arm that never ran.
  if (armMode === "single") {
    for (const conflicting of [
      "ORCHESTRA_EVAL_AGGREGATOR_MODE",
      "ORCHESTRA_EVAL_IDENTICAL_PROMPTS",
    ]) {
      if (process.env[conflicting] && process.env[conflicting] !== "false") {
        console.error(
          `${c.red}${conflicting} is set together with ORCHESTRA_EVAL_SWARM_MODE=single — the single-agent arm runs no proposers, so this flag would label an arm that never executed.${c.reset}`
        );
        process.exit(2);
      }
    }
  }

  const { cases, errors } = await loadAllCases();

  if (opts.jsonOnly === false) {
    console.log(`${c.bold}Orchestra eval suite (PM #41)${c.reset}`);
    console.log(`${c.dim}Loaded ${cases.length} cases${
      opts.useRealAgent ? ` (real agent: ON)` : " (mock-only)"
    }${c.reset}`);
    if (armMode) {
      console.log(
        `${c.bold}${c.yellow}Swarm arm: ${armMode.toUpperCase()}${c.reset}${c.dim} (ORCHESTRA_EVAL_SWARM_MODE forces every case ${
          armMode === "swarm" ? "into the full MoA ensemble" : "to a single agent"
        })${c.reset}`
      );
    }
    if (errors.length > 0) {
      console.log(`${c.red}${errors.length} case file(s) failed to load:${c.reset}`);
      for (const e of errors) {
        console.log(`  ${c.red}✗${c.reset} ${e.file}: ${e.error}`);
      }
    }
    console.log("");
  }

  const suite = await runSuite(cases, {
    useRealAgent: opts.useRealAgent,
    filter: { tag: opts.tag, idPrefix: opts.idPrefix },
    repeat: opts.repeat,
    // A real-agent arm runs for tens of minutes; without live output the
    // operator cannot tell a slow run from a hung one.
    onResult: opts.jsonOnly
      ? undefined
      : (r, index, total) => {
          const icon = r.error
            ? `${c.yellow}!${c.reset}`
            : r.passed
              ? `${c.green}✓${c.reset}`
              : `${c.red}✗${c.reset}`;
          const score = `${r.constraintsPassed}/${r.constraintsTotal}`;
          console.log(
            `${c.dim}[${index}/${total}]${c.reset} ${icon} ${r.id} ${c.dim}(${score} constraints, ${(r.durationMs / 1000).toFixed(1)}s${
              r.noAnswer ? ", NO ANSWER" : ""
            })${c.reset}`
          );
        },
  });

  // Write structured results to disk for diffing across runs.
  const resultsDir = path.join(process.cwd(), "evals", "results");
  await fs.mkdir(resultsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = opts.label ? `-${opts.label.replace(/[^a-z0-9-]/gi, "_")}` : "";
  const resultsFile = path.join(resultsDir, `${stamp}${suffix}.json`);
  await fs.writeFile(resultsFile, JSON.stringify(suite, null, 2));

  if (opts.jsonOnly) {
    console.log(JSON.stringify(suite, null, 2));
  } else {
    console.log("");
    for (const agg of suite.aggregates) {
      const color =
        agg.meanScore >= 0.999 ? c.green : agg.meanScore >= 0.5 ? c.yellow : c.red;
      const spread =
        agg.runs > 1 ? ` ${c.dim}[${agg.scores.map((s) => s.toFixed(2)).join(" ")}]${c.reset}` : "";
      console.log(
        `${color}${agg.meanScore.toFixed(3)}${c.reset} ${agg.id} ${c.dim}(pass ${(agg.passRate * 100).toFixed(0)}%, ${(agg.meanDurationMs / 1000).toFixed(1)}s${
          agg.noAnswerCount > 0 ? `, ${agg.noAnswerCount} no-answer` : ""
        })${c.reset}${spread}`
      );
    }
    console.log("");
    const summaryColor =
      suite.errored > 0 ? c.yellow : suite.failed > 0 ? c.red : c.green;
    console.log(
      `${c.bold}Mean score: ${suite.meanScore.toFixed(4)}${c.reset} ${c.dim}(primary metric — fraction of constraints satisfied, across ${suite.totalCases} runs of ${suite.aggregates.length} cases × ${suite.repeats})${c.reset}`
    );
    console.log(
      `${summaryColor}${c.bold}Binary: ${suite.passed}/${suite.totalCases} runs fully passed, ${suite.failed} failed, ${suite.errored} errored${c.reset}`
    );
    console.log(
      `${c.dim}Arms: ${suite.arms ?? "(none — production shape)"} | cost $${suite.totalCostUsd.toFixed(4)}${
        suite.costFullyPriced ? "" : " (LOWER BOUND — unpriced calls)"
      } | mean ${(suite.meanDurationMs / 1000).toFixed(1)}s/run${
        suite.meanTtftMs === null ? "" : ` | mean TTFT ${(suite.meanTtftMs / 1000).toFixed(1)}s`
      }${c.reset}`
    );
    if (suite.vacuous > 0) {
      console.log(
        `${c.yellow}⚠ ${suite.vacuous} case(s) passed VACUOUSLY (all assertions skipped — judge-only case in mock mode; nothing verified). Run with --real to actually score them.${c.reset}`
      );
    }
    if (suite.noAnswer > 0) {
      const delivered = suite.totalCases - suite.noAnswer - suite.errored;
      const deliveredPass = suite.cases.filter((r) => r.passed && !r.noAnswer).length;
      console.log(
        `${c.yellow}⚠ ${suite.noAnswer}/${suite.totalCases} case(s) returned NO ANSWER (empty response — a DELIVERY failure, not a wrong answer). Delivered-only score: ${deliveredPass}/${delivered}. Do NOT read a delivery gap as a capability gap.${c.reset}`
      );
    }
    console.log(`${c.dim}Full results: ${path.relative(process.cwd(), resultsFile)}${c.reset}`);
  }

  // Integrity check: the model must be the same one the run started with.
  const modelAtEnd = readConfiguredChatModel();
  if (modelAtStart && modelAtEnd && modelAtStart !== modelAtEnd) {
    console.error(
      `${c.red}${c.bold}⚠ MODEL CHANGED MID-RUN: "${modelAtStart}" → "${modelAtEnd}".${c.reset}`
    );
    console.error(
      `${c.red}Orchestra's auto-fallback persisted a different chatModel (a 401/4xx is enough to trigger it). This run's results are NOT comparable to any other arm — discard them, restore the model, and re-run.${c.reset}`
    );
    process.exit(3);
  }

  // Exit code: 2 if load errors, 1 if any failures, 0 if all green.
  if (errors.length > 0) process.exit(2);
  if (suite.failed > 0 || suite.errored > 0) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
