import { parseAbsoluteTimeMs } from "@/lib/cron/parse";
import type { CronSchedule } from "@/lib/cron/types";

const MINUTE_MS = 60_000;
const MAX_CRON_LOOKAHEAD_MINUTES = 60 * 24 * 366 * 2; // 2 years

// Max possible day-of-month per month (1-indexed; Feb uses 29 to stay
// leap-year-lenient). Used to reject structurally impossible day×month combos.
const MAX_DAY_IN_MONTH = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * PM #74 — true if SOME (day-of-month, month) pair from the two sets can ever
 * occur. "30 2 *" (Feb 30) / "31 4 *" (Apr 31) are structurally impossible: the
 * minute-by-minute lookahead would otherwise scan all ~1,054,080 minutes of the
 * 2-year cap — each doing an Intl.formatToParts — ≈100s of CPU. This bails in O(1).
 * The matcher uses AND semantics for day-of-month × month, so an impossible combo
 * can never match regardless of day-of-week.
 */
function isDayMonthFeasible(dayOfMonth: Set<number>, month: Set<number>): boolean {
  for (const m of month) {
    const maxDay = MAX_DAY_IN_MONTH[m] ?? 31;
    for (const d of dayOfMonth) {
      if (d <= maxDay) return true;
    }
  }
  return false;
}

type ZonedDateParts = {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
};

type CronMatcher = {
  matches: (parts: ZonedDateParts) => boolean;
  /** PM #74 — day-level match only (day-of-month × month × day-of-week). When
   *  this is false the whole DAY is skippable, so the lookahead jumps to the
   *  next midnight instead of scanning all 1440 of the day's minutes. */
  matchesDay: (parts: ZonedDateParts) => boolean;
  /** PM #74 — false when the day-of-month × month sets have NO possible date
   *  (e.g. "30 2 *"); lets the lookahead bail in O(1). */
  dayMonthFeasible: boolean;
};

function resolveCronTimezone(tz?: string): string {
  const trimmed = typeof tz === "string" ? tz.trim() : "";
  if (trimmed) {
    return trimmed;
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function parseNumberToken(token: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(token)) {
    return null;
  }
  const value = Number(token);
  if (!Number.isInteger(value) || value < min || value > max) {
    return null;
  }
  return value;
}

function expandRange(
  token: string,
  min: number,
  max: number,
  mapDow7To0: boolean,
): number[] | null {
  const [leftRaw, rightRaw] = token.split("-");
  if (!leftRaw || !rightRaw) {
    return null;
  }
  const left = parseNumberToken(leftRaw, min, max);
  const right = parseNumberToken(rightRaw, min, max);
  if (left === null || right === null || left > right) {
    return null;
  }
  const out: number[] = [];
  for (let value = left; value <= right; value += 1) {
    out.push(mapDow7To0 && value === 7 ? 0 : value);
  }
  return out;
}

function parseCronField(
  field: string,
  min: number,
  max: number,
  mapDow7To0: boolean,
): Set<number> | null {
  const trimmed = field.trim();
  if (!trimmed) {
    return null;
  }

  const values = new Set<number>();
  const parts = trimmed.split(",");
  for (const part of parts) {
    const token = part.trim();
    if (!token) {
      return null;
    }

    const [baseRaw, stepRaw] = token.split("/");
    const hasStep = stepRaw !== undefined;
    const step = hasStep ? parseNumberToken(stepRaw, 1, max - min + 1) : 1;
    if (step === null) {
      return null;
    }

    let baseValues: number[] = [];
    if (baseRaw === "*") {
      for (let v = min; v <= max; v += 1) {
        baseValues.push(mapDow7To0 && v === 7 ? 0 : v);
      }
    } else if (baseRaw.includes("-")) {
      const expanded = expandRange(baseRaw, min, max, mapDow7To0);
      if (!expanded) {
        return null;
      }
      baseValues = expanded;
    } else {
      const single = parseNumberToken(baseRaw, min, max);
      if (single === null) {
        return null;
      }
      baseValues = [mapDow7To0 && single === 7 ? 0 : single];
    }

    if (hasStep) {
      const sorted = [...new Set(baseValues)].sort((a, b) => a - b);
      if (sorted.length === 0) {
        return null;
      }
      const start = sorted[0];
      for (const value of sorted) {
        if ((value - start) % step === 0) {
          values.add(value);
        }
      }
      continue;
    }

    for (const value of baseValues) {
      values.add(value);
    }
  }

  return values.size > 0 ? values : null;
}

function parseCronExpr(expr: string): CronMatcher | null {
  const fields = expr.trim().split(/\s+/).filter(Boolean);
  if (fields.length !== 5) {
    return null;
  }
  const minute = parseCronField(fields[0], 0, 59, false);
  const hour = parseCronField(fields[1], 0, 23, false);
  const dayOfMonth = parseCronField(fields[2], 1, 31, false);
  const month = parseCronField(fields[3], 1, 12, false);
  const dayOfWeek = parseCronField(fields[4], 0, 7, true);
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) {
    return null;
  }
  return {
    matches(parts: ZonedDateParts) {
      return (
        minute.has(parts.minute) &&
        hour.has(parts.hour) &&
        dayOfMonth.has(parts.dayOfMonth) &&
        month.has(parts.month) &&
        dayOfWeek.has(parts.dayOfWeek)
      );
    },
    matchesDay(parts: ZonedDateParts) {
      return (
        dayOfMonth.has(parts.dayOfMonth) &&
        month.has(parts.month) &&
        dayOfWeek.has(parts.dayOfWeek)
      );
    },
    dayMonthFeasible: isDayMonthFeasible(dayOfMonth, month),
  };
}

function getZonedDateParts(ms: number, tz: string): ZonedDateParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    minute: "2-digit",
    hour: "2-digit",
    day: "2-digit",
    month: "2-digit",
    weekday: "short",
  });

  const parts = formatter.formatToParts(new Date(ms));
  let minute = 0;
  let hour = 0;
  let dayOfMonth = 0;
  let month = 0;
  let weekdayRaw = "";
  for (const part of parts) {
    if (part.type === "minute") minute = Number(part.value);
    if (part.type === "hour") hour = Number(part.value);
    if (part.type === "day") dayOfMonth = Number(part.value);
    if (part.type === "month") month = Number(part.value);
    if (part.type === "weekday") weekdayRaw = part.value.toLowerCase();
  }
  const dayOfWeekMap: Record<string, number> = {
    sun: 0,
    mon: 1,
    tue: 2,
    wed: 3,
    thu: 4,
    fri: 5,
    sat: 6,
  };
  return {
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek: dayOfWeekMap[weekdayRaw.slice(0, 3)] ?? 0,
  };
}

function computeNextCronRunAtMs(expr: string, nowMs: number, tz?: string): number | undefined {
  const matcher = parseCronExpr(expr);
  if (!matcher) {
    return undefined;
  }
  // PM #74 — bail instantly on structurally impossible day×month (Feb 30, Apr 31)
  // instead of scanning the full ~1M-minute / 2-year lookahead (≈100s of CPU,
  // and a mild DoS: an operator's "0 0 30 2 *" cron would hang a tick).
  if (!matcher.dayMonthFeasible) {
    return undefined;
  }
  const timezone = resolveCronTimezone(tz);
  let cursor = Math.floor(nowMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  // PM #74 — day-skipping lookahead. The old minute-by-minute scan did up to
  // ~1M Intl.formatToParts calls (≈100s) for far/impossible expressions. When
  // the DAY can't match (dom/month/dow), jump to ~midnight of the next day
  // instead of scanning its 1440 minutes — turning a months-away match from
  // ~hundreds-of-thousands of iterations into ~hundreds (one per day).
  let scanned = 0;
  while (scanned < MAX_CRON_LOOKAHEAD_MINUTES) {
    const parts = getZonedDateParts(cursor, timezone);
    if (matcher.matchesDay(parts)) {
      if (matcher.matches(parts)) {
        return cursor;
      }
      cursor += MINUTE_MS;
      scanned += 1;
    } else {
      // Jump to ~00:00 of the next day. A DST transition can land us ±1h off
      // midnight; that's harmless — the loop re-evaluates the parts each pass.
      const minutesIntoDay = parts.hour * 60 + parts.minute;
      const skip = Math.max(1, 24 * 60 - minutesIntoDay);
      cursor += skip * MINUTE_MS;
      scanned += skip;
    }
  }
  return undefined;
}

export function computeNextRunAtMs(schedule: CronSchedule, nowMs: number): number | undefined {
  if (schedule.kind === "at") {
    const atMs = parseAbsoluteTimeMs(schedule.at);
    if (atMs === null) {
      return undefined;
    }
    return atMs > nowMs ? atMs : undefined;
  }

  if (schedule.kind === "every") {
    const everyMs = Math.max(1, Math.floor(schedule.everyMs));
    const anchor = Math.max(0, Math.floor(schedule.anchorMs ?? nowMs));
    if (nowMs < anchor) {
      return anchor;
    }
    const elapsed = nowMs - anchor;
    const steps = Math.max(1, Math.floor((elapsed + everyMs - 1) / everyMs));
    return anchor + steps * everyMs;
  }

  const expr = schedule.expr.trim();
  if (!expr) {
    return undefined;
  }
  return computeNextCronRunAtMs(expr, nowMs, schedule.tz);
}

/**
 * Format an instant as a "YYYY-MM-DD HH:MM" local-time bucket in the
 * supplied timezone. Used for DST fall-back dedup — see CronJobState.
 * lastFireLocalBucket for the full rationale.
 *
 * Bucket granularity matches cron's minute resolution. Two UTC instants
 * that map to the same local wall-clock minute (DST fall-back) produce
 * the same bucket; two distinct local minutes always produce different
 * buckets.
 */
export function formatLocalCronBucket(ms: number, tz?: string): string {
  const timezone = resolveCronTimezone(tz);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = formatter.formatToParts(new Date(ms));
  let year = "0000";
  let month = "00";
  let day = "00";
  let hour = "00";
  let minute = "00";
  for (const part of parts) {
    if (part.type === "year") year = part.value;
    if (part.type === "month") month = part.value;
    if (part.type === "day") day = part.value;
    if (part.type === "hour") hour = part.value === "24" ? "00" : part.value;
    if (part.type === "minute") minute = part.value;
  }
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

export function validateCronExpression(expr: string): string | null {
  if (!expr.trim()) {
    return "Cron expression is required.";
  }
  const matcher = parseCronExpr(expr);
  if (!matcher) {
    return "Cron expression must contain 5 fields and only use numbers, '*', ranges, lists, or steps.";
  }
  return null;
}
