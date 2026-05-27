/**
 * Cross-concern integration smoke for chat-store: exercises the SIGTERM-flush
 * path (PM #29) and broken-file detection (PM #30) IN CONJUNCTION with the
 * normal index rebuild flow. Each of those concerns has its own focused unit
 * test; this file proves they compose without stepping on each other.
 *
 * What this catches that the per-PM unit tests don't:
 *   - Module-level state (broken-files registry, pendingFlushes Map) leaks
 *     across operations in surprising ways.
 *   - A SIGTERM handler installed while broken files exist doesn't crash on
 *     a flushAllPendingChats() that touches files NOT in the broken set.
 *   - rebuildChatIndex() doesn't undo the SIGTERM handler's flushed writes.
 *
 * This is intentionally NOT a full /api/chat → runAgent → SSE end-to-end test.
 * That would require either a running dev server (already covered by
 * src/lib/agent/integration.test.ts, which skips when unreachable) or a
 * production-only `/api/_test/chat` route, which would be production code
 * that exists only for tests — an architectural smell. The existing
 * `src/app/api/chat/route.test.ts` (428 LOC) already mocks runAgent and
 * covers every body-parse / dispatch / forceSwarm path.
 */
import fs from "fs/promises";
import path from "path";
import os from "os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir: string;
let chatStore: typeof import("./chat-store");

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-cs-int-"));
  vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.resetModules();
  chatStore = await import("./chat-store");
  chatStore.__resetBrokenChatFilesForTest();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("chat-store integration — broken-file + SIGTERM-flush coexistence", () => {
  it("SIGTERM-flush writes a valid chat to disk EVEN WHEN a separate broken file exists", async () => {
    // Seed: one corrupt chat file already on disk + the broken-files registry
    // pre-populated by a prior rebuild.
    const chatsDir = path.join(tmpDir, "data", "chats");
    await fs.mkdir(chatsDir, { recursive: true });
    await fs.writeFile(path.join(chatsDir, "c-broken.json"), "{{not json}}");
    await chatStore.rebuildChatIndex();
    expect(chatStore.getBrokenChatFiles()).toHaveLength(1);

    // Now create a valid chat with a debounced write.
    const chat = await chatStore.createChat("c-valid", "valid");
    await chatStore.saveChat({
      ...chat,
      messages: [
        {
          id: "m1",
          role: "user",
          content: "must survive SIGTERM",
          createdAt: new Date().toISOString(),
        },
      ],
    });

    // Simulate SIGTERM-flush. Must not throw even though broken-files registry
    // is non-empty (the flush touches different files entirely).
    await chatStore.flushAllPendingChats();

    const valid = await fs.readFile(
      path.join(chatsDir, "c-valid.json"),
      "utf-8"
    );
    const parsed = JSON.parse(valid);
    expect(parsed.messages[0].content).toBe("must survive SIGTERM");

    // Broken-file registry untouched — flush has no business changing it.
    expect(chatStore.getBrokenChatFiles()).toHaveLength(1);
    expect(chatStore.getBrokenChatFiles()[0].file).toBe("c-broken.json");
  });

  it("rebuildChatIndex after a successful SIGTERM-flush picks up the just-flushed chat", async () => {
    const chat = await chatStore.createChat("flush-then-index", "x");
    await chatStore.saveChat({
      ...chat,
      messages: [
        {
          id: "m1",
          role: "user",
          content: "indexed after flush",
          createdAt: new Date().toISOString(),
        },
      ],
    });
    await chatStore.flushAllPendingChats();

    const items = await chatStore.rebuildChatIndex();
    const found = items.find((i) => i.id === "flush-then-index");
    expect(found).toBeDefined();
    expect(found?.messageCount).toBe(1);
  });

  it("two concurrent saveChats to different chats don't clobber each other under flush", async () => {
    const chatA = await chatStore.createChat("c-a", "a");
    const chatB = await chatStore.createChat("c-b", "b");

    // Fire both saves without awaiting; they share the debounce timer pool.
    const pA = chatStore.saveChat({
      ...chatA,
      messages: [
        {
          id: "ma",
          role: "user",
          content: "from A",
          createdAt: new Date().toISOString(),
        },
      ],
    });
    const pB = chatStore.saveChat({
      ...chatB,
      messages: [
        {
          id: "mb",
          role: "user",
          content: "from B",
          createdAt: new Date().toISOString(),
        },
      ],
    });
    await Promise.all([pA, pB]);

    await chatStore.flushAllPendingChats();

    const a = JSON.parse(
      await fs.readFile(
        path.join(tmpDir, "data", "chats", "c-a.json"),
        "utf-8"
      )
    );
    const b = JSON.parse(
      await fs.readFile(
        path.join(tmpDir, "data", "chats", "c-b.json"),
        "utf-8"
      )
    );

    expect(a.messages[0].content).toBe("from A");
    expect(b.messages[0].content).toBe("from B");
  });
});
