import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

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

  // Fresh isolated dir.
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dataDir, "settings"), { recursive: true });

  // Reuse the operator's real model/key config (read-only copy) when present, so
  // model-dependent specs have working providers locally.
  const realSettings = path.join(realData, "settings", "settings.json");
  if (fs.existsSync(realSettings)) {
    fs.copyFileSync(realSettings, path.join(dataDir, "settings", "settings.json"));
  }

  // Force admin/admin, scoped to the isolated dir (auth:reset honors the env).
  execSync("npm run auth:reset", {
    stdio: "inherit",
    env: { ...process.env, ORCHESTRA_DATA_DIR: dataDir },
  });
}
