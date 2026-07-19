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

  it("true for keys nested deeper — proposerTiers + aggregator.tournamentJudgeModel (recursive)", () => {
    expect(
      settingsHasCleartextKey({ proposerTiers: { frontier: { provider: "anthropic", apiKey: "sk-ant-x" } } })
    ).toBe(true);
    expect(
      settingsHasCleartextKey({ aggregator: { tournamentJudgeModel: { provider: "openai", apiKey: "sk-x" } } })
    ).toBe(true);
    // all tiers keyless (inheriting from the provider env) → false
    expect(
      settingsHasCleartextKey({
        proposerTiers: { fast: { provider: "ollama" }, frontier: { provider: "anthropic", apiKey: "" } },
      })
    ).toBe(false);
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

  it("flags EVERY keyed file (any name, incl. malformed JSON); skips the live file and clean files", async () => {
    await fs.writeFile(
      path.join(dir, "settings.json"), // live file — excluded by name even though keyed
      JSON.stringify({ chatModel: { provider: "openrouter", apiKey: "sk-or-v1-LIVE" } })
    );
    await fs.writeFile(
      path.join(dir, "settings.json.backup-123"),
      JSON.stringify({ chatModel: { provider: "openrouter", apiKey: "sk-or-v1-LEAK" } })
    );
    await fs.writeFile(
      path.join(dir, "settings.json.copy"), // non-backup name must still be caught
      JSON.stringify({ proposerTiers: { frontier: { provider: "anthropic", apiKey: "sk-ant-LEAK" } } })
    );
    await fs.writeFile(
      path.join(dir, "settings.json.broken"), // malformed JSON hiding a key (trailing comma)
      '{ "chatModel": { "apiKey": "sk-or-v1-BROKEN", } '
    );
    await fs.writeFile(
      path.join(dir, "settings.json.bak-456"),
      JSON.stringify({ chatModel: { provider: "ollama" } }) // clean
    );
    await fs.writeFile(path.join(dir, "readme.txt"), "no secrets here"); // clean non-JSON

    const hits = await findKeyedSiblings(dir);
    expect(hits).toEqual([
      "settings.json.backup-123",
      "settings.json.broken",
      "settings.json.copy",
    ]);
  });

  it("returns [] for a missing directory", async () => {
    expect(await findKeyedSiblings(path.join(dir, "does-not-exist"))).toEqual([]);
  });
});
