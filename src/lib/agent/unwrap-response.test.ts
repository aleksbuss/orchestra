/**
 * PM #61 — models emit the final `response` tool call as TEXT (JSON blob or a
 * fenced code block) instead of a native tool call, trapping the real answer.
 * `unwrapSerializedResponseCall` recovers the inner message. These pin the
 * recovery AND its conservatism (must not mangle legitimate answers).
 */
import { describe, expect, it } from "vitest";
import { unwrapSerializedResponseCall } from "./agent";

describe("unwrapSerializedResponseCall (PM #61)", () => {
  it("unwraps a fenced ```json response call (the deepseek-chat + MoA case)", () => {
    const raw =
      '```json\n{\n  "call": "response",\n  "arguments": {\n    "message": "### OSINT\\n\\nРегистратор: IANA."\n  }\n}\n```';
    expect(unwrapSerializedResponseCall(raw)).toBe("### OSINT\n\nРегистратор: IANA.");
  });

  it("unwraps a bare JSON response call", () => {
    const raw = '{"call":"response","arguments":{"message":"Сегодня XXI век."}}';
    expect(unwrapSerializedResponseCall(raw)).toBe("Сегодня XXI век.");
  });

  it("accepts name/input and tool/parameters field variants", () => {
    expect(
      unwrapSerializedResponseCall('{"name":"response","input":{"message":"hi"}}')
    ).toBe("hi");
    expect(
      unwrapSerializedResponseCall('{"tool":"response","parameters":{"text":"yo"}}')
    ).toBe("yo");
  });

  it("leaves a normal prose answer untouched", () => {
    const prose = "It is the 21st century.";
    expect(unwrapSerializedResponseCall(prose)).toBe(prose);
  });

  it("leaves prose that merely mentions the word response untouched", () => {
    const prose = "Here is my response to your question: 42.";
    expect(unwrapSerializedResponseCall(prose)).toBe(prose);
  });

  it("does NOT unwrap a JSON object that isn't a response call", () => {
    const json = '{"call":"search_web","arguments":{"query":"edem.lv"}}';
    expect(unwrapSerializedResponseCall(json)).toBe(json);
  });

  it("leaves a legitimate JSON answer (no response wrapper) intact", () => {
    const answer = '```json\n{"city":"Riga","country":"LV"}\n```';
    expect(unwrapSerializedResponseCall(answer)).toBe(answer);
  });

  it("returns malformed JSON unchanged", () => {
    const broken = '{"call":"response","arguments":{"message": unterminated';
    expect(unwrapSerializedResponseCall(broken)).toBe(broken);
  });

  it("falls back to original when the unwrapped message would be empty", () => {
    const raw = '{"call":"response","arguments":{"message":"   "}}';
    expect(unwrapSerializedResponseCall(raw)).toBe(raw);
  });

  it("handles empty / non-matching input safely", () => {
    expect(unwrapSerializedResponseCall("")).toBe("");
    expect(unwrapSerializedResponseCall("just text")).toBe("just text");
  });
});
