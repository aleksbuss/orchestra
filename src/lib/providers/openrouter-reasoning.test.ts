/**
 * PM #137 — the OpenAI adapter drops OpenRouter's non-standard
 * `delta.reasoning`, so a reasoning model's turn dies with the TTFT watchdog
 * claiming the provider "sent no response". These pin the body-field
 * workaround: what it patches, and — mostly — what it must leave alone.
 */
import { describe, it, expect, afterEach } from "vitest";
import { generateText } from "ai";
import {
  disableReasoningInBody,
  withOpenRouterReasoningDisabled,
} from "./openrouter-reasoning";
import { createModel } from "@/lib/providers/llm-provider";

const CHAT = JSON.stringify({
  model: "qwen/qwen3.8-flash",
  messages: [{ role: "user", content: "hi" }],
  stream: true,
});

afterEach(() => {
  delete process.env.ORCHESTRA_OPENROUTER_REASONING;
});

describe("disableReasoningInBody", () => {
  it("adds reasoning.enabled=false to a chat-completion body", () => {
    const out = JSON.parse(disableReasoningInBody(CHAT) as string);
    expect(out.reasoning).toEqual({ enabled: false });
    // and changes nothing else
    expect(out.model).toBe("qwen/qwen3.8-flash");
    expect(out.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(out.stream).toBe(true);
  });

  it("leaves an EXISTING reasoning preference alone — a caller can opt back in", () => {
    const explicit = JSON.stringify({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      reasoning: { effort: "high" },
    });
    expect(disableReasoningInBody(explicit)).toBe(explicit);

    const effort = JSON.stringify({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "high",
    });
    expect(disableReasoningInBody(effort)).toBe(effort);
  });

  it("leaves a body with NO messages alone — embeddings are not chat completions", () => {
    const emb = JSON.stringify({ model: "text-embedding-3-small", input: ["a", "b"] });
    expect(disableReasoningInBody(emb)).toBe(emb);
  });

  it("fails safe on anything that is not a JSON object body", () => {
    expect(disableReasoningInBody("not json at all")).toBe("not json at all");
    expect(disableReasoningInBody(JSON.stringify([1, 2, 3]))).toBe(JSON.stringify([1, 2, 3]));
    expect(disableReasoningInBody(JSON.stringify(null))).toBe(JSON.stringify(null));
    const bytes = new Uint8Array([1, 2, 3]);
    expect(disableReasoningInBody(bytes)).toBe(bytes);
    expect(disableReasoningInBody(undefined)).toBe(undefined);
  });
});

describe("withOpenRouterReasoningDisabled", () => {
  function spyFetch() {
    const calls: Array<{ input: unknown; init: RequestInit | undefined }> = [];
    const fn = (async (input: unknown, init?: RequestInit) => {
      calls.push({ input, init });
      return new Response("ok");
    }) as unknown as typeof globalThis.fetch;
    return { fn, calls };
  }

  it("patches the body on the way through to the inner fetch", async () => {
    const { fn, calls } = spyFetch();
    await withOpenRouterReasoningDisabled(fn)("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      body: CHAT,
    });
    expect(JSON.parse(calls[0].init!.body as string).reasoning).toEqual({ enabled: false });
  });

  it("ORCHESTRA_OPENROUTER_REASONING=on ships the body exactly as the SDK built it", async () => {
    process.env.ORCHESTRA_OPENROUTER_REASONING = "on";
    const { fn, calls } = spyFetch();
    await withOpenRouterReasoningDisabled(fn)("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      body: CHAT,
    });
    expect(calls[0].init!.body).toBe(CHAT);
  });

  it("is a strict-string opt-out — a typo does NOT disable the workaround", async () => {
    process.env.ORCHESTRA_OPENROUTER_REASONING = "true";
    const { fn, calls } = spyFetch();
    await withOpenRouterReasoningDisabled(fn)("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      body: CHAT,
    });
    expect(JSON.parse(calls[0].init!.body as string).reasoning).toEqual({ enabled: false });
  });

  it("drops a stale Content-Length once the body has grown", async () => {
    const { fn, calls } = spyFetch();
    await withOpenRouterReasoningDisabled(fn)("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      body: CHAT,
      headers: { "Content-Type": "application/json", "Content-Length": String(CHAT.length) },
    });
    const sent = new Headers(calls[0].init!.headers as HeadersInit);
    expect(sent.get("content-length")).toBeNull();
    expect(sent.get("content-type")).toBe("application/json");
  });

  it("passes a body-less request straight through, headers untouched", async () => {
    const { fn, calls } = spyFetch();
    const init = { method: "GET", headers: { "X-Title": "Orchestra" } };
    await withOpenRouterReasoningDisabled(fn)("https://openrouter.ai/api/v1/models", init);
    expect(calls[0].init).toBe(init);
  });
});

/**
 * End-to-end through the REAL factory. Everything above proves the wrapper
 * works IF it sits on the path; nothing proved that it does, or that the SDK
 * does not build a body the wrapper then declines to touch — it bails out on
 * an existing `reasoning` / `reasoning_effort` key, and the OpenAI adapter is
 * the one component entitled to set the latter.
 *
 * So: real `createModel`, real `generateText`, and assert on the bytes that
 * actually left. The operator's standing direction is that reasoning must
 * never be enabled; this is the only test that can fail if a future provider
 * refactor quietly drops the wrapper.
 */
describe("PM #137 end-to-end — the body that really leaves createModel", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** Stub the network and hand back the outgoing body. */
  function captureOutgoingBody(): () => string {
    let seen: unknown;
    globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
      seen = init?.body;
      return new Response(
        JSON.stringify({
          id: "x",
          object: "chat.completion",
          created: 0,
          model: "qwen/qwen3.8-flash",
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof globalThis.fetch;
    return () => String(seen);
  }

  async function runOneTurn(): Promise<Record<string, unknown>> {
    const body = captureOutgoingBody();
    const model = createModel({
      provider: "openrouter",
      model: "qwen/qwen3.8-flash",
      apiKey: "test-key-not-a-real-one",
    } as never);
    await generateText({ model, prompt: "hi", abortSignal: AbortSignal.timeout(10_000) });
    return JSON.parse(body()) as Record<string, unknown>;
  }

  it("an OpenRouter chat completion carries reasoning.enabled=false", async () => {
    const sent = await runOneTurn();
    expect(sent.reasoning).toEqual({ enabled: false });
    // The bail-out key the adapter could legitimately set. If this ever appears
    // the wrapper goes silent and every reasoning model is a dead turn again.
    expect(sent).not.toHaveProperty("reasoning_effort");
  });

  it("falsifier — with the documented opt-out ON, the field is absent", async () => {
    process.env.ORCHESTRA_OPENROUTER_REASONING = "on";
    const sent = await runOneTurn();
    expect(sent).not.toHaveProperty("reasoning");
  });
});
