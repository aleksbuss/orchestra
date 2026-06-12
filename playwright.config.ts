import { defineConfig, devices } from '@playwright/test';
import path from 'path';

// PM #62 — E2E (which resets credentials + writes chats/projects) runs against
// an ISOLATED data dir so it NEVER touches the real `data/`. global-setup.ts
// creates it fresh; the dev server gets it via `webServer.env`. Set here so both
// the config process and global-setup see the same value.
const E2E_DATA_DIR = path.resolve('.e2e-data');
process.env.ORCHESTRA_DATA_DIR = E2E_DATA_DIR;

// Default 3000; override with E2E_PORT when something else occupies it —
// the suite spins up its OWN server either way (reuseExistingServer: false).
const E2E_PORT = Number(process.env.E2E_PORT ?? 3000);

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  globalSetup: './tests/e2e/global-setup.ts',
  use: {
    trace: 'on-first-retry',
    baseURL: `http://localhost:${E2E_PORT}`,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `PORT=${E2E_PORT} npm run dev`,
    url: `http://localhost:${E2E_PORT}`,
    // Always start our OWN isolated server — never reuse a server that might be
    // pointed at the real data dir.
    reuseExistingServer: false,
    env: { ORCHESTRA_DATA_DIR: E2E_DATA_DIR },
  },
});
