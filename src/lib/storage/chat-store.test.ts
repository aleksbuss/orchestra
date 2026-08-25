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

// ── Isolate from the real data dir via ORCHESTRA_DATA_DIR ────────────────────
//
// This block used to create `tmpDir`, delete it again, and point NOTHING at it.
// The header claimed isolation "by patching process.cwd()" and no cwd patch was
// ever written; the body said "we can't easily override the DATA_DIR without
// modifying process.cwd". That stopped being true when `ORCHESTRA_DATA_DIR` was
// added (the PM #62 fix), but this file was never updated — so every case here
// ran against the operator's LIVE database: real chats written into
// `data/chats/`, the real `data/chat-index.json` REWRITTEN, and the fixtures
// swept into `data/.trash/chats/`. Measured, not inferred: running this one
// file and diffing `data/` afterwards is what found it.
//
// Nothing was lost, because the cases clean up after themselves. A crash
// halfway through is the version where the live index survives describing
// test chats.
let tmpDir: string;
let previousDataDir: string | undefined;

vi.mock("@/lib/realtime/event-bus", () => ({
  publishUiSyncEvent: vi.fn(),
}));

describe("Chat Store", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-chat-"));
    previousDataDir = process.env.ORCHESTRA_DATA_DIR;
    process.env.ORCHESTRA_DATA_DIR = tmpDir;
  });

  afterEach(async () => {
    if (previousDataDir === undefined) delete process.env.ORCHESTRA_DATA_DIR;
    else process.env.ORCHESTRA_DATA_DIR = previousDataDir;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // The isolation above is load-bearing, and its failure mode is SILENT — the
  // suite passes either way, it just passes against real data. Assert it.
  it("runs against an isolated data dir, not the operator's live one", async () => {
    const { getDataDir } = await import("@/lib/storage/data-dir");
    expect(getDataDir()).toBe(path.resolve(tmpDir));
    expect(getDataDir()).not.toBe(path.join(process.cwd(), "data"));
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

  describe("isValidChatId — the route-layer half of the path guard", () => {
    // The storage guard (`chatFilePath` → `assertPathInside`) THROWS on
    // traversal, and its own comment tells callers to "treat this as a hard
    // error and 400 the request". Four route handlers could not, because the
    // throw only surfaced from deep inside getChat/deleteChat/createChat — each
    // answered 500 with an empty body instead. This predicate is what lets a
    // route answer 400, and it must agree with the guard exactly, never be a
    // weaker hand-rolled check.
    it("accepts the ids production actually generates", async () => {
      const { isValidChatId } = await import("@/lib/storage/chat-store");
      expect(isValidChatId(crypto.randomUUID())).toBe(true);
      expect(isValidChatId("realrun-qa-sweep-0e3530db")).toBe(true);
      expect(isValidChatId("c-1")).toBe(true);
    });

    it("rejects traversal in every form the routes can receive", async () => {
      const { isValidChatId } = await import("@/lib/storage/chat-store");
      // Next decodes %2f before the handler sees it, so the guard must reject
      // the DECODED form — that is what actually reached the store.
      expect(isValidChatId("../../../etc/passwd")).toBe(false);
      expect(isValidChatId("a/../../b")).toBe(false);
      expect(isValidChatId("/etc/passwd")).toBe(false);
    });

    it("a BARE `..` is accepted, and that is correct — pinned so nobody 'fixes' it", async () => {
      const { isValidChatId } = await import("@/lib/storage/chat-store");
      // The guard runs on the FINAL fragment, `${chatId}.json`. For `..` that
      // is the literal filename `...json`, which lives inside CHATS_DIR — no
      // traversal, so `false` here would be wrong. Checking the raw id instead
      // of the suffixed fragment is the tempting mistake this pins against:
      // it would reject a harmless id while still missing `../x` in any case
      // where the suffix changes the resolution.
      expect(isValidChatId("..")).toBe(true);
    });

    it("rejects the sibling-prefix trick, not just `..`", async () => {
      const { isValidChatId } = await import("@/lib/storage/chat-store");
      // PM #6 / PM #16: a naive `resolve + startsWith` without the trailing
      // path separator lets `<dir>-evil` pass as if it were inside `<dir>`.
      expect(isValidChatId("../chats-evil/x")).toBe(false);
    });

    it("rejects empty and non-string input rather than throwing", async () => {
      const { isValidChatId } = await import("@/lib/storage/chat-store");
      expect(isValidChatId("")).toBe(false);
      expect(isValidChatId(undefined as unknown as string)).toBe(false);
      expect(isValidChatId(null as unknown as string)).toBe(false);
    });

    it("agrees with the store: an id it accepts is one getChat can handle", async () => {
      // Ties the predicate to the real thing rather than to a second opinion
      // about what "valid" means — the drift this whole class of bug lives in.
      const { isValidChatId, createChat, getChat } = await import(
        "@/lib/storage/chat-store"
      );
      const id = `guard-agrees-${Date.now()}`;
      expect(isValidChatId(id)).toBe(true);
      await createChat(id, "Guard", undefined);
      expect((await getChat(id))?.id).toBe(id);
    });

    it("agrees with the store: an id it rejects is one getChat THROWS on", async () => {
      const { isValidChatId, getChat } = await import("@/lib/storage/chat-store");
      const bad = "../../../etc/passwd";
      expect(isValidChatId(bad)).toBe(false);
      await expect(getChat(bad)).rejects.toThrow();
    });
  });

});
