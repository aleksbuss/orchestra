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

/**
 * Full-inventory characterization (§10 tool.ts decomposition).
 *
 * Pins the EXACT tool-name set `createAgentTools` returns for a fully-featured
 * context and the exact delta each gate removes. This is the parity net for
 * the family-file split: the facade recomposition must reproduce this
 * inventory byte-for-byte. Adding/removing a tool is a deliberate contract
 * change — update the list here in the same PR (that is the point).
 */
describe("createAgentTools — full inventory characterization", () => {
  const fullCtx = () =>
    ctx({
      data: { telegram: { botToken: "token", chatId: 42 } },
    } as Partial<AgentContext>);

  const FULL_INVENTORY = [
    "call_subordinate",
    "code_execution",
    "copy_file",
    "create_goal_tree",
    "create_project",
    "create_skill",
    "cron",
    "delete_mcp_server",
    "delete_skill",
    "fetch_webpage",
    "get_current_project",
    "inject_mcp_defaults",
    "install_packages",
    "install_skill_from_github",
    "knowledge_query",
    "list_projects",
    "load_skill",
    "load_skill_resource",
    "memory_delete",
    "memory_load",
    "memory_save",
    "process",
    "read_pdf_file",
    "read_text_file",
    "replace_in_file",
    "response",
    "search_blackboard",
    "search_web",
    "switch_project",
    "telegram_send_file",
    "update_skill",
    "update_task_status",
    "upsert_mcp_server",
    "web_task",
    "write_skill_file",
    "write_text_file",
    "write_to_blackboard",
  ];

  function names(tools: Record<string, unknown>): string[] {
    return Object.keys(tools).sort();
  }

  function removedByGate(gatedTools: Record<string, unknown>): string[] {
    const gated = new Set(Object.keys(gatedTools));
    return FULL_INVENTORY.filter((name) => !gated.has(name));
  }

  it("a fully-featured context yields the exact expected inventory", () => {
    expect(names(createAgentTools(fullCtx(), settings()))).toEqual(FULL_INVENTORY);
  });

  it("no projectId removes exactly the project-scoped tools", () => {
    const tools = createAgentTools(
      ctx({
        projectId: undefined,
        data: { telegram: { botToken: "token", chatId: 42 } },
      } as Partial<AgentContext>),
      settings()
    );
    expect(removedByGate(tools)).toEqual([
      "create_skill",
      "delete_mcp_server",
      "delete_skill",
      "install_skill_from_github",
      "load_skill",
      "load_skill_resource",
      "search_blackboard",
      "update_skill",
      "upsert_mcp_server",
      "write_skill_file",
      "write_to_blackboard",
    ]);
  });

  it("codeExecution disabled removes exactly the execution family", () => {
    const tools = createAgentTools(
      fullCtx(),
      settings({ codeExecution: { enabled: false } })
    );
    expect(removedByGate(tools)).toEqual([
      "code_execution",
      "install_packages",
      "process",
    ]);
  });

  it("memory disabled removes exactly the memory family", () => {
    const tools = createAgentTools(fullCtx(), settings({ memory: { enabled: false } }));
    expect(removedByGate(tools)).toEqual([
      "memory_delete",
      "memory_load",
      "memory_save",
    ]);
  });

  it("unusable search removes exactly search_web", () => {
    const tools = createAgentTools(
      fullCtx(),
      settings({ search: { enabled: false, provider: "none" } })
    );
    expect(removedByGate(tools)).toEqual(["search_web"]);
  });

  it("missing telegram runtime removes exactly telegram_send_file", () => {
    const tools = createAgentTools(ctx(), settings());
    expect(removedByGate(tools)).toEqual(["telegram_send_file"]);
  });

  it("agentNumber at max depth removes exactly call_subordinate", () => {
    const tools = createAgentTools(
      ctx({
        agentNumber: 3,
        data: { telegram: { botToken: "token", chatId: 42 } },
      } as Partial<AgentContext>),
      settings()
    );
    expect(removedByGate(tools)).toEqual(["call_subordinate"]);
  });
});
