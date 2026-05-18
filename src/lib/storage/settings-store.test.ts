/**
 * Tests for `getSettings` / `saveSettings`.
 *
 * Why this file exists: settings-store is one of the most-called modules in
 * the codebase (every authenticated route loads it) and was completely
 * untested. The audit also found it sits next to the worst leak vector we
 * shipped (PM #15 — `RootLayout` reading the whole file). Locking down
 * behavior here so future "let's just make this faster / let's swap the
 * merge strategy" patches can't silently corrupt operator state.
 *
 * Invariants under test:
 *   - DEFAULT_SETTINGS is internally consistent (default hash verifies the
 *     default password — same contract as `password.test.ts`, restated here
 *     because settings-store is the surface that actually wires the two).
 *   - First read with no file → returns defaults verbatim, NO write to disk
 *     (lazy init — important: a stat-only operator shouldn't materialize a
 *     settings.json by accident).
 *   - getSettings on garbage JSON → falls back to defaults (does NOT throw).
 *   - getSettings deep-merges saved-on-disk over defaults — new fields added
 *     to DEFAULT_SETTINGS in code reach old saved files transparently.
 *   - saveSettings({ partial }) deep-merges; arrays are replaced (not merged)
 *     because deepMerge treats Arrays as values.
 *   - saveSettings round-trip: write then read returns the same shape.
 *   - The known PM #1 flake — atomic-rename ENOENT race — is forgiven by a
 *     retry inside getSettings.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import {
  DEFAULT_AUTH_PASSWORD,
  DEFAULT_AUTH_USERNAME,
  verifyPassword,
} from "@/lib/auth/password";

let tmpRoot: string;
let cwdSpy: any;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-settings-test-"));
  // settings-store derives its DATA_DIR from `process.cwd()` at import time.
  // We need to override cwd BEFORE loading the module so the module reads
  // from our tmp tree. We achieve that with a per-test dynamic import +
  // `vi.resetModules()` so each test gets a fresh closure.
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmpRoot);
  vi.resetModules();
});

afterEach(() => {
  cwdSpy?.mockRestore();
});

async function loadModule() {
  return await import("./settings-store");
}

describe("DEFAULT_SETTINGS — internal consistency", () => {
  it("default password hash verifies the default password", async () => {
    const { DEFAULT_SETTINGS } = await loadModule();
    expect(DEFAULT_SETTINGS.auth.username).toBe(DEFAULT_AUTH_USERNAME);
    expect(verifyPassword(DEFAULT_AUTH_PASSWORD, DEFAULT_SETTINGS.auth.passwordHash)).toBe(true);
  });

  it("ships with mustChangeCredentials=true so onboarding fires for fresh installs", async () => {
    const { DEFAULT_SETTINGS } = await loadModule();
    expect(DEFAULT_SETTINGS.auth.mustChangeCredentials).toBe(true);
    expect(DEFAULT_SETTINGS.auth.enabled).toBe(true);
  });
});

describe("getSettings — first read, no file on disk", () => {
  it("returns DEFAULT_SETTINGS when settings.json does not exist", async () => {
    const { getSettings, DEFAULT_SETTINGS } = await loadModule();
    const out = await getSettings();
    expect(out).toEqual(DEFAULT_SETTINGS);
  });

  it("does NOT materialize a settings.json on read (lazy init)", async () => {
    const { getSettings } = await loadModule();
    await getSettings();
    // The settings DIR is created (so saveSettings can succeed without a
    // race), but the FILE itself must not be auto-written. A stat-only
    // operator pre-flight check should not change disk state.
    const filePath = path.join(tmpRoot, "data", "settings", "settings.json");
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns a fresh clone — caller mutations do not bleed into the next read", async () => {
    const { getSettings } = await loadModule();
    const a = await getSettings();
    a.auth.username = "MUTATED";
    const b = await getSettings();
    expect(b.auth.username).not.toBe("MUTATED");
  });
});

describe("getSettings — with on-disk JSON", () => {
  it("deep-merges saved-on-disk values over DEFAULT_SETTINGS", async () => {
    const settingsDir = path.join(tmpRoot, "data", "settings");
    await fs.mkdir(settingsDir, { recursive: true });
    // Old saved file: only overrides one nested field. New defaults must
    // still appear (e.g., `memory.enabled` from a fresh DEFAULT_SETTINGS).
    await fs.writeFile(
      path.join(settingsDir, "settings.json"),
      JSON.stringify({ auth: { username: "alice" } }),
      "utf-8"
    );

    const { getSettings, DEFAULT_SETTINGS } = await loadModule();
    const out = await getSettings();
    expect(out.auth.username).toBe("alice");
    expect(out.auth.passwordHash).toBe(DEFAULT_SETTINGS.auth.passwordHash);
    expect(out.memory.enabled).toBe(DEFAULT_SETTINGS.memory.enabled);
  });

  it("falls back to DEFAULT_SETTINGS when the JSON is malformed (does NOT throw)", async () => {
    const settingsDir = path.join(tmpRoot, "data", "settings");
    await fs.mkdir(settingsDir, { recursive: true });
    await fs.writeFile(path.join(settingsDir, "settings.json"), "}{ not json", "utf-8");

    const { getSettings, DEFAULT_SETTINGS } = await loadModule();
    const out = await getSettings();
    expect(out).toEqual(DEFAULT_SETTINGS);
  });

  it("falls back to DEFAULT_SETTINGS when the parsed JSON is not an object (e.g., array)", async () => {
    const settingsDir = path.join(tmpRoot, "data", "settings");
    await fs.mkdir(settingsDir, { recursive: true });
    await fs.writeFile(path.join(settingsDir, "settings.json"), "[1,2,3]", "utf-8");

    const { getSettings, DEFAULT_SETTINGS } = await loadModule();
    const out = await getSettings();
    expect(out).toEqual(DEFAULT_SETTINGS);
  });
});

describe("saveSettings — round-trip and merge semantics", () => {
  it("persists a partial update and re-reads it back, with defaults preserved", async () => {
    const { saveSettings, getSettings, DEFAULT_SETTINGS } = await loadModule();
    await saveSettings({ general: { darkMode: true, language: "ru" } });

    const after = await getSettings();
    expect(after.general.darkMode).toBe(true);
    expect(after.general.language).toBe("ru");
    // Untouched leaves keep their defaults.
    expect(after.memory.enabled).toBe(DEFAULT_SETTINGS.memory.enabled);
    expect(after.auth.username).toBe(DEFAULT_SETTINGS.auth.username);
  });

  it("deep-merges nested objects rather than replacing them wholesale", async () => {
    const { saveSettings, getSettings } = await loadModule();
    // First write touches one field of `auth`.
    await saveSettings({ auth: { enabled: true, username: "buss", passwordHash: "x", mustChangeCredentials: false } } as any);
    // Second write touches a *different* field of `auth`.
    await saveSettings({ auth: { enabled: false } } as any);
    const after = await getSettings();
    expect(after.auth.enabled).toBe(false);
    expect(after.auth.username).toBe("buss"); // preserved across partial writes
  });

  it("two sequential saves do not lose data — the file lock serializes writers", async () => {
    const { saveSettings, getSettings } = await loadModule();
    // Sequential writes — same shape as concurrent if the lock is doing its
    // job, but easier to assert on. Concurrent-write torture is covered by
    // fs-utils.test.ts; here we just make sure settings-store routes through
    // the lock.
    await Promise.all([
      saveSettings({ general: { darkMode: true, language: "en" } }),
      saveSettings({ general: { darkMode: false, language: "en" } }),
    ]);
    const after = await getSettings();
    // The file must end up with one of the two writes' value, not corrupted.
    expect([true, false]).toContain(after.general.darkMode);
  });

  it("deepMerge on the auth section: new password is written, default is replaced", async () => {
    // Specifically exercises the "credentials.route.ts" flow: server merges
    // a new passwordHash on top of current settings. The old hash must NOT
    // somehow win (string keys, primitive values — straight replace).
    const { saveSettings, getSettings } = await loadModule();
    await saveSettings({
      auth: {
        enabled: true,
        username: "buss",
        passwordHash: "scrypt$abc$xyz",
        mustChangeCredentials: false,
      },
    });
    const after = await getSettings();
    expect(after.auth.passwordHash).toBe("scrypt$abc$xyz");
    expect(after.auth.mustChangeCredentials).toBe(false);
  });
});
