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
import path from "path";
import { loadAllCases, runSuite } from "../src/lib/evals/runner";

interface CliOptions {
  useRealAgent: boolean;
  tag?: string;
  idPrefix?: string;
  jsonOnly: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { useRealAgent: false, jsonOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--real") opts.useRealAgent = true;
    else if (arg === "--json") opts.jsonOnly = true;
    else if (arg === "--tag") opts.tag = argv[++i];
    else if (arg === "--case") opts.idPrefix = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage: npm run evals -- [options]",
          "",
          "  --real           Invoke real agent against operator-configured LLM (default: mock-only)",
          "  --tag <name>     Filter to cases with this tag",
          "  --case <prefix>  Filter to cases whose id starts with the prefix",
          "  --json           Emit JSON only (no human-readable summary)",
          "  -h, --help       This help",
        ].join("\n")
      );
      process.exit(0);
    }
  }
  return opts;
}

const c = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
};

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  const { cases, errors } = await loadAllCases();

  if (opts.jsonOnly === false) {
    console.log(`${c.bold}Orchestra eval suite (PM #41)${c.reset}`);
    console.log(`${c.dim}Loaded ${cases.length} cases${
      opts.useRealAgent ? ` (real agent: ON)` : " (mock-only)"
    }${c.reset}`);
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
  });

  // Write structured results to disk for diffing across runs.
  const resultsDir = path.join(process.cwd(), "evals", "results");
  await fs.mkdir(resultsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const resultsFile = path.join(resultsDir, `${stamp}.json`);
  await fs.writeFile(resultsFile, JSON.stringify(suite, null, 2));

  if (opts.jsonOnly) {
    console.log(JSON.stringify(suite, null, 2));
  } else {
    for (const r of suite.cases) {
      const icon = r.error
        ? `${c.yellow}!${c.reset}`
        : r.passed
          ? `${c.green}✓${c.reset}`
          : `${c.red}✗${c.reset}`;
      console.log(`${icon} ${r.id} ${c.dim}(${r.durationMs}ms)${c.reset} — ${r.description}`);
      if (r.error) {
        console.log(`    ${c.yellow}error: ${r.error}${c.reset}`);
      } else if (!r.passed) {
        for (const a of r.assertions) {
          if (!a.passed) {
            console.log(`    ${c.red}assertion[${a.index}] ${a.type}: ${a.reason}${c.reset}`);
          }
        }
      }
    }
    console.log("");
    const summaryColor =
      suite.errored > 0 ? c.yellow : suite.failed > 0 ? c.red : c.green;
    console.log(
      `${summaryColor}${c.bold}Summary: ${suite.passed}/${suite.totalCases} passed, ${suite.failed} failed, ${suite.errored} errored${c.reset}`
    );
    console.log(`${c.dim}Full results: ${path.relative(process.cwd(), resultsFile)}${c.reset}`);
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
