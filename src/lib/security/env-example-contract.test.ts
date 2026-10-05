/**
 * Contract for the shipped `.env.example` (PM #140).
 *
 * Two defects shipped through this file, and each one defeated a guard we
 * already had:
 *
 *  1. `EXTERNAL_API_TOKEN=orchestra-local-token` — a well-known bearer token on
 *     `/api/external/message`, an endpoint that is exempt from session auth. The
 *     installers only regenerate EMPTY or `changeme`-style values
 *     (`looks_placeholder`), so even `npm run setup:local` left it in place.
 *  2. `OPENAI_API_KEY=sk-...` — credential detection is a truthiness check
 *     (`hasProviderCredential`), so a placeholder counts as a real key: the
 *     PM #101 starter-provider overlay returned null and every model slot stayed
 *     on OpenAI with a bogus credential.
 *
 * Rule: an UNCOMMENTED credential-shaped line in `.env.example` must be empty.
 * A commented example sets nothing, so it is fine.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const CREDENTIAL_KEY = /(SECRET|TOKEN|PASSWORD|API_KEY|CREDENTIAL)/i;

interface Finding {
  key: string;
  value: string;
}

/** Active `KEY=value` lines whose key looks like a credential and whose value is non-empty. */
function nonEmptyCredentialDefaults(envFileText: string): Finding[] {
  const findings: Finding[] = [];
  for (const line of envFileText.split(/\r?\n/)) {
    // A `#` comment never matches: the key group must start with a letter or `_`.
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const [, key, value] = m;
    if (CREDENTIAL_KEY.test(key) && value !== "") findings.push({ key, value });
  }
  return findings;
}

describe("`.env.example` ships no credential (PM #140)", () => {
  it("every uncommented credential-shaped line is empty", () => {
    const text = fs.readFileSync(path.join(process.cwd(), ".env.example"), "utf8");
    expect(nonEmptyCredentialDefaults(text)).toEqual([]);
  });

  it("the checker would have caught both defects that shipped (positive control)", () => {
    const shipped = [
      "OPENAI_API_KEY=sk-...",
      "EXTERNAL_API_TOKEN=orchestra-local-token",
      "ORCHESTRA_AUTH_SECRET=",
    ].join("\n");
    expect(nonEmptyCredentialDefaults(shipped).map((f) => f.key)).toEqual([
      "OPENAI_API_KEY",
      "EXTERNAL_API_TOKEN",
    ]);
  });

  it("ignores commented examples and non-credential settings", () => {
    const text = [
      "# OPENROUTER_API_KEY=sk-or-...",
      "APP_BIND_HOST=127.0.0.1",
      "APP_BASE_URL=http://localhost:3000",
      "TELEGRAM_BOT_TOKEN=",
    ].join("\n");
    expect(nonEmptyCredentialDefaults(text)).toEqual([]);
  });
});
