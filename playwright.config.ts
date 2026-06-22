import { defineConfig, devices } from '@playwright/test';
import path from 'path';

// PM #62 — E2E (which resets credentials + writes chats/projects) runs against
// an ISOLATED data dir so it NEVER touches the real `data/`. global-setup.ts
// creates it fresh; the dev server gets it via `webServer.env`. Set here so both
// the config process and global-setup see the same value.
const E2E_DATA_DIR = path.resolve('.e2e-data');
process.env.ORCHESTRA_DATA_DIR = E2E_DATA_DIR;

// PM #76 — `backupRoot()` (storage/backup.ts) derives from `getDataDir()/..`,
// so it resolves to the SAME `data-backups/` sibling dir regardless of the
// `ORCHESTRA_DATA_DIR` override above (`.e2e-data/..` === `data/..`). A real
// dev server boots during e2e (NODE_ENV isn't "test", so the backup scheduler
// is NOT skipped) and silently copies throwaway `.e2e-data` into the
// OPERATOR'S real backup ring — confirmed live: a 2026-06-21 e2e run created
// `data-backups/data-<ts>/` full of e2e admin/admin test chats. Explicit
// override breaks the collision the same way `ORCHESTRA_DATA_DIR` does above.
const E2E_BACKUP_DIR = path.resolve('.e2e-data-backups');
process.env.ORCHESTRA_BACKUP_DIR = E2E_BACKUP_DIR;

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
    env: { ORCHESTRA_DATA_DIR: E2E_DATA_DIR, ORCHESTRA_BACKUP_DIR: E2E_BACKUP_DIR },
  },
});
