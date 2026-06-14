/**
 * Structural security gate (PM #28 / #70).
 *
 * CLAUDE.md asks reviewers to run a "pre-merge grep BOTH forms" for
 * `...process.env` / `env: process.env` before every PR. A human-run grep is
 * exactly the control that gets skipped under deadline pressure — the same
 * failure mode PM #70 hit when the `env: process.env` form slipped past review.
 * This test makes the grep a CI gate instead.
 *
 * Invariant: ALL agent-spawned child processes (python/node/shell runners, the
 * install orchestrator, the codex/gemini CLI subprocesses) MUST build their env
 * via the scrubbers in `scrub-env.ts`, NEVER by spreading the operator's full
 * `process.env` — that ships live API keys into a sandboxed / agent-controlled
 * process. Reading a SINGLE var (`process.env.FOO`) is fine; spreading or
 * assigning the WHOLE object is the leak.
 *
 * Scope: `src/lib/tools` (child-process tools) and `src/lib/providers`
 * (codex/gemini CLI subprocess env, PM #70). Test files are excluded — they
 * legitimately snapshot/restore `process.env`. `scrub-env.ts` is the single
 * module allowed to touch `process.env` directly (and it iterates via
 * `Object.entries`, never spreads).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOTS = ["src/lib/tools", "src/lib/providers"];

// `process.env` followed by `.`/word char is a single-var read (legitimate);
// the negative lookahead restricts the match to the WHOLE-object forms.
const FORBIDDEN: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /\.\.\.process\.env(?![.\w])/, label: "...process.env (spread)" },
  { re: /env\s*:\s*process\.env(?![.\w])/, label: "env: process.env (assign)" },
];

// The one module allowed to read process.env directly (the scrubber itself).
const ALLOWLIST = new Set([path.normalize("src/lib/security/scrub-env.ts")]);

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("PM #28/#70 — no raw process.env spread in agent-spawned process env", () => {
  const files = ROOTS.flatMap((root) =>
    fs.existsSync(root) ? collectTsFiles(root) : []
  ).filter((f) => !ALLOWLIST.has(path.normalize(f)));

  it("scans a non-trivial number of files (guards against a broken glob)", () => {
    // A silently-empty scan would make the gate below vacuously pass — the
    // exact false-confidence failure F-13 warned about. Pin a floor.
    expect(files.length).toBeGreaterThan(10);
  });

  it("finds no whole-object process.env spread/assign outside the scrubber", () => {
    const violations: string[] = [];
    for (const file of files) {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((rawLine, idx) => {
        // Drop a trailing `//` line comment so an explanatory comment that
        // names the pattern doesn't trip the gate; code before `//` still scans.
        const code = rawLine.replace(/\/\/.*$/, "");
        for (const { re, label } of FORBIDDEN) {
          if (re.test(code)) {
            violations.push(`${file}:${idx + 1} [${label}] ${rawLine.trim()}`);
          }
        }
      });
    }
    expect(
      violations,
      "Spreading/assigning the whole process.env leaks the operator's secrets " +
        "into a child process. Use scrubProcessEnv({...}) from scrub-env.ts.\n" +
        `Offenders:\n${violations.join("\n")}`
    ).toEqual([]);
  });
});
