import { spawn } from "child_process";
import { cliProviderEnv } from "@/lib/security/scrub-env";

export type CliProviderName = "codex-cli" | "gemini-cli";

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface CachedModels {
  expiresAt: number;
  models: { id: string; name: string }[];
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<CliProviderName, CachedModels>();

function commandForProvider(provider: CliProviderName): string {
  if (provider === "codex-cli") {
    return process.env.CODEX_COMMAND || "codex";
  }
  return process.env.GEMINI_CLI_COMMAND || "gemini";
}

function runCommand(
  command: string,
  args: string[],
  provider: CliProviderName,
  timeoutMs = 2_500
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let finished = false;
    let timedOut = false;

    let child;
    try {
      child = spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        // PM #70 — scrub secrets; the CLI keeps only its own auth vars.
        env: cliProviderEnv(provider),
      });
    } catch (error) {
      resolve({
        code: 1,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        timedOut: false,
      });
      return;
    }

    const timer = setTimeout(() => {
      if (!finished) {
        timedOut = true;
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 200_000) stdout = stdout.slice(-200_000);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 200_000) stderr = stderr.slice(-200_000);
    });

    child.on("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({
        code: 1,
        stdout,
        stderr: `${stderr}\n${error instanceof Error ? error.message : String(error)}`.trim(),
        timedOut,
      });
    });

    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b)
  );
}

function collectJsonLikeModels(
  value: unknown,
  matcher: (token: string) => boolean,
  out: Set<string>
): void {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (matcher(trimmed)) out.add(trimmed);
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectJsonLikeModels(entry, matcher, out);
    }
    return;
  }

  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const [key, nested] of Object.entries(record)) {
    if (
      typeof nested === "string" &&
      (key === "id" || key === "model" || key === "name")
    ) {
      const trimmed = nested.trim();
      if (matcher(trimmed)) out.add(trimmed);
    }
    collectJsonLikeModels(nested, matcher, out);
  }
}

function parseFromJsonOutput(raw: string, matcher: (token: string) => boolean): string[] {
  const models = new Set<string>();
  const trimmed = raw.trim();
  if (!trimmed) return [];

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    collectJsonLikeModels(parsed, matcher, models);
  } catch {
    // Try JSONL as a fallback.
    for (const line of trimmed.split(/\r?\n/)) {
      const row = line.trim();
      if (!row || !(row.startsWith("{") || row.startsWith("["))) continue;
      try {
        const parsed = JSON.parse(row) as unknown;
        collectJsonLikeModels(parsed, matcher, models);
      } catch {
        // Ignore malformed JSON lines.
      }
    }
  }

  return uniqueSorted([...models]);
}

function parseWithRegex(raw: string, regex: RegExp): string[] {
  const found: string[] = [];
  for (const match of raw.matchAll(regex)) {
    const token = match[0]?.trim();
    if (token) found.push(token);
  }
  return uniqueSorted(found);
}

// Exported for unit tests (`cli-models.test.ts`). The runtime code path
// only consumes the parsers via `parseCodexModels` / `parseGeminiModels`
// below; tests benefit from poking at the matchers directly to pin the
// shape of valid model ids without going through CLI output.
export function matchesCodexModel(token: string): boolean {
  return /^gpt-[a-z0-9][a-z0-9._-]*$/i.test(token) || /^o[134](?:-[a-z0-9._-]+)?$/i.test(token);
}

export function matchesGeminiModel(token: string): boolean {
  return /^gemini-[a-z0-9][a-z0-9._-]*$/i.test(token);
}

export function parseCodexModels(raw: string): string[] {
  const fromJson = parseFromJsonOutput(raw, matchesCodexModel);
  if (fromJson.length > 0) return fromJson;
  return parseWithRegex(raw, /\b(?:gpt-[a-z0-9][a-z0-9._-]*|o[134](?:-[a-z0-9._-]+)?)\b/gi);
}

export function parseGeminiModels(raw: string): string[] {
  const fromJson = parseFromJsonOutput(raw, matchesGeminiModel);
  if (fromJson.length > 0) return fromJson;
  return parseWithRegex(raw, /\bgemini-[a-z0-9][a-z0-9._-]*\b/gi);
}

function commandCandidates(provider: CliProviderName): string[][] {
  if (provider === "codex-cli") {
    return [
      ["models", "--json"],
      ["models"],
    ];
  }

  return [
    ["models", "--json"],
    ["models", "list", "--json"],
    ["models"],
    ["models", "list"],
  ];
}

function toModelOptions(models: string[]): { id: string; name: string }[] {
  return models.map((id) => ({ id, name: id }));
}

export async function getCliProviderModels(
  provider: CliProviderName,
  fallbackModels: { id: string; name: string }[]
): Promise<{ id: string; name: string }[]> {
  const now = Date.now();
  const cached = cache.get(provider);
  if (cached && cached.expiresAt > now) {
    return cached.models;
  }

  const command = commandForProvider(provider);
  const parse = provider === "codex-cli" ? parseCodexModels : parseGeminiModels;
  const discovered = new Set<string>();

  for (const args of commandCandidates(provider)) {
    const result = await runCommand(command, args, provider);
    if (result.timedOut) continue;

    const combined = `${result.stdout}\n${result.stderr}`.trim();
    if (!combined) continue;

    for (const model of parse(combined)) {
      discovered.add(model);
    }

    if (discovered.size > 0) break;
  }

  const models =
    discovered.size > 0
      ? toModelOptions(uniqueSorted([...discovered]))
      : [...fallbackModels];

  cache.set(provider, {
    models,
    expiresAt: now + CACHE_TTL_MS,
  });

  return models;
}
