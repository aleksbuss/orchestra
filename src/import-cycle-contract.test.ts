/**
 * Structural gate — no runtime import cycles under `src/`.
 *
 * A cycle is legal ESM and `next dev` resolves it lazily, so a cyclic import
 * can sit in the tree for months looking fine. The PRODUCTION bundle is where
 * it bites: Turbopack groups modules into route chunks, and a module caught
 * mid-cycle is evaluated while still partially initialised — its exports read
 * as `undefined` at call time.
 *
 * That is exactly how every cron route came to be broken in production (PM
 * #111) while dev, the unit suite and the Playwright e2e suite were all green:
 *
 *   cron/service → agent/agent → tools/tool → tools/cron-tool → cron/service
 *
 *   GET /api/projects/<id>/cron/status
 *   → 500  TypeError: (0 , _.ensureCronSchedulerStarted) is not a function
 *   → 400  {"error":"(0 , f.getCronProjectStatus) is not a function"}
 *
 * Nothing in the repo could catch it: `npm run dev` resolves the cycle, and the
 * e2e suite runs against a dev server. It was found by hand, by opening
 * `/dashboard/cron` against `npm run start`.
 *
 * So the gate is static instead. At the time it was written the tree had
 * **zero** cycles, which is why there is no allowlist — if you are reading this
 * because it failed, the answer is to break the cycle (usually by making the
 * heaviest edge a `await import(...)` at its single call site), not to add an
 * exemption. An exemption here means shipping a module whose exports may be
 * `undefined` in production.
 *
 * Scope note: `import type` lines are erased at compile time and create no
 * runtime edge, so they are excluded — a type-only cycle is harmless.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOTS = ["src/lib", "src/app"];

/**
 * `import ... from "@/..."` — but NOT `import type ...`.
 *
 * Matched over the WHOLE FILE, not line by line. The first version of this
 * gate used a per-line regex and silently missed every multi-line import
 * block — which is how most of this codebase writes them:
 *
 *   import {
 *     addCronJob,
 *   } from "@/lib/cron/service";
 *
 * Mutation-checked: re-adding the PM #111 static import made the cycle check
 * still pass, because the edge that closed the loop lived in exactly such a
 * block. `[^;]*?` keeps the match inside one statement, since an import
 * declaration ends at its semicolon.
 *
 * BOTH specifier styles are matched. An earlier version took only `@/…` and so
 * ignored 231 relative specifiers — it reported "zero cycles" on a tree that had
 * them, which is how `runAgent` came to be `undefined` in the background-daemon
 * path of a production build while this gate was green.
 */
const RUNTIME_IMPORT_RE = /\bimport\s+(?!type[\s{])[^;]*?from\s*["']((?:@\/|\.\.?\/)[^"']+)["']/g;

/**
 * Remove comments before matching imports.
 *
 * Without this the scan reads prose as code. `moa-proposer-tools.ts` documents
 * itself with *"Re-exported from `./moa` so test files keep their `import { ... }
 * from "./moa"` lines intact"* — and the import regex, which spans newlines,
 * matched straight across that sentence and reported a cycle that does not
 * exist. A gate with false positives is no better than one with false
 * negatives: it teaches the next person to add an exemption.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

function stripExt(p: string): string {
  return p.replace(/\\/g, "/").replace(/\.(tsx?|jsx?)$/, "");
}

function collect(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(full));
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.includes(".test."))
      out.push(full);
  }
  return out;
}

/**
 * `@/lib/foo` → `src/lib/foo`; `./foo` / `../foo` → resolved against the
 * importing file's own directory. Checked against what is actually on disk, so
 * a specifier that resolves to nothing simply produces no edge.
 */
function resolveSpecifier(spec: string, fromFile: string): string | null {
  const base = spec.startsWith("@/")
    ? "src/" + spec.slice(2)
    : path.join(path.dirname(fromFile), spec);
  for (const cand of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (fs.existsSync(cand)) return stripExt(cand);
  }
  return null;
}

function buildGraph(): { graph: Map<string, Set<string>>; fileCount: number } {
  const graph = new Map<string, Set<string>>();
  const files = ROOTS.flatMap(collect);
  for (const file of files) {
    const self = stripExt(file);
    const deps = new Set<string>();
    const source = stripComments(fs.readFileSync(file, "utf-8"));
    RUNTIME_IMPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RUNTIME_IMPORT_RE.exec(source)) !== null) {
      const target = resolveSpecifier(m[1], file);
      if (target && target !== self) deps.add(target);
    }
    graph.set(self, deps);
  }
  return { graph, fileCount: files.length };
}

/** Tarjan — every strongly-connected component larger than one node is a cycle. */
function findCycles(graph: Map<string, Set<string>>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  let counter = 0;

  const strongConnect = (v: string): void => {
    index.set(v, counter);
    low.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!index.has(w)) {
        if (!graph.has(w)) continue; // outside the scanned roots
        strongConnect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      const component: string[] = [];
      for (;;) {
        const w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
        if (w === v) break;
      }
      if (component.length > 1) cycles.push(component.sort());
    }
  };

  for (const v of graph.keys()) if (!index.has(v)) strongConnect(v);
  return cycles;
}

describe("import-cycle contract — a cycle is a production-only landmine", () => {
  const { graph, fileCount } = buildGraph();

  it("the scan actually found the tree (an empty graph must not pass silently)", () => {
    // The classic way a structural gate degrades in the passing direction: the
    // glob stops matching and "no cycles found" becomes "nothing was checked".
    expect(fileCount).toBeGreaterThan(150);
    const edges = [...graph.values()].reduce((n, s) => n + s.size, 0);
    // Both `@/…` and relative specifiers must be counted — the earlier
    // alias-only version saw roughly half of them and still passed.
    expect(edges).toBeGreaterThan(400);
  });

  it("no module under src/lib or src/app takes part in a runtime import cycle", () => {
    const cycles = findCycles(graph);
    expect(
      cycles,
      cycles.length === 0
        ? ""
        : `Runtime import cycle(s) found. In production these modules can be evaluated\n` +
          `mid-initialisation, so their exports read as \`undefined\` at call time (PM #111).\n` +
          `Break the heaviest edge with a dynamic \`await import(...)\` at its call site:\n` +
          cycles.map((c) => `  - ${c.join(" ↔ ")}`).join("\n")
    ).toEqual([]);
  });

  it("the edges deferred for PM #111 are still lazy", () => {
    // Named explicitly, because re-adding either static import restores a real
    // cycle and the detector above is the only other thing that would notice.
    //
    // `cron-tool.ts` is deliberately NOT on this list. Making ITS import of
    // `cron/runtime` dynamic looked like the same fix and built clean — and it
    // broke the background daemon in production: Turbopack split `cron/runtime`
    // and its subgraph into an async chunk, and the fire-and-forget job read
    // `agent`'s namespace before that chunk resolved, so every background turn
    // answered `[Background Daemon Error]: (0 , t.runAgent) is not a function`.
    // Bisected across five production builds. One lazy edge (`cron/service ->
    // agent`) is enough to break that ring; the second was not free.
    const service = fs.readFileSync("src/lib/cron/service.ts", "utf-8");
    expect(
      /^\s*import\s+\{[^}]*runAgentText/m.test(service),
      "cron/service.ts must import runAgentText lazily, not at module scope"
    ).toBe(false);

    const cliRunner = fs.readFileSync("src/lib/providers/cli-runner.ts", "utf-8");
    expect(
      /^\s*import\s+\{[^}]*getProjectContentRoot/m.test(cliRunner),
      "cli-runner.ts must import getProjectContentRoot lazily, not at module scope"
    ).toBe(false);

    const projectStore = fs.readFileSync("src/lib/storage/project-store.ts", "utf-8");
    expect(
      /^\s*import\s+\{[^}]*clearMemoryCache/m.test(projectStore),
      "project-store.ts must import clearMemoryCache lazily, not at module scope"
    ).toBe(false);
  });});
