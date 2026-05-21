/**
 * Route-level tests for POST /api/chat — the central endpoint through which
 * every user message flows.
 *
 * Why this file exists: the central chat endpoint had ZERO route-level
 * coverage before this — any refactor to body parsing, background dispatch,
 * or runAgent forwarding could silently break the entire app and only be
 * caught by manual smoke-testing in the browser. The audit (2026-05-20)
 * flagged this as the single highest-ROI test to add.
 *
 * Critical regressions tracked here:
 *   1. Body shape — UI sends `{ chatId, projectId, currentPath, swarmEnabled,
 *      forceSwarm, background, preset, message }` AND the AI SDK transport
 *      sends `{ messages: [...] }` instead of `message`. Both must work; a
 *      regression on either silently breaks the chat.
 *   2. `forceSwarm` plumbing — added 2026-05-20 to override the MoA Router's
 *      classify-as-trivial veto. Must flow body → runAgent options.
 *   3. Background mode (Phase 3 Daemon) — `background: true` must NOT call
 *      runAgent (would block on stream); must call dispatchAgentJob and
 *      return a queued response.
 *   4. AbortSignal binding — `req.signal` must be passed to runAgent so that
 *      a closed browser tab cancels the LLM call (PM #1 P0 outage class).
 *   5. Validation — empty/non-string message returns 400 without touching
 *      runAgent or the chat store.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

// All dependencies are mocked. Integration of the real pipeline is covered
// by the agent + moa + chat-store unit tests respectively.
vi.mock("@/lib/agent/agent", () => ({
  runAgent: vi.fn(),
}));
vi.mock("@/lib/storage/chat-store", () => ({
  createChat: vi.fn(),
  getChat: vi.fn(),
  saveChat: vi.fn(),
}));
vi.mock("@/lib/cron/runtime", () => ({
  ensureCronSchedulerStarted: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/agent/daemon", () => ({
  dispatchAgentJob: vi.fn(),
}));
// Logger is a no-op in tests — we don't want to assert log output here.
vi.mock("@/lib/observability/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  withLogContext: vi.fn(async (_ctx, fn) => fn()),
}));

import { POST } from "./route";
import { runAgent } from "@/lib/agent/agent";
import {
  createChat,
  getChat,
  saveChat,
} from "@/lib/storage/chat-store";
import { dispatchAgentJob } from "@/lib/agent/daemon";

function buildRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Helper: build a fake runAgent return value with the contract the route
 * relies on — `.toUIMessageStreamResponse(opts)` returning a Response.
 */
function fakeRunAgentResult() {
  return {
    toUIMessageStreamResponse: vi.fn((opts: { headers?: Record<string, string> }) => {
      return new Response("stream-body", {
        status: 200,
        headers: opts?.headers,
      });
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getChat).mockResolvedValue(null);
  vi.mocked(createChat).mockResolvedValue(undefined as never);
  vi.mocked(saveChat).mockResolvedValue(undefined as never);
});

describe("POST /api/chat — input validation", () => {
  it("returns 400 when neither `message` nor `messages` is present", async () => {
    const res = await POST(buildRequest({ chatId: "c1" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/message is required/i);
    // The 400 path must NOT spin up the agent or create a chat — those
    // would be wasted work for a malformed request.
    expect(runAgent).not.toHaveBeenCalled();
    expect(createChat).not.toHaveBeenCalled();
  });

  it("returns 400 when `message` is empty string", async () => {
    const res = await POST(buildRequest({ chatId: "c1", message: "" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when `message` is not a string (e.g. number)", async () => {
    const res = await POST(buildRequest({ chatId: "c1", message: 42 }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when `messages` array has no user role entry", async () => {
    const res = await POST(
      buildRequest({
        chatId: "c1",
        messages: [{ role: "assistant", content: "previous reply" }],
      })
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/chat — happy path (interactive mode)", () => {
  it("calls runAgent with the user message and streams the result", async () => {
    vi.mocked(runAgent).mockResolvedValue(fakeRunAgentResult() as never);

    const res = await POST(
      buildRequest({
        chatId: "chat-123",
        message: "Hello world",
      })
    );

    expect(res.status).toBe(200);
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runAgent).mock.calls[0][0].userMessage).toBe("Hello world");
    expect(vi.mocked(runAgent).mock.calls[0][0].chatId).toBe("chat-123");
  });

  it("creates a new chat when chatId is missing", async () => {
    vi.mocked(runAgent).mockResolvedValue(fakeRunAgentResult() as never);

    await POST(buildRequest({ message: "first ever message" }));

    expect(createChat).toHaveBeenCalledTimes(1);
    // First arg is a UUID string — just check shape, not value.
    const newChatId = vi.mocked(createChat).mock.calls[0][0];
    expect(typeof newChatId).toBe("string");
    expect(newChatId.length).toBeGreaterThan(10);
  });

  it("creates a chat if chatId is provided but does not exist on disk", async () => {
    // This is the legitimate "user navigates to a stale URL with deleted chat"
    // path. The route must heal instead of 500ing.
    vi.mocked(getChat).mockResolvedValue(null);
    vi.mocked(runAgent).mockResolvedValue(fakeRunAgentResult() as never);

    await POST(buildRequest({ chatId: "stale-id", message: "hi" }));

    expect(createChat).toHaveBeenCalledWith("stale-id", "New Chat", undefined);
  });

  it("does NOT create a chat when chatId exists on disk", async () => {
    vi.mocked(getChat).mockResolvedValue({
      id: "c1",
      title: "Existing",
      messages: [],
    } as never);
    vi.mocked(runAgent).mockResolvedValue(fakeRunAgentResult() as never);

    await POST(buildRequest({ chatId: "c1", message: "hi" }));

    expect(createChat).not.toHaveBeenCalled();
  });

  it("surfaces X-Chat-Id and X-Trace-Id response headers", async () => {
    vi.mocked(runAgent).mockResolvedValue(fakeRunAgentResult() as never);

    const res = await POST(buildRequest({ chatId: "c1", message: "hi" }));

    // X-Chat-Id pins the stream to a chat regardless of client state.
    expect(res.headers.get("X-Chat-Id")).toBe("c1");
    // X-Trace-Id is a UUID for log correlation (PM #17 / Sprint 3 contract).
    const traceId = res.headers.get("X-Trace-Id");
    expect(traceId).toMatch(/^[0-9a-f-]{36}$/i);
  });
});

describe("POST /api/chat — AI SDK transport format (messages array)", () => {
  // The frontend uses `DefaultChatTransport` which posts `{ messages: [...] }`
  // instead of `{ message: "..." }`. Both shapes must work or the entire
  // useChat()-based UI silently breaks with no backend error.

  it("extracts the last user message from a `messages` array (string content)", async () => {
    vi.mocked(runAgent).mockResolvedValue(fakeRunAgentResult() as never);

    await POST(
      buildRequest({
        chatId: "c1",
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "ack" },
          { role: "user", content: "second — this one should be picked" },
        ],
      })
    );

    expect(vi.mocked(runAgent).mock.calls[0][0].userMessage).toBe(
      "second — this one should be picked"
    );
  });

  it("extracts text from `parts` array when content is structured", async () => {
    vi.mocked(runAgent).mockResolvedValue(fakeRunAgentResult() as never);

    await POST(
      buildRequest({
        chatId: "c1",
        messages: [
          {
            role: "user",
            parts: [
              { type: "text", text: "Hello " },
              { type: "image", url: "ignored.png" },
              { type: "text", text: "world" },
            ],
          },
        ],
      })
    );

    expect(vi.mocked(runAgent).mock.calls[0][0].userMessage).toBe("Hello world");
  });

  it("prefers explicit `message` field over `messages` array if both present", async () => {
    // Defensive: if a client sends both, take the explicit one.
    vi.mocked(runAgent).mockResolvedValue(fakeRunAgentResult() as never);

    await POST(
      buildRequest({
        chatId: "c1",
        message: "explicit",
        messages: [{ role: "user", content: "from messages" }],
      })
    );

    expect(vi.mocked(runAgent).mock.calls[0][0].userMessage).toBe("explicit");
  });
});

describe("POST /api/chat — swarm / forceSwarm flag forwarding", () => {
  // These flags were the source of the 2026-05-20 "Swarm doesn't run" bug.
  // The fix added forceSwarm to bypass the Router's classify-as-trivial veto.
  // These tests pin the body-to-runAgent contract so a future refactor
  // can't silently drop either flag.

  it("forwards swarmEnabled=true to runAgent when explicitly set", async () => {
    vi.mocked(runAgent).mockResolvedValue(fakeRunAgentResult() as never);
    await POST(
      buildRequest({ chatId: "c1", message: "hi", swarmEnabled: true })
    );
    expect(vi.mocked(runAgent).mock.calls[0][0].swarmEnabled).toBe(true);
  });

  it("defaults swarmEnabled to true when omitted (the UI default)", async () => {
    vi.mocked(runAgent).mockResolvedValue(fakeRunAgentResult() as never);
    await POST(buildRequest({ chatId: "c1", message: "hi" }));
    expect(vi.mocked(runAgent).mock.calls[0][0].swarmEnabled).toBe(true);
  });

  it("forwards swarmEnabled=false to runAgent (user explicitly disabled)", async () => {
    vi.mocked(runAgent).mockResolvedValue(fakeRunAgentResult() as never);
    await POST(
      buildRequest({ chatId: "c1", message: "hi", swarmEnabled: false })
    );
    expect(vi.mocked(runAgent).mock.calls[0][0].swarmEnabled).toBe(false);
  });

  it("forwards forceSwarm=true to runAgent (Force Swarm UI toggle on)", async () => {
    vi.mocked(runAgent).mockResolvedValue(fakeRunAgentResult() as never);
    await POST(
      buildRequest({ chatId: "c1", message: "hi", forceSwarm: true })
    );
    expect(vi.mocked(runAgent).mock.calls[0][0].forceSwarm).toBe(true);
  });

  it("normalizes forceSwarm to strictly true — string 'true' must NOT enable it", async () => {
    // Defensive: prevents a sloppy client sending a string from accidentally
    // turning on forceSwarm. The route's `=== true` check enforces this.
    vi.mocked(runAgent).mockResolvedValue(fakeRunAgentResult() as never);
    await POST(
      buildRequest({ chatId: "c1", message: "hi", forceSwarm: "true" })
    );
    expect(vi.mocked(runAgent).mock.calls[0][0].forceSwarm).toBe(false);
  });

  it("defaults forceSwarm to false when omitted", async () => {
    vi.mocked(runAgent).mockResolvedValue(fakeRunAgentResult() as never);
    await POST(buildRequest({ chatId: "c1", message: "hi" }));
    expect(vi.mocked(runAgent).mock.calls[0][0].forceSwarm).toBe(false);
  });
});

describe("POST /api/chat — AbortSignal binding (PM #1)", () => {
  // PM #1 was a P0 outage caused by missing AbortSignal propagation. Every
  // request must pass `req.signal` to runAgent so closing the tab cancels
  // the upstream LLM call.

  it("passes req.signal as abortSignal to runAgent", async () => {
    vi.mocked(runAgent).mockResolvedValue(fakeRunAgentResult() as never);
    const req = buildRequest({ chatId: "c1", message: "hi" });

    await POST(req);

    const passedSignal = vi.mocked(runAgent).mock.calls[0][0].abortSignal;
    // It must be exactly the request's signal — not a fresh AbortController.
    // Identity check: closing the tab on the browser side aborts req.signal,
    // which only cancels runAgent if the same instance was passed through.
    expect(passedSignal).toBe(req.signal);
  });
});

describe("POST /api/chat — background mode (daemon path)", () => {
  // background: true → dispatchAgentJob + immediate 200 response.
  // The daemon path MUST NOT call runAgent (blocking, streams the response).

  it("dispatches a daemon job and returns queued status without calling runAgent", async () => {
    vi.mocked(getChat).mockResolvedValue({
      id: "c1",
      title: "X",
      messages: [],
    } as never);

    const res = await POST(
      buildRequest({
        chatId: "c1",
        message: "do this in the background",
        background: true,
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.status).toBe("queued");
    expect(body.chatId).toBe("c1");
    expect(body.traceId).toMatch(/^[0-9a-f-]{36}$/i);

    // Critical: background path MUST NOT block on runAgent.
    expect(runAgent).not.toHaveBeenCalled();
    expect(dispatchAgentJob).toHaveBeenCalledTimes(1);
  });

  it("persists the user message before dispatching the daemon job", async () => {
    // Otherwise the background worker reads a chat that doesn't have the
    // prompt the user just sent.
    vi.mocked(getChat).mockResolvedValue({
      id: "c1",
      title: "X",
      messages: [],
    } as never);

    await POST(
      buildRequest({
        chatId: "c1",
        message: "background prompt",
        background: true,
      })
    );

    expect(saveChat).toHaveBeenCalledTimes(1);
    const savedChat = vi.mocked(saveChat).mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(savedChat.messages.length).toBe(1);
    expect(savedChat.messages[0].role).toBe("user");
    expect(savedChat.messages[0].content).toBe("background prompt");
  });

  it("background mode propagates swarmEnabled + preset to the dispatched job", async () => {
    vi.mocked(getChat).mockResolvedValue({
      id: "c1",
      title: "X",
      messages: [],
    } as never);

    await POST(
      buildRequest({
        chatId: "c1",
        message: "x",
        background: true,
        swarmEnabled: false,
        preset: "custom",
      })
    );

    const job = vi.mocked(dispatchAgentJob).mock.calls[0][0];
    expect(job.swarmEnabled).toBe(false);
    expect(job.preset).toBe("custom");
  });
});

describe("POST /api/chat — error handling", () => {
  it("returns 500 with a stable shape when runAgent throws", async () => {
    vi.mocked(runAgent).mockRejectedValue(new Error("provider 503"));

    const res = await POST(buildRequest({ chatId: "c1", message: "hi" }));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("provider 503");
    // Trace-id MUST be in the error body for log correlation. Without this,
    // a user reporting "it broke" has no way to point you at the right log.
    expect(body.traceId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("returns 500 with a generic message for non-Error throws", async () => {
    vi.mocked(runAgent).mockRejectedValue("string thrown");

    const res = await POST(buildRequest({ chatId: "c1", message: "hi" }));

    expect(res.status).toBe(500);
    const body = await res.json();
    // Should not crash the route on weird throw values.
    expect(typeof body.error).toBe("string");
    expect(body.traceId).toMatch(/^[0-9a-f-]{36}$/i);
  });
});
