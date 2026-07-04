/**
 * reflection-evidence.test.ts — compiler evidence for the reflection critic
 * (DDD Phase 4, corrected: advisory input to the Skeptic, never a verdict).
 *
 * Uses the REAL TypeScript parser via `verifyWrittenSource` — no mocks; the
 * value of the module IS the deterministic parse, so we test the real thing.
 */
import { describe, it, expect } from "vitest";
import {
  collectCompilerEvidence,
  formatCompilerEvidenceSection,
} from "./reflection-evidence";

const VALID_TS = "export function add(a: number, b: number): number {\n  return a + b;\n}";
const BROKEN_TS = "export function add(a: number {\n  return a + ;\n}";

describe("collectCompilerEvidence — fenced-block extraction + syntax check", () => {
  it("valid ts block → 'parses clean' evidence", async () => {
    const draft = "Here is the fix:\n```ts\n" + VALID_TS + "\n```\nDone.";
    const evidence = await collectCompilerEvidence(draft);
    expect(evidence).toContain("Code block #1 (ts)");
    expect(evidence).toContain("parses clean");
  });

  it("broken ts block → diagnostics with line:col", async () => {
    const draft = "```typescript\n" + BROKEN_TS + "\n```";
    const evidence = await collectCompilerEvidence(draft);
    expect(evidence).toContain("Code block #1 (ts)");
    expect(evidence).toContain("Syntax error");
    expect(evidence).toMatch(/line \d+:\d+/);
  });

  it("invalid json block → 'Invalid JSON' evidence", async () => {
    const draft = '```json\n{"a": 1,}\n```';
    const evidence = await collectCompilerEvidence(draft);
    expect(evidence).toContain("Invalid JSON");
  });

  it("block numbering counts ALL fenced blocks so #N matches the draft", async () => {
    // Block #1 is python (skipped), #2 is the checkable ts block.
    const draft =
      "```python\nprint('hi')\n```\ntext\n```ts\n" + BROKEN_TS + "\n```";
    const evidence = await collectCompilerEvidence(draft);
    expect(evidence).toContain("Code block #2 (ts)");
    expect(evidence).not.toContain("Code block #1");
  });

  it("returns null when nothing is checkable (prose, python, untagged fences)", async () => {
    expect(await collectCompilerEvidence("just prose, no code")).toBeNull();
    expect(
      await collectCompilerEvidence("```python\nprint('x')\n```")
    ).toBeNull();
    expect(await collectCompilerEvidence("```\nuntagged\n```")).toBeNull();
  });

  it("caps at 3 checked blocks", async () => {
    const block = "```ts\n" + VALID_TS + "\n```\n";
    const evidence = await collectCompilerEvidence(block.repeat(5));
    expect(evidence).not.toBeNull();
    const count = (evidence as string).match(/Code block #/g)?.length ?? 0;
    expect(count).toBe(3);
  });

  it("skips oversized and empty blocks without failing the rest", async () => {
    const huge = "```ts\n" + "const x = 1;\n".repeat(3000) + "```\n";
    const draft = huge + "```ts\n" + VALID_TS + "\n```";
    const evidence = await collectCompilerEvidence(draft);
    // Only the small block produced evidence (numbered #2 — the huge one is #1).
    expect(evidence).toContain("Code block #2 (ts)");
    expect(evidence).not.toContain("Code block #1");
  });
});

describe("formatCompilerEvidenceSection — advisory framing (PM #84 posture)", () => {
  it("frames the evidence as syntax-only and NOT a verdict on logic/security", () => {
    const section = formatCompilerEvidenceSection("Code block #1 (ts): parses clean");
    expect(section).toContain("syntax-only, advisory");
    expect(section).toContain("do NOT invent syntax errors");
    expect(section).toContain("audit those yourself");
  });
});
