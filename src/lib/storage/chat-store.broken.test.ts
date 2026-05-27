/**
 * PM #30 regression test — `rebuildChatIndex` must record broken files,
 * not silently skip them.
 *
 * Before PM #30, a corrupt chat file landed under `catch { /_ skip _/ }` with
 * no log signature. Combined with a corrupt chat-index.json (the only path
 * that triggers a rebuild), the chat became invisible in the sidebar with
 * zero operator-facing evidence. Now we record (file, sizeBytes, reason,
 * detectedAt), emit a structured warn log, AND `/api/health` exposes the
 * count under `chat_index_integrity`.
 *
 * What this test exercises:
 *   - corrupt chat-file → entry appears in `getBrokenChatFiles()`
 *   - valid chat-file alongside corrupt one → valid one indexes correctly,
 *     corrupt one recorded (no all-or-nothing on the rebuild)
 *   - operator hand-repairs the file → next rebuild drops it from the registry
 */
import fs from "fs/promises";
import path from "path";
import os from "os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir: string;
let chatStore: typeof import("./chat-store");

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-broken-"));
  vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
  // Silence the expected `chat_index_broken_file` warn lines.
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.resetModules();
  chatStore = await import("./chat-store");
  chatStore.__resetBrokenChatFilesForTest();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeRaw(filename: string, content: string): Promise<void> {
  const chatsDir = path.join(tmpDir, "data", "chats");
  await fs.mkdir(chatsDir, { recursive: true });
  await fs.writeFile(path.join(chatsDir, filename), content, "utf-8");
}

describe("PM #30 — broken-chat-file detection in rebuildChatIndex", () => {
  it("records a corrupt JSON file with file name, size, and reason", async () => {
    await writeRaw("c-broken.json", "{this is not json");

    await chatStore.rebuildChatIndex();

    const broken = chatStore.getBrokenChatFiles();
    expect(broken).toHaveLength(1);
    expect(broken[0].file).toBe("c-broken.json");
    expect(broken[0].sizeBytes).toBeGreaterThan(0);
    expect(broken[0].reason).toMatch(/JSON|Unexpected|parse/i);
    expect(broken[0].detectedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("emits a structured warn log line for the operator to grep", async () => {
    const warnSpy = vi.mocked(console.warn);
    await writeRaw("c-broken-2.json", "}}}");

    await chatStore.rebuildChatIndex();

    const calls = warnSpy.mock.calls.flat().filter((arg): arg is string => typeof arg === "string");
    const interesting = calls.find((line) => line.includes("chat_index_broken_file"));
    expect(interesting).toBeDefined();
    expect(interesting).toContain("c-broken-2.json");
  });

  it("valid files alongside corrupt ones still index successfully", async () => {
    // One valid chat
    const validChat = {
      id: "c-valid",
      title: "valid",
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await writeRaw("c-valid.json", JSON.stringify(validChat));
    // One corrupt
    await writeRaw("c-broken-3.json", "<not json>");

    const items = await chatStore.rebuildChatIndex();

    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("c-valid");
    expect(chatStore.getBrokenChatFiles()).toHaveLength(1);
    expect(chatStore.getBrokenChatFiles()[0].file).toBe("c-broken-3.json");
  });

  it("repaired file drops out of the broken registry on next rebuild", async () => {
    await writeRaw("c-recoverable.json", "<corrupt>");
    await chatStore.rebuildChatIndex();
    expect(chatStore.getBrokenChatFiles()).toHaveLength(1);

    // Operator hand-repairs (or some upstream process replaces) the file.
    const goodChat = {
      id: "c-recoverable",
      title: "ok now",
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await writeRaw("c-recoverable.json", JSON.stringify(goodChat));

    await chatStore.rebuildChatIndex();
    expect(chatStore.getBrokenChatFiles()).toHaveLength(0);
  });
});
