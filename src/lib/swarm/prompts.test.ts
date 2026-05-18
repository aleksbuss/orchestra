import { describe, it, expect } from "vitest";
import { getSwarmSystemPrompt } from "./prompts";

describe("Swarm Prompts Factory", () => {
  it("should generate the accurate Orchestrator orchestrator prompt", () => {
    const prompt = getSwarmSystemPrompt("orchestrator");

    // Core identity check — must be the Apex Orchestrator
    expect(prompt).toContain("Apex Orchestrator");
    // Delegation responsibility check
    expect(prompt).toContain("break down the user's request");

    // Parallel delegation constraint check — the current prompt describes sequential vs parallel
    expect(prompt).toContain("call_agent");
    expect(prompt).toContain("in the same turn");
  });

  it("should generate proper specialized constraints for coder", () => {
    const prompt = getSwarmSystemPrompt("coder");
    // Identity check
    expect(prompt).toContain("Coder");
    // Quality constraint — no placeholders
    expect(prompt).toContain("no placeholders");
    // Independence constraint — delegate research
    expect(prompt).toContain("call_agent");
  });

  it("should generate proper constraints for researcher", () => {
    const prompt = getSwarmSystemPrompt("researcher");
    // Identity check
    expect(prompt).toContain("Researcher");
    // Core responsibility — must use search tool
    expect(prompt).toContain("search_web");
    // Accuracy constraint
    expect(prompt).toContain("Do NOT make up");
  });

  it("should generate proper constraints for reviewer", () => {
    const prompt = getSwarmSystemPrompt("reviewer");
    // Identity check
    expect(prompt).toContain("Reviewer");
    // No blind approvals
    expect(prompt).toContain("Never say");
    // Must escalate, not fix
    expect(prompt).toContain("call_agent");
  });

  it("should fallback to a basic assistant if role is unknown", () => {
    // Assert on default switch statement fallback
    const prompt = getSwarmSystemPrompt("unknown_role" as any);
    expect(prompt).toContain("You are a helpful AI assistant");
  });
});
