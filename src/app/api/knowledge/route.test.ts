/**
 * Tests for POST /api/knowledge — directory-import endpoint for RAG.
 *
 * Pinned invariants (PM #6 territory):
 *   - 400 when directory is missing or not a string.
 *   - 400 when subdir doesn't match `/^[a-zA-Z0-9_-]+$/` (defends the
 *     downstream getDbPath against path-traversal).
 *   - Relative directory: must stay inside the knowledge sandbox via
 *     `assertPathInside` — `..` traversal returns 400, never reaches
 *     the importer.
 *   - Absolute directory: ACCEPTED by design (local-first model — single
 *     trusted operator can ingest from any path). Documented in CLAUDE.md
 *     § "🛡 Security Patterns". If we ever multi-tenant this becomes a
 *     P0 — this test is the trip-wire for that future decision.
 *   - Calls `importKnowledge` with the resolved path and (subdir || "main").
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/memory/knowledge", () => ({
  importKnowledge: vi.fn(),
}));

vi.mock("@/lib/storage/settings-store", () => ({
  getSettings: vi.fn(),
}));

import { POST } from "./route";
import { importKnowledge } from "@/lib/memory/knowledge";
import { getSettings } from "@/lib/storage/settings-store";

const mockedImport = vi.mocked(importKnowledge);
const mockedSettings = vi.mocked(getSettings);

beforeEach(() => {
  vi.clearAllMocks();
  mockedSettings.mockResolvedValue({} as any);
  mockedImport.mockResolvedValue({ imported: 3, skipped: 1, errors: [] });
});

function buildPost(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/knowledge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/knowledge — validation", () => {
  it("returns 400 when directory is missing", async () => {
    const res = await POST(buildPost({}));
    expect(res.status).toBe(400);
    expect(mockedImport).not.toHaveBeenCalled();
  });

  it("returns 400 when directory is not a string", async () => {
    const res = await POST(buildPost({ directory: 42 }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when subdir contains disallowed chars (path-traversal class)", async () => {
    for (const bad of ["../evil", "with space", "a/b", "a$b", "a.b"]) {
      const res = await POST(buildPost({ directory: "/tmp/data", subdir: bad }));
      expect(res.status, `subdir=${bad}`).toBe(400);
    }
    expect(mockedImport).not.toHaveBeenCalled();
  });

  it("accepts subdir matching /^[a-zA-Z0-9_-]+$/", async () => {
    const res = await POST(
      buildPost({ directory: "/tmp/data", subdir: "valid_name-123" })
    );
    expect(res.status).toBe(200);
    expect(mockedImport).toHaveBeenCalledWith("/tmp/data", "valid_name-123", expect.any(Object));
  });
});

describe("POST /api/knowledge — relative path sandboxing (PM #6)", () => {
  it("relative `..` traversal returns 400 (never reaches importer)", async () => {
    const res = await POST(
      buildPost({ directory: "../../etc", subdir: "main" })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid directory/i);
    expect(mockedImport).not.toHaveBeenCalled();
  });

  it("relative path inside knowledge sandbox is accepted", async () => {
    const res = await POST(
      buildPost({ directory: "alpha", subdir: "main" })
    );
    expect(res.status).toBe(200);
    expect(mockedImport).toHaveBeenCalledOnce();
    const [resolvedDir] = mockedImport.mock.calls[0];
    expect(resolvedDir).toContain("/data/knowledge/alpha");
  });
});

describe("POST /api/knowledge — absolute path (local-first design choice)", () => {
  it("absolute path is forwarded to importer verbatim (documented in CLAUDE.md)", async () => {
    // This is INTENTIONAL per CLAUDE.md § "🛡 Security Patterns" — a
    // single trusted operator can ingest from any directory on their own
    // machine. If Orchestra ever multi-tenants, this branch becomes a P0.
    // The test stays as the trip-wire.
    const res = await POST(
      buildPost({ directory: "/Users/me/Documents/docs", subdir: "main" })
    );
    expect(res.status).toBe(200);
    expect(mockedImport).toHaveBeenCalledWith(
      "/Users/me/Documents/docs",
      "main",
      expect.any(Object)
    );
  });
});

describe("POST /api/knowledge — happy path + subdir defaults", () => {
  it("defaults subdir to 'main' when not provided", async () => {
    await POST(buildPost({ directory: "/tmp/data" }));
    expect(mockedImport).toHaveBeenCalledWith("/tmp/data", "main", expect.any(Object));
  });

  it("returns the importer's result verbatim", async () => {
    mockedImport.mockResolvedValue({
      imported: 5,
      skipped: 2,
      errors: ["Error processing weird.bin"],
    });
    const res = await POST(buildPost({ directory: "/tmp/data" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      imported: 5,
      skipped: 2,
      errors: ["Error processing weird.bin"],
    });
  });

  it("returns 500 with sanitized error message when importer throws", async () => {
    mockedImport.mockRejectedValue(new Error("disk full"));
    const res = await POST(buildPost({ directory: "/tmp/data" }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/disk full/);
  });
});
