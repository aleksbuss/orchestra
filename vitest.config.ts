import { defineConfig, configDefaults } from 'vitest/config';
import path from 'path';
import react from '@vitejs/plugin-react';

// Coverage thresholds — see CLAUDE.md § "🛡 Security Patterns" and PM #15/#16.
//
// Strategy:
//   - Tight thresholds on the small, high-blast-radius modules whose tests
//     we just wrote (auth, security, the storage helper that owns the path
//     sandbox). A regression that drops their coverage will block CI.
//   - Looser global threshold so the rest of the codebase isn't flooded
//     with red the day this lands. Raise these per-PR as test coverage
//     grows in Sprint 2+.
//
// Run with: `npx vitest run --coverage`
//
// Threshold semantics:
//   - `lines`/`functions`/`statements`/`branches` are percentages 0–100.
//   - Per-file thresholds (under `coverage.thresholds["src/path/file.ts"]`)
//     win over the global block. Use them to pin "this module is critical
//     and must stay tested" without dragging the global up prematurely.
export default defineConfig({
  // `@vitejs/plugin-react` enables the automatic JSX runtime so
  // component test files can use JSX without a top-level `import React`.
  // It only kicks in for `.tsx` / `.jsx` files, so node-only tests are
  // unaffected.
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  },
  test: {
    exclude: [...configDefaults.exclude, 'tests/e2e/**'],
    // Default env is `node` (fast, no DOM). Component tests opt into
    // `happy-dom` via the per-file directive `// @vitest-environment happy-dom`.
    // We picked happy-dom over jsdom for boot speed: ~3x faster cold-start
    // matters when CI runs the suite per-PR.
    setupFiles: ['./vitest.setup.ts'],
    // Deliberate timeout above the 5000ms default. Several auth tests run REAL
    // scrypt key-derivation in loops (password.test.ts, login/credentials route
    // tests). At 5000ms they flaked under full-suite parallel load — and worse
    // under v8 coverage instrumentation, which is exactly the command CI runs
    // (`npm run test:coverage`). 15s is ~3x the observed worst case. Prefer a
    // per-test timeout over raising this further; and never "fix" a real-crypto
    // test by mocking the KDF where the KDF is the unit under test. See QA audit
    // F-01a / F-05.
    testTimeout: 15000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      // Emit the report (and evaluate thresholds) even when a test fails.
      // vitest defaults this to false: a single flaky failure would otherwise
      // suppress lcov.info entirely, taking the coverage gate AND the uploaded
      // CI artifact down along with the failing test. See QA audit F-11.
      reportOnFailure: true,
      // Limit instrumentation to source code, not tests/configs/fixtures.
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        ...configDefaults.coverage.exclude ?? [],
        'src/**/*.test.{ts,tsx}',
        'src/**/__tests__/**',
        'src/**/*.testing.ts',
        'src/types/**',
        // Generated / vendored copies of upstream code.
        'src/lib/vendor/**',
        // Disposable helpers used only by tests.
        'src/lib/agent/daemon.testing.ts',
      ],
      thresholds: {
        // Per-module floors for code where regressions are catastrophic.
        // Scrypt/auth primitive: hash + verify + default-creds detection.
        'src/lib/auth/password.ts': { lines: 90, functions: 100, branches: 80, statements: 90 },
        // Path-sandbox helper — failures here are CVE-class (PM #6, #16).
        'src/lib/storage/fs-utils.ts': { lines: 70, functions: 80, branches: 60, statements: 70 },
        // SSRF guard.
        'src/lib/security/url-guard.ts': { lines: 80, functions: 90, branches: 70, statements: 80 },
        // Rate limiter (PM #13) + session secret guard (PM #12).
        'src/lib/auth/rate-limit.ts': { lines: 85, functions: 100, branches: 80, statements: 85 },
        'src/lib/auth/session.ts': { lines: 60, functions: 70, branches: 50, statements: 60 },
        // Auth gate — the audit found this can have huge holes (PM #14).
        'src/middleware.ts': { lines: 80, functions: 100, branches: 75, statements: 80 },

        // Global floor — tracks MEASURED coverage, not an aspiration.
        // Measured 2026-06 (QA audit F-14): statements 45.7%, branches 83.4%,
        // functions 71.1%, lines 45.7%. The previous "≈9.8%" comment + lines:9
        // floor were stale by ~36 points — coverage grew steadily but the floor
        // never moved, so it had stopped protecting anything (a regression could
        // delete a third of the suite's coverage and still pass). Floors now sit
        // ~3 points under actual: a real regression fails CI, while small
        // run-to-run jitter (corpus-gated skipIf tests in observability/replay)
        // does not. RAISE these in any PR that adds tests; a PR that DELETES
        // tested code without replacing must not be free to lower them.
        lines: 43,
        functions: 68,
        branches: 80,
        statements: 43,
      },
    },
  }
});
