/**
 * Tests for the multi-process boot guard — pins every branch of
 * `assertSingleProcess` without involving `process.exit` (the wrapper
 * is tested implicitly by composition).
 *
 * The escape-hatch and the three positive-detection branches each need
 * coverage so the next maintainer who tweaks the detection logic catches
 * regressions in the same shape we caught the audit gaps.
 *
 * Why we don't test `enforceSingleProcessOrExit` directly: that wrapper
 * calls `process.exit(1)` on detection, which Vitest can't isolate per
 * test. The wrapper body is two lines (assert + console.error +
 * process.exit) — the assert path is what matters for correctness.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertSingleProcess,
  MultiProcessDetectedError,
  MULTI_PROCESS_BYPASS_ENV,
} from "./multi-process-guard";

const noCluster = { isWorker: false };
const workerCluster = { isWorker: true };

describe("assertSingleProcess — single-process happy paths", () => {
  it("returns undefined when env is empty and not a cluster worker", () => {
    expect(() => assertSingleProcess({}, noCluster)).not.toThrow();
  });

  it("accepts NODE_APP_INSTANCE='0' as primary PM2 instance", () => {
    expect(() =>
      assertSingleProcess({ NODE_APP_INSTANCE: "0" }, noCluster)
    ).not.toThrow();
  });

  it("accepts NODE_APP_INSTANCE='' (set but empty) as not-cluster", () => {
    expect(() =>
      assertSingleProcess({ NODE_APP_INSTANCE: "" }, noCluster)
    ).not.toThrow();
  });
});

describe("assertSingleProcess — cluster detection (positive branches)", () => {
  it("throws when cluster.isWorker is true", () => {
    expect(() => assertSingleProcess({}, workerCluster)).toThrow(
      MultiProcessDetectedError
    );
    expect(() => assertSingleProcess({}, workerCluster)).toThrow(
      /cluster\.isWorker/
    );
  });

  it("throws when NODE_APP_INSTANCE='1' (PM2 cluster worker)", () => {
    expect(() =>
      assertSingleProcess({ NODE_APP_INSTANCE: "1" }, noCluster)
    ).toThrow(MultiProcessDetectedError);
    expect(() =>
      assertSingleProcess({ NODE_APP_INSTANCE: "1" }, noCluster)
    ).toThrow(/NODE_APP_INSTANCE/);
  });

  it("throws when NODE_APP_INSTANCE is a large numeric (e.g. '12')", () => {
    expect(() =>
      assertSingleProcess({ NODE_APP_INSTANCE: "12" }, noCluster)
    ).toThrow(MultiProcessDetectedError);
  });

  it("does NOT throw on non-numeric NODE_APP_INSTANCE values", () => {
    // PM2 sometimes sets names like "primary" / "main"; only positive
    // integers should trigger the guard. Anything else is treated as
    // "label, not index" and accepted.
    expect(() =>
      assertSingleProcess({ NODE_APP_INSTANCE: "main" }, noCluster)
    ).not.toThrow();
  });

  it("throws when NODE_UNIQUE_ID is set (node cluster worker env)", () => {
    expect(() =>
      assertSingleProcess({ NODE_UNIQUE_ID: "1" }, noCluster)
    ).toThrow(MultiProcessDetectedError);
    expect(() =>
      assertSingleProcess({ NODE_UNIQUE_ID: "1" }, noCluster)
    ).toThrow(/NODE_UNIQUE_ID/);
  });
});

describe("assertSingleProcess — bypass escape hatch", () => {
  it("bypass='true' (exact string) skips ALL checks", () => {
    expect(() =>
      assertSingleProcess(
        {
          [MULTI_PROCESS_BYPASS_ENV]: "true",
          NODE_APP_INSTANCE: "5",
          NODE_UNIQUE_ID: "9",
        },
        workerCluster
      )
    ).not.toThrow();
  });

  it("bypass='1' is NOT enough (strict string compare — matches DISABLE_AUTH pattern)", () => {
    expect(() =>
      assertSingleProcess(
        {
          [MULTI_PROCESS_BYPASS_ENV]: "1",
          NODE_APP_INSTANCE: "1",
        },
        noCluster
      )
    ).toThrow(MultiProcessDetectedError);
  });

  it("bypass='yes' is NOT enough", () => {
    expect(() =>
      assertSingleProcess(
        {
          [MULTI_PROCESS_BYPASS_ENV]: "yes",
        },
        workerCluster
      )
    ).toThrow(MultiProcessDetectedError);
  });

  it("bypass='TRUE' (case mismatch) is NOT enough", () => {
    expect(() =>
      assertSingleProcess(
        {
          [MULTI_PROCESS_BYPASS_ENV]: "TRUE",
        },
        workerCluster
      )
    ).toThrow(MultiProcessDetectedError);
  });
});

describe("MultiProcessDetectedError — message contents", () => {
  it("error message names the offending signal", () => {
    try {
      assertSingleProcess({}, workerCluster);
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MultiProcessDetectedError);
      expect((err as MultiProcessDetectedError).signal).toBe(
        "cluster.isWorker"
      );
    }
  });

  it("error message points at withFileLock for context", () => {
    try {
      assertSingleProcess({ NODE_APP_INSTANCE: "2" }, noCluster);
      expect.fail("expected throw");
    } catch (err) {
      expect((err as Error).message).toMatch(/withFileLock/);
    }
  });

  it("error message names the bypass env var", () => {
    try {
      assertSingleProcess({ NODE_UNIQUE_ID: "1" }, noCluster);
      expect.fail("expected throw");
    } catch (err) {
      expect((err as Error).message).toMatch(
        new RegExp(MULTI_PROCESS_BYPASS_ENV)
      );
    }
  });
});

describe("enforceSingleProcessOrExit — calls process.exit(1) on detection", () => {
  // The wrapper that boot uses. We can't run `process.exit` for real in a
  // test (vitest worker would die), so we spy and verify the contract.
  // The wrapper is idempotent via a globalThis flag; we clear it between
  // tests so each one exercises the fresh-boot path.
  // Inferred types — vitest's ReturnType-based annotations are fragile
  // across console + process.exit overloads (vitest 3 made the signatures
  // stricter); let the compiler infer from vi.spyOn directly.
  let exitSpy = vi.spyOn(process, "exit");
  let errorSpy = vi.spyOn(console, "error");

  beforeEach(() => {
    delete (globalThis as { __orchestraMultiProcessGuardChecked__?: boolean })
      .__orchestraMultiProcessGuardChecked__;
    // Throw from the spy so the wrapper's `process.exit(1)` doesn't actually
    // exit the test worker; the throw is caught by vitest as a test failure
    // ONLY if we let it propagate (we wrap in try/catch below).
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {
        throw new Error("__test_exit__");
      }) as never);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    delete (globalThis as { __orchestraMultiProcessGuardChecked__?: boolean })
      .__orchestraMultiProcessGuardChecked__;
  });

  it("does NOT call process.exit when running as a primary single process", async () => {
    // Need a fresh module so the idempotency flag is reset.
    vi.resetModules();
    const fresh = await import("./multi-process-guard");
    expect(() => fresh.enforceSingleProcessOrExit()).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("calls process.exit(1) AND logs the MultiProcessDetectedError when a worker is detected", async () => {
    // Stub cluster.isWorker by direct prop-write on the import. The spy on
    // process.exit throws "__test_exit__" so the assertion below catches it.
    const cluster = await import("node:cluster");
    const originalIsWorker = cluster.default.isWorker;
    Object.defineProperty(cluster.default, "isWorker", {
      value: true,
      configurable: true,
    });

    vi.resetModules();
    const fresh = await import("./multi-process-guard");
    expect(() => fresh.enforceSingleProcessOrExit()).toThrow(
      /__test_exit__/
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    // The MultiProcessDetectedError message is printed to stderr before exit.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/MultiProcessGuard.*cluster\.isWorker/i)
    );

    Object.defineProperty(cluster.default, "isWorker", {
      value: originalIsWorker,
      configurable: true,
    });
  });

  it("idempotent on a second call within the same process (globalThis flag)", async () => {
    vi.resetModules();
    const fresh = await import("./multi-process-guard");
    fresh.enforceSingleProcessOrExit();
    // Second call should short-circuit; no new exit even if env changes.
    fresh.enforceSingleProcessOrExit();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
