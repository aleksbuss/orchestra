/**
 * PM #6 regression — `deleteChatFile` previously inlined the same broken
 * `startsWith(dir)`-without-`path.sep` guard as the two `/api/files` routes.
 * Even though `path.basename` already strips traversal segments from the
 * typical caller, the function is exported and the bug class was bad enough
 * that we encode the invariant here as a regression guard against future
 * callers that forget to sanitize.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

// LAZY on purpose. `chat-files-store.ts` captures `getDataDir()` in a
// module-level const at import time, and ESM hoists static imports above every
// hook — so a static import bound the OPERATOR'S LIVE `data/chat-files/` before
// the cwd spy below could take effect, and this file created `chat-foo` there
// on every run. The spy alone was never enough; the data dir must be redirected
// BEFORE the module is first evaluated.
type ChatFilesStore = typeof import("./chat-files-store");
let mod: ChatFilesStore;
const deleteChatFile: ChatFilesStore["deleteChatFile"] = (...args) =>
  mod.deleteChatFile(...args);
const getChatFilesDir: ChatFilesStore["getChatFilesDir"] = (...args) =>
  mod.getChatFilesDir(...args);

let tmpRoot: string;
let cwdSpy: any;
let previousDataDir: string | undefined;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-chatfiles-test-"));
  // `getChatFilesDir` resolves under `process.cwd()/data/chat-files/<id>`.
  // We override cwd so the helper's DATA_DIR points into our tmp tree and
  // we can plant a sibling "evil" directory next to a chat dir.
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmpRoot);
  // Redirect the data root BEFORE the module is first evaluated, then import.
  // The spy covers the `<cwd>/data` fallback; the env var covers the case where
  // an outer runner already set one. Both must be in place before this line.
  previousDataDir = process.env.ORCHESTRA_DATA_DIR;
  process.env.ORCHESTRA_DATA_DIR = path.join(tmpRoot, "data");
  mod = await import("./chat-files-store");

  await fs.mkdir(getChatFilesDir("chat-foo"), { recursive: true });
  await fs.mkdir(path.join(tmpRoot, "data", "chat-files", "chat-foo-evil"), {
    recursive: true,
  });

  await fs.writeFile(path.join(getChatFilesDir("chat-foo"), "ok.txt"), "x", "utf-8");
  await fs.writeFile(
    path.join(tmpRoot, "data", "chat-files", "chat-foo-evil", "secret.txt"),
    "DO-NOT-DELETE",
    "utf-8"
  );
});

afterEach(() => {
  cwdSpy?.mockRestore();
  if (previousDataDir === undefined) delete process.env.ORCHESTRA_DATA_DIR;
  else process.env.ORCHESTRA_DATA_DIR = previousDataDir;
});

describe("deleteChatFile — PM #6 regression", () => {
  it("does not delete files in a sibling-prefix directory", async () => {
    // Most callers pass through `path.basename`, which neutralizes this
    // already. The point of the test is the deeper exported contract: an
    // unsanitized call site cannot escape the chat sandbox.
    const result = await deleteChatFile("chat-foo", "../chat-foo-evil/secret.txt");
    expect(result).toBe(false);

    const stat = await fs.stat(
      path.join(tmpRoot, "data", "chat-files", "chat-foo-evil", "secret.txt")
    );
    expect(stat.size).toBeGreaterThan(0);
  });

  it("deletes a benign file inside the chat sandbox (sanity)", async () => {
    const result = await deleteChatFile("chat-foo", "ok.txt");
    expect(result).toBe(true);
    await expect(
      fs.stat(path.join(getChatFilesDir("chat-foo"), "ok.txt"))
    ).rejects.toThrow();
  });
});
