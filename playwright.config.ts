import { defineConfig, devices } from '@playwright/test';
import path from 'path';
import {
  CLEAN_BOOT_BACKUP_DIR,
  CLEAN_BOOT_BASE_URL,
  CLEAN_BOOT_DATA_DIR,
  CLEAN_BOOT_DIST_DIR,
  CLEAN_BOOT_PORT,
  CLEAN_BOOT_PROVIDER_ENV,
} from './tests/e2e/clean-boot-env';

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

// ── The clean-boot server (PM #103) ──────────────────────────────────────────
// A SECOND server, because the main one cannot answer the question this suite
// exists to ask. `global-setup.ts` copies the operator's real settings.json into
// `.e2e-data` "so model-dependent specs have working providers locally", so a
// local e2e run is emphatically NOT a fresh install — and on CI, where that copy
// finds nothing, the same suite silently tests a different thing. An instrument
// that measures one thing on a laptop and another on CI is the exact class of
// silent degradation that let PM #99 and PM #101 ship.
//
// This server gets a data dir that is created empty and seeded with NOTHING: no
// settings, no credential reset. It is the only place in the repo where the
// first-run path is exercised as a stranger would meet it. Constants are shared
// with global-setup and the spec via `tests/e2e/clean-boot-env.ts`.

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // ONE worker everywhere, not just on CI. Every spec shares one server and one
  // settings file, and `fresh-install-drill.spec.ts` repoints the brain mid-run,
  // so parallel workers make the suite fail — its header already tells you to
  // pass `--workers=1` by hand. A default that only works when you remember a
  // flag means `npx playwright test` is red on a laptop and green on CI, which
  // is the same laptop-vs-CI divergence the clean-boot server exists to remove.
  // CI behaviour is unchanged; this only fixes the local default.
  workers: 1,
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
      // The clean-boot spec talks to the OTHER server; running it here would
      // point it at the seeded dir and quietly assert nothing.
      testIgnore: /clean-boot\.spec\.ts/,
    },
    {
      name: 'clean-boot',
      use: { ...devices['Desktop Chrome'], baseURL: CLEAN_BOOT_BASE_URL },
      testMatch: /clean-boot\.spec\.ts/,
    },
  ],
  webServer: [
    {
      command: `PORT=${E2E_PORT} npm run dev`,
      url: `http://localhost:${E2E_PORT}`,
      // Always start our OWN isolated server — never reuse a server that might be
      // pointed at the real data dir.
      reuseExistingServer: false,
      env: { ORCHESTRA_DATA_DIR: E2E_DATA_DIR, ORCHESTRA_BACKUP_DIR: E2E_BACKUP_DIR },
    },
    {
      command: `PORT=${CLEAN_BOOT_PORT} npm run dev`,
      url: `${CLEAN_BOOT_BASE_URL}/login`,
      reuseExistingServer: false,
      env: {
        ORCHESTRA_DATA_DIR: CLEAN_BOOT_DATA_DIR,
        ORCHESTRA_BACKUP_DIR: CLEAN_BOOT_BACKUP_DIR,
        // Its own build dir — two `next dev` processes sharing `.next/` race
        // each other (see the note in next.config.mjs).
        ORCHESTRA_NEXT_DIST_DIR: CLEAN_BOOT_DIST_DIR,
        ...CLEAN_BOOT_PROVIDER_ENV,
      },
    },
  ],
});
