import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

const fileLocks = new Map<string, Promise<void>>();

/**
 * Resolves `candidate` against `rootDir` and guarantees the result stays inside
 * `rootDir`. Use this on every user-supplied path fragment that touches the
 * filesystem — `path.join()` alone is NOT a security boundary, it normalizes
 * `../../` traversal silently. See `POST_MORTEMS.md` PM #6.
 *
 * **Known limitation — symlinks (carried as residual risk in PM #6):** this
 * helper normalizes paths string-wise via `path.resolve`, it does NOT call
 * `fs.realpath`. A symlink placed inside `rootDir` (e.g. by a privileged
 * process or by an admin-installed knowledge bundle) can still point outside
 * the sandbox, and the helper will accept it. For Orchestra's local-first,
 * single-trusted-operator threat model this trade-off is acceptable; if you
 * extend Orchestra to multi-tenant or untrusted operators, replace this with
 * an async `realpath`-based guard.
 *
 * @param rootDir The directory the candidate must stay inside.
 * @param candidate The user-supplied path fragment (relative or absolute).
 * @throws Error if `candidate` escapes `rootDir` after string normalization.
 * @returns The absolute resolved path, safe to pass to fs APIs.
 */
export function assertPathInside(rootDir: string, candidate: string): string {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedCandidate = path.resolve(rootDir, candidate);
  if (
    resolvedCandidate !== resolvedRoot &&
    !resolvedCandidate.startsWith(resolvedRoot + path.sep)
  ) {
    throw new Error(
      `Path "${candidate}" escapes the allowed root "${resolvedRoot}"`
    );
  }
  return resolvedCandidate;
}

/**
 * Find the deepest ancestor of `target` that exists on disk, realpath it,
 * and return the realpath plus the suffix of original path components that
 * don't yet exist. Used by `assertPathInsideRealpath` so the guard works
 * even when the candidate file hasn't been created yet (a common case for
 * the agent: it's about to create the file we're validating).
 *
 * Throws only if even the filesystem root cannot be realpath'd, which
 * effectively means "we're being run with a broken FS view."
 */
async function realpathDeepestAncestor(
  target: string
): Promise<{ real: string; suffix: string[] }> {
  let current = target;
  const missing: string[] = [];
  while (true) {
    try {
      const real = await fs.realpath(current);
      return { real, suffix: missing.reverse() };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const parent = path.dirname(current);
      if (parent === current) {
        throw new Error(`Cannot resolve realpath for ${target}: walked up to FS root.`);
      }
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Symlink-safe variant of `assertPathInside`. Used for **linked projects**
 * (Open Folder feature) where the user's repository on disk may contain
 * symlinks pointing outside it. Without `fs.realpath`, a symlink at
 * `<absoluteRoot>/secrets -> ~/.ssh` would let the agent read private keys.
 *
 * Behavior:
 *   1. realpaths `rootDir` (the absoluteRoot) so the comparison baseline
 *      already accounts for any symlinks ALONG the root itself.
 *   2. Finds the deepest existing ancestor of the candidate, realpaths it,
 *      then re-appends the not-yet-existing suffix. This makes the check
 *      work for files the agent is about to create.
 *   3. String-checks the realpath'd candidate against the realpath'd root.
 *
 * Async because `fs.realpath` is async. Use the sync `assertPathInside` for
 * sandbox projects (under `data/projects/`) where Orchestra controls the
 * directory tree and there are no user-installed symlinks to worry about.
 */
export async function assertPathInsideRealpath(
  rootDir: string,
  candidate: string
): Promise<string> {
  const resolvedRoot = await fs.realpath(path.resolve(rootDir));
  const candidateAbs = path.resolve(rootDir, candidate);
  const { real: ancestorReal, suffix } = await realpathDeepestAncestor(candidateAbs);
  const candidateReal =
    suffix.length > 0 ? path.join(ancestorReal, ...suffix) : ancestorReal;
  if (
    candidateReal !== resolvedRoot &&
    !candidateReal.startsWith(resolvedRoot + path.sep)
  ) {
    throw new Error(
      `Path "${candidate}" escapes the allowed root "${resolvedRoot}" (after symlink resolution)`
    );
  }
  return candidateReal;
}

async function resolveChain(promise: Promise<unknown>): Promise<void> {
  await promise.then(
    () => undefined,
    () => undefined
  );
}

/**
 * Executes a function with an in-memory lock for a specific file path.
 * This guarantees sequential Read-Modify-Write cycles for that file within the same Node process.
 * @param filePath The absolute path of the file to lock
 * @param fn The asynchronous function to execute while holding the lock
 */
export async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const resolvedPath = path.resolve(filePath);
  const previous = fileLocks.get(resolvedPath) ?? Promise.resolve();
  
  const next = resolveChain(previous).then(fn);
  const lockPromise = resolveChain(next);
  
  fileLocks.set(resolvedPath, lockPromise);
  
  try {
    return await next;
  } finally {
    // Prevent memory leak: remove the lock if no other concurrent requests have queued up behind it.
    if (fileLocks.get(resolvedPath) === lockPromise) {
      fileLocks.delete(resolvedPath);
    }
  }
}


/**
 * Safely writes a file by writing to a temporary file first and then
 * performing an atomic rename. This prevents data corruption (e.g. 0-byte JSON files)
 * in case the Node process crashes or concurrent writes happen exactly at the same time.
 * @param filePath The absolute path of the file to write
 * @param data The string data to write to the file
 */
export async function safeWriteFile(filePath: string, data: string): Promise<void> {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const baseName = path.basename(filePath, ext);
  
  // Ensure the target directory exists
  await fs.mkdir(dir, { recursive: true });

  // Generate a random temporary filename in the same directory
  const tempPath = path.join(dir, `${baseName}.${crypto.randomUUID()}${ext}.tmp`);
  
  try {
    // Write data to the temporary file
    await fs.writeFile(tempPath, data, "utf-8");
    // Atomically rename it to the target file path
    await fs.rename(tempPath, filePath);
  } catch (error) {
    // Attempt to clean up the temp file if something failed during write/rename
    try {
      await fs.rm(tempPath, { force: true });
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}
