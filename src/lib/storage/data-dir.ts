import path from "path";

/**
 * Single source of truth for the on-disk data root (Orchestra's JSON "database").
 *
 * Honors the `ORCHESTRA_DATA_DIR` environment variable, so tests, Playwright
 * E2E, and throwaway dev runs can point at an ISOLATED directory without ever
 * moving, copying, or touching the real `data/`. When unset, the default is
 * `<cwd>/data` — the production and local-dev layout, unchanged.
 *
 * The result is always an absolute path: a relative `ORCHESTRA_DATA_DIR`
 * (e.g. `.playwright-data`) is anchored at the process working directory.
 *
 * WHY THIS EXISTS (PM #62): the data root was duplicated as
 * `path.join(process.cwd(), "data")` across ~30 modules with no override. With
 * no first-class way to isolate, running destructive tests against a clean DB
 * tempted physically moving the live `data/` aside — a practice that
 * irreversibly destroyed real user chats. Centralizing here, behind one env
 * hook, makes safe isolation trivial and kills the drift-prone literal.
 */
export function getDataDir(): string {
  const override = process.env.ORCHESTRA_DATA_DIR?.trim();
  return path.resolve(
    override && override.length > 0 ? override : path.join(process.cwd(), "data")
  );
}

/**
 * Join path segments under the data root.
 * `dataPath("chats", `${id}.json`)` → `<dataDir>/chats/<id>.json`.
 */
export function dataPath(...segments: string[]): string {
  return path.join(getDataDir(), ...segments);
}
