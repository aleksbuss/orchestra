/**
 * PM #28 regression tests — `scrubProcessEnv()` must drop secret-shaped env
 * names before they reach a child process spawned by the agent.
 *
 * Why: in LOCAL-mode installs (the documented primary path in README),
 * Orchestra inherits the operator's full `process.env`. Before PM #28, every
 * Python / Node.js / shell snippet the agent ran could read `os.environ` /
 * `printenv` and exfiltrate `ORCHESTRA_AUTH_SECRET`, `OPENAI_API_KEY`,
 * `GITHUB_TOKEN`, etc. The scrubber blocks secret-shaped names by pattern
 * BEFORE the spread into the spawned `env`.
 *
 * Contract under test:
 *   - dropped: any underscore-bounded token in {KEY, SECRET, TOKEN,
 *     PASSWORD, PASSWD, CREDENTIAL(S), PRIVATE} plus the explicit ALWAYS_SCRUB list.
 *   - preserved: shell-essential vars (PATH, HOME, USER, SHELL, LANG, TZ),
 *     legitimate non-secret names that happen to contain keyword fragments
 *     (KEYBOARD_LAYOUT, HASHTABLE_SIZE, AUTHORIZATION_HEADER).
 *   - overrides win: explicit caller overrides bypass the filter (so a
 *     VIRTUAL_ENV path the agent legitimately needs gets through).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { scrubProcessEnv } from "./code-execution";

describe("PM #28 — scrubProcessEnv", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Start each test with a known-clean baseline — every test owns its env.
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it("drops ORCHESTRA_AUTH_SECRET and other always-scrub names", () => {
    process.env.ORCHESTRA_AUTH_SECRET = "scrypt$abc$def";
    process.env.ORCHESTRA_SESSION_SECRET = "xyz";
    process.env.PATH = "/usr/bin:/bin";

    const out = scrubProcessEnv();

    expect(out.ORCHESTRA_AUTH_SECRET).toBeUndefined();
    expect(out.ORCHESTRA_SESSION_SECRET).toBeUndefined();
    expect(out.PATH).toBe("/usr/bin:/bin");
  });

  it("drops *_API_KEY, *_TOKEN, *_PASSWORD, *_SECRET name shapes", () => {
    process.env.OPENAI_API_KEY = "sk-real-key";
    process.env.ANTHROPIC_API_KEY = "sk-ant-real";
    process.env.GITHUB_TOKEN = "ghp_real";
    process.env.DATABASE_PASSWORD = "p@ssw0rd";
    process.env.AWS_SECRET_ACCESS_KEY = "secret";
    process.env.PATH = "/usr/bin";

    const out = scrubProcessEnv();

    expect(out.OPENAI_API_KEY).toBeUndefined();
    expect(out.ANTHROPIC_API_KEY).toBeUndefined();
    expect(out.GITHUB_TOKEN).toBeUndefined();
    expect(out.DATABASE_PASSWORD).toBeUndefined();
    expect(out.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(out.PATH).toBe("/usr/bin");
  });

  it("drops bare TOKEN, KEY, SECRET, PRIVATE, CREDENTIALS at name boundaries", () => {
    process.env.TOKEN = "x";
    process.env.SECRET = "x";
    process.env.PRIVATE_KEY = "BEGIN RSA";
    process.env.CREDENTIALS = "x";
    process.env.MY_CREDENTIAL = "x";

    const out = scrubProcessEnv();

    expect(out.TOKEN).toBeUndefined();
    expect(out.SECRET).toBeUndefined();
    expect(out.PRIVATE_KEY).toBeUndefined();
    expect(out.CREDENTIALS).toBeUndefined();
    expect(out.MY_CREDENTIAL).toBeUndefined();
  });

  it("preserves shell essentials: PATH, HOME, USER, SHELL, LANG, TZ", () => {
    process.env.PATH = "/usr/bin";
    process.env.HOME = "/home/user";
    process.env.USER = "user";
    process.env.SHELL = "/bin/zsh";
    process.env.LANG = "en_US.UTF-8";
    process.env.TZ = "Europe/Riga";

    const out = scrubProcessEnv();

    expect(out.PATH).toBe("/usr/bin");
    expect(out.HOME).toBe("/home/user");
    expect(out.USER).toBe("user");
    expect(out.SHELL).toBe("/bin/zsh");
    expect(out.LANG).toBe("en_US.UTF-8");
    expect(out.TZ).toBe("Europe/Riga");
  });

  it("preserves legitimate names containing keyword fragments (no underscore boundary)", () => {
    // These names contain keyword *substrings* but no underscore-bounded match
    // — they're real OS / library names that must survive scrubbing.
    process.env.KEYBOARD_LAYOUT = "us";
    process.env.HASHTABLE_SIZE = "1024";
    process.env.MONKEYPATCH = "1";
    process.env.AUTHORIZATION_HEADER = "Bearer ..."; // not _AUTH_ boundary
    process.env.KEYSTONE_VERSION = "v3"; // KEYS is a prefix, not bounded
    process.env.SECRETARY = "alice"; // SECRET in middle without boundary

    const out = scrubProcessEnv();

    expect(out.KEYBOARD_LAYOUT).toBe("us");
    expect(out.HASHTABLE_SIZE).toBe("1024");
    expect(out.MONKEYPATCH).toBe("1");
    expect(out.AUTHORIZATION_HEADER).toBe("Bearer ...");
    // KEYSTONE_VERSION: "KEYS" is followed by "TONE" (no underscore) — passes.
    expect(out.KEYSTONE_VERSION).toBe("v3");
    expect(out.SECRETARY).toBe("alice");
  });

  it("caller overrides bypass the filter (explicit means trusted)", () => {
    process.env.OPENAI_API_KEY = "operator-key"; // would normally be dropped

    const out = scrubProcessEnv({
      // Explicit caller value — they know what they're doing.
      VIRTUAL_ENV: "/tmp/venv",
      // Even a secret-shaped override gets through — it's a deliberate choice.
      MY_TEST_API_KEY: "test-only",
    });

    expect(out.OPENAI_API_KEY).toBeUndefined();
    expect(out.VIRTUAL_ENV).toBe("/tmp/venv");
    expect(out.MY_TEST_API_KEY).toBe("test-only");
  });

});
