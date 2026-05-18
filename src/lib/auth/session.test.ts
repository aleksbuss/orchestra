/**
 * Tests for the production guard around `ORCHESTRA_AUTH_SECRET`. PM #12.
 *
 * Threat: Orchestra ships open-source. The historical fallback secret
 * `"orchestra-default-auth-secret-change-me"` and the .env.example placeholder
 * `"eggent-local-dev-secret"` are public. Any deployment that forgot to set
 * the env var (or copied .env.example unchanged) is forgeable by anyone who
 * read the source.
 *
 * Defense: in `NODE_ENV=production`, refuse to sign or verify tokens when the
 * secret is missing or matches a known-insecure value. In other modes, log a
 * loud warning but allow the fallback so local dev iterations don't require
 * env-var setup.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createSessionToken, verifySessionToken } from "./session";

describe("session secret production guard (PM #12)", () => {
  // Vitest's `vi.spyOn` has a notoriously hard-to-name return type — the
  // method-key generic is filtered through a `Properties<T>` mapped type that
  // resists straightforward parameterization. Test code, narrow scope, no
  // runtime impact: `any` is the pragmatic call here.
  let warnSpy: any;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    // Restore both env vars + the spy. `vi.unstubAllEnvs` reverts every
    // `vi.stubEnv` made during this test, including any `delete`-equivalent.
    vi.unstubAllEnvs();
    warnSpy.mockRestore();
  });

  describe("production refuses insecure values", () => {
    it("throws when secret is missing", async () => {
      vi.stubEnv("ORCHESTRA_AUTH_SECRET", "");
      vi.stubEnv("NODE_ENV", "production");
      await expect(createSessionToken("admin", false)).rejects.toThrow(
        /ORCHESTRA_AUTH_SECRET is missing or set to a known-insecure value/
      );
    });

    it("throws when secret is empty string", async () => {
      vi.stubEnv("ORCHESTRA_AUTH_SECRET", "");
      vi.stubEnv("NODE_ENV", "production");
      await expect(createSessionToken("admin", false)).rejects.toThrow(
        /known-insecure/
      );
    });

    it("throws when secret matches the historical hardcoded fallback", async () => {
      vi.stubEnv(
        "ORCHESTRA_AUTH_SECRET",
        "orchestra-default-auth-secret-change-me"
      );
      vi.stubEnv("NODE_ENV", "production");
      await expect(createSessionToken("admin", false)).rejects.toThrow(
        /known-insecure/
      );
    });

    it("throws when secret matches the .env.example placeholder", async () => {
      vi.stubEnv("ORCHESTRA_AUTH_SECRET", "eggent-local-dev-secret");
      vi.stubEnv("NODE_ENV", "production");
      await expect(createSessionToken("admin", false)).rejects.toThrow(
        /known-insecure/
      );
    });

    it("throws on common low-effort placeholders (change-me, secret, default)", async () => {
      vi.stubEnv("NODE_ENV", "production");
      for (const placeholder of ["change-me", "changeme", "secret", "default"]) {
        vi.stubEnv("ORCHESTRA_AUTH_SECRET", placeholder);
        await expect(createSessionToken("admin", false)).rejects.toThrow(
          /known-insecure/
        );
      }
    });

    it("throws on verifySessionToken too — covers the middleware path", async () => {
      vi.stubEnv("ORCHESTRA_AUTH_SECRET", "");
      vi.stubEnv("NODE_ENV", "production");
      // A well-formed but unsigned-with-this-secret token. Verification must
      // fail loudly, not silently — otherwise a forged cookie would be the
      // shape of "no session" and the middleware would 401 quietly while the
      // operator never realizes their secret is forgeable.
      await expect(verifySessionToken("payload.signature")).rejects.toThrow(
        /known-insecure/
      );
    });
  });

  describe("production accepts a real secret", () => {
    it("signs and verifies successfully with a strong secret", async () => {
      vi.stubEnv("ORCHESTRA_AUTH_SECRET", "Zk9PnH3xvLqR8sM2wT4yA6cE1bN5jU7iD0");
      vi.stubEnv("NODE_ENV", "production");
      const token = await createSessionToken("admin", false);
      expect(typeof token).toBe("string");
      const verified = await verifySessionToken(token);
      expect(verified?.username).toBe("admin");
    });
  });

  describe("development falls back gracefully", () => {
    it("uses the dev fallback when secret is missing in development", async () => {
      vi.stubEnv("ORCHESTRA_AUTH_SECRET", "");
      vi.stubEnv("NODE_ENV", "development");
      const token = await createSessionToken("admin", false);
      expect(typeof token).toBe("string");
      expect(warnSpy).toHaveBeenCalled();
      const message = String(warnSpy.mock.calls[0]?.[0] ?? "");
      expect(message).toMatch(/UNSAFE for any deployment/);
    });

    it("uses the dev fallback when secret is the placeholder in development", async () => {
      vi.stubEnv("ORCHESTRA_AUTH_SECRET", "eggent-local-dev-secret");
      vi.stubEnv("NODE_ENV", "development");
      const token = await createSessionToken("admin", false);
      expect(typeof token).toBe("string");
    });

    it("test environment behaves like development (loud but not fatal)", async () => {
      vi.stubEnv("ORCHESTRA_AUTH_SECRET", "");
      vi.stubEnv("NODE_ENV", "test");
      const token = await createSessionToken("admin", false);
      expect(typeof token).toBe("string");
    });
  });
});
