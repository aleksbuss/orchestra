/**
 * Compiler evidence for the reflection critic (DDD roadmap Phase 4 — CORRECTED).
 *
 * The original plan wanted a `sandbox/executor.ts` that runs `tsc --noEmit` as
 * an ARBITER: "if the compiler passes, auto-reject the Skeptic's verdict". That
 * inverts safety — compiling ≠ correct, and it is the exact anti-pattern the
 * PM #80/#84 doctrine rejected (deterministic checks are ADVISORY signals, never
 * hard-gates over judgment). It also duplicated two existing primitives: the
 * PM #80 post-write syntax check and the `code_execution` tool.
 *
 * The corrected design keeps the valuable half: give the critic DETERMINISTIC
 * ground truth about syntax so it (a) never hallucinates syntax errors that
 * aren't there (a real failure mode — `reviseWithCritique` even has a
 * `cannot_fix` escape hatch for hallucinated critiques), and (b) never blesses
 * code the parser rejects. The critic keeps full authority over logic /
 * security / architecture — the evidence is an INPUT, not a verdict.
 *
 * Reuses the PM #80 checker (`verifyWrittenSource`) — one syntax-check
 * implementation in the codebase, per the "use the existing pattern" rule.
 * In-process TS parser only: no child process, no Docker, no new module tree.
 */
import { verifyWrittenSource } from "@/lib/tools/post-write-verify";

/** Fenced code block: ```lang\n...``` — lang tag optional. */
const FENCE_RE = /```([a-zA-Z0-9_-]*)[^\S\n]*\n([\s\S]*?)```/g;

/**
 * Map a fence language tag to a synthetic filename whose extension routes it
 * through the right `verifyWrittenSource` checker. Unlisted tags (python,
 * bash, prose, untagged) are skipped — we only have a TS/JS/JSON parser.
 */
const LANG_TO_FILENAME: Record<string, string> = {
  ts: "block.ts",
  typescript: "block.ts",
  tsx: "block.tsx",
  js: "block.js",
  javascript: "block.js",
  mjs: "block.js",
  cjs: "block.js",
  jsx: "block.jsx",
  json: "block.json",
};

/** Check at most this many blocks — a draft with 10 snippets doesn't need 10 parses. */
const MAX_CHECKED_BLOCKS = 3;
/** Skip pathological single blocks; parsing a huge dump isn't worth the CPU. */
const MAX_BLOCK_CHARS = 20_000;

/**
 * Extract fenced TS/JS/JSON blocks from a draft response and syntax-check each.
 *
 * Returns a compact per-block report ("Code block #2 (ts): Syntax error(s)…")
 * or `null` when the draft contains nothing checkable. Block numbers count ALL
 * fenced blocks in order of appearance so the critic can match them against
 * what it reads in the draft.
 *
 * Never throws and never blocks reflection — any internal failure returns null
 * (same fail-safe posture as `verifyWrittenSource` itself).
 */
export async function collectCompilerEvidence(
  draft: string
): Promise<string | null> {
  try {
    const findings: string[] = [];
    let checked = 0;
    let blockIndex = 0;
    // Fresh regex per call — module-level lastIndex would leak across calls.
    const re = new RegExp(FENCE_RE.source, "g");
    let match: RegExpExecArray | null;
    while ((match = re.exec(draft)) !== null && checked < MAX_CHECKED_BLOCKS) {
      blockIndex += 1;
      const lang = (match[1] || "").toLowerCase();
      const fileName = LANG_TO_FILENAME[lang];
      if (!fileName) continue;
      const code = match[2];
      if (!code.trim() || code.length > MAX_BLOCK_CHARS) continue;
      const verdict = await verifyWrittenSource(fileName, code);
      if (!verdict) continue;
      checked += 1;
      findings.push(
        verdict.valid
          ? `Code block #${blockIndex} (${verdict.language}): parses clean — no syntax errors.`
          : `Code block #${blockIndex} (${verdict.language}): ${verdict.diagnostics}`
      );
    }
    return findings.length > 0 ? findings.join("\n") : null;
  } catch {
    return null;
  }
}

/**
 * Wrap the evidence for injection into the critic's user message. The framing
 * matters: the parser is authoritative for SYNTAX ONLY, and explicitly not a
 * verdict on the draft — the PM #84 "advisory, never a hard-gate" posture.
 */
export function formatCompilerEvidenceSection(evidence: string): string {
  return (
    `\n\n## Deterministic compiler evidence (syntax-only, advisory):\n${evidence}\n` +
    `This comes from the TypeScript parser, not an LLM. For SYNTAX questions trust it over ` +
    `your own reading of the code — do NOT invent syntax errors it does not report, and do ` +
    `NOT dismiss errors it does report. It says NOTHING about logic, security, performance, ` +
    `or runtime behavior — audit those yourself; a draft that parses clean can still be wrong.`
  );
}
