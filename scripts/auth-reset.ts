/**
 * Reset Orchestra auth credentials to the documented defaults (admin/admin).
 *
 * Usage: npm run auth:reset
 *
 * What it does:
 *   1. Reads data/settings/settings.json
 *   2. Creates a timestamped backup next to it (settings.json.backup-<ms>)
 *   3. Resets auth.username → "admin", auth.passwordHash → default hash,
 *      auth.mustChangeCredentials → true
 *   4. Writes the file atomically via fs.rename
 *
 * Use this when you have forgotten the password and need to regain access.
 * After running, log in with admin/admin and the onboarding flow will force
 * you to set a new password.
 */
import fs from "fs/promises";
import path from "path";

const ROOT = process.cwd();
const SETTINGS_FILE = path.join(ROOT, "data", "settings", "settings.json");

const DEFAULT_AUTH_USERNAME = "admin";
const DEFAULT_AUTH_PASSWORD_HASH =
  "scrypt$XLqs3H3hyIdkLImyxg8Trg$zJz4yn41_fzKQJG6bFe9fLoKY6djdHDWIVIuYDKr0gX_Neo4LQ3wj6eJt3cKjvfxKyd6mek39RvSlpf7n-qGkA";

async function main() {
  let content: string;
  try {
    content = await fs.readFile(SETTINGS_FILE, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(
        `[auth:reset] No settings file at ${SETTINGS_FILE}. ` +
          `Start the dev server once to generate it, then re-run.`
      );
      process.exit(1);
    }
    throw err;
  }

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(content) as Record<string, unknown>;
  } catch (err) {
    console.error(
      `[auth:reset] settings.json is not valid JSON. Refusing to overwrite.`,
      err
    );
    process.exit(1);
  }

  const backupPath = `${SETTINGS_FILE}.backup-${Date.now()}`;
  await fs.writeFile(backupPath, content, "utf-8");

  const auth =
    (settings.auth as Record<string, unknown> | undefined) ?? {};
  auth.enabled = true;
  auth.username = DEFAULT_AUTH_USERNAME;
  auth.passwordHash = DEFAULT_AUTH_PASSWORD_HASH;
  auth.mustChangeCredentials = true;
  settings.auth = auth;

  const tmpPath = `${SETTINGS_FILE}.tmp-${Date.now()}`;
  await fs.writeFile(tmpPath, JSON.stringify(settings, null, 2), "utf-8");
  await fs.rename(tmpPath, SETTINGS_FILE);

  console.log(`[auth:reset] ✅ Auth reset complete.`);
  console.log(`             Backup saved: ${path.relative(ROOT, backupPath)}`);
  console.log(`             Username:     admin`);
  console.log(`             Password:     admin`);
  console.log(``);
  console.log(`Log in, then change credentials immediately when prompted.`);
}

main().catch((err) => {
  console.error("[auth:reset] Failed:", err);
  process.exit(1);
});
