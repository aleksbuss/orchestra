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
    const env = cliProviderEnv("gemini-cli");
    expect(env.GEMINI_API_KEY).toBe("g-gemini");
    expect(env.GOOGLE_API_KEY).toBe("g-google");
    expect(env.OPENAI_API_KEY).toBeUndefined(); // foreign provider key dropped
    expect(env.ORCHESTRA_AUTH_SECRET).toBeUndefined();
  });
});
