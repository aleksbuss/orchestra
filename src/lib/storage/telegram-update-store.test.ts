/**
 * Tests for telegram-update-store — the dedupe table that prevents
 * duplicate processing of Telegram webhook deliveries.
 *
 * Why this matters: Telegram retries on any 5xx or timeout. A single
 * user message can hit the webhook 2-3 times. Without claim-once
 * semantics, the agent fires N times and the user sees duplicate
 * replies (each costs tokens). The store IS the dedupe boundary.
 *
 * Pinned invariants:
 *   - First claim → true; any subsequent claim of the same updateId
 *     under the same bot → false.
 *   - Cross-bot isolation: the same updateId on different bots are
 *     independent.
 *   - Hard cap (MAX_UPDATES_PER_BOT = 2000): older entries are evicted
 *     so the file doesn't grow unbounded.
 *   - releaseTelegramUpdate is a rollback for the case where the agent
 *     fails AFTER claim — the next webhook redelivery should succeed.
 *   - Non-integer updateId is rejected loudly (claim) / silently (release).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

let tmpRoot: string;
let cwdSpy: any;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-tg-update-"));
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmpRoot);
  vi.resetModules();
});

afterEach(async () => {
  cwdSpy?.mockRestore();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function loadModule() {
  return await import("./telegram-update-store");
}

describe("claimTelegramUpdate — idempotency contract", () => {
  it("first claim returns true; second claim of the same id returns false", async () => {
    const m = await loadModule();
    expect(await m.claimTelegramUpdate("bot", 100)).toBe(true);
    expect(await m.claimTelegramUpdate("bot", 100)).toBe(false);
  });

  it("different update ids on the same bot are independent", async () => {
    const m = await loadModule();
    expect(await m.claimTelegramUpdate("bot", 100)).toBe(true);
    expect(await m.claimTelegramUpdate("bot", 101)).toBe(true);
    expect(await m.claimTelegramUpdate("bot", 102)).toBe(true);
    // All three are now claimed; re-claim each → false.
    expect(await m.claimTelegramUpdate("bot", 100)).toBe(false);
    expect(await m.claimTelegramUpdate("bot", 101)).toBe(false);
  });

  it("cross-bot isolation — same updateId on different bots both claim", async () => {
    const m = await loadModule();
    expect(await m.claimTelegramUpdate("bot-a", 100)).toBe(true);
    // Different bot, same id — independent. Without isolation a user on
    // bot-b would lose their first message.
    expect(await m.claimTelegramUpdate("bot-b", 100)).toBe(true);
  });

  it("hard cap evicts oldest entries (file size doesn't grow unbounded)", async () => {
    const m = await loadModule();
    // 2050 distinct ids; cap is 2000. Earliest 50 should be evicted, so
    // the very first id can be re-claimed (it's no longer remembered).
    for (let i = 1; i <= 2050; i++) {
      expect(await m.claimTelegramUpdate("bot", i)).toBe(true);
    }
    // The first id (1) was evicted → re-claim succeeds.
    expect(await m.claimTelegramUpdate("bot", 1)).toBe(true);
    // Recent id (2049) is still remembered → re-claim fails.
    expect(await m.claimTelegramUpdate("bot", 2049)).toBe(false);
  }, 30_000);

  it("rejects non-integer updateId loudly (the webhook handler validates upstream too)", async () => {
    const m = await loadModule();
    await expect(m.claimTelegramUpdate("bot", 1.5)).rejects.toThrow(/integer/i);
    await expect(m.claimTelegramUpdate("bot", NaN)).rejects.toThrow(/integer/i);
  });

  it("normalizes the bot id (path-traversal class) before keying", async () => {
    const m = await loadModule();
    // Both "bot/x" and the normalized "bot_x" must hit the same bucket —
    // otherwise an attacker could bypass dedupe by varying punctuation.
    expect(await m.claimTelegramUpdate("bot/x", 100)).toBe(true);
    expect(await m.claimTelegramUpdate("bot_x", 100)).toBe(false);
  });
});

describe("releaseTelegramUpdate — rollback for downstream failure", () => {
  it("releases a previously-claimed id so a redelivery can succeed", async () => {
    const m = await loadModule();
    expect(await m.claimTelegramUpdate("bot", 100)).toBe(true);
    expect(await m.claimTelegramUpdate("bot", 100)).toBe(false);

    await m.releaseTelegramUpdate("bot", 100);

    // After release, Telegram's retry can be claimed again.
    expect(await m.claimTelegramUpdate("bot", 100)).toBe(true);
  });

  it("is a silent no-op when releasing an unknown id", async () => {
    const m = await loadModule();
    await expect(m.releaseTelegramUpdate("bot", 999)).resolves.toBeUndefined();
  });

  it("is a silent no-op on non-integer updateId (defensive — webhook may pass garbage)", async () => {
    const m = await loadModule();
    await expect(m.releaseTelegramUpdate("bot", "abc" as any)).resolves.toBeUndefined();
    await expect(m.releaseTelegramUpdate("bot", 1.5)).resolves.toBeUndefined();
  });

  it("releasing one id leaves siblings claimed", async () => {
    const m = await loadModule();
    await m.claimTelegramUpdate("bot", 100);
    await m.claimTelegramUpdate("bot", 101);

    await m.releaseTelegramUpdate("bot", 100);

    expect(await m.claimTelegramUpdate("bot", 100)).toBe(true); // re-claimable
    expect(await m.claimTelegramUpdate("bot", 101)).toBe(false); // still claimed
  });
});

describe("persistence — round-trip across module reloads", () => {
  it("a claim survives a fresh import (state is in the file, not memory)", async () => {
    const m1 = await loadModule();
    expect(await m1.claimTelegramUpdate("bot", 100)).toBe(true);

    // Simulate a process restart by resetting the module cache and
    // re-importing. The file on disk is the source of truth.
    vi.resetModules();
    const m2 = await loadModule();
    expect(await m2.claimTelegramUpdate("bot", 100)).toBe(false);
  });

  it("recovers from a malformed file (does NOT crash; treats as empty)", async () => {
    const dir = path.join(tmpRoot, "data", "integrations", "telegram");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "processed-updates.json"),
      "{ broken",
      "utf-8"
    );
    const m = await loadModule();
    // No throw, and the malformed state is treated as empty so the next
    // claim succeeds.
    expect(await m.claimTelegramUpdate("bot", 100)).toBe(true);
  });
});
