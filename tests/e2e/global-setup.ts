import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  CLEAN_BOOT_BACKUP_DIR,
  CLEAN_BOOT_DATA_DIR,
  CLEAN_BOOT_MANIFEST,
} from "./clean-boot-env";

/**
 * PM #62 — Playwright E2E runs against an ISOLATED data dir (ORCHESTRA_DATA_DIR),
 * never the real `data/`. The suite resets credentials and writes chats/projects,
 * so it must never touch user data. The isolated dir is recreated fresh each run;
 * the operator's model/key config is copied read-only so model-dependent specs
 * work locally (CI starts from defaults).
 */
export default function globalSetup(): void {
  const dataDir = process.env.ORCHESTRA_DATA_DIR;
  if (!dataDir) {
    throw new Error(
      "E2E global-setup: ORCHESTRA_DATA_DIR must be set (see playwright.config.ts)."
    );
  }
  const realData = path.resolve(process.cwd(), "data");
  if (path.resolve(dataDir) === realData) {
    throw new Error(
      `E2E global-setup: ORCHESTRA_DATA_DIR resolves to the real data dir (${realData}) — refusing to run.`
    );
  }

  // PM #76 — backupRoot() (storage/backup.ts) derives from `getDataDir()/..`,
  // so an isolated ORCHESTRA_DATA_DIR alone does NOT isolate backups (both
  // `.e2e-data/..` and `data/..` resolve to the same `data-backups/`). The dev
  // server boots for real during e2e and WILL run the boot backup, so this
  // must be isolated explicitly via ORCHESTRA_BACKUP_DIR (set in
  // playwright.config.ts), with the same refuse-if-it-collides guard.
  const backupDir = process.env.ORCHESTRA_BACKUP_DIR;
  const realBackupRoot = path.resolve(process.cwd(), "data-backups");
  if (!backupDir) {
    throw new Error(
      "E2E global-setup: ORCHESTRA_BACKUP_DIR must be set (see playwright.config.ts) — " +
        "without it, e2e backups land in the operator's real data-backups/."
    );
  }
  if (path.resolve(backupDir) === realBackupRoot) {
    throw new Error(
      `E2E global-setup: ORCHESTRA_BACKUP_DIR resolves to the real backup dir (${realBackupRoot}) — refusing to run.`
    );
  }

  // Fresh isolated dirs.
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dataDir, "settings"), { recursive: true });
  fs.rmSync(backupDir, { recursive: true, force: true });

  // Reuse the operator's real model/key config (read-only copy) when present, so
  // model-dependent specs have working providers locally. On CI there is no
  // operator config — seed an empty object so `auth:reset` has a file to edit
  // (it refuses to run on a missing file, and the settings store deep-merges
  // DEFAULT_SETTINGS over whatever JSON is on disk, so `{}` is a valid start).
  const realSettings = path.join(realData, "settings", "settings.json");
  const isoSettings = path.join(dataDir, "settings", "settings.json");
  if (fs.existsSync(realSettings)) {
    fs.copyFileSync(realSettings, isoSettings);
  } else {
    fs.writeFileSync(isoSettings, "{}\n", "utf-8");
  }

  // Force admin/admin, scoped to the isolated dir (auth:reset honors the env).
  execSync("npm run auth:reset", {
    stdio: "inherit",
    env: { ...process.env, ORCHESTRA_DATA_DIR: dataDir },
  });

  prepareCleanBootDir(realData, realBackupRoot);
}

/**
 * The clean-boot dir (PM #103) — deliberately the OPPOSITE of everything above.
 *
 * No settings copy, no `auth:reset`, no seeding of any kind: the whole point is
 * a directory that has never been written to, so the first-run path is exercised
 * as a stranger meets it. Every seeding step that makes the main e2e dir useful
 * is precisely what makes it unable to answer "does a fresh install work?".
 *
 * It is created EMPTY, not merely wiped-and-populated — `clean-boot.spec.ts`
 * asserts the emptiness rather than trusting it, because an isolation step that
 * silently stops working is the failure mode this repo keeps paying for
 * (PM #100).
 */
function prepareCleanBootDir(realData: string, realBackupRoot: string): void {
  const cleanData = CLEAN_BOOT_DATA_DIR;
  const cleanBackup = CLEAN_BOOT_BACKUP_DIR;
  // Same refuse-if-it-collides guard as the seeded dirs. A clean-boot dir is
  // wiped unconditionally on every run, so a misconfiguration here would delete
  // the operator's database rather than merely pollute it.
  if (path.resolve(cleanData) === realData) {
    throw new Error(
      `E2E global-setup: clean-boot data dir resolves to the real data dir (${realData}) — refusing to run.`
    );
  }
  if (path.resolve(cleanBackup) === realBackupRoot) {
    throw new Error(
      `E2E global-setup: clean-boot backup dir resolves to the real backup dir (${realBackupRoot}) — refusing to run.`
    );
  }
  if (path.resolve(cleanData) === path.resolve(process.env.ORCHESTRA_DATA_DIR!)) {
    throw new Error(
      "E2E global-setup: the clean-boot data dir must not be the seeded e2e dir — " +
        "sharing them would seed the very thing clean-boot exists to leave unseeded."
    );
  }

  fs.rmSync(cleanData, { recursive: true, force: true });
  fs.rmSync(cleanBackup, { recursive: true, force: true });
  // The directory itself must exist so the dev server can boot; nothing goes
  // INSIDE it. `getSettings` is lazy — it creates `settings/` on first read but
  // does not materialize `settings.json`, which the spec relies on.
  fs.mkdirSync(cleanData, { recursive: true });

  // Record the emptiness NOW. By the time the spec runs, the app has been up
  // for a while and has created its own (empty) scaffolding, so a directory
  // listing taken then cannot distinguish "the app made a folder" from "someone
  // seeded this". This is the only moment the answer is unambiguous.
  fs.writeFileSync(
    CLEAN_BOOT_MANIFEST,
    JSON.stringify(
      { createdAt: new Date().toISOString(), entries: fs.readdirSync(cleanData) },
      null,
      2
    ),
    "utf-8"
  );
}
