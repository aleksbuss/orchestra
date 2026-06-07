import { request as pwRequest, expect } from "@playwright/test";

export const TEST_PASSWORD = "orchestra-e2e-pw-9!";
export const BASE_URL = "http://localhost:3000";

/**
 * Programmatic login + credentials-rotation. Uses the API directly to sidestep
 * the multi-step UI onboarding wizard — that flow has its own coverage and is
 * brittle against UI changes. Critically, changing the password rotates the
 * session, so the UI flow leaves you logged OUT; hitting the API and pulling
 * the POST-rotation cookie is the reliable way to land authenticated.
 *
 * Returns the `orchestra_auth` cookie(s) to inject into a browser context.
 */
export async function loginViaApi(): Promise<
  { name: string; value: string; domain: string; path: string }[]
> {
  const ctx = await pwRequest.newContext({ baseURL: BASE_URL });

  // Step 1: login with admin/admin (default after `npm run auth:reset`), or the
  // test password if a previous run already rotated it.
  let loginRes = await ctx.post("/api/auth/login", {
    data: { username: "admin", password: "admin" },
  });
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

  // Step 2: rotate forced first-login credentials; the cookie then carries the
  // post-rotation state (mustChangeCredentials: false).
  const loginBody = await loginRes.json();
  if (loginBody.mustChangeCredentials) {
    const rotateRes = await ctx.put("/api/auth/credentials", {
      data: { username: "admin", password: TEST_PASSWORD },
    });
    expect(rotateRes.status()).toBe(200);
  }

  const state = await ctx.storageState();
  await ctx.dispose();
  return state.cookies.filter((c) => c.name === "orchestra_auth");
}
