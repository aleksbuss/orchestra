/**
 * Tests for the background-job queue store.
 *
 * The queue is the only thing connecting `dispatchAgentJob` (background
 * mode in /api/chat) to ghost-sweeper recovery on boot. Two regressions
 * matter:
 *   - Enqueue is idempotent on chatId — re-submitting a job overwrites
 *     instead of duplicating.
 *   - Dequeue silently no-ops on a missing file (the daemon may try to
 *     dequeue a job that was already cleaned up by ghost-sweeper).
 *   - getPendingJobs survives a corrupt JSON file (a partial write from
 *     a crashed previous run shouldn't take the whole queue down).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import type { AgentJobPayload } from "@/lib/agent/daemon";

let tmpRoot: string;
let cwdSpy: any;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-queue-"));
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmpRoot);
  vi.resetModules();
});

afterEach(async () => {
  cwdSpy?.mockRestore();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function loadModule() {
  return await import("./queue-store");
}

const job = (chatId: string): AgentJobPayload => ({
  chatId,
  userMessage: `msg for ${chatId}`,
  swarmEnabled: true,
} as AgentJobPayload);

describe("enqueueJob → getPendingJobs round-trip", () => {
  it("returns an empty array when no jobs are queued (fresh install)", async () => {
    const m = await loadModule();
    expect(await m.getPendingJobs()).toEqual([]);
  });

  it("persists one job per chatId", async () => {
    const m = await loadModule();
    await m.enqueueJob(job("c-1"));
    await m.enqueueJob(job("c-2"));
    await m.enqueueJob(job("c-3"));
    const pending = await m.getPendingJobs();
    expect(pending).toHaveLength(3);
    expect(new Set(pending.map((p) => p.chatId))).toEqual(
      new Set(["c-1", "c-2", "c-3"])
    );
  });

  it("re-enqueueing the same chatId OVERWRITES — does not duplicate", async () => {
    const m = await loadModule();
    await m.enqueueJob({ ...job("c-1"), userMessage: "first" });
    await m.enqueueJob({ ...job("c-1"), userMessage: "second" });
    const pending = await m.getPendingJobs();
    expect(pending).toHaveLength(1);
    expect(pending[0].userMessage).toBe("second");
  });
});

describe("dequeueJob", () => {
  it("removes the job from the queue", async () => {
    const m = await loadModule();
    await m.enqueueJob(job("c-1"));
    await m.dequeueJob("c-1");
    expect(await m.getPendingJobs()).toEqual([]);
  });

  it("is a silent no-op on a missing file (daemon idempotency)", async () => {
    const m = await loadModule();
    await expect(m.dequeueJob("never-existed")).resolves.toBeUndefined();
  });

  it("removes only the targeted job; siblings stay queued", async () => {
    const m = await loadModule();
    await m.enqueueJob(job("c-1"));
    await m.enqueueJob(job("c-2"));
    await m.dequeueJob("c-1");
    const pending = await m.getPendingJobs();
    expect(pending).toHaveLength(1);
    expect(pending[0].chatId).toBe("c-2");
  });
});

describe("getPendingJobs — corruption tolerance", () => {
  it("skips a corrupt JSON file and returns the rest", async () => {
    const m = await loadModule();
    await m.enqueueJob(job("c-good"));

    // Plant a corrupt sibling file the way a partial-write crash would leave it.
    const queueDir = path.join(tmpRoot, "data", "queue");
    await fs.writeFile(path.join(queueDir, "c-bad.json"), "{ corrupted", "utf-8");

    const pending = await m.getPendingJobs();
    expect(pending).toHaveLength(1);
    expect(pending[0].chatId).toBe("c-good");
  });

  it("ignores non-.json files in the queue directory (defensive)", async () => {
    const m = await loadModule();
    await m.enqueueJob(job("c-good"));
    const queueDir = path.join(tmpRoot, "data", "queue");
    // Lock files, tmp files, etc. should NOT be parsed as jobs.
    await fs.writeFile(path.join(queueDir, "leftover.lock"), "x", "utf-8");
    await fs.writeFile(path.join(queueDir, "stale.tmp"), "x", "utf-8");

    const pending = await m.getPendingJobs();
    expect(pending).toHaveLength(1);
  });
});
