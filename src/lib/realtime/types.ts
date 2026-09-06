export type UiSyncTopic = "projects" | "chat" | "files" | "global";

/**
 * PM #98 — `cancelled` is distinct from `error` on purpose: a user pressing
 * stop is not a system failure, and colouring their own deliberate action red
 * is the same class of lie as reporting a provider stall as "cancelled".
 */
export type SwarmNodeStatus = "queued" | "running" | "completed" | "error" | "cancelled";

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
  /**
   * PM #98: the provider accepted the connection and then went silent — either
   * it never sent a first token, or it stopped mid-answer. Distinct from
   * `abort` (which means the USER cancelled) because the user did nothing, and
   * distinct from `upstream_5xx` because the provider never said anything at
   * all. Recoverable: a retry frequently lands on a healthier endpoint.
   */
  | "stream_stalled"
  | "internal"
  /**
   * Auto-recovery: the configured chat model was unavailable (404 / deprecated /
   * tool-incompatible) and the agent automatically switched to a fallback. The
   * UI should render this as an INFO toast, not an error — the chat turn
   * succeeded. The payload's `modelFallback` field carries the details.
   */
  | "model_fallback"
  /**
   * Post-review Sprint 0: the primary turn's own model call errored, and
   * `primary-stream-recovery.ts` delivered a substitute answer for THIS turn
   * specifically (distinct from `model_fallback`, which changes the DEFAULT
   * model for FUTURE turns — this changes nothing persisted, one turn only).
   * Render as an INFO toast, not an error — the chat turn succeeded.
   */
  | "turn_recovered"
  /**
   * Tool-capable-retry-on-model-swap: the substitute didn't just answer with
   * text — it re-ran the FULL task WITH tools on a different model and
   * genuinely completed it (`tool-capable-retry.ts`). Distinct from
   * `turn_recovered` (a tool-less forced summary/refusal, which structurally
   * cannot complete a task that needs a tool) — this one actually finished
   * the work. Render as an INFO toast, not an error.
   */
  | "turn_recovered_with_tools"
  /**
   * PM #132 — the recovery ladder DID produce text for this turn, but that text
   * was a tool call the model printed instead of executing, so the user was
   * handed an honest failure notice rather than the substitute's "answer".
   * Deliberately NOT `turn_recovered`: that banner says "Answered by a different
   * model", which would be a false claim about a turn where nothing was
   * answered and nothing was executed. Amber, not emerald — this turn failed.
   */
  | "turn_degraded"
  /**
   * PM #122 — fired the MOMENT the retry/substitute ladder actually starts
   * (`final-answer-failover.ts`'s call sites), before it is known whether it
   * will succeed. The ladder runs `generateText`, never `streamText` — zero
   * chunks reach the client for its entire duration (live-measured: 73s to
   * 7+ minutes on a degraded free tier) — so `useChat`'s own `status` has
   * already left `streaming`/`submitted` by the time this fires (the ORIGINAL
   * stream already errored or finished empty). Without this event the UI's
   * loading indicator vanishes long before the turn is actually done, and a
   * real, eventually-successful recovery looks identical to a silent death
   * for the whole gap. Superseded by `turn_recovered` (success) or the
   * ordinary error path (failure) once the ladder settles — never terminal
   * on its own.
   */
  | "recovering";

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

