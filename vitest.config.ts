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
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
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

        // Loose global floor: do NOT race to raise this without earning it.
        // Today's numbers reflect what's actually tested as of PM #15/#16:
        // lines ≈9.8%, functions ≈23.4%, statements ≈9.8%, branches ≈64%.
        // The floors below sit ~1 point under those numbers so a small
        // accidental drop fails CI, but the threshold isn't aspirational —
        // it tracks what we have. RAISE these in any PR that adds tests;
        // a PR that DELETES tested code without replacing must not be free
        // to lower these to keep CI green.
        lines: 9,
        functions: 22,
        branches: 50,
        statements: 9,
      },
    },
  }
});
