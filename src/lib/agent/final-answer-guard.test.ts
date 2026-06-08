/**
 * PM #69 — `turnHasDeliverableAnswer` decides whether a turn actually delivered
 * an answer to the user. When it returns false, runAgent's onFinish forces one
 * tool-less final-answer generation so the user always gets a reply (the failure
 * mode: deepseek/OpenRouter returns `finishReason: "other"` after a tool call
 * and never proceeds to a `response`).
 *
 * This pins the DECISION: a `response` tool call/result or real assistant text
 * counts as delivered; a turn that ends with only a non-response tool call, a
 * `<thinking>`-only block, or nothing at all does NOT.
 */
import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import { turnHasDeliverableAnswer } from "./agent";

const responseToolCall = (message: string): ModelMessage => ({
  role: "assistant",
  content: [
    { type: "tool-call", toolCallId: "r1", toolName: "response", input: { message } },
  ],
}) as unknown as ModelMessage;

const responseToolResult = (message: string): ModelMessage => ({
  role: "tool",
  content: [
    { type: "tool-result", toolCallId: "r1", toolName: "response", output: message },
  ],
}) as unknown as ModelMessage;

const searchToolCall = (): ModelMessage => ({
  role: "assistant",
  content: [
    { type: "tool-call", toolCallId: "s1", toolName: "search_web", input: { query: "x" } },
  ],
}) as unknown as ModelMessage;

const searchToolResult = (): ModelMessage => ({
  role: "tool",
  content: [
    { type: "tool-result", toolCallId: "s1", toolName: "search_web", output: "results" },
  ],
}) as unknown as ModelMessage;

const assistantText = (text: string): ModelMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
}) as unknown as ModelMessage;

describe("PM #69 — turnHasDeliverableAnswer", () => {
  it("DELIVERED: a `response` tool call carries the answer", () => {
    expect(turnHasDeliverableAnswer([responseToolCall("Here is the answer.")])).toBe(true);
  });

  it("DELIVERED: a `response` tool result carries the answer", () => {
    expect(turnHasDeliverableAnswer([responseToolResult("Here is the answer.")])).toBe(true);
  });

  it("DELIVERED: plain assistant text is an answer", () => {
    expect(turnHasDeliverableAnswer([assistantText("React 19.2.7 is the latest.")])).toBe(true);
  });

  it("NOT delivered: the turn ended on a non-response tool call + result (the PM #69 failure)", () => {
    expect(turnHasDeliverableAnswer([searchToolCall(), searchToolResult()])).toBe(false);
  });

  it("NOT delivered: assistant text was only a <thinking> block (stripped to empty)", () => {
    expect(
      turnHasDeliverableAnswer([assistantText("<thinking>Goal: figure it out</thinking>")])
    ).toBe(false);
  });

  it("NOT delivered: no messages at all (model returned nothing)", () => {
    expect(turnHasDeliverableAnswer([])).toBe(false);
  });

  it("DELIVERED: search happened, THEN a response tool delivered (the success path)", () => {
    expect(
      turnHasDeliverableAnswer([
        searchToolCall(),
        searchToolResult(),
        responseToolCall("React 19.2.7, per the search."),
      ])
    ).toBe(true);
  });
});
