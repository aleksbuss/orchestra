/**
 * Tests for the cron run-log — append-only JSONL with size-based pruning.
 *
 * Pinned invariants:
 *   - Append creates the parent dir on demand.
 *   - Concurrent appends to the same path are serialized (the in-module
 *     `writesByPath` queue) so we never tear a JSON line.
 *   - Pruning kicks in when the file exceeds `maxBytes`, keeps the last
 *     `keepLines` entries.
 *   - `readCronRunLogEntries` returns most-recent-first, drops malformed
 *     lines, and respects `limit`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { appendCronRunLog, readCronRunLogEntries } from "./run-log";
import type { CronRunLogEntry } from "@/lib/cron/types";

let tmpRoot: string;
let logPath: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-runlog-"));
  logPath = path.join(tmpRoot, "j1.jsonl");
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function entry(overrides: Partial<CronRunLogEntry> = {}): CronRunLogEntry {
  return {
    ts: Date.now(),
    jobId: "j1",
    projectId: "proj",
    status: "ok",
    ...overrides,
  } as CronRunLogEntry;
}

describe("appendCronRunLog", () => {
  it("creates the parent dir if missing", async () => {
    const nested = path.join(tmpRoot, "deep", "nest", "j1.jsonl");
    await appendCronRunLog(nested, entry());
    const stat = await fs.stat(nested);
    expect(stat.isFile()).toBe(true);
  });

  it("appends one JSON line per call, terminated by \\n", async () => {
    await appendCronRunLog(logPath, entry({ status: "ok" }));
    await appendCronRunLog(logPath, entry({ status: "error" }));
    const raw = await fs.readFile(logPath, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    JSON.parse(lines[0]);
    JSON.parse(lines[1]);
  });

  it("serializes concurrent writes to the same path (no torn lines)", async () => {
    // Fire 30 appends in parallel. Without the per-path queue, two
    // appendFile calls could interleave and produce a half-written line.
    await Promise.all(
      Array.from({ length: 30 }, (_, i) => appendCronRunLog(logPath, entry({ ts: i })))
    );
    const raw = await fs.readFile(logPath, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    expect(lines).toHaveLength(30);
    for (const line of lines) {
      // Every line must parse; a torn line would throw here.
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

describe("appendCronRunLog — pruning", () => {
  it("prunes when the file grows past `maxBytes`, keeping the last `keepLines`", async () => {
    // Write 50 entries with a tight maxBytes so pruning fires. Keep last 5.
    for (let i = 0; i < 50; i++) {
      await appendCronRunLog(
        logPath,
        entry({ ts: i }),
        { maxBytes: 200, keepLines: 5 }
      );
    }
    const raw = await fs.readFile(logPath, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(5);

    // The kept lines must be the LAST ones — pruning preserves recency.
    const tsValues = lines.map((l) => (JSON.parse(l) as CronRunLogEntry).ts);
    const sorted = [...tsValues].sort((a, b) => a - b);
    expect(tsValues).toEqual(sorted);
    expect(tsValues[tsValues.length - 1]).toBe(49);
  });

  it("does not prune when below `maxBytes` (default budget is generous)", async () => {
    for (let i = 0; i < 5; i++) {
      await appendCronRunLog(logPath, entry({ ts: i }));
    }
    const raw = await fs.readFile(logPath, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    expect(lines).toHaveLength(5);
  });
});

describe("readCronRunLogEntries", () => {
  it("returns [] for a missing file", async () => {
    expect(await readCronRunLogEntries(path.join(tmpRoot, "nope.jsonl"))).toEqual([]);
  });

  it("returns entries in INSERTION order (oldest at index 0, newest last)", async () => {
    for (let i = 0; i < 4; i++) {
      await appendCronRunLog(logPath, entry({ ts: i, jobId: `j-${i}` }));
    }
    const out = await readCronRunLogEntries(logPath);
    expect(out).toHaveLength(4);
    // The implementation walks the file from the END backwards and pushes,
    // then `.reverse()` — net effect: oldest first, newest last.
    expect(out[0].ts).toBe(0);
    expect(out[3].ts).toBe(3);
  });

  it("respects `limit` — truncates from the START (drops oldest), keeps newest", async () => {
    for (let i = 0; i < 10; i++) {
      await appendCronRunLog(logPath, entry({ ts: i }));
    }
    const out = await readCronRunLogEntries(logPath, { limit: 3 });
    expect(out).toHaveLength(3);
    // Newest 3: ts 7, 8, 9
    expect(out.map((e) => e.ts)).toEqual([7, 8, 9]);
  });

  it("skips malformed JSON lines without crashing", async () => {
    await fs.writeFile(
      logPath,
      [
        JSON.stringify(entry({ ts: 1 })),
        "this is not json",
        JSON.stringify(entry({ ts: 2 })),
        "{ broken",
      ].join("\n") + "\n",
      "utf-8"
    );
    const out = await readCronRunLogEntries(logPath);
    expect(out.map((e) => e.ts).sort()).toEqual([1, 2]);
  });

  it("rejects entries that don't match the expected shape (defensive)", async () => {
    await fs.writeFile(
      logPath,
      [
        JSON.stringify({ ts: 1, jobId: "j", projectId: "p", status: "ok" }),
        JSON.stringify({ ts: "not-a-number", jobId: "j", projectId: "p", status: "ok" }),
        JSON.stringify({ ts: 2, jobId: "j", projectId: "p", status: "weird-status" }),
      ].join("\n") + "\n",
      "utf-8"
    );
    const out = await readCronRunLogEntries(logPath);
    expect(out).toHaveLength(1);
    expect(out[0].ts).toBe(1);
  });
});
