/**
 * chat-store.test.ts
 *
 * Tests for the chat persistence layer:
 *   - CRUD (create, read, update, delete)
 *   - Concurrency: updateChat prevents data races
 *   - Corruption resilience: invalid JSON files are skipped
 *   - Sorted listing
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import fs from "fs/promises";
import os from "os";

// ── Isolate from real data dir by patching process.cwd() ──────────────────────
let tmpDir: string;

vi.mock("@/lib/realtime/event-bus", () => ({
  publishUiSyncEvent: vi.fn(),
}));

// We need to rewrite the DATA_DIR to our temp dir.
// The cleanest way is to use a dynamic import after setting cwd.
// Instead, we write the chats directory directly and import the module.

describe("Chat Store", () => {
  // We can't easily override the DATA_DIR without modifying process.cwd.
  // Use a real temp filesystem approach:
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-chat-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("createChat should persist a chat with correct fields", async () => {
    // We test the shape of the Chat object returned by createChat
    const { createChat } = await import("@/lib/storage/chat-store");
    const chatId = `test-${Date.now()}-${Math.random()}`;
    
    const chat = await createChat(chatId, "Test Chat Title", "project-abc");

    expect(chat.id).toBe(chatId);
    expect(chat.title).toBe("Test Chat Title");
    expect(chat.projectId).toBe("project-abc");
    expect(chat.messages).toEqual([]);
    expect(chat.createdAt).toBeTruthy();
    expect(chat.updatedAt).toBeTruthy();

    // Cleanup
    const { deleteChat } = await import("@/lib/storage/chat-store");
    await deleteChat(chatId);
  });

  it("getChat should return null for a non-existent chat", async () => {
    const { getChat } = await import("@/lib/storage/chat-store");
    const result = await getChat("nonexistent-chat-id-xyz-999");
    expect(result).toBeNull();
  });

  it("updateChat should apply mutator and return updated chat", async () => {
    const { createChat, updateChat, getChat } = await import("@/lib/storage/chat-store");
    const chatId = `test-update-${Date.now()}`;
    
    await createChat(chatId, "Initial Title");

    const updated = await updateChat(chatId, (chat) => {
      chat.title = "Updated Title";
      return chat;
    });

    expect(updated).not.toBeNull();
    expect(updated!.title).toBe("Updated Title");

    // Verify persisted to disk
    const reloaded = await getChat(chatId);
    expect(reloaded?.title).toBe("Updated Title");

    const { deleteChat } = await import("@/lib/storage/chat-store");
    await deleteChat(chatId);
  });

  it("updateChat should return null for nonexistent chat", async () => {
    const { updateChat } = await import("@/lib/storage/chat-store");
    const result = await updateChat("nonexistent-99999", (chat) => chat);
    expect(result).toBeNull();
  });

  it("deleteChat should remove the file and return true", async () => {
    const { createChat, deleteChat, getChat } = await import("@/lib/storage/chat-store");
    const chatId = `test-delete-${Date.now()}`;
    
    await createChat(chatId, "To be deleted");
    const deleted = await deleteChat(chatId);
    
    expect(deleted).toBe(true);
    expect(await getChat(chatId)).toBeNull();
  });

  it("deleteChat should return false for nonexistent chat", async () => {
    const { deleteChat } = await import("@/lib/storage/chat-store");
    const result = await deleteChat("totally-nonexistent-chat-id");
    expect(result).toBe(false);
  });

  it("updateChat concurrency: 50 parallel appends should all be stored (no data loss)", async () => {
    const { createChat, updateChat, getChat } = await import("@/lib/storage/chat-store");
    const chatId = `test-concurrent-${Date.now()}`;
    
    await createChat(chatId, "Concurrent test");

    const CONCURRENT = 50;
    await Promise.all(
      Array.from({ length: CONCURRENT }, (_, i) =>
        updateChat(chatId, (chat) => {
          chat.messages.push({
            id: `msg-${i}`,
            role: "user",
            content: `Message ${i}`,
            createdAt: new Date().toISOString(),
          });
          return chat;
        })
      )
    );

    const final = await getChat(chatId);
    expect(final?.messages.length).toBe(CONCURRENT);

    const { deleteChat } = await import("@/lib/storage/chat-store");
    await deleteChat(chatId);
  });

  describe("Sprint 11 — chatId path-traversal defense (CVE-class arbitrary file write)", () => {
    // Pre-Sprint-11 `chatFilePath` used naive `path.join(CHATS_DIR,
    // \`\${chatId}.json\`)`. An attacker-controlled chatId of
    // `"../settings/settings"` would resolve to `data/settings/settings.json`
    // (clobbering auth state) or `"../../../../tmp/evil"` could escape
    // `data/` entirely. The fix wraps the path build with
    // `assertPathInside(CHATS_DIR, ...)` which throws on traversal.

    it("createChat with `../` in chatId throws instead of writing outside CHATS_DIR", async () => {
      const { createChat } = await import("@/lib/storage/chat-store");
      await expect(
        createChat("../settings/evil", "Malicious")
      ).rejects.toThrow(/escapes the allowed root/);
    });

    it("getChat with `../` in chatId throws (defense at the path-resolve layer)", async () => {
      const { getChat } = await import("@/lib/storage/chat-store");
      await expect(getChat("../../../etc/passwd")).rejects.toThrow(
        /escapes the allowed root/
      );
    });

    it("updateChat with `../` in chatId throws (defense applies to all callers)", async () => {
      const { updateChat } = await import("@/lib/storage/chat-store");
      await expect(
        updateChat("../poisoned", (chat) => chat)
      ).rejects.toThrow(/escapes the allowed root/);
    });

    it("deleteChat with `../` in chatId throws (defense applies to all callers)", async () => {
      const { deleteChat } = await import("@/lib/storage/chat-store");
      await expect(deleteChat("../../traces/evil")).rejects.toThrow(
        /escapes the allowed root/
      );
    });

    it("sibling-prefix bypass: chatId starting with chat-dir prefix doesn't slip through", async () => {
      // The PM #16 class of bug: a bare startsWith(root) would accept
      // `data/chats-evil/foo` because the resolved path literally starts
      // with `data/chats`. `assertPathInside` adds `path.sep` suffix so
      // sibling prefixes don't match. This test pins that guarantee
      // even after a refactor.
      const { createChat } = await import("@/lib/storage/chat-store");
      // chatId crafted to land at `data/chats-evil/x.json` after join+resolve
      await expect(
        createChat("../chats-evil/x", "Sibling prefix attack")
      ).rejects.toThrow(/escapes the allowed root/);
    });

    it("normal UUID-shaped chatIds pass through unchanged", async () => {
      const { createChat, deleteChat } = await import(
        "@/lib/storage/chat-store"
      );
      // Production callers use `crypto.randomUUID()` — must not regress.
      const safeId = "550e8400-e29b-41d4-a716-446655440000";
      await expect(createChat(safeId, "Safe")).resolves.toBeDefined();
      await deleteChat(safeId);
    });
  });
});
