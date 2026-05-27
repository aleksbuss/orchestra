import fs from "fs/promises";
import path from "path";
import { Chat, ChatListItem, ChatSchema } from "@/lib/types";
import { publishUiSyncEvent } from "@/lib/realtime/event-bus";
import { withFileLock, safeWriteFile } from "@/lib/storage/fs-utils";

const DATA_DIR = path.join(process.cwd(), "data");
const CHATS_DIR = path.join(DATA_DIR, "chats");

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

const CHAT_INDEX_FILE = path.join(DATA_DIR, "chat-index.json");

/* ─── Hot-path optimization: read cache + debounced write coalescing ────────
 *
 * Why: every message append used to read+parse, mutate, and serialize+write
 * the entire chat JSON file. For a 376 KB autoresearch session that is
 * ~16 KB of churn per message, multiplied by every tool call. JSON parse
 * and stringify are single-threaded V8 calls that block the agent loop.
 *
 * The cache eliminates the parse cost: once a chat is read from disk, the
 * parsed object is held in memory until the chat is deleted. Subsequent
 * `getChat()` calls return the cached reference (Chat is treated as
 * write-through-the-API: callers must use `updateChat` / `saveChat` to
 * mutate, never mutate the returned object directly).
 *
 * The debounce coalesces bursts: when several writes hit the same chat
 * within FLUSH_DEBOUNCE_MS (a tool-call storm during streaming), only the
 * latest snapshot is actually written to disk. A trailing flush guarantees
 * the latest state always lands.
 *
 * Tradeoff: a process crash within the debounce window loses the last
 * burst of un-flushed writes. The single-developer / local-first deployment
 * profile makes this acceptable; if multi-process or stricter durability
 * is ever needed, replace the cache + debouncer with a proper embedded
 * store (SQLite + WAL).
 */
const FLUSH_DEBOUNCE_MS = 80;
const chatCache = new Map<string, Chat>();
interface PendingFlush {
  chat: Chat;
  timer: ReturnType<typeof setTimeout>;
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}
const pendingFlushes = new Map<string, PendingFlush>();

function chatFilePath(chatId: string): string {
  return path.join(CHATS_DIR, `${chatId}.json`);
}

async function flushNow(chatId: string): Promise<void> {
  const entry = pendingFlushes.get(chatId);
  if (!entry) return;
  pendingFlushes.delete(chatId);
  clearTimeout(entry.timer);
  try {
    const filePath = chatFilePath(chatId);
    await withFileLock(filePath, async () => {
      await safeWriteFile(filePath, JSON.stringify(entry.chat, null, 2));
    });
    await updateIndexItem(entry.chat);
    publishUiSyncEvent({
      topic: "chat",
      chatId: entry.chat.id,
      projectId: entry.chat.projectId ?? null,
      reason: "chat_saved",
    });
    entry.resolve();
  } catch (err) {
    entry.reject(err);
  }
}

function scheduleFlush(chat: Chat): Promise<void> {
  chatCache.set(chat.id, chat);
  const existing = pendingFlushes.get(chat.id);
  if (existing) {
    existing.chat = chat;
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => {
      void flushNow(chat.id);
    }, FLUSH_DEBOUNCE_MS);
    return existing.promise;
  }
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const entry: PendingFlush = {
    chat,
    timer: setTimeout(() => {
      void flushNow(chat.id);
    }, FLUSH_DEBOUNCE_MS),
    promise,
    resolve,
    reject,
  };
  pendingFlushes.set(chat.id, entry);
  return promise;
}

/** Force-flush every pending chat write. Use on graceful shutdown. */
export async function flushAllPendingChats(): Promise<void> {
  const ids = [...pendingFlushes.keys()];
  await Promise.all(ids.map((id) => flushNow(id)));
}

/**
 * Wire SIGTERM / SIGINT to flush every pending chat write before the process
 * exits (PM #29). Without this, a graceful restart during streaming or an
 * orchestrated `kill -TERM` lose the last debounce-window (80 ms) of agent
 * tool outputs because the `setTimeout`-scheduled `flushNow` never fires.
 *
 * Module-level side effect — runs once per process. Idempotent via a
 * globalThis flag so Next.js dev-mode reloads don't stack handlers (each
 * reload re-evaluates the module; without the flag, signals would fire N
 * times after N reloads, calling `flushAllPendingChats` N times — harmless
 * for correctness but wasteful and pollutes telemetry).
 *
 * The handler returns synchronously but schedules an async flush. Node won't
 * exit while file I/O is pending, so the writes complete before process
 * teardown — verified by the regression test in `chat-store.flush.test.ts`.
 */
declare global {
  var __orchestraChatStoreFlushHandlersInstalled__: boolean | undefined;
}

function installChatStoreShutdownFlush(): void {
  if (globalThis.__orchestraChatStoreFlushHandlersInstalled__) return;
  globalThis.__orchestraChatStoreFlushHandlersInstalled__ = true;

  const onSignal = (sig: string) => {
    if (pendingFlushes.size === 0) return;
    console.log(
      `[chat-store] Received ${sig}, flushing ${pendingFlushes.size} pending chat write(s) before exit.`
    );
    // Fire-and-forget on purpose: Node keeps the event loop alive while
    // safeWriteFile I/O is pending, so writes drain naturally before the
    // process exits. Awaiting from inside a signal handler isn't necessary
    // and would only matter if other handlers in the chain raced to call
    // `process.exit()`, which Orchestra does not do.
    void flushAllPendingChats().catch((err) => {
      console.error("[chat-store] SIGTERM flush failed:", err);
    });
  };

  process.once("SIGTERM", () => onSignal("SIGTERM"));
  process.once("SIGINT", () => onSignal("SIGINT"));
}

// Skip during Vitest runs — the test runner emits SIGTERM/SIGINT for its own
// lifecycle (process teardown, watcher restart) and we don't want this
// handler to log noise or compete with the test's own signal mocks.
if (process.env.VITEST !== "true" && process.env.NODE_ENV !== "test") {
  installChatStoreShutdownFlush();
}

/** Test-only: expose the installer so the regression test can opt in. */
export const __testInternals__ = {
  installChatStoreShutdownFlush,
};

/** Test helper / project deletion: drop cache + cancel pending flush for one chat. */
function evictChatCache(chatId: string): void {
  const pending = pendingFlushes.get(chatId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingFlushes.delete(chatId);
    pending.resolve();
  }
  chatCache.delete(chatId);
}

/**
 * Reads only the lightweight chat index for sidebar display.
 * This is O(1) disk read instead of O(N).
 */
export async function getAllChats(): Promise<ChatListItem[]> {
  await ensureDir(CHATS_DIR);
  
  // Try reading from index first
  try {
    const indexContent = await fs.readFile(CHAT_INDEX_FILE, "utf-8");
    return JSON.parse(indexContent) as ChatListItem[];
  } catch (err) {
    // Index missing or corrupted — rebuild from individual files
    const isParseError = err instanceof SyntaxError;
    if (isParseError) {
      console.warn("[chat-store] chat-index.json is corrupted, rebuilding from source files.");
    }
    return await rebuildChatIndex();
  }
}

/**
 * Records chat files that failed to parse during the last `rebuildChatIndex`.
 * Reported via `/api/health` and surfaced as an operator-facing banner so
 * silent two-strike data loss (chat-index corrupt + a chat-file corrupt)
 * becomes a visible signal instead of an invisible omission (PM #30).
 *
 * Module-level Map so it survives across calls (the index doesn't auto-rebuild
 * on every page load — operator needs to see lingering broken files even on
 * subsequent `getAllChats` calls that hit the cached index).
 */
interface BrokenChatFile {
  file: string;
  sizeBytes: number;
  reason: string;
  detectedAt: string;
}
const brokenChatFiles = new Map<string, BrokenChatFile>();

export function getBrokenChatFiles(): BrokenChatFile[] {
  return [...brokenChatFiles.values()];
}

/** Test-only: clear the broken-files record between cases. */
export function __resetBrokenChatFilesForTest(): void {
  brokenChatFiles.clear();
}

/**
 * Scans all chat files to recreate the index.
 * Only called as fallback or after bulk operations.
 *
 * PM #30 — files that fail to parse used to be silently skipped (`catch {}`).
 * Two-strike condition (corrupt index + corrupt chat-file) made the chat
 * disappear from the sidebar with no log signature. Now we record the file
 * name + size + reason in `brokenChatFiles` and emit a structured log line
 * so the operator has a chance to recover the file (or accept the loss).
 */
export async function rebuildChatIndex(): Promise<ChatListItem[]> {
  await ensureDir(CHATS_DIR);
  const files = await fs.readdir(CHATS_DIR);
  const items: ChatListItem[] = [];

  for (const file of files) {
    // NOTE: CHAT_INDEX_FILE lives in DATA_DIR (data/), not CHATS_DIR (data/chats/).
    // No need to skip it here — it will never appear in the readdir(CHATS_DIR) listing.
    if (!file.endsWith(".json")) continue;
    const filePath = path.join(CHATS_DIR, file);
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const chat = JSON.parse(content);
      items.push({
        id: chat.id,
        title: chat.title,
        projectId: chat.projectId,
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt,
        messageCount: chat.messages?.length ?? 0,
      });
      // If a previously broken file is now parseable (operator hand-repaired
      // it, or the previous error was transient), drop it from the registry.
      brokenChatFiles.delete(file);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      let sizeBytes = 0;
      try {
        const stat = await fs.stat(filePath);
        sizeBytes = stat.size;
      } catch { /* file vanished between readdir and stat — leave size 0 */ }
      brokenChatFiles.set(file, {
        file,
        sizeBytes,
        reason,
        detectedAt: new Date().toISOString(),
      });
      // Structured log so `grep chat_index_broken_file data/logs/*.jsonl`
      // (or stdout when running `npm run dev`) surfaces every skip with the
      // exact filename. Replaces the previous silent `catch {}`.
      console.warn(
        `[chat-store] chat_index_broken_file ${JSON.stringify({ file, sizeBytes, reason })}`
      );
    }
  }

  const sorted = items.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );

  // Atomic write index with lock to prevent race conditions during rebuild
  await withFileLock(CHAT_INDEX_FILE, async () => {
    await safeWriteFile(CHAT_INDEX_FILE, JSON.stringify(sorted, null, 2));
  });
  return sorted;
}

/** Internal helper to update one item in the index without full rebuild */
async function updateIndexItem(chat: Chat) {
  await withFileLock(CHAT_INDEX_FILE, async () => {
    let index: ChatListItem[] = [];
    try {
      const content = await fs.readFile(CHAT_INDEX_FILE, "utf-8");
      index = JSON.parse(content);
    } catch {
      // If index fails, we'll need to rebuild later, but for now start fresh
    }

    const item: ChatListItem = {
      id: chat.id,
      title: chat.title,
      projectId: chat.projectId,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
      messageCount: chat.messages.length,
    };

    // Replace or add
    const existingIdx = index.findIndex(i => i.id === chat.id);
    if (existingIdx !== -1) {
      index[existingIdx] = item;
    } else {
      index.unshift(item);
    }

    // Keep sorted by updatedAt
    index.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    
    await safeWriteFile(CHAT_INDEX_FILE, JSON.stringify(index, null, 2));
  });
}

/** Internal helper to remove one item from index */
async function removeIndexItem(chatId: string) {
  await withFileLock(CHAT_INDEX_FILE, async () => {
    try {
      const content = await fs.readFile(CHAT_INDEX_FILE, "utf-8");
      let index: ChatListItem[] = JSON.parse(content);
      index = index.filter(i => i.id !== chatId);
      await safeWriteFile(CHAT_INDEX_FILE, JSON.stringify(index, null, 2));
    } catch { /* ignore if index missing */ }
  });
}

export async function getChat(chatId: string): Promise<Chat | null> {
  // Cache hit: returns the live parsed object, including any in-flight
  // unflushed mutations (the cache is updated synchronously by saveChat /
  // updateChat before the disk write completes).
  const cached = chatCache.get(chatId);
  if (cached) return cached;

  await ensureDir(CHATS_DIR);
  const filePath = chatFilePath(chatId);

  // Retry once after 50ms if file not found — helps with transient ENOENT during atomic renames (fs.rename)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const parsedRaw = JSON.parse(content);
      const parseResult = ChatSchema.safeParse(parsedRaw);

      if (!parseResult.success) {
        console.warn(`[chat-store] Chat ${chatId} is corrupted:`, parseResult.error.message);
        return null;
      }

      const chat = parseResult.data as Chat;
      chatCache.set(chatId, chat);
      return chat;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT" && attempt === 0) {
        await new Promise(resolve => setTimeout(resolve, 50));
        continue;
      }
      return null;
    }
  }
  return null;
}

export async function saveChat(chat: Chat): Promise<void> {
  await ensureDir(CHATS_DIR);
  // Cache update is synchronous — concurrent reads and the agent's next
  // turn see the latest state immediately. The disk write is debounced.
  scheduleFlush(chat);
}

/**
 * Safely updates a chat: read latest state via cache (or disk), apply the
 * mutator, store the result back. Uses the same per-file lock as flushNow,
 * so concurrent updateChat calls on the same chat are serialized within the
 * process. Cross-process concurrency is intentionally not addressed here —
 * the local-first deployment runs a single Node process.
 */
export async function updateChat(
  chatId: string,
  mutator: (chat: Chat) => Chat | Promise<Chat>
): Promise<Chat | null> {
  const filePath = chatFilePath(chatId);

  const updated = await withFileLock<Chat | null>(filePath, async () => {
    let chat: Chat | null = chatCache.get(chatId) ?? null;
    if (!chat) {
      try {
        const content = await fs.readFile(filePath, "utf-8");
        const parsedRaw = JSON.parse(content);
        const parseResult = ChatSchema.safeParse(parsedRaw);
        if (parseResult.success) chat = parseResult.data as Chat;
      } catch {
        return null;
      }
    }

    if (!chat) return null;
    chat = await mutator(chat);
    return chat;
  });

  if (!updated) return null;

  scheduleFlush(updated);

  publishUiSyncEvent({
    topic: "chat",
    chatId: updated.id,
    projectId: updated.projectId ?? null,
    reason: "chat_updated",
  });

  return updated;
}

export async function deleteChat(chatId: string): Promise<boolean> {
  const existing = await getChat(chatId);
  evictChatCache(chatId);
  const filePath = chatFilePath(chatId);
  try {
    await fs.unlink(filePath);
    await removeIndexItem(chatId);
    publishUiSyncEvent({
      topic: "chat",
      chatId,
      projectId: existing?.projectId ?? null,
      reason: "chat_deleted",
    });
    return true;
  } catch {
    return false;
  }
}

/** Delete all chats that belong to the given project. Returns number of deleted chats. */
export async function deleteChatsByProjectId(projectId: string): Promise<number> {
  await ensureDir(CHATS_DIR);
  // Drain pending writes so we read consistent state from disk.
  await flushAllPendingChats();
  const files = await fs.readdir(CHATS_DIR);
  let deleted = 0;
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const content = await fs.readFile(path.join(CHATS_DIR, file), "utf-8");
      const parsedRaw = JSON.parse(content);
      const parseResult = ChatSchema.safeParse(parsedRaw);
      if (!parseResult.success) continue;
      const chat = parseResult.data;
      if (chat.projectId === projectId) {
        evictChatCache(chat.id);
        await fs.unlink(path.join(CHATS_DIR, file));
        deleted++;
      }
    } catch {
      // skip corrupted files
    }
  }
  if (deleted > 0) {
    await rebuildChatIndex();
    publishUiSyncEvent({
      topic: "chat",
      projectId,
      reason: "project_chats_deleted",
    });
  }
  return deleted;
}

export async function createChat(
  id: string,
  title: string,
  projectId?: string
): Promise<Chat> {
  const now = new Date().toISOString();
  const chat: Chat = {
    id,
    title,
    projectId,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
  // createChat is a control-plane call (chat list refresh, sidebar), so we
  // flush immediately rather than waiting on debounce — gives a deterministic
  // round-trip for the caller.
  scheduleFlush(chat);
  await flushNow(id);
  return chat;
}
