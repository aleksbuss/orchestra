import { test, expect } from '@playwright/test';
import { loginViaApi } from './helpers';

test.describe('Orchestra Swarm Intelligence & Background Daemon', () => {
  test('Swarm task emits a hierarchical agent trace', async ({ page, context }) => {
    // Authenticate via the API. The UI onboarding wizard (login → forced
    // credential rotation → project/skills steps) is brittle and, because the
    // password change rotates the session, leaves the browser logged out.
    // loginViaApi performs the rotation and hands back the post-rotation cookie.
    const authCookies = await loginViaApi();
    expect(
      authCookies.length,
      'login succeeded but did not return an orchestra_auth cookie'
    ).toBeGreaterThan(0);
    await context.addCookies(authCookies);

    // Land on the dashboard and open a chat (creates one if none exists).
    await page.goto('/dashboard');
    const newChatBtn = page.getByRole('button', { name: /new chat/i }).first();
    if (await newChatBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await newChatBtn.click();
    }

    const chatInput = page.locator('textarea').first();
    await chatInput.waitFor({ state: 'visible', timeout: 15000 });

    // Swarm is ON by default (app-store). Send a task that triggers the ensemble.
    await chatInput.fill(
      'Please research the latest capabilities of React Server Components and then write an example component.'
    );
    await chatInput.press('Enter');

    // Open the Swarm Activity panel — its trigger button is always present while
    // Swarm is ON. The SwarmDAG inside renders ONLY once the backend emits agent
    // nodes (it returns null for an empty DAG), and shows a live status header;
    // that header's presence proves a hierarchical swarm trace was emitted for
    // this turn. Real-model MoA needs more headroom than CI mocks.
    await page.getByRole('button', { name: /swarm activity/i }).first().click();

    await expect(
      page
        .getByText(/agents? thinking|Swarm Work Completed|Swarm Execution Failed/i)
        .first()
    ).toBeVisible({ timeout: 45000 });
  });
});
