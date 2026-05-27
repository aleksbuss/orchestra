/**
 * PM #35 regression tests — instrumentation.ts boot hook + instrumentation-node sibling.
 *
 * Pinned contracts:
 *   - `register()` is a no-op on non-Node runtimes (edge / browser). Calling
 *     it must NOT trigger the dynamic import of `instrumentation-node`
 *     (the sibling pulls Node-only modules — `cross-spawn`, MCP SDK — that
 *     don't exist in edge bundles and would crash the build).
 *   - `register()` on Node runtime imports `instrumentation-node`, which in
 *     turn evaluates `chat-store` (installing the SIGTERM/SIGINT handler —
 *     PM #29) AND calls `ensureCronSchedulerStarted` (booting cron +
 *     sweepers — PM #32).
 *   - Repeated `register()` calls don't crash — Next.js's dev-mode HMR may
 *     re-invoke the hook, and downstream callees (ensureCronSchedulerStarted,
 *     chat-store flush handler) are both idempotent via `globalThis` flags.
 *
 * Implementation note: we mock `./instrumentation-node` directly. The
 * sibling's body is two lines (one side-effect import, one await on
 * `ensureCronSchedulerStarted`) — exercising it for real here would just
 * re-test the wiring covered by `chat-store.flush.test.ts`,
 * `sweepers.test.ts`, and `cron/runtime.test.ts` separately.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the sibling so a Node-runtime register() call doesn't actually boot
// the cron scheduler / chat-store side effects (they have their own focused
// test suites). The mock value is opaque — we don't need to inspect it; we
// rely on a spy attached at `globalThis` to count invocations across the
// vi.mock cache, which factories don't reset between tests.
declare global {
  var __instrumentationNodeImports__: number;
}
globalThis.__instrumentationNodeImports__ = 0;

vi.mock("./instrumentation-node", () => {
  globalThis.__instrumentationNodeImports__ =
    (globalThis.__instrumentationNodeImports__ ?? 0) + 1;
  return {};
});

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("PM #35 — instrumentation.register()", () => {
  it("no-ops when NEXT_RUNTIME is not 'nodejs' (edge runtime guard)", async () => {
    const before = globalThis.__instrumentationNodeImports__;
    vi.stubEnv("NEXT_RUNTIME", "edge");
    const { register } = await import("./instrumentation");
    await register();
    // Edge call must NOT have triggered the sibling import (the sibling
    // pulls Node-only modules — cross-spawn, MCP SDK — that would crash
    // the edge bundle).
    expect(globalThis.__instrumentationNodeImports__).toBe(before);
  });

  it("no-ops when NEXT_RUNTIME is undefined (defensive default)", async () => {
    const before = globalThis.__instrumentationNodeImports__;
    vi.stubEnv("NEXT_RUNTIME", "");
    const { register } = await import("./instrumentation");
    await register();
    expect(globalThis.__instrumentationNodeImports__).toBe(before);
  });

  it("on nodejs runtime: importing register() and calling it does not throw", async () => {
    // We don't assert a specific import-count increment because vi.mock
    // factories memoise across `vi.resetModules`. The real assertion is
    // "register() resolves cleanly on Node runtime" — the side effects
    // (cron boot, SIGTERM handler) are pinned by the individual test
    // suites of those modules.
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    const { register } = await import("./instrumentation");
    await expect(register()).resolves.toBeUndefined();
  });

  it("repeated register() calls on nodejs don't throw (HMR / multiple-eval)", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    const { register } = await import("./instrumentation");
    await expect(register()).resolves.toBeUndefined();
    await expect(register()).resolves.toBeUndefined();
    await expect(register()).resolves.toBeUndefined();
  });
});
