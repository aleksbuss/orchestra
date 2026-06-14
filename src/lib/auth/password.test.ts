/**
 * Tests for the scrypt-based password hash + verify primitive.
 *
 * Why this file exists: `password.ts` is the smallest piece of code with the
 * highest blast radius — a regression here locks every operator out of every
 * Orchestra deployment in the wild, including the user's own. It was also,
 * historically, the file under-tested: only the session-secret guard (PM #12)
 * had coverage. This file fixes that gap before it bites.
 *
 * What we lock down:
 *   - the canonical "scrypt$<salt>$<hash>" format
 *   - hash() → verify() roundtrip on a few realistic passwords
 *   - the **shipped DEFAULT_AUTH_PASSWORD_HASH must verify against "admin"**
 *     (this is the contract the README/UI promises new operators)
 *   - legacy fallback works for hashes minted under the old N=16384 cost
 *   - whitespace trimming behavior matches what login & credentials routes do
 *   - malformed input never throws (returns false)
 *   - isDefaultAuthCredentials only fires on the EXACT default pair
 */
import { describe, it, expect, vi } from "vitest";
import { scryptSync } from "node:crypto";

// password.ts is the real scrypt KDF (N=2^17 ≈ 0.6–2s per hash/verify). Tests
// that do multiple ops (hash+verify roundtrips, the case-sensitivity check) can
// approach the global 15s timeout under parallel CI load. This file legitimately
// CANNOT mock the KDF — it IS the unit under test — so give it headroom (F-01a
// sibling; the route tests mock the KDF instead, since they only test routing).
vi.setConfig({ testTimeout: 30000 });
import {
  DEFAULT_AUTH_PASSWORD,
  DEFAULT_AUTH_PASSWORD_HASH,
  DEFAULT_AUTH_USERNAME,
  hashPassword,
  isDefaultAuthCredentials,
  verifyPassword,
} from "./password";

function encodeBase64Url(bytes: Buffer | Uint8Array): string {
  const buf = Buffer.from(bytes);
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

describe("hashPassword", () => {
  it("returns the canonical scrypt$<salt>$<hash> envelope", () => {
    const out = hashPassword("hunter2hunter");
    const parts = out.split("$");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("scrypt");
    expect(parts[1].length).toBeGreaterThan(0);
    expect(parts[2].length).toBeGreaterThan(0);
  });

  it("produces a different hash on every call (random salt)", () => {
    const a = hashPassword("samepassword");
    const b = hashPassword("samepassword");
    expect(a).not.toBe(b);
  });

  it("rejects empty / whitespace-only password", () => {
    expect(() => hashPassword("")).toThrow(/required/i);
    expect(() => hashPassword("   ")).toThrow(/required/i);
  });

  it("trims surrounding whitespace before hashing", () => {
    // Both routes (.trim()) call this with already-trimmed input, but the
    // primitive itself trims defensively. Verify the contract: padded input
    // produces a hash that the trimmed plaintext can verify against.
    const padded = "   secret-pw-1   ";
    const stored = hashPassword(padded);
    expect(verifyPassword("secret-pw-1", stored)).toBe(true);
  });
});

describe("verifyPassword", () => {
  it("returns true for the password used to create the hash", () => {
    const stored = hashPassword("p@ssw0rd-quite-long");
    expect(verifyPassword("p@ssw0rd-quite-long", stored)).toBe(true);
  });

  it("returns false for the wrong password", () => {
    const stored = hashPassword("right-one");
    expect(verifyPassword("wrong-one", stored)).toBe(false);
  });

  it("is case-sensitive on the password", () => {
    const stored = hashPassword("CaseMatters");
    expect(verifyPassword("casematters", stored)).toBe(false);
    expect(verifyPassword("CASEMATTERS", stored)).toBe(false);
    expect(verifyPassword("CaseMatters", stored)).toBe(true);
  });

  it("returns false on malformed envelope (no scrypt$ prefix)", () => {
    expect(verifyPassword("anything", "garbage")).toBe(false);
    expect(verifyPassword("anything", "bcrypt$abc$def")).toBe(false);
    expect(verifyPassword("anything", "scrypt$only-two-parts")).toBe(false);
    expect(verifyPassword("anything", "")).toBe(false);
  });

  it("returns false (does NOT throw) on un-decodable base64 hash segment", () => {
    expect(verifyPassword("anything", "scrypt$saltsalt$!!!not-base64!!!")).toBe(false);
  });

  it("verifies legacy hashes minted under N=16384 (pre-2026 cost params)", () => {
    // Simulate a hash created BEFORE the cost bump. verify() must still pass
    // for these — operators who installed Orchestra months ago should not be
    // locked out by an upgrade.
    const password = "legacy-user-password";
    const salt = "legacy-salt-fixed-1";
    const legacyHashBytes = scryptSync(password, salt, 64, {
      N: 16384,
      r: 8,
      p: 1,
    });
    const legacyEnvelope = `scrypt$${salt}$${encodeBase64Url(legacyHashBytes)}`;

    expect(verifyPassword(password, legacyEnvelope)).toBe(true);
    expect(verifyPassword("not-the-password", legacyEnvelope)).toBe(false);
  });
});

describe("DEFAULT_AUTH_PASSWORD_HASH — the shipped 'admin/admin' contract", () => {
  it("verifies against the shipped default password 'admin'", () => {
    // This is the contract every fresh-install README promises and the login
    // page hints at. If this assertion ever fails, fresh installs cannot log
    // in — a P0 onboarding break.
    expect(verifyPassword(DEFAULT_AUTH_PASSWORD, DEFAULT_AUTH_PASSWORD_HASH)).toBe(true);
  });

  it("rejects the wrong password against the shipped default hash", () => {
    expect(verifyPassword("notadmin", DEFAULT_AUTH_PASSWORD_HASH)).toBe(false);
    expect(verifyPassword("Admin", DEFAULT_AUTH_PASSWORD_HASH)).toBe(false);
    expect(verifyPassword("admin ", DEFAULT_AUTH_PASSWORD_HASH)).toBe(false);
  });
});

describe("isDefaultAuthCredentials", () => {
  it("returns true for the exact default username + default hash pair", () => {
    expect(
      isDefaultAuthCredentials(DEFAULT_AUTH_USERNAME, DEFAULT_AUTH_PASSWORD_HASH)
    ).toBe(true);
  });

  it("returns true even when caller passes whitespace-padded values", () => {
    expect(
      isDefaultAuthCredentials(
        `  ${DEFAULT_AUTH_USERNAME}  `,
        `  ${DEFAULT_AUTH_PASSWORD_HASH}  `
      )
    ).toBe(true);
  });

  it("returns false when the username has been changed", () => {
    expect(isDefaultAuthCredentials("aleks", DEFAULT_AUTH_PASSWORD_HASH)).toBe(false);
  });

  it("returns false when the password has been changed (any other hash)", () => {
    const newHash = hashPassword("a-real-new-password");
    expect(isDefaultAuthCredentials(DEFAULT_AUTH_USERNAME, newHash)).toBe(false);
  });

  it("does NOT trigger the onboarding flow when a user happens to pick 'admin' literally", () => {
    // Important: isDefaultAuthCredentials gates the "you must change your
    // credentials" onboarding redirect. We ONLY want to trigger it when the
    // user is still on the literal shipped hash, NOT when they typed
    // "admin" themselves and got a random salt. Otherwise the onboarding
    // flow loops or surfaces incorrectly.
    const userChoseAdmin = hashPassword("admin");
    expect(isDefaultAuthCredentials(DEFAULT_AUTH_USERNAME, userChoseAdmin)).toBe(false);
  });
});
