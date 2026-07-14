/**
 * Migrate cleartext API keys from data/settings/settings.json into a
 * gitignored .env.local, then strip them from the on-disk settings.
 *
 * Usage: npm run scrub:secrets
 *
 * Safe to run multiple times. The settings.json file is rewritten atomically
 * via fs.rename (old-or-new, never partial), so NO cleartext backup is written
 * to disk — the whole point of scrubbing is defeated by a keyed copy beside it,
 * even a transient one an indexer/rsync/tar could grab in the window. Recovery
 * of the pre-scrub state comes from the migrated keys in .env.local and the
 * data-backups/ snapshots, not a sibling copy.
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
  /** Per-tier proposer models (fast/balanced/frontier/skeptic) — each a keyed ModelConfig. */
  proposerTiers?: Record<string, ModelLike>;
  /** Tournament judge lives under `aggregator`. */
  aggregator?: { tournamentJudgeModel?: ModelLike; [key: string]: unknown };
  [key: string]: unknown;
}

/**
 * True if a settings value still carries a non-empty cleartext key ANYWHERE.
 * Recurses so it catches every key-bearing slot — chatModel/utilityModel/
 * embeddingsModel/search, providerApiKeys values, proposerTiers.{fast,balanced,
 * frontier,skeptic}, aggregator.tournamentJudgeModel, and any slot added later —
 * without enumerating them. An enumerated list rots: the doubt-driven review
 * caught exactly that (proposerTiers + tournamentJudge were being missed).
 */
export function settingsHasCleartextKey(value: unknown): boolean {
  if (value == null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(settingsHasCleartextKey);
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (key === "apiKey" && typeof v === "string" && v.length > 0) return true;
    if (
      key === "providerApiKeys" &&
      v &&
      typeof v === "object" &&
      Object.values(v as Record<string, unknown>).some((x) => typeof x === "string" && x.length > 0)
    ) {
      return true;
    }
    if (v && typeof v === "object" && settingsHasCleartextKey(v)) return true;
  }
  return false;
}

/** Fallback signature for files that don't JSON-parse (a keyed but malformed file). */
const RAW_KEY_SIGNATURE =
  /"apiKey"\s*:\s*"[^"]+"|sk-or-v1|sk-ant-|sk-[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{20,}/;

/**
 * List EVERY file in `dir` (other than the live settings.json) that still holds
 * a cleartext key. Scans ALL files, not just `*.backup`/`*.bak` — a hand-made
 * `settings.json.copy` / `.old` leaks just the same (doubt-driven review). Uses
 * the structural `settingsHasCleartextKey` when the file parses as JSON, and a
 * raw-text signature when it does NOT (a keyed-but-malformed file must not slip
 * through a swallowed `JSON.parse`). Non-destructive: it names leftovers, never
 * deletes operator-created files (e.g. an intentional auth:reset recovery copy).
 */
export async function findKeyedSiblings(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const hits: string[] = [];
  for (const name of entries) {
    if (name === "settings.json") continue;
    const full = path.join(dir, name);
    let text: string;
    try {
      if (!(await fs.stat(full)).isFile()) continue;
      text = await fs.readFile(full, "utf-8");
    } catch {
      continue; // unreadable / not a regular file
    }
    let keyed: boolean;
    try {
      keyed = settingsHasCleartextKey(JSON.parse(text) as unknown);
    } catch {
      keyed = RAW_KEY_SIGNATURE.test(text); // malformed JSON must not hide a key
    }
    if (keyed) hits.push(name);
  }
  return hits.sort();
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

  // Per-tier proposer models + the tournament judge are keyed ModelConfigs too
  // (doubt-driven review caught these being skipped — they were silently left
  // in settings.json). harvestModel migrates each to its provider's env var and
  // strips the inline key, same as chatModel; an empty/absent key is skipped.
  for (const [tier, m] of Object.entries(settings.proposerTiers ?? {})) {
    harvestModel(`proposerTiers.${tier}`, m);
  }
  harvestModel("aggregator.tournamentJudgeModel", settings.aggregator?.tournamentJudgeModel);

  if (collected.length === 0) {
    console.log("[scrub-secrets] No cleartext API keys found in settings.json. Nothing to migrate.");
    return;
  }

  // Keys FIRST: .env.local carries them before settings.json loses them, so a
  // crash between the two writes never drops a key (re-running is idempotent).
  // Then an atomic tmp+rename swaps settings.json in one step (old-or-new, never
  // partial). NO cleartext backup is written — recovery is .env.local +
  // data-backups/, never a keyed sibling (not even a transient one).
  await writeEnvLocal(env);

  const tmp = `${SETTINGS_FILE}.tmp-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(settings, null, 2), "utf-8");
  await fs.rename(tmp, SETTINGS_FILE);

  console.log("[scrub-secrets] Migrated:");
  for (const c of collected) {
    console.log(`  ${c.source.padEnd(28)} → ${c.envKey} (${c.masked})`);
  }
  console.log(`[scrub-secrets] Updated: ${ENV_LOCAL}`);
  console.log(`[scrub-secrets] settings.json scrubbed (no cleartext backup written).`);

  const leftovers = await findKeyedSiblings(path.dirname(SETTINGS_FILE));
  if (leftovers.length > 0) {
    console.log("");
    console.log("⚠  These files in data/settings/ STILL contain cleartext keys — delete them before sharing the tree:");
    for (const name of leftovers) console.log(`     ${name}`);
  }

  console.log("");
  console.log("⚠  Rotate these keys at the provider — anything ever written to disk in cleartext should be considered exposed.");
}

const invokedDirectly =
  process.argv[1]?.endsWith("scrub-secrets.ts") ||
  process.argv[1]?.endsWith("scrub-secrets.js");
if (invokedDirectly) {
  main().catch((err) => {
    console.error("[scrub-secrets] Failed:", err);
    process.exit(1);
  });
}
