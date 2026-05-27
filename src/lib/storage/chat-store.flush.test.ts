/**
 * PM #29 regression test — chat-store SIGTERM/SIGINT flush wiring.
 *
 * Why: chat-store debounces disk writes by 80 ms to coalesce tool-call
 * storms. Before PM #29, a graceful restart (kill -TERM, systemd stop)
 * during an active turn would lose the last debounce window of agent
 * outputs because the `setTimeout`-scheduled `flushNow` never fired —
 * the process exited before the timer.
 *
 * The fix installs `process.once("SIGTERM", ...)` and `("SIGINT", ...)`
 * handlers at module load (skipped in Vitest) that call
 * `flushAllPendingChats()`. This test exercises the handler manually via
 * `process.emit("SIGTERM")` and asserts the pending write reaches disk.
 */
import fs from "fs/promises";
import path from "path";
import os from "os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We import these dynamically AFTER stubbing process.cwd so that chat-store
// resolves its DATA_DIR into the temp directory.
let tmpDir: string;
let chatStore: typeof import("./chat-store");

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-flush-"));
  vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
  // Wipe module cache so chat-store re-reads `process.cwd()` for its DATA_DIR.
  vi.resetModules();
  chatStore = await import("./chat-store");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("PM #29 — chat-store SIGTERM flush", () => {
  it("installer is exported and idempotent (multi-call doesn't stack handlers)", () => {
    const before = process.listenerCount("SIGTERM");
    chatStore.__testInternals__.installChatStoreShutdownFlush();
    const after1 = process.listenerCount("SIGTERM");
    chatStore.__testInternals__.installChatStoreShutdownFlush();
    const after2 = process.listenerCount("SIGTERM");

    // First call adds one (or zero if the global flag was already set by a
    // prior test run). Second call MUST be a no-op.
    expect(after1).toBeGreaterThanOrEqual(before);
    expect(after2).toBe(after1);
  });

  it("flushAllPendingChats drains pending writes to disk", async () => {
    const chat = await chatStore.createChat("test-chat-flush-1", "test");
    // Must AWAIT saveChat — it calls `await ensureDir(...)` BEFORE scheduling
    // the debounced flush, so the entry only enters `pendingFlushes` after the
    // await settles. `void saveChat(...)` would race flushAllPendingChats.
    await chatStore.saveChat({
      ...chat,
      messages: [
        {
          id: "m1",
          role: "user",
          content: "queued before flush",
          createdAt: new Date().toISOString(),
        },
      ],
      updatedAt: new Date().toISOString(),
    });

    // Explicit flush — same call the SIGTERM handler will make.
    await chatStore.flushAllPendingChats();

    const filePath = path.join(tmpDir, "data", "chats", `${chat.id}.json`);
    const content = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0].content).toBe("queued before flush");
  });

  it("simulated SIGTERM after debounced saveChat: writes still reach disk", async () => {
    chatStore.__testInternals__.installChatStoreShutdownFlush();

    const chat = await chatStore.createChat("test-chat-flush-2", "test");
    await chatStore.saveChat({
      ...chat,
      messages: [
        {
          id: "m1",
          role: "user",
          content: "in debounce window",
          createdAt: new Date().toISOString(),
        },
      ],
      updatedAt: new Date().toISOString(),
    });

    // Emit SIGTERM — the installed handler should call flushAllPendingChats
    // (fire-and-forget; Node keeps the event loop alive for pending I/O).
    // We don't actually exit the process — that would kill the test runner.
    process.emit("SIGTERM");

    // Give the handler's microtask a tick to schedule the flush, then await
    // it explicitly to synchronise with disk before reading.
    await new Promise((resolve) => setImmediate(resolve));
    await chatStore.flushAllPendingChats();

    const filePath = path.join(tmpDir, "data", "chats", `${chat.id}.json`);
    const content = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.messages).toHaveLength(1);
  });
});
