import { describe, it, expect } from "vitest";

/**
 * Integration tests that hit the running dev server.
 * These verify the actual HTTP endpoints respond correctly.
 *
 * Prerequisites: `npm run dev` must be running on localhost:3000.
 * When the server is NOT running — or :3000 is occupied by an unrelated
 * app (any Next.js dev server defaults to this port; verified via the
 * /api/health `product` marker) — all tests gracefully skip instead of
 * failing against the wrong server.
 */

const BASE_URL = "http://127.0.0.1:3000";

/** Wrapper around fetch that returns null when the server is unreachable. */
async function safeFetch(
  url: string,
  init?: RequestInit
): Promise<Response | null> {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Server not running or timeout — caller should skip
    return null;
  }
}

/**
 * Port 3000 is the default for EVERY Next.js dev server, so "something
 * responds" does not mean "Orchestra responds" — a foreign app answers
 * these routes with 404s and turns every assertion below into noise.
 * Probe `/api/health` once and require the `product: "Orchestra"` marker;
 * unreachable or foreign both mean skip, same as "server not running".
 * Status is deliberately ignored here: a degraded-but-real Orchestra must
 * NOT skip — its failures are exactly what this suite exists to surface.
 */
const orchestraDetected: Promise<boolean> = (async () => {
  const res = await safeFetch(`${BASE_URL}/api/health`);
  if (!res) return false;
  try {
    const data = (await res.json()) as { product?: string };
    return data?.product === "Orchestra";
  } catch {
    return false;
  }
})();

describe("API Integration Tests", () => {
  describe("Health Check API", () => {
    it("should respond with 200 and subsystem statuses", async () => {
      if (!(await orchestraDetected)) return; // No Orchestra on :3000 — skip
      const res = await safeFetch(`${BASE_URL}/api/health`);
      if (!res) return; // Server not running — skip

      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data).toHaveProperty("status");
      expect(data).toHaveProperty("subsystems");
      expect(typeof data.subsystems).toBe("object");
    }, 10000);
  });

  describe("Chat API", () => {
    it("should reject POST without a message (returns 400 or 401 if auth required)", async () => {
      if (!(await orchestraDetected)) return; // No Orchestra on :3000 — skip
      const res = await safeFetch(`${BASE_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId: "test-empty" }),
      });
      if (!res) return; // Server not running — skip

      // 400 = message validation failed, 401 = auth required before validation
      expect([400, 401]).toContain(res.status);
    }, 10000);

    it("should accept a valid background message and return queued status (or 401 if auth required)", async () => {
      if (!(await orchestraDetected)) return; // No Orchestra on :3000 — skip
      const res = await safeFetch(`${BASE_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatId: `integration-test-${Date.now()}`,
          message: "Reply with exactly: PONG",
          background: true,
        }),
      });
      if (!res) return; // Server not running — skip

      if (res.status === 401) {
        // Auth is enabled — integration test cannot proceed without credentials
        return;
      }

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.status).toBe("queued");
    }, 10000);
  });

  describe("Settings API", () => {
    it("should return current settings", async () => {
      if (!(await orchestraDetected)) return; // No Orchestra on :3000 — skip
      const res = await safeFetch(`${BASE_URL}/api/settings`);
      if (!res) return; // Server not running — skip

      if (res.status === 200) {
        const data = await res.json();
        expect(data).toHaveProperty("chatModel");
        expect(data.chatModel).toHaveProperty("provider");
        expect(data.chatModel).toHaveProperty("model");
      } else {
        expect([200, 302, 401]).toContain(res.status);
      }
    }, 10000);
  });

  describe("Dashboard accessibility", () => {
    it("should serve the dashboard page", async () => {
      if (!(await orchestraDetected)) return; // No Orchestra on :3000 — skip
      const res = await safeFetch(`${BASE_URL}/dashboard`);
      if (!res) return; // Server not running — skip

      expect([200, 302, 307, 308]).toContain(res.status);
    }, 10000);
  });
});
