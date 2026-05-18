/**
 * Regression guard for the passwordHash-leak audit (PM #15).
 *
 * Earlier `RootLayout` did `await getSettings()` to compute the initial
 * `<html className="dark">` class. Next.js dev-mode RSC instrumentation
 * captures every server-side `fs.readFile` and embeds its return value in
 * the HTML stream. Result: every page using the root layout — including
 * the unauthenticated `/login` route — leaked `data/settings/settings.json`
 * verbatim, including `auth.passwordHash`.
 *
 * The fix moves dark-mode application client-side via a pre-paint script
 * that reads `localStorage`. To make sure no future "let's just read one
 * more thing here" patch accidentally re-introduces the leak vector, this
 * test pins two invariants on the source of `src/app/layout.tsx`:
 *
 *   1. It does NOT import from `@/lib/storage/settings-store` (the only
 *      function that loads the auth-bearing settings file).
 *   2. It does NOT contain a literal `getSettings(` callsite — covers the
 *      "import via re-export" case.
 *
 * These are intentionally text-level checks. They're cheap, and they
 * survive refactors better than a render-time assertion against the JSX
 * tree (RSC + async server components are awkward to render in vitest).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const LAYOUT_FILE = path.resolve(__dirname, "layout.tsx");

describe("PM #15 — RootLayout must not read settings server-side", () => {
  const source = fs.readFileSync(LAYOUT_FILE, "utf-8");

  it("does not import from @/lib/storage/settings-store", () => {
    // Allow the substring to appear inside a /* … */ comment that explains
    // the historical bug. The check below targets the import statement
    // itself, not any prose mentioning the module name.
    const importLine = source.match(
      /^\s*import[\s\S]*?from\s+["']@\/lib\/storage\/settings-store["']/m
    );
    expect(
      importLine,
      "RootLayout must not import settings-store. See PM #15: this is the " +
        "exact path that leaked auth.passwordHash through unauthenticated " +
        "/login HTML in dev mode."
    ).toBeNull();
  });

  it("does not call getSettings(", () => {
    expect(
      source.includes("getSettings("),
      "RootLayout must not call getSettings() — see PM #15."
    ).toBe(false);
  });

  it("uses a client-side dark-mode bootstrap script (no SSR settings dependency)", () => {
    // Sanity check that the fix actually shipped: the bootstrap script must
    // be present, otherwise we've regressed in the OTHER direction (no dark
    // mode at all) and someone will inevitably "re-add the read" to fix it.
    expect(source).toContain("localStorage");
    expect(source).toContain("orchestra-theme");
  });
});
