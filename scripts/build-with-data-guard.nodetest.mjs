/**
 * Tests for the build data-symlink guard. Uses Node's built-in test runner
 * (`node --test scripts/build-with-data-guard.test.mjs`) so it has ZERO
 * dependency on the app's test toolchain — it validates a build-time script
 * and must run even when node_modules is in flux.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isInsideRoot,
  findEscapingSymlinks,
  parkSymlinks,
  restoreSymlinks,
} from "./build-with-data-guard.mjs";

function mkTmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "guard-test-"));
}

test("isInsideRoot: nested paths inside, siblings/parents outside", () => {
  const root = "/a/b";
  assert.equal(isInsideRoot(root, "/a/b"), true);
  assert.equal(isInsideRoot(root, "/a/b/c/d"), true);
  assert.equal(isInsideRoot(root, "/a/c"), false); // sibling
  assert.equal(isInsideRoot(root, "/a"), false); // parent
  assert.equal(isInsideRoot(root, "/a/b-evil/x"), false); // prefix-sibling, not nested
});

test("findEscapingSymlinks: flags out-of-root targets, ignores in-root + broken", () => {
  const root = mkTmpRoot();
  const outside = mkTmpRoot(); // a separate tmp tree = outside `root`
  try {
    const dataDir = path.join(root, "data", "projects", "p", ".venv", "bin");
    fs.mkdirSync(dataDir, { recursive: true });

    // Real file outside root + an absolute symlink to it (the venv-python case).
    const outsideFile = path.join(outside, "python3.13");
    fs.writeFileSync(outsideFile, "#!/bin/echo");
    const escaping = path.join(dataDir, "python");
    fs.symlinkSync(outsideFile, escaping);

    // Chained relative symlink python3 -> python -> (outside). realpath escapes.
    const chained = path.join(dataDir, "python3");
    fs.symlinkSync("python", chained);

    // In-root symlink (relative, stays inside) — must NOT be flagged.
    const innerTarget = path.join(root, "data", "projects", "p", "real.txt");
    fs.writeFileSync(innerTarget, "x");
    const innerLink = path.join(dataDir, "inside-link");
    fs.symlinkSync(innerTarget, innerLink);

    // Broken symlink (target does not exist) — realpath throws → ignored.
    const broken = path.join(dataDir, "broken");
    fs.symlinkSync(path.join(dataDir, "nope"), broken);

    const found = findEscapingSymlinks(path.join(root, "data"), root).sort();
    assert.deepEqual(found.sort(), [escaping, chained].sort());
    assert.ok(!found.includes(innerLink), "in-root link must not be flagged");
    assert.ok(!found.includes(broken), "broken link must not be flagged");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("park then restore is a no-op round-trip (link + target preserved)", () => {
  const root = mkTmpRoot();
  const outside = mkTmpRoot();
  try {
    const binDir = path.join(root, "data", "projects", "p", ".venv", "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const outsideFile = path.join(outside, "python3.13");
    fs.writeFileSync(outsideFile, "#!/bin/echo");

    const absLink = path.join(binDir, "python");
    fs.symlinkSync(outsideFile, absLink); // absolute → escapes
    const relLink = path.join(binDir, "python3");
    fs.symlinkSync("python", relLink); // relative chain → escapes via python

    const escaping = findEscapingSymlinks(path.join(root, "data"), root);
    assert.equal(escaping.length, 2);

    const manifest = parkSymlinks(escaping);
    // Parked: the symlinks are gone from disk.
    assert.ok(!fs.existsSync(absLink) && !safeIsSymlink(absLink));
    assert.ok(!safeIsSymlink(relLink));
    // Manifest captured the exact original targets.
    const byLink = Object.fromEntries(manifest.map((m) => [m.link, m.target]));
    assert.equal(byLink[absLink], outsideFile);
    assert.equal(byLink[relLink], "python");

    restoreSymlinks(manifest);
    // Restored: symlinks back, byte-identical targets.
    assert.equal(fs.readlinkSync(absLink), outsideFile);
    assert.equal(fs.readlinkSync(relLink), "python");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("restore does not clobber a path that is now occupied", () => {
  const root = mkTmpRoot();
  try {
    const dir = path.join(root, "data");
    fs.mkdirSync(dir, { recursive: true });
    const link = path.join(dir, "x");
    // Simulate a manifest whose link path was, after parking, replaced by a
    // real file (e.g. the venv was regenerated mid-build). Restore must skip it.
    fs.writeFileSync(link, "regenerated");
    restoreSymlinks([{ link, target: "/some/other/place" }]);
    assert.equal(fs.readFileSync(link, "utf8"), "regenerated");
    assert.ok(!safeIsSymlink(link), "must not overwrite a real file with a symlink");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function safeIsSymlink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
