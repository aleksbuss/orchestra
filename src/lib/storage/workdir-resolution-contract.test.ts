/**
 * Structural CI gate: there are exactly TWO project roots, they have two
 * different names, and a tool never re-derives the one it reports.
 *
 * THE DEFECT CLASS (PM #105). `getWorkDir(projectId, absoluteRoot?)` meant two
 * different directories depending on an OPTIONAL second argument:
 *
 *     getWorkDir("p1")                  -> data/projects/p1        (sandbox)
 *     getWorkDir("p1", "/Users/me/foo") -> /Users/me/foo           (linked repo)
 *
 * So which directory a caller got depended on whether that caller happened to
 * have looked the project up first. `get_current_project` — the agent's FIRST
 * orientation step — had not, so it REPORTED the sandbox while every tool that
 * ACTED had been through the async resolver and ran in the linked repo. In a
 * live run the agent believed the report, `cd`-ed into an empty
 * `data/projects/<id>/`, found no source, and answered about a different
 * repository. Nothing crashed and nothing was inconsistent on its face: the
 * report was internally coherent, just about the wrong directory.
 *
 * The fix was to make the ambiguity unrepresentable — two names, no default:
 *
 *     getProjectContentRoot(id)  async  where the project's FILES live
 *     getProjectMetaRoot(id)     sync   where ORCHESTRA's own state lives
 *
 * WHAT THIS GATE CHECKS, precisely:
 *
 *   1. The three retired names never come back in executable code. A
 *      reintroduced `getWorkDir` is the ambiguity, restored.
 *   2. Inside `src/lib/tools`, only `tool-paths.ts` may touch a project-store
 *      root resolver. Every other tool goes through `resolveContextBaseDir` /
 *      `resolveContextCwd`. This is the rule that would have caught PM #105:
 *      the defect was not a wrong constant, it was a SECOND resolver.
 *
 * WHAT IT DOES NOT CHECK: that a given tool passes the right context, or that
 * `context.workDir` was populated upstream. That is dataflow, not a scan —
 * `project-nav-tools.test.ts` pins the behavior end-to-end instead. Claiming
 * this gate proves the whole property would be the same "green means correct"
 * mistake that let PM #105 ship.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/** The ambiguous names the split retired. None may return. */
const RETIRED_NAMES = [
  "getWorkDir",
  "resolveWorkDirForProject",
  "getProjectWorkDir",
] as const;

const RETIRED_IN_CODE = new RegExp(`\\b(${RETIRED_NAMES.join("|")})\\b`);

/** The two survivors. Importing either is "resolving a project root". */
const ROOT_RESOLVER = /\b(getProjectContentRoot|getProjectMetaRoot)\b/;

/**
 * Comment lines are exempt: the post-mortem narrative in `project-store.ts`
 * and this file both NAME the retired functions on purpose. Only executable
 * code counts.
 */
function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      sourceFiles(full, acc);
    } else if (/\.tsx?$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

function scan(
  root: string,
  predicate: (line: string, file: string) => boolean
): string[] {
  const abs = path.join(process.cwd(), root);
  if (!fs.existsSync(abs)) return [];
  const offenders: string[] = [];
  for (const file of sourceFiles(abs)) {
    const rel = path.relative(process.cwd(), file);
    fs.readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (isCommentLine(line)) return;
        if (predicate(line, rel)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
  }
  return offenders;
}

describe("workdir-resolution contract — two roots, two names, one resolver", () => {
  it("the retired ambiguous names appear nowhere in executable code", () => {
    // This file is the one exemption: its pins below name the retired
    // identifiers as string literals on purpose, to prove the regex still
    // matches them. Exempting anything else would defeat the gate.
    const isThisGate = (file: string) =>
      path.basename(file) === "workdir-resolution-contract.test.ts";
    const offenders = [
      ...scan("src", (line, file) => !isThisGate(file) && RETIRED_IN_CODE.test(line)),
      ...scan("scripts", (line, file) => !isThisGate(file) && RETIRED_IN_CODE.test(line)),
    ];
    expect(offenders).toEqual([]);
  });

  it("only tool-paths.ts resolves a project root inside src/lib/tools", () => {
    // Any OTHER tool module that reaches for a root resolver is building the
    // second, divergent answer — exactly the shape of PM #105.
    const offenders = scan("src/lib/tools", (line, file) => {
      if (path.basename(file) === "tool-paths.ts") return false;
      if (/\.test\.tsx?$/.test(file)) return false;
      return ROOT_RESOLVER.test(line);
    });
    expect(offenders).toEqual([]);
  });

  it("tool-paths.ts really does resolve a root (the gate cannot pass by matching nothing)", () => {
    // Verify-the-instrument: if `tool-paths.ts` stopped resolving anything,
    // the check above would be vacuously green forever.
    const src = fs.readFileSync(
      path.join(process.cwd(), "src/lib/tools/tool-paths.ts"),
      "utf8"
    );
    expect(ROOT_RESOLVER.test(src)).toBe(true);
    expect(src).toMatch(/export function resolveContextBaseDir\b/);
  });

  it("the patterns it scans for are the ones that shipped", () => {
    // Pin both regexes against the literal defect AND against the fixed
    // shape, so neither can silently degrade in the passing direction.
    expect(RETIRED_IN_CODE.test('import { getWorkDir } from "@/lib/storage/project-store";')).toBe(
      true
    );
    expect(RETIRED_IN_CODE.test("  const workDir = getWorkDir(projectId, project?.absoluteRoot);")).toBe(
      true
    );
    expect(RETIRED_IN_CODE.test("  const workDir = await resolveWorkDirForProject(id);")).toBe(true);
    expect(RETIRED_IN_CODE.test("  return getProjectWorkDir(projectId);")).toBe(true);

    expect(RETIRED_IN_CODE.test("  const workDir = await getProjectContentRoot(projectId);")).toBe(
      false
    );
    expect(RETIRED_IN_CODE.test("  return getProjectMetaRoot(context.projectId);")).toBe(false);

    expect(ROOT_RESOLVER.test("  return getProjectMetaRoot(context.projectId);")).toBe(true);
    expect(ROOT_RESOLVER.test("  const cwd = resolveContextBaseDir(context);")).toBe(false);
  });

  it("the comment exemption does not swallow a real callsite", () => {
    // `isCommentLine` is the one place this gate could be defeated by
    // accident — a too-greedy rule would exempt live code.
    expect(isCommentLine(" * PM #105 came from `getWorkDir(projectId)` ...")).toBe(true);
    expect(isCommentLine("// const workDir = getWorkDir(projectId);")).toBe(true);
    expect(isCommentLine("  const workDir = getWorkDir(projectId); // legacy")).toBe(false);
  });
});
