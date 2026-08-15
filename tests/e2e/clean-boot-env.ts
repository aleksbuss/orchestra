/**
 * Shared constants for the clean-boot server (PM #103).
 *
 * Three files need to agree on these: `playwright.config.ts` (starts the
 * server), `global-setup.ts` (creates the directory), and `clean-boot.spec.ts`
 * (asserts on the directory). Passing them around through `process.env` worked,
 * but a typo in one of the three names degrades in the passing direction — the
 * spec would read `undefined`, skip its precondition check, and stay green while
 * testing nothing. A shared module makes a mismatch a TypeScript error instead.
 */
import path from "node:path";

/** Seeded-suite port, mirrored from playwright.config.ts. */
const E2E_PORT = Number(process.env.E2E_PORT ?? 3000);

/** The clean-boot server's port — its own, so both servers can run at once. */
export const CLEAN_BOOT_PORT = Number(process.env.E2E_CLEAN_PORT ?? E2E_PORT + 1);

export const CLEAN_BOOT_BASE_URL = `http://localhost:${CLEAN_BOOT_PORT}`;

/** Created empty on every run and seeded with NOTHING. */
export const CLEAN_BOOT_DATA_DIR = path.resolve(".e2e-clean-data");

export const CLEAN_BOOT_BACKUP_DIR = path.resolve(".e2e-clean-data-backups");

/**
 * What the clean data dir contained the instant global-setup finished with it.
 *
 * Written OUTSIDE that dir, because a file inside it would itself be seeding.
 * This exists because the obvious check — "read the directory in the test and
 * assert it is empty" — is a race: the server boots when the suite starts, and
 * by the time the clean-boot project runs (last, with `workers: 1`) the app has
 * legitimately created its own empty scaffolding. That check passed only while
 * clean-boot happened to run first. The manifest records the one moment the
 * question "was anything seeded?" has an exact answer.
 */
export const CLEAN_BOOT_MANIFEST = path.resolve(".e2e-clean-boot-manifest.json");

/**
 * Its own Next build dir. Two `next dev` processes sharing `.next/` race each
 * other; consumed by `next.config.mjs` via `ORCHESTRA_NEXT_DIST_DIR`.
 */
export const CLEAN_BOOT_DIST_DIR = ".next-clean-boot";

/**
 * The credential picture the clean install boots into: one non-OpenAI key it can
 * discover, and every other provider explicitly blanked.
 *
 * `OPENAI_API_KEY: ""` is load-bearing and must not be "simplified" to omitting
 * the key. The dev server loads `.env.local`, and `@next/env` only fills a
 * variable that is `undefined` — an explicit empty string is what stops the
 * operator's own OpenAI key from leaking in and making the PM #101 assertion
 * pass for the wrong reason. The OpenRouter value is a placeholder; no
 * clean-boot test performs a model call, so it is never sent anywhere.
 */
export const CLEAN_BOOT_PROVIDER_ENV = {
  OPENROUTER_API_KEY: "sk-or-clean-boot-not-a-real-key",
  OPENAI_API_KEY: "",
  ANTHROPIC_API_KEY: "",
  GOOGLE_API_KEY: "",
} as const;
