/**
 * Tests for POST /api/auth/logout — clears the orchestra_auth cookie.
 *
 * Why testing matters even for a 16-line route:
 *   - The route MUST set Max-Age=0 / equivalent so the browser actually
 *     drops the cookie. A regression that sets a future expiry instead
 *     leaves the user "logged in" until the actual session TTL.
 *   - The Secure flag must follow request scheme (HTTPS request gets
 *     Secure cookie, http://localhost dev does not). Otherwise dev mode
 *     breaks (browser refuses Secure cookies on http) or prod regresses
 *     (Secure missing, cookie sent over http on a misconfigured proxy).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

beforeEach(() => {
  vi.unstubAllEnvs();
});

function buildRequest(opts: {
  url?: string;
  forwardedProto?: string;
} = {}): NextRequest {
  const headers = new Headers();
  if (opts.forwardedProto) headers.set("x-forwarded-proto", opts.forwardedProto);
  return new NextRequest(opts.url ?? "http://localhost:3000/api/auth/logout", {
    method: "POST",
    headers,
  });
}

describe("POST /api/auth/logout", () => {
  it("returns 200 + success=true", async () => {
    const res = await POST(buildRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it("sets the orchestra_auth cookie with Max-Age=0 (clears it)", async () => {
    const res = await POST(buildRequest());
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/orchestra_auth=/);
    expect(cookie).toMatch(/Max-Age=0/);
  });

  it("sets HttpOnly + Path=/ + SameSite=Lax for the cleared cookie", async () => {
    const res = await POST(buildRequest());
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it("does NOT mark the cookie Secure on http://localhost (dev mode)", async () => {
    const res = await POST(buildRequest({ url: "http://localhost:3000/api/auth/logout" }));
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).not.toMatch(/Secure/);
  });

  it("DOES mark the cookie Secure when behind https proxy (x-forwarded-proto=https)", async () => {
    const res = await POST(
      buildRequest({
        url: "http://localhost:3000/api/auth/logout",
        forwardedProto: "https",
      })
    );
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/Secure/);
  });

  it("respects ORCHESTRA_AUTH_COOKIE_SECURE env override", async () => {
    vi.stubEnv("ORCHESTRA_AUTH_COOKIE_SECURE", "1");
    const res = await POST(buildRequest({ url: "http://localhost:3000/api/auth/logout" }));
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/Secure/);
  });
});
