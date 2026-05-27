/**
 * PM #31 regression test — `/api/_debug/chat/<id>` observability endpoint
 * returns the 5 fields the operator needs in one shot: disk state, recent
 * logs scoped to the chat, SSE bus health, active-job presence, uptime.
 *
 * Auth-gating itself is tested via the existing middleware test suite
 * (PM #14 / PM #25 already pin "every /api/* requires session"). This test
 * focuses on the route's payload contract.
 */
import fs from "fs/promises";
import path from "path";
import os from "os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

let tmpDir: string;
let routeModule: typeof import("./route");
let chatStore: typeof import("@/lib/storage/chat-store");

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-debug-"));
  vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
  vi.resetModules();
  routeModule = await import("./route");
  chatStore = await import("@/lib/storage/chat-store");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeReq(): NextRequest {
  return new NextRequest("http://localhost:3000/api/_debug/chat/anything");
}

describe("PM #31 — /api/_debug/chat/<id>", () => {
  it("returns diskState.exists=false for a chatId with no on-disk file", async () => {
    const res = await routeModule.GET(makeReq(), {
      params: Promise.resolve({ id: "nonexistent" }),
    });
    const body = await res.json();
    expect(body.chatId).toBe("nonexistent");
    expect(body.diskState.exists).toBe(false);
    expect(body.recentLogs).toEqual([]);
    expect(body.activeJob.exists).toBe(false);
    expect(typeof body.uptimeSec).toBe("number");
    expect(body.sseBusHealthy).toBe(true);
  });

  it("returns chat metadata + lastMessage preview for an existing chat", async () => {
    // Seed a chat through the public chat-store API.
    const chat = await chatStore.createChat("debug-target", "test chat");
    await chatStore.saveChat({
      ...chat,
      messages: [
        {
          id: "m1",
          role: "user",
          content: "hello world",
          createdAt: new Date().toISOString(),
        },
        {
          id: "m2",
          role: "assistant",
          content: "hi back",
          createdAt: new Date().toISOString(),
        },
      ],
    });
    await chatStore.flushAllPendingChats();

    const res = await routeModule.GET(makeReq(), {
      params: Promise.resolve({ id: "debug-target" }),
    });
    const body = await res.json();
    expect(body.diskState.exists).toBe(true);
    expect(body.diskState.title).toBe("test chat");
    expect(body.diskState.messageCount).toBe(2);
    expect(body.diskState.lastMessage.id).toBe("m2");
    expect(body.diskState.lastMessage.role).toBe("assistant");
    expect(body.diskState.lastMessage.contentPreview).toContain("hi back");
  });

  it("scopes recentLogs to the requested chatId only", async () => {
    // Seed a tiny logs file matching what observability/logger emits.
    const logsDir = path.join(tmpDir, "data", "logs");
    await fs.mkdir(logsDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const file = path.join(logsDir, `orchestra-${today}.jsonl`);
    const lines = [
      JSON.stringify({ ts: "T1", chatId: "wanted", event: "agent_start" }),
      JSON.stringify({ ts: "T2", chatId: "other", event: "agent_start" }),
      JSON.stringify({ ts: "T3", chatId: "wanted", event: "agent_finish" }),
      "this is not json — should be skipped silently",
      JSON.stringify({ ts: "T4", chatId: "wanted", event: "tool_call" }),
    ].join("\n");
    await fs.writeFile(file, lines);

    const res = await routeModule.GET(makeReq(), {
      params: Promise.resolve({ id: "wanted" }),
    });
    const body = await res.json();
    expect(body.recentLogs).toHaveLength(3);
    // Chronological order (the route reverses the per-file backwards scan).
    expect(body.recentLogs.map((l: { event: string }) => l.event)).toEqual([
      "agent_start",
      "agent_finish",
      "tool_call",
    ]);
    // None of "other" leaked into our scope.
    expect(
      body.recentLogs.every((l: { chatId: string }) => l.chatId === "wanted")
    ).toBe(true);
  });

  it("contentPreview is bounded to 240 chars", async () => {
    const longBody = "x".repeat(500);
    const chat = await chatStore.createChat("long-msg", "x");
    await chatStore.saveChat({
      ...chat,
      messages: [
        {
          id: "m1",
          role: "user",
          content: longBody,
          createdAt: new Date().toISOString(),
        },
      ],
    });
    await chatStore.flushAllPendingChats();

    const res = await routeModule.GET(makeReq(), {
      params: Promise.resolve({ id: "long-msg" }),
    });
    const body = await res.json();
    expect(body.diskState.lastMessage.contentPreview.length).toBe(240);
  });
});
