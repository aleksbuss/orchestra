/**
 * Route-level tests for POST /api/auth/login.
 *
 * This is the first route-level test in the codebase. The audit found 40
 * route.ts files with ZERO route-level coverage, including the auth surface
 * itself. This file establishes the pattern: mock the storage layer + the
 * rate limiter, construct a real NextRequest, call the exported POST handler
 * directly, assert response status + body shape.
 *
 * Critical regression tracked here:
 *   - Response body must NEVER contain the stored passwordHash (or any
 *     scrypt$ envelope). The on-disk hash is offline-bruteforce material;
 *     leaking it through any error message, validation echo, or success
 *     response would be a CVE-class bug.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  DEFAULT_AUTH_PASSWORD_HASH,
  DEFAULT_AUTH_USERNAME,
  hashPassword,
} from "@/lib/auth/password";

// We mock the settings store so each test can dictate the persisted auth
// state. The real fs-backed implementation is exercised by integration tests.
vi.mock("@/lib/storage/settings-store", () => ({
  getSettings: vi.fn(),
}));

// Rate limiter is mocked so the 429 path is testable without burning real
// time + so the other tests run in a deterministic "always allowed" state.
vi.mock("@/lib/auth/rate-limit", () => ({
  clientIpFromRequest: vi.fn(() => "1.2.3.4"),
  shouldAllowLoginAttempt: vi.fn(() => ({ allowed: true })),
  recordLoginOutcome: vi.fn(),
}));

// Real scrypt (N=2^17) costs ~0.6–2s per call; this route's tests exercise
// ROUTING, not the KDF (password.test.ts owns the real KDF round-trip). Replace
// only the two expensive functions with deterministic fast stubs — keeping the
// real constants (DEFAULT_AUTH_*) and the verify behavior the route depends on.
// Fixes the F-01a timeout flake: the 5-iteration escape-hatch test below ran
// five real verifies and intermittently blew the timeout under parallel load.
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

import { POST } from "./route";
import { getSettings } from "@/lib/storage/settings-store";
import {
  shouldAllowLoginAttempt,
  recordLoginOutcome,
} from "@/lib/auth/rate-limit";

function buildRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function defaultSettingsWithAuth(overrides: Partial<{
  username: string;
  passwordHash: string;
  enabled: boolean;
  mustChangeCredentials: boolean;
}> = {}) {
  return {
    auth: {
      enabled: true,
      username: DEFAULT_AUTH_USERNAME,
      passwordHash: DEFAULT_AUTH_PASSWORD_HASH,
      mustChangeCredentials: true,
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(shouldAllowLoginAttempt).mockReturnValue({ allowed: true });
  // Tests that need a session secret rely on the dev fallback. Force a known
  // dev environment so we don't trip PM #12 production guard.
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv(
    "ORCHESTRA_AUTH_SECRET",
    "test-only-secret-not-for-production-use-please"
  );
});

describe("POST /api/auth/login — happy path", () => {
  it("returns 200 + sets auth cookie for default admin/admin", async () => {
    vi.mocked(getSettings).mockResolvedValue(defaultSettingsWithAuth() as any);

    const res = await POST(buildRequest({ username: "admin", password: "admin" }));
    expect(res.status).toBe(200);

    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/orchestra_auth=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\//);
  });

  it("body announces mustChangeCredentials=true on the shipped default hash", async () => {
    vi.mocked(getSettings).mockResolvedValue(defaultSettingsWithAuth() as any);

    const res = await POST(buildRequest({ username: "admin", password: "admin" }));
    const body = (await res.json()) as { success: boolean; mustChangeCredentials: boolean };
    expect(body.success).toBe(true);
    expect(body.mustChangeCredentials).toBe(true);
  });

  it("body announces mustChangeCredentials=false once credentials have been customized", async () => {
    const customHash = hashPassword("a-real-password-09sdf9");
    vi.mocked(getSettings).mockResolvedValue(
      defaultSettingsWithAuth({ username: "aleks", passwordHash: customHash }) as any
    );

    const res = await POST(buildRequest({ username: "aleks", password: "a-real-password-09sdf9" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mustChangeCredentials: boolean };
    expect(body.mustChangeCredentials).toBe(false);
  });

  it("records the success outcome for the rate limiter", async () => {
    vi.mocked(getSettings).mockResolvedValue(defaultSettingsWithAuth() as any);
    await POST(buildRequest({ username: "admin", password: "admin" }));
    expect(recordLoginOutcome).toHaveBeenCalledWith("1.2.3.4", "success");
  });
});

describe("POST /api/auth/login — failure paths", () => {
  it("returns 401 on wrong password and records a failure", async () => {
    vi.mocked(getSettings).mockResolvedValue(defaultSettingsWithAuth() as any);

    const res = await POST(buildRequest({ username: "admin", password: "WRONG" }));
    expect(res.status).toBe(401);

    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/invalid/i);
    expect(recordLoginOutcome).toHaveBeenCalledWith("1.2.3.4", "failure");
  });

  it("returns 401 on wrong username with a generic error (no user-enumeration leak)", async () => {
    vi.mocked(getSettings).mockResolvedValue(defaultSettingsWithAuth() as any);

    const res = await POST(buildRequest({ username: "nope", password: "admin" }));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    // Same generic "Invalid credentials" message as wrong-password — operators
    // should not be able to distinguish "user exists but wrong password" from
    // "user does not exist." This protects against username enumeration.
    expect(body.error).toMatch(/invalid credentials/i);
  });

  it("returns 400 on missing username/password without burning a rate-limit slot", async () => {
    vi.mocked(getSettings).mockResolvedValue(defaultSettingsWithAuth() as any);

    const res1 = await POST(buildRequest({ password: "admin" }));
    expect(res1.status).toBe(400);
    const res2 = await POST(buildRequest({ username: "admin" }));
    expect(res2.status).toBe(400);
    const res3 = await POST(buildRequest({ username: "  ", password: "  " }));
    expect(res3.status).toBe(400);

    // Bad-request paths must NOT count toward bruteforce budget — otherwise
    // a misbehaving frontend could lock its own user out by sending blanks.
    expect(recordLoginOutcome).not.toHaveBeenCalled();
  });

  it("returns 403 when authentication is disabled in settings", async () => {
    vi.mocked(getSettings).mockResolvedValue(
      defaultSettingsWithAuth({ enabled: false }) as any
    );

    const res = await POST(buildRequest({ username: "admin", password: "admin" }));
    expect(res.status).toBe(403);
  });

  it("returns 429 + Retry-After when the rate limiter denies", async () => {
    vi.mocked(shouldAllowLoginAttempt).mockReturnValue({
      allowed: false,
      retryAfterSeconds: 42,
    });
    vi.mocked(getSettings).mockResolvedValue(defaultSettingsWithAuth() as any);

    const res = await POST(buildRequest({ username: "admin", password: "admin" }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");

    // Locked path must short-circuit BEFORE consulting settings — the cost of
    // the scrypt verify is what we're protecting against.
    expect(getSettings).not.toHaveBeenCalled();
  });
});

describe("POST /api/auth/login — passwordHash leak regression", () => {
  // The on-disk hash is offline-bruteforce material. No code path through the
  // login route should ever surface it back to the client — not in a success
  // body, not in an error message, not in a validation echo. These tests
  // would have caught the kind of leak the audit found in /login HTML.

  async function bodyFor(status: "ok" | "wrong-pw" | "bad-req" | "rate-limited"): Promise<string> {
    vi.mocked(getSettings).mockResolvedValue(defaultSettingsWithAuth() as any);
    if (status === "rate-limited") {
      vi.mocked(shouldAllowLoginAttempt).mockReturnValue({
        allowed: false,
        retryAfterSeconds: 30,
      });
    }
    const req =
      status === "bad-req"
        ? buildRequest({})
        : status === "wrong-pw"
        ? buildRequest({ username: "admin", password: "WRONG" })
        : buildRequest({ username: "admin", password: "admin" });

    const res = await POST(req);
    return await res.text();
  }

  for (const path of ["ok", "wrong-pw", "bad-req", "rate-limited"] as const) {
    it(`response body for "${path}" path does not contain the stored password hash`, async () => {
      const body = await bodyFor(path);
      expect(body).not.toContain(DEFAULT_AUTH_PASSWORD_HASH);
      expect(body).not.toMatch(/scrypt\$[^"]+\$[^"]+/);
      expect(body).not.toMatch(/passwordHash/i);
    });
  }
});

describe("POST /api/auth/login — ORCHESTRA_DISABLE_AUTH escape hatch", () => {
  // When auth is fully disabled via env, middleware never sends users here,
  // but a programmatic POST should still resolve cleanly. The endpoint must
  // NOT consult the rate limiter or the settings store — both are bypassed.

  it("returns success without checking credentials when auth is disabled", async () => {
    vi.stubEnv("ORCHESTRA_DISABLE_AUTH", "true");
    const res = await POST(buildRequest({ username: "anyone", password: "anything" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.mustChangeCredentials).toBe(false);
    // Neither rate limiter nor settings store should have been touched.
    expect(vi.mocked(shouldAllowLoginAttempt)).not.toHaveBeenCalled();
    expect(vi.mocked(getSettings)).not.toHaveBeenCalled();
    expect(vi.mocked(recordLoginOutcome)).not.toHaveBeenCalled();
  });

  it("returns success even with empty credentials when auth is disabled", async () => {
    // Edge case: stray client posts {} — should still resolve, not 400.
    vi.stubEnv("ORCHESTRA_DISABLE_AUTH", "true");
    const res = await POST(buildRequest({}));
    expect(res.status).toBe(200);
  });

  it("only activates when value is exactly 'true' — falsy strings remain protected", async () => {
    for (const value of ["1", "yes", "TRUE", "", "false"]) {
      vi.stubEnv("ORCHESTRA_DISABLE_AUTH", value);
      vi.mocked(getSettings).mockResolvedValue(defaultSettingsWithAuth() as never);
      const res = await POST(buildRequest({ username: "x", password: "y" }));
      // Should reach the real verifier and fail (wrong password), not bypass.
      expect(res.status).toBe(401);
    }
  });
});
