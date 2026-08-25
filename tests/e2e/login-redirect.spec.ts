/**
 * The login form must actually leave the login page.
 *
 * Reported as "sometimes I have to press Sign In up to three times before it
 * logs me in". Measured on a cold route: the POST returns 200 with
 * `{"success":true}` and the session cookie IS set — and the browser stays on
 * `/login`. The login had succeeded every time; only the navigation was lost,
 * so each retry succeeded again and left the person on the same form.
 *
 * Cause: `router.replace(x)` followed synchronously by `router.refresh()`. The
 * refresh cancels the pending navigation. A/B, three cold-route runs each:
 *
 *   replace() + refresh()     -> /login, /login, /login
 *   replace() alone           -> /dashboard/projects  ×3
 *   window.location.assign()  -> /dashboard/projects  ×3
 *
 * This spec drives the real form the way a person does — type, click, wait —
 * and asserts the outcome a person cares about: the page moved. It does not
 * assert the mechanism, so a future rewrite of the redirect (a Server Action,
 * a route-handler 302) stays free to change how, as long as it still leaves.
 */
import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";

test.describe("login — a successful sign-in leaves the login page", () => {
  test.beforeEach(() => {
    // Known credentials, scoped to the isolated e2e data dir.
    execSync("npm run auth:reset", {
      stdio: "pipe",
      env: { ...process.env, ORCHESTRA_DATA_DIR: process.env.ORCHESTRA_DATA_DIR },
    });
  });

  test("typing the default credentials and pressing Sign In lands off /login", async ({ page }) => {
    const loginPosts: number[] = [];
    page.on("response", (r) => {
      if (r.url().includes("/api/auth/login")) loginPosts.push(r.status());
    });

    await page.goto("/login");
    await page.locator("#username").waitFor({ state: "visible", timeout: 30_000 });

    // Human-ish: click into the field and type, rather than setting the value.
    await page.locator("#username").click();
    await page.keyboard.type("admin", { delay: 40 });
    await page.locator("#password").click();
    await page.keyboard.type("admin", { delay: 40 });
    await page.locator('button[type="submit"]').click();

    // The whole point: ONE press is enough.
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 45_000 });

    expect(
      loginPosts,
      "exactly one login POST should have been needed"
    ).toEqual([200]);
    expect(new URL(page.url()).pathname).not.toMatch(/^\/login/);
  });

  test("a rejected password keeps you on /login with a visible reason", async ({ page }) => {
    // The counterpart: the page must NOT leave when the credentials are wrong,
    // and must say why — otherwise "it moved" could be satisfied by moving on
    // a failed login too.
    await page.goto("/login");
    await page.locator("#username").waitFor({ state: "visible", timeout: 30_000 });
    await page.locator("#username").fill("admin");
    await page.locator("#password").fill("definitely-not-the-password");
    await page.locator('button[type="submit"]').click();

    await expect(page.locator("p.text-destructive")).toBeVisible({ timeout: 20_000 });
    expect(new URL(page.url()).pathname).toMatch(/^\/login/);
  });
});
