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

  it("parses a Mistral [TOOL_CALLS] array", () => {
    const raw = '[TOOL_CALLS][{"name":"search_web","arguments":{"query":"q"}}]';
    expect(extractHallucinatedToolCall(raw)?.name).toBe("search_web");
  });

  it("parses the OpenAI nested {function:{name,arguments-string}} shape", () => {
    const raw =
      '{"type":"function","function":{"name":"write_text_file","arguments":"{\\"file_path\\":\\"e.ts\\"}"}}';
    const call = extractHallucinatedToolCall(raw);
    expect(call?.name).toBe("write_text_file");
    expect(call?.args).toEqual({ file_path: "e.ts" });
  });

  it("parses a bare JSON tool-call blob with an args container", () => {
    const raw = '{"name":"search_web","arguments":{"query":"x"}}';
    expect(extractHallucinatedToolCall(raw)?.name).toBe("search_web");
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
