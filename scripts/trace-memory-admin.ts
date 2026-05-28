/**
 * PM #53 — Operator CLI for inspecting and curating the PM #51 trace
 * pool at `data/traces/`. PM #51 said retention was "operator-controlled"
 * but there was no tool; this script is the tool.
 *
 * Subcommands:
 *   list           — table of all traces (id, score, captured-at, prompt
 *                    summary). Sorted by score descending.
 *   show <id>      — full trace JSON, pretty-printed.
 *   stats          — total count, score distribution (min/max/median/mean),
 *                    oldest/newest, average prompt+answer length.
 *   clear          — wipe all traces. Requires the operator to type
 *                    `yes` to confirm — guards against accidental sweep.
 *   delete <id>    — remove a single trace file.
 *
 * Usage:
 *   npm run trace:list
 *   npm run trace:show <id>
 *   npm run trace:stats
 *   npm run trace:clear
 *   npm run trace:delete <id>
 *
 * Pure CLI — does not import the runtime trace-memory module to keep
 * boot fast and avoid pulling in the Vercel AI SDK. We re-read the
 * JSON files directly and operate on their on-disk shape.
 */
import { promises as fs } from "fs";
import path from "path";
import readline from "readline/promises";
import { stdin, stdout } from "process";

const ROOT = process.cwd();
const TRACES_DIR = process.env.ORCHESTRA_DATA_DIR
  ? path.join(process.env.ORCHESTRA_DATA_DIR, "traces")
  : path.join(ROOT, "data", "traces");

interface OnDiskTrace {
  id: string;
  userPrompt: string;
  finalText: string;
  signals?: Record<string, number | boolean>;
  qualityScore: number;
  modelConfig: { provider: string; model: string };
  capturedAt: string;
  embedding: number[];
}

async function loadAllTraces(): Promise<OnDiskTrace[]> {
  let dirEntries: string[];
  try {
    dirEntries = await fs.readdir(TRACES_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const traces: OnDiskTrace[] = [];
  for (const entry of dirEntries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(TRACES_DIR, entry), "utf-8");
      traces.push(JSON.parse(raw) as OnDiskTrace);
    } catch {
      // Skip corrupt files silently.
    }
  }
  return traces;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function padEnd(s: string, n: number): string {
  if (s.length >= n) return s;
  return s + " ".repeat(n - s.length);
}

async function cmdList(): Promise<number> {
  const traces = await loadAllTraces();
  if (traces.length === 0) {
    console.log("(no traces — pool is empty)");
    return 0;
  }
  traces.sort((a, b) => b.qualityScore - a.qualityScore);
  console.log(
    padEnd("ID", 18) + padEnd("SCORE", 8) + padEnd("CAPTURED", 22) + "PROMPT"
  );
  console.log("-".repeat(120));
  for (const t of traces) {
    console.log(
      padEnd(t.id, 18) +
        padEnd(t.qualityScore.toFixed(3), 8) +
        padEnd(t.capturedAt.replace("T", " ").slice(0, 19), 22) +
        truncate(t.userPrompt.replace(/\s+/g, " "), 70)
    );
  }
  console.log(`\n${traces.length} trace(s).`);
  return 0;
}

async function cmdShow(id: string | undefined): Promise<number> {
  if (!id) {
    console.error("Usage: npm run trace:show <id>");
    return 1;
  }
  const filePath = path.join(TRACES_DIR, `${id}.json`);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`No trace with id "${id}" at ${filePath}`);
      return 1;
    }
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as OnDiskTrace;
    const redacted = {
      ...parsed,
      // Embedding is 1536+ floats — drown the operator. Show length only.
      embedding: `<${parsed.embedding?.length ?? 0}-dim vector>`,
    };
    console.log(JSON.stringify(redacted, null, 2));
  } catch (err) {
    console.error(
      `Trace file is corrupt: ${err instanceof Error ? err.message : err}`
    );
    return 1;
  }
  return 0;
}

interface StatsResult {
  total: number;
  scoreMin: number;
  scoreMax: number;
  scoreMean: number;
  scoreMedian: number;
  promptLengthMean: number;
  answerLengthMean: number;
  oldest?: string;
  newest?: string;
}

export function computeStats(traces: OnDiskTrace[]): StatsResult {
  if (traces.length === 0) {
    return {
      total: 0,
      scoreMin: 0,
      scoreMax: 0,
      scoreMean: 0,
      scoreMedian: 0,
      promptLengthMean: 0,
      answerLengthMean: 0,
    };
  }
  const scores = traces.map((t) => t.qualityScore).sort((a, b) => a - b);
  const median =
    scores.length % 2 === 0
      ? (scores[scores.length / 2 - 1] + scores[scores.length / 2]) / 2
      : scores[Math.floor(scores.length / 2)];
  const promptLens = traces.map((t) => t.userPrompt.length);
  const answerLens = traces.map((t) => t.finalText.length);
  const captured = traces.map((t) => t.capturedAt).sort();
  return {
    total: traces.length,
    scoreMin: scores[0],
    scoreMax: scores[scores.length - 1],
    scoreMean: scores.reduce((a, b) => a + b, 0) / scores.length,
    scoreMedian: median,
    promptLengthMean:
      promptLens.reduce((a, b) => a + b, 0) / promptLens.length,
    answerLengthMean:
      answerLens.reduce((a, b) => a + b, 0) / answerLens.length,
    oldest: captured[0],
    newest: captured[captured.length - 1],
  };
}

async function cmdStats(): Promise<number> {
  const traces = await loadAllTraces();
  const s = computeStats(traces);
  if (s.total === 0) {
    console.log("(no traces — pool is empty)");
    return 0;
  }
  console.log(`Total traces:           ${s.total}`);
  console.log(
    `Quality score range:    ${s.scoreMin.toFixed(3)} … ${s.scoreMax.toFixed(3)}`
  );
  console.log(`Quality mean / median:  ${s.scoreMean.toFixed(3)} / ${s.scoreMedian.toFixed(3)}`);
  console.log(`Avg prompt length:      ${s.promptLengthMean.toFixed(0)} chars`);
  console.log(`Avg answer length:      ${s.answerLengthMean.toFixed(0)} chars`);
  console.log(`Oldest captured:        ${s.oldest ?? "—"}`);
  console.log(`Newest captured:        ${s.newest ?? "—"}`);
  return 0;
}

async function cmdClear(): Promise<number> {
  const traces = await loadAllTraces();
  if (traces.length === 0) {
    console.log("(no traces — nothing to clear)");
    return 0;
  }
  // Skip the confirmation prompt under --yes (CI-friendly).
  const skipPrompt = process.argv.includes("--yes");
  if (!skipPrompt) {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    const answer = await rl.question(
      `About to delete ${traces.length} trace file(s) from ${TRACES_DIR}. Type "yes" to confirm: `
    );
    rl.close();
    if (answer.trim().toLowerCase() !== "yes") {
      console.log("Aborted.");
      return 1;
    }
  }
  let removed = 0;
  for (const t of traces) {
    try {
      await fs.unlink(path.join(TRACES_DIR, `${t.id}.json`));
      removed++;
    } catch (err) {
      console.error(
        `Failed to remove ${t.id}.json: ${err instanceof Error ? err.message : err}`
      );
    }
  }
  console.log(`Removed ${removed}/${traces.length} trace(s).`);
  return 0;
}

async function cmdDelete(id: string | undefined): Promise<number> {
  if (!id) {
    console.error("Usage: npm run trace:delete <id>");
    return 1;
  }
  const filePath = path.join(TRACES_DIR, `${id}.json`);
  try {
    await fs.unlink(filePath);
    console.log(`Removed ${filePath}`);
    return 0;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`No trace with id "${id}"`);
      return 1;
    }
    console.error(
      `Failed to remove ${id}: ${err instanceof Error ? err.message : err}`
    );
    return 1;
  }
}

async function main(): Promise<number> {
  const cmd = process.argv[2];
  const arg = process.argv[3];
  switch (cmd) {
    case "list":
      return cmdList();
    case "show":
      return cmdShow(arg);
    case "stats":
      return cmdStats();
    case "clear":
      return cmdClear();
    case "delete":
      return cmdDelete(arg);
    default:
      console.error(
        "Usage: npx tsx scripts/trace-memory-admin.ts <list|show <id>|stats|clear|delete <id>>"
      );
      return 1;
  }
}

// Only execute when invoked directly (not when imported by tests).
const invokedDirectly =
  process.argv[1]?.endsWith("trace-memory-admin.ts") ||
  process.argv[1]?.endsWith("trace-memory-admin.js");
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    }
  );
}
