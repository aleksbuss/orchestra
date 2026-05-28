/**
 * PM #53 (extended by PM #55) — Operator CLI for inspecting and
 * curating the trace pool at `data/traces/` (global) and
 * `data/projects/<projectId>/.orchestra_traces/` (per-project).
 *
 * Subcommands:
 *   list           — table of traces (id, scope, score, captured-at,
 *                    prompt summary). Sorted by score descending.
 *   show <id>      — full trace JSON, pretty-printed.
 *   stats          — pool count, score distribution, oldest/newest,
 *                    avg prompt+answer length.
 *   clear          — wipe all traces in scope. Typed `yes` confirmation.
 *   delete <id>    — remove a single trace file.
 *
 * Scope flags (apply to all subcommands except `show` which takes <id>):
 *   --global              (default) operate on the global pool
 *                         data/traces/<id>.json
 *   --project <projectId> operate on that project's pool
 *                         data/projects/<projectId>/.orchestra_traces/
 *   --all                 walk global AND every project pool found
 *                         under data/projects/. Only meaningful for
 *                         `list`/`stats`. Refused by `clear`/`delete`
 *                         to prevent accidental cross-scope wipe.
 *
 * Usage examples:
 *   npm run trace:list                    # global pool
 *   npm run trace:list -- --all           # global + every project
 *   npm run trace:list -- --project p123  # one project
 *   npm run trace:stats -- --project p123
 *   npm run trace:clear -- --project p123 # wipe only that project's pool
 *
 * Pure CLI — does not import the runtime trace-memory module to keep
 * boot fast and avoid pulling in the Vercel AI SDK.
 */
import { promises as fs } from "fs";
import path from "path";
import readline from "readline/promises";
import { stdin, stdout } from "process";

const ROOT = process.cwd();
const DATA_DIR = process.env.ORCHESTRA_DATA_DIR ?? path.join(ROOT, "data");
const GLOBAL_TRACES_DIR = path.join(DATA_DIR, "traces");
const PROJECTS_DIR = path.join(DATA_DIR, "projects");

interface OnDiskTrace {
  id: string;
  userPrompt: string;
  finalText: string;
  signals?: Record<string, number | boolean | string>;
  qualityScore: number;
  modelConfig: { provider: string; model: string };
  capturedAt: string;
  embedding: number[];
  projectId?: string;
}

interface TraceWithScope extends OnDiskTrace {
  scope: string; // "global" or projectId
}

type Scope =
  | { kind: "global" }
  | { kind: "project"; projectId: string }
  | { kind: "all" };

/** Parse `--global` / `--project <id>` / `--all` from argv. Default = global. */
function parseScope(argv: string[]): Scope {
  if (argv.includes("--all")) return { kind: "all" };
  const projectIdx = argv.indexOf("--project");
  if (projectIdx >= 0 && argv[projectIdx + 1]) {
    return { kind: "project", projectId: argv[projectIdx + 1] };
  }
  return { kind: "global" };
}

function projectTracesDir(projectId: string): string {
  return path.join(PROJECTS_DIR, projectId, ".orchestra_traces");
}

function dirForScope(scope: Exclude<Scope, { kind: "all" }>): string {
  if (scope.kind === "global") return GLOBAL_TRACES_DIR;
  return projectTracesDir(scope.projectId);
}

async function loadTracesFromDir(
  dir: string,
  scopeLabel: string
): Promise<TraceWithScope[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: TraceWithScope[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(dir, entry), "utf-8");
      const parsed = JSON.parse(raw) as OnDiskTrace;
      out.push({ ...parsed, scope: scopeLabel });
    } catch {
      // Skip corrupt files silently.
    }
  }
  return out;
}

async function listProjectIds(): Promise<string[]> {
  try {
    const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function loadTraces(scope: Scope): Promise<TraceWithScope[]> {
  if (scope.kind === "all") {
    const result: TraceWithScope[] = [];
    result.push(...(await loadTracesFromDir(GLOBAL_TRACES_DIR, "global")));
    const projectIds = await listProjectIds();
    for (const pid of projectIds) {
      result.push(...(await loadTracesFromDir(projectTracesDir(pid), pid)));
    }
    return result;
  }
  const scopeLabel = scope.kind === "global" ? "global" : scope.projectId;
  return loadTracesFromDir(dirForScope(scope), scopeLabel);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function padEnd(s: string, n: number): string {
  if (s.length >= n) return s;
  return s + " ".repeat(n - s.length);
}

function describeScope(scope: Scope): string {
  if (scope.kind === "global") return "global pool";
  if (scope.kind === "project") return `project "${scope.projectId}"`;
  return "all scopes (global + every project)";
}

async function cmdList(scope: Scope): Promise<number> {
  const traces = await loadTraces(scope);
  if (traces.length === 0) {
    console.log(`(no traces in ${describeScope(scope)})`);
    return 0;
  }
  traces.sort((a, b) => b.qualityScore - a.qualityScore);
  // Column widths: id 18, scope 18, score 8, captured 22, prompt rest.
  console.log(
    padEnd("ID", 18) +
      padEnd("SCOPE", 18) +
      padEnd("SCORE", 8) +
      padEnd("CAPTURED", 22) +
      "PROMPT"
  );
  console.log("-".repeat(120));
  for (const t of traces) {
    console.log(
      padEnd(t.id, 18) +
        padEnd(truncate(t.scope, 17), 18) +
        padEnd(t.qualityScore.toFixed(3), 8) +
        padEnd(t.capturedAt.replace("T", " ").slice(0, 19), 22) +
        truncate(t.userPrompt.replace(/\s+/g, " "), 60)
    );
  }
  console.log(`\n${traces.length} trace(s) across ${describeScope(scope)}.`);
  return 0;
}

async function cmdShow(id: string | undefined, scope: Scope): Promise<number> {
  if (!id) {
    console.error("Usage: npm run trace:show -- <id> [--project <projectId>]");
    return 1;
  }
  // Show across whichever scope matches first under --all.
  const candidates: Array<{ dir: string; label: string }> = [];
  if (scope.kind === "all") {
    candidates.push({ dir: GLOBAL_TRACES_DIR, label: "global" });
    for (const pid of await listProjectIds()) {
      candidates.push({ dir: projectTracesDir(pid), label: pid });
    }
  } else if (scope.kind === "global") {
    candidates.push({ dir: GLOBAL_TRACES_DIR, label: "global" });
  } else {
    candidates.push({
      dir: projectTracesDir(scope.projectId),
      label: scope.projectId,
    });
  }
  for (const { dir, label } of candidates) {
    const filePath = path.join(dir, `${id}.json`);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    try {
      const parsed = JSON.parse(raw) as OnDiskTrace;
      const redacted = {
        scope: label,
        ...parsed,
        embedding: `<${parsed.embedding?.length ?? 0}-dim vector>`,
      };
      console.log(JSON.stringify(redacted, null, 2));
      return 0;
    } catch (err) {
      console.error(
        `Trace file is corrupt: ${err instanceof Error ? err.message : err}`
      );
      return 1;
    }
  }
  console.error(`No trace with id "${id}" in ${describeScope(scope)}.`);
  return 1;
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

async function cmdStats(scope: Scope): Promise<number> {
  const traces = await loadTraces(scope);
  const s = computeStats(traces);
  console.log(`Scope: ${describeScope(scope)}`);
  if (s.total === 0) {
    console.log("(no traces — pool is empty)");
    return 0;
  }
  console.log(`Total traces:           ${s.total}`);
  console.log(
    `Quality score range:    ${s.scoreMin.toFixed(3)} … ${s.scoreMax.toFixed(3)}`
  );
  console.log(
    `Quality mean / median:  ${s.scoreMean.toFixed(3)} / ${s.scoreMedian.toFixed(3)}`
  );
  console.log(`Avg prompt length:      ${s.promptLengthMean.toFixed(0)} chars`);
  console.log(`Avg answer length:      ${s.answerLengthMean.toFixed(0)} chars`);
  console.log(`Oldest captured:        ${s.oldest ?? "—"}`);
  console.log(`Newest captured:        ${s.newest ?? "—"}`);
  return 0;
}

async function cmdClear(scope: Scope): Promise<number> {
  if (scope.kind === "all") {
    console.error(
      "Refusing to `clear --all` — that would wipe every project's pool plus global. " +
        "Run `clear --global` or `clear --project <id>` per pool you actually want to nuke."
    );
    return 1;
  }
  const dir = dirForScope(scope);
  const traces = await loadTraces(scope);
  if (traces.length === 0) {
    console.log(`(no traces in ${describeScope(scope)} — nothing to clear)`);
    return 0;
  }
  const skipPrompt = process.argv.includes("--yes");
  if (!skipPrompt) {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    const answer = await rl.question(
      `About to delete ${traces.length} trace file(s) from ${dir} (${describeScope(scope)}). Type "yes" to confirm: `
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
      await fs.unlink(path.join(dir, `${t.id}.json`));
      removed++;
    } catch (err) {
      console.error(
        `Failed to remove ${t.id}.json: ${err instanceof Error ? err.message : err}`
      );
    }
  }
  console.log(`Removed ${removed}/${traces.length} trace(s) from ${describeScope(scope)}.`);
  return 0;
}

async function cmdDelete(id: string | undefined, scope: Scope): Promise<number> {
  if (!id) {
    console.error(
      "Usage: npm run trace:delete -- <id> [--project <projectId>]"
    );
    return 1;
  }
  if (scope.kind === "all") {
    console.error(
      "Refusing to `delete --all` — pass `--global` or `--project <id>` to disambiguate."
    );
    return 1;
  }
  const filePath = path.join(dirForScope(scope), `${id}.json`);
  try {
    await fs.unlink(filePath);
    console.log(`Removed ${filePath}`);
    return 0;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`No trace with id "${id}" in ${describeScope(scope)}`);
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
  // The third positional may be `<id>` for show/delete OR a flag start.
  const arg =
    process.argv[3] && !process.argv[3].startsWith("--")
      ? process.argv[3]
      : undefined;
  const scope = parseScope(process.argv);
  switch (cmd) {
    case "list":
      return cmdList(scope);
    case "show":
      return cmdShow(arg, scope);
    case "stats":
      return cmdStats(scope);
    case "clear":
      return cmdClear(scope);
    case "delete":
      return cmdDelete(arg, scope);
    default:
      console.error(
        "Usage: npx tsx scripts/trace-memory-admin.ts <list|show <id>|stats|clear|delete <id>> [--global|--project <id>|--all]"
      );
      return 1;
  }
}

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

// Test-only exports.
export { parseScope, dirForScope, projectTracesDir };
