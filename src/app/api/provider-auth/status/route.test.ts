/**
 * Tests for GET /api/provider-auth/status?provider=...&method=...&hasApiKey=...
 *
 * Same validation gates as the connect route. `hasApiKey` is parsed from
 * a query-string truthy form (1, true, yes) — all other values map to
 * `false` so the operator's "I have a key" intent flows correctly.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/providers/provider-auth", () => ({
  checkProviderAuthStatus: vi.fn(),
}));

import { GET } from "./route";
import { checkProviderAuthStatus } from "@/lib/providers/provider-auth";

const mockedCheck = vi.mocked(checkProviderAuthStatus);

beforeEach(() => {
  vi.clearAllMocks();
  mockedCheck.mockResolvedValue({ ok: true } as any);
});

function buildGet(query: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/provider-auth/status${query}`);
}

describe("GET /api/provider-auth/status — validation", () => {
  it("400 on unknown provider", async () => {
    const res = await GET(buildGet("?provider=openai&method=oauth"));
    expect(res.status).toBe(400);
  });

  it("400 on unknown method", async () => {
    const res = await GET(buildGet("?provider=codex-cli&method=secret"));
    expect(res.status).toBe(400);
  });

  it("400 when method=api_key (api_key flow lives in Settings vault)", async () => {
    const res = await GET(buildGet("?provider=codex-cli&method=api_key"));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/provider-auth/status — hasApiKey parsing", () => {
  it.each([
    ["1", true],
    ["true", true],
    ["yes", true],
    ["0", false],
    ["false", false],
    ["", false],
    ["maybe", false],
  ])("hasApiKey=%s → %s", async (raw, expected) => {
    await GET(
      buildGet(`?provider=codex-cli&method=oauth&hasApiKey=${encodeURIComponent(raw)}`)
    );
    expect(mockedCheck).toHaveBeenCalledWith(
      expect.objectContaining({ hasApiKey: expected })
    );
  });
});

describe("GET /api/provider-auth/status — happy path", () => {
  it("returns the check result verbatim", async () => {
    mockedCheck.mockResolvedValue({ ok: true, account: "user-1" } as any);
    const res = await GET(buildGet("?provider=codex-cli&method=oauth"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, account: "user-1" });
  });

  it("returns 500 on throw", async () => {
    mockedCheck.mockRejectedValue(new Error("auth daemon down"));
    const res = await GET(buildGet("?provider=codex-cli&method=oauth"));
    expect(res.status).toBe(500);
  });
});
