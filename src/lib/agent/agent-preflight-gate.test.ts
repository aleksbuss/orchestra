/**
 * Structural security gate (Sprint 4 — guarded AgentSession, PM #58).
 *
 * PM #58 was a P0 data-egress leak: the Privacy-Mode air-gap
 * (`assertPrivacyModeAllowsSettings`) was applied at the interactive `runAgent`
 * but FORGOTTEN at `runAgentText` (cron + the unauthenticated Telegram webhook)
 * and `runSubordinateAgent` — so those paths shipped user prompts to cloud
 * vendors while the UI showed Privacy Mode ON. The root shape: a cross-cutting
 * guard hand-copied at N entry points, where a new/forgotten copy inherits ZERO
 * guards.
 *
 * Sprint 4 folded settings acquisition + the air-gap into a single
 * `resolveGuardedAgentSettings()` (`agent-privacy.ts`), so the guard fires
 * INSIDE acquisition and can't be skipped. This gate keeps it that way: NO
 * agent-layer module may import `getSettings` directly — and thus acquire
 * settings that bypass the air-gap — except the guarded helper's own home. A
 * new `runAgent`-like function MUST call `resolveGuardedAgentSettings()`, not
 * bare `getSettings()`.
 *
 * A human-run "did you remember the guard?" review is the exact control that
 * gets skipped under deadline pressure (it's what PM #58 hit). This makes it a
 * CI gate instead — the same posture as `no-raw-process-env.test.ts` and
 * `abort-contract.test.ts`.
 *
 * If an agent-layer module ever needs to read settings for a genuinely
 * NON-model reason (there are currently zero such cases), add it to ALLOWLIST
 * with a comment explaining why the air-gap does not apply.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = "src/lib/agent";

// The single agent-layer module allowed to import getSettings — it wraps the
// call together with the air-gap in `resolveGuardedAgentSettings`.
const ALLOWLIST = new Set([path.normalize("src/lib/agent/agent-privacy.ts")]);

// Matches a named import of `getSettings` from the settings-store, single- OR
// multi-line (the negated class spans newlines). Comments can't match because
// they won't carry the full `from "@/lib/storage/settings-store"` clause.
const GET_SETTINGS_IMPORT_RE =
  /import\s*\{[^}]*\bgetSettings\b[^}]*\}\s*from\s*["']@\/lib\/storage\/settings-store["']/;

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("Sprint 4 / PM #58 — agent settings acquisition must pass the Privacy-Mode air-gap", () => {
  const files = (fs.existsSync(ROOT) ? collectTsFiles(ROOT) : []).filter(
    (f) => !ALLOWLIST.has(path.normalize(f))
  );

  it("scans a non-trivial number of agent files (guards against a broken glob)", () => {
    // A silently-empty scan would make the gate vacuously pass.
    expect(files.length).toBeGreaterThan(10);
  });

  it("no agent-layer module imports getSettings directly (use resolveGuardedAgentSettings)", () => {
    const violations: string[] = [];
    for (const file of files) {
      const src = fs.readFileSync(file, "utf8");
      if (GET_SETTINGS_IMPORT_RE.test(src)) {
        violations.push(file);
      }
    }
    expect(
      violations,
      "An agent-layer module that imports getSettings directly can acquire " +
        "settings WITHOUT the Privacy-Mode air-gap — the PM #58 P0 egress leak. " +
        "Acquire settings via resolveGuardedAgentSettings (agent-privacy.ts) " +
        "instead. If a genuinely non-model read is needed, add the file to " +
        "ALLOWLIST with a justification.\nOffenders:\n" + violations.join("\n")
    ).toEqual([]);
  });
});
