/**
 * Tests for GET / POST /api/external/token — manage the API token used
 * by /api/external/message.
 *
 * Pinned invariants:
 *   - GET reports `source: "stored" | "env" | "none"` so the UI can
 *     differentiate "operator generated a token via UI" from "token comes
 *     from .env" from "no token at all."
 *   - GET returns the masked token only — never the raw secret.
 *   - POST generates a new token via crypto.randomBytes (we sanity-check
 *     prefix + length elsewhere) and persists it. The response includes
 *     the FULL token ONCE (so the operator can copy it) — that's the
 *     intentional one-time exposure.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/storage/external-api-token-store", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/storage/external-api-token-store")
  >("@/lib/storage/external-api-token-store");
  return {
    ...actual,
    getExternalApiTokenStatus: vi.fn(),
    saveExternalApiToken: vi.fn(),
  };
});

import { GET, POST } from "./route";
import {
  generateExternalApiToken,
  getExternalApiTokenStatus,
  maskExternalApiToken,
  saveExternalApiToken,
} from "@/lib/storage/external-api-token-store";

const mockedStatus = vi.mocked(getExternalApiTokenStatus);
const mockedSave = vi.mocked(saveExternalApiToken);

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("GET /api/external/token — source resolution", () => {
  it("source='stored' when a token has been generated via the UI", async () => {
    mockedStatus.mockResolvedValue({
      configured: true,
      maskedToken: "orches****abcd",
      updatedAt: "2026-05-09T10:00:00.000Z",
    });

    const res = await GET();
    const body = await res.json();
    expect(body.configured).toBe(true);
    expect(body.source).toBe("stored");
    expect(body.maskedToken).toBe("orches****abcd");
    expect(body.updatedAt).toBe("2026-05-09T10:00:00.000Z");
  });

  it("source='env' when only EXTERNAL_API_TOKEN env is set (fallback path)", async () => {
    mockedStatus.mockResolvedValue({
      configured: false,
      maskedToken: null,
      updatedAt: null,
    });
    vi.stubEnv("EXTERNAL_API_TOKEN", "orchestra_ext_envtokenenvtokenenvtokenenvtoken1234");

    const res = await GET();
    const body = await res.json();
    expect(body.configured).toBe(true);
    expect(body.source).toBe("env");
    // Masked, not raw.
    expect(body.maskedToken).toBe(
      maskExternalApiToken(
        "orchestra_ext_envtokenenvtokenenvtokenenvtoken1234"
      )
    );
    // updatedAt is null for env tokens (we don't know when they were set).
    expect(body.updatedAt).toBeNull();
  });

  it("source='none' when nothing is configured anywhere (fresh install)", async () => {
    mockedStatus.mockResolvedValue({
      configured: false,
      maskedToken: null,
      updatedAt: null,
    });
    vi.stubEnv("EXTERNAL_API_TOKEN", "");

    const res = await GET();
    const body = await res.json();
    expect(body.configured).toBe(false);
    expect(body.source).toBe("none");
    expect(body.maskedToken).toBeNull();
  });

  it("never returns the RAW env token in the masked response", async () => {
    mockedStatus.mockResolvedValue({
      configured: false,
      maskedToken: null,
      updatedAt: null,
    });
    const raw = "orchestra_ext_DO-NOT-LEAK-aaaaaaaaaaaaaaaaaaaaaaaaa";
    vi.stubEnv("EXTERNAL_API_TOKEN", raw);

    const res = await GET();
    const text = await res.text();
    expect(text).not.toContain("DO-NOT-LEAK");
  });

  it("stored token wins over env when both present (matches handle-external-message logic)", async () => {
    mockedStatus.mockResolvedValue({
      configured: true,
      maskedToken: "stored****",
      updatedAt: "2026-05-09T10:00:00.000Z",
    });
    vi.stubEnv("EXTERNAL_API_TOKEN", "envtoken-should-not-show");

    const res = await GET();
    const body = await res.json();
    expect(body.source).toBe("stored");
    expect(body.maskedToken).toBe("stored****");
    expect(JSON.stringify(body)).not.toContain("envtoken-should-not-show");
  });
});

describe("POST /api/external/token — generate", () => {
  it("returns 200 with a fresh token + masked variant + persists it", async () => {
    mockedSave.mockResolvedValue(undefined);
    const res = await POST();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.source).toBe("stored");
    expect(typeof body.token).toBe("string");
    expect(body.token.startsWith("orchestra_ext_")).toBe(true);
    expect(body.maskedToken).toBe(maskExternalApiToken(body.token));
    expect(mockedSave).toHaveBeenCalledOnce();
    expect(mockedSave).toHaveBeenCalledWith(body.token);
  });

  it("returns 500 when persistence fails (does NOT leak the new token in the error)", async () => {
    mockedSave.mockRejectedValue(new Error("disk full"));
    const res = await POST();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/disk full/);
    expect(body.token).toBeUndefined();
  });

  it("returns a token with strong entropy (>= 60 hex chars after the prefix)", async () => {
    mockedSave.mockResolvedValue(undefined);
    const res = await POST();
    const body = await res.json();
    const tail = body.token.replace(/^orchestra_ext_/, "");
    expect(tail.length).toBeGreaterThanOrEqual(60);
    expect(tail).toMatch(/^[0-9a-f]+$/);
  });

  it("each invocation generates a unique token", async () => {
    mockedSave.mockResolvedValue(undefined);
    const a = generateExternalApiToken();
    const b = generateExternalApiToken();
    expect(a).not.toBe(b);
  });
});
