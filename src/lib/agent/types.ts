import type { ModelMessage } from "ai";

export interface AgentContext {
  chatId: string;
  projectId?: string;
  currentPath?: string; // relative path within the project for cwd
  /**
   * Resolved absolute work directory for this run. Populated by the agent
   * context builder after looking up the project — for linked projects this
   * is the user's real repo root (`absoluteRoot`), for sandbox projects it
   * is `data/projects/<id>/`. Sync helpers in `tool.ts` (resolveContextCwd)
   * read this directly to avoid an async lookup on every file resolution.
   * Optional for backward compat; if undefined, callers fall back to
   * `getWorkDir(projectId)` which returns the sandbox path.
   */
  workDir?: string;
  memorySubdir: string;
  knowledgeSubdirs: string[];
  history: ModelMessage[];
  agentNumber: number;
  parentContext?: AgentContext;
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
