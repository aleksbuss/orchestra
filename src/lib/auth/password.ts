import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT_KEY_LEN = 64;
// scrypt cost parameters (2026 recommended: N=2^17)
// Memory required: 128 * N * r bytes = 128 * 131072 * 8 = 128MB
const SCRYPT_N = 131072;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 256 * 1024 * 1024; // 256MB — safe headroom

const DEFAULT_SALT = "XLqs3H3hyIdkLImyxg8Trg";
// Pre-computed with N=131072, r=8, p=1 (new strong params)
const DEFAULT_HASH =
  "zJz4yn41_fzKQJG6bFe9fLoKY6djdHDWIVIuYDKr0gX_Neo4LQ3wj6eJt3cKjvfxKyd6mek39RvSlpf7n-qGkA";

export const DEFAULT_AUTH_USERNAME = "admin";
export const DEFAULT_AUTH_PASSWORD = "admin";
export const DEFAULT_AUTH_PASSWORD_HASH = `scrypt$${DEFAULT_SALT}$${DEFAULT_HASH}`;

export function isDefaultAuthCredentials(
  username: string,
  passwordHash: string
): boolean {
  return (
    username.trim() === DEFAULT_AUTH_USERNAME &&
    passwordHash.trim() === DEFAULT_AUTH_PASSWORD_HASH
  );
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(input: string): Uint8Array | null {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Hash a password using scrypt with modern cost parameters (N=131072).
 */
export function hashPassword(password: string): string {
  const trimmed = password.trim();
  if (!trimmed) {
    throw new Error("Password is required");
  }
  const salt = encodeBase64Url(randomBytes(16));
  // Modern parameters for 2026: N=2^17, r=8, p=1
  const derived = scryptSync(trimmed, salt, SCRYPT_KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$${salt}$${encodeBase64Url(derived)}`;
}

/**
 * Verify a password against a stored hash.
 * Supports both new high-cost and legacy low-cost hashes by attempting both if needed,
 * though bumping the global cost is the primary goal.
 */
export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") {
    return false;
  }

  const salt = parts[1];
  const expected = decodeBase64Url(parts[2]);
  if (!expected) {
    return false;
  }

  try {
    // 1. Try with modern parameters first (covers all new hashes AND the new DEFAULT_AUTH_PASSWORD_HASH)
    const actualHigh = scryptSync(password, salt, expected.length, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAXMEM,
    });
    if (timingSafeEqual(actualHigh, expected)) {
      return true;
    }

    // 2. Fallback to legacy Node.js default parameters (N=16384) for hashes created before this update
    const actualLegacy = scryptSync(password, salt, expected.length, {
      N: 16384,
      r: 8,
      p: 1,
    });
    return timingSafeEqual(actualLegacy, expected);
  } catch {
    return false;
  }
}
