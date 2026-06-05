#!/usr/bin/env node
/**
 * Build guard: park out-of-root symlinks under `data/` before `next build`.
 *
 * WHY THIS EXISTS
 * ---------------
 * `data/` is gitignored runtime state. Agent-created project workspaces under
 * `data/projects/<id>/` contain Python venvs (`.venv/bin/python` → an absolute
 * path to a uv/system interpreter under $HOME) and node_modules. Turbopack
 * walks the whole project root when building the module graph and treats the
 * configured root (`outputFileTracingRoot` / inferred) as a HARD boundary:
 * the moment it follows a symlink whose real target resolves OUTSIDE the root
 * it panics with "Symlink ... is invalid, it points out of the filesystem root"
 * and the entire build dies. There is no Turbopack config option to exclude a
 * directory from this traversal (verified against the Next 15.5 TurbopackOptions
 * schema — only resolveAlias/resolveExtensions/rules/root exist), and
 * `outputFileTracingExcludes` only affects the per-route output-trace phase, not
 * the module graph. So we neutralise the offenders for the duration of the build.
 *
 * The build never legitimately needs `data/` (it is runtime state, read only
 * when the server is running — `instrumentation.ts` runs at boot, not build).
 *
 * WHAT IT DOES
 * -----------
 *   1. Recover: restore any symlinks left parked by a previously crashed run
 *      (idempotent — reads a manifest written before any mutation).
 *   2. Park: find every symlink under `data/` whose realpath escapes the
 *      project root, record (path, link target) to a manifest, then delete the
 *      symlink. Deletion (not move) avoids cross-filesystem rename issues; the
 *      link is recreated byte-identically on restore, so this is non-destructive.
 *   3. Run `next build --turbopack --no-lint`.
 *   4. Restore: recreate every parked symlink. Runs on normal exit, SIGINT,
 *      SIGTERM, and uncaughtException so a Ctrl-C mid-build still restores.
 *
 * In CI / Docker / a fresh clone `data/` is empty, so step 2 finds nothing and
 * this is a thin pass-through around `next build`.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");
const MANIFEST_PATH = path.join(ROOT, ".next-data-symlink-guard.json");

/** True if absolute path `p` is the root itself or nested inside it. */
export function isInsideRoot(root, p) {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function canonicalize(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Recursively collect symlinks under `dir` whose realpath escapes `root`.
 * Broken symlinks (realpath throws) are left alone — Turbopack only panics on
 * links that successfully resolve to a target outside the root boundary.
 *
 * Both sides of the comparison are canonicalized: `fs.realpathSync` on a link
 * target is always canonical, so the root must be too — otherwise a root that
 * itself sits under a symlinked prefix (e.g. `/tmp` → `/private/tmp` on macOS)
 * makes every in-root link look like it escapes.
 */
export function findEscapingSymlinks(dir, root = ROOT, acc = []) {
  return walkForEscaping(dir, canonicalize(root), acc);
}

function walkForEscaping(dir, canonRoot, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc; // dir missing (fresh install) or unreadable — nothing to do
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      let real = null;
      try {
        real = fs.realpathSync(full);
      } catch {
        real = null; // broken link — ignore
      }
      if (real && !isInsideRoot(canonRoot, real)) acc.push(full);
    } else if (entry.isDirectory()) {
      walkForEscaping(full, canonRoot, acc);
    }
  }
  return acc;
}

function isSymlink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Remove each symlink, returning a manifest of { link, target } for restore. */
export function parkSymlinks(links) {
  const manifest = [];
  for (const link of links) {
    try {
      const target = fs.readlinkSync(link);
      manifest.push({ link, target });
      fs.unlinkSync(link);
    } catch (err) {
      console.warn(`[build-guard] could not park ${link}: ${err?.message ?? err}`);
    }
  }
  return manifest;
}

/** Recreate every parked symlink, but only if nothing now occupies its path. */
export function restoreSymlinks(manifest) {
  for (const { link, target } of manifest) {
    try {
      if (!isSymlink(link) && !fs.existsSync(link)) {
        fs.symlinkSync(target, link);
      }
    } catch (err) {
      console.warn(`[build-guard] could not restore ${link}: ${err?.message ?? err}`);
    }
  }
}

function writeManifest(manifest) {
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

function clearManifest() {
  try {
    fs.rmSync(MANIFEST_PATH, { force: true });
  } catch {
    /* best effort */
  }
}

/** Restore from a manifest left by a crashed prior run, then clear it. */
function recoverFromCrashedRun() {
  if (!fs.existsSync(MANIFEST_PATH)) return;
  try {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
    if (Array.isArray(manifest)) {
      console.log(`[build-guard] recovering ${manifest.length} symlink(s) from a prior interrupted build`);
      restoreSymlinks(manifest);
    }
  } catch (err) {
    console.warn(`[build-guard] could not read recovery manifest: ${err?.message ?? err}`);
  }
  clearManifest();
}

function main() {
  recoverFromCrashedRun();

  const escaping = findEscapingSymlinks(DATA_DIR);
  const manifest = parkSymlinks(escaping);
  if (manifest.length) {
    writeManifest(manifest);
    console.log(
      `[build-guard] parked ${manifest.length} out-of-root symlink(s) under data/ for the build ` +
        `(restored automatically afterwards)`
    );
  }

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    restoreSymlinks(manifest);
    clearManifest();
  };
  process.on("exit", restore);
  process.on("SIGINT", () => {
    restore();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    restore();
    process.exit(143);
  });
  process.on("uncaughtException", (err) => {
    restore();
    console.error(err);
    process.exit(1);
  });

  const res = spawnSync(
    "npx",
    ["--no-install", "next", "build", "--turbopack", "--no-lint"],
    { stdio: "inherit", env: process.env, shell: process.platform === "win32" }
  );
  restore();
  process.exit(res.status ?? 1);
}

// Run only when invoked directly (`node scripts/build-with-data-guard.mjs`),
// not when imported by the test.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
