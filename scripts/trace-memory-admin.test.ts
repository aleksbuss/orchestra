/**
 * PM #53 — trace-memory CLI stats logic.
 *
 * Pinned: `computeStats` is the only piece of CLI logic worth unit-
 * testing — the I/O wrappers around it are thin shells over `fs`
 * operations. We don't run the CLI subprocess; we exercise the pure
 * function directly.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import {
  computeStats,
  parseScope,
  projectTracesDir,
  dirForScope,
  __cmdListForTests,
  __cmdShowForTests,
  __cmdDeleteForTests,
  __cmdStatsForTests,
} from "./trace-memory-admin";

interface OnDiskTrace {
  id: string;
  userPrompt: string;
  finalText: string;
  qualityScore: number;
  modelConfig: { provider: string; model: string };
  capturedAt: string;
  embedding: number[];
}

function trace(over: Partial<OnDiskTrace>): OnDiskTrace {
  return {
    id: "id1",
    userPrompt: "p",
    finalText: "f",
    qualityScore: 0.8,
    modelConfig: { provider: "openai", model: "gpt-4o" },
    capturedAt: "2026-05-01T10:00:00Z",
    embedding: [1, 0, 0, 0],
    ...over,
  };
}

describe("PM #53 — computeStats", () => {
  it("empty pool → zero totals and zeros across", () => {
    const s = computeStats([]);
    expect(s.total).toBe(0);
    expect(s.scoreMin).toBe(0);
    expect(s.scoreMax).toBe(0);
    expect(s.oldest).toBeUndefined();
    expect(s.newest).toBeUndefined();
  });

  it("median on odd count is the middle value", () => {
    const s = computeStats([
      trace({ qualityScore: 0.7 }),
      trace({ qualityScore: 0.9 }),
      trace({ qualityScore: 0.8 }),
    ]);
    expect(s.scoreMedian).toBeCloseTo(0.8, 5);
  });

  it("median on even count is average of two middles", () => {
    const s = computeStats([
      trace({ qualityScore: 0.7 }),
      trace({ qualityScore: 0.8 }),
      trace({ qualityScore: 0.9 }),
      trace({ qualityScore: 1.0 }),
    ]);
    // 0.8 + 0.9 / 2 = 0.85
    expect(s.scoreMedian).toBeCloseTo(0.85, 5);
  });

  it("scoreMin / scoreMax track the boundaries", () => {
    const s = computeStats([
      trace({ qualityScore: 0.71 }),
      trace({ qualityScore: 0.99 }),
      trace({ qualityScore: 0.85 }),
    ]);
    expect(s.scoreMin).toBeCloseTo(0.71, 5);
    expect(s.scoreMax).toBeCloseTo(0.99, 5);
  });

  it("oldest / newest are the captured-at extremes sorted by ISO order", () => {
    const s = computeStats([
      trace({ capturedAt: "2026-05-03T10:00:00Z" }),
      trace({ capturedAt: "2026-05-01T10:00:00Z" }),
      trace({ capturedAt: "2026-05-02T10:00:00Z" }),
    ]);
    expect(s.oldest).toBe("2026-05-01T10:00:00Z");
    expect(s.newest).toBe("2026-05-03T10:00:00Z");
  });

  it("mean prompt / answer lengths are averaged correctly", () => {
    const s = computeStats([
      trace({ userPrompt: "a".repeat(100), finalText: "b".repeat(200) }),
      trace({ userPrompt: "a".repeat(200), finalText: "b".repeat(400) }),
    ]);
    expect(s.promptLengthMean).toBe(150);
    expect(s.answerLengthMean).toBe(300);
  });

  it("scoreMean is the arithmetic mean", () => {
    const s = computeStats([
      trace({ qualityScore: 0.6 }),
      trace({ qualityScore: 0.8 }),
      trace({ qualityScore: 1.0 }),
    ]);
    expect(s.scoreMean).toBeCloseTo(0.8, 5);
  });
});

describe("PM #55 — parseScope + scope dir resolution", () => {
  it("no flags → global", () => {
    expect(parseScope(["node", "script", "list"])).toEqual({ kind: "global" });
  });

  it("--global → global", () => {
    expect(parseScope(["node", "script", "list", "--global"])).toEqual({
      kind: "global",
    });
  });

  it("--all → all", () => {
    expect(parseScope(["node", "script", "list", "--all"])).toEqual({
      kind: "all",
    });
  });

  it("--project <id> → project scope", () => {
    expect(
      parseScope(["node", "script", "list", "--project", "abc123"])
    ).toEqual({ kind: "project", projectId: "abc123" });
  });

  it("--project with no id → defaults to global (defensive)", () => {
    expect(parseScope(["node", "script", "list", "--project"])).toEqual({
      kind: "global",
    });
  });

  it("--all wins over --project (defensive — both means all)", () => {
    expect(
      parseScope(["node", "script", "list", "--project", "abc", "--all"])
    ).toEqual({ kind: "all" });
  });

  it("projectTracesDir matches the runtime convention", () => {
    const out = projectTracesDir("proj-x");
    expect(out).toMatch(/projects\/proj-x\/\.orchestra_traces$/);
  });

  it("dirForScope global → data/traces", () => {
    expect(dirForScope({ kind: "global" })).toMatch(/data\/traces$/);
  });

  it("dirForScope project → per-project nested path", () => {
    expect(dirForScope({ kind: "project", projectId: "p1" })).toMatch(
      /projects\/p1\/\.orchestra_traces$/
    );
  });
});

// PM #56 — CLI subcommand integration tests. We exercise the public
// handlers with a temp data dir + intercepted stdout to confirm they
// do the right thing on real fs operations. Subprocess invocation
// would be more realistic but slow; the handlers are the actual code
// path the operator hits.
describe("PM #56 — CLI subcommand handlers", () => {
  let tempDir: string;
  let originalDataDir: string | undefined;
  let logs: string[];
  let originalLog: typeof console.log;
  let originalError: typeof console.error;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-trace-test-"));
    originalDataDir = process.env.ORCHESTRA_DATA_DIR;
    process.env.ORCHESTRA_DATA_DIR = tempDir;
    logs = [];
    originalLog = console.log;
    originalError = console.error;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    console.error = (...args: unknown[]) => {
      logs.push("ERROR: " + args.map(String).join(" "));
    };
  });

  afterEach(async () => {
    console.log = originalLog;
    console.error = originalError;
    if (originalDataDir === undefined) {
      delete process.env.ORCHESTRA_DATA_DIR;
    } else {
      process.env.ORCHESTRA_DATA_DIR = originalDataDir;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function seedGlobalTrace(
    id: string,
    score: number,
    promptText = "test prompt"
  ): Promise<void> {
    const dir = path.join(tempDir, "traces");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `${id}.json`),
      JSON.stringify({
        id,
        userPrompt: promptText,
        finalText: "answer",
        qualityScore: score,
        modelConfig: { provider: "openai", model: "gpt-4o" },
        capturedAt: "2026-05-01T12:00:00Z",
        embedding: [1, 0, 0, 0],
      })
    );
  }

  async function seedProjectTrace(
    projectId: string,
    id: string,
    score: number
  ): Promise<void> {
    const dir = path.join(
      tempDir,
      "projects",
      projectId,
      ".orchestra_traces"
    );
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `${id}.json`),
      JSON.stringify({
        id,
        userPrompt: "project prompt",
        finalText: "answer",
        qualityScore: score,
        modelConfig: { provider: "openai", model: "gpt-4o" },
        capturedAt: "2026-05-01T12:00:00Z",
        embedding: [1, 0, 0, 0],
        projectId,
      })
    );
  }

  it("cmdList on empty pool → prints empty marker", async () => {
    const code = await __cmdListForTests({ kind: "global" });
    expect(code).toBe(0);
    expect(logs.some((l) => /no traces.*global pool/i.test(l))).toBe(true);
  });

  it("cmdList prints traces sorted by score descending", async () => {
    await seedGlobalTrace("aaa", 0.75);
    await seedGlobalTrace("bbb", 0.95);
    await seedGlobalTrace("ccc", 0.85);
    const code = await __cmdListForTests({ kind: "global" });
    expect(code).toBe(0);
    // Find row indices in logs.
    const bbbIdx = logs.findIndex((l) => l.startsWith("bbb"));
    const cccIdx = logs.findIndex((l) => l.startsWith("ccc"));
    const aaaIdx = logs.findIndex((l) => l.startsWith("aaa"));
    expect(bbbIdx).toBeGreaterThanOrEqual(0);
    expect(bbbIdx).toBeLessThan(cccIdx);
    expect(cccIdx).toBeLessThan(aaaIdx);
  });

  it("cmdList --all walks global + every project", async () => {
    await seedGlobalTrace("g1", 0.9);
    await seedProjectTrace("proj-a", "a1", 0.85);
    await seedProjectTrace("proj-b", "b1", 0.95);
    const code = await __cmdListForTests({ kind: "all" });
    expect(code).toBe(0);
    expect(logs.some((l) => l.startsWith("g1"))).toBe(true);
    expect(logs.some((l) => l.startsWith("a1"))).toBe(true);
    expect(logs.some((l) => l.startsWith("b1"))).toBe(true);
  });

  it("cmdShow with missing id → error code 1", async () => {
    const code = await __cmdShowForTests(undefined, { kind: "global" });
    expect(code).toBe(1);
    expect(logs.some((l) => l.includes("ERROR:") && l.includes("Usage"))).toBe(
      true
    );
  });

  it("cmdShow with unknown id → error code 1", async () => {
    const code = await __cmdShowForTests("ghost", { kind: "global" });
    expect(code).toBe(1);
    expect(
      logs.some((l) => l.includes("ERROR:") && /No trace.*ghost/i.test(l))
    ).toBe(true);
  });

  it("cmdShow on existing trace prints redacted JSON + scope label", async () => {
    await seedGlobalTrace("zzz", 0.88);
    const code = await __cmdShowForTests("zzz", { kind: "global" });
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toMatch(/"id": "zzz"/);
    expect(out).toMatch(/"scope": "global"/);
    // Embedding redacted to dimension count.
    expect(out).toMatch(/"embedding": "<4-dim vector>"/);
  });

  it("cmdShow finds trace under --all by walking scopes", async () => {
    await seedProjectTrace("proj-x", "xxx", 0.91);
    const code = await __cmdShowForTests("xxx", { kind: "all" });
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toMatch(/"scope": "proj-x"/);
  });

  it("cmdDelete refuses --all", async () => {
    const code = await __cmdDeleteForTests("xxx", { kind: "all" });
    expect(code).toBe(1);
    expect(
      logs.some((l) => l.includes("ERROR:") && /Refusing.*--all/i.test(l))
    ).toBe(true);
  });

  it("cmdDelete removes file from project pool", async () => {
    await seedProjectTrace("proj-x", "kill-me", 0.8);
    const code = await __cmdDeleteForTests("kill-me", {
      kind: "project",
      projectId: "proj-x",
    });
    expect(code).toBe(0);
    // File must be gone.
    const filePath = path.join(
      tempDir,
      "projects",
      "proj-x",
      ".orchestra_traces",
      "kill-me.json"
    );
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it("cmdStats on empty pool → prints scope header but no body", async () => {
    const code = await __cmdStatsForTests({ kind: "global" });
    expect(code).toBe(0);
    expect(logs.some((l) => /Scope.*global pool/i.test(l))).toBe(true);
    expect(logs.some((l) => /no traces.*empty/i.test(l))).toBe(true);
  });

  it("cmdStats prints score range when traces exist", async () => {
    await seedGlobalTrace("a", 0.71);
    await seedGlobalTrace("b", 0.95);
    const code = await __cmdStatsForTests({ kind: "global" });
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toMatch(/Total traces:\s+2/);
    expect(out).toMatch(/0\.71/);
    expect(out).toMatch(/0\.95/);
  });
});
