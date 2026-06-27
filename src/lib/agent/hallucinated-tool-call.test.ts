/**
 * PM #81 — degraded models (notably Qwen via Ollama/OpenRouter under long
 * context) stop using the native tool-calling channel and PRINT the tool call
 * as raw markup. `extractHallucinatedToolCall` normalizes every shape; these
 * pin the recovery AND its conservatism (a real answer that merely quotes
 * `<tool_call>` must not match), plus the `turnHasDeliverableAnswer` wiring that
 * routes an action-tool hallucination into the forced-final-answer path instead
 * of persisting XML garbage to the user.
 */
import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import {
  extractHallucinatedToolCall,
  turnHasDeliverableAnswer,
  detectActionHallucination,
  stripHallucinatedTrailingText,
  neutralizeHallucinatedHistory,
  HALLUCINATED_HISTORY_PLACEHOLDER,
} from "./agent-response";

describe("extractHallucinatedToolCall (PM #81)", () => {
  it("parses a Qwen/Hermes <tool_call> JSON block", () => {
    const raw =
      '<tool_call>\n{"name": "write_text_file", "arguments": {"file_path": "a.ts", "content": "x"}}\n</tool_call>';
    const call = extractHallucinatedToolCall(raw);
    expect(call?.name).toBe("write_text_file");
    expect(call?.args).toEqual({ file_path: "a.ts", content: "x" });
  });

  it("tolerates a missing closing </tool_call> tag", () => {
    const raw = '<tool_call>{"name":"search_web","arguments":{"query":"edem.lv"}}';
    expect(extractHallucinatedToolCall(raw)?.name).toBe("search_web");
  });

  it("strips a surrounding ```xml / ``` fence around the markup", () => {
    const raw =
      '```\n<tool_call>{"name":"read_text_file","arguments":{"file_path":"b.ts"}}</tool_call>\n```';
    expect(extractHallucinatedToolCall(raw)?.name).toBe("read_text_file");
  });

  it("parses a Functionary <function=NAME> JSON block", () => {
    const raw = '<function=write_text_file>{"file_path":"c.ts","content":"y"}</function>';
    const call = extractHallucinatedToolCall(raw);
    expect(call?.name).toBe("write_text_file");
    expect(call?.args).toEqual({ file_path: "c.ts", content: "y" });
  });

  it("parses Functionary <parameter=...> pairs when the inner is not JSON", () => {
    const raw =
      "<function=read_text_file><parameter=file_path>d.ts</parameter></function>";
    const call = extractHallucinatedToolCall(raw);
    expect(call?.name).toBe("read_text_file");
    expect(call?.args).toEqual({ file_path: "d.ts" });
  });

  // ── The REAL production format (PM #81 deep-audit, chat a8e1a43c): leading
  // prose, then a NESTED <tool_call><function=…><parameter=…> block, frequently
  // UNCLOSED (the content param runs to EOF). The first cut anchored to ^…$ and
  // parsed the <tool_call> inner as JSON → it matched ZERO of these. ──────────
  it("parses prose-prefixed NESTED <tool_call><function=><parameter=> (the real degradation)", () => {
    const raw =
      "Let me update the engine to integrate our new modules:\n\n" +
      "<tool_call>\n<function=write_text_file>\n" +
      "<parameter=file_path>\n/proj/src/engine.ts\n</parameter>\n" +
      "<parameter=content>\nimport { Bot } from 'grammy';\nexport class Engine {}\n"; // UNCLOSED to EOF
    const call = extractHallucinatedToolCall(raw);
    expect(call?.name).toBe("write_text_file");
    expect(call?.args.file_path).toBe("/proj/src/engine.ts");
    expect(String(call?.args.content)).toContain("import { Bot }");
  });

  it("parses the nested form when fully CLOSED with trailing tags", () => {
    const raw =
      "Here is the file:\n<tool_call><function=read_text_file>" +
      "<parameter=file_path>a.ts</parameter></function></tool_call>";
    expect(extractHallucinatedToolCall(raw)?.name).toBe("read_text_file");
  });

  it("does NOT match a CORRECTION message that only MENTIONS <tool_call> (the operator's manual fix)", () => {
    const raw =
      "CRITICAL SYSTEM INSTRUCTION: You are hallucinating raw XML-like `<tool_call>` " +
      "blocks directly into your text response. Use the native JSON tool-calling API instead.";
    expect(extractHallucinatedToolCall(raw)).toBeNull();
  });

  it("parses a Mistral [TOOL_CALLS] array", () => {
    const raw = '[TOOL_CALLS][{"name":"search_web","arguments":{"query":"q"}}]';
    expect(extractHallucinatedToolCall(raw)?.name).toBe("search_web");
  });

  it("parses the OpenAI nested {function:{name,arguments-string}} shape inside <tool_call>", () => {
    // The OpenAI-nested object inside markup IS detected (markup is unambiguous);
    // bare (no markup) it is NOT — see the conservatism block below.
    const raw =
      '<tool_call>{"type":"function","function":{"name":"write_text_file","arguments":"{\\"file_path\\":\\"e.ts\\"}"}}</tool_call>';
    const call = extractHallucinatedToolCall(raw);
    expect(call?.name).toBe("write_text_file");
    expect(call?.args).toEqual({ file_path: "e.ts" });
  });

  it("recovers a bare JSON `response` blob (PM #61) — the ONLY bare-JSON case", () => {
    const raw = '{"name":"response","arguments":{"message":"hi"}}';
    expect(extractHallucinatedToolCall(raw)?.name).toBe("response");
  });

  // --- conservatism: must NOT match legitimate output ---

  it("does NOT match plain prose", () => {
    expect(extractHallucinatedToolCall("Here is your answer: 42.")).toBeNull();
  });

  it("does NOT match prose that merely mentions <tool_call> mid-sentence", () => {
    const prose =
      "When the model degrades it prints `<tool_call>` as text instead of calling it.";
    expect(extractHallucinatedToolCall(prose)).toBeNull();
  });

  it("does NOT match a legitimate JSON answer without an args container", () => {
    expect(extractHallucinatedToolCall('{"city":"Riga","country":"LV"}')).toBeNull();
  });

  it("does NOT match a bare-JSON ACTION-tool call (would delete a legit JSON answer)", () => {
    // A user can legitimately ask for "only the tool-call JSON, no prose". Bare
    // JSON for an action tool must NOT be treated as a hallucination — only the
    // unambiguous markup forms (or a bare `response`) are safe. False-negative by
    // design (qwen3-coder degrades into <tool_call> markup, not bare JSON).
    expect(
      extractHallucinatedToolCall('{"name":"write_text_file","arguments":{"file_path":"a.ts"}}')
    ).toBeNull();
    expect(extractHallucinatedToolCall('{"name":"search_web","arguments":{"query":"x"}}')).toBeNull();
  });

  it("does NOT match an empty / whitespace string", () => {
    expect(extractHallucinatedToolCall("")).toBeNull();
    expect(extractHallucinatedToolCall("   \n  ")).toBeNull();
  });
});

function assistantMsg(text: string): ModelMessage {
  return { role: "assistant", content: text };
}

describe("turnHasDeliverableAnswer + hallucinated calls (PM #81)", () => {
  it("treats an action-tool hallucination as NO delivery (forces a real answer)", () => {
    const msgs = [
      assistantMsg(
        '<tool_call>{"name":"write_text_file","arguments":{"file_path":"a.ts","content":"x"}}</tool_call>'
      ),
    ];
    expect(turnHasDeliverableAnswer(msgs)).toBe(false);
  });

  it("treats a mis-emitted `response` call as delivered (unwrap recovers it)", () => {
    const msgs = [
      assistantMsg('<tool_call>{"name":"response","arguments":{"message":"hi"}}</tool_call>'),
    ];
    expect(turnHasDeliverableAnswer(msgs)).toBe(true);
  });

  it("treats normal prose as delivered", () => {
    expect(turnHasDeliverableAnswer([assistantMsg("All done — the file is written.")])).toBe(
      true
    );
  });
});

describe("detectActionHallucination (PM #81 Sprint 2)", () => {
  it("returns the call for an action-tool hallucination", () => {
    const call = detectActionHallucination([
      assistantMsg('<tool_call>{"name":"write_text_file","arguments":{"file_path":"a.ts"}}</tool_call>'),
    ]);
    expect(call?.name).toBe("write_text_file");
  });

  it("returns null for a mis-emitted `response` (recoverable to prose)", () => {
    expect(
      detectActionHallucination([
        assistantMsg('<tool_call>{"name":"response","arguments":{"message":"hi"}}</tool_call>'),
      ])
    ).toBeNull();
  });

  it("returns null for a normal prose answer", () => {
    expect(detectActionHallucination([assistantMsg("Here is the answer.")])).toBeNull();
  });
});

describe("stripHallucinatedTrailingText (PM #81 Sprint 2)", () => {
  it("drops the trailing action-tool markup message", () => {
    const msgs = [
      assistantMsg("earlier text"),
      assistantMsg('<tool_call>{"name":"write_text_file","arguments":{"file_path":"a.ts"}}</tool_call>'),
    ];
    const out = stripHallucinatedTrailingText(msgs);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(msgs[0]);
  });

  it("keeps a trailing normal answer", () => {
    const msgs = [assistantMsg("All done.")];
    expect(stripHallucinatedTrailingText(msgs)).toHaveLength(1);
  });

  it("keeps a trailing mis-emitted `response` markup (it is the answer)", () => {
    const msgs = [
      assistantMsg('<tool_call>{"name":"response","arguments":{"message":"hi"}}</tool_call>'),
    ];
    expect(stripHallucinatedTrailingText(msgs)).toHaveLength(1);
  });
});

function assistantParts(parts: unknown[]): ModelMessage {
  return { role: "assistant", content: parts } as ModelMessage;
}
function toolResultMsg(toolCallId: string, toolName: string): ModelMessage {
  return {
    role: "tool",
    content: [
      { type: "tool-result", toolCallId, toolName, output: { type: "json", value: { ok: true } } },
    ],
  } as ModelMessage;
}

describe("neutralizeHallucinatedHistory (PM #82)", () => {
  // The REAL production format: nested <tool_call><function=NAME><parameter=…>.
  const markup =
    "<tool_call>\n<function=write_text_file>\n<parameter=file_path>a.ts</parameter>\n<parameter=content>x</parameter>";

  it("replaces an action-tool markup assistant message with the placeholder", () => {
    const out = neutralizeHallucinatedHistory([assistantMsg("ok"), assistantMsg(markup)]);
    expect(out[0]).toEqual({ role: "assistant", content: "ok" });
    expect(out[1].content).toBe(HALLUCINATED_HISTORY_PLACEHOLDER);
  });

  it("neutralizes every poisoned message across the history", () => {
    const out = neutralizeHallucinatedHistory([
      assistantMsg(markup),
      { role: "user", content: "continue" },
      assistantMsg(markup),
    ]);
    expect(out[0].content).toBe(HALLUCINATED_HISTORY_PLACEHOLDER);
    expect(out[2].content).toBe(HALLUCINATED_HISTORY_PLACEHOLDER);
  });

  it("leaves clean assistant text untouched", () => {
    const msgs = [assistantMsg("Here is the plan: step 1, step 2.")];
    expect(neutralizeHallucinatedHistory(msgs)).toEqual(msgs);
  });

  it("does not touch user messages, even ones quoting markup", () => {
    const msgs: ModelMessage[] = [{ role: "user", content: markup }];
    expect(neutralizeHallucinatedHistory(msgs)).toEqual(msgs);
  });

  it("keeps a mis-emitted `response` markup (it is the answer, not poison)", () => {
    const msgs = [
      assistantMsg('<tool_call>{"name":"response","arguments":{"message":"hi"}}</tool_call>'),
    ];
    expect(neutralizeHallucinatedHistory(msgs)).toEqual(msgs);
  });

  it("preserves a native tool-call/result pair (pair-safe)", () => {
    const msgs: ModelMessage[] = [
      assistantParts([
        { type: "tool-call", toolCallId: "c1", toolName: "write_text_file", input: { file_path: "a.ts" } },
      ]),
      toolResultMsg("c1", "write_text_file"),
    ];
    expect(neutralizeHallucinatedHistory(msgs)).toEqual(msgs);
  });

  it("neutralizes markup text but KEEPS a native part in a mixed message", () => {
    const out = neutralizeHallucinatedHistory([
      assistantParts([
        { type: "text", text: markup },
        { type: "tool-call", toolCallId: "c2", toolName: "search_web", input: { query: "x" } },
      ]),
    ]);
    const content = out[0].content as Array<{ type: string; text?: string; toolName?: string }>;
    expect(content[0]).toEqual({ type: "text", text: HALLUCINATED_HISTORY_PLACEHOLDER });
    expect(content.some((p) => p.type === "tool-call" && p.toolName === "search_web")).toBe(true);
  });
});
