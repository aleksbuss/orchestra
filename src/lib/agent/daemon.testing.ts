/**
 * Test-only helpers for `daemon.ts`. Used by `daemon.test.ts` to exercise
 * private state (the auto-pilot timeouts Map) for PM #7 regression coverage
 * without going through the full `runAgent` mock chain.
 *
 * Two layers of defense ensure this file never affects production:
 *
 *   1. The `*.testing.ts` filename convention signals intent — production
 *      code MUST NOT import from a `*.testing.ts` module. A code review
 *      that spots `import "./daemon.testing"` outside a `*.test.ts` file
 *      should reject the change.
 *
 *   2. `assertNotProduction()` throws loudly if any entry point fires
 *      under `NODE_ENV=production`. Vitest sets `NODE_ENV=test`, Next dev
 *      sets `development`, real builds set `production`. So even if convention
 *      #1 is violated, production deployments fail-loud rather than silently
 *      corrupting state.
 *
 * Note: this file IS bundled into production builds (the `.testing.` part
 * is convention, not a Next.js exclusion rule). The runtime guard is the
 * actual safety net. If you want to exclude this from prod bundles, add a
 * webpack/turbopack ignore rule for `*.testing.ts` in `next.config.mjs`.
 */
import {
  __getAutoPilotTimeoutsForTesting,
  __getAutoPilotIterationsForTesting,
} from "./daemon";

function assertNotProduction(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "daemon.testing helpers are forbidden in production. " +
        "These exist only for vitest regression coverage of PM #7."
    );
  }
}

/** Mirrors the behaviour exercised by PM #7 regression tests. */
export function hasPendingAutoPilotTimeout(chatId: string): boolean {
  assertNotProduction();
  return __getAutoPilotTimeoutsForTesting().has(chatId);
}

/** Current auto-pilot iteration count for a chat (0 if absent). */
export function getAutoPilotIterations(chatId: string): number {
  assertNotProduction();
  return __getAutoPilotIterationsForTesting().get(chatId) ?? 0;
}

/** Directly seed the iteration counter (test setup for the cap-bypass regression). */
export function setAutoPilotIterations(chatId: string, n: number): void {
  assertNotProduction();
  __getAutoPilotIterationsForTesting().set(chatId, n);
}

/** Clear the iteration counter for a chat (test cleanup). */
export function clearAutoPilotIterations(chatId: string): void {
  assertNotProduction();
  __getAutoPilotIterationsForTesting().delete(chatId);
}

/**
 * Schedule a fake auto-pilot iteration for tests. Mirrors the production
 * setTimeout block in `daemon.ts:runBackgroundJob` — registers in the
 * timeouts Map and self-cleans on fire. Tests use this to verify that
 * `abortJob` clears the timeout BEFORE it fires (PM #7).
 */
export function primeAutoPilotTimeout(
  chatId: string,
  ms: number,
  cb: () => void
): void {
  assertNotProduction();
  const timeouts = __getAutoPilotTimeoutsForTesting();
  const timer = setTimeout(() => {
    timeouts.delete(chatId);
    cb();
  }, ms);
  timeouts.set(chatId, timer);
}
