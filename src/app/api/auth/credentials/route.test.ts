/**
 * Tests for PUT /api/auth/credentials — sets username + password.
 *
 * Pinned invariants:
 *   - 401 when not authenticated. Unauthenticated users MUST NOT change
 *     credentials (otherwise the onboarding flow becomes a takeover).
 *   - Username validation: 3-64 chars, [a-zA-Z0-9._-]. Rejecting other
 *     chars defends file-system stores that may key by username later.
 *   - Password validation: 8-128 chars.
 *   - On success: persists hashed password, mints a fresh session token
 *     with mustChangeCredentials=false, sets cookie.
 *   - The PERSISTED password is hashed (scrypt envelope), not plaintext.
 *   - The RESPONSE body never echoes the password or its hash.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/storage/settings-store", () => ({
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
}));

vi.mock("@/lib/auth/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/session")>(
    "@/lib/auth/session"
  );
  return {
    ...actual,
    verifySessionToken: vi.fn(),
  };
});

// Real scrypt (N=2^17) costs ~0.6–2s per call; this route's tests exercise
// ROUTING + validation, not the KDF. Stub just the two expensive functions —
// the `scrypt$teststub$…` envelope still satisfies the "persisted password is a
// scrypt envelope, not plaintext" assertion. Fixes the F-01a timeout flake (the
// username-charset loop hashed a new password per iteration).
vi.mock("@/lib/auth/password", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/password")>();
  const fakeHash = (pw: string) =>
    `scrypt$teststub$${Buffer.from(String(pw)).toString("base64url")}`;
  return {
    ...actual,
    hashPassword: (pw: string) => fakeHash(pw),
    verifyPassword: (pw: string, storedHash: string) =>
      storedHash === actual.DEFAULT_AUTH_PASSWORD_HASH
        ? String(pw) === "admin"
        : storedHash === fakeHash(pw),
  };
});

import { PUT } from "./route";
import {
  getSettings,
  saveSettings,
} from "@/lib/storage/settings-store";
import { AUTH_COOKIE_NAME, verifySessionToken } from "@/lib/auth/session";
import {
  DEFAULT_AUTH_PASSWORD_HASH,
  DEFAULT_AUTH_USERNAME,
} from "@/lib/auth/password";

const mockedSettings = vi.mocked(getSettings);
const mockedSave = vi.mocked(saveSettings);
const mockedVerify = vi.mocked(verifySessionToken);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv(
    "ORCHESTRA_AUTH_SECRET",
    "test-only-secret-not-for-production-use-please"
  );
  mockedSettings.mockResolvedValue({
    auth: {
      enabled: true,
      username: DEFAULT_AUTH_USERNAME,
      passwordHash: DEFAULT_AUTH_PASSWORD_HASH,
      mustChangeCredentials: true,
    },
  } as any);
  mockedSave.mockResolvedValue(undefined as any);
});

function buildRequest(opts: {
  cookie?: string;
  body?: unknown;
}): NextRequest {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (opts.cookie) headers.set("cookie", `${AUTH_COOKIE_NAME}=${opts.cookie}`);
  return new NextRequest("http://localhost:3000/api/auth/credentials", {
    method: "PUT",
    headers,
    body: JSON.stringify(opts.body ?? {}),
  });
}

describe("PUT /api/auth/credentials — auth gate", () => {
  it("returns 401 when no session cookie present", async () => {
    mockedVerify.mockResolvedValue(null);
    const res = await PUT(
      buildRequest({ body: { username: "buss", password: "longenough" } })
    );
    expect(res.status).toBe(401);
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it("returns 401 when token doesn't verify", async () => {
    mockedVerify.mockResolvedValue(null);
    const res = await PUT(
      buildRequest({
        cookie: "forged.token",
        body: { username: "buss", password: "longenough" },
      })
    );
    expect(res.status).toBe(401);
  });
});

describe("PUT /api/auth/credentials — input validation", () => {
  beforeEach(() => {
    mockedVerify.mockResolvedValue({
      username: "admin",
      issuedAt: 1,
      expiresAt: 9999999999,
      mustChangeCredentials: true,
    });
  });

  it("rejects username < 3 chars", async () => {
    const res = await PUT(
      buildRequest({
        cookie: "ok.token",
        body: { username: "ab", password: "longenough" },
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/at least 3 characters/i);
  });

  it("rejects username > 64 chars", async () => {
    const res = await PUT(
      buildRequest({
        cookie: "ok.token",
        body: { username: "x".repeat(65), password: "longenough" },
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/at most 64/i);
  });

  it("rejects username with disallowed characters", async () => {
    const cases = ["bad space", "bad/slash", "bad@host", "bad!", "bad$"];
    for (const u of cases) {
      const res = await PUT(
        buildRequest({
          cookie: "ok.token",
          body: { username: u, password: "longenough" },
        })
      );
      expect(res.status, `username=${u}`).toBe(400);
    }
  });

  it("accepts allowed username characters: letters, digits, dot, underscore, hyphen", async () => {
    for (const u of ["good", "user.name", "user_name", "user-name", "abc123"]) {
      const res = await PUT(
        buildRequest({
          cookie: "ok.token",
          body: { username: u, password: "longenough" },
        })
      );
      expect(res.status, `username=${u}`).toBe(200);
    }
  });

  it("rejects password < 8 chars", async () => {
    const res = await PUT(
      buildRequest({
        cookie: "ok.token",
        body: { username: "buss", password: "short" },
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/at least 8/i);
  });

  it("rejects password > 128 chars", async () => {
    const res = await PUT(
      buildRequest({
        cookie: "ok.token",
        body: { username: "buss", password: "x".repeat(129) },
      })
    );
    expect(res.status).toBe(400);
  });

  it("trims whitespace before validating (so '  ab  ' is treated as 'ab' = too short)", async () => {
    const res = await PUT(
      buildRequest({
        cookie: "ok.token",
        body: { username: "  ab  ", password: "longenough" },
      })
    );
    expect(res.status).toBe(400);
  });
});

describe("PUT /api/auth/credentials — happy path", () => {
  beforeEach(() => {
    mockedVerify.mockResolvedValue({
      username: "admin",
      issuedAt: 1,
      expiresAt: 9999999999,
      mustChangeCredentials: true,
    });
  });

  it("returns 200 + sets a fresh session cookie", async () => {
    const res = await PUT(
      buildRequest({
        cookie: "ok.token",
        body: { username: "buss", password: "newGoodPassword" },
      })
    );
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/orchestra_auth=/);
    expect(setCookie).toMatch(/HttpOnly/i);
  });

  it("persists username + scrypt-hashed password (NEVER plaintext)", async () => {
    await PUT(
      buildRequest({
        cookie: "ok.token",
        body: { username: "buss", password: "newGoodPassword" },
      })
    );
    expect(mockedSave).toHaveBeenCalledOnce();
    const saved = mockedSave.mock.calls[0][0] as { auth: { username: string; passwordHash: string; mustChangeCredentials: boolean } };
    expect(saved.auth.username).toBe("buss");
    // Hash envelope, NOT the plaintext.
    expect(saved.auth.passwordHash).toMatch(/^scrypt\$/);
    expect(saved.auth.passwordHash).not.toBe("newGoodPassword");
    expect(saved.auth.mustChangeCredentials).toBe(false);
  });

  it("response body never echoes the password or its hash", async () => {
    const res = await PUT(
      buildRequest({
        cookie: "ok.token",
        body: { username: "buss", password: "leaky-password-test" },
      })
    );
    const text = await res.text();
    expect(text).not.toContain("leaky-password-test");
    expect(text).not.toMatch(/passwordHash/i);
    expect(text).not.toContain("scrypt$");
  });

  it("response signals mustChangeCredentials=false (onboarding completed)", async () => {
    const res = await PUT(
      buildRequest({
        cookie: "ok.token",
        body: { username: "buss", password: "newGoodPassword" },
      })
    );
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.username).toBe("buss");
    expect(body.mustChangeCredentials).toBe(false);
  });
});
