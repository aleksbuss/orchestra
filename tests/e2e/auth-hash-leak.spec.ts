/**
 * Regression test for the password-hash leak found in the Sprint-1 audit.
 *
 * Bug: GET /login (an unauthenticated, public route) embedded the entire
 * `data/settings/settings.json`, including `auth.passwordHash`, into the
 * RSC stream of the served HTML. Cause: `RootLayout` calls `getSettings()`
 * server-side, and Next.js dev-mode RSC instrumentation captures every
 * server-side fs.readFile and serializes its return value to the client
 * for the React DevTools timeline.
 *
 * Threat: anyone who can `curl http://<orchestra>/login` walks away with an
 * offline-bruteforceable scrypt hash. With the local-first single-operator
 * threat model this is "merely" bad on dev; the moment Orchestra ships
 * behind a tunnel/VPN/cloud it becomes CVE-class.
 *
 * Defense: this test asserts that NO unauthenticated route — login, the
 * `/api/auth/status` heartbeat, the unauth `/api/health` probe — exposes
 * any string matching the `scrypt$<salt>$<hash>` envelope or the literal
 * `passwordHash` JSON key. The fix shape (drop full settings from
 * RootLayout, expose only `darkMode`) is covered by a separate task; this
 * test stays as a guard against any regression that re-introduces the leak.
 */
import { test, expect, request as playwrightRequest } from "@playwright/test";

const SCRYPT_HASH_RE = /scrypt\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+/;

test.describe("auth — passwordHash must not leak through any unauthenticated surface", () => {
  test("/login HTML body does not contain the scrypt hash envelope", async ({ baseURL }) => {
    // Use a fresh request context so we explicitly start without any cookies
    // — same threat model as a stranger hitting the URL.
    const ctx = await playwrightRequest.newContext({ baseURL });
    const res = await ctx.get("/login");
    expect(res.status()).toBe(200);
    const body = await res.text();

    expect(body, "raw HTML must not contain a scrypt$ envelope").not.toMatch(SCRYPT_HASH_RE);
    expect(body, "raw HTML must not contain the literal 'passwordHash' key").not.toContain("passwordHash");
    await ctx.dispose();
  });

  test("/api/auth/status response does not surface the hash", async ({ baseURL }) => {
    const ctx = await playwrightRequest.newContext({ baseURL });
    const res = await ctx.get("/api/auth/status");
    // Status itself is intentionally unauthenticated — used by the SPA shell
    // to decide whether to render a logged-in or logged-out chrome. It must
    // never include the hash.
    const body = await res.text();
    expect(body).not.toMatch(SCRYPT_HASH_RE);
    expect(body).not.toContain("passwordHash");
    await ctx.dispose();
  });

  test("/api/health response does not surface the hash", async ({ baseURL }) => {
    const ctx = await playwrightRequest.newContext({ baseURL });
    const res = await ctx.get("/api/health");
    const body = await res.text();
    expect(body).not.toMatch(SCRYPT_HASH_RE);
    expect(body).not.toContain("passwordHash");
    await ctx.dispose();
  });

  test("redirect target after anonymous GET / does not leak the hash on the way", async ({
    baseURL,
  }) => {
    // Anonymous GET / → middleware redirects to /login. Both the redirect
    // response AND the final body must be clean.
    const ctx = await playwrightRequest.newContext({ baseURL });
    const res = await ctx.get("/", { maxRedirects: 5 });
    const body = await res.text();
    expect(body).not.toMatch(SCRYPT_HASH_RE);
    expect(body).not.toContain("passwordHash");
    await ctx.dispose();
  });
});
