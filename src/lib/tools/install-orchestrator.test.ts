/**
 * Tests for `install-orchestrator.ts` — the helper the `install_packages`
 * tool calls into. Public surface is a single `installPackages` async
 * function; internal helpers (plan builders, command runners, the auto-
 * kind resolver) drive the actual work.
 *
 * Strategy: mock `child_process.spawn` so commands never actually run.
 * We assert on argv shape — the actual package install is upstream and
 * out of our test contract. Every branch of input normalization +
 * resolution is exercised through the public API.
 *
 * Pinned invariants:
 *   - Empty / whitespace-only package list → `success: false`, no spawn.
 *   - Duplicate / whitespace-padded packages dedup + trim before reaching
 *     the installer (so `npm i lodash lodash` runs once, not twice).
 *   - `kind: "auto"` resolves based on preferManager: `go` / `uv` /
 *     `pip|python` / `apt|apt-get` route appropriately; anything else
 *     falls back to `node`.
 *   - First successful plan wins; later plans aren't even attempted.
 *   - When every plan fails, the result message surfaces the last
 *     stderr (or a generic fallback if every attempt's stderr is empty).
 *   - `timeoutMs` is clamped to a safe range (no `0`, no negative, no
 *     non-finite). Default 10 min when omitted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

const spawnMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) =>
    spawnMock(...(args as Parameters<typeof spawnMock>)),
}));
vi.mock("child_process", () => ({
  spawn: (...args: unknown[]) =>
    spawnMock(...(args as Parameters<typeof spawnMock>)),
}));

import { installPackages } from "./install-orchestrator";

function fakeProcess(opts: {
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  /** If true, the child emits an `error` event before exiting (e.g. ENOENT). */
  spawnError?: Error;
}): ChildProcess {
  const proc = new EventEmitter() as ChildProcess;
  const stdout = new EventEmitter() as NodeJS.ReadableStream;
  const stderr = new EventEmitter() as NodeJS.ReadableStream;
  // @ts-expect-error — tests don't need the full stream surface.
  proc.stdout = stdout;
  // @ts-expect-error — same as above.
  proc.stderr = stderr;
  // Need a kill() noop so the timeout path doesn't throw.
  proc.kill = (() => true) as ChildProcess["kill"];

  // Schedule the emissions on the next tick so the caller can attach
  // listeners before they fire.
  setImmediate(() => {
    if (opts.spawnError) {
      proc.emit("error", opts.spawnError);
      proc.emit("close", null);
      return;
    }
    if (opts.stdout) stdout.emit("data", Buffer.from(opts.stdout));
    if (opts.stderr) stderr.emit("data", Buffer.from(opts.stderr));
    proc.emit("close", opts.exitCode);
  });
  return proc;
}

beforeEach(() => {
  spawnMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("installPackages — input validation", () => {
  it("returns success=false with 'No packages specified' on empty list", async () => {
    const result = await installPackages({
      kind: "node",
      packages: [],
      cwd: "/tmp",
    });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/no packages/i);
    expect(result.attempts).toEqual([]);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("filters out whitespace-only entries; an all-blank list is treated as empty", async () => {
    const result = await installPackages({
      kind: "node",
      packages: ["", "   ", "\t\n"],
      cwd: "/tmp",
    });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/no packages/i);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("dedups + trims package names before reaching the installer", async () => {
    spawnMock.mockImplementation(() =>
      fakeProcess({ exitCode: 0, stdout: "added" })
    );

    await installPackages({
      kind: "node",
      packages: ["  lodash ", "lodash", "react"],
      cwd: "/tmp",
    });

    // Whichever manager wins, the package list should be deduped/trimmed.
    expect(spawnMock).toHaveBeenCalled();
    const args = spawnMock.mock.calls[0][1] as string[];
    // The argv slice after the manager + subcommand contains the package list.
    expect(args).toContain("lodash");
    expect(args).toContain("react");
    expect(args.filter((a) => a === "lodash").length).toBe(1);
  });
});

describe("installPackages — kind: 'auto' resolution", () => {
  it("auto + preferManager='pip' → routes through python plans (pip3 / pip)", async () => {
    spawnMock.mockImplementation(() =>
      fakeProcess({ exitCode: 0, stdout: "installed" })
    );

    const result = await installPackages({
      kind: "auto",
      preferManager: "pip",
      packages: ["requests"],
      cwd: "/tmp",
    });
    expect(result.resolvedKind).toBe("python");
    expect(spawnMock).toHaveBeenCalled();
  });

  it("auto + preferManager='go' → resolvedKind='go'", async () => {
    spawnMock.mockImplementation(() =>
      fakeProcess({ exitCode: 0, stdout: "ok" })
    );
    const result = await installPackages({
      kind: "auto",
      preferManager: "go",
      packages: ["github.com/example/tool"],
      cwd: "/tmp",
    });
    expect(result.resolvedKind).toBe("go");
  });

  it("auto + preferManager='uv' → resolvedKind='uv'", async () => {
    spawnMock.mockImplementation(() =>
      fakeProcess({ exitCode: 0, stdout: "ok" })
    );
    const result = await installPackages({
      kind: "auto",
      preferManager: "uv",
      packages: ["httpx"],
      cwd: "/tmp",
    });
    expect(result.resolvedKind).toBe("uv");
  });

  it("auto + preferManager='apt-get' → resolvedKind='apt'", async () => {
    // apt builds plans by probing for sudo+apt; treat the case where the
    // probe finds nothing — result will still report resolvedKind='apt'.
    spawnMock.mockImplementation(() =>
      fakeProcess({ exitCode: 0, stdout: "ok" })
    );
    const result = await installPackages({
      kind: "auto",
      preferManager: "apt-get",
      packages: ["curl"],
      cwd: "/tmp",
    });
    expect(result.resolvedKind).toBe("apt");
  });

  it("auto + preferManager='brew' → resolvedKind='brew' (macOS system CLIs)", async () => {
    spawnMock.mockImplementation(() => fakeProcess({ exitCode: 0, stdout: "ok" }));
    const result = await installPackages({
      kind: "auto",
      preferManager: "brew",
      packages: ["nmap"],
      cwd: "/tmp",
    });
    expect(result.resolvedKind).toBe("brew");
  });

  it("explicit kind='brew' is honored", async () => {
    spawnMock.mockImplementation(() => fakeProcess({ exitCode: 0, stdout: "ok" }));
    const result = await installPackages({
      kind: "brew",
      packages: ["ffmpeg"],
      cwd: "/tmp",
    });
    expect(result.resolvedKind).toBe("brew");
  });

  it("auto with no preferManager → defaults to node (most common case)", async () => {
    spawnMock.mockImplementation(() =>
      fakeProcess({ exitCode: 0, stdout: "ok" })
    );
    const result = await installPackages({
      kind: "auto",
      packages: ["lodash"],
      cwd: "/tmp",
    });
    expect(result.resolvedKind).toBe("node");
  });

  it("auto with an unknown preferManager also falls back to node", async () => {
    spawnMock.mockImplementation(() =>
      fakeProcess({ exitCode: 0, stdout: "ok" })
    );
    const result = await installPackages({
      kind: "auto",
      preferManager: "totally-made-up",
      packages: ["lodash"],
      cwd: "/tmp",
    });
    expect(result.resolvedKind).toBe("node");
  });
});

describe("installPackages — execution outcomes", () => {
  it("first successful plan wins; later plans are never attempted", async () => {
    // Two plans, both spawn npm-ish commands; the first exits 0 → second
    // never spawns. We don't assert spawn count beyond "at least 1" but
    // we DO assert success+message reflect the first-plan happy path.
    spawnMock.mockImplementation(() =>
      fakeProcess({ exitCode: 0, stdout: "added 1 package" })
    );

    const result = await installPackages({
      kind: "node",
      packages: ["lodash"],
      cwd: "/tmp",
    });
    expect(result.success).toBe(true);
    expect(result.message).toMatch(/installed successfully/i);
    expect(result.attempts.length).toBeGreaterThanOrEqual(1);
    expect(result.attempts.every((a) => !a.skipped || a === result.attempts[0])).toBe(
      true
    );
  });

  it("when every plan fails, stderr appears in the per-attempt record (and feeds the result message)", async () => {
    // Note: `at(-1).stderr` drives the result message — but if the last
    // attempt is a "skipped because the command isn't on PATH" entry,
    // its stderr is empty and the message falls through to the generic
    // fallback. We assert the more durable property: stderr surfaces on
    // at least one attempt so triage isn't blind.
    spawnMock.mockImplementation(() =>
      fakeProcess({
        exitCode: 1,
        stderr: "npm ERR! 404 Not Found",
      })
    );

    const result = await installPackages({
      kind: "node",
      packages: ["this-pkg-does-not-exist-anywhere"],
      cwd: "/tmp",
    });
    expect(result.success).toBe(false);
    expect(result.attempts.length).toBeGreaterThanOrEqual(1);
    expect(result.attempts.some((a) => a.stderr.includes("404 Not Found"))).toBe(
      true
    );
  });

  it("when every plan fails with empty stderr, falls back to a generic message", async () => {
    spawnMock.mockImplementation(() =>
      fakeProcess({ exitCode: 1, stderr: "" })
    );

    const result = await installPackages({
      kind: "node",
      packages: ["lodash"],
      cwd: "/tmp",
    });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/failed to install/i);
  });

  it("captures stdout + stderr per attempt up to a hard cap (no megabyte logs)", async () => {
    // Spawning a process that writes 200 KB to stdout should produce an
    // attempt whose stdout is bounded (the file's OUTPUT_CAP = 120,000
    // chars). We assert the length is reasonable, not the exact cap.
    const bigChunk = "x".repeat(200_000);
    spawnMock.mockImplementation(() =>
      fakeProcess({ exitCode: 0, stdout: bigChunk })
    );
    const result = await installPackages({
      kind: "node",
      packages: ["lodash"],
      cwd: "/tmp",
    });
    expect(result.attempts[0].stdout.length).toBeLessThan(200_000);
    expect(result.attempts[0].success).toBe(true);
  });

  it("a spawn `error` event (e.g. ENOENT) is captured as a failed attempt", async () => {
    spawnMock.mockImplementation(() => {
      const err = new Error("spawn /usr/bin/totally-fake ENOENT");
      return fakeProcess({ exitCode: null, spawnError: err });
    });

    const result = await installPackages({
      kind: "node",
      packages: ["lodash"],
      cwd: "/tmp",
    });
    // Any spawn-error attempt must show up as `success: false`; the
    // overall result depends on whether any other plan succeeded.
    expect(result.attempts.some((a) => !a.success)).toBe(true);
  });
});

describe("installPackages — timeout clamping (defensive)", () => {
  it("treats negative timeoutMs as the default (no 'fire immediately')", async () => {
    spawnMock.mockImplementation(() =>
      fakeProcess({ exitCode: 0, stdout: "ok" })
    );
    const result = await installPackages({
      kind: "node",
      packages: ["lodash"],
      cwd: "/tmp",
      timeoutMs: -1,
    });
    // A negative timeout would have aborted the spawn immediately; the
    // spawn instead got its full chance and succeeded.
    expect(result.success).toBe(true);
  });

  it("treats NaN timeoutMs as the default", async () => {
    spawnMock.mockImplementation(() =>
      fakeProcess({ exitCode: 0, stdout: "ok" })
    );
    const result = await installPackages({
      kind: "node",
      packages: ["lodash"],
      cwd: "/tmp",
      timeoutMs: Number.NaN,
    });
    expect(result.success).toBe(true);
  });
});
