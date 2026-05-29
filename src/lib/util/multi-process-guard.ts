/**
 * Multi-process boot guard.
 *
 * CLAUDE.md "Critical Rule §1 — Single-process invariant" calls out that
 * `withFileLock` is an in-process Map-keyed promise chain; it serialises
 * reads/writes WITHIN the same Node process only. Deploying Orchestra in
 * cluster mode (PM2 `instances: > 1`, Node `cluster.fork()` workers,
 * multiple containers behind a shared `data/` volume) means cross-process
 * concurrent writes lost-update each other silently — chat history goes
 * missing, project blackboards corrupt, settings.json races on auth flows.
 *
 * The rule has been documented since PM #29; this guard makes it executable.
 * The first time the Node bundle boots in a worker context, the operator
 * gets a fatal exit with a precise error message instead of a slow drip of
 * data loss they'll spend a week diagnosing.
 *
 * Detection signals (any positive match → refuse to boot):
 *
 *   1. `cluster.isWorker === true` from `node:cluster`. This is the
 *      unambiguous signal that the current process was forked by Node's
 *      cluster module as a worker. Set automatically by `cluster.fork()`.
 *
 *   2. `process.env.NODE_APP_INSTANCE` is set to a non-"0" numeric value.
 *      PM2 cluster mode sets this on every worker (primary = "0", workers
 *      = "1", "2", …). The "0" case is the primary instance OR a PM2 fork
 *      mode (always "0") — both safe.
 *
 *   3. `process.env.NODE_UNIQUE_ID` is set. Node's `cluster` module sets
 *      this on workers; PM2 forwards it too. Belt-and-suspenders for the
 *      cluster.isWorker check, in case a custom forker preserves the env
 *      without setting cluster state.
 *
 * Escape hatch — same shape as `ORCHESTRA_DISABLE_AUTH` (CLAUDE.md "Auth
 * escape hatches"):
 *
 *   ORCHESTRA_MULTI_PROCESS_OK=true
 *
 * Strict string compare — "1", "yes", "TRUE" are intentionally not enough.
 * Use this ONLY after you've migrated `withFileLock` to an advisory
 * lockfile primitive (e.g. `proper-lockfile`). Setting it without that
 * migration trades one class of silent data loss for another.
 *
 * The check runs at module load via `enforceSingleProcessOrExit()`. The
 * `assertSingleProcess()` helper is exported separately so unit tests
 * can pin every branch without involving `process.exit`.
 */

import cluster from "node:cluster";

export const MULTI_PROCESS_BYPASS_ENV = "ORCHESTRA_MULTI_PROCESS_OK";

export interface ProcessEnvSnapshot {
  NODE_APP_INSTANCE?: string;
  NODE_UNIQUE_ID?: string;
  [MULTI_PROCESS_BYPASS_ENV]?: string;
}

export interface ClusterSnapshot {
  isWorker: boolean;
}

export class MultiProcessDetectedError extends Error {
  readonly signal: string;
  constructor(signal: string, detail: string) {
    super(
      `Orchestra refuses to boot in multi-process mode (${signal}). ${detail}\n\n` +
        `Why: src/lib/storage/fs-utils.ts:withFileLock is an in-process Map. ` +
        `Cluster-mode deploys lost-update each other across processes — chat ` +
        `history, project blackboards, and settings.json all silently corrupt.\n\n` +
        `Fix one of:\n` +
        `  • Set PM2 instances: 1 (or remove cluster_mode: true)\n` +
        `  • Run a single container instead of N replicas behind a shared volume\n` +
        `  • Don't use cluster.fork() — Orchestra is single-process by design\n\n` +
        `Override (only after migrating withFileLock to an advisory lockfile):\n` +
        `  ${MULTI_PROCESS_BYPASS_ENV}=true`
    );
    this.name = "MultiProcessDetectedError";
    this.signal = signal;
  }
}

/**
 * Pure synchronous assertion — throws MultiProcessDetectedError if any
 * cluster signal fires AND the bypass env var is not exactly "true".
 *
 * Both `env` and `clusterSnapshot` are injectable so the unit test pins
 * every branch without globally mutating process.env / node:cluster.
 */
export function assertSingleProcess(
  env: ProcessEnvSnapshot = process.env as ProcessEnvSnapshot,
  clusterSnapshot: ClusterSnapshot = cluster
): void {
  // Bypass check is strict string compare — see CLAUDE.md "Auth escape
  // hatches" for the same posture on ORCHESTRA_DISABLE_AUTH.
  if (env[MULTI_PROCESS_BYPASS_ENV] === "true") {
    return;
  }

  if (clusterSnapshot.isWorker) {
    throw new MultiProcessDetectedError(
      "cluster.isWorker",
      "node:cluster reports this process is a worker forked by cluster.fork()."
    );
  }

  const instance = env.NODE_APP_INSTANCE;
  if (instance !== undefined && instance !== "" && instance !== "0") {
    // PM2 cluster mode: primary = "0", workers = "1"+.
    const parsed = Number.parseInt(instance, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      throw new MultiProcessDetectedError(
        "NODE_APP_INSTANCE",
        `process.env.NODE_APP_INSTANCE=${JSON.stringify(instance)} indicates a non-primary PM2 cluster worker.`
      );
    }
  }

  if (env.NODE_UNIQUE_ID !== undefined && env.NODE_UNIQUE_ID !== "") {
    throw new MultiProcessDetectedError(
      "NODE_UNIQUE_ID",
      `process.env.NODE_UNIQUE_ID=${JSON.stringify(env.NODE_UNIQUE_ID)} is set by Node's cluster module on worker processes.`
    );
  }
}

/**
 * Boot-time wrapper — runs the assertion, prints the error to stderr,
 * and exits with code 1 on detection. The `process.exit` path is the
 * non-test caller; tests use `assertSingleProcess` directly.
 *
 * Idempotent via globalThis flag so dev-mode HMR re-evals don't repeat
 * the check (the env doesn't change between HMR cycles).
 */
declare global {
  var __orchestraMultiProcessGuardChecked__: boolean | undefined;
}

export function enforceSingleProcessOrExit(): void {
  if (globalThis.__orchestraMultiProcessGuardChecked__) return;
  globalThis.__orchestraMultiProcessGuardChecked__ = true;

  try {
    assertSingleProcess();
  } catch (err) {
    if (err instanceof MultiProcessDetectedError) {
      console.error(`[MultiProcessGuard] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}
