/**
 * PM #63 — chat soft-delete. Deleting a chat must move its file to
 * `data/.trash/chats/` (recoverable) rather than hard-unlinking it, and a
 * restore must bring it back. Isolates via a mocked cwd + module reset, the
 * same pattern as chat-store.flush.test.ts.
 */
import fs from "fs/promises";
import path from "path";
import os from "os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir: string;
let chatStore: typeof import("./chat-store");

const chatsDir = () => path.join(tmpDir, "data", "chats");
const trashDir = () => path.join(tmpDir, "data", ".trash", "chats");

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-softdel-"));
  vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
  vi.resetModules();
  chatStore = await import("./chat-store");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("chat soft-delete (PM #63)", () => {
  it("deleteChat moves the file to trash instead of hard-deleting", async () => {
    await chatStore.createChat("c1", "Hello");
    await chatStore.flushAllPendingChats();
    await expect(fs.access(path.join(chatsDir(), "c1.json"))).resolves.toBeUndefined();

    const ok = await chatStore.deleteChat("c1");
    expect(ok).toBe(true);

    // Gone from the live chats dir…
    await expect(
      fs.access(path.join(chatsDir(), "c1.json"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    // …but recoverable from the trash.
    const trashed = await chatStore.listTrashedChats();
    expect(trashed.map((t) => t.id)).toContain("c1");
    const files = await fs.readdir(trashDir());
    expect(files.some((f) => f.startsWith("c1."))).toBe(true);
  });

  it("restoreChatFromTrash brings a deleted chat back and clears it from trash", async () => {
    await chatStore.createChat("c2", "World");
    await chatStore.flushAllPendingChats();
    await chatStore.deleteChat("c2");

    const restored = await chatStore.restoreChatFromTrash("c2");
    expect(restored).toBe(true);

    const chat = await chatStore.getChat("c2");
    expect(chat?.id).toBe("c2");
    await expect(
      fs.access(path.join(chatsDir(), "c2.json"))
    ).resolves.toBeUndefined();
    // The trashed copy was consumed by the restore.
    expect((await chatStore.listTrashedChats()).map((t) => t.id)).not.toContain("c2");
  });

  it("restoreChatFromTrash returns false for an id that was never trashed", async () => {
    expect(await chatStore.restoreChatFromTrash("never-existed")).toBe(false);
  });

  it("deleteChatsByProjectId soft-deletes too (recoverable)", async () => {
    await chatStore.createChat("p1", "A", "proj-x");
    await chatStore.createChat("p2", "B", "proj-x");
    await chatStore.flushAllPendingChats();

    const n = await chatStore.deleteChatsByProjectId("proj-x");
    expect(n).toBe(2);
    const trashedIds = (await chatStore.listTrashedChats()).map((t) => t.id).sort();
    expect(trashedIds).toEqual(["p1", "p2"]);
  });
});

describe("getOrphanIndexEntries (PM #62 — index/file drift detector)", () => {
  it("flags index entries whose chat file is missing (the data-loss signature)", async () => {
    await chatStore.createChat("k1", "A");
    await chatStore.createChat("k2", "B");
    await chatStore.flushAllPendingChats();
    // Drift: remove k2's file WITHOUT updating the index (what hard-deletion /
    // an out-of-band `rm` does — exactly the PM #62 41-index-vs-7-files state).
    await fs.rm(path.join(chatsDir(), "k2.json"));

    const orphans = await chatStore.getOrphanIndexEntries();
    expect(orphans).toContain("k2");
    expect(orphans).not.toContain("k1");
  });

  it("returns [] when the index is absent or every entry has a file", async () => {
    expect(await chatStore.getOrphanIndexEntries()).toEqual([]);
    await chatStore.createChat("k3", "C");
    await chatStore.flushAllPendingChats();
    expect(await chatStore.getOrphanIndexEntries()).toEqual([]);
  });
});
