/**
 * Regression guard for PM #14: middleware.ts must live at `src/middleware.ts`,
 * NOT at the project root. With a `src/` directory, Next.js only picks up
 * middleware from inside `src/`. A root-level `middleware.ts` is SILENTLY
 * IGNORED — every request bypasses auth enforcement.
 *
 * This test exists because the bug took ~5 minutes of auditing to find but
 * could have lived undetected indefinitely: unit tests imported the module
 * directly via `@/middleware` path-alias, so they "passed" without proving
 * Next.js was actually invoking it. Detection only happened during a manual
 * `curl` end-to-end audit.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("PM #14 — middleware.ts location", () => {
  const projectRoot = path.resolve(__dirname, "..");

  it("middleware.ts exists at src/middleware.ts", () => {
    const expected = path.join(projectRoot, "src", "middleware.ts");
    expect(
      fs.existsSync(expected),
      "Next.js needs middleware in src/ when src/ directory is used. " +
        "Restore src/middleware.ts before next deploy — without it every " +
        "/api/* route is unauthenticated."
    ).toBe(true);
  });

  it("no stray middleware.ts at project root (would be silently ignored)", () => {
    const wrongLocation = path.join(projectRoot, "middleware.ts");
    expect(
      fs.existsSync(wrongLocation),
      "A root-level middleware.ts is ignored by Next.js when src/ is in " +
        "use. If you need it at root, ALSO remove src/. Otherwise move it " +
        "to src/middleware.ts. See POST_MORTEMS.md PM #14."
    ).toBe(false);
  });

  it("src/middleware.ts exports a `config.matcher`", async () => {
    // Sanity check: matcher must be present, otherwise Next.js doesn't know
    // which paths to gate. The contract is already there in the source, but
    // a future "let's clean this up" refactor that drops `config` would
    // silently disable enforcement.
    const mod = await import("./middleware");
    expect(mod.config).toBeDefined();
    expect(mod.config.matcher).toBeDefined();
    expect(Array.isArray(mod.config.matcher) || typeof mod.config.matcher === "string").toBe(
      true
    );
  });
});
