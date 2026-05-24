/**
 * fs-utils.test.ts
 *
 * Tests for the core storage primitives:
 *   1. withFileLock — in-memory mutex for sequential RMW cycles
 *   2. safeWriteFile — atomic write via tmp file + rename
 *
 * These are the most security-critical utilities in Orchestra; a bug here
 * means data loss under any concurrent load.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import path from "path";
import fs from "fs/promises";
import os from "os";
import {
  withFileLock,
  safeWriteFile,
  assertPathInside,
  assertPathInsideRealpath,
} from "@/lib/storage/fs-utils";

// ── Helpers ──────────────────────────────────────────────────────────────────

async function makeTmpFile(content = ""): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-test-"));
  const file = path.join(dir, "test.json");
  if (content) await fs.writeFile(file, content, "utf-8");
  return file;
}

async function cleanupFile(filePath: string) {
  await fs.rm(path.dirname(filePath), { recursive: true, force: true });
}

// ── withFileLock ──────────────────────────────────────────────────────────────

describe("withFileLock", () => {
  it("should execute the provided function and return its value", async () => {
    const result = await withFileLock("/tmp/test-lock-1.json", async () => 42);
    expect(result).toBe(42);
  });

  it("should serialize concurrent calls on the same path (no data loss)", async () => {
    const filePath = await makeTmpFile(JSON.stringify({ count: 0 }));

    const INCREMENT_COUNT = 50;
    const ops = Array.from({ length: INCREMENT_COUNT }, (_, i) =>
      withFileLock(filePath, async () => {
        const raw = await fs.readFile(filePath, "utf-8");
        const data = JSON.parse(raw) as { count: number };
        data.count += 1;
        await fs.writeFile(filePath, JSON.stringify(data));
        return i;
      })
    );

    await Promise.all(ops);

    const final = JSON.parse(await fs.readFile(filePath, "utf-8")) as { count: number };
    expect(final.count).toBe(INCREMENT_COUNT);

    await cleanupFile(filePath);
  });

  it("should allow concurrent calls on DIFFERENT paths (no blocking)", async () => {
    const results: number[] = [];
    const order: string[] = [];

    await Promise.all([
      withFileLock("/tmp/lock-path-A.json", async () => {
        order.push("A");
        results.push(1);
      }),
      withFileLock("/tmp/lock-path-B.json", async () => {
        order.push("B");
        results.push(2);
      }),
    ]);

    // Both should have executed
    expect(results).toContain(1);
    expect(results).toContain(2);
  });

  it("should propagate errors thrown inside the locked function", async () => {
    await expect(
      withFileLock("/tmp/lock-error-test.json", async () => {
        throw new Error("intentional lock error");
      })
    ).rejects.toThrow("intentional lock error");
  });

  it("should clean up the lock entry after completion (no memory leak)", async () => {
    // Run 100 unique paths sequentially to ensure the Map doesn't accumulate entries.
    // We can't inspect the private Map, but we can confirm there are no hanging promises
    // by checking that all locks resolve even after many unique paths.
    const paths = Array.from({ length: 100 }, (_, i) => `/tmp/lock-gc-test-${i}.json`);
    const results = await Promise.all(paths.map((p) => withFileLock(p, async () => p)));
    expect(results).toHaveLength(100);
    expect(results[0]).toBe("/tmp/lock-gc-test-0.json");
  });

  it("should continue processing queued operations after one throws", async () => {
    const results: string[] = [];
    const filePath = "/tmp/lock-recovery-test.json";

    await Promise.allSettled([
      withFileLock(filePath, async () => {
        results.push("first");
      }),
      withFileLock(filePath, async () => {
        throw new Error("second throws");
      }),
      withFileLock(filePath, async () => {
        results.push("third");
      }),
    ]);

    // 'first' and 'third' should both have run despite the middle one failing
    expect(results).toContain("first");
    expect(results).toContain("third");
  });
});

// ── safeWriteFile ─────────────────────────────────────────────────────────────

describe("safeWriteFile", () => {
  it("should write data to a file that can then be read back", async () => {
    const filePath = await makeTmpFile();
    const data = JSON.stringify({ hello: "world", num: 42 });

    await safeWriteFile(filePath, data);

    const result = await fs.readFile(filePath, "utf-8");
    expect(result).toBe(data);

    await cleanupFile(filePath);
  });

  it("should create parent directories if they don't exist", async () => {
    const dir = path.join(os.tmpdir(), `orchestra-deep-${Date.now()}`, "nested", "dirs");
    const filePath = path.join(dir, "data.json");

    await safeWriteFile(filePath, "{}");

    const exists = await fs.readFile(filePath, "utf-8");
    expect(exists).toBe("{}");

    await fs.rm(path.join(os.tmpdir(), `orchestra-deep-${Date.now() - 5000}`), {
      recursive: true,
      force: true,
    });
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("should not leave behind temp files if write succeeds", async () => {
    const filePath = await makeTmpFile();
    const dir = path.dirname(filePath);

    await safeWriteFile(filePath, '{"clean": true}');

    const files = await fs.readdir(dir);
    // Only the target file should exist, no .tmp files
    const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);

    await cleanupFile(filePath);
  });

  it("should overwrite existing file content", async () => {
    const filePath = await makeTmpFile('{"old": true}');

    await safeWriteFile(filePath, '{"new": true}');

    const result = await fs.readFile(filePath, "utf-8");
    expect(JSON.parse(result)).toEqual({ new: true });

    await cleanupFile(filePath);
  });
});

// ── assertPathInside ─────────────────────────────────────────────────────────

describe("assertPathInside (PM #6 path-traversal guard)", () => {
  const ROOT = "/tmp/orchestra-knowledge-test-root";

  it("accepts a simple subdirectory name", () => {
    const resolved = assertPathInside(ROOT, "docs");
    expect(resolved).toBe(path.resolve(ROOT, "docs"));
  });

  it("accepts a nested path", () => {
    const resolved = assertPathInside(ROOT, "docs/api/v1");
    expect(resolved).toBe(path.resolve(ROOT, "docs/api/v1"));
  });

  it("accepts the root itself (empty fragment)", () => {
    const resolved = assertPathInside(ROOT, ".");
    expect(resolved).toBe(path.resolve(ROOT));
  });

  it("rejects parent traversal via ..", () => {
    expect(() => assertPathInside(ROOT, "../../etc")).toThrow();
  });

  it("rejects deeply nested ..", () => {
    expect(() => assertPathInside(ROOT, "docs/../../etc")).toThrow();
  });

  it("rejects an absolute path that escapes the root", () => {
    expect(() => assertPathInside(ROOT, "/etc/passwd")).toThrow();
  });

  it("rejects a sibling directory matched by prefix (not just startsWith)", () => {
    // /tmp/orchestra-knowledge-test-root vs /tmp/orchestra-knowledge-test-root-evil
    // A naive startsWith without path.sep would let "../orchestra-knowledge-test-root-evil/x" through.
    expect(() =>
      assertPathInside(ROOT, "../orchestra-knowledge-test-root-evil/x")
    ).toThrow();
  });

  it("normalizes redundant segments without escaping", () => {
    const resolved = assertPathInside(ROOT, "./docs/./a/../a/file.txt");
    expect(resolved).toBe(path.resolve(ROOT, "docs/a/file.txt"));
  });
});

// ── assertPathInsideRealpath (Open Folder symlink guard) ─────────────────────

describe("assertPathInsideRealpath (linked-project symlink guard)", () => {
  let workRoot: string;
  let outsideTarget: string;

  beforeEach(async () => {
    workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-linked-"));
    outsideTarget = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-outside-"));
    await fs.writeFile(path.join(outsideTarget, "secret.txt"), "private", "utf-8");
  });

  afterEach(async () => {
    await fs.rm(workRoot, { recursive: true, force: true });
    await fs.rm(outsideTarget, { recursive: true, force: true });
  });

  it("accepts a real file inside the root", async () => {
    const file = path.join(workRoot, "src", "index.ts");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "// hi", "utf-8");

    const resolved = await assertPathInsideRealpath(workRoot, "src/index.ts");
    // realpath resolves /private/var/folders prefix on macOS; check via fs.realpath equality
    expect(resolved).toBe(await fs.realpath(file));
  });

  it("accepts a not-yet-existing file whose parent is inside the root", async () => {
    // Agent is about to create a new file — must not throw.
    const resolved = await assertPathInsideRealpath(workRoot, "new-file.txt");
    const expected = path.join(await fs.realpath(workRoot), "new-file.txt");
    expect(resolved).toBe(expected);
  });

  it("REJECTS a symlink inside the root that points OUTSIDE", async () => {
    // The whole reason this function exists. `assertPathInside` (string-only)
    // would let this through; realpath traversal must catch it.
    const linkPath = path.join(workRoot, "escape-link");
    await fs.symlink(outsideTarget, linkPath, "dir");

    await expect(
      assertPathInsideRealpath(workRoot, "escape-link/secret.txt")
    ).rejects.toThrow(/escapes/);
  });

  it("rejects parent-traversal even with realpath", async () => {
    await expect(
      assertPathInsideRealpath(workRoot, "../../etc/passwd")
    ).rejects.toThrow(/escapes/);
  });

  it("accepts a symlink inside the root that points INSIDE the same root", async () => {
    // Intra-root symlinks are legitimate (e.g. monorepo aliases).
    const inner = path.join(workRoot, "inner");
    await fs.mkdir(inner);
    await fs.writeFile(path.join(inner, "file.txt"), "ok", "utf-8");
    const linkPath = path.join(workRoot, "alias-link");
    await fs.symlink(inner, linkPath, "dir");

    const resolved = await assertPathInsideRealpath(workRoot, "alias-link/file.txt");
    expect(resolved).toBe(path.join(await fs.realpath(workRoot), "inner", "file.txt"));
  });
});
