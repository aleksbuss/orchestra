import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  snapshotBeforeWrite,
  listProjectSnapshots,
} from "./snapshots";

// The module reads `process.cwd()` lazily on each call. Tests stub it to
// point at a temp directory so we exercise the real fs codepath without
// polluting the repo's `data/`. Worker threads don't allow `process.chdir`.
let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "snapshots-test-"));
  vi.spyOn(process, "cwd").mockReturnValue(tempDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("snapshots", () => {
  it("returns null when target file does not exist (fresh write)", async () => {
    const result = await snapshotBeforeWrite({
      projectId: "p1",
      filePath: path.join(tempDir, "does-not-exist.txt"),
      reason: "test",
    });
    expect(result).toBeNull();
  });

  it("captures the previous content of an existing file", async () => {
    const target = path.join(tempDir, "existing.txt");
    await fs.writeFile(target, "original content", "utf-8");

    const result = await snapshotBeforeWrite({
      projectId: "p1",
      chatId: "chat-A",
      filePath: target,
      reason: "write_text_file overwrite",
    });

    expect(result).not.toBeNull();
    expect(result!.projectId).toBe("p1");
    expect(result!.chatId).toBe("chat-A");
    expect(result!.originalPath).toBe(target);
    expect(result!.bytes).toBe("original content".length);

    // Verify the snapshot file actually contains the previous content
    const snapshotContent = await fs.readFile(
      path.join(tempDir, "data", "snapshots", "p1", `${result!.id}.content`),
      "utf-8"
    );
    expect(snapshotContent).toBe("original content");
  });

  it("listProjectSnapshots returns most recent first", async () => {
    const target = path.join(tempDir, "f.txt");
    await fs.writeFile(target, "v1", "utf-8");
    const first = await snapshotBeforeWrite({
      projectId: "p1",
      filePath: target,
      reason: "first",
    });

    // Tick the clock so the second snapshot has a later timestamp. Real
    // agent runs always have ≥1ms between writes, but tests run fast.
    await new Promise((r) => setTimeout(r, 5));
    await fs.writeFile(target, "v2", "utf-8");
    const second = await snapshotBeforeWrite({
      projectId: "p1",
      filePath: target,
      reason: "second",
    });

    const list = await listProjectSnapshots("p1");
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe(second!.id);
    expect(list[1].id).toBe(first!.id);
  });

  it("filters by chatId when requested", async () => {
    const target = path.join(tempDir, "f.txt");
    await fs.writeFile(target, "x", "utf-8");
    await snapshotBeforeWrite({
      projectId: "p1",
      chatId: "chat-A",
      filePath: target,
      reason: "A",
    });
    await fs.writeFile(target, "x", "utf-8");
    await snapshotBeforeWrite({
      projectId: "p1",
      chatId: "chat-B",
      filePath: target,
      reason: "B",
    });

    const onlyA = await listProjectSnapshots("p1", { chatId: "chat-A" });
    expect(onlyA).toHaveLength(1);
    expect(onlyA[0].chatId).toBe("chat-A");
  });

  it("returns null and does not throw when target is a directory", async () => {
    const dir = path.join(tempDir, "some-dir");
    await fs.mkdir(dir);
    const result = await snapshotBeforeWrite({
      projectId: "p1",
      filePath: dir,
      reason: "test",
    });
    expect(result).toBeNull();
  });

  it("returns [] for a project with no snapshots", async () => {
    expect(await listProjectSnapshots("never-existed")).toEqual([]);
  });

  it("respects the limit option", async () => {
    const target = path.join(tempDir, "f.txt");
    for (let i = 0; i < 5; i++) {
      await fs.writeFile(target, `v${i}`, "utf-8");
      await snapshotBeforeWrite({ projectId: "p1", filePath: target, reason: "x" });
      await new Promise((r) => setTimeout(r, 2));
    }
    const limited = await listProjectSnapshots("p1", { limit: 2 });
    expect(limited).toHaveLength(2);
  });
});
