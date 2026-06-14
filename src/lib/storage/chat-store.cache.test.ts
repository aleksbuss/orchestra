/**
 * PM #64 — the chat parse-cache must stay BOUNDED (a long-lived daemon used to
 * accumulate every chat it ever touched → slow OOM) AND must never drop an
 * un-flushed mutation under cache pressure. Isolated via mocked cwd + module
 * reset (same pattern as chat-store.flush.test.ts).
 */
import fs from "fs/promises";
import path from "path";
import os from "os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// These PM #64 tests create + read MAX_CACHED_CHATS (200) + a margin of chats
// against the REAL filesystem to prove the cache bound under realistic pressure
// — ~500 disk ops each. That's legitimately I/O-heavy, so give them room above
// the 15s global timeout: at the edge they intermittently flaked under parallel
// CI load (confirmed via a low-timeout reproduction; QA audit F-01a sibling).
vi.setConfig({ testTimeout: 30000 });

let tmpDir: string;
let chatStore: typeof import("./chat-store");

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-cache-"));
  vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
  vi.resetModules();
  chatStore = await import("./chat-store");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("chat parse-cache is bounded (PM #64)", () => {
  it("never exceeds MAX_CACHED_CHATS no matter how many chats are touched", async () => {
    const max = chatStore.__testInternals__.MAX_CACHED_CHATS;
    const n = max + 50;
    for (let i = 0; i < n; i++) {
      await chatStore.createChat(`c${i}`, `chat ${i}`);
    }
    await chatStore.flushAllPendingChats();
    // Read them all back (each read populates the cache).
    for (let i = 0; i < n; i++) {
      await chatStore.getChat(`c${i}`);
    }
    expect(chatStore.__testInternals__.getChatCacheSize()).toBeLessThanOrEqual(max);
  });

  it("does NOT evict a chat with a pending (un-flushed) write under pressure", async () => {
    const max = chatStore.__testInternals__.MAX_CACHED_CHATS;
    // Dirty chat: create + mutate, leaving a pending debounced flush.
    await chatStore.createChat("dirty", "v0");
    await chatStore.flushAllPendingChats();
    await chatStore.updateChat("dirty", (c) => {
      c.title = "v1-unflushed";
      return c;
    });
    expect(chatStore.__testInternals__.hasPendingFlush("dirty")).toBe(true);

    // Pile on cache pressure with many OTHER chats.
    for (let i = 0; i < max + 20; i++) {
      await chatStore.createChat(`pressure-${i}`, "x");
      await chatStore.getChat(`pressure-${i}`);
    }

    // The dirty chat's pending write must still land — not be dropped.
    await chatStore.flushAllPendingChats();
    const persisted = await chatStore.getChat("dirty");
    expect(persisted?.title).toBe("v1-unflushed");
    const onDisk = JSON.parse(
      await fs.readFile(path.join(tmpDir, "data", "chats", "dirty.json"), "utf-8")
    );
    expect(onDisk.title).toBe("v1-unflushed");
  });
});
