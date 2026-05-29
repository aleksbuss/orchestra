import { CronScheduler, recoverStaleCronRunMarkers } from "@/lib/cron/service";
import { getPendingJobs } from "@/lib/storage/queue-store";
import { dispatchAgentJob } from "@/lib/agent/daemon";
import { ensureSweepersScheduled, runAllSweepers } from "@/lib/cron/sweepers";

declare global {
  // eslint-disable-next-line no-var
  var __orchestraCronScheduler__: CronScheduler | undefined;
  // eslint-disable-next-line no-var
  var __orchestraBootRecoveryController__: AbortController | undefined;
  // eslint-disable-next-line no-var
  var __orchestraShutdownHandlersInstalled__: boolean | undefined;
}

/**
 * Module-level abort controller for boot-time recovery work.
 *
 * Why this exists: PM #1 residual gap — queue recovery used to dispatch every
 * pending job in a tight loop, with no path to cancel mid-loop on shutdown.
 * If the process received SIGTERM during recovery, it would keep spawning
 * fresh `dispatchAgentJob` calls (each with its own `AbortController`) until
 * the OS killed the process — leaking work and confusing the next boot.
 *
 * The controller is global-keyed so a Next.js dev-mode reload doesn't create
 * a second one and double-bind the signal handlers.
 */
function getBootRecoveryController(): AbortController {
  if (!globalThis.__orchestraBootRecoveryController__) {
    globalThis.__orchestraBootRecoveryController__ = new AbortController();
  }
  return globalThis.__orchestraBootRecoveryController__;
}

function installShutdownHandlers(controller: AbortController): void {
  if (globalThis.__orchestraShutdownHandlersInstalled__) return;
  globalThis.__orchestraShutdownHandlersInstalled__ = true;

  const onSignal = (sig: string) => {
    if (!controller.signal.aborted) {
      console.log(`[TaskQueue] Received ${sig}, aborting boot recovery loop.`);
      controller.abort();
    }
  };
  process.once("SIGTERM", () => onSignal("SIGTERM"));
  process.once("SIGINT", () => onSignal("SIGINT"));
}

export async function ensureCronSchedulerStarted(): Promise<void> {
  if (!globalThis.__orchestraCronScheduler__) {
    globalThis.__orchestraCronScheduler__ = new CronScheduler();

    const recoveryController = getBootRecoveryController();
    installShutdownHandlers(recoveryController);
    const recoverySignal = recoveryController.signal;

    // 0. Cron job recovery — clear any `runningAtMs` markers left over from
    //    a previous process. Without this, jobs that were running at the
    //    time of a crash stay "running" in the UI until the 2-hour
    //    STUCK_RUN_MS sanitizer clears them. Fire-and-forget; we don't
    //    block the scheduler boot on this (worst case the 2-hour sanitizer
    //    catches whatever we miss).
    void recoverStaleCronRunMarkers().catch(err => {
      console.error("[CronRecovery] Failed to recover stale run markers:", err);
    });

    // 1. Recover and resume pending background jobs from the robust queue.
    //    Abort gate: bail out of the loop on SIGTERM/SIGINT so we don't keep
    //    spawning new daemon jobs while the process is being torn down.
    getPendingJobs().then(jobs => {
      for (const job of jobs) {
        if (recoverySignal.aborted) {
          console.log(`[TaskQueue] Boot recovery aborted; ${jobs.length - jobs.indexOf(job)} job(s) deferred until next boot.`);
          break;
        }
        console.log(`[TaskQueue] Resuming background job for chat ${job.chatId}`);
        dispatchAgentJob(job).catch(console.error);
      }
    }).finally(() => {
      // 2. Data-directory sweepers (PM #32): tmp/ + orphan queue entries +
      //    ghost-task cleanup. Boot-time run gives the operator immediate
      //    cleanup on every restart; the recurring 6h interval (registered
      //    by `ensureSweepersScheduled`) handles long-running deployments.
      //    Sprint 2 follow-up: ghost-task sweep used to be its own explicit
      //    call here (boot-only), which meant a mid-uptime crash-leaked
      //    in_progress task stayed orphan until the next restart. It's
      //    now folded into `runAllSweepers()`, so both the boot run AND
      //    the recurring 6h tick catch ghosts. Both gated on the same
      //    recovery signal — if shutdown started mid-boot, skip the sweep.
      if (recoverySignal.aborted) return;
      void runAllSweepers().catch((err) => {
        console.warn("[TaskQueue] Boot-time sweepers failed:", err);
      });
      ensureSweepersScheduled();
    });
  }
  globalThis.__orchestraCronScheduler__.start();
}
