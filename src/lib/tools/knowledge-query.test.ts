/**
 * Tests for `knowledgeQuery` — thin try/catch wrapper around `queryKnowledge`.
 *
 * Why test such a thin shell: the agent path consumes its STRING return
 * value verbatim and stuffs it into the model's context. A regression that
 * lets an exception propagate (instead of returning the error as a string)
 * would crash the whole tool-call loop.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/memory/knowledge", () => ({
  queryKnowledge: vi.fn(),
}));

import { knowledgeQuery } from "./knowledge-query";
import { queryKnowledge } from "@/lib/memory/knowledge";

const mocked = vi.mocked(queryKnowledge);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("knowledgeQuery", () => {
  it("forwards every argument verbatim", async () => {
    mocked.mockResolvedValue("results...");
    const settings = { memory: { similarityThreshold: 0.4 } } as any;
    await knowledgeQuery("term", 5, ["alpha", "beta"], settings);
    expect(mocked).toHaveBeenCalledOnce();
    expect(mocked).toHaveBeenCalledWith("term", 5, ["alpha", "beta"], settings);
  });

  it("returns the underlying call's string verbatim on success", async () => {
    mocked.mockResolvedValue("Found 3 docs:\n[1] ...");
    const out = await knowledgeQuery("q", 3, ["main"], {} as any);
    expect(out).toBe("Found 3 docs:\n[1] ...");
  });

  it("turns an underlying Error into a 'Knowledge query error: ...' string (no throw)", async () => {
    mocked.mockRejectedValue(new Error("vector index missing"));
    const out = await knowledgeQuery("q", 3, ["main"], {} as any);
    expect(out).toBe("Knowledge query error: vector index missing");
  });

  it("turns a non-Error throw into the same string format (defensive)", async () => {
    mocked.mockRejectedValue("plain string");
    const out = await knowledgeQuery("q", 3, ["main"], {} as any);
    expect(out).toBe("Knowledge query error: plain string");
  });
});
