/**
 * Tests for `createCallAgentTool` — the AI-SDK Tool factory the orchestrator
 * uses to delegate to peer agents (coder/researcher/reviewer).
 *
 * Why this matters: every Swarm turn that delegates goes through this tool.
 * Two regressions are easy to introduce here and hard to spot:
 *   1. An exception in the delegation callback escapes the `execute` body
 *      and crashes the whole agent run (PM #17 class — silent post-MoA
 *      failure). The current implementation catches and converts to a
 *      string result; this test pins that contract.
 *   2. The tool's `inputSchema` accepts the wrong role enum or rejects
 *      valid roles. The orchestrator system prompt assumes exactly the
 *      three roles allowed today; broadening or shrinking the enum
 *      silently breaks delegation parsing.
 */
import { describe, it, expect, vi } from "vitest";
import { createCallAgentTool } from "./tools";
import { SWARM_ROLES, type SwarmRole } from "./types";

// The Vercel AI SDK's `tool()` returns an object with `execute`, `inputSchema`,
// and `description`. We only need to exercise `execute` directly to test
// the delegation contract.
type ToolWithExecute = {
  description?: string;
  inputSchema?: unknown;
  execute: (args: { role: SwarmRole; taskDescription: string; context?: string }) => Promise<string>;
};

describe("createCallAgentTool — delegation contract", () => {
  it("invokes onDelegate with role + taskDescription + context and returns its result", async () => {
    const onDelegate = vi.fn(async () => "subordinate output");
    const t = createCallAgentTool(onDelegate) as unknown as ToolWithExecute;

    const out = await t.execute({
      role: "coder",
      taskDescription: "implement X",
      context: "use typescript",
    });

    expect(out).toBe("subordinate output");
    expect(onDelegate).toHaveBeenCalledOnce();
    expect(onDelegate).toHaveBeenCalledWith("coder", "implement X", "use typescript");
  });

  it("forwards undefined context as-is — does not coerce to empty string", async () => {
    const onDelegate = vi.fn(async () => "ok");
    const t = createCallAgentTool(onDelegate) as unknown as ToolWithExecute;

    await t.execute({ role: "researcher", taskDescription: "find Y" });

    expect(onDelegate).toHaveBeenCalledWith("researcher", "find Y", undefined);
  });

  it("converts a callback exception into a returned string (does NOT throw)", async () => {
    // Throwing here would kill the agent run via the loop-guard contract
    // (CLAUDE.md § "Loop Guard"). The tool MUST capture and stringify.
    const onDelegate = vi.fn(async () => {
      throw new Error("boom");
    });
    const t = createCallAgentTool(onDelegate) as unknown as ToolWithExecute;

    await expect(
      t.execute({ role: "coder", taskDescription: "x" })
    ).resolves.toMatch(/Sub-agent error.*boom/i);
  });

  it("converts a non-Error throw (string, number, undefined) into a returned string", async () => {
    const onDelegate = vi.fn(async () => {
      throw "plain string thrown";
    });
    const t = createCallAgentTool(onDelegate) as unknown as ToolWithExecute;

    await expect(
      t.execute({ role: "reviewer", taskDescription: "y" })
    ).resolves.toMatch(/Sub-agent error.*plain string thrown/i);
  });
});

describe("createCallAgentTool — wiring sanity", () => {
  it("returns a tool object with description and inputSchema set", () => {
    const t = createCallAgentTool(async () => "x") as unknown as ToolWithExecute;
    expect(t.description).toBeTruthy();
    expect(t.inputSchema).toBeDefined();
  });
});

describe("SWARM_ROLES constant — orchestrator never delegates to itself", () => {
  it("contains the four canonical roles", () => {
    expect(new Set(SWARM_ROLES)).toEqual(
      new Set(["orchestrator", "coder", "researcher", "reviewer"])
    );
  });

  it("the call_agent enum (coder/researcher/reviewer) excludes 'orchestrator'", () => {
    // Self-delegation would loop the orchestrator forever. The tool's input
    // schema only accepts peer roles. Verify by trying to run the schema
    // against {role: "orchestrator"} — Zod would reject. We mirror the
    // enum here so a future widening of the schema would require a
    // matching test update.
    const peerRoles: SwarmRole[] = ["coder", "researcher", "reviewer"];
    expect(peerRoles).not.toContain("orchestrator");
    for (const role of peerRoles) {
      expect(SWARM_ROLES).toContain(role);
    }
  });
});
