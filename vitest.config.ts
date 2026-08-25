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
    // `data/` is the JSON-on-disk DB + agent-created project workspaces; test files the
    // agent writes there (e.g. data/projects/<id>/**/*.test.ts) must NEVER be collected as
    // Orchestra's own suite — they pollute the run and fail on unresolved imports.
    // `data-backups/**` (a SIBLING of data/, not covered by 'data/**') holds full
    // snapshots of data/, incl. agent-written project test files — exclude it for
    // the same reason: they fail on unresolved imports and pollute the suite.
    // `.claude/**` holds harness worktrees (.claude/worktrees/<task>/ is a full repo
    // checkout — its tests/e2e copies escape the root-anchored 'tests/e2e/**' exclude
    // and crash under vitest); `.stryker-tmp/**` holds Stryker mutation sandboxes
    // (full instrumented copies of src/). Both duplicate the whole suite when present.
    exclude: [
      ...configDefaults.exclude,
      'tests/e2e/**',
      'data/**',
      'data-backups/**',
      '.claude/**',
      '.stryker-tmp/**',
    ],
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
        //
        // Re-measured 2026-08-25 from CI, not from a laptop. Three consecutive
        // green `test:coverage` runs on `ci.yml` (32760345289, 32759718102,
        // 32636809154) reported statements 63.66–63.67, branches 83.12–83.14,
        // functions 83.55–83.56, lines 63.66–63.67 — run-to-run jitter of
        // ±0.02 points, and a local run agreed to within 0.05. The feared
        // corpus-gated `skipIf` variance is NOT points-scale here, so a ~3-point
        // margin is safe rather than optimistic.
        //
        // These had drifted 20 points below actual — the exact failure the
        // previous version of this comment described ("stale by ~36 points …
        // had stopped protecting anything") and instructed future PRs to
        // prevent. It recurred anyway: the suite went 3813 → 4027 tests and the
        // floors never moved, because "RAISE these in any PR" is a convention
        // and nothing enforces it. Treat that as the standing risk, not as
        // solved — and when you next raise these, take the number from CI runs
        // like the ones cited above, not from your machine.
        lines: 60,
        functions: 80,
        branches: 80,
        statements: 60,
      },
    },
  }
});
