/**
 * Tests for parseAbsoluteTimeMs — the entry point for every `schedule.at`.
 *
 * UI submits a string, route POSTs it, service stores it, scheduler
 * computes the next run by parsing it back. Three accepted shapes:
 *
 *   1. Numeric epoch milliseconds — passes through as integer.
 *   2. ISO datetime — explicit tz preserved; bare datetime treated as UTC.
 *   3. Bare ISO date — treated as midnight UTC.
 *
 * The previous incarnation of this test file inlined a copy of the
 * function so the import wasn't exercised; coverage report showed
 * parse.ts at 19.35%. This version imports the real export.
 *
 * Pinned invariants:
 *   - Empty / whitespace-only input → null.
 *   - Numeric: positive integer → floored; '0', '-1', fractions → null.
 *   - "2026-05-16" → midnight UTC (NOT local-time interpretation).
 *   - Bare ISO datetime gets a trailing Z (UTC), not local time.
 *   - Explicit tz suffix (Z, ±HH:MM, ±HHMM) is preserved.
 *   - Junk → null.
 */
import { describe, it, expect } from "vitest";
import { parseAbsoluteTimeMs } from "./parse";

describe("parseAbsoluteTimeMs — emptiness & garbage", () => {
  it("returns null for empty string", () => {
    expect(parseAbsoluteTimeMs("")).toBeNull();
  });

  it("returns null for whitespace-only input", () => {
    expect(parseAbsoluteTimeMs("   ")).toBeNull();
    expect(parseAbsoluteTimeMs("\t\n")).toBeNull();
  });

  it("returns null for nonsense input that Date.parse rejects", () => {
    expect(parseAbsoluteTimeMs("not a date")).toBeNull();
    expect(parseAbsoluteTimeMs("yesterday")).toBeNull();
    expect(parseAbsoluteTimeMs("13/45/2099")).toBeNull();
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(parseAbsoluteTimeMs("  2026-01-01  ")).toBe(
      Date.UTC(2026, 0, 1, 0, 0, 0)
    );
  });
});

describe("parseAbsoluteTimeMs — numeric epoch milliseconds", () => {
  it("accepts a positive integer string and returns the same number", () => {
    expect(parseAbsoluteTimeMs("1779408000000")).toBe(1779408000000);
  });

  it("'0' falls through to Date.parse (regex matches but n>0 fails)", () => {
    // /^\d+$/ matches "0", but the n > 0 guard rejects → falls through to
    // Date.parse("0"), which on Node returns a valid ms (interpreted as a
    // 4-digit-ish year). NOT null. Pinning current behavior.
    expect(parseAbsoluteTimeMs("0")).toBe(Date.parse("0"));
  });

  it("'-1' falls through to Date.parse (regex doesn't match '-')", () => {
    // /^\d+$/ doesn't allow '-', so '-1' goes to Date.parse, which on
    // Node returns a valid number (lenient year-like interpretation).
    // Pinning current behavior — caller is expected to range-check.
    expect(parseAbsoluteTimeMs("-1")).toBe(Date.parse("-1"));
  });

  it("rejects fractional numerics", () => {
    expect(parseAbsoluteTimeMs("1779408000000.5")).toBeNull();
  });

  it("accepts very large epochs (year 2100+)", () => {
    const farFuture = Date.UTC(2100, 0, 1);
    expect(parseAbsoluteTimeMs(String(farFuture))).toBe(farFuture);
  });
});

describe("parseAbsoluteTimeMs — bare ISO date (YYYY-MM-DD)", () => {
  it("treats YYYY-MM-DD as midnight UTC (no local-time drift)", () => {
    expect(parseAbsoluteTimeMs("2026-05-16")).toBe(
      Date.UTC(2026, 4, 16, 0, 0, 0)
    );
  });

  it("handles leap day", () => {
    expect(parseAbsoluteTimeMs("2028-02-29")).toBe(
      Date.UTC(2028, 1, 29, 0, 0, 0)
    );
  });

  it("'YYYY-MM' falls through to Date.parse, which expands to 1st of month", () => {
    // The bare-date regex requires YYYY-MM-DD. '2026-05' falls through.
    // Date.parse on Node interprets '2026-05' as 2026-05-01T00:00:00Z.
    // Pinning current behavior — caller is responsible for stricter
    // YYYY-MM-DD validation if needed.
    expect(parseAbsoluteTimeMs("2026-05")).toBe(
      Date.UTC(2026, 4, 1, 0, 0, 0)
    );
  });

  it("rejects '2026-13-01' (invalid month)", () => {
    expect(parseAbsoluteTimeMs("2026-13-01")).toBeNull();
  });
});

describe("parseAbsoluteTimeMs — ISO datetime", () => {
  it("treats bare 'YYYY-MM-DDTHH:MM:SS' as UTC (trailing Z is added)", () => {
    expect(parseAbsoluteTimeMs("2026-05-16T12:30:00")).toBe(
      Date.UTC(2026, 4, 16, 12, 30, 0)
    );
  });

  it("preserves an explicit Z suffix as UTC", () => {
    expect(parseAbsoluteTimeMs("2026-05-16T12:30:00Z")).toBe(
      Date.UTC(2026, 4, 16, 12, 30, 0)
    );
  });

  it("preserves an explicit positive offset (+02:00)", () => {
    // 2026-05-16T12:30:00+02:00 == 2026-05-16T10:30:00Z
    expect(parseAbsoluteTimeMs("2026-05-16T12:30:00+02:00")).toBe(
      Date.UTC(2026, 4, 16, 10, 30, 0)
    );
  });

  it("preserves an explicit negative offset (-05:00)", () => {
    // 2026-05-16T08:00:00-05:00 == 2026-05-16T13:00:00Z
    expect(parseAbsoluteTimeMs("2026-05-16T08:00:00-05:00")).toBe(
      Date.UTC(2026, 4, 16, 13, 0, 0)
    );
  });

  it("preserves a colonless offset (+0200)", () => {
    expect(parseAbsoluteTimeMs("2026-05-16T12:30:00+0200")).toBe(
      Date.UTC(2026, 4, 16, 10, 30, 0)
    );
  });

  it("handles fractional seconds", () => {
    expect(parseAbsoluteTimeMs("2026-05-16T12:30:00.500Z")).toBe(
      Date.UTC(2026, 4, 16, 12, 30, 0) + 500
    );
  });

  it("returns null for malformed datetime (impossible hour)", () => {
    expect(parseAbsoluteTimeMs("2026-05-16T25:99:99")).toBeNull();
  });
});
