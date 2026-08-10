/**
 * Structural CI gate: a raw settings slot must never be handed straight to
 * `createModel`.
 *
 * THE DEFECT CLASS (PM #99). `createModel` resolves an API key from exactly two
 * places — an explicit `config.apiKey`, and `process.env[<PROVIDER>_API_KEY]`.
 * It has no access to settings, so it cannot see the Settings → API Keys Vault.
 * Anything that builds a model from a settings slot must therefore run the slot
 * through `resolveWorkerKey` first. Four callsites did not:
 *
 *   - `runAgent`         — gated behind `options.preset !== "custom"`, and
 *                          `PresetTier` has one member, `"custom"`. Dead code.
 *   - `runAgentText`     — no lookup at all (cron / Telegram / external).
 *   - `runSubordinate`   — no lookup at all (delegated runs).
 *   - `buildFinalAnswerPool` — returned the raw slots, so the failover could
 *                          never substitute.
 *
 * All four were invisible to a green suite and to every operator whose key also
 * sat in the environment, because the env fallback covered for them. The bug
 * only surfaces on a machine where the key exists ONLY in the vault — which is
 * what a first-time user who follows the UI ends up with.
 *
 * WHAT THIS GATE CHECKS, precisely: no `createModel(...)` call takes a bare
 * `settings.<slot>` expression as its first argument. That is the exact shape
 * all four defects had, and it is decidable by reading the call.
 *
 * WHAT IT DOES NOT CHECK: whether a config bound to a local variable was
 * resolved somewhere upstream. That needs dataflow, not a scan. This gate
 * therefore catches the shape that actually shipped four times, not every
 * conceivable way to lose a key — claiming otherwise would be the "a green
 * gate proves the property" mistake this file exists to document.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOTS = ["src/lib", "src/app"];

/**
 * `createModel(settings.chatModel, …)` / `createModel(s.utilityModel)` etc.
 * The receiver is matched loosely (any identifier) because the settings object
 * is variously named `settings`, `s`, and `opts.settings` across the tree.
 */
const RAW_SLOT_CALL =
  /createModel\(\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.(chatModel|utilityModel|embeddingsModel|proposerTiers)\b/;

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(full, acc);
    } else if (
      /\.tsx?$/.test(entry.name) &&
      !/\.test\.tsx?$/.test(entry.name) &&
      !/\.integration\.test\.tsx?$/.test(entry.name)
    ) {
      acc.push(full);
    }
  }
  return acc;
}

describe("key-resolution contract — no raw settings slot reaches createModel", () => {
  it("every createModel argument is a resolved config, not a settings slot", () => {
    const offenders: string[] = [];

    for (const root of ROOTS) {
      const abs = path.join(process.cwd(), root);
      if (!fs.existsSync(abs)) continue;
      for (const file of sourceFiles(abs)) {
        const lines = fs.readFileSync(file, "utf8").split("\n");
        lines.forEach((line, i) => {
          if (RAW_SLOT_CALL.test(line)) {
            offenders.push(`${path.relative(process.cwd(), file)}:${i + 1}: ${line.trim()}`);
          }
        });
      }
    }

    expect(offenders).toEqual([]);
  });

  it("the pattern it scans for is the one that shipped (guards against a regex that matches nothing)", () => {
    // A structural gate whose regex silently stops matching degrades in the
    // PASSING direction and is worthless. Pin it against the literal defect.
    expect(RAW_SLOT_CALL.test("  const model = createModel(settings.chatModel, {")).toBe(true);
    expect(RAW_SLOT_CALL.test("createModel(opts.settings.utilityModel)")).toBe(true);
    // And against the fixed shape, so the gate cannot pass by matching nothing.
    expect(RAW_SLOT_CALL.test("const model = createModel(chatModelConfig, {")).toBe(false);
    expect(RAW_SLOT_CALL.test("createModel(resolveWorkerKey(settings.chatModel, settings))")).toBe(
      false
    );
  });
});
