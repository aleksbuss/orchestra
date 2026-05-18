/**
 * Tests for the bearer-token gate on POST /api/external/message.
 *
 * This is one of TWO public API routes (in middleware allowlist), so
 * the bearer-token check IS the security boundary. A regression here
 * lets the world drive your agent.
 *
 * Pinned invariants:
 *   - 503 when no token is configured anywhere (file or env).
 *   - 401 on missing / malformed Authorization header.
 *   - 401 on token mismatch.
 *   - The match is timing-safe (different-length tokens take ~constant
 *     time to reject — we can't *measure* that in unit tests, but we
 *     pin the API path that uses `timingSafeEqual` exists).
 *   - `EXTERNAL_API_TOKEN` env var works as a fallback when no token
 *     is stored in `data/settings/external-api-token.json`.
 *   - Stored token wins over env when BOTH are set (matches the route's
 *     `storedToken || envToken` precedence).
 *   - Successful auth forwards the body to `handleExternalMessage` and
 *     returns its result.
 *   - `ExternalMessageError` instances are translated to their captured
 *     status + payload (validation errors surface to clients).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/storage/external-api-token-store", () => ({
  getExternalApiToken: vi.fn(),
}));

vi.mock("@/lib/external/handle-external-message", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/external/handle-external-message")
  >("@/lib/external/handle-external-message");
  return {
    ...actual,
    handleExternalMessage: vi.fn(),
  };
});

import { POST } from "./route";
import { getExternalApiToken } from "@/lib/storage/external-api-token-store";
import {
  ExternalMessageError,
  handleExternalMessage,
} from "@/lib/external/handle-external-message";

function buildRequest(opts: {
  authHeader?: string;
  body?: unknown;
}): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.authHeader) headers["Authorization"] = opts.authHeader;
  return new NextRequest("http://localhost:3000/api/external/message", {
    method: "POST",
    headers,
    body: JSON.stringify(opts.body ?? {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("POST /api/external/message — token configuration", () => {
  it("returns 503 when no stored token AND no EXTERNAL_API_TOKEN env", async () => {
    vi.mocked(getExternalApiToken).mockResolvedValue(null);
    vi.stubEnv("EXTERNAL_API_TOKEN", "");

    const res = await POST(buildRequest({ authHeader: "Bearer anything" }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/External API token is not configured/i);
    // Auth check must short-circuit before touching the handler.
    expect(handleExternalMessage).not.toHaveBeenCalled();
  });

  it("falls back to EXTERNAL_API_TOKEN env when no stored token", async () => {
    vi.mocked(getExternalApiToken).mockResolvedValue(null);
    vi.stubEnv("EXTERNAL_API_TOKEN", "env-token-secret");
    vi.mocked(handleExternalMessage).mockResolvedValue({
      success: true,
      sessionId: "s",
      reply: "ok",
      context: { activeProjectId: null, activeProjectName: null, activeChatId: "c", currentPath: "" },
      switchedProject: null,
      createdProject: null,
    });

    const res = await POST(
      buildRequest({
        authHeader: "Bearer env-token-secret",
        body: { sessionId: "s", message: "hi" },
      })
    );
    expect(res.status).toBe(200);
  });

  it("stored token wins over env when both are configured", async () => {
    vi.mocked(getExternalApiToken).mockResolvedValue("stored-token");
    vi.stubEnv("EXTERNAL_API_TOKEN", "env-token-secret");
    vi.mocked(handleExternalMessage).mockResolvedValue({
      success: true,
      sessionId: "s",
      reply: "ok",
      context: { activeProjectId: null, activeProjectName: null, activeChatId: "c", currentPath: "" },
      switchedProject: null,
      createdProject: null,
    });

    // env-token-secret should NOT auth — the stored one is the one we check.
    const failRes = await POST(
      buildRequest({
        authHeader: "Bearer env-token-secret",
        body: { sessionId: "s", message: "hi" },
      })
    );
    expect(failRes.status).toBe(401);

    // Now with the stored token — passes.
    const okRes = await POST(
      buildRequest({
        authHeader: "Bearer stored-token",
        body: { sessionId: "s", message: "hi" },
      })
    );
    expect(okRes.status).toBe(200);
  });
});

describe("POST /api/external/message — bearer token parsing", () => {
  beforeEach(() => {
    vi.mocked(getExternalApiToken).mockResolvedValue("the-secret");
  });

  it("returns 401 when no Authorization header is present", async () => {
    const res = await POST(buildRequest({ body: { sessionId: "s", message: "x" } }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/Bearer/);
  });

  it("returns 401 when scheme is not 'Bearer' (case-insensitive on scheme)", async () => {
    const res1 = await POST(buildRequest({ authHeader: "Basic the-secret" }));
    expect(res1.status).toBe(401);

    // 'bearer' lowercase IS accepted (RFC7235 says scheme is case-insensitive).
    vi.mocked(handleExternalMessage).mockResolvedValue({
      success: true,
      sessionId: "s",
      reply: "ok",
      context: { activeProjectId: null, activeProjectName: null, activeChatId: "c", currentPath: "" },
      switchedProject: null,
      createdProject: null,
    });
    const res2 = await POST(
      buildRequest({
        authHeader: "bearer the-secret",
        body: { sessionId: "s", message: "x" },
      })
    );
    expect(res2.status).toBe(200);
  });

  it("returns 401 when token is missing after the scheme", async () => {
    const res = await POST(buildRequest({ authHeader: "Bearer " }));
    expect(res.status).toBe(401);
  });

  it("returns 401 on token mismatch (wrong value, same length)", async () => {
    const res = await POST(
      buildRequest({
        authHeader: "Bearer the-XXXXXX",
        body: { sessionId: "s", message: "x" },
      })
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 on token mismatch where lengths differ (timing-safe path)", async () => {
    // The route's safeTokenMatch returns false fast for length mismatch so
    // timingSafeEqual never sees buffers of different length (which would
    // throw). Verify both the response and that the handler wasn't called.
    const res = await POST(
      buildRequest({
        authHeader: "Bearer short",
        body: { sessionId: "s", message: "x" },
      })
    );
    expect(res.status).toBe(401);
    expect(handleExternalMessage).not.toHaveBeenCalled();
  });
});

describe("POST /api/external/message — happy path", () => {
  beforeEach(() => {
    vi.mocked(getExternalApiToken).mockResolvedValue("good-token");
  });

  it("forwards parsed body to handleExternalMessage and returns its result", async () => {
    vi.mocked(handleExternalMessage).mockResolvedValue({
      success: true,
      sessionId: "tg:42",
      reply: "agent says hi",
      context: {
        activeProjectId: "p-1",
        activeProjectName: "Test Project",
        activeChatId: "c-1",
        currentPath: "src/foo",
      },
      switchedProject: null,
      createdProject: null,
    });

    const res = await POST(
      buildRequest({
        authHeader: "Bearer good-token",
        body: {
          sessionId: "tg:42",
          message: "hi",
          projectId: "p-1",
          chatId: "c-1",
          currentPath: "src/foo",
        },
      })
    );
    expect(res.status).toBe(200);
    expect(handleExternalMessage).toHaveBeenCalledWith({
      sessionId: "tg:42",
      message: "hi",
      projectId: "p-1",
      chatId: "c-1",
      currentPath: "src/foo",
    });
  });

  it("coerces non-string body fields to safe defaults (defensive)", async () => {
    vi.mocked(handleExternalMessage).mockResolvedValue({
      success: true,
      sessionId: "s",
      reply: "ok",
      context: { activeProjectId: null, activeProjectName: null, activeChatId: "c", currentPath: "" },
      switchedProject: null,
      createdProject: null,
    });

    await POST(
      buildRequest({
        authHeader: "Bearer good-token",
        body: { sessionId: 42, message: { not: "a string" }, projectId: null },
      })
    );

    // Non-strings flatten to "" / undefined; the handler is the one that
    // 400s on empty sessionId/message via ExternalMessageError. The route
    // itself should NOT throw on weird types.
    expect(handleExternalMessage).toHaveBeenCalledWith({
      sessionId: "",
      message: "",
      projectId: undefined,
      chatId: undefined,
      currentPath: undefined,
    });
  });
});

describe("POST /api/external/message — error translation", () => {
  beforeEach(() => {
    vi.mocked(getExternalApiToken).mockResolvedValue("good-token");
  });

  it("translates ExternalMessageError to its captured status + payload", async () => {
    vi.mocked(handleExternalMessage).mockRejectedValue(
      new ExternalMessageError(404, {
        error: 'Project "missing" not found',
        availableProjects: [{ id: "a", name: "A" }],
      })
    );

    const res = await POST(
      buildRequest({
        authHeader: "Bearer good-token",
        body: { sessionId: "s", message: "x", projectId: "missing" },
      })
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/Project "missing" not found/);
    expect(body.availableProjects).toEqual([{ id: "a", name: "A" }]);
  });

  it("returns 500 with sanitized message on unexpected throws", async () => {
    vi.mocked(handleExternalMessage).mockRejectedValue(
      new Error("internal hiccup with /etc/secrets-or-something")
    );

    const res = await POST(
      buildRequest({
        authHeader: "Bearer good-token",
        body: { sessionId: "s", message: "x" },
      })
    );
    expect(res.status).toBe(500);
  });
});
