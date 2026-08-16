import type { ModelMessage } from "ai";

export interface AgentContext {
  chatId: string;
  projectId?: string;
  currentPath?: string; // relative path within the project for cwd
  /**
   * The project's CONTENT root for this run, resolved once by the agent
   * context builder via `getProjectContentRoot` — the user's real repo
   * (`absoluteRoot`) for a linked project, `data/projects/<id>/` for a
   * sandbox one. Sync helpers read it directly to avoid an async lookup on
   * every file resolution.
   *
   * Optional for backward compat. When it is undefined, callers fall back to
   * `getProjectMetaRoot(projectId)` — the Orchestra-owned sandbox, NOT a sync
   * guess at the content root. PM #105: every consumer must go through
   * `resolveContextBaseDir`, so the path the agent is TOLD and the path its
   * tools ACT in can never disagree.
   */
  workDir?: string;
  memorySubdir: string;
  knowledgeSubdirs: string[];
  history: ModelMessage[];
  agentNumber: number;
  parentContext?: AgentContext;
  /**
   * SECURITY (PM #92) — true when this run was triggered by UNTRUSTED external
   * input (a Telegram / external-API message from a non-operator), NOT the
   * operator's own interactive or cron use. RCE-class tools (code_execution,
   * install_packages, process) are withheld from untrusted triggers unless the
   * operator explicitly opts in via `settings.codeExecution.allowExternalTriggers`.
   * MUST be propagated to subordinate agents (`call_subordinate`) so the gate
   * cannot be laundered through one hop of delegation.
   */
  untrustedTrigger?: boolean;
  data: Record<string, unknown>;
}

export interface AgentLoopResult {
  response: string;
  toolCalls: AgentToolCallRecord[];
}

export interface AgentToolCallRecord {
  toolName: string;
  args: Record<string, unknown>;
  result: string;
  timestamp: string;
}

export interface StreamCallbacks {
  onTextDelta?: (delta: string) => void;
  onToolCall?: (toolName: string, args: Record<string, unknown>) => void;
  onToolResult?: (toolName: string, result: string) => void;
  onFinish?: (result: AgentLoopResult) => void;
}
