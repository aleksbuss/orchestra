export type UiSyncTopic = "projects" | "chat" | "files" | "global";

export type SwarmNodeStatus = "queued" | "running" | "completed" | "error";

export interface SwarmNodeData {
  nodeId: string;
  parentNodeId?: string;
  role: string;             // "orchestrator" | "coder" | "researcher" | "reviewer" | "tool"
  taskSummary: string;
  status: SwarmNodeStatus;
  startedAt?: string;
  completedAt?: string;
  toolName?: string;        // for tool_node events
}

/**
 * Structured chat-level error event (Sprint 3 / PM #17 follow-up).
 *
 * Why this exists: PM #17 was caused by an upstream 404 (OpenRouter "no
 * endpoints support tool use") that happened AFTER MoA had successfully
 * produced a consensus. The error was logged on the server side but never
 * reached the UI — the user saw "Swarm crashed" with a blank message
 * pane. This payload, attached to a `topic: "chat"` event, gives the
 * frontend the data it needs to render a visible, actionable error toast
 * instead of an empty pane.
 *
 * The `kind` field is the only branchable piece — UIs should map it to
 * a localized message + a hint. Add new kinds rather than overloading
 * existing ones.
 */
export type ChatErrorKind =
  | "upstream_no_tools"   // PM #17: model rejected tool use
  | "upstream_rate_limit" // 429
  | "upstream_4xx"
  | "upstream_5xx"
  | "abort"
  | "internal";

export interface ChatErrorPayload {
  /** Server-side trace id — copy/pasteable into logs for postmortem grep. */
  traceId?: string;
  kind: ChatErrorKind;
  /** Short human-readable message — already user-safe (no internals). */
  message: string;
  /** Optional actionable hint, e.g. "Switch chat model in Settings". */
  hint?: string;
  /** True if the agent might succeed on retry (e.g., transient 5xx). */
  recoverable: boolean;
}

export interface UiSyncEvent {
  id: number;
  topic: UiSyncTopic;
  at: string;
  projectId?: string | null;
  chatId?: string;
  reason?: string;
  parentId?: string;
  nodeType?: "agent_node" | "tool_node" | "system_node";
  swarmNode?: SwarmNodeData;
  /** Set on `topic: "chat"` events emitted from agent error paths. */
  chatError?: ChatErrorPayload;
}

