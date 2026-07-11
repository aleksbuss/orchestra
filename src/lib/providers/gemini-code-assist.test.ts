import { describe, it, expect } from "vitest";
import {
  sanitizeGeminiCodeAssistSchema,
  sanitizeGeminiCodeAssistRequest,
  buildGeminiCodeAssistRequestBody,
  shouldRetryGeminiCodeAssist,
  buildGeminiCodeAssistFallbackBodies,
  unwrapGeminiCodeAssistResponse,
  rewriteGeminiCodeAssistEventData,
  rewriteGeminiCodeAssistSseStream,
  parseGeminiModelMethod,
  extractGeminiCodeAssistProjectId,
  extractGeminiCurrentTierId,
  extractGeminiDefaultAllowedTierId,
  extractGeminiOperationName,
  resolveGeminiCodeAssistPlatform,
} from "./gemini-code-assist";

// ---- stream test helpers ---------------------------------------------------

function streamFromString(s: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(s));
      c.close();
    },
  });
}

async function readStreamToString(s: ReadableStream<Uint8Array>): Promise<string> {
  const reader = s.getReader();
  const dec = new TextDecoder();
  let out = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  out += dec.decode();
  return out;
}

// ---- sanitizeGeminiCodeAssistSchema ---------------------------------------

describe("sanitizeGeminiCodeAssistSchema", () => {
  it("strips blocklisted JSON-schema keywords the Code Assist backend rejects", () => {
    const out = sanitizeGeminiCodeAssistSchema({
      type: "string",
      minLength: 3,
      maxLength: 10,
      pattern: "^a",
      format: "email",
      $schema: "http://json-schema.org/draft-07",
    });
    expect(out).toEqual({ type: "string" });
  });

  it("rewrites `const` to a single-value `enum`", () => {
    expect(sanitizeGeminiCodeAssistSchema({ const: "foo" })).toEqual({ enum: ["foo"] });
  });

  it("collapses a nullable `type` array by dropping \"null\"", () => {
    expect(sanitizeGeminiCodeAssistSchema({ type: ["string", "null"] })).toEqual({ type: "string" });
    expect(
      sanitizeGeminiCodeAssistSchema({ type: ["string", "number", "null"] })
    ).toEqual({ type: ["string", "number"] });
  });

  it("drops additionalProperties unless it is exactly false", () => {
    expect(sanitizeGeminiCodeAssistSchema({ additionalProperties: true })).toEqual({});
    expect(sanitizeGeminiCodeAssistSchema({ additionalProperties: false })).toEqual({
      additionalProperties: false,
    });
  });

  it("recurses into nested properties and arrays", () => {
    const out = sanitizeGeminiCodeAssistSchema({
      type: "object",
      properties: {
        a: { const: 1, pattern: "x" },
        b: { type: ["number", "null"] },
      },
      items: [{ minimum: 0, type: "integer" }],
    });
    expect(out).toEqual({
      type: "object",
      properties: { a: { enum: [1] }, b: { type: "number" } },
      items: [{ type: "integer" }],
    });
  });

  it("returns non-record inputs unchanged", () => {
    expect(sanitizeGeminiCodeAssistSchema("str")).toBe("str");
    expect(sanitizeGeminiCodeAssistSchema(42)).toBe(42);
  });
});

// ---- sanitizeGeminiCodeAssistRequest --------------------------------------

describe("sanitizeGeminiCodeAssistRequest", () => {
  it("returns {} for a non-record body", () => {
    expect(sanitizeGeminiCodeAssistRequest(null)).toEqual({});
    expect(sanitizeGeminiCodeAssistRequest([1, 2])).toEqual({});
  });

  it("passes through a body with no tools array", () => {
    expect(sanitizeGeminiCodeAssistRequest({ contents: [1] })).toEqual({ contents: [1] });
  });

  it("sanitizes function-declaration parameters + parametersJsonSchema", () => {
    const out = sanitizeGeminiCodeAssistRequest({
      contents: [1],
      tools: [
        {
          functionDeclarations: [
            { name: "f", parameters: { type: "string", pattern: "x" } },
            { name: "g", parametersJsonSchema: { const: 7 } },
          ],
        },
      ],
    });
    expect(out).toEqual({
      contents: [1],
      tools: [
        {
          functionDeclarations: [
            { name: "f", parameters: { type: "string" } },
            { name: "g", parametersJsonSchema: { enum: [7] } },
          ],
        },
      ],
    });
  });
});

// ---- buildGeminiCodeAssistRequestBody -------------------------------------

describe("buildGeminiCodeAssistRequestBody", () => {
  it("wraps the request with model/project and injects a session_id when absent", () => {
    const out = buildGeminiCodeAssistRequestBody({
      requestBody: { contents: [1] },
      modelId: "gemini-2.5-pro",
      projectId: "proj-1",
      sessionId: "sess-1",
    });
    expect(out.model).toBe("gemini-2.5-pro");
    expect(out.project).toBe("proj-1");
    expect(typeof out.user_prompt_id).toBe("string");
    expect(out.request).toEqual({ contents: [1], session_id: "sess-1" });
  });

  it("preserves an existing non-empty session_id and does not add `project` without a projectId", () => {
    const out = buildGeminiCodeAssistRequestBody({
      requestBody: { contents: [1], session_id: "keep" },
      modelId: "m",
      sessionId: "ignored",
    });
    expect("project" in out).toBe(false);
    expect(out.request).toEqual({ contents: [1], session_id: "keep" });
  });

  it("tolerates a non-object requestBody", () => {
    const out = buildGeminiCodeAssistRequestBody({ requestBody: null, modelId: "m" });
    expect(out.model).toBe("m");
    expect(out.request).toEqual({});
  });
});

// ---- shouldRetryGeminiCodeAssist ------------------------------------------

describe("shouldRetryGeminiCodeAssist", () => {
  it("retries only on a 500 carrying an internal-error marker", () => {
    expect(
      shouldRetryGeminiCodeAssist(new Response("x", { status: 500 }), "Internal Error Encountered")
    ).toBe(true);
    expect(
      shouldRetryGeminiCodeAssist(new Response("x", { status: 500 }), '{"status": "INTERNAL"}')
    ).toBe(true);
  });

  it("does not retry non-500 or unmarked 500 bodies", () => {
    expect(shouldRetryGeminiCodeAssist(new Response("x", { status: 429 }), "internal error encountered")).toBe(false);
    expect(shouldRetryGeminiCodeAssist(new Response("x", { status: 500 }), "quota exceeded")).toBe(false);
  });
});

// ---- buildGeminiCodeAssistFallbackBodies ----------------------------------

describe("buildGeminiCodeAssistFallbackBodies", () => {
  it("produces the documented progressive-reduction ladder, deduped", () => {
    const bodies = buildGeminiCodeAssistFallbackBodies({
      contents: [1],
      systemInstruction: "s",
      tools: ["t"],
      toolConfig: "tc",
      generationConfig: "gc",
    });
    expect(bodies).toEqual([
      { contents: [1], systemInstruction: "s", tools: ["t"], generationConfig: "gc" }, // -toolConfig
      { contents: [1], systemInstruction: "s", generationConfig: "gc" }, // -tools -toolConfig
      { contents: [1], systemInstruction: "s", tools: ["t"], toolConfig: "tc" }, // -generationConfig
      { contents: [1], systemInstruction: "s" }, // minimal
    ]);
  });

  it("returns an empty ladder when nothing is reducible", () => {
    expect(buildGeminiCodeAssistFallbackBodies({ foo: "bar" })).toEqual([]);
  });
});

// ---- unwrapGeminiCodeAssistResponse ---------------------------------------

describe("unwrapGeminiCodeAssistResponse", () => {
  it("unwraps a `.response` envelope and passes plain payloads through", () => {
    expect(unwrapGeminiCodeAssistResponse({ response: { a: 1 } })).toEqual({ a: 1 });
    expect(unwrapGeminiCodeAssistResponse({ a: 1 })).toEqual({ a: 1 });
    expect(unwrapGeminiCodeAssistResponse([1, 2])).toEqual([1, 2]);
    expect(unwrapGeminiCodeAssistResponse("s")).toBe("s");
  });
});

// ---- rewriteGeminiCodeAssistEventData -------------------------------------

describe("rewriteGeminiCodeAssistEventData", () => {
  it("unwraps the response envelope inside an SSE data payload", () => {
    expect(rewriteGeminiCodeAssistEventData('{"response":{"a":1}}')).toBe('{"a":1}');
  });

  it("passes [DONE], empty, and non-JSON data through untouched", () => {
    expect(rewriteGeminiCodeAssistEventData("[DONE]")).toBe("[DONE]");
    expect(rewriteGeminiCodeAssistEventData("")).toBe("");
    expect(rewriteGeminiCodeAssistEventData("not json")).toBe("not json");
  });
});

// ---- rewriteGeminiCodeAssistSseStream (the silent-fail surface) ------------

describe("rewriteGeminiCodeAssistSseStream", () => {
  it("rewrites data lines, unwrapping the response envelope per event", async () => {
    const out = await readStreamToString(
      rewriteGeminiCodeAssistSseStream(streamFromString('data: {"response":{"text":"hi"}}\n\n'))
    );
    expect(out).toBe('data: {"text":"hi"}\n\n');
  });

  it("preserves non-data lines and handles multiple events", async () => {
    const out = await readStreamToString(
      rewriteGeminiCodeAssistSseStream(
        streamFromString(
          'event: message\ndata: {"response":{"a":1}}\n\ndata: {"response":{"b":2}}\n\n'
        )
      )
    );
    expect(out).toBe('event: message\ndata: {"a":1}\n\ndata: {"b":2}\n\n');
  });

  it("joins multi-line data payloads before unwrapping", async () => {
    // Two `data:` lines for one event are joined with \n, then parsed.
    const out = await readStreamToString(
      rewriteGeminiCodeAssistSseStream(streamFromString('data: {"response":\ndata: {"a":1}}\n\n'))
    );
    expect(out).toBe('data: {"a":1}\n\n');
  });
});

// ---- parseGeminiModelMethod -----------------------------------------------

describe("parseGeminiModelMethod", () => {
  it("parses model id + method from a /models/<id>:<method> path", () => {
    expect(parseGeminiModelMethod("/v1beta/models/gemini-2.5-pro:generateContent")).toEqual({
      modelId: "gemini-2.5-pro",
      method: "generateContent",
    });
    expect(parseGeminiModelMethod("/v1beta/models/gemini-2.5-flash:streamGenerateContent")).toEqual({
      modelId: "gemini-2.5-flash",
      method: "streamGenerateContent",
    });
  });

  it("URL-decodes the model id", () => {
    expect(parseGeminiModelMethod("/models/tuned%2Fabc:generateContent")).toEqual({
      modelId: "tuned/abc",
      method: "generateContent",
    });
  });

  it("returns null for an unknown method, a missing marker, or an empty model id", () => {
    expect(parseGeminiModelMethod("/models/gemini:countTokens")).toBeNull();
    expect(parseGeminiModelMethod("/v1beta/foo/bar")).toBeNull();
    expect(parseGeminiModelMethod("/models/:generateContent")).toBeNull();
  });
});

// ---- payload extractors ---------------------------------------------------

describe("extractGeminiCodeAssistProjectId", () => {
  it("reads the direct string, direct object id, and nested response id", () => {
    expect(extractGeminiCodeAssistProjectId({ cloudaicompanionProject: "proj-1" })).toBe("proj-1");
    expect(extractGeminiCodeAssistProjectId({ cloudaicompanionProject: { id: "proj-2" } })).toBe("proj-2");
    expect(
      extractGeminiCodeAssistProjectId({ response: { cloudaicompanionProject: { id: "proj-3" } } })
    ).toBe("proj-3");
  });

  it("returns undefined for missing/invalid payloads", () => {
    expect(extractGeminiCodeAssistProjectId({})).toBeUndefined();
    expect(extractGeminiCodeAssistProjectId(null)).toBeUndefined();
    expect(extractGeminiCodeAssistProjectId([1])).toBeUndefined();
  });
});

describe("extractGeminiCurrentTierId", () => {
  it("returns the current tier id or undefined", () => {
    expect(extractGeminiCurrentTierId({ currentTier: { id: "free-tier" } })).toBe("free-tier");
    expect(extractGeminiCurrentTierId({ currentTier: {} })).toBeUndefined();
    expect(extractGeminiCurrentTierId({})).toBeUndefined();
  });
});

describe("extractGeminiDefaultAllowedTierId", () => {
  it("prefers an isDefault tier, else falls back to the first tier with an id", () => {
    expect(
      extractGeminiDefaultAllowedTierId({ allowedTiers: [{ id: "a" }, { id: "b", isDefault: true }] })
    ).toBe("b");
    expect(extractGeminiDefaultAllowedTierId({ allowedTiers: [{ id: "a" }, { id: "b" }] })).toBe("a");
  });

  it("returns undefined for an empty/absent tier list", () => {
    expect(extractGeminiDefaultAllowedTierId({ allowedTiers: [] })).toBeUndefined();
    expect(extractGeminiDefaultAllowedTierId({})).toBeUndefined();
  });
});

describe("extractGeminiOperationName", () => {
  it("returns a trimmed operation name or undefined", () => {
    expect(extractGeminiOperationName({ name: "operations/123" })).toBe("operations/123");
    expect(extractGeminiOperationName({ name: "  " })).toBeUndefined();
    expect(extractGeminiOperationName({})).toBeUndefined();
  });
});

describe("resolveGeminiCodeAssistPlatform", () => {
  it("returns a valid Code Assist platform enum for the host", () => {
    expect(["WINDOWS", "MACOS", "PLATFORM_UNSPECIFIED"]).toContain(resolveGeminiCodeAssistPlatform());
  });
});
