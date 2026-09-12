/**
 * PM #137 — the OpenAI adapter drops OpenRouter's non-standard
 * `delta.reasoning`, so a reasoning model's turn dies with the TTFT watchdog
 * claiming the provider "sent no response". These pin the body-field
 * workaround: what it patches, and — mostly — what it must leave alone.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  disableReasoningInBody,
  withOpenRouterReasoningDisabled,
} from "./openrouter-reasoning";

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
