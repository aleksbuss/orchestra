/**
 * Tests for the external-api-token store. This is the credential the
 * `/api/external/message` route checks — it's the only auth on a route
 * that's PUBLIC by design (in middleware allowlist), so a regression
 * here means the world can drive your agent.
 *
 * Pinned invariants:
 *   - Missing file → null (not a thrown error). The status check needs to
 *     succeed to render the "no token configured" UI; throwing would make
 *     the whole settings page error.
 *   - Empty / whitespace-only token in the file → treated as "no token".
 *     Defends against an operator who saved with a blank input and now
 *     thinks they're "secure."
 *   - Save preserves `createdAt` across rewrites — only `updatedAt` moves.
 *     This matters for UI showing "token created N days ago".
 *   - Generated tokens are unique, look like the documented prefix, and
 *     have enough entropy (32-byte hex = 64 chars).
 *   - Mask never reveals more than 6+4 chars; helps audit screenshots.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import {
  generateExternalApiToken,
  maskExternalApiToken,
} from "./external-api-token-store";

let tmpRoot: string;
let cwdSpy: any;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-extapi-"));
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmpRoot);
  vi.resetModules();
});

afterEach(async () => {
  cwdSpy?.mockRestore();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function loadModule() {
  return await import("./external-api-token-store");
}

describe("getExternalApiToken — read path", () => {
  it("returns null when the file does not exist (fresh install)", async () => {
    const m = await loadModule();
    expect(await m.getExternalApiToken()).toBeNull();
  });

  it("returns the persisted token", async () => {
    const m = await loadModule();
    await m.saveExternalApiToken("orchestra_ext_real_token");
    expect(await m.getExternalApiToken()).toBe("orchestra_ext_real_token");
  });

  it("returns null on a whitespace-only token (defensive — never accept blank)", async () => {
    const settingsDir = path.join(tmpRoot, "data", "settings");
    await fs.mkdir(settingsDir, { recursive: true });
    await fs.writeFile(
      path.join(settingsDir, "external-api-token.json"),
      JSON.stringify({ token: "   " }),
      "utf-8"
    );
    const m = await loadModule();
    expect(await m.getExternalApiToken()).toBeNull();
  });

  it("returns null on malformed JSON (does NOT crash callers)", async () => {
    const settingsDir = path.join(tmpRoot, "data", "settings");
    await fs.mkdir(settingsDir, { recursive: true });
    await fs.writeFile(
      path.join(settingsDir, "external-api-token.json"),
      "{ corrupted",
      "utf-8"
    );
    const m = await loadModule();
    expect(await m.getExternalApiToken()).toBeNull();
  });
});

describe("getExternalApiTokenStatus — UI metadata", () => {
  it("reports configured=false on a fresh install", async () => {
    const m = await loadModule();
    const status = await m.getExternalApiTokenStatus();
    expect(status.configured).toBe(false);
    expect(status.maskedToken).toBeNull();
    expect(status.updatedAt).toBeNull();
  });

  it("returns masked token + updatedAt when configured", async () => {
    const m = await loadModule();
    await m.saveExternalApiToken("orchestra_ext_aaaa1111bbbb2222");
    const status = await m.getExternalApiTokenStatus();
    expect(status.configured).toBe(true);
    expect(status.maskedToken).toMatch(/^orches\*\*\*\*2222$/);
    expect(typeof status.updatedAt).toBe("string");
    // ISO sanity
    expect(new Date(status.updatedAt as string).toISOString()).toBe(status.updatedAt);
  });
});

describe("saveExternalApiToken", () => {
  it("rejects empty / whitespace-only tokens", async () => {
    const m = await loadModule();
    await expect(m.saveExternalApiToken("")).rejects.toThrow(/empty/i);
    await expect(m.saveExternalApiToken("   ")).rejects.toThrow(/empty/i);
  });

  it("trims the input before persisting", async () => {
    const m = await loadModule();
    await m.saveExternalApiToken("  trim-me  ");
    expect(await m.getExternalApiToken()).toBe("trim-me");
  });

  it("preserves createdAt across rewrites; only updatedAt moves", async () => {
    const m = await loadModule();
    await m.saveExternalApiToken("first");
    const first = await m.getExternalApiTokenStatus();

    // Wait a millisecond so updatedAt differs.
    await new Promise((r) => setTimeout(r, 5));
    await m.saveExternalApiToken("second");

    // Read raw to check createdAt — it's not in the public status shape.
    const raw = await fs.readFile(
      path.join(tmpRoot, "data", "settings", "external-api-token.json"),
      "utf-8"
    );
    const parsed = JSON.parse(raw) as { createdAt: string; updatedAt: string };

    // updatedAt MUST have moved forward.
    expect(parsed.updatedAt).not.toBe(first.updatedAt);
    // createdAt stays at the FIRST install timestamp.
    expect(parsed.createdAt).toBe(first.updatedAt);
  });
});

describe("generateExternalApiToken", () => {
  it("uses the orchestra_ext_ prefix the docs promise", async () => {
    const t = generateExternalApiToken();
    expect(t.startsWith("orchestra_ext_")).toBe(true);
  });

  it("has >= 60 chars after the prefix (32 random bytes -> 64 hex)", async () => {
    const t = generateExternalApiToken();
    const body = t.replace(/^orchestra_ext_/, "");
    expect(body.length).toBeGreaterThanOrEqual(60);
    expect(body).toMatch(/^[0-9a-f]+$/);
  });

  it("produces unique tokens across calls (entropy sanity)", async () => {
    const a = generateExternalApiToken();
    const b = generateExternalApiToken();
    expect(a).not.toBe(b);
  });
});

describe("maskExternalApiToken", () => {
  it("returns **** for tokens 10 chars or shorter (insufficient material to mask safely)", async () => {
    expect(maskExternalApiToken("short")).toBe("****");
    expect(maskExternalApiToken("0123456789")).toBe("****"); // exactly 10
  });

  it("shows first 6 + last 4 with **** in between for normal-length tokens", async () => {
    expect(maskExternalApiToken("orchestra_ext_aaaa1111bbbb2222")).toBe(
      "orches****2222"
    );
  });

  it("never returns more than 6+4 visible chars from the original (audit-screenshot safety)", async () => {
    const tok = "orchestra_ext_" + "x".repeat(100);
    const masked = maskExternalApiToken(tok);
    // The mask itself contributes ****; visible original chars are head+tail.
    const visible = masked.replace(/\*+/g, "");
    expect(visible.length).toBe(10);
  });
});
