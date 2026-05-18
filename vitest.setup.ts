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
