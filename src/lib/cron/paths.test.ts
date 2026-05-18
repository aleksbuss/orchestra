/**
 * Tests for cron path helpers — pure path math.
 *
 * These functions decide where on disk a cron project's data lives. Two
 * regression hazards:
 *   1. The `GLOBAL_CRON_PROJECT_ID` ("none") special-case must keep working
 *      — global jobs land under `data/cron/main/`, not under a `data/projects/none/`
 *      directory that would compete with real projects named "none".
 *   2. Project-scoped paths must be sandboxed inside `data/projects/<id>/`,
 *      so an attacker submitting a slash-prefixed `projectId` can't escape.
 *      We don't enforce this at the path-helpers level (the routes do via
 *      `assertPathInside` upstream — see PM #6/#16), but the helpers must
 *      not silently MAKE the escape easier than the natural `path.join`.
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  GLOBAL_CRON_PROJECT_ID,
  resolveCronProjectDir,
  resolveCronStorePath,
  resolveCronRunsDir,
  resolveCronRunLogPath,
} from "./paths";

const cwd = process.cwd();

describe("resolveCronProjectDir — global vs project-scoped", () => {
  it("global id 'none' resolves under data/cron/main/", () => {
    expect(resolveCronProjectDir(GLOBAL_CRON_PROJECT_ID)).toBe(
      path.join(cwd, "data", "cron", "main")
    );
  });

  it("empty / whitespace-only project id falls into the global bucket", () => {
    const expected = path.join(cwd, "data", "cron", "main");
    expect(resolveCronProjectDir("")).toBe(expected);
    expect(resolveCronProjectDir("   ")).toBe(expected);
  });

  it("real project id resolves under data/projects/<id>/.meta/cron/", () => {
    expect(resolveCronProjectDir("proj-1")).toBe(
      path.join(cwd, "data", "projects", "proj-1", ".meta", "cron")
    );
  });

  it("trims surrounding whitespace before resolving", () => {
    expect(resolveCronProjectDir("  proj-1  ")).toBe(
      path.join(cwd, "data", "projects", "proj-1", ".meta", "cron")
    );
  });
});

describe("resolveCronStorePath / resolveCronRunsDir / resolveCronRunLogPath", () => {
  it("store path is a sibling of the runs dir under the same project root", () => {
    const proj = "proj-2";
    const dir = resolveCronProjectDir(proj);
    expect(resolveCronStorePath(proj)).toBe(path.join(dir, "jobs.json"));
    expect(resolveCronRunsDir(proj)).toBe(path.join(dir, "runs"));
  });

  it("run-log path is <runs-dir>/<jobId>.jsonl", () => {
    expect(resolveCronRunLogPath("proj-3", "job-abc")).toBe(
      path.join(resolveCronRunsDir("proj-3"), "job-abc.jsonl")
    );
  });

  it("global runs dir lands under data/cron/main/runs/", () => {
    expect(resolveCronRunsDir(GLOBAL_CRON_PROJECT_ID)).toBe(
      path.join(cwd, "data", "cron", "main", "runs")
    );
  });
});
