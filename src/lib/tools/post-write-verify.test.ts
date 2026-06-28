import { describe, it, expect } from "vitest";
import { verifyWrittenSource } from "@/lib/tools/post-write-verify";

describe("verifyWrittenSource (PM #80 grounding signal)", () => {
  it("passes syntactically valid TypeScript", async () => {
    const result = await verifyWrittenSource(
      "/proj/src/types.ts",
      `export type AttackType = 'spam' | 'links' | 'obfuscated' | 'mixed';\n` +
        `export interface Job { id: string; count: number; mode: AttackType; }\n`
    );
    expect(result?.valid).toBe(true);
    expect(result?.language).toBe("ts");
    expect(result?.diagnostics).toBeUndefined();
  });

  it("flags the exact production corruption signature as invalid", async () => {
    // The mangled blob qwen3-coder actually wrote in the looping chat: clean TS
    // unions/interface restructured into nested arrays with literal `\n` and
    // mismatched quotes, ending in an unterminated string literal.
    const mangled =
      `[["spam' | 'links' | 'obfuscated' | 'mixed' | 'advanced_spam", ` +
      `'AgentMode": "bot' | 'userbot', 'AttackStatus": "idle' | 'running'], ` +
      `['id": "string\\n  chatId: string\\n  count: number`;
    const result = await verifyWrittenSource("/proj/src/types.ts", mangled);
    expect(result?.valid).toBe(false);
    expect(result?.diagnostics).toBeTruthy();
    expect(result?.hint).toContain("Do NOT rewrite the whole file");
  });

  it("reports a line:col position for a broken TS file", async () => {
    const result = await verifyWrittenSource(
      "/proj/src/broken.ts",
      `export function f( {\n  return 1;\n`
    );
    expect(result?.valid).toBe(false);
    expect(result?.diagnostics).toMatch(/line \d+:\d+/);
  });

  it("passes valid TSX (JSX parsed in .tsx mode)", async () => {
    const result = await verifyWrittenSource(
      "/proj/src/comp.tsx",
      `export const C = () => <div className="x">hi {1 + 2}</div>;\n`
    );
    expect(result?.valid).toBe(true);
    expect(result?.language).toBe("tsx");
  });

  it("passes valid JS", async () => {
    const result = await verifyWrittenSource(
      "/proj/s.js",
      `const x = [1, 2, 3].map((n) => n * 2);\nmodule.exports = { x };\n`
    );
    expect(result?.valid).toBe(true);
  });

  it("validates JSON and flags broken JSON", async () => {
    expect((await verifyWrittenSource("/proj/a.json", `{"a":1,"b":[2,3]}`))?.valid).toBe(true);
    const bad = await verifyWrittenSource("/proj/a.json", `{"a":1,]`);
    expect(bad?.valid).toBe(false);
    expect(bad?.diagnostics).toContain("Invalid JSON");
  });

  it("skips non-source files (returns null — no noise on .md/.txt)", async () => {
    expect(await verifyWrittenSource("/proj/README.md", `# Title\n\n[[not code]] 'x`)).toBeNull();
    expect(await verifyWrittenSource("/proj/notes.txt", `whatever ['x' | 'y`)).toBeNull();
  });

  it("skips empty and oversized content", async () => {
    expect(await verifyWrittenSource("/proj/a.ts", "   \n  ")).toBeNull();
    expect(await verifyWrittenSource("/proj/a.ts", "a".repeat(200_001))).toBeNull();
  });
});
