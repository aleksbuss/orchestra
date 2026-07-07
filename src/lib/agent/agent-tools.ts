/**
 * Agent ToolSet assembly — the single chokepoint (Sprint 5, §10 `agent-tools` seam).
 *
 * Every agent entry point needs the same three-step recipe: build the base
 * tools, optionally merge in the project's MCP tools, then ALWAYS wrap the
 * result in the global loop guard (CLAUDE.md §4). Before this file that recipe
 * was hand-copied at four callsites in `agent.ts` (`runAgent`, `runAgentText`,
 * `runSubordinateAgent`, `runSubAgent`) — exactly the "cross-cutting invariant
 * copied at N entry points" class the 2026-07 architecture review flagged as the
 * root of PM #58 / #23 / #22 / #91. Folding it here makes the loop-guard wrap
 * (and the untrusted-trigger MCP gate that lives inside
 * `getProjectMcpToolsForContext`, PM #92/#38) structurally impossible to forget,
 * the same posture as the guarded settings acquisition (#40).
 *
 * The guard wrap is always the LAST step, so a caller physically cannot obtain
 * an unguarded ToolSet from this helper. Site-specific scoping that must run
 * BEFORE the guard (e.g. swarm read-only role pruning) goes through `scopeTools`.
 */
import type { ToolSet } from "ai";
import type { AgentContext } from "@/lib/agent/types";
import type { AppSettings } from "@/lib/types";
import type { SwarmRole } from "@/lib/swarm/types";
import { createAgentTools } from "@/lib/tools/tool";
import { getProjectMcpToolsForContext } from "@/lib/mcp/client";
import { applyGlobalToolLoopGuard } from "@/lib/agent/tool-guard";

export interface AssembleToolSetOptions {
  /**
   * Forwarded to `getProjectMcpToolsForContext` — restricts the MCP tools to the
   * read-only set for a `researcher`/`reviewer` sub-agent role (PM #92).
   */
  mcpRole?: SwarmRole;
  /**
   * When set AND project MCP tools are present, build the MCP system-prompt docs
   * at this character budget. Omit to skip doc generation entirely (the
   * subordinate path never injects MCP docs).
   */
  mcpDocsLimit?: number;
  /** DAG context threaded into the loop guard (chat + parent-node ids for the SwarmTerminal). */
  guardContext?: { chatId: string; parentNodeId?: string };
  /**
   * Applied to the merged tools BEFORE the loop-guard wrap. Used by the swarm
   * sub-agent path to prune to a role's read-only set (see `scopeSwarmRoleTools`).
   */
  scopeTools?: (tools: ToolSet) => ToolSet;
}

export interface AssembledToolSet {
  /** Base + MCP + scoping, wrapped in the global loop guard. Safe to mutate (fresh object). */
  tools: ToolSet;
  /** MCP transport cleanup, if project MCP tools were merged. */
  mcpCleanup?: () => Promise<void>;
  /** MCP tool docs for the system prompt, if `mcpDocsLimit` was provided and MCP tools were merged. */
  mcpDocs?: string;
}

/**
 * Assemble an agent's ToolSet through the one guarded path. See the file header.
 */
export async function assembleAgentToolSet(
  context: AgentContext,
  settings: AppSettings,
  options: AssembleToolSetOptions = {}
): Promise<AssembledToolSet> {
  const baseTools = createAgentTools(context, settings);
  let tools: ToolSet = baseTools;
  let mcpCleanup: (() => Promise<void>) | undefined;
  let mcpDocs: string | undefined;

  // `getProjectMcpToolsForContext` already returns null when there is no
  // projectId; gate here too so we don't await it needlessly on the global path.
  if (context.projectId) {
    const mcp = await getProjectMcpToolsForContext(context, settings, options.mcpRole);
    if (mcp) {
      tools = { ...baseTools, ...mcp.tools };
      mcpCleanup = mcp.cleanup;
      if (options.mcpDocsLimit !== undefined) {
        mcpDocs = mcp.mcpSystemPrompt(options.mcpDocsLimit);
      }
    }
  }

  if (options.scopeTools) {
    tools = options.scopeTools(tools);
  }

  // ALWAYS last — a caller cannot get an unguarded ToolSet out of this helper.
  tools = applyGlobalToolLoopGuard(tools, options.guardContext);

  return { tools, mcpCleanup, mcpDocs };
}

/**
 * Prune a swarm sub-agent's tools to the set its role may use (CLAUDE.md §1).
 * `researcher`/`reviewer` are read-only (reviewer additionally keeps `grep`);
 * `coder` retains the full structural + OS-execution toolset. Extracted verbatim
 * from `runSubAgent` so the scoping is directly unit-testable.
 *
 * NOTE: this is name-substring scoping of the WHOLE sub-agent toolset, distinct
 * from the MCP-only `isMcpToolReadOnly` boundary. It is a pre-existing heuristic,
 * preserved as-is.
 */
export function scopeSwarmRoleTools(tools: ToolSet, role: SwarmRole): ToolSet {
  const readOnlyMatch = (key: string) =>
    key.includes("search") ||
    key.includes("read") ||
    key.includes("list") ||
    key.includes("view") ||
    key.includes("blackboard") ||
    key === "knowledge_query" ||
    key === "memory_load" ||
    key === "response" ||
    key === "call_mcp_tool" ||
    key === "mcp_get_tool_schema";

  const keep = (key: string) => {
    if (role === "researcher") return readOnlyMatch(key);
    if (role === "reviewer") return readOnlyMatch(key) || key.includes("grep");
    return true; // "coder" retains everything.
  };

  if (role !== "researcher" && role !== "reviewer") return tools;

  const filtered: ToolSet = {};
  for (const key of Object.keys(tools)) {
    if (keep(key)) filtered[key] = tools[key];
  }
  return filtered;
}
