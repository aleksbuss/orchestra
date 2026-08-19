/**
 * Vitest setup that runs once per test worker.
 *
 * Currently sets up `@testing-library/jest-dom` matchers (`toBeInTheDocument`,
 * `toHaveTextContent`, `toBeVisible`, etc.) so component tests using
 * `@testing-library/react` can assert on DOM state without re-importing
 * the matcher extensions in every file.
 *
 * Only files that opt into a DOM environment via
 * `// @vitest-environment happy-dom` (file-level directive) actually need
 * these matchers — but extending in setup is harmless for non-DOM tests
 * because the import is side-effect-only on the global expect.
 */
import "@testing-library/jest-dom/vitest";

/**
 * Skill auto-install (graphify, binary-gated — see `skill-autoinstall.ts`) is
 * forced OFF for the whole suite so tests are hermetic: otherwise `createProject`
 * would copy the graphify skill on a developer machine that happens to have the
 * CLI on `PATH` and not on CI, and any skill-count assertion would flake by
 * machine. UNCONDITIONAL assignment on purpose — `??=` would inherit a
 * developer's or CI's pre-exported `auto`/`force` and reintroduce exactly the
 * machine-dependence this guards against. A test that needs the install path
 * sets the var explicitly in its own body (which runs after this setup) and
 * restores it.
 */
process.env.ORCHESTRA_SKILL_AUTOINSTALL = "off";
