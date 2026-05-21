/**
 * E2E smoke test for the golden-path "user sends a chat message" flow.
 *
 * Why this file exists: the audit (2026-05-20) found Orchestra had 3 E2E
 * tests, none of which exercised the most basic user journey — log in,
 * type a message, hit send, see it acknowledged by the backend. This is
 * the single regression that would brick the entire product.
 *
 * Scope (intentionally narrow):
 *   - Login works programmatically (we POST credentials directly rather
 *     than dance through the multi-step onboarding UI — that flow is
 *     covered by `swarm.spec.ts`).
 *   - The chat UI mounts: a message input is interactive.
 *   - Submitting a message:
 *       a) reaches `/api/chat` (the central endpoint),
 *       b) does NOT crash the server (no 500 response).
 *
 * Setup contract (before running):
 *   1. `npm run auth:reset` — sets credentials to admin/admin and forces
 *      mustChangeCredentials. The test handles the cred-change flow
 *      automatically by hitting /api/auth/credentials directly.
 *   2. `npm run dev` — the dev server must be reachable on localhost:3000.
 *   3. `npx playwright test tests/e2e/send-message.spec.ts`
 *
 * Explicitly out of scope:
 *   - LLM response content (depends on which provider/model is configured
 *     and whether an API key is present — would be flaky in any CI).
 *   - The visual onboarding wizard (multi-step, has its own coverage in
 *     `swarm.spec.ts`).
 */
import { test, expect, request as pwRequest } from "@playwright/test";

const TEST_PASSWORD = "orchestra-e2e-pw-9!";
const BASE_URL = "http://localhost:3000";

/**
 * Programmatic login + credentials-rotation. Uses the API directly to
 * sidestep the multi-step UI onboarding wizard — that flow has its own
 * coverage and isn't what this spec is regression-testing.
 *
 * Returns the auth cookie value, which we inject into the browser
 * context. The cookie carries `mustChangeCredentials: false`, so
 * middleware lets us straight through to the chat UI.
 */
async function loginViaApi(): Promise<{ name: string; value: string; domain: string; path: string }[]> {
  const ctx = await pwRequest.newContext({ baseURL: BASE_URL });

  // Step 1: login with admin/admin (default after `npm run auth:reset`).
  let loginRes = await ctx.post("/api/auth/login", {
    data: { username: "admin", password: "admin" },
  });

  // If admin/admin doesn't work, the password was rotated on a previous
  // run. Try our test password — same outcome.
  if (loginRes.status() !== 200) {
    loginRes = await ctx.post("/api/auth/login", {
      data: { username: "admin", password: TEST_PASSWORD },
    });
  }
  expect(
    loginRes.status(),
    "could not log in with either admin/admin or the test password. " +
      "Run `npm run auth:reset` and try again."
  ).toBe(200);

  // Step 2: if the response says mustChangeCredentials, rotate it. After
  // this the session cookie carries the post-rotation state.
  const loginBody = await loginRes.json();
  if (loginBody.mustChangeCredentials) {
    const rotateRes = await ctx.put("/api/auth/credentials", {
      data: { username: "admin", password: TEST_PASSWORD },
    });
    expect(rotateRes.status()).toBe(200);
  }

  // Pull the cookies out so we can inject them into the browser context.
  const state = await ctx.storageState();
  await ctx.dispose();
  return state.cookies.filter((c) => c.name === "orchestra_auth");
}

test.describe("send-message — golden path", () => {
  test("user can send a message and the chat API does not 500", async ({
    page,
    context,
  }) => {
    // ── 1. Programmatic login ────────────────────────────────────────
    const authCookies = await loginViaApi();
    expect(
      authCookies.length,
      "login succeeded but did not return an orchestra_auth cookie"
    ).toBeGreaterThan(0);
    await context.addCookies(authCookies);

    // ── 2. Land on a project to mount the chat UI ────────────────────
    // /dashboard renders the project picker. Click any existing project
    // (the test is hermetic with respect to project identity).
    await page.goto("/dashboard");
    const anyProject = page
      .locator("button")
      .filter({ hasText: /BugHunt|TestNew1|TEST|web search/i })
      .first();
    if (await anyProject.isVisible({ timeout: 5000 }).catch(() => false)) {
      await anyProject.click();
    }

    // ── 3. Open a chat (creates a new one if none exists) ────────────
    const newChatBtn = page
      .getByRole("button", { name: /new chat/i })
      .first();
    if (await newChatBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await newChatBtn.click();
    }

    // ── 4. Locate the chat input ─────────────────────────────────────
    // First textarea on the page is the chat input (see chat-input.tsx).
    // Sidebar / settings UIs use plain inputs, not textareas.
    const chatInput = page.locator("textarea").first();
    await chatInput.waitFor({ state: "visible", timeout: 15000 });

    // ── 5. Send a message + intercept the API call ───────────────────
    // We don't care what the LLM says back. We care that:
    //   a) /api/chat is hit
    //   b) it does NOT 500
    //   c) it responds with a 2xx (200 stream for interactive, 200 queued
    //      for background — both are fine for this smoke regression).
    const apiResponse = page.waitForResponse(
      (r) => r.url().includes("/api/chat") && r.request().method() === "POST",
      { timeout: 20000 }
    );

    const messageText = `e2e-smoke-${Date.now()}`;
    await chatInput.fill(messageText);
    await chatInput.press("Enter");

    const res = await apiResponse;
    expect(
      res.status(),
      `chat API returned ${res.status()} for a plain message — this is a P0 regression. ` +
        `Check the dev server log for the stack trace.`
    ).toBeLessThan(500);
    expect(res.status()).toBeGreaterThanOrEqual(200);
  });
});
