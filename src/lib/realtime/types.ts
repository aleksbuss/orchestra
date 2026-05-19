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
  | "internal"
  /**
   * Auto-recovery: the configured chat model was unavailable (404 / deprecated /
   * tool-incompatible) and the agent automatically switched to a fallback. The
   * UI should render this as an INFO toast, not an error — the chat turn
   * succeeded. The payload's `modelFallback` field carries the details.
   */
  | "model_fallback";

/**
 * Details of an automatic model fallback event. Attached to a `model_fallback`
 * chat error so the UI can render a focused "we switched providers" toast
 * rather than the generic upstream-error banner.
 *
 * Pricing is informational only — if the fallback model has a different cost,
 * we surface it so the user knows their next invoice may differ. We do NOT
 * compute or track actual costs here; that's a separate billing surface.
 */
export interface ModelFallbackDetails {
  originalModel: string;
  newModel: string;
  /** Which provider both models belong to (e.g. "openrouter"). */
  provider: string;
  /**
   * Where the replacement came from:
   *   - `openrouter_catalog` — queried OpenRouter `/models` and picked the
   *     cheapest tool-capable entry.
   *   - `static_chain` — hardcoded fallback chain for providers that don't
   *     expose pricing via API (OpenAI, Anthropic, Google).
   *   - `ollama_local` — picked from locally-installed Ollama models.
   */
  source: "openrouter_catalog" | "static_chain" | "ollama_local";
  /** Best-effort pricing for the new model, when available. */
  pricing?: {
    promptUsdPerMillion?: number;
    completionUsdPerMillion?: number;
    /** True if the new model is free-tier (e.g. OpenRouter `:free` variant). */
    isFree?: boolean;
  };
  /** Why the original model failed. Surfaced in the UI as context. */
  reason: "model_not_found" | "no_tool_support" | "unknown_4xx";
}

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
  /** Set when `kind === "model_fallback"`. */
  modelFallback?: ModelFallbackDetails;
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

