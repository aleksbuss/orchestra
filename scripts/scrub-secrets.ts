/**
 * Migrate cleartext API keys from data/settings/settings.json into a
 * gitignored .env.local, then strip them from the on-disk settings.
 *
 * Usage: npm run scrub:secrets
 *
 * Safe to run multiple times. The settings.json file is rewritten atomically
 * via fs.rename. A timestamped backup is created next to it before any
 * modification: settings.json.backup-<unix-ms>.
 */
import fs from "fs/promises";
import path from "path";

const ROOT = process.cwd();
const SETTINGS_FILE = path.join(ROOT, "data", "settings", "settings.json");
const ENV_LOCAL = path.join(ROOT, ".env.local");

type ProviderName =
  | "openai"
  | "anthropic"
  | "google"
  | "openrouter"
  | "tavily";

const ENV_KEY_BY_PROVIDER: Record<ProviderName, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  tavily: "TAVILY_API_KEY",
};

interface ModelLike {
  provider?: string;
  apiKey?: string;
}

interface SearchLike {
  provider?: string;
  apiKey?: string;
}

interface Settings {
  chatModel?: ModelLike;
  utilityModel?: ModelLike;
  embeddingsModel?: ModelLike;
  search?: SearchLike;
  providerApiKeys?: Record<string, string>;
  [key: string]: unknown;
}

function pickEnvKey(provider: string | undefined): string | null {
  if (!provider) return null;
  const key = ENV_KEY_BY_PROVIDER[provider as ProviderName];
  return key ?? null;
}

function maskKey(key: string): string {
  if (key.length < 8) return "****";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

async function readEnvLocal(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const text = await fs.readFile(ENV_LOCAL, "utf-8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim();
      map.set(k, v);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return map;
}

async function writeEnvLocal(env: Map<string, string>): Promise<void> {
  const sorted = [...env.entries()].sort(([a], [b]) => a.localeCompare(b));
  const body =
    "# Generated/updated by scripts/scrub-secrets.ts. Add your keys here.\n" +
    sorted.map(([k, v]) => `${k}=${v}`).join("\n") +
    "\n";
  await fs.writeFile(ENV_LOCAL, body, "utf-8");
}

async function main(): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(SETTINGS_FILE, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.log(`[scrub-secrets] No settings file at ${SETTINGS_FILE}; nothing to do.`);
      return;
    }
    throw err;
  }

  const settings = JSON.parse(raw) as Settings;
  const env = await readEnvLocal();

  const collected: Array<{ source: string; envKey: string; masked: string }> = [];

  const harvestModel = (label: string, m: ModelLike | undefined) => {
    if (!m?.apiKey) return;
    const envKey = pickEnvKey(m.provider);
    if (!envKey) return;
    const existing = env.get(envKey);
    if (!existing || existing.length === 0) {
      env.set(envKey, m.apiKey);
    }
    collected.push({ source: label, envKey, masked: maskKey(m.apiKey) });
    delete m.apiKey;
  };

  harvestModel("chatModel", settings.chatModel);
  harvestModel("utilityModel", settings.utilityModel);
  harvestModel("embeddingsModel", settings.embeddingsModel);

  if (settings.search?.apiKey && settings.search.provider === "tavily") {
    const envKey = ENV_KEY_BY_PROVIDER.tavily;
    if (!env.get(envKey)) env.set(envKey, settings.search.apiKey);
    collected.push({
      source: "search.tavily",
      envKey,
      masked: maskKey(settings.search.apiKey),
    });
    delete settings.search.apiKey;
  }

  if (settings.providerApiKeys && typeof settings.providerApiKeys === "object") {
    for (const [provider, key] of Object.entries(settings.providerApiKeys)) {
      if (typeof key !== "string" || key.length === 0) continue;
      const envKey = pickEnvKey(provider);
      if (!envKey) continue;
      if (!env.get(envKey)) env.set(envKey, key);
      collected.push({
        source: `providerApiKeys.${provider}`,
        envKey,
        masked: maskKey(key),
      });
    }
    delete settings.providerApiKeys;
  }

  if (collected.length === 0) {
    console.log("[scrub-secrets] No cleartext API keys found in settings.json. Nothing to migrate.");
    return;
  }

  const backup = `${SETTINGS_FILE}.backup-${Date.now()}`;
  await fs.writeFile(backup, raw, "utf-8");
  await writeEnvLocal(env);

  const tmp = `${SETTINGS_FILE}.tmp-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(settings, null, 2), "utf-8");
  await fs.rename(tmp, SETTINGS_FILE);

  console.log("[scrub-secrets] Migrated:");
  for (const c of collected) {
    console.log(`  ${c.source.padEnd(28)} → ${c.envKey} (${c.masked})`);
  }
  console.log(`[scrub-secrets] Backup: ${backup}`);
  console.log(`[scrub-secrets] Updated: ${ENV_LOCAL}`);
  console.log(`[scrub-secrets] settings.json now free of plaintext API keys.`);
  console.log("");
  console.log("⚠  Rotate these keys at the provider — anything ever written to disk in cleartext should be considered exposed.");
  console.log("⚠  The backup above STILL CONTAINS the cleartext keys. Delete it once you've verified the migration — a 'scrubbed' tree with a keyed backup next to it defeats the point of scrubbing.");
}

main().catch((err) => {
  console.error("[scrub-secrets] Failed:", err);
  process.exit(1);
});
