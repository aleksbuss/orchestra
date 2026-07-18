import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolSet } from "ai";

// Mock the leaf deps BEFORE importing the unit under test.
vi.mock("@/lib/tools/tool", () => ({
  createAgentTools: vi.fn(),
}));
vi.mock("@/lib/mcp/client", () => ({
  getProjectMcpToolsForContext: vi.fn(),
}));
// The guard tags the tools so we can assert it ran AND that scoping happened first.
vi.mock("@/lib/agent/tool-guard", () => ({
  applyGlobalToolLoopGuard: vi.fn((tools: ToolSet, ctx?: unknown) => ({
    ...tools,
    __guardedWith: ctx ?? null,
  })),
}));

import { assembleAgentToolSet, scopeSwarmRoleTools } from "./agent-tools";
import { createAgentTools } from "@/lib/tools/tool";
import { getProjectMcpToolsForContext } from "@/lib/mcp/client";
import { applyGlobalToolLoopGuard } from "@/lib/agent/tool-guard";
import type { AgentContext } from "@/lib/agent/types";
import type { AppSettings } from "@/lib/types";

const ctx = (projectId?: string) =>
  ({
    chatId: "c1",
    projectId,
    memorySubdir: "main",
    knowledgeSubdirs: ["main"],
    history: [],
    agentNumber: 0,
  }) as unknown as AgentContext;

const settings = {} as AppSettings;

const asTools = (obj: Record<string, unknown>) => obj as unknown as ToolSet;

const baseSet = () =>
  asTools({
    search_web: {},
    read_text_file: {},
    list_dir: {},
    view_image: {},
    blackboard_read: {},
    knowledge_query: {},
    memory_load: {},
    response: {},
    call_mcp_tool: {},
    mcp_get_tool_schema: {},
    grep: {},
    write_text_file: {},
    code_execution: {},
    install_packages: {},
  });

describe("scopeSwarmRoleTools (swarm read-only role scoping, CLAUDE.md §1)", () => {
  it("researcher keeps ONLY read-only tools, drops write/exec/grep", () => {
    const out = Object.keys(scopeSwarmRoleTools(baseSet(), "researcher"));
    expect(out).toContain("search_web");
    expect(out).toContain("read_text_file");
    expect(out).toContain("blackboard_read");
    expect(out).toContain("knowledge_query");
    expect(out).toContain("response");
    expect(out).toContain("call_mcp_tool");
    expect(out).not.toContain("write_text_file");
    expect(out).not.toContain("code_execution");
    expect(out).not.toContain("install_packages");
    expect(out).not.toContain("grep"); // grep is reviewer-only
  });

  it("reviewer keeps read-only PLUS grep, still drops write/exec", () => {
    const out = Object.keys(scopeSwarmRoleTools(baseSet(), "reviewer"));
    expect(out).toContain("grep");
    expect(out).toContain("read_text_file");
    expect(out).not.toContain("write_text_file");
    expect(out).not.toContain("code_execution");
  });

  it("coder retains the FULL toolset (same reference, untouched)", () => {
    const input = baseSet();
    const out = scopeSwarmRoleTools(input, "coder");
    expect(out).toBe(input);
    expect(Object.keys(out)).toHaveLength(Object.keys(baseSet()).length);
    expect(out).toHaveProperty("code_execution");
  });
});

describe("assembleAgentToolSet (§10 agent-tools chokepoint)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("no projectId → base tools guarded, MCP never queried, no cleanup/docs", async () => {
    vi.mocked(createAgentTools).mockReturnValue(asTools({ a: {} }));

    const res = await assembleAgentToolSet(ctx(undefined), settings);

    expect(getProjectMcpToolsForContext).not.toHaveBeenCalled();
    expect(applyGlobalToolLoopGuard).toHaveBeenCalledTimes(1);
    expect(res.mcpCleanup).toBeUndefined();
    expect(res.mcpDocs).toBeUndefined();
    expect(res.tools).toHaveProperty("a");
    expect(res.tools).toHaveProperty("__guardedWith"); // proves the guard wrapped it
  });

  it("projectId + MCP present + mcpDocsLimit → merges tools, returns cleanup + docs at the given budget", async () => {
    vi.mocked(createAgentTools).mockReturnValue(asTools({ base: {} }));
    const cleanup = vi.fn(async () => {});
    const mcpSystemPrompt = vi.fn((n: number) => `docs:${n}`);
    vi.mocked(getProjectMcpToolsForContext).mockResolvedValue({
      tools: asTools({ mcp_x: {} }),
      cleanup,
      mcpSystemPrompt,
    } as never);

    const res = await assembleAgentToolSet(ctx("p1"), settings, { mcpDocsLimit: 2048 });

    expect(res.tools).toHaveProperty("base");
    expect(res.tools).toHaveProperty("mcp_x");
    expect(res.mcpCleanup).toBe(cleanup);
    expect(mcpSystemPrompt).toHaveBeenCalledWith(2048);
    expect(res.mcpDocs).toBe("docs:2048");
  });

  it("MCP present but mcpDocsLimit OMITTED → no docs built (subordinate path)", async () => {
    vi.mocked(createAgentTools).mockReturnValue(asTools({ base: {} }));
    const mcpSystemPrompt = vi.fn((n: number) => `docs:${n}`);
    vi.mocked(getProjectMcpToolsForContext).mockResolvedValue({
      tools: asTools({ mcp_x: {} }),
      cleanup: vi.fn(async () => {}),
      mcpSystemPrompt,
    } as never);

    const res = await assembleAgentToolSet(ctx("p1"), settings);

    expect(res.tools).toHaveProperty("mcp_x");
    expect(mcpSystemPrompt).not.toHaveBeenCalled();
    expect(res.mcpDocs).toBeUndefined();
  });

  it("scopeTools runs BEFORE the guard (the guard receives the scoped set)", async () => {
    vi.mocked(createAgentTools).mockReturnValue(asTools({ keep: {}, drop: {} }));

    const res = await assembleAgentToolSet(ctx(undefined), settings, {
      scopeTools: (t) => {
        const { drop: _drop, ...rest } = t as Record<string, unknown>;
        return rest as unknown as ToolSet;
      },
    });

    // The guard mock was handed the already-scoped set.
    const guardArg = vi.mocked(applyGlobalToolLoopGuard).mock.calls[0][0];
    expect(guardArg).toHaveProperty("keep");
    expect(guardArg).not.toHaveProperty("drop");
    expect(res.tools).not.toHaveProperty("drop");
  });

  it("threads mcpRole and guardContext through", async () => {
    vi.mocked(createAgentTools).mockReturnValue(asTools({ base: {} }));
    vi.mocked(getProjectMcpToolsForContext).mockResolvedValue(null as never);
    const guardContext = { chatId: "c1", parentNodeId: "n1" };

    await assembleAgentToolSet(ctx("p1"), settings, { mcpRole: "reviewer", guardContext });

    expect(getProjectMcpToolsForContext).toHaveBeenCalledWith(
      expect.anything(),
      settings,
      "reviewer",
    );
    expect(applyGlobalToolLoopGuard).toHaveBeenCalledWith(expect.anything(), guardContext);
  });
});
