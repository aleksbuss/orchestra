/**
 * scrub-secrets — the pure detection helpers. The `main()` migration itself is
 * an fs orchestration over process.cwd() (guarded by `invokedDirectly` so this
 * import doesn't run it); we pin the two exported predicates that decide
 * whether a settings file still leaks a cleartext key.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { settingsHasCleartextKey, findKeyedSiblings } from "./scrub-secrets";

describe("settingsHasCleartextKey", () => {
  it("true when a model / search / providerApiKeys carries a non-empty key", () => {
    expect(
      settingsHasCleartextKey({ chatModel: { provider: "openrouter", apiKey: "sk-or-v1-abc" } })
    ).toBe(true);
    expect(settingsHasCleartextKey({ utilityModel: { provider: "openai", apiKey: "sk-x" } })).toBe(true);
    expect(settingsHasCleartextKey({ search: { provider: "tavily", apiKey: "tvly-x" } })).toBe(true);
    expect(settingsHasCleartextKey({ providerApiKeys: { openai: "sk-x" } })).toBe(true);
  });

  it("false for a scrubbed object — empty keys, keyless local providers, or nothing", () => {
    expect(settingsHasCleartextKey({ chatModel: { provider: "openrouter", apiKey: "" } })).toBe(false);
    expect(settingsHasCleartextKey({ chatModel: { provider: "ollama" } })).toBe(false);
    expect(settingsHasCleartextKey({ providerApiKeys: { openai: "" } })).toBe(false);
    expect(settingsHasCleartextKey({})).toBe(false);
  });
});

describe("findKeyedSiblings", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "scrub-secrets-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("flags only backup/.bak siblings that still hold a key — skips the live file, clean backups, and non-JSON", async () => {
    await fs.writeFile(
      path.join(dir, "settings.json"),
      JSON.stringify({ chatModel: { provider: "openrouter", apiKey: "sk-or-v1-LIVE" } })
    );
    await fs.writeFile(
      path.join(dir, "settings.json.backup-123"),
      JSON.stringify({ chatModel: { provider: "openrouter", apiKey: "sk-or-v1-LEAK" } })
    );
    await fs.writeFile(
      path.join(dir, "settings.json.bak-456"),
      JSON.stringify({ chatModel: { provider: "ollama" } }) // clean
    );
    await fs.writeFile(path.join(dir, "notes.txt"), "sk-or-v1-not-a-backup-name"); // wrong name

    const hits = await findKeyedSiblings(dir);
    // live settings.json excluded by name; clean .bak not flagged; notes.txt not a backup.
    expect(hits).toEqual(["settings.json.backup-123"]);
  });

  it("returns [] for a missing directory", async () => {
    expect(await findKeyedSiblings(path.join(dir, "does-not-exist"))).toEqual([]);
  });
});
