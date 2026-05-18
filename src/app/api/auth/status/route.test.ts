/**
 * Tests for GET /api/auth/status — public route, the SPA shell calls it
 * to decide whether to render logged-in or logged-out chrome.
 *
 * Pinned invariants:
 *   - 401 + cleared cookie when no/invalid token (so the shell can react
 *     without keeping a stale forge cookie around).
 *   - 200 with username + mustChangeCredentials when authenticated.
 *   - mustChangeCredentials is OR-derived: session.mustChangeCredentials
 *     OR isDefaultAuthCredentials(settings) — covers the case where the
 *     user's session was minted before the operator reset to defaults.
 *   - The route NEVER surfaces the password hash (PM #15 class).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/storage/settings-store", () => ({
  getSettings: vi.fn(),
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

import { GET } from "./route";
import { getSettings } from "@/lib/storage/settings-store";
import {
  AUTH_COOKIE_NAME,
  verifySessionToken,
  createSessionToken,
} from "@/lib/auth/session";
import {
  DEFAULT_AUTH_PASSWORD_HASH,
  DEFAULT_AUTH_USERNAME,
  hashPassword,
} from "@/lib/auth/password";

const mockedGetSettings = vi.mocked(getSettings);
const mockedVerify = vi.mocked(verifySessionToken);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv(
    "ORCHESTRA_AUTH_SECRET",
    "test-only-secret-not-for-production-use-please"
  );
});

function buildRequest(opts: { cookie?: string } = {}): NextRequest {
  const headers = new Headers();
  if (opts.cookie) headers.set("cookie", `${AUTH_COOKIE_NAME}=${opts.cookie}`);
  return new NextRequest("http://localhost:3000/api/auth/status", {
    method: "GET",
    headers,
  });
}

const settingsWith = (overrides: {
  username?: string;
  passwordHash?: string;
  mustChange?: boolean;
}) => ({
  auth: {
    enabled: true,
    username: overrides.username ?? DEFAULT_AUTH_USERNAME,
    passwordHash: overrides.passwordHash ?? DEFAULT_AUTH_PASSWORD_HASH,
    mustChangeCredentials: overrides.mustChange ?? false,
  },
});

describe("GET /api/auth/status — unauthenticated", () => {
  it("returns 401 + authenticated:false when no cookie present", async () => {
    mockedVerify.mockResolvedValue(null);
    const res = await GET(buildRequest());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.authenticated).toBe(false);
    expect(body.username).toBeNull();
  });

  it("returns 401 + clears the cookie when the token is forged/expired", async () => {
    mockedVerify.mockResolvedValue(null);
    const res = await GET(buildRequest({ cookie: "forged.token.value" }));
    expect(res.status).toBe(401);
    // Forged cookie present → response should clear it (Max-Age=0)
    // so the browser doesn't keep sending it.
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/orchestra_auth=/);
    expect(setCookie).toMatch(/Max-Age=0/);
  });
});

describe("GET /api/auth/status — authenticated", () => {
  it("returns 200 with username when session is valid", async () => {
    mockedVerify.mockResolvedValue({
      username: "buss",
      issuedAt: 1,
      expiresAt: 9999999999,
      mustChangeCredentials: false,
    });
    mockedGetSettings.mockResolvedValue(
      settingsWith({ username: "buss", passwordHash: hashPassword("real-password") }) as any
    );

    const res = await GET(buildRequest({ cookie: "ok.token" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authenticated).toBe(true);
    expect(body.username).toBe("buss");
  });

  it("mustChangeCredentials=true when settings are still on the shipped default hash", async () => {
    mockedVerify.mockResolvedValue({
      username: "admin",
      issuedAt: 1,
      expiresAt: 9999999999,
      mustChangeCredentials: false, // session mints with false
    });
    mockedGetSettings.mockResolvedValue(settingsWith({}) as any); // defaults

    const res = await GET(buildRequest({ cookie: "ok.token" }));
    const body = await res.json();
    expect(body.mustChangeCredentials).toBe(true);
  });

  it("mustChangeCredentials sticks to true if session carries the flag (even after settings updated)", async () => {
    mockedVerify.mockResolvedValue({
      username: "buss",
      issuedAt: 1,
      expiresAt: 9999999999,
      mustChangeCredentials: true,
    });
    mockedGetSettings.mockResolvedValue(
      settingsWith({ username: "buss", passwordHash: hashPassword("real-password") }) as any
    );

    const res = await GET(buildRequest({ cookie: "ok.token" }));
    const body = await res.json();
    expect(body.mustChangeCredentials).toBe(true);
  });
});

describe("GET /api/auth/status — passwordHash leak regression (PM #15 class)", () => {
  // The route must never include the stored hash in any response shape.
  for (const auth of [false, true] as const) {
    it(`response body never contains the scrypt envelope (authenticated=${auth})`, async () => {
      if (auth) {
        mockedVerify.mockResolvedValue({
          username: "admin",
          issuedAt: 1,
          expiresAt: 9999999999,
          mustChangeCredentials: false,
        });
      } else {
        mockedVerify.mockResolvedValue(null);
      }
      mockedGetSettings.mockResolvedValue(settingsWith({}) as any);

      const res = await GET(buildRequest({ cookie: auth ? "ok.token" : undefined }));
      const text = await res.text();
      expect(text).not.toContain("scrypt$");
      expect(text).not.toMatch(/passwordHash/i);
    });
  }
});
