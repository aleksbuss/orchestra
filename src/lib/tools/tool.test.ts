/**
 * `createAgentTools` registration + gating contract (QA audit F-15).
 *
 * `tool.ts` sat at ~24% line coverage — the biggest single-file gap. The
 * untested part is the ~30-tool registration in `createAgentTools`: the execute
 * bodies delegate to separately-tested modules, but the WIRING and the
 * settings/projectId GATING that decides which tools the agent even receives
 * had no coverage. (The CLAUDE.md warning about untestable transitive imports
 * is about `agent.ts`'s `applyGlobalToolLoopGuard`, NOT `createAgentTools` —
 * which, verified here, imports cleanly.)
 *
 * The gating is a real safety contract: `code_execution` MUST NOT be in the
 * ToolSet when `settings.codeExecution.enabled` is false — the agent cannot run
 * code it has no tool for. Same for memory, web search, and project-scoped tools.
 */
import { describe, it, expect } from "vitest";
import { createAgentTools } from "./tool";
import type { AgentContext } from "@/lib/agent/types";
import type { AppSettings } from "@/lib/types";

function ctx(over: Partial<AgentContext> = {}): AgentContext {
  return {
    chatId: "c1",
    projectId: "p-1",
    memorySubdir: "main",
    knowledgeSubdirs: [],
    history: [],
    agentNumber: 0,
    ...over,
  } as AgentContext;
}

function settings(over: Record<string, unknown> = {}): AppSettings {
  return {
    codeExecution: { enabled: true, timeout: 600, maxOutputLength: 120000 },
    memory: { enabled: true, similarityThreshold: 0.5 },
    search: { enabled: true, provider: "searxng" },
    ...over,
  } as unknown as AppSettings;
}

describe("createAgentTools — registration + gating contract (F-15)", () => {
  it("always registers the core tools (before any conditional gate)", () => {
    const tools = createAgentTools(ctx(), settings());
    for (const name of [
      "response",
      "create_goal_tree",
      "update_task_status",
      "list_projects",
      "create_project",
    ]) {
      expect(tools[name], `missing core tool ${name}`).toBeTruthy();
    }
  });

  it("gates code_execution on settings.codeExecution.enabled (safety boundary)", () => {
    expect(
      createAgentTools(ctx(), settings({ codeExecution: { enabled: true } })).code_execution
    ).toBeTruthy();
    expect(
      createAgentTools(ctx(), settings({ codeExecution: { enabled: false } })).code_execution
    ).toBeUndefined();
  });

  it("gates memory tools on settings.memory.enabled", () => {
    expect(createAgentTools(ctx(), settings({ memory: { enabled: true } })).memory_save).toBeTruthy();
    expect(
      createAgentTools(ctx(), settings({ memory: { enabled: false } })).memory_save
    ).toBeUndefined();
  });

  it("gates search_web on search usability (provider + key)", () => {
    expect(
      createAgentTools(ctx(), settings({ search: { enabled: true, provider: "searxng" } })).search_web
    ).toBeTruthy();
    expect(
      createAgentTools(ctx(), settings({ search: { enabled: false, provider: "none" } })).search_web
    ).toBeUndefined();
  });

  it("gates project-scoped tools (blackboard) on context.projectId", () => {
    expect(createAgentTools(ctx({ projectId: "p-1" }), settings()).write_to_blackboard).toBeTruthy();
    expect(
      createAgentTools(ctx({ projectId: undefined }), settings()).write_to_blackboard
    ).toBeUndefined();
  });

  it("every registered tool is well-formed (string description + execute fn)", () => {
    const tools = createAgentTools(ctx(), settings());
    for (const [name, t] of Object.entries(tools)) {
      const def = t as { description?: unknown; execute?: unknown };
      expect(typeof def.description, `${name}.description`).toBe("string");
      expect(typeof def.execute, `${name}.execute`).toBe("function");
    }
  });

  it("the always-on response tool returns the message text", async () => {
    const tools = createAgentTools(ctx(), settings());
    const exec = (tools.response as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute;
    expect(await exec({ message: "done" }, {})).toBe("done");
  });
});
