/**
 * Tests for the log-query helpers — every filter rule the Orchestra MCP
 * server (Sprint 4) exposes to Claude Code is decided by these pure
 * functions. A regression here means I see wrong logs and debug the
 * wrong thing.
 */
import { describe, it, expect } from "vitest";
import {
  parseJsonlLines,
  filterLogEntries,
  getLogDayKey,
  getLogFilenamesInRange,
  takeLast,
  type LogEntry,
} from "./log-query";

const sample: LogEntry = {
  ts: "2026-05-09T10:00:00.000Z",
  level: "info",
  event: "agent_started",
  traceId: "T-1",
  chatId: "c-1",
};

const jsonl = (entries: Array<Partial<LogEntry>>) =>
  entries.map((e) => JSON.stringify(e)).join("\n") + "\n";

describe("parseJsonlLines — robustness", () => {
  it("returns [] for empty input (no implicit one-empty-entry)", () => {
    expect(parseJsonlLines("")).toEqual([]);
    expect(parseJsonlLines("\n\n")).toEqual([]);
  });

  it("parses one entry per JSON line", () => {
    const out = parseJsonlLines(jsonl([sample, { ...sample, ts: "2026-05-09T10:00:01.000Z" }]));
    expect(out).toHaveLength(2);
    expect(out[0].traceId).toBe("T-1");
  });

  it("skips malformed JSON lines without dropping good ones", () => {
    const text = [
      JSON.stringify(sample),
      "this-is-not-json",
      JSON.stringify({ ...sample, event: "after_torn_line" }),
      "{ broken",
    ].join("\n");
    const out = parseJsonlLines(text);
    expect(out.map((e) => e.event)).toEqual(["agent_started", "after_torn_line"]);
  });

  it("rejects entries missing required fields (ts/level/event)", () => {
    const text = [
      JSON.stringify({ level: "info", event: "no_ts" }),
      JSON.stringify({ ts: "x", event: "no_level" }),
      JSON.stringify({ ts: "x", level: "info" }), // no event
      JSON.stringify(sample),
    ].join("\n");
    expect(parseJsonlLines(text)).toHaveLength(1);
  });

  it("rejects entries with an unknown level (defends against type widening)", () => {
    // If a future logger adds `level: "trace"`, the MCP API surface should
    // require the closed-set update before silently shipping it.
    const text = JSON.stringify({ ...sample, level: "trace" }) + "\n";
    expect(parseJsonlLines(text)).toEqual([]);
  });

  it("trims whitespace around lines (handles CRLF and trailing spaces)", () => {
    const out = parseJsonlLines(`  ${JSON.stringify(sample)}  \r\n`);
    expect(out).toHaveLength(1);
  });
});

describe("filterLogEntries — single-axis filters", () => {
  const entries: LogEntry[] = [
    { ts: "2026-05-09T10:00:00.000Z", level: "info", event: "a", traceId: "T-1", chatId: "c-1" },
    { ts: "2026-05-09T10:00:01.000Z", level: "warn", event: "b", traceId: "T-1", chatId: "c-2" },
    { ts: "2026-05-09T10:00:02.000Z", level: "error", event: "c", traceId: "T-2", chatId: "c-1" },
    { ts: "2026-05-09T10:00:03.000Z", level: "debug", event: "d_inner", traceId: "T-2", chatId: "c-3" },
  ];

  it("traceId filter — exact match", () => {
    expect(filterLogEntries(entries, { traceId: "T-1" }).map((e) => e.event)).toEqual(["a", "b"]);
  });

  it("chatId filter — exact match", () => {
    expect(filterLogEntries(entries, { chatId: "c-1" }).map((e) => e.event)).toEqual(["a", "c"]);
  });

  it('minLevel="warn" returns warn + error only', () => {
    expect(filterLogEntries(entries, { minLevel: "warn" }).map((e) => e.level)).toEqual(["warn", "error"]);
  });

  it('minLevel="error" returns error only', () => {
    expect(filterLogEntries(entries, { minLevel: "error" }).map((e) => e.level)).toEqual(["error"]);
  });

  it('minLevel="debug" (default) returns everything', () => {
    expect(filterLogEntries(entries).length).toBe(4);
    expect(filterLogEntries(entries, { minLevel: "debug" }).length).toBe(4);
  });

  it("contains — case-insensitive substring on event OR msg", () => {
    expect(filterLogEntries(entries, { contains: "INNER" }).map((e) => e.event)).toEqual(["d_inner"]);
    expect(filterLogEntries(entries, { contains: "absent" })).toEqual([]);
  });

  it("contains — also matches against `msg` not just `event`", () => {
    const withMsg: LogEntry[] = [
      { ts: "x", level: "info", event: "evt", msg: "Look for THIS string" },
    ];
    expect(filterLogEntries(withMsg, { contains: "this string" })).toHaveLength(1);
  });

  it("sinceTs / untilTs — strict bounds on ts (lexicographic on ISO string is correct)", () => {
    const out = filterLogEntries(entries, {
      sinceTs: "2026-05-09T10:00:01.000Z",
      untilTs: "2026-05-09T10:00:02.000Z",
    });
    expect(out.map((e) => e.event)).toEqual(["b", "c"]);
  });
});

describe("filterLogEntries — composite filters", () => {
  const entries: LogEntry[] = [
    { ts: "2026-05-09T10:00:00.000Z", level: "info", event: "a", traceId: "T-1", chatId: "c-1" },
    { ts: "2026-05-09T10:00:01.000Z", level: "error", event: "b", traceId: "T-1", chatId: "c-1" },
    { ts: "2026-05-09T10:00:02.000Z", level: "error", event: "c", traceId: "T-2", chatId: "c-2" },
  ];

  it("traceId AND minLevel AND chatId compose with AND semantics", () => {
    const out = filterLogEntries(entries, {
      traceId: "T-1",
      minLevel: "error",
      chatId: "c-1",
    });
    expect(out.map((e) => e.event)).toEqual(["b"]);
  });

  it("returns input order (no implicit re-sort)", () => {
    // We rely on this in the MCP `tail` tool — the JSONL file is already
    // chronologically ordered by writer; reversing here would surprise.
    const reordered = [...entries].reverse();
    const out = filterLogEntries(reordered);
    expect(out).toEqual(reordered);
  });
});

describe("getLogDayKey", () => {
  it("returns YYYY-MM-DD in UTC", () => {
    expect(getLogDayKey(new Date("2026-05-09T23:59:59.999Z"))).toBe("2026-05-09");
    expect(getLogDayKey(new Date("2026-05-10T00:00:00.001Z"))).toBe("2026-05-10");
  });
});

describe("getLogFilenamesInRange", () => {
  it("single-day range returns one filename", () => {
    const day = new Date("2026-05-09T05:00:00.000Z");
    expect(getLogFilenamesInRange(day, day)).toEqual(["orchestra-2026-05-09.jsonl"]);
  });

  it("multi-day range returns one filename per UTC day, ordered ascending", () => {
    const a = new Date("2026-05-09T23:30:00.000Z");
    const b = new Date("2026-05-12T00:30:00.000Z");
    expect(getLogFilenamesInRange(a, b)).toEqual([
      "orchestra-2026-05-09.jsonl",
      "orchestra-2026-05-10.jsonl",
      "orchestra-2026-05-11.jsonl",
      "orchestra-2026-05-12.jsonl",
    ]);
  });

  it("inverted range (since > until) returns []", () => {
    const a = new Date("2026-05-10T00:00:00.000Z");
    const b = new Date("2026-05-09T00:00:00.000Z");
    expect(getLogFilenamesInRange(a, b)).toEqual([]);
  });

  it("caps the result at 365 entries (defends against accidentally-huge ranges)", () => {
    const a = new Date("2024-01-01T00:00:00.000Z");
    const b = new Date("2030-01-01T00:00:00.000Z");
    const out = getLogFilenamesInRange(a, b);
    expect(out.length).toBeLessThanOrEqual(366); // cap is exclusive but adjacent
  });
});

describe("takeLast", () => {
  it("returns the trailing N items in input order", () => {
    expect(takeLast([1, 2, 3, 4, 5], 3)).toEqual([3, 4, 5]);
  });

  it("returns the full list when N >= length", () => {
    expect(takeLast([1, 2, 3], 10)).toEqual([1, 2, 3]);
  });

  it("returns [] for N <= 0", () => {
    expect(takeLast([1, 2, 3], 0)).toEqual([]);
    expect(takeLast([1, 2, 3], -5)).toEqual([]);
  });
});
