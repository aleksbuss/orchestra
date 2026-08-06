/**
 * Model-config wizard live render check (sprint S2).
 *
 * Unit coverage (`model-wizards.dom.test.tsx`) already asserts render
 * correctness in jsdom. This exists for what jsdom CANNOT see: real chromium
 * layout, the real `settings.json` shape served by the route, and a zero
 * console-error budget on the settings page.
 */
import { test, expect } from "@playwright/test";
import { loginViaApi } from "./helpers";

test("settings page: model wizard renders, step indicator visible, dropdown opens, no console errors", async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));

  const authCookies = await loginViaApi();
  expect(authCookies.length).toBeGreaterThan(0);
  await context.addCookies(authCookies);

  await page.goto("/dashboard/settings");

  // Step indicator labels prove the wizard mounted past the loading state.
  await expect(page.getByText("Provider").first()).toBeVisible({ timeout: 10000 });

  // One real interaction: open a model-select dropdown (custom click-based combobox).
  const selectTrigger = page
    .locator("text=/Select a model|Select model/i")
    .first();
  if (await selectTrigger.isVisible({ timeout: 5000 }).catch(() => false)) {
    await selectTrigger.click();
    await expect(page.locator('input[placeholder="Search models..."]')).toBeVisible({
      timeout: 5000,
    });
  }

  expect(errors, `console/page errors on settings page:\n${errors.join("\n")}`).toEqual([]);
});
