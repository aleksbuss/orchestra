/**
 * Tests for `ensureCronSchedulerStarted` — the boot-time entry point that
 * every route hits to lazily spin up the cron scheduler. The module owns
 * three pieces of global state on `globalThis`:
 *
 *   - __orchestraCronScheduler__         — the singleton CronScheduler.
 *   - __orchestraBootRecoveryController__— shared AbortController so
 *     SIGTERM/SIGINT cancels the queue-replay loop mid-flight (PM #1).
 *   - __orchestraShutdownHandlersInstalled__ — guard against re-binding
 *     signal handlers on Next.js dev-mode reload.
 *
 * Pinned invariants:
 *   - First call: constructs a CronScheduler, calls .start() once,
 *     installs SIGTERM/SIGINT once, dispatches pending queue jobs,
 *     runs ghost-sweeper after.
 *   - Subsequent calls: reuse the singleton — no second scheduler, no
 *     second signal-handler install, no second queue replay.
 *   - If recovery is aborted mid-loop, remaining jobs are deferred and
 *     ghost-sweeper is skipped.
 *
 * Setup note: every test resets `globalThis.__orchestra*__` so they
 * don't pollute each other.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/cron/service", () => ({
  CronScheduler: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
  recoverStaleCronRunMarkers: vi.fn(),
}));

vi.mock("@/lib/storage/queue-store", () => ({
  getPendingJobs: vi.fn(),
}));

vi.mock("@/lib/agent/daemon", () => ({
  dispatchAgentJob: vi.fn(),
}));

// Sprint 2 follow-up: ghost-sweeper is now invoked indirectly via
// `runAllSweepers()` (not from runtime.ts directly). Mock the sweepers
// module so we can assert the boot-time call lands on the unified entry
// point. The ghost-sweeper module itself stays mocked too, in case any
// indirect import path still resolves it.
vi.mock("@/lib/cron/sweepers", () => ({
  runAllSweepers: vi.fn(),
  ensureSweepersScheduled: vi.fn(),
}));

vi.mock("@/lib/agent/ghost-sweeper", () => ({
  sweepGhostTasks: vi.fn(),
}));

import { CronScheduler, recoverStaleCronRunMarkers } from "@/lib/cron/service";
import { getPendingJobs } from "@/lib/storage/queue-store";
import { dispatchAgentJob } from "@/lib/agent/daemon";
import { runAllSweepers, ensureSweepersScheduled } from "@/lib/cron/sweepers";

const mockedScheduler = vi.mocked(CronScheduler);
const mockedPending = vi.mocked(getPendingJobs);
const mockedDispatch = vi.mocked(dispatchAgentJob);
const mockedRunAll = vi.mocked(runAllSweepers);
const mockedEnsureScheduled = vi.mocked(ensureSweepersScheduled);
const mockedRecover = vi.mocked(recoverStaleCronRunMarkers);

let processOnceSpy: any;

beforeEach(() => {
  vi.clearAllMocks();
  // Clear all module-owned globals so each test starts fresh.
  delete (globalThis as any).__orchestraCronScheduler__;
  delete (globalThis as any).__orchestraBootRecoveryController__;
  delete (globalThis as any).__orchestraShutdownHandlersInstalled__;
  // Spy on signal handler installation — we don't want real handlers to
  // fire (a stray SIGINT during the test run could leak through).
  processOnceSpy = vi.spyOn(process, "once").mockReturnValue(process);
  mockedPending.mockResolvedValue([]);
  mockedDispatch.mockResolvedValue(undefined as any);
  mockedRunAll.mockResolvedValue({
    tmp: { scanned: 0, removed: 0, errors: 0, removedSample: [] },
    queue: { scanned: 0, removed: 0, errors: 0, removedSample: [] },
    ghost: { ok: true },
  });
  mockedEnsureScheduled.mockReturnValue(undefined as any);
  mockedRecover.mockResolvedValue({ scannedProjects: 0, clearedJobs: 0 });
});

afterEach(() => {
  processOnceSpy?.mockRestore();
  delete (globalThis as any).__orchestraCronScheduler__;
  delete (globalThis as any).__orchestraBootRecoveryController__;
  delete (globalThis as any).__orchestraShutdownHandlersInstalled__;
});

async function freshImport(): Promise<typeof import("./runtime")> {
  vi.resetModules();
  return await import("./runtime");
}

describe("ensureCronSchedulerStarted — first boot", () => {
  it("creates exactly one CronScheduler and calls .start()", async () => {
    const { ensureCronSchedulerStarted } = await freshImport();
    await ensureCronSchedulerStarted();

    expect(mockedScheduler).toHaveBeenCalledTimes(1);
    const instance = mockedScheduler.mock.results[0].value as {
      start: ReturnType<typeof vi.fn>;
    };
    expect(instance.start).toHaveBeenCalledOnce();
  });

  it("installs SIGTERM and SIGINT handlers exactly once", async () => {
    const { ensureCronSchedulerStarted } = await freshImport();
    await ensureCronSchedulerStarted();

    const signals = processOnceSpy.mock.calls.map((args: any[]) => args[0]);
    expect(signals).toContain("SIGTERM");
    expect(signals).toContain("SIGINT");
    expect(globalThis.__orchestraShutdownHandlersInstalled__).toBe(true);
  });

  it("dispatches each pending queue job", async () => {
    mockedPending.mockResolvedValue([
      { chatId: "c-1" } as any,
      { chatId: "c-2" } as any,
    ]);
    const { ensureCronSchedulerStarted } = await freshImport();
    await ensureCronSchedulerStarted();

    // The dispatcher promise chain runs in the background; flush
    // microtasks before asserting.
    await new Promise((r) => setImmediate(r));

    expect(mockedDispatch).toHaveBeenCalledTimes(2);
    expect(mockedDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "c-1" })
    );
    expect(mockedDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "c-2" })
    );
  });

  it("runs the unified sweepers entry exactly once after queue replay", async () => {
    // Sprint 2 follow-up: `sweepGhostTasks` was previously called from
    // runtime.ts directly; it's now folded into `runAllSweepers()` (along
    // with tmp + queue sweeps). The boot path calls the unified entry
    // once and also registers the 6h recurring tick — so any mid-uptime
    // ghost task is now caught without waiting for a server restart.
    mockedPending.mockResolvedValue([{ chatId: "c-1" } as any]);
    const { ensureCronSchedulerStarted } = await freshImport();
    await ensureCronSchedulerStarted();
    await new Promise((r) => setImmediate(r));
    expect(mockedRunAll).toHaveBeenCalledOnce();
    expect(mockedEnsureScheduled).toHaveBeenCalledOnce();
  });

  it("clears stale cron runningAtMs markers via recoverStaleCronRunMarkers", async () => {
    // Boot recovery for the STUCK_RUN_MS blind spot — jobs from a previous
    // (crashed) process should have their `runningAtMs` cleared so the UI
    // doesn't show them as "running" for 2 hours until the inline sanitizer
    // catches up.
    mockedRecover.mockResolvedValue({ scannedProjects: 2, clearedJobs: 3 });
    const { ensureCronSchedulerStarted } = await freshImport();
    await ensureCronSchedulerStarted();
    await new Promise((r) => setImmediate(r));
    expect(mockedRecover).toHaveBeenCalledOnce();
  });

  it("scheduler still starts when recoverStaleCronRunMarkers throws", async () => {
    // The recovery is fire-and-forget; a failure must NOT prevent the
    // scheduler from booting (worst case the 2-hour sanitizer cleans up).
    mockedRecover.mockRejectedValue(new Error("disk full"));
    const { ensureCronSchedulerStarted } = await freshImport();
    await ensureCronSchedulerStarted();
    expect(mockedScheduler).toHaveBeenCalledTimes(1);
    const instance = mockedScheduler.mock.results[0].value as {
      start: ReturnType<typeof vi.fn>;
    };
    expect(instance.start).toHaveBeenCalledOnce();
  });

  it("skips the unified sweepers entry when recovery was aborted before .finally()", async () => {
    // Sprint 2 follow-up: same gating applies — if SIGTERM/SIGINT fires
    // mid-boot the entire sweepers entry (incl. ghost cleanup) is skipped,
    // not just the legacy direct ghost call.
    mockedPending.mockResolvedValue([{ chatId: "c-1" } as any]);
    const { ensureCronSchedulerStarted } = await freshImport();
    await ensureCronSchedulerStarted();

    // Abort BEFORE the promise chain reaches .finally().
    globalThis.__orchestraBootRecoveryController__!.abort();
    await new Promise((r) => setImmediate(r));

    expect(mockedRunAll).not.toHaveBeenCalled();
    expect(mockedEnsureScheduled).not.toHaveBeenCalled();
  });
});

describe("ensureCronSchedulerStarted — idempotency", () => {
  it("second call reuses the existing scheduler (no second constructor)", async () => {
    const { ensureCronSchedulerStarted } = await freshImport();
    await ensureCronSchedulerStarted();
    await ensureCronSchedulerStarted();
    await ensureCronSchedulerStarted();

    expect(mockedScheduler).toHaveBeenCalledTimes(1);
    // But .start() is called every time — start() itself is idempotent.
    const instance = mockedScheduler.mock.results[0].value as {
      start: ReturnType<typeof vi.fn>;
    };
    expect(instance.start).toHaveBeenCalledTimes(3);
  });

  it("does not re-install signal handlers on subsequent calls", async () => {
    const { ensureCronSchedulerStarted } = await freshImport();
    await ensureCronSchedulerStarted();
    const callsAfterFirst = processOnceSpy.mock.calls.length;
    await ensureCronSchedulerStarted();
    await ensureCronSchedulerStarted();
    expect(processOnceSpy.mock.calls.length).toBe(callsAfterFirst);
  });

  it("does not re-run the queue replay on subsequent calls", async () => {
    mockedPending.mockResolvedValue([{ chatId: "c-1" } as any]);
    const { ensureCronSchedulerStarted } = await freshImport();
    await ensureCronSchedulerStarted();
    await new Promise((r) => setImmediate(r));
    expect(mockedDispatch).toHaveBeenCalledOnce();

    await ensureCronSchedulerStarted();
    await new Promise((r) => setImmediate(r));
    // Same count — second call must not re-fire dispatch.
    expect(mockedDispatch).toHaveBeenCalledOnce();
  });
});
