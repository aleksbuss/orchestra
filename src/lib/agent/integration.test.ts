import { describe, it, expect } from "vitest";

/**
 * Integration tests that hit a running Orchestra server.
 * These verify the actual HTTP endpoints respond correctly.
 *
 * Prerequisites: a server must be running at `ORCHESTRA_E2E_BASE_URL`
 * (default `http://127.0.0.1:3000`, i.e. `npm run dev`). When no server is
 * there — or the port is occupied by an unrelated app (any Next.js dev server
 * defaults to 3000; verified via the /api/health `product` marker) — every
 * test below reports as SKIPPED rather than passing vacuously.
 *
 * WHY THE SKIP MUST BE VISIBLE: these tests used to `return` early, which
 * vitest counts as a PASS. In CI nothing listens on :3000, so all five
 * silently "passed" without asserting anything, and the suite total implied
 * coverage that did not exist. `ctx.skip()` puts them in the skipped column
 * where a reader can see they did not run. Do not revert this to a bare
 * `return` — a test that cannot run must never look like a test that passed.
 */

/**
 * Overridable so the suite can be pointed at a production build on another
 * port (`ORCHESTRA_E2E_BASE_URL=http://localhost:3100 npx vitest run …`)
 * instead of only ever reaching whatever happens to hold :3000. A stale dev
 * server on the default port once failed this suite while a clean build of
 * the same commit was healthy — with the URL hardcoded there was no way to
 * tell those two apart without editing the test.
 */
const BASE_URL = process.env.ORCHESTRA_E2E_BASE_URL ?? "http://127.0.0.1:3000";

/** Minimal shape of the vitest test context used here. */
type SkippableContext = { skip: (note?: string) => void };

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

/** Skip (visibly) unless a real Orchestra is answering at BASE_URL. */
async function requireOrchestra(ctx: SkippableContext): Promise<void> {
  if (!(await orchestraDetected)) {
    ctx.skip(`no Orchestra at ${BASE_URL}`);
  }
}

describe("API Integration Tests", () => {
  describe("Health Check API", () => {
    it("should respond with 200 and subsystem statuses", async (ctx) => {
      await requireOrchestra(ctx);
      const res = await safeFetch(`${BASE_URL}/api/health`);
      if (!res) {
        ctx.skip("server became unreachable mid-run");
        return;
      }

      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data).toHaveProperty("status");
      expect(data).toHaveProperty("subsystems");
      expect(typeof data.subsystems).toBe("object");
    }, 10000);
  });

  describe("Chat API", () => {
    it("should reject POST without a message (returns 400 or 401 if auth required)", async (ctx) => {
      await requireOrchestra(ctx);
      const res = await safeFetch(`${BASE_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId: "test-empty" }),
      });
      if (!res) {
        ctx.skip("server became unreachable mid-run");
        return;
      }

      // 400 = message validation failed, 401 = auth required before validation
      expect([400, 401]).toContain(res.status);
    }, 10000);

    it("should accept a valid background message and return queued status (or 401 if auth required)", async (ctx) => {
      await requireOrchestra(ctx);
      const res = await safeFetch(`${BASE_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatId: `integration-test-${Date.now()}`,
          message: "Reply with exactly: PONG",
          background: true,
        }),
      });
      if (!res) {
        ctx.skip("server became unreachable mid-run");
        return;
      }

      if (res.status === 401) {
        // Auth is enabled — this test cannot proceed without credentials, and
        // that is a skip, not a pass: nothing about the queue path was checked.
        ctx.skip("auth enabled; no credentials available to this suite");
        return;
      }

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.status).toBe("queued");
    }, 10000);
  });

  describe("Settings API", () => {
    it("should return current settings", async (ctx) => {
      await requireOrchestra(ctx);
      const res = await safeFetch(`${BASE_URL}/api/settings`);
      if (!res) {
        ctx.skip("server became unreachable mid-run");
        return;
      }

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
    it("should serve the dashboard page", async (ctx) => {
      await requireOrchestra(ctx);
      const res = await safeFetch(`${BASE_URL}/dashboard`);
      if (!res) {
        ctx.skip("server became unreachable mid-run");
        return;
      }

      expect([200, 302, 307, 308]).toContain(res.status);
    }, 10000);
  });
});
