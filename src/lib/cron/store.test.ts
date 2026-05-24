/**
 * Tests for the cron store — atomic JSON file with `{version, jobs[]}` shape.
 *
 * Pinned invariants:
 *   - Missing file → empty store, NOT an exception. Operators can list cron
 *     jobs in a fresh project that's never had any.
 *   - Malformed `jobs` (non-array, missing) → coerced to `[]`. We do NOT
 *     crash on a corrupted on-disk file.
 *   - Save is atomic: write to a tmp path, then rename. Partial writes
 *     never become the visible state.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { loadCronStore, saveCronStore } from "./store";
import type { CronStoreFile } from "@/lib/cron/types";

let tmpRoot: string;
let storePath: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-cronstore-"));
  storePath = path.join(tmpRoot, "jobs.json");
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("loadCronStore", () => {
  it("returns an empty store when the file does not exist", async () => {
    const store = await loadCronStore(storePath);
    expect(store).toEqual({ version: 1, jobs: [] });
  });

  it("returns the persisted store when the file is valid", async () => {
    const expected: CronStoreFile = {
      version: 1,
      jobs: [
        // The fields beyond `jobId` are domain-specific; we just need a
        // plausible-shaped object to round-trip through JSON.
        { jobId: "j1" } as unknown as CronStoreFile["jobs"][number],
      ],
    };
    await fs.writeFile(storePath, JSON.stringify(expected), "utf-8");
    const store = await loadCronStore(storePath);
    expect(store.jobs).toHaveLength(1);
    expect((store.jobs[0] as unknown as { jobId: string }).jobId).toBe("j1");
  });

  it("coerces a non-array `jobs` field to []", async () => {
    await fs.writeFile(storePath, JSON.stringify({ version: 1, jobs: "oops" }), "utf-8");
    const store = await loadCronStore(storePath);
    expect(store.jobs).toEqual([]);
  });

  it("filters out null/undefined entries from the jobs array", async () => {
    await fs.writeFile(
      storePath,
      JSON.stringify({ version: 1, jobs: [null, { jobId: "x" }, undefined] }),
      "utf-8"
    );
    const store = await loadCronStore(storePath);
    expect(store.jobs).toHaveLength(1);
  });

  it("rethrows on file-system errors that are NOT ENOENT (signals a real problem)", async () => {
    // Use a directory in place of the file — `readFile` will fail with EISDIR.
    await fs.mkdir(storePath, { recursive: true });
    await expect(loadCronStore(storePath)).rejects.toThrow();
  });

  it("propagates JSON parse errors as exceptions (operators can spot corruption)", async () => {
    await fs.writeFile(storePath, "not-json{", "utf-8");
    await expect(loadCronStore(storePath)).rejects.toThrow();
  });
});

describe("saveCronStore — atomic write", () => {
  it("creates the parent directory if it does not exist", async () => {
    const deepPath = path.join(tmpRoot, "nested", "deep", "jobs.json");
    await saveCronStore(deepPath, { version: 1, jobs: [] });
    const stat = await fs.stat(deepPath);
    expect(stat.isFile()).toBe(true);
  });

  it("round-trips through loadCronStore", async () => {
    const expected: CronStoreFile = {
      version: 1,
      jobs: [{ jobId: "round-trip" } as unknown as CronStoreFile["jobs"][number]],
    };
    await saveCronStore(storePath, expected);
    const reloaded = await loadCronStore(storePath);
    expect(reloaded).toEqual(expected);
  });

  it("does not leave a .tmp file in the parent directory after success", async () => {
    await saveCronStore(storePath, { version: 1, jobs: [] });
    const entries = await fs.readdir(path.dirname(storePath));
    expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);
  });
});
