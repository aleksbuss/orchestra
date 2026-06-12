import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import pkg from "../../../package.json";

const require = createRequire(import.meta.url);

/**
 * Supply-chain regression guards.
 *
 * Some security fixes live in `package.json` (npm `overrides`), not in
 * source — they're invisible to a code reviewer and trivially dropped
 * during a routine dependency cleanup. When that happens the
 * vulnerability returns SILENTLY: nothing in the diff looks security-
 * relevant. These tests are the teeth that turn "the override was
 * removed" into a red CI run.
 *
 * If a guard here ever blocks a legitimate change, don't delete it —
 * understand why the floor exists (the linked advisory) and decide
 * deliberately. Bump the floor; never just lower the bar.
 */

/** Compare two `major.minor.patch` strings. Returns a<b ? -1, a>b ? 1, else 0. */
function compareSemverCore(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10));
  const pb = b.split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

/** Resolve the on-disk version of an installed package as actually loaded. */
function installedVersion(name: string): string {
  const pkgJsonPath = require.resolve(`${name}/package.json`);
  return JSON.parse(readFileSync(pkgJsonPath, "utf8")).version as string;
}

describe("dependency floor — lodash >= 4.18.1 (prototype-pollution / code-injection)", () => {
  // GHSA-r5fr-rjxr-66jc (code injection via _.template),
  // GHSA-f23m-r3pf-42rh + GHSA-xxjr-mmjv-4gpg (prototype pollution in
  // _.unset / _.omit). All fixed in 4.18.x; <=4.17.23 is vulnerable.
  // lodash enters the tree transitively (agent-browser → node-simctl →
  // @appium/logger), pinned up via the `overrides` block in package.json.
  const FLOOR = "4.18.1";

  it("keeps the lodash override declared in package.json", () => {
    // If this fails, someone removed the override — the resolved lodash
    // version below will (eventually, after a reinstall) regress to the
    // vulnerable transitive one. Re-add: "overrides": { "lodash": "^4.18.1" }.
    expect(pkg.overrides).toBeDefined();
    expect((pkg.overrides as Record<string, string>).lodash).toBe("^4.18.1");
  });

  it("resolves an installed lodash at or above the floor", () => {
    const version = installedVersion("lodash");
    expect(
      compareSemverCore(version, FLOOR) >= 0,
      `installed lodash ${version} is below the ${FLOOR} security floor — ` +
        `the override was dropped or a reinstall pulled the vulnerable transitive copy`
    ).toBe(true);
  });

  it("has no nested lodash copy below the floor", () => {
    // Defense in depth: the override should dedupe to one copy, but a
    // future dependency could install a nested lodash that escapes the
    // top-level resolution. Walk every lodash package.json under
    // node_modules and assert the floor holds for all of them.
    const root = path.resolve(__dirname, "../../../node_modules");
    const matches = (readdirSync(root, { recursive: true }) as string[])
      .filter(
        (rel) =>
          rel.endsWith(`${path.sep}lodash${path.sep}package.json`) ||
          rel === path.join("lodash", "package.json")
      );
    expect(matches.length).toBeGreaterThan(0); // sanity: lodash is installed
    const offenders = matches
      .map((rel) => {
        const v = JSON.parse(
          readFileSync(path.join(root, rel), "utf8")
        ).version as string;
        return { rel, v };
      })
      .filter(({ v }) => compareSemverCore(v, FLOOR) < 0);
    expect(
      offenders,
      `lodash copies below ${FLOOR}: ${JSON.stringify(offenders)}`
    ).toEqual([]);
  });
});
