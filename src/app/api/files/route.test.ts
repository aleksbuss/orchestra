/**
 * PM #6 regression — path traversal on DELETE /api/files.
 *
 * The route inlines its own `path.resolve` + `startsWith(workDir)` guard
 * instead of using the shared `assertPathInside` helper. CLAUDE.md flags
 * this exact route by line number for migration. The audit found the bug
 * is not just stylistic — the inlined check is missing the `path.sep`
 * suffix, so a sibling directory with a common prefix slips through:
 *
 *     workDir = "/data/projects/foo"
 *     fullPath = workDir + "/../foo-evil/secrets" → "/data/projects/foo-evil/secrets"
 *     resolvedPath.startsWith(workDir)  // TRUE — passes the inlined check
 *
 * Two layers of test:
 *   1. The textbook `..` traversal → must 403. (Currently passes the inlined
 *      check by accident, since `..` collapses out, but assert it anyway.)
 *   2. The sibling-prefix bypass `../foo-evil/...` → must 403. (This is the
 *      hole the inlined guard misses.)
 *
 * Failing this test = real CVE-class bug. Fixing it = migrate to
 * `assertPathInside`, which appends `path.sep` correctly.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { NextRequest } from "next/server";

vi.mock("@/lib/realtime/event-bus", () => ({
  publishUiSyncEvent: vi.fn(),
}));

// `getWorkDir` is sync and returns a path under cwd. We override it per test
// so we can plant the workdir + the sibling "evil" dir under a tmp root.
vi.mock("@/lib/storage/project-store", async () => {
  const actual = await vi.importActual<typeof import("@/lib/storage/project-store")>(
    "@/lib/storage/project-store"
  );
  return {
    ...actual,
    getWorkDir: vi.fn(),
    getProjectFiles: vi.fn(async () => []),
  };
});

import { DELETE } from "./route";
import { getWorkDir } from "@/lib/storage/project-store";

let tmpRoot: string;
let workDir: string;
let evilDir: string;
let secretFile: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-files-test-"));
  workDir = path.join(tmpRoot, "foo");
  evilDir = path.join(tmpRoot, "foo-evil");
  await fs.mkdir(workDir, { recursive: true });
  await fs.mkdir(evilDir, { recursive: true });
  secretFile = path.join(evilDir, "secrets.txt");
  await fs.writeFile(secretFile, "pretend-this-is-a-cred", "utf-8");

  // Plant a benign file inside workDir so legit deletes still work.
  await fs.writeFile(path.join(workDir, "readme.txt"), "hello", "utf-8");

  vi.mocked(getWorkDir).mockReturnValue(workDir);
});

function deleteRequest(filePath: string): NextRequest {
  const url = new URL("http://localhost:3000/api/files");
  url.searchParams.set("project", "foo");
  url.searchParams.set("path", filePath);
  return new NextRequest(url, { method: "DELETE" });
}

describe("DELETE /api/files — PM #6 path traversal", () => {
  it("rejects classic ../../../etc/passwd traversal with 403", async () => {
    const res = await DELETE(deleteRequest("../../../../etc/passwd"));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/invalid/i);
  });

  it("rejects sibling-prefix bypass (../foo-evil/secrets.txt) with 403 — NOT 200", async () => {
    // This is the bug. `path.resolve(workDir, "../foo-evil/secrets.txt")`
    // returns `<tmp>/foo-evil/secrets.txt`, which startsWith(`<tmp>/foo`)
    // is TRUE — the inlined guard passes it. The fix is `assertPathInside`,
    // which compares against `<tmp>/foo` + path.sep so the prefix-only
    // overlap is rejected.
    const res = await DELETE(deleteRequest("../foo-evil/secrets.txt"));
    expect(res.status, "sibling-prefix path must be rejected").toBe(403);

    // Strong assertion: the file must still exist on disk after the call.
    // If the guard let the unlink through, this stat will throw.
    await expect(fs.stat(secretFile)).resolves.toBeDefined();
  });

  it("does not delete files outside workDir, regardless of status (absolute path)", async () => {
    // Note on shape: `path.join(workDir, "/abs/path")` does NOT re-anchor on
    // the absolute slash — Node's `path.join` treats it as a separator, so
    // the absolute fragment becomes a sub-path under workDir. The result is
    // that an outside file is never reached *by accident*, but only because
    // of the join semantics, not because the route validated the input.
    // What we lock down here is the actual invariant: the outside file
    // must still exist after the call. The status code may be 403 (good
    // guard) or 404 (file not found at the joined non-existent sub-path) —
    // both are acceptable; deleting the outside file is not.
    const before = await fs.stat(secretFile);
    const res = await DELETE(deleteRequest(secretFile));
    expect([403, 404]).toContain(res.status);
    const after = await fs.stat(secretFile);
    expect(after.size).toBe(before.size);
  });

  it("allows deletion of a benign file inside the workDir (sanity)", async () => {
    const res = await DELETE(deleteRequest("readme.txt"));
    expect(res.status).toBe(200);
    await expect(fs.stat(path.join(workDir, "readme.txt"))).rejects.toThrow();
  });
});
