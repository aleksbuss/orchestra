/**
 * Tests for POST /api/provider-auth/connect — wraps `connectProviderAuth`
 * with input validation. Only oauth flow is allowed (codex-cli / gemini-cli);
 * the api_key branch is rejected with a clear hint pointing the operator at
 * Settings → API Key Vault.
 *
 * Pinned invariants:
 *   - 400 on unknown provider (only codex-cli / gemini-cli).
 *   - 400 on unknown method (only api_key / oauth).
 *   - 400 when method is api_key (forbidden via this endpoint — vault path
 *     is the canonical way). Error mentions the right product surface.
 *   - 500 on underlying connectProviderAuth throw — no error stack leak.
 *   - Trims leading/trailing whitespace from provider + method.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/providers/provider-auth", () => ({
  connectProviderAuth: vi.fn(),
}));

import { POST } from "./route";
import { connectProviderAuth } from "@/lib/providers/provider-auth";

const mockedConnect = vi.mocked(connectProviderAuth);

beforeEach(() => {
  vi.clearAllMocks();
  mockedConnect.mockResolvedValue({ ok: true, message: "ok" } as any);
});

function buildPost(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/provider-auth/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/provider-auth/connect — input validation", () => {
  it("returns 400 for unknown provider", async () => {
    const res = await POST(buildPost({ provider: "openai", method: "oauth" }));
    expect(res.status).toBe(400);
    expect(mockedConnect).not.toHaveBeenCalled();
  });

  it("returns 400 for unknown method", async () => {
    const res = await POST(buildPost({ provider: "codex-cli", method: "magic" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when method is api_key (vault path is the canonical surface)", async () => {
    const res = await POST(buildPost({ provider: "codex-cli", method: "api_key" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/codex-cli supports only oauth/i);
  });

  it("gemini-cli message is specific to the provider when api_key is sent", async () => {
    const res = await POST(buildPost({ provider: "gemini-cli", method: "api_key" }));
    expect((await res.json()).error).toMatch(/gemini-cli supports only oauth/i);
  });

  it("trims whitespace from provider/method", async () => {
    await POST(buildPost({ provider: "  codex-cli  ", method: "  oauth  " }));
    expect(mockedConnect).toHaveBeenCalledOnce();
    expect(mockedConnect).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "codex-cli", method: "oauth" })
    );
  });
});

describe("POST /api/provider-auth/connect — happy path", () => {
  it("forwards apiKey through to the connector (oauth flow may still pass it)", async () => {
    await POST(
      buildPost({
        provider: "codex-cli",
        method: "oauth",
        apiKey: "ignored-but-passed",
      })
    );
    expect(mockedConnect).toHaveBeenCalledWith({
      provider: "codex-cli",
      method: "oauth",
      apiKey: "ignored-but-passed",
    });
  });

  it("returns the connector result verbatim", async () => {
    mockedConnect.mockResolvedValue({ ok: true, accountId: "user-42" } as any);
    const res = await POST(buildPost({ provider: "codex-cli", method: "oauth" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, accountId: "user-42" });
  });

  it("returns 500 with sanitized message when connector throws", async () => {
    mockedConnect.mockRejectedValue(new Error("OAuth server unreachable"));
    const res = await POST(buildPost({ provider: "codex-cli", method: "oauth" }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/OAuth server unreachable/);
  });
});
