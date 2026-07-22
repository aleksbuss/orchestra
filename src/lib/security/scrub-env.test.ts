/**
 * PM #28 / PM #70 — env scrubbing shared by code-execution AND the CLI/install
 * child-process surfaces. A spawned process (agent code, a package post-install
 * hook, an agentic CLI) must never inherit the app auth secret or unrelated
 * providers' keys.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { scrubProcessEnv, cliProviderEnv } from "./scrub-env";

const ORIGINAL = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, ORIGINAL);
});
beforeEach(() => {
  // Hermetic baseline: clear the host env first so assertions can never be
  // masked (or flaked) by whatever the operator's real shell exports —
  // scrubProcessEnv iterates process.env directly.
  for (const k of Object.keys(process.env)) delete process.env[k];
  process.env.PATH = "/usr/bin:/bin";
  process.env.HOME = "/home/op";
  process.env.ORCHESTRA_AUTH_SECRET = "app-secret";
  process.env.OPENAI_API_KEY = "sk-openai";
  process.env.GEMINI_API_KEY = "g-gemini";
  process.env.GOOGLE_API_KEY = "g-google";
  process.env.ANTHROPIC_API_KEY = "sk-anthropic";
  process.env.TAVILY_API_KEY = "tvly-x";
});

describe("scrubProcessEnv", () => {
  it("drops secret-shaped names + the always-scrub list, keeps base env", () => {
    const env = scrubProcessEnv();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ORCHESTRA_AUTH_SECRET).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/home/op");
  });

  it("re-adds explicit overrides bypassing the filter", () => {
    const env = scrubProcessEnv({ OPENAI_API_KEY: "rescued" });
    expect(env.OPENAI_API_KEY).toBe("rescued");
  });

  // The always-scrub list catches names the secret REGEX does not: AUTH and
  // AUTHORIZATION contain none of the regex tokens
  // (KEY/SECRET/TOKEN/PASSWORD/CREDENTIAL/PRIVATE), so they exercise the
  // `ALWAYS_SCRUB_NAMES.has(upper)` branch in isolation — the regex cannot mask
  // a regression here the way it does for ORCHESTRA_*_SECRET (which also matches
  // `_SECRET`).
  it("drops bare AUTH / AUTHORIZATION via the always-scrub list, not the regex", () => {
    process.env.AUTH = "creds";
    process.env.AUTHORIZATION = "Bearer xyz";

    const env = scrubProcessEnv();

    expect(env.AUTH).toBeUndefined();
    expect(env.AUTHORIZATION).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin:/bin"); // base env still passes through
  });

  // Each regex alternation token gets one name that ONLY it can catch (e.g.
  // API_KEYS: the KEY branch fails its boundary on the trailing S, so only
  // KEYS matches; GPG_PRIVATE is the sole PRIVATE-token hit). Deleting any
  // single token from SECRET_ENV_RE leaks its var.
  it("drops every regex token family at its own boundary (KEYS/TOKENS/SECRETS/PASSWORDS/PASSWD/PRIVATE)", () => {
    process.env.API_KEYS = "k1,k2";
    process.env.OAUTH_TOKENS = "t1";
    process.env.CLIENT_SECRETS = "s1";
    process.env.USER_PASSWORDS = "p1";
    process.env.DB_PASSWD = "p2";
    process.env.GPG_PRIVATE = "armored";

    const env = scrubProcessEnv();

    expect(env.API_KEYS).toBeUndefined();
    expect(env.OAUTH_TOKENS).toBeUndefined();
    expect(env.CLIENT_SECRETS).toBeUndefined();
    expect(env.USER_PASSWORDS).toBeUndefined();
    expect(env.DB_PASSWD).toBeUndefined();
    expect(env.GPG_PRIVATE).toBeUndefined();
  });

  // The list is compared against the UPPER-CASED name; a mixed-case
  // `Authorization` only matches after normalisation. Since it carries no regex
  // token, dropping the `toUpperCase()` step would leak it.
  it("upper-cases the name before the always-scrub check (mixed-case Authorization)", () => {
    process.env.Authorization = "Bearer xyz";

    const env = scrubProcessEnv();

    expect(env.Authorization).toBeUndefined();
  });
});

describe("cliProviderEnv — keeps the CLI's OWN auth, drops everything else secret", () => {
  it("codex-cli: keeps OPENAI_API_KEY, drops the auth secret + foreign provider keys", () => {
    const env = cliProviderEnv("codex-cli");
    expect(env.OPENAI_API_KEY).toBe("sk-openai"); // own auth survives
    expect(env.ORCHESTRA_AUTH_SECRET).toBeUndefined(); // app secret never leaks
    expect(env.GEMINI_API_KEY).toBeUndefined(); // foreign provider key dropped
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.TAVILY_API_KEY).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin:/bin"); // base env (→ OAuth files via HOME) kept
  });

  it("gemini-cli: keeps GEMINI/GOOGLE keys, drops OPENAI + the auth secret", () => {
    // Service-account auth: _CREDENTIALS matches the secret regex, so this var
    // reaches the subprocess ONLY via the passthrough list — the assertion
    // below is the only thing protecting that entry.
    process.env.GOOGLE_APPLICATION_CREDENTIALS = "/home/op/sa.json";

    const env = cliProviderEnv("gemini-cli");
    expect(env.GEMINI_API_KEY).toBe("g-gemini");
    expect(env.GOOGLE_API_KEY).toBe("g-google");
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBe("/home/op/sa.json");
    expect(env.OPENAI_API_KEY).toBeUndefined(); // foreign provider key dropped
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.TAVILY_API_KEY).toBeUndefined();
    expect(env.ORCHESTRA_AUTH_SECRET).toBeUndefined();
  });

  // An unset passthrough var must be OMITTED from the result, not added with an
  // undefined value — the `if (value !== undefined)` guard. GOOGLE_APPLICATION_
  // CREDENTIALS is unset in the baseline, so it isolates that branch.
  it("omits an unset passthrough var entirely instead of adding it as undefined", () => {
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

    const env = cliProviderEnv("gemini-cli");

    expect("GOOGLE_APPLICATION_CREDENTIALS" in env).toBe(false);
  });
});
