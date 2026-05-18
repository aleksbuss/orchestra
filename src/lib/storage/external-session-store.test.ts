/**
 * Tests for external-session storage. Sessions are keyed by an
 * untrusted-from-the-network `sessionId` (e.g., a Telegram user id), so
 * the path-derivation MUST sandbox aggressively. PM #6 / #16 territory:
 *   - The id regex `^[a-zA-Z0-9._:-]{1,128}$` is the only thing keeping
 *     a malicious caller from making us write to `../../etc/`.
 *   - Anything in `getExternalSession` that doesn't match should throw
 *     loudly, not silently land an evil path.
 *
 * Pinned invariants:
 *   - Read of a missing session returns `null` (not throws).
 *   - getOrCreate creates with sane defaults.
 *   - Round-trip preserves all fields, including empty maps for activeChats.
 *   - Invalid id (slashes, traversal, oversize) throws on every entrypoint.
 *   - contextKey: empty/null projectId → __global__; non-empty → as-is.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

let tmpRoot: string;
let cwdSpy: any;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-extsess-"));
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmpRoot);
  vi.resetModules();
});

afterEach(async () => {
  cwdSpy?.mockRestore();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function loadModule() {
  return await import("./external-session-store");
}

describe("contextKey — projectId fallback to __global__", () => {
  it("empty / null / whitespace projectId returns __global__", async () => {
    const m = await loadModule();
    expect(m.contextKey(null)).toBe("__global__");
    expect(m.contextKey(undefined)).toBe("__global__");
    expect(m.contextKey("")).toBe("__global__");
    expect(m.contextKey("   ")).toBe("__global__");
  });

  it("real projectId is returned verbatim", async () => {
    const m = await loadModule();
    expect(m.contextKey("proj-1")).toBe("proj-1");
  });
});

describe("getExternalSession — read path", () => {
  it("returns null when no session file exists", async () => {
    const m = await loadModule();
    expect(await m.getExternalSession("alice")).toBeNull();
  });

  it("returns the session when persisted", async () => {
    const m = await loadModule();
    const created = await m.getOrCreateExternalSession("alice");
    expect(created.id).toBe("alice");
    const fetched = await m.getExternalSession("alice");
    expect(fetched).toEqual(created);
  });

  it("coerces missing/invalid activeChats and currentPaths to empty maps", async () => {
    const dir = path.join(tmpRoot, "data", "external-sessions");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "alice.json"),
      JSON.stringify({
        id: "alice",
        activeProjectId: null,
        activeChats: "not-an-object",
        currentPaths: null,
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-01T00:00:00.000Z",
      }),
      "utf-8"
    );
    const m = await loadModule();
    const out = await m.getExternalSession("alice");
    expect(out?.activeChats).toEqual({});
    expect(out?.currentPaths).toEqual({});
  });

  it("returns null on malformed JSON (does NOT crash)", async () => {
    const dir = path.join(tmpRoot, "data", "external-sessions");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "alice.json"), "{ broken", "utf-8");
    const m = await loadModule();
    expect(await m.getExternalSession("alice")).toBeNull();
  });
});

describe("getOrCreateExternalSession — defaults", () => {
  it("creates a session with empty maps and ISO timestamps", async () => {
    const m = await loadModule();
    const s = await m.getOrCreateExternalSession("user-7");
    expect(s.id).toBe("user-7");
    expect(s.activeProjectId).toBeNull();
    expect(s.activeChats).toEqual({});
    expect(s.currentPaths).toEqual({});
    expect(new Date(s.createdAt).toISOString()).toBe(s.createdAt);
  });

  it("idempotent — second call with the same id returns the existing session", async () => {
    const m = await loadModule();
    const a = await m.getOrCreateExternalSession("idem");
    await new Promise((r) => setTimeout(r, 5));
    const b = await m.getOrCreateExternalSession("idem");
    expect(b.createdAt).toBe(a.createdAt);
  });
});

describe("session id validation — sandbox boundary", () => {
  // The regex IS the security boundary against path traversal here. PM #6
  // class — these tests are a regression guard.
  const evil = [
    "../../../etc/passwd",
    "alice/../bob",
    "alice\\bob",
    "with space",
    "with$dollar",
    "with;semicolon",
    "x".repeat(129), // over the 128 cap
  ];

  for (const bad of evil) {
    it(`rejects malicious sessionId ${JSON.stringify(bad).slice(0, 40)}`, async () => {
      const m = await loadModule();
      await expect(m.getOrCreateExternalSession(bad)).rejects.toThrow(/sessionId/i);
    });
  }

  it("accepts legitimate ids: alphanumeric, dot, underscore, colon, hyphen", async () => {
    const m = await loadModule();
    for (const ok of ["alice", "user.123", "tg:42", "session-abc_99"]) {
      await expect(m.getOrCreateExternalSession(ok)).resolves.toBeDefined();
    }
  });

  it("rejects empty / whitespace-only id", async () => {
    const m = await loadModule();
    await expect(m.getOrCreateExternalSession("")).rejects.toThrow(/sessionId/i);
    await expect(m.getOrCreateExternalSession("   ")).rejects.toThrow(/sessionId/i);
  });
});

describe("saveExternalSession — round-trip", () => {
  it("persists modifications via saveExternalSession", async () => {
    const m = await loadModule();
    const s = await m.getOrCreateExternalSession("alice");
    s.activeProjectId = "proj-x";
    s.activeChats = { "proj-x": "chat-1" };
    s.currentPaths = { "proj-x": "/some/path" };
    await m.saveExternalSession(s);

    const reloaded = await m.getExternalSession("alice");
    expect(reloaded?.activeProjectId).toBe("proj-x");
    expect(reloaded?.activeChats).toEqual({ "proj-x": "chat-1" });
    expect(reloaded?.currentPaths).toEqual({ "proj-x": "/some/path" });
  });
});
