/**
 * Behavioral tests for the auth middleware.
 *
 * `middleware.location.test.ts` already guards file location (PM #14). This
 * file covers the actual gating logic — what happens for which path with
 * which session — because that logic was previously untested. A bug in any
 * of these branches lets unauthenticated traffic reach internal routes; the
 * audit flagged it as a top-priority gap.
 *
 * Branches under test:
 *   1. static + dotted bypasses (NEVER 401, NEVER redirect)
 *   2. public API allowlist (login, logout, status, health, external/message,
 *      and POST /integrations/telegram only)
 *   3. /login special-cases: anonymous → 200, authenticated → /dashboard,
 *      authenticated+mustChange → onboarding redirect
 *   4. anonymous + protected page → /login?next=…
 *   5. anonymous + protected API → 401 JSON (NOT redirect — would break fetch)
 *   6. authenticated + mustChangeCredentials gated to /dashboard/projects?credentials=1
 *   7. "/" → /dashboard for authenticated users
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { AUTH_COOKIE_NAME, createSessionToken } from "@/lib/auth/session";
import { middleware } from "./middleware";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv(
    "ORCHESTRA_AUTH_SECRET",
    "test-only-secret-not-for-production-use-please"
  );
});

function makeRequest(
  pathname: string,
  opts: { cookie?: string; method?: string; search?: string } = {}
): NextRequest {
  const url = `http://localhost:3000${pathname}${opts.search ?? ""}`;
  const headers = new Headers();
  if (opts.cookie) {
    headers.set("cookie", `${AUTH_COOKIE_NAME}=${opts.cookie}`);
  }
  return new NextRequest(url, {
    method: opts.method ?? "GET",
    headers,
  });
}

async function tokenFor(opts: { mustChange?: boolean } = {}): Promise<string> {
  return createSessionToken("admin", opts.mustChange ?? false);
}

describe("middleware — bypass list", () => {
  it("lets static asset paths through without inspecting the cookie", async () => {
    for (const path of [
      "/_next/static/chunks/main.js",
      "/_next/image/whatever.png",
      "/favicon.ico",
      "/robots.txt",
      "/sitemap.xml",
      "/some-file.css",
      "/some-script.js",
      "/photo.png",
    ]) {
      const res = await middleware(makeRequest(path));
      expect(res.status, `bypass for ${path}`).toBe(200);
    }
  });
});

describe("middleware — public API allowlist", () => {
  it("lets login/logout/status/health/external-message through unauthenticated", async () => {
    for (const path of [
      "/api/health",
      "/api/auth/login",
      "/api/auth/logout",
      "/api/auth/status",
      "/api/external/message",
    ]) {
      const res = await middleware(makeRequest(path));
      expect(res.status, `public API ${path}`).toBe(200);
    }
  });

  it("lets POST /api/integrations/telegram through, but NOT GET", async () => {
    const post = await middleware(makeRequest("/api/integrations/telegram", { method: "POST" }));
    expect(post.status).toBe(200);

    const get = await middleware(makeRequest("/api/integrations/telegram", { method: "GET" }));
    expect(get.status).toBe(401);
  });
});

describe("middleware — protected resources without a session", () => {
  it("redirects unauthenticated page request to /login?next=...", async () => {
    const res = await middleware(makeRequest("/dashboard/settings"));
    expect(res.status).toBe(307);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/login");
    expect(location).toContain("next=");
    expect(decodeURIComponent(location)).toContain("/dashboard/settings");
  });

  it("returns 401 JSON for unauthenticated API request (no redirect — would break fetch)", async () => {
    const res = await middleware(makeRequest("/api/chat"));
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = await res.json();
    expect(body.error).toMatch(/unauthorized/i);
  });
});

describe("middleware — /login behavior with a session", () => {
  it("redirects already-logged-in users away from /login to /dashboard", async () => {
    const cookie = await tokenFor();
    const res = await middleware(makeRequest("/login", { cookie }));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/dashboard");
  });

  it("redirects mustChangeCredentials users from /login to onboarding flow", async () => {
    const cookie = await tokenFor({ mustChange: true });
    const res = await middleware(makeRequest("/login", { cookie }));
    expect(res.status).toBe(307);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/dashboard/projects");
    expect(location).toContain("onboarding=1");
    expect(location).toContain("credentials=1");
  });

  it("lets anonymous users see /login normally", async () => {
    const res = await middleware(makeRequest("/login"));
    expect(res.status).toBe(200);
  });
});

describe("middleware — mustChangeCredentials gating for authenticated users", () => {
  it("redirects everywhere-except-onboarding-target to onboarding", async () => {
    const cookie = await tokenFor({ mustChange: true });
    for (const path of [
      "/dashboard",
      "/dashboard/settings",
      "/dashboard/chat",
      "/dashboard/anything",
    ]) {
      const res = await middleware(makeRequest(path, { cookie }));
      expect(res.status, `mustChange gate on ${path}`).toBe(307);
      expect(res.headers.get("location")).toContain("credentials=1");
    }
  });

  it("ALLOWS /dashboard/projects?credentials=1 — the onboarding target itself", async () => {
    const cookie = await tokenFor({ mustChange: true });
    const res = await middleware(
      makeRequest("/dashboard/projects", {
        cookie,
        search: "?onboarding=1&credentials=1",
      })
    );
    expect(res.status).toBe(200);
  });

  it("blocks /dashboard/projects without credentials=1 — prevents an onboarding skip", async () => {
    const cookie = await tokenFor({ mustChange: true });
    const res = await middleware(makeRequest("/dashboard/projects", { cookie }));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("credentials=1");
  });

  it("returns 403 on /api/* when mustChangeCredentials — closes same-origin fetch under default creds", async () => {
    // Without this gate, a session minted by `npm run auth:reset` (admin/admin
    // + mustChangeCredentials: true) could hit every API endpoint until the
    // operator clicked through the dashboard onboarding flow. The dashboard
    // redirect alone is not enough — a same-origin fetch from any localhost
    // page bypasses the UI entirely.
    const cookie = await tokenFor({ mustChange: true });
    for (const path of [
      "/api/chat",
      "/api/projects",
      "/api/files",
      "/api/settings",
      "/api/events",
    ]) {
      const res = await middleware(makeRequest(path, { cookie, method: "POST" }));
      expect(res.status, `mustChange API gate on ${path}`).toBe(403);
      expect(res.headers.get("content-type")).toMatch(/application\/json/);
    }
  });

  it("ALLOWS /api/auth/credentials and /api/auth/logout under mustChangeCredentials — the recovery surface", async () => {
    const cookie = await tokenFor({ mustChange: true });
    // /api/auth/credentials must work so the user CAN actually change the
    // password; /api/auth/logout so the UI can offer an escape hatch.
    for (const path of ["/api/auth/credentials", "/api/auth/logout"]) {
      const res = await middleware(makeRequest(path, { cookie, method: "PUT" }));
      expect(res.status, `allowed under mustChange: ${path}`).not.toBe(403);
    }
  });
});

describe("middleware — root + invalid cookies", () => {
  it("redirects authenticated '/' to /dashboard", async () => {
    const cookie = await tokenFor();
    const res = await middleware(makeRequest("/", { cookie }));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/dashboard");
  });

  it("treats a forged/garbage cookie as no session — redirects to /login", async () => {
    const res = await middleware(
      makeRequest("/dashboard", { cookie: "totally.not.a.valid.token" })
    );
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("treats a token signed with a DIFFERENT secret as no session", async () => {
    // Mint a token under a different secret, then verify under the canonical
    // one. This is the cookie-replay-from-another-deployment threat.
    vi.stubEnv("ORCHESTRA_AUTH_SECRET", "OTHER-secret-xx-xx-xx");
    const foreign = await createSessionToken("admin", false);

    vi.stubEnv("ORCHESTRA_AUTH_SECRET", "test-only-secret-not-for-production-use-please");
    const res = await middleware(makeRequest("/dashboard", { cookie: foreign }));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });
});

describe("middleware — ORCHESTRA_DISABLE_AUTH escape hatch", () => {
  // When the env flag is set, every request must pass without inspecting the
  // cookie. This is the "local dev / forgot password recovery" path. It MUST
  // NOT silently re-enable itself based on cookie presence — a stale cookie
  // from a previous session is irrelevant when auth is off.

  it("lets an anonymous request through to a protected page (no redirect)", async () => {
    vi.stubEnv("ORCHESTRA_DISABLE_AUTH", "true");
    const res = await middleware(makeRequest("/dashboard/projects"));
    // 200-ish: NextResponse.next() does not set a redirect status.
    expect(res.status).not.toBe(307);
    expect(res.headers.get("location")).toBeNull();
  });

  it("lets an anonymous API request through without 401", async () => {
    vi.stubEnv("ORCHESTRA_DISABLE_AUTH", "true");
    const res = await middleware(makeRequest("/api/projects"));
    expect(res.status).not.toBe(401);
  });

  it("redirects /login → /dashboard when auth is disabled (no login form needed)", async () => {
    vi.stubEnv("ORCHESTRA_DISABLE_AUTH", "true");
    const res = await middleware(makeRequest("/login"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/dashboard");
  });

  it("redirects '/' → /dashboard when auth is disabled", async () => {
    vi.stubEnv("ORCHESTRA_DISABLE_AUTH", "true");
    const res = await middleware(makeRequest("/"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/dashboard");
  });

  it("only activates when value is exactly 'true' — '1', 'yes', '' are off", async () => {
    // Defensive: prevents accidental enablement from sloppy shell quoting.
    for (const value of ["1", "yes", "TRUE", "", "false"]) {
      vi.stubEnv("ORCHESTRA_DISABLE_AUTH", value);
      const res = await middleware(makeRequest("/dashboard"));
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toContain("/login");
    }
  });
});

describe("middleware — a dot in the path must NOT skip auth (2026-08-25 disclosure)", () => {
  /**
   * `shouldBypass` used to run its "looks like a static file" regex FIRST and
   * over the whole path, so any request whose last segment contained a dot
   * skipped every auth check. Reproduced end-to-end against a running server:
   *
   *   GET /api/debug/chat/foo         → 401  (correct)
   *   GET /api/debug/chat/foo.json    → 200  (auth skipped)
   *
   * And it was reachable with real data, because `POST /api/chat` takes a
   * caller-supplied `chatId`: a chat created as `notes.private` was then
   * readable ANONYMOUSLY through `/api/debug/chat/notes.private`, returning its
   * title, message count and `lastMessage.contentPreview` — the message text.
   *
   * Url-encoded traversal hit the same clause, because `%2f` is not a literal
   * `/` so the "extension" ran to the end of the path.
   */
  it("every /api/ route with a dotted final segment still 401s anonymously", async () => {
    for (const path of [
      "/api/debug/chat/foo.json",
      "/api/debug/chat/notes.private",
      "/api/debug/chat/x.y",
      "/api/projects/foo.json",
      "/api/settings.json",
    ]) {
      const res = await middleware(makeRequest(path));
      expect(res.status, `dotted API path must not bypass: ${path}`).toBe(401);
    }
  });

  it("url-encoded traversal does not bypass either", async () => {
    for (const path of [
      "/api/debug/chat/x%2f..%2fy",
      "/api/debug/chat/..%2f..%2f..%2fetc%2fpasswd",
    ]) {
      const res = await middleware(makeRequest(path));
      expect(res.status, `encoded traversal must not bypass: ${path}`).toBe(401);
    }
  });

  it("dashboard pages with a dotted segment redirect to login instead of rendering", async () => {
    const res = await middleware(makeRequest("/dashboard/projects/foo.json"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("the fix does not break real static assets — the reason the clause exists", async () => {
    // Root-level `public/` files still bypass; only application routes are
    // excluded. If this ever fails, the fix was over-applied.
    for (const path of ["/logo.png", "/manifest.json", "/some-file.css"]) {
      const res = await middleware(makeRequest(path));
      expect(res.status, `static asset must still bypass: ${path}`).toBe(200);
    }
  });

  it("an authenticated session still reaches a dotted API path", async () => {
    // The gate must reject the ANONYMOUS caller, not the path shape.
    const res = await middleware(
      makeRequest("/api/debug/chat/foo.json", { cookie: await tokenFor() })
    );
    expect(res.status).toBe(200);
  });
});
