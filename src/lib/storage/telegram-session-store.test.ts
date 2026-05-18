/**
 * Tests for telegram-session-store — the per-(bot, chat) → sessionId
 * mapping consumed by the inbound webhook handler.
 *
 * Pinned invariants:
 *   - botId normalization: keep [a-zA-Z0-9._:-], strip everything else,
 *     fall back to "default" for empty/whitespace. Same regex used as
 *     defense-in-depth for path-traversal class (PM #6/#16).
 *   - Default + fresh session ids encode the chat key for human triage.
 *   - Empty/missing chat-sessions file → null (no throw on first install).
 *   - setTelegramChatSessionId rejects empty/whitespace.
 *   - Round-trip: set → get returns the persisted sessionId.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

let tmpRoot: string;
let cwdSpy: any;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-tg-sess-"));
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmpRoot);
  vi.resetModules();
});

afterEach(async () => {
  cwdSpy?.mockRestore();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function loadModule() {
  return await import("./telegram-session-store");
}

describe("createDefaultTelegramSessionId — sandbox-friendly id encoding", () => {
  it("encodes bot id + chat id in the canonical format", async () => {
    const m = await loadModule();
    expect(m.createDefaultTelegramSessionId("123456", "42")).toBe(
      "telegram:123456:42"
    );
  });

  it("normalizes hostile bot ids to safe characters", async () => {
    const m = await loadModule();
    // `/` is rejected → underscored. The point is that this id later flows
    // into external-session-store paths (data/external-sessions/<id>.json),
    // so the normalized output must satisfy that store's regex too.
    expect(m.createDefaultTelegramSessionId("../evil", "1")).toBe(
      "telegram:.._evil:1"
    );
  });

  it("falls back to 'default' for empty / whitespace bot ids", async () => {
    const m = await loadModule();
    expect(m.createDefaultTelegramSessionId("", "1")).toBe(
      "telegram:default:1"
    );
    expect(m.createDefaultTelegramSessionId("   ", "1")).toBe(
      "telegram:default:1"
    );
  });

  it("accepts both string and number chat ids (Telegram sends ints, API sometimes strings)", async () => {
    const m = await loadModule();
    expect(m.createDefaultTelegramSessionId("bot", 42)).toBe(
      "telegram:bot:42"
    );
    expect(m.createDefaultTelegramSessionId("bot", "42")).toBe(
      "telegram:bot:42"
    );
  });
});

describe("createFreshTelegramSessionId — disposable session id with nonce", () => {
  it("derives from the canonical id and appends a hex nonce", async () => {
    const m = await loadModule();
    const id = m.createFreshTelegramSessionId("bot", 42);
    expect(id.startsWith("telegram:bot:42:")).toBe(true);
    // The nonce is a UUID with dashes stripped: 32 hex chars.
    const nonce = id.replace("telegram:bot:42:", "");
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
  });

  it("produces unique values across calls (entropy sanity)", async () => {
    const m = await loadModule();
    const a = m.createFreshTelegramSessionId("bot", 42);
    const b = m.createFreshTelegramSessionId("bot", 42);
    expect(a).not.toBe(b);
  });
});

describe("getTelegramChatSessionId — read", () => {
  it("returns null when no chat-sessions file exists yet", async () => {
    const m = await loadModule();
    expect(await m.getTelegramChatSessionId("bot", 42)).toBeNull();
  });

  it("returns null when the chat is not in the file", async () => {
    const dir = path.join(tmpRoot, "data", "integrations", "telegram");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "chat-sessions.json"),
      JSON.stringify({ sessions: { "bot:99": "telegram:bot:99" } }),
      "utf-8"
    );
    const m = await loadModule();
    expect(await m.getTelegramChatSessionId("bot", 42)).toBeNull();
  });

  it("returns null on a malformed sessions file (does NOT crash)", async () => {
    const dir = path.join(tmpRoot, "data", "integrations", "telegram");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "chat-sessions.json"),
      "{ broken",
      "utf-8"
    );
    const m = await loadModule();
    expect(await m.getTelegramChatSessionId("bot", 42)).toBeNull();
  });

  it("trims-and-rejects empty stored values (defense — never return whitespace)", async () => {
    const dir = path.join(tmpRoot, "data", "integrations", "telegram");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "chat-sessions.json"),
      JSON.stringify({ sessions: { "bot:42": "   " } }),
      "utf-8"
    );
    const m = await loadModule();
    expect(await m.getTelegramChatSessionId("bot", 42)).toBeNull();
  });
});

describe("setTelegramChatSessionId — write + round-trip", () => {
  it("persists and re-reads the same sessionId", async () => {
    const m = await loadModule();
    await m.setTelegramChatSessionId("bot", 42, "telegram:bot:42:nonce");
    expect(await m.getTelegramChatSessionId("bot", 42)).toBe(
      "telegram:bot:42:nonce"
    );
  });

  it("rejects empty / whitespace-only sessionId", async () => {
    const m = await loadModule();
    await expect(m.setTelegramChatSessionId("bot", 42, "")).rejects.toThrow(/empty/i);
    await expect(m.setTelegramChatSessionId("bot", 42, "   ")).rejects.toThrow(/empty/i);
  });

  it("trims whitespace around stored value", async () => {
    const m = await loadModule();
    await m.setTelegramChatSessionId("bot", 42, "  trimmed  ");
    expect(await m.getTelegramChatSessionId("bot", 42)).toBe("trimmed");
  });

  it("isolates by botId — same chatId on different bots are separate", async () => {
    const m = await loadModule();
    await m.setTelegramChatSessionId("bot-a", 42, "id-a");
    await m.setTelegramChatSessionId("bot-b", 42, "id-b");
    expect(await m.getTelegramChatSessionId("bot-a", 42)).toBe("id-a");
    expect(await m.getTelegramChatSessionId("bot-b", 42)).toBe("id-b");
  });

  it("normalizes botId on write the same way as on read (round-trip after sanitization)", async () => {
    const m = await loadModule();
    // Pre-sanitization "bot/with/slashes" and post-sanitization "bot_with_slashes"
    // must hit the SAME storage cell.
    await m.setTelegramChatSessionId("bot/with/slashes", 42, "id-x");
    expect(await m.getTelegramChatSessionId("bot_with_slashes", 42)).toBe("id-x");
  });
});
