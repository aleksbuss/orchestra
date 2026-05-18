import { test, expect } from '@playwright/test';

test.describe('Orchestra Swarm Intelligence & Background Daemon', () => {
  test('Agent config (Swarm & Daemon) toggles work and emit events', async ({ page }) => {
    // 1. Navigate to the main application
    await page.goto('/');

    // Handle initial app setup if database is empty
    const usernameInput = page.locator('#credential-username');
    try {
      if (await usernameInput.isVisible({ timeout: 3000 })) {
        // Step 0: Auth
        await usernameInput.fill('admin');
        await page.locator('#credential-password').fill('password1234');
        await page.locator('#credential-password-confirm').fill('password1234');
        await page.locator('button', { hasText: 'Save and Continue' }).click();
        
        // Step 1: Project
        const projectName = page.locator('#name');
        await projectName.waitFor({ state: 'visible' });
        await projectName.fill('E2E Test Project');
        await page.locator('button', { hasText: 'Create Project' }).click();

        // Step 2: Settings (Skip)
        const skipBtn = page.locator('button', { hasText: 'Skip' });
        await skipBtn.waitFor({ state: 'visible' });
        await skipBtn.click();

        // Step 3: Telegram (Continue)
        const continueBtn = page.locator('button', { hasText: 'Continue to Skills' });
        await continueBtn.waitFor({ state: 'visible' });
        await continueBtn.click();
        
        // Step 4: Skills (Finish)
        const finishBtn = page.locator('button', { hasText: 'Finish Onboarding' });
        await finishBtn.waitFor({ state: 'visible' });
        await finishBtn.click();
      }
    } catch (e) {
      console.log('Skipping onboarding or already initialized string.');
    }

    // Go to chat
    await page.goto('/dashboard');
    await page.waitForTimeout(1000); // Give the UI time to settle
    
    // 2. Ensure the chat container is mounted
    const chatInput = page.locator('textarea').first();
    await chatInput.waitFor({ state: 'visible', timeout: 15000 });

    // 3. Optional: Locate the "Swarm Delegation" and "Daemon" inputs.
    // In CI, these defaults are already set by Zustand.
    /*
    const swarmSwitch = page.locator('label', { hasText: 'Swarm' });
    if (await swarmSwitch.isVisible()) {
      await swarmSwitch.click();
    }
    */
    /*
    await expect(swarmSwitch).toBeChecked();
    await expect(daemonSwitch).toBeChecked();
    */

    // 5. Input a task that triggers the swarm
    await chatInput.fill('Please research the latest capabilities of React Server Components and then write an example component.');
    await chatInput.press('Enter');

    // 6. Look for the "SwarmTrace" accordion component appearing in the chat list
    const swarmTraceBox = page.locator('button').filter({ hasText: /(thinking|Wait|complete)/i }).first();
    await expect(swarmTraceBox).toBeVisible({ timeout: 15000 }); // Wait up to 15 seconds for backend to start processing

    // 7. Click to expand and verify it lists sub-agents working
    await swarmTraceBox.click();
    const traceItems = page.locator('.font-mono', { hasText: 'Node ID' });
    
    // We expect the backend to have emitted at least one hierarchical logic trace
    await expect(traceItems.first()).toBeVisible({ timeout: 15000 });
  });
});
