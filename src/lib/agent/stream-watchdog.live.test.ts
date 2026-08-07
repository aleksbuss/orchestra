/**
 * PM #98 — the test that would actually have caught the bug.
 *
 * Everything else about this fix is unit-tested against MOCKS, and mocks are
 * precisely what let round 1 ship broken: the honest-failure path was wired to
 * `onError`, the tests mocked the SDK, and nothing noticed that the real
 * `streamText` never calls `onError` on an abort. A mock of the thing whose
 * behaviour IS the defect proves nothing.
 *
 * So this file uses no mocks at all. It stands up a real `node:http` server
 * that reproduces each failure shape, points the REAL `@ai-sdk/openai` provider
 * and the REAL `streamText` at it, and asserts on wall-clock behaviour:
 *
 *   1. accept the socket, send nothing at all      → the provider headers bound
 *   2. send SSE headers, then never a token        → time-to-first-token
 *   3. send a token, then go silent                → inter-chunk idle
 *   4. send a full answer                          → nothing fires (no false positive)
 *
 * Budgets are milliseconds here, not the production 60s/90s/120s, so the whole
 * file runs in about a second.
 *
 * MUTATION-VERIFIED, because "it passes" is not evidence that it can fail. Each
 * assertion below was confirmed to turn RED when the protection it covers is
 * deliberately broken:
 *
 *   | mutant                                   | test that dies                |
 *   | ---------------------------------------- | ----------------------------- |
 *   | TTFT never armed                         | "ends the turn on the TTFT…"  |
 *   | idle never re-armed on a chunk           | "…dies MID-ANSWER…"           |
 *   | watchdog arms with a 1ms budget          | "…nothing firing" (false pos) |
 *   | stall branch removed from the classifier | "…never as a user cancel…"    |
 *   | headers bound disabled                   | "…never sends headers at all" |
 *   | tool-execution pause removed             | "…SLOW TOOL is not a stall"   |
 *
 * The ONE test here that is deliberately NOT mutation-verifiable is
 * "fires onAbort — and NOT onError or onFinish". No mutation of OUR code can
 * break it, because it does not test our code: it PINS the SDK's abort
 * semantics, which is the exact fact round 1 got wrong. It earns its place by
 * turning red when an `ai` upgrade changes those semantics — which would
 * silently re-open PM #98.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { streamText, tool, stepCountIs } from "ai";
import { z } from "zod";
import { createOpenAI } from "@ai-sdk/openai";
import { createStreamWatchdog } from "./stream-watchdog";
import { createHeadersTimeoutFetch } from "@/lib/providers/fetch-timeout";
import { isStreamStall } from "@/lib/observability/stream-stall";
import { classifyChatError } from "@/lib/observability/classify-error";

type Mode = "no-headers" | "headers-then-silence" | "one-token-then-silence" | "complete";

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  }
});

/** One OpenAI-compatible SSE chunk carrying `text`. */
function sseChunk(text: string): string {
  return `data: ${JSON.stringify({
    id: "1",
    object: "chat.completion.chunk",
    created: 1,
    model: "stall-test",
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  })}\n\n`;
}

/** An SSE chunk carrying a tool call. */
function toolCallChunk(): string {
  return `data: ${JSON.stringify({
    id: "1",
    object: "chat.completion.chunk",
    created: 1,
    model: "stall-test",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "slow_install", arguments: "{}" },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  })}\n\n`;
}

/** The terminating chunk of a step. */
function finishChunk(reason: string): string {
  return `data: ${JSON.stringify({
    id: "1",
    object: "chat.completion.chunk",
    created: 1,
    model: "stall-test",
    choices: [{ index: 0, delta: {}, finish_reason: reason }],
  })}\n\n`;
}

/** A server that fails the way a loaded free-tier endpoint fails. */
async function startServer(mode: Mode): Promise<string> {
  server = createServer((_req, res) => {
    if (mode === "no-headers") return; // socket accepted, nothing ever written
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.flushHeaders();
    if (mode === "headers-then-silence") return; // the PM #98 shape
    res.write(sseChunk("Сегодня в Латвии"));
    if (mode === "one-token-then-silence") return; // died mid-answer
    res.write(sseChunk(" всё спокойно."));
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`;
}

/**
 * Drive the real stack the way `agent.ts` does: watchdog signal, `onChunk`
 * feeding it, `onAbort` as the only listener that fires on an abort.
 */
async function runTurn(
  baseURL: string,
  opts: { ttftMs: number; idleMs: number; headersTimeoutMs: number }
) {
  const provider = createOpenAI({
    apiKey: "test",
    baseURL,
    name: "stalltest",
    fetch: createHeadersTimeoutFetch({ label: "stalltest", timeoutMs: opts.headersTimeoutMs }),
  });
  const watchdog = createStreamWatchdog(undefined, {
    label: "stalltest/model",
    ttftMs: opts.ttftMs,
    idleMs: opts.idleMs,
  });

  let onAbortFired = false;
  let onErrorFired = false;
  let reportedError: unknown = null;
  let onFinishFired = false;
  let streamed = "";
  let thrown: unknown = null;
  const startedAt = Date.now();

  const result = streamText({
    model: provider.chat("stall-test"),
    messages: [{ role: "user", content: "Найди новости из Латвии" }],
    maxRetries: 0, // one attempt — we are measuring the bound, not the retry policy
    abortSignal: watchdog.signal,
    onChunk: ({ chunk }) => {
      watchdog.noteActivity();
      if (chunk.type === "text-delta") streamed += chunk.text;
    },
    onAbort: () => {
      onAbortFired = true;
    },
    onError: ({ error }) => {
      onErrorFired = true;
      reportedError = error;
    },
    onFinish: () => {
      onFinishFired = true;
      watchdog.settle();
    },
  });

  try {
    for await (const _ of result.textStream) void _;
  } catch (err) {
    thrown = err;
  }
  watchdog.settle();

  return {
    elapsedMs: Date.now() - startedAt,
    onAbortFired,
    onErrorFired,
    onFinishFired,
    streamed,
    thrown,
    reportedError,
    stalled: watchdog.stalled,
  };
}

const BUDGETS = { ttftMs: 400, idleMs: 400, headersTimeoutMs: 5000 };

describe("PM #98 live — a provider that accepts the connection and goes silent", () => {
  it("ends the turn on the TTFT bound instead of hanging", async () => {
    const url = await startServer("headers-then-silence");
    const r = await runTurn(url, BUDGETS);

    // The incident was 640387 ms. The bound is what makes that impossible.
    expect(r.elapsedMs).toBeLessThan(3000);
    expect(r.stalled?.orchestraStreamStall).toBe("ttft");
  });

  it("fires onAbort — and NOT onError or onFinish", async () => {
    // The round-1 defect, reproduced against the real SDK rather than argued
    // from its source. Wiring the honest-failure path to `onError` would make
    // it dead code, and this assertion is what says so out loud.
    const url = await startServer("headers-then-silence");
    const r = await runTurn(url, BUDGETS);

    expect(r.onAbortFired).toBe(true);
    expect(r.onErrorFired).toBe(false);
    expect(r.onFinishFired).toBe(false);
  });

  it("classifies as a stall, never as a user cancellation", async () => {
    const url = await startServer("headers-then-silence");
    const r = await runTurn(url, BUDGETS);

    expect(isStreamStall(r.stalled)).toBe(true);
    const payload = classifyChatError(r.stalled);
    expect(payload.kind).toBe("stream_stalled");
    expect(payload.message).not.toMatch(/cancel/i);
  });

  it("catches a stream that dies MID-ANSWER, and keeps what arrived", async () => {
    const url = await startServer("one-token-then-silence");
    const r = await runTurn(url, BUDGETS);

    expect(r.stalled?.orchestraStreamStall).toBe("idle");
    // The text the user was watching is still in hand for `handleStreamAbort`.
    expect(r.streamed).toContain("Сегодня в Латвии");
  });

  it("bounds a socket that never sends headers at all", async () => {
    const url = await startServer("no-headers");
    const r = await runTurn(url, { ttftMs: 5000, idleMs: 5000, headersTimeoutMs: 400 });

    expect(r.elapsedMs).toBeLessThan(3000);
    // The transport bound fired, not the semantic one — different instruments,
    // and `classifyChatError` must tell the same story for both.
    // The transport bound fired, not the semantic one, so `watchdog.stalled`
    // is empty — the two instruments are genuinely independent.
    expect(r.stalled).toBeNull();
    // AND a live-measured asymmetry worth writing down: a TRANSPORT failure is
    // a real stream error, so `onError` DOES fire (an abort does not — see the
    // test above). `textStream` itself never throws in `ai@6`; errors are
    // delivered to `onError` only. Asserting on a `try/catch` around the
    // iteration would silently assert nothing.
    expect(r.thrown).toBeNull();
    expect(r.onErrorFired).toBe(true);
    expect(classifyChatError(r.reportedError).kind).toBe("stream_stalled");
  });
});

describe("PM #98 live — a SLOW TOOL is not a stall", () => {
  it("does not abort a tool that runs far longer than the idle budget", async () => {
    // The single highest-risk behaviour in this change. `install-orchestrator`
    // permits a TEN-MINUTE command; tool execution emits no chunks, so an idle
    // watchdog that keeps counting through it aborts healthy work — a worse bug
    // than the hang being fixed. Until now that was covered only by fake
    // timers. This runs the real SDK tool loop with a real slow tool.
    let call = 0;
    server = createServer((_req, res) => {
      call += 1;
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.flushHeaders();
      if (call === 1) {
        // Step 1: the model asks for the tool and the step ends.
        res.write(toolCallChunk());
        res.write(finishChunk("tool_calls"));
      } else {
        // Step 2, after the tool finally returned: the actual answer.
        res.write(sseChunk("Готово."));
        res.write(finishChunk("stop"));
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const baseURL = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`;

    const provider = createOpenAI({ apiKey: "test", baseURL, name: "stalltest" });
    const watchdog = createStreamWatchdog(undefined, {
      label: "stalltest/model",
      ttftMs: 2000,
      idleMs: 300, // the tool sleeps for 3x this
    });

    const TOOL_MS = 900;
    let streamed = "";
    const result = streamText({
      model: provider.chat("stall-test"),
      messages: [{ role: "user", content: "run it" }],
      maxRetries: 0,
      stopWhen: [stepCountIs(4)],
      tools: {
        slow_install: tool({
          description: "a legitimately slow command",
          inputSchema: z.object({}),
          execute: async () => {
            await new Promise((r) => setTimeout(r, TOOL_MS));
            return "installed";
          },
        }),
      },
      abortSignal: watchdog.signal,
      onChunk: ({ chunk }) => {
        // Exactly the wiring `agent.ts` uses.
        if (chunk.type === "tool-call") watchdog.pauseForToolExecution();
        else watchdog.noteActivity();
        if (chunk.type === "text-delta") streamed += chunk.text;
      },
      onStepFinish: () => watchdog.noteStepBoundary(),
      onFinish: () => watchdog.settle(),
    });

    for await (const _ of result.textStream) void _;
    watchdog.settle();

    expect(watchdog.stalled).toBeNull();
    expect(streamed).toContain("Готово.");
  }, 20000);
});

describe("PM #98 live — no false positives on a healthy stream", () => {
  it("delivers a complete answer with nothing firing", async () => {
    // The bound must never be the reason a good turn fails. Budgets here are
    // 400ms, far tighter than production, so a false positive would be loud.
    const url = await startServer("complete");
    const r = await runTurn(url, BUDGETS);

    expect(r.streamed).toBe("Сегодня в Латвии всё спокойно.");
    expect(r.stalled).toBeNull();
    expect(r.onAbortFired).toBe(false);
    expect(r.thrown).toBeNull();
  });
});
