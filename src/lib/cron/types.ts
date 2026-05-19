export type CronProjectId = string;

export type CronSchedule =
  | { kind: "at"; at: string }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string };

export type CronPayload = {
  kind: "agentTurn";
  message: string;
  chatId?: string;
  telegramChatId?: string;
  currentPath?: string;
  timeoutSeconds?: number;
};

export type CronRunStatus = "ok" | "error" | "skipped";

export type CronJobState = {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: CronRunStatus;
  lastError?: string;
  lastDurationMs?: number;
  consecutiveErrors?: number;
  /**
   * Sticky flag: set to `true` when `computeNextRunAtMs` returns `undefined`
   * for a `cron`-kind schedule (i.e., the 2-year lookahead is exhausted —
   * the expression is impossible, e.g., `0 0 30 2 *` for Feb 30). Prevents
   * the scheduler tick from re-running the ~1M-iteration loop every minute,
   * which would otherwise be a DoS vector for any authenticated user.
   * Cleared by `applyPatch` whenever `patch.schedule` is set.
   */
  unresolvable?: boolean;
  /**
   * Local-time bucket of the most recent successful fire, formatted as
   * "YYYY-MM-DD HH:MM" in the job's schedule timezone. Used to dedupe
   * DST fall-back double-fires: when clocks go back, the same local
   * wall-clock time happens twice (e.g., America/New_York 2026-11-01
   * 01:30 occurs at both UTC 05:30 and UTC 06:30). Without dedup, a
   * cron `30 1 * * *` would fire twice that day. With dedup, the
   * second occurrence is skipped because its bucket matches the
   * first. Spring-forward gaps (02:30 NYC on 2026-03-08) are
   * inherently skipped because `getZonedDateParts` never produces
   * that bucket — no special handling needed.
   * Only set for `cron`-kind schedules; not used for `at` / `every`.
   */
  lastFireLocalBucket?: string;
};

export type CronJob = {
  id: string;
  projectId: CronProjectId;
  name: string;
  description?: string;
  enabled: boolean;
  deleteAfterRun?: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  schedule: CronSchedule;
  payload: CronPayload;
  state: CronJobState;
};

export type CronStoreFile = {
  version: 1;
  jobs: CronJob[];
};

export type CronJobCreate = {
  name: string;
  description?: string;
  enabled?: boolean;
  deleteAfterRun?: boolean;
  schedule: CronSchedule;
  payload: CronPayload;
};

export type CronJobPatch = Partial<{
  name: string;
  description: string;
  enabled: boolean;
  deleteAfterRun: boolean;
  schedule: CronSchedule;
  payload: Partial<CronPayload>;
}>;

export type CronRunLogEntry = {
  ts: number;
  jobId: string;
  projectId: CronProjectId;
  status: CronRunStatus;
  error?: string;
  summary?: string;
  runAtMs?: number;
  durationMs?: number;
  nextRunAtMs?: number;
};
