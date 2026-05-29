/**
 * PM #32 regression tests — data/ cleanup sweepers.
 *
 * What this pins:
 *   - sweepTempDir: deletes files OLDER than maxAgeMs; leaves recent files,
 *     directories, and symlinks untouched.
 *   - sweepOrphanQueueEntries: deletes queue entries whose chatId is NOT in
 *     the live chat set; leaves entries that match a live chat.
 *   - Both: missing directory is not an error (fresh install); errors on
 *     individual files don't abort the sweep.
 */
import fs from "fs/promises";
import path from "path";
import os from "os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir: string;
let sweepers: typeof import("./sweepers");

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-sweep-"));
  vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
  // Silence console.warn from error-path assertions.
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.resetModules();
  sweepers = await import("./sweepers");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeWithMtime(
  filePath: string,
  content: string,
  mtimeMs: number
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
  const ts = mtimeMs / 1000;
  await fs.utimes(filePath, ts, ts);
}

describe("PM #32 — sweepTempDir", () => {
  it("returns zero-result if data/tmp does not exist (fresh install)", async () => {
    const out = await sweepers.sweepTempDir();
    expect(out).toEqual({
      scanned: 0,
      removed: 0,
      errors: 0,
      removedSample: [],
    });
  });

  it("deletes files older than maxAgeMs and keeps recent ones", async () => {
    const tmp = path.join(tmpDir, "data", "tmp");
    const now = Date.now();
    const ancient = now - 30 * 24 * 60 * 60 * 1000; // 30 days ago
    const recent = now - 60 * 60 * 1000; // 1 hour ago

    await writeWithMtime(path.join(tmp, "old-1.bin"), "data", ancient);
    await writeWithMtime(path.join(tmp, "old-2.bin"), "data", ancient);
    await writeWithMtime(path.join(tmp, "recent.bin"), "data", recent);

    const out = await sweepers.sweepTempDir(7 * 24 * 60 * 60 * 1000); // 7d
    expect(out.scanned).toBe(3);
    expect(out.removed).toBe(2);
    expect(out.errors).toBe(0);
    expect(out.removedSample.sort()).toEqual(["old-1.bin", "old-2.bin"]);

    const remaining = await fs.readdir(tmp);
    expect(remaining).toEqual(["recent.bin"]);
  });

  it("skips directories — only sweeps regular files", async () => {
    const tmp = path.join(tmpDir, "data", "tmp");
    await fs.mkdir(path.join(tmp, "old-dir"), { recursive: true });
    // Make the directory ancient.
    const ancient = (Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000;
    await fs.utimes(path.join(tmp, "old-dir"), ancient, ancient);

    const out = await sweepers.sweepTempDir();
    expect(out.removed).toBe(0);

    // Directory still there.
    const stat = await fs.stat(path.join(tmp, "old-dir"));
    expect(stat.isDirectory()).toBe(true);
  });
});

describe("PM #32 — sweepOrphanQueueEntries", () => {
  it("returns zero-result if data/queue does not exist", async () => {
    const out = await sweepers.sweepOrphanQueueEntries(new Set());
    expect(out.scanned).toBe(0);
    expect(out.removed).toBe(0);
  });

  it("deletes entries for chatIds NOT in the live set, keeps the rest", async () => {
    const queue = path.join(tmpDir, "data", "queue");
    await fs.mkdir(queue, { recursive: true });
    await fs.writeFile(path.join(queue, "live-1.json"), "{}");
    await fs.writeFile(path.join(queue, "live-2.json"), "{}");
    await fs.writeFile(path.join(queue, "orphan-a.json"), "{}");
    await fs.writeFile(path.join(queue, "orphan-b.json"), "{}");
    // Non-json file — must be ignored entirely (neither scanned nor deleted).
    await fs.writeFile(path.join(queue, "stray.txt"), "x");

    const live = new Set(["live-1", "live-2"]);
    const out = await sweepers.sweepOrphanQueueEntries(live);

    expect(out.scanned).toBe(4); // 4 .json files
    expect(out.removed).toBe(2);
    expect(out.errors).toBe(0);
    expect(out.removedSample.sort()).toEqual([
      "orphan-a.json",
      "orphan-b.json",
    ]);

    const remaining = (await fs.readdir(queue)).sort();
    expect(remaining).toEqual(["live-1.json", "live-2.json", "stray.txt"]);
  });

  it("empty live set deletes everything queue-ish", async () => {
    const queue = path.join(tmpDir, "data", "queue");
    await fs.mkdir(queue, { recursive: true });
    await fs.writeFile(path.join(queue, "any-1.json"), "{}");
    await fs.writeFile(path.join(queue, "any-2.json"), "{}");

    const out = await sweepers.sweepOrphanQueueEntries(new Set());
    expect(out.removed).toBe(2);
  });
});

describe("PM #32 — ensureSweepersScheduled idempotency", () => {
  it("multi-call doesn't stack interval timers", () => {
    sweepers.ensureSweepersScheduled();
    const first = globalThis.__orchestraSweepInterval__;
    sweepers.ensureSweepersScheduled();
    const second = globalThis.__orchestraSweepInterval__;
    expect(first).toBeDefined();
    expect(second).toBe(first);
    // Cleanup so subsequent test files don't see a leaked timer.
    clearInterval(first);
    globalThis.__orchestraSweepInterval__ = undefined;
  });
});

describe("Sprint 5 — sweepOrphanChatFiles", () => {
  it("returns zero-result when data/chat-files does not exist (fresh install)", async () => {
    const out = await sweepers.sweepOrphanChatFiles(new Set());
    expect(out).toEqual({
      scanned: 0,
      removed: 0,
      errors: 0,
      removedSample: [],
    });
  });

  it("removes <chatId>/ directories whose id is NOT in the live chat set", async () => {
    const root = path.join(tmpDir, "data", "chat-files");
    await fs.mkdir(path.join(root, "live-1"), { recursive: true });
    await fs.writeFile(path.join(root, "live-1", "doc.txt"), "x");
    await fs.mkdir(path.join(root, "orphan-1"), { recursive: true });
    await fs.writeFile(path.join(root, "orphan-1", "img.png"), "y");
    await fs.mkdir(path.join(root, "orphan-2"), { recursive: true });

    const out = await sweepers.sweepOrphanChatFiles(new Set(["live-1"]));

    expect(out.scanned).toBe(3);
    expect(out.removed).toBe(2);
    expect(out.removedSample).toEqual(
      expect.arrayContaining(["orphan-1", "orphan-2"])
    );

    // Live directory survives.
    await expect(
      fs.access(path.join(root, "live-1", "doc.txt"))
    ).resolves.toBeUndefined();
    // Orphan dirs gone (recursive rm including their contents).
    await expect(
      fs.access(path.join(root, "orphan-1"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.access(path.join(root, "orphan-2"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("skips non-directory entries inside chat-files (defense — there shouldn't be any)", async () => {
    const root = path.join(tmpDir, "data", "chat-files");
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "stray-file.txt"), "z");

    const out = await sweepers.sweepOrphanChatFiles(new Set());

    expect(out.scanned).toBe(0);
    expect(out.removed).toBe(0);
    // Stray file still there.
    await expect(
      fs.access(path.join(root, "stray-file.txt"))
    ).resolves.toBeUndefined();
  });

  it("removes nothing when every dir matches the live chat set", async () => {
    const root = path.join(tmpDir, "data", "chat-files");
    await fs.mkdir(path.join(root, "c1"), { recursive: true });
    await fs.mkdir(path.join(root, "c2"), { recursive: true });

    const out = await sweepers.sweepOrphanChatFiles(new Set(["c1", "c2"]));

    expect(out.scanned).toBe(2);
    expect(out.removed).toBe(0);
  });

  it("caps removedSample at 20 (logging brevity)", async () => {
    const root = path.join(tmpDir, "data", "chat-files");
    for (let i = 0; i < 25; i++) {
      await fs.mkdir(path.join(root, `orphan-${i}`), { recursive: true });
    }

    const out = await sweepers.sweepOrphanChatFiles(new Set());

    expect(out.removed).toBe(25);
    expect(out.removedSample.length).toBe(20);
  });
});
