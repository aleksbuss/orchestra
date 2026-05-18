/**
 * Tests for GET /api/events — the SSE bus that powers the frontend
 * `useBackgroundSync` hook (CLAUDE.md §"🔄 Realtime & Frontend
 * Resilience Contract").
 *
 * Pinned invariants:
 *   - Returns text/event-stream with no-cache headers + `X-Accel-Buffering:
 *     no` (Nginx/proxy buffering would defeat the realtime delivery).
 *   - First frame is `event: ready` — the client uses this to know the
 *     stream is alive. PM #5 reconnect path depends on this.
 *   - Every `publishUiSyncEvent` ends up as a `sync` SSE event on the
 *     stream. Frontend's parser dispatches on the event name.
 *   - Aborting the request (browser tab closed) calls unsubscribe and
 *     closes the controller — without this the subscriber map leaks
 *     (CLAUDE.md MAX_LISTENERS cap is a band-aid for that).
 *   - 15s heartbeat keeps long-lived connections alive through proxies
 *     that drop idle TCP.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

import { GET } from "./route";
import {
  publishUiSyncEvent,
  subscribeUiSyncEvents,
} from "@/lib/realtime/event-bus";

beforeEach(() => {
  vi.useFakeTimers();
  // Clear listener state between tests so subscriber count is deterministic.
  const g = globalThis as typeof globalThis & {
    __ORCHESTRA_UI_SYNC_BUS_STATE__?: { listeners: Map<number, unknown> };
  };
  g.__ORCHESTRA_UI_SYNC_BUS_STATE__?.listeners.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

function listenerCount(): number {
  const g = globalThis as typeof globalThis & {
    __ORCHESTRA_UI_SYNC_BUS_STATE__?: { listeners: Map<number, unknown> };
  };
  return g.__ORCHESTRA_UI_SYNC_BUS_STATE__?.listeners.size ?? 0;
}

function buildRequest(): { req: NextRequest; abort: () => void } {
  const controller = new AbortController();
  const req = new NextRequest("http://localhost:3000/api/events", {
    method: "GET",
    signal: controller.signal,
  });
  return { req, abort: () => controller.abort() };
}

async function readNFrames(
  res: Response,
  expected: number,
  timeoutMs = 200
): Promise<string[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: string[] = [];
  const deadline = Date.now() + timeoutMs;

  while (frames.length < expected && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    frames.push(decoder.decode(value));
  }

  reader.releaseLock();
  return frames;
}

describe("GET /api/events — headers + first frame", () => {
  it("returns text/event-stream with no-cache + X-Accel-Buffering=no", async () => {
    const { req } = buildRequest();
    const res = await GET(req);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    expect(res.headers.get("cache-control")).toMatch(/no-cache/);
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    expect(res.headers.get("connection")).toBe("keep-alive");
  });

  it("first SSE frame is `event: ready` with an ISO timestamp", async () => {
    const { req } = buildRequest();
    const res = await GET(req);
    const frames = await readNFrames(res, 1);
    expect(frames[0]).toMatch(/^event: ready\n/);
    expect(frames[0]).toMatch(/data: \{"at":"\d{4}-\d{2}-\d{2}T/);
  });
});

describe("GET /api/events — sync event delivery", () => {
  it("publishes from the bus arrive as `event: sync` frames", async () => {
    const { req } = buildRequest();
    const res = await GET(req);
    // Read the initial `ready` frame.
    const readerFrames: string[] = [];
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    readerFrames.push(decoder.decode(first.value));

    // Publish; the subscriber inside the route enqueues a 'sync' frame.
    publishUiSyncEvent({
      topic: "chat",
      chatId: "c-1",
      reason: "agent_started",
    });

    const next = await reader.read();
    readerFrames.push(decoder.decode(next.value));

    expect(readerFrames[0]).toMatch(/event: ready/);
    expect(readerFrames[1]).toMatch(/^event: sync\n/);
    expect(readerFrames[1]).toMatch(/"chatId":"c-1"/);
    expect(readerFrames[1]).toMatch(/"reason":"agent_started"/);

    reader.releaseLock();
  });
});

describe("GET /api/events — lifecycle & cleanup", () => {
  it("subscribing to events bumps the bus listener count, abort restores it", async () => {
    const before = listenerCount();
    const { req, abort } = buildRequest();
    const res = await GET(req);
    // Force the stream's start() to run by reading once.
    const reader = res.body!.getReader();
    await reader.read();

    expect(listenerCount()).toBe(before + 1);

    abort();
    // Give microtask queue a chance to run the abort handler.
    await Promise.resolve();
    await Promise.resolve();

    expect(listenerCount()).toBe(before);
    reader.releaseLock();
  });

  it("emits heartbeat comments every 15 seconds (proxy keepalive)", async () => {
    const { req } = buildRequest();
    const res = await GET(req);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // First frame: `ready`.
    await reader.read();

    // Advance fake timers by 15s — heartbeat interval fires.
    vi.advanceTimersByTime(15_000);
    const next = await reader.read();
    const frame = decoder.decode(next.value);
    // Heartbeat is an SSE comment line `: ping ...`
    expect(frame).toMatch(/^: ping \d+/);

    reader.releaseLock();
  });
});
