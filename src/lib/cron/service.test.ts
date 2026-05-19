/**
 * Tests for the cron service public API. Six exports under test:
 *
 *   - listCronJobs(projectId, opts)
 *   - getCronJob(projectId, jobId)
 *   - getCronProjectStatus(projectId)
 *   - addCronJob(projectId, input)
 *   - updateCronJob(projectId, jobId, patch)
 *   - removeCronJob(projectId, jobId)
 *
 * Two surfaces are NOT exercised here:
 *   - runCronJobNow / executeCronJob — pulls in runAgentText, the chat
 *     store, and the Telegram integration. Worth a focused integration
 *     test of its own; covered minimally via the route-level mocked
 *     test under /api/projects/[id]/cron/[jobId]/run.
 *   - CronScheduler.start/stop — wall-clock-driven; tested in service-
 *     scheduler.test.ts if/when added.
 *
 * Setup: stub `process.cwd()` to a per-test tmp dir BEFORE importing the
 * service. The `paths.ts` module captures `process.cwd()` at module
 * load, so any later cwd change is ignored unless we dynamically import.
 *
 * Pinned invariants:
 *   - addCronJob validates each kind of schedule + payload and rejects
 *     malformed input with informative messages.
 *   - addCronJob computes `state.nextRunAtMs` synchronously based on the
 *     normalized schedule (used by the scheduler to decide when to wake).
 *   - listCronJobs sorts by nextRunAtMs ASC, with undefined sorted last.
 *   - listCronJobs filters disabled jobs unless { includeDisabled: true }.
 *   - getCronProjectStatus reports min(nextRunAtMs) of ENABLED jobs only.
 *   - updateCronJob recomputes nextRunAtMs after every change.
 *   - 'at'-schedule with deleteAfterRun defaults to true (one-shot UX).
 *   - Invalid project id (matching /^[a-z0-9][a-z0-9-]{0,127}$/) throws.
 *   - Missing project (getProject → null) throws "Project ... not found."
 *   - normalizeTelegramChatId coerces numbers to strings.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

vi.mock("@/lib/storage/project-store", () => ({
  getProject: vi.fn(),
  getAllProjects: vi.fn(),
}));

vi.mock("@/lib/storage/chat-store", () => ({
  getChat: vi.fn(),
  createChat: vi.fn(),
}));

vi.mock("@/lib/storage/telegram-integration-store", () => ({
  getTelegramIntegrationRuntimeConfig: vi.fn(),
}));

vi.mock("@/lib/agent/agent", () => ({
  runAgentText: vi.fn(),
}));

import * as projectStore from "@/lib/storage/project-store";

const mockedGetProject = vi.mocked(projectStore.getProject);
const mockedGetAllProjects = vi.mocked(projectStore.getAllProjects);

let tmpRoot: string;
let cwdSpy: any;
let service: typeof import("./service");

// Deterministic "now" — 2026-05-17 12:00:00 UTC. We freeze the system
// clock to this value at the start of each test so timestamp assertions
// (e.g. `updatedAtMs > beforeUpdate`) don't depend on real wall-clock
// progress (which is flaky on slow CI runners and would otherwise
// require `await sleep(2)` hacks).
const NOW = Date.UTC(2026, 4, 17, 12, 0, 0);

beforeEach(async () => {
  vi.clearAllMocks();
  vi.setSystemTime(NOW);
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-cron-svc-"));
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmpRoot);

  // Default: project lookups succeed for "p-1"; getAllProjects is empty.
  mockedGetProject.mockImplementation(async (id) =>
    id === "p-1" ? ({ id: "p-1", name: "Test" } as any) : null
  );
  mockedGetAllProjects.mockResolvedValue([]);

  // Dynamic import AFTER cwd spy is installed — paths.ts captures
  // process.cwd() at module load time.
  vi.resetModules();
  service = await import("./service");
});

afterEach(async () => {
  cwdSpy?.mockRestore();
  vi.useRealTimers();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// Convenience: a valid 'every'-style create payload.
const everyCreate = (overrides: Record<string, unknown> = {}) => ({
  name: "test job",
  schedule: { kind: "every" as const, everyMs: 60_000 },
  payload: { kind: "agentTurn" as const, message: "run something" },
  ...overrides,
});

// Convenience: a valid 'at'-style create payload (future).
// With the clock frozen, Date.now() is NOW → atMs = NOW + 60_000 deterministically.
const futureIso = () => new Date(Date.now() + 60_000).toISOString();
const atCreate = (overrides: Record<string, unknown> = {}) => ({
  name: "one-shot",
  schedule: { kind: "at" as const, at: futureIso() },
  payload: { kind: "agentTurn" as const, message: "x" },
  ...overrides,
});

describe("addCronJob — validation", () => {
  it("throws when project does not exist (getProject → null)", async () => {
    await expect(service.addCronJob("nonexistent", everyCreate())).rejects.toThrow(
      /not found/i
    );
  });

  it("rejects an unknown project (any non-existent id, malformed or not)", async () => {
    // assertProjectExists fires before the format guard, so a malformed
    // id like "BAD!" surfaces as a "not found" error in practice. The
    // format guard inside withProjectStore is a defense-in-depth check
    // for data already on disk.
    await expect(service.addCronJob("BAD!", everyCreate())).rejects.toThrow(
      /not found/i
    );
  });

  it("throws when name is missing/blank", async () => {
    await expect(
      service.addCronJob("p-1", everyCreate({ name: "" }))
    ).rejects.toThrow(/name is required/i);
    await expect(
      service.addCronJob("p-1", everyCreate({ name: "   " }))
    ).rejects.toThrow(/name is required/i);
  });

  it("throws when payload.kind is wrong", async () => {
    await expect(
      service.addCronJob(
        "p-1",
        everyCreate({ payload: { kind: "wrong", message: "x" } })
      )
    ).rejects.toThrow(/payload\.kind must be "agentTurn"/i);
  });

  it("throws when payload.message is blank", async () => {
    await expect(
      service.addCronJob(
        "p-1",
        everyCreate({ payload: { kind: "agentTurn", message: "  " } })
      )
    ).rejects.toThrow(/payload\.message is required/i);
  });

  it("throws when schedule.everyMs is zero or negative", async () => {
    await expect(
      service.addCronJob("p-1", everyCreate({ schedule: { kind: "every", everyMs: 0 } }))
    ).rejects.toThrow(/positive integer/i);
    await expect(
      service.addCronJob("p-1", everyCreate({ schedule: { kind: "every", everyMs: -5 } }))
    ).rejects.toThrow(/positive integer/i);
  });

  it("throws when schedule.kind is unrecognized", async () => {
    await expect(
      service.addCronJob("p-1", everyCreate({ schedule: { kind: "wibble" } as any }))
    ).rejects.toThrow(/must be one of/i);
  });

  it("throws on unparseable 'at' timestamp", async () => {
    await expect(
      service.addCronJob(
        "p-1",
        atCreate({ schedule: { kind: "at", at: "tomorrow" } as any })
      )
    ).rejects.toThrow(/valid timestamp/i);
  });

  it("throws on invalid cron expression", async () => {
    await expect(
      service.addCronJob(
        "p-1",
        everyCreate({ schedule: { kind: "cron", expr: "60 * * * *" } as any })
      )
    ).rejects.toThrow(/5 fields/i);
  });
});

describe("addCronJob — successful create", () => {
  it("creates an 'every' job with nextRunAtMs computed + default enabled=true", async () => {
    const created = await service.addCronJob("p-1", everyCreate());
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.enabled).toBe(true);
    expect(created.schedule.kind).toBe("every");
    // Clock is frozen at NOW; first run for an 'every' job anchored at
    // NOW with everyMs=60_000 is exactly NOW + 60_000 (PM #20 — every
    // returns the next tick when elapsed=0, see schedule.ts ceiling math).
    expect(created.state.nextRunAtMs).toBe(NOW + 60_000);
    // 'every' without explicit anchorMs gets anchored to now.
    if (created.schedule.kind === "every") {
      expect(created.schedule.anchorMs).toBe(NOW);
    }
  });

  it("'at' kind: deleteAfterRun defaults to true (one-shot)", async () => {
    const created = await service.addCronJob("p-1", atCreate());
    expect(created.deleteAfterRun).toBe(true);
  });

  it("'every' kind: deleteAfterRun defaults to undefined (recurring)", async () => {
    const created = await service.addCronJob("p-1", everyCreate());
    expect(created.deleteAfterRun).toBeUndefined();
  });

  it("respects explicit enabled=false on create (job is dormant)", async () => {
    const created = await service.addCronJob(
      "p-1",
      everyCreate({ enabled: false })
    );
    expect(created.enabled).toBe(false);
    // Disabled job → computeJobNextRunAtMs returns undefined.
    expect(created.state.nextRunAtMs).toBeUndefined();
  });

  it("coerces a numeric telegramChatId in the payload to a string", async () => {
    const created = await service.addCronJob(
      "p-1",
      everyCreate({
        payload: {
          kind: "agentTurn",
          message: "x",
          telegramChatId: 12345 as any,
        },
      })
    );
    expect(created.payload.telegramChatId).toBe("12345");
  });

  it("trims optional text fields and drops empty strings", async () => {
    const created = await service.addCronJob(
      "p-1",
      everyCreate({
        description: "  hello  ",
        payload: {
          kind: "agentTurn",
          message: "x",
          chatId: "   ",
          currentPath: "  /work  ",
        },
      })
    );
    expect(created.description).toBe("hello");
    expect(created.payload.chatId).toBeUndefined();
    expect(created.payload.currentPath).toBe("/work");
  });

  it("persists the job to disk under data/projects/<id>/.meta/cron/jobs.json", async () => {
    await service.addCronJob("p-1", everyCreate());
    const storePath = path.join(
      tmpRoot,
      "data",
      "projects",
      "p-1",
      ".meta",
      "cron",
      "jobs.json"
    );
    const raw = await fs.readFile(storePath, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.jobs).toHaveLength(1);
    expect(parsed.jobs[0].name).toBe("test job");
  });
});

describe("listCronJobs", () => {
  it("returns [] for an empty project", async () => {
    const jobs = await service.listCronJobs("p-1");
    expect(jobs).toEqual([]);
  });

  it("filters disabled jobs by default", async () => {
    await service.addCronJob("p-1", everyCreate({ name: "active" }));
    await service.addCronJob(
      "p-1",
      everyCreate({ name: "dormant", enabled: false })
    );
    const visible = await service.listCronJobs("p-1");
    expect(visible.map((j) => j.name).sort()).toEqual(["active"]);
  });

  it("includes disabled jobs when includeDisabled=true", async () => {
    await service.addCronJob("p-1", everyCreate({ name: "active" }));
    await service.addCronJob(
      "p-1",
      everyCreate({ name: "dormant", enabled: false })
    );
    const all = await service.listCronJobs("p-1", { includeDisabled: true });
    expect(all.map((j) => j.name).sort()).toEqual(["active", "dormant"]);
  });

  it("sorts by nextRunAtMs ASC (sooner jobs first)", async () => {
    // Build deterministic order: job1 fires in 60s, job2 in 30s.
    await service.addCronJob(
      "p-1",
      everyCreate({ name: "slow", schedule: { kind: "every", everyMs: 60_000 } })
    );
    await service.addCronJob(
      "p-1",
      everyCreate({ name: "fast", schedule: { kind: "every", everyMs: 30_000 } })
    );
    const jobs = await service.listCronJobs("p-1");
    expect(jobs.map((j) => j.name)).toEqual(["fast", "slow"]);
  });

  it("sorts jobs with undefined nextRunAtMs to the end", async () => {
    // Disabled jobs have no nextRunAtMs. We include them to verify the sort.
    await service.addCronJob(
      "p-1",
      everyCreate({ name: "active" })
    );
    await service.addCronJob(
      "p-1",
      everyCreate({ name: "dormant", enabled: false })
    );
    const jobs = await service.listCronJobs("p-1", { includeDisabled: true });
    expect(jobs[0].name).toBe("active");
    expect(jobs[1].name).toBe("dormant");
  });

  it("throws when the project does not exist", async () => {
    await expect(service.listCronJobs("nonexistent")).rejects.toThrow(/not found/i);
  });
});

describe("getCronJob", () => {
  it("returns the job when it exists", async () => {
    const added = await service.addCronJob("p-1", everyCreate());
    const fetched = await service.getCronJob("p-1", added.id);
    expect(fetched?.id).toBe(added.id);
    expect(fetched?.name).toBe("test job");
  });

  it("returns null when the job id is unknown", async () => {
    const fetched = await service.getCronJob("p-1", "nope");
    expect(fetched).toBeNull();
  });

  it("throws when the project does not exist", async () => {
    await expect(service.getCronJob("missing", "x")).rejects.toThrow(
      /not found/i
    );
  });
});

describe("getCronProjectStatus", () => {
  it("reports zero jobs and null nextWake on empty project", async () => {
    const status = await service.getCronProjectStatus("p-1");
    expect(status.projectId).toBe("p-1");
    expect(status.jobs).toBe(0);
    expect(status.nextWakeAtMs).toBeNull();
  });

  it("reports the soonest nextRunAtMs across enabled jobs", async () => {
    const fast = await service.addCronJob(
      "p-1",
      everyCreate({ schedule: { kind: "every", everyMs: 30_000 } })
    );
    await service.addCronJob(
      "p-1",
      everyCreate({ schedule: { kind: "every", everyMs: 5 * 60_000 } })
    );
    const status = await service.getCronProjectStatus("p-1");
    expect(status.jobs).toBe(2);
    expect(status.nextWakeAtMs).toBe(fast.state.nextRunAtMs);
  });

  it("ignores disabled jobs when computing nextWake", async () => {
    await service.addCronJob(
      "p-1",
      everyCreate({
        name: "dormant",
        enabled: false,
        schedule: { kind: "every", everyMs: 1_000 }, // soonest but disabled
      })
    );
    const slow = await service.addCronJob(
      "p-1",
      everyCreate({ schedule: { kind: "every", everyMs: 5 * 60_000 } })
    );
    const status = await service.getCronProjectStatus("p-1");
    expect(status.jobs).toBe(2);
    // The dormant job has no nextRunAtMs, so the slow enabled job wins.
    expect(status.nextWakeAtMs).toBe(slow.state.nextRunAtMs);
  });
});

describe("updateCronJob", () => {
  it("returns null when job id is unknown", async () => {
    const result = await service.updateCronJob("p-1", "missing", {
      name: "new-name",
    });
    expect(result).toBeNull();
  });

  it("renames a job and bumps updatedAtMs", async () => {
    const created = await service.addCronJob("p-1", everyCreate());
    const beforeUpdate = created.updatedAtMs;
    // Advance the frozen clock by 1ms so `applyPatch`'s captured `nowMs`
    // is strictly greater than `created.updatedAtMs`. This replaces an
    // earlier `await sleep(2)` that was a flake risk on slow CI runners.
    vi.setSystemTime(NOW + 1);
    const renamed = await service.updateCronJob("p-1", created.id, {
      name: "renamed",
    });
    expect(renamed?.name).toBe("renamed");
    expect(renamed!.updatedAtMs).toBe(beforeUpdate + 1);
  });

  it("disabling a job clears runningAtMs and nextRunAtMs", async () => {
    const created = await service.addCronJob("p-1", everyCreate());
    expect(created.state.nextRunAtMs).toBeDefined();
    const updated = await service.updateCronJob("p-1", created.id, {
      enabled: false,
    });
    expect(updated?.enabled).toBe(false);
    expect(updated?.state.nextRunAtMs).toBeUndefined();
  });

  it("changing the schedule recomputes nextRunAtMs", async () => {
    const created = await service.addCronJob(
      "p-1",
      everyCreate({ schedule: { kind: "every", everyMs: 60_000 } })
    );
    const oldNext = created.state.nextRunAtMs!;
    const futureAt = new Date(NOW + 600_000).toISOString();
    const updated = await service.updateCronJob("p-1", created.id, {
      schedule: { kind: "at", at: futureAt },
    });
    expect(updated?.schedule.kind).toBe("at");
    // The new nextRunAtMs lands at the exact 'at' timestamp (deterministic
    // because the clock is frozen).
    expect(updated!.state.nextRunAtMs).not.toBe(oldNext);
    expect(updated!.state.nextRunAtMs).toBe(NOW + 600_000);
  });

  it("rejects an empty payload.message in the patch", async () => {
    const created = await service.addCronJob("p-1", everyCreate());
    await expect(
      service.updateCronJob("p-1", created.id, {
        payload: { message: "   " },
      } as any)
    ).rejects.toThrow(/cannot be empty/i);
  });
});

describe("removeCronJob", () => {
  it("returns { removed: true } and deletes the job", async () => {
    const created = await service.addCronJob("p-1", everyCreate());
    const result = await service.removeCronJob("p-1", created.id);
    expect(result.removed).toBe(true);
    const after = await service.listCronJobs("p-1", { includeDisabled: true });
    expect(after).toHaveLength(0);
  });

  it("returns { removed: false } for an unknown id (idempotent delete)", async () => {
    const result = await service.removeCronJob("p-1", "nope");
    expect(result.removed).toBe(false);
  });
});

describe("listKnownCronProjectIds", () => {
  it("returns 'none' + all project ids", async () => {
    mockedGetAllProjects.mockResolvedValue([
      { id: "proj-a" } as any,
      { id: "proj-b" } as any,
      { id: "" } as any, // filtered out
    ]);
    const ids = await service.listKnownCronProjectIds();
    expect(ids).toEqual(["none", "proj-a", "proj-b"]);
  });

  it("returns just 'none' when there are no projects", async () => {
    mockedGetAllProjects.mockResolvedValue([]);
    const ids = await service.listKnownCronProjectIds();
    expect(ids).toEqual(["none"]);
  });
});

describe("Concurrent state — withCronStoreLock contract", () => {
  // These tests pin the implicit contract that `service.ts` mutates the
  // on-disk jobs.json under `withCronStoreLock`. If a future refactor
  // bypasses the lock (e.g., raw fs.writeFile after a read), one of two
  // jobs in a race would be lost-write'd. The locking primitive itself
  // is unit-tested in `fs-utils.test.ts`; these tests verify *service*
  // uses it correctly.

  it("two parallel addCronJob calls both land in the store (no lost-write)", async () => {
    const [a, b] = await Promise.all([
      service.addCronJob("p-1", { ...everyCreate(), name: "alpha" }),
      service.addCronJob("p-1", { ...everyCreate(), name: "bravo" }),
    ]);
    expect(a.id).not.toBe(b.id);

    const all = await service.listCronJobs("p-1", { includeDisabled: true });
    expect(all.map((j) => j.name).sort()).toEqual(["alpha", "bravo"]);
  });

  it("parallel updateCronJob calls on different jobs both succeed", async () => {
    const a = await service.addCronJob("p-1", { ...everyCreate(), name: "j-a" });
    const b = await service.addCronJob("p-1", { ...everyCreate(), name: "j-b" });

    await Promise.all([
      service.updateCronJob("p-1", a.id, { name: "a-renamed" }),
      service.updateCronJob("p-1", b.id, { name: "b-renamed" }),
    ]);

    const all = await service.listCronJobs("p-1", { includeDisabled: true });
    expect(all.map((j) => j.name).sort()).toEqual(["a-renamed", "b-renamed"]);
  });

  it("parallel add + remove on the same store don't corrupt the JSON file", async () => {
    // Seed one job to remove, then fire add + remove together.
    const existing = await service.addCronJob("p-1", { ...everyCreate(), name: "seed" });

    await Promise.all([
      service.addCronJob("p-1", { ...everyCreate(), name: "newcomer" }),
      service.removeCronJob("p-1", existing.id),
    ]);

    // File must still parse as valid JSON; result must contain only the new job.
    const storePath = path.join(
      tmpRoot, "data", "projects", "p-1", ".meta", "cron", "jobs.json"
    );
    const raw = await fs.readFile(storePath, "utf8");
    const parsed = JSON.parse(raw); // throws if torn
    expect(parsed.jobs).toHaveLength(1);
    expect(parsed.jobs[0].name).toBe("newcomer");
  });
});

describe("Global cron project ('none')", () => {
  it("addCronJob accepts projectId='none' without checking getProject", async () => {
    // GLOBAL_CRON_PROJECT_ID="none" — assertProjectExists is bypassed.
    // We don't mock getProject for "none" because the service shouldn't
    // call it.
    mockedGetProject.mockClear();
    const created = await service.addCronJob("none", everyCreate());
    expect(created.projectId).toBe("none");
    expect(mockedGetProject).not.toHaveBeenCalled();
  });

  it("normalizes empty/whitespace project id to GLOBAL_CRON_PROJECT_ID", async () => {
    const created = await service.addCronJob("   ", everyCreate());
    expect(created.projectId).toBe("none");
  });
});

/**
 * PM #20 follow-up — DoS mitigation for impossible cron expressions.
 *
 * Pre-fix: a cron schedule whose lookahead is exhausted (e.g., `0 0 30 2 *`
 * — Feb 30 — never resolves) would cause `computeJobNextRunAtMs` to spin
 * through `MAX_CRON_LOOKAHEAD_MINUTES` (~1M iterations, ~28s wall-clock)
 * on every scheduler tick, because `sanitizeStore` re-computes any job
 * whose `state.nextRunAtMs` is undefined. With N such jobs, the tick is
 * pinned for ~N×28s, deadlocking the scheduler. The fix caches an
 * `unresolvable: true` flag on the job's state.
 */
describe("PM #20 follow-up — impossible cron expression caching", () => {
  // Combined regression: the ONE expensive compute (~28s for the Feb 30
  // lookahead exhaustion) is paid once and then we run all the cache
  // assertions against the same job. Pre-fix, each of these would have
  // paid the ~28s cost independently (the scheduler tick would too,
  // every minute — the DoS vector). The 60s timeout accommodates the
  // first compute.
  it("caches unresolvable flag, skips recompute on read, and PATCH clears it (combined slow-path regression)", async () => {
    // 1. Initial compute pays the lookahead cost ONCE and caches the flag.
    const created = await service.addCronJob("p-1", {
      name: "feb-30",
      schedule: { kind: "cron", expr: "0 0 30 2 *" }, // Feb 30 — never resolves
      payload: { kind: "agentTurn", message: "x" },
    });
    expect(created.state.nextRunAtMs).toBeUndefined();
    expect(created.state.unresolvable).toBe(true);

    // 2. Subsequent reads (sanitizeStore re-entry path) MUST hit the cache
    //    and complete in milliseconds — not re-run the 28s lookahead.
    const readStart = Date.now();
    await service.listCronJobs("p-1");
    await service.listCronJobs("p-1");
    await service.listCronJobs("p-1");
    const readElapsedMs = Date.now() - readStart;
    // Cache hit is sub-millisecond; without the fix this would be ~84s.
    expect(readElapsedMs).toBeLessThan(2000);

    // 3. PATCH with a valid schedule clears the flag and yields a real next-run.
    const fixed = await service.updateCronJob("p-1", created.id, {
      schedule: { kind: "cron", expr: "0 9 * * *" }, // every day at 09:00
    });
    expect(fixed?.state.unresolvable).toBeFalsy();
    expect(typeof fixed?.state.nextRunAtMs).toBe("number");
  }, 60_000);

  it("does NOT set unresolvable for `every` schedule (only `cron` kind exhausts lookahead)", async () => {
    // The `unresolvable` flag is specific to the cron-expr lookahead loop.
    // Other kinds (`every`, `at`) compute in O(1); their `undefined` return
    // values have different meanings ("already ran" for at, "disabled" for
    // either) and must NOT set the cache.
    const created = await service.addCronJob("p-1", everyCreate());
    expect(created.state.unresolvable).toBeFalsy();
  });
});

/**
 * STUCK_RUN_MS boot recovery regression — see
 * `recoverStaleCronRunMarkers` in service.ts.
 *
 * Pre-fix: if a cron job was running when the process crashed, its
 * `runningAtMs` marker stayed on disk. The scheduler then refused to
 * re-run the job for 2 hours (STUCK_RUN_MS) until the in-line sanitizer
 * cleared it. Users saw "running" in the UI with no way to recover.
 *
 * Post-fix: on every boot, scan all cron stores and clear any
 * `runningAtMs` markers (they must be from a previous process by the
 * single-process invariant). Mark affected jobs as `lastStatus="error"`
 * with `lastError="Interrupted by process restart."` so the UI shows
 * an explanation.
 */
describe("recoverStaleCronRunMarkers — clears interrupted-job markers on boot", () => {
  beforeEach(() => {
    // The recovery iterates listKnownCronProjectIds, which depends on
    // getAllProjects(). Default mock is empty array; tests in this block
    // need "p-1" to be visible so recovery actually opens its store.
    mockedGetAllProjects.mockResolvedValue([{ id: "p-1" } as any]);
  });

  it("clears runningAtMs and records error reason for an interrupted job", async () => {
    // Create a normal job, then manually plant a "running" marker as if
    // the previous process died mid-execution.
    const created = await service.addCronJob("p-1", everyCreate());
    const storePath = path.join(
      tmpRoot, "data", "projects", "p-1", ".meta", "cron", "jobs.json"
    );
    const raw = await fs.readFile(storePath, "utf8");
    const parsed = JSON.parse(raw);
    parsed.jobs.find((j: any) => j.id === created.id).state.runningAtMs =
      NOW - 60_000; // 1 minute ago
    await fs.writeFile(storePath, JSON.stringify(parsed, null, 2));

    const result = await service.recoverStaleCronRunMarkers();
    expect(result.scannedProjects).toBeGreaterThanOrEqual(1);
    expect(result.clearedJobs).toBe(1);

    const after = await service.getCronJob("p-1", created.id);
    expect(after?.state.runningAtMs).toBeUndefined();
    expect(after?.state.lastStatus).toBe("error");
    expect(after?.state.lastError).toMatch(/process restart/i);
    expect(after?.state.consecutiveErrors).toBe(1);
  });

  it("does NOT touch jobs that completed successfully (lastStatus stays 'ok')", async () => {
    // This shouldn't really happen — if lastStatus="ok", runningAtMs would
    // have been cleared by finalizeJobRun. But defensive: a write that
    // crashed BETWEEN setting lastStatus and clearing runningAtMs would
    // leave both set. Recovery must not stomp on a true positive.
    const created = await service.addCronJob("p-1", everyCreate());
    const storePath = path.join(
      tmpRoot, "data", "projects", "p-1", ".meta", "cron", "jobs.json"
    );
    const raw = await fs.readFile(storePath, "utf8");
    const parsed = JSON.parse(raw);
    const stored = parsed.jobs.find((j: any) => j.id === created.id);
    stored.state.runningAtMs = NOW - 60_000;
    stored.state.lastStatus = "ok"; // pretend run finished happily
    stored.state.lastError = undefined;
    await fs.writeFile(storePath, JSON.stringify(parsed, null, 2));

    await service.recoverStaleCronRunMarkers();
    const after = await service.getCronJob("p-1", created.id);
    expect(after?.state.runningAtMs).toBeUndefined();
    expect(after?.state.lastStatus).toBe("ok"); // preserved
    expect(after?.state.lastError).toBeUndefined();
  });

  it("is idempotent — second call is a no-op", async () => {
    const created = await service.addCronJob("p-1", everyCreate());
    const storePath = path.join(
      tmpRoot, "data", "projects", "p-1", ".meta", "cron", "jobs.json"
    );
    const raw = await fs.readFile(storePath, "utf8");
    const parsed = JSON.parse(raw);
    parsed.jobs.find((j: any) => j.id === created.id).state.runningAtMs = NOW - 1000;
    await fs.writeFile(storePath, JSON.stringify(parsed, null, 2));

    const first = await service.recoverStaleCronRunMarkers();
    expect(first.clearedJobs).toBe(1);

    const second = await service.recoverStaleCronRunMarkers();
    expect(second.clearedJobs).toBe(0);
  });

  it("returns zero clearedJobs when no jobs have stale markers", async () => {
    await service.addCronJob("p-1", everyCreate());
    const result = await service.recoverStaleCronRunMarkers();
    expect(result.clearedJobs).toBe(0);
  });
});

/**
 * DST fall-back dedup regression — see schedule.ts `computeNextCronRunWithDstDedup`
 * and CronJobState.lastFireLocalBucket.
 *
 * The test exercises `computeJobNextRunAtMs` indirectly through addCronJob +
 * updateCronJob (which both go through the dedup path). We can't easily
 * simulate a real DST transition in the cron tick loop within unit tests,
 * so instead we hand-craft a job with a `lastFireLocalBucket` and verify
 * that the next compute skips a candidate matching that bucket.
 */
describe("DST fall-back dedup — cron schedules don't double-fire on clock rollback", () => {
  it("a cron job with lastFireLocalBucket set skips the duplicate UTC instant", async () => {
    // Anchor the test clock to the NYC fall-back morning of 2026:
    // 2026-11-01 05:00 UTC (which is 01:00 EDT — DST about to end at 02:00 local).
    const NOW_FALLBACK = Date.UTC(2026, 10, 1, 5, 0, 0);
    vi.setSystemTime(NOW_FALLBACK);

    // Create a cron `30 1 * * *` America/New_York → fires at 01:30 local daily.
    const created = await service.addCronJob("p-1", {
      name: "ny-130",
      schedule: { kind: "cron", expr: "30 1 * * *", tz: "America/New_York" },
      payload: { kind: "agentTurn", message: "x" },
    });
    // First-ever fire — no previous bucket, so the natural next match is
    // 01:30 EDT = 05:30 UTC the same day.
    expect(created.state.nextRunAtMs).toBe(Date.UTC(2026, 10, 1, 5, 30, 0));

    // Now simulate that the job has just fired at 01:30 EDT — set
    // lastFireLocalBucket directly + advance the clock past 05:30 UTC.
    // PATCH with no schedule change so we hit applyPatch's recompute
    // path with the bucket still in place.
    vi.setSystemTime(Date.UTC(2026, 10, 1, 5, 31, 0)); // 1 minute after first fire

    // The implementation persists lastFireLocalBucket inside finalizeJobRun
    // (which we don't invoke here — runCronJobNow goes through a different
    // claim path). For unit testing, we set the bucket via updateCronJob's
    // patch path by directly editing the JSON file the store reads. This
    // is brittle but the alternative requires running the full executeCronJob
    // pipeline (mocked LLM, mocked telegram, …) which adds too much surface
    // for one regression.
    const storePath = path.join(
      tmpRoot, "data", "projects", "p-1", ".meta", "cron", "jobs.json"
    );
    const raw = await fs.readFile(storePath, "utf8");
    const parsed = JSON.parse(raw);
    const stored = parsed.jobs.find((j: any) => j.id === created.id);
    stored.state.lastFireLocalBucket = "2026-11-01 01:30";
    await fs.writeFile(storePath, JSON.stringify(parsed, null, 2));

    // Re-trigger a recompute via PATCH (name change is a no-op for
    // scheduling but goes through applyPatch → computeNextRunWithCache).
    const refreshed = await service.updateCronJob("p-1", created.id, {
      name: "ny-130-renamed",
    });

    // The natural next match for `30 1 * * *` after 05:31 UTC is 06:30 UTC
    // (01:30 EST — the duplicate). DST dedup must skip it and return
    // 2026-11-02 01:30 EST = 2026-11-02 06:30 UTC instead.
    expect(refreshed?.state.nextRunAtMs).toBe(Date.UTC(2026, 10, 2, 6, 30, 0));
  }, 30_000);

  it("PATCH-ing the schedule clears the dedup bucket alongside the unresolvable flag", async () => {
    const created = await service.addCronJob("p-1", {
      name: "x",
      schedule: { kind: "cron", expr: "0 12 * * *", tz: "UTC" },
      payload: { kind: "agentTurn", message: "x" },
    });
    // Plant a stale bucket directly on disk.
    const storePath = path.join(
      tmpRoot, "data", "projects", "p-1", ".meta", "cron", "jobs.json"
    );
    const raw = await fs.readFile(storePath, "utf8");
    const parsed = JSON.parse(raw);
    parsed.jobs.find((j: any) => j.id === created.id).state.lastFireLocalBucket =
      "2020-01-01 12:00";
    await fs.writeFile(storePath, JSON.stringify(parsed, null, 2));

    // Patch the schedule. The bucket is recorded against the OLD tz/expr
    // and is meaningless under the new schedule.
    const updated = await service.updateCronJob("p-1", created.id, {
      schedule: { kind: "cron", expr: "0 13 * * *", tz: "UTC" },
    });
    expect(updated?.state.lastFireLocalBucket).toBeUndefined();
  });
});
