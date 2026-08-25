/**
 * `POST /api/integrations/telegram` — authenticate BEFORE reporting config state.
 *
 * This handler is the one route deliberately exempt from the auth middleware
 * (`src/middleware.ts` lets POST through so Telegram can deliver webhooks with a
 * secret-token header instead of a session cookie). That makes the ORDER of its
 * two early returns a security property, not a style question.
 *
 * Before this fix, the "Telegram integration is not configured" 503 ran first,
 * so any anonymous caller could POST an empty body and read the operator's
 * configuration state off the status code — 503 meant "not set up", 401 meant
 * "set up, wrong secret". Confirmed live during the 2026-08-25 audit against a
 * running server.
 *
 * The route is 760 LOC with a dozen storage imports, which is why it had no
 * colocated test at all (2026-06 QA audit, finding F-33). Everything it touches
 * after the auth check is mocked here; these cases deliberately assert only the
 * ordering, and they are worth having on their own — the failure they pin is
 * silent and cannot be seen from the response body.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const runtimeConfig = {
  botToken: "",
  webhookSecret: "",
  defaultProjectId: "",
  allowedUserIds: [] as string[],
};

vi.mock("@/lib/storage/telegram-integration-store", () => ({
  getTelegramIntegrationRuntimeConfig: vi.fn(async () => runtimeConfig),
  consumeTelegramAccessCode: vi.fn(),
  normalizeTelegramUserId: vi.fn((v: unknown) => String(v)),
}));
vi.mock("@/lib/storage/telegram-update-store", () => ({
  claimTelegramUpdate: vi.fn(async () => true),
  releaseTelegramUpdate: vi.fn(),
}));
vi.mock("@/lib/storage/telegram-session-store", () => ({
  createDefaultTelegramSessionId: vi.fn(() => "s"),
  createFreshTelegramSessionId: vi.fn(() => "s"),
  getTelegramChatSessionId: vi.fn(async () => "s"),
  setTelegramChatSessionId: vi.fn(),
}));
vi.mock("@/lib/external/handle-external-message", () => ({
  handleExternalMessage: vi.fn(async () => ({ text: "ok" })),
  ExternalMessageError: class extends Error {},
}));
vi.mock("@/lib/storage/chat-files-store", () => ({ saveChatFile: vi.fn() }));
vi.mock("@/lib/storage/chat-store", () => ({
  createChat: vi.fn(),
  getChat: vi.fn(async () => null),
}));
vi.mock("@/lib/storage/external-session-store", () => ({
  contextKey: vi.fn(() => "k"),
  getOrCreateExternalSession: vi.fn(async () => ({ id: "s", activeChats: {} })),
  saveExternalSession: vi.fn(),
}));
vi.mock("@/lib/storage/project-store", () => ({ getAllProjects: vi.fn(async () => []) }));

import { POST } from "./route";

function post(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost:3000/api/integrations/telegram", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({}),
  });
}

beforeEach(() => {
  runtimeConfig.botToken = "";
  runtimeConfig.webhookSecret = "";
  vi.clearAllMocks();
});

describe("telegram webhook — auth precedes configuration reporting", () => {
  it("nothing configured → 401, NOT a 503 that reveals the install has no Telegram", async () => {
    const res = await POST(post());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
    // The tell that made this an oracle: the word "configured" in an
    // unauthenticated response.
    expect(JSON.stringify(body)).not.toMatch(/configur/i);
  });

  it("secret configured, no header → 401 — indistinguishable from the case above", async () => {
    runtimeConfig.botToken = "123:abc";
    runtimeConfig.webhookSecret = "s3cret";
    const res = await POST(post());
    expect(res.status).toBe(401);
    // Same status AND same body as "not configured at all". That equality IS
    // the fix: an anonymous caller learns nothing either way.
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("secret configured, wrong header → 401", async () => {
    runtimeConfig.botToken = "123:abc";
    runtimeConfig.webhookSecret = "s3cret";
    const res = await POST(post({ "x-telegram-bot-api-secret-token": "wrong!" }));
    expect(res.status).toBe(401);
  });

  it("correct secret but a missing bot token → 503, because the caller is now authenticated", async () => {
    // The configuration report is not deleted, only moved behind the auth
    // check — an operator whose token is missing still gets told why.
    runtimeConfig.botToken = "";
    runtimeConfig.webhookSecret = "s3cret";
    const res = await POST(post({ "x-telegram-bot-api-secret-token": "s3cret" }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/not configured/i);
  });

  it("correct secret and full config → past both gates (400 on the empty body, not 401/503)", async () => {
    runtimeConfig.botToken = "123:abc";
    runtimeConfig.webhookSecret = "s3cret";
    const res = await POST(post({ "x-telegram-bot-api-secret-token": "s3cret" }));
    // `{}` has no `update_id`, which the handler rejects with 400 — proof that
    // a valid caller reaches the real body-validation path.
    expect(res.status).toBe(400);
  });
});
