/**
 * Secret-scrubbing for any agent-spawned child process (PM #28, PM #70).
 *
 * Extracted from code-execution.ts so BOTH the code-execution runtimes AND the
 * install_packages orchestrator share one scrubber — a malicious package's
 * post-install script (`npm`/`brew`/`pip`) runs arbitrary code too, so it must
 * not inherit the operator's `.env` secrets either. Drops underscore-bounded
 * KEY/SECRET/TOKEN/PASSWORD/… names (so `OPENAI_API_KEY`, `TAVILY_API_KEY`,
 * `ANTHROPIC_API_KEY`, … are removed) plus a small explicit list, and keeps
 * everything an installer needs (PATH, HOME, npm_config_*, HOMEBREW_*, …).
 */

const SECRET_ENV_RE =
  /(?:^|_)(?:KEY|KEYS|SECRET|SECRETS|TOKEN|TOKENS|PASSWORD|PASSWORDS|PASSWD|CREDENTIAL|CREDENTIALS|PRIVATE)(?:$|_)/i;
const ALWAYS_SCRUB_NAMES = new Set([
  "ORCHESTRA_AUTH_SECRET",
  "ORCHESTRA_SESSION_SECRET",
  "AUTH",
  "AUTHORIZATION",
]);

/**
 * Override shape on purpose: `NodeJS.ProcessEnv` in this project's typings
 * marks `NODE_ENV` as required, which makes constructing override literals
 * awkward. We accept the looser shape (matches the actual runtime contract
 * of `process.env`), then cast the return back to `NodeJS.ProcessEnv` so
 * callsites that pass into `spawn({ env })` don't need their own casts.
 */
type EnvBag = Record<string, string | undefined>;

export function scrubProcessEnv(overrides: EnvBag = {}): NodeJS.ProcessEnv {
  const safe: EnvBag = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    if (ALWAYS_SCRUB_NAMES.has(upper)) continue;
    if (SECRET_ENV_RE.test(upper)) continue;
    safe[name] = value;
  }
  // Caller-supplied overrides are NOT subject to the filter: a caller that
  // explicitly passes `{ VIRTUAL_ENV: "..." }` knows it's not a secret.
  // The cast is safe — at runtime `process.env` is exactly this shape; the
  // typing mismatch is purely about NODE_ENV being marked required by the
  // augmented @types/node ProcessEnv interface in this codebase.
  return { ...safe, ...overrides } as NodeJS.ProcessEnv;
}

type CliProviderName = "codex-cli" | "gemini-cli";

/**
 * The secret-shaped auth vars each CLI provider legitimately needs in its
 * spawned subprocess. Everything else secret (ORCHESTRA_AUTH_SECRET, OTHER
 * providers' keys) is scrubbed; non-secret vars the CLI needs (PATH, HOME and
 * thus its OAuth files, *_BASE_URL, GOOGLE_CLOUD_PROJECT) pass through
 * `scrubProcessEnv` untouched and don't need listing here.
 */
const CLI_ENV_PASSTHROUGH: Record<CliProviderName, string[]> = {
  "codex-cli": ["OPENAI_API_KEY"],
  "gemini-cli": ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS"],
};

/**
 * Scrubbed env for a spawned CLI model provider (PM #70). The CLI is a trusted
 * operator tool but it's agentic (codex runs code) and agent-reachable, so it
 * must not inherit the app auth secret or unrelated providers' keys — only its
 * OWN auth vars survive, alongside the non-secret base env.
 */
export function cliProviderEnv(provider: CliProviderName): NodeJS.ProcessEnv {
  const overrides: EnvBag = {};
  for (const name of CLI_ENV_PASSTHROUGH[provider]) {
    const value = process.env[name];
    if (value !== undefined) overrides[name] = value;
  }
  return scrubProcessEnv(overrides);
}
