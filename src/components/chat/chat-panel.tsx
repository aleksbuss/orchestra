"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import type { UIMessage } from "ai";
import { ChatMessages } from "./chat-messages";
import { ChatInput } from "./chat-input";
import { useAppStore } from "@/store/app-store";
import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import type { ChatMessage } from "@/lib/types";
import { useBackgroundSync } from "@/hooks/use-background-sync";
import { useChatError } from "@/hooks/use-chat-error";
import { generateClientId } from "@/lib/utils";
import { GoalTree } from "@/components/chat/goal-tree";
import { ChatErrorBanner } from "@/components/chat/chat-error-banner";
import { BudgetBanner } from "@/components/chat/budget-banner";

/** Convert stored ChatMessage to UIMessage (parts format for useChat) */
function chatMessagesToUIMessages(chatMessages: ChatMessage[]): UIMessage[] {
  const result: UIMessage[] = [];

  // Build a map of toolCallId -> tool result for pairing
  const toolResultMap = new Map<string, ChatMessage>();
  for (const m of chatMessages) {
    if (m.role === "tool" && m.toolCallId) {
      toolResultMap.set(m.toolCallId, m);
    }
  }

  for (const m of chatMessages) {
    if (m.role === "user") {
      result.push({
        id: m.id,
        role: "user",
        parts: [{ type: "text" as const, text: m.content }],
      });
    } else if (m.role === "assistant") {
      const parts: UIMessage["parts"] = [];

      // Add tool call parts with their results
      if (m.toolCalls && m.toolCalls.length > 0) {
        for (const tc of m.toolCalls) {
          const toolResult = toolResultMap.get(tc.toolCallId);
          parts.push({
            type: `tool-${tc.toolName}` as `tool-${string}`,
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            state: "output-available" as const,
            input: tc.args,
            output: toolResult?.toolResult ?? toolResult?.content ?? "",
          } as unknown as UIMessage["parts"][number]);
        }
      }

      // Add text content
      if (m.content) {
        parts.push({ type: "text" as const, text: m.content });
      }

      // Only add message if it has content
      if (parts.length > 0) {
        result.push({
          id: m.id,
          role: "assistant",
          parts,
        });
      }
    }
    // Skip "tool" role messages - they are paired with assistant toolCalls above
  }

  return result;
}

interface SwitchProjectResult {
  success?: boolean;
  action?: string;
  projectId?: string;
  currentPath?: string;
}

interface CreateProjectResult {
  success?: boolean;
  action?: string;
  projectId?: string;
}

function tryParseSwitchProjectResult(output: unknown): SwitchProjectResult | null {
  if (output == null) return null;

  let parsed: unknown = output;
  if (typeof output === "string") {
    const trimmed = output.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  if (record.action !== "switch_project" || record.success !== true) {
    return null;
  }

  const projectId = typeof record.projectId === "string" ? record.projectId : undefined;
  if (!projectId?.trim()) {
    return null;
  }

  return {
    success: true,
    action: "switch_project",
    projectId,
    currentPath:
      typeof record.currentPath === "string" ? record.currentPath : undefined,
  };
}

function tryParseCreateProjectResult(output: unknown): CreateProjectResult | null {
  if (output == null) return null;

  let parsed: unknown = output;
  if (typeof output === "string") {
    const trimmed = output.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  if (record.action !== "create_project" || record.success !== true) {
    return null;
  }

  const projectId = typeof record.projectId === "string" ? record.projectId : undefined;
  if (!projectId?.trim()) {
    return null;
  }

  return {
    success: true,
    action: "create_project",
    projectId,
  };
}

function extractToolPartInfo(
  part: UIMessage["parts"][number],
  toolName: string
): { key: string; output: unknown } | null {
  if (part.type === "dynamic-tool") {
    const dynamicPart = part as {
      type: "dynamic-tool";
      toolName: string;
      toolCallId: string;
      state: string;
      output?: unknown;
    };
    if (
      dynamicPart.toolName !== toolName ||
      dynamicPart.state !== "output-available"
    ) {
      return null;
    }
    return {
      key: dynamicPart.toolCallId ? `${toolName}:${dynamicPart.toolCallId}` : "",
      output: dynamicPart.output,
    };
  }

  if (part.type === `tool-${toolName}`) {
    const toolPart = part as {
      type: string;
      toolCallId: string;
      state: string;
      output?: unknown;
    };
    if (toolPart.state !== "output-available") {
      return null;
    }
    return {
      key: toolPart.toolCallId ? `${toolName}:${toolPart.toolCallId}` : "",
      output: toolPart.output,
    };
  }

  return null;
}

function areUIMessagesEquivalentById(
  left: UIMessage[],
  right: UIMessage[]
): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i].id !== right[i].id) return false;
    if (left[i].role !== right[i].role) return false;
  }
  return true;
}

import { SwarmDAG, useSwarmDAGEvents } from "./swarm-dag";
import { Plane, Loader2, Activity } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

export function ChatPanel() {
  const {
    activeChatId,
    setActiveChatId,
    activeProjectId,
    currentPath,
    setCurrentPath,
    setActiveProjectId,
    setProjects,
    addChat,
    swarmEnabled,
    daemonMode,
    forceSwarm,
    activePreset,
  } = useAppStore();
  
  // Internal chatId that stays stable during a message send.
  // Pre-generate a UUID so useChat always has a consistent id.
  const [internalChatId, setInternalChatId] = useState(
    () => activeChatId || generateClientId()
  );

  const { nodes: swarmNodes, clearNodes: clearSwarmNodes } = useSwarmDAGEvents(activeChatId || internalChatId);
  const [input, setInput] = useState("");
  const [autoPilotStatus, setAutoPilotStatus] = useState<"idle" | "queued" | "error">("idle");
  // PM #17 follow-up — Sprint 3 backend already publishes structured chat
  // errors over SSE. The hook below picks them up for the active chat and
  // the `<ChatErrorBanner />` below renders them above the input. Without
  // this, the user sees an empty pane when the swarm crashes after MoA.
  const { error: chatError, dismiss: dismissChatError } = useChatError(
    activeChatId || internalChatId
  );
  // PM #36 — soft budget banner snapshot for the active chat. Populated from
  // /api/chat/history (whole chat object includes `cumulativeUsage`); cleared
  // when switching to a chat with no recorded usage.
  const [cumulativeUsage, setCumulativeUsage] = useState<
    import("@/lib/types").ChatUsage | undefined
  >(undefined);
  const syncTick = useBackgroundSync({
    topics: ["chat", "global"],
    projectId: activeProjectId ?? null,
    chatId: activeChatId ?? undefined,
  });
  const internalChatIdRef = useRef(internalChatId);
  internalChatIdRef.current = internalChatId;

  const activeProjectIdRef = useRef(activeProjectId);
  activeProjectIdRef.current = activeProjectId;

  const currentPathRef = useRef(currentPath);
  currentPathRef.current = currentPath;

  const swarmEnabledRef = useRef(swarmEnabled);
  swarmEnabledRef.current = swarmEnabled;

  const forceSwarmRef = useRef(forceSwarm);
  forceSwarmRef.current = forceSwarm;

  const daemonModeRef = useRef(daemonMode);
  daemonModeRef.current = daemonMode;

  const activePresetRef = useRef(activePreset);
  activePresetRef.current = activePreset;

  // Track the last activeChatId we've seen to detect external navigation
  const prevActiveChatId = useRef(activeChatId);

  // Sync internalChatId when user navigates to a different chat via sidebar
  useEffect(() => {
    if (activeChatId !== prevActiveChatId.current) {
      prevActiveChatId.current = activeChatId;
      if (activeChatId !== null) {
        setInternalChatId(activeChatId);
      } else {
        // "New chat" clicked — generate fresh id
        setInternalChatId(generateClientId());
      }
    }
  }, [activeChatId]);

  // Stable transport — body is a function so it always reads current refs
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        body: () => ({
          chatId: internalChatIdRef.current,
          projectId: activeProjectIdRef.current,
          currentPath: currentPathRef.current,
          swarmEnabled: swarmEnabledRef.current,
          forceSwarm: forceSwarmRef.current,
          background: daemonModeRef.current,
          preset: activePresetRef.current,
        }),
      }),
    []
  );

  const { messages, sendMessage, status, stop, setMessages } = useChat({
    id: internalChatId,
    transport,
    onError: (error) => {
      console.error("Chat error:", error);
    },
  });

  // Don't overwrite messages while a request is in flight (avoids "blink" on new chat)
  const statusRef = useRef(status);
  statusRef.current = status;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const pendingProjectSwitchRef = useRef(false);
  const submissionStartCountRef = useRef<number | null>(null);
  const handledSwitchToolCallsRef = useRef<Set<string>>(new Set());
  const queuedSwitchResultRef = useRef<SwitchProjectResult | null>(null);
  const shouldRefreshProjectsRef = useRef(false);
  const switchInFlightRef = useRef(false);

  // Reset local messages when switching to "new chat" mode.
  useEffect(() => {
    if (activeChatId === null) {
      setMessages([]);
    }
  }, [activeChatId, setMessages]);

  // Refetch gating refs:
  //   - prevChatIdRef / prevStatusRef catch chat switches and stream-end edges
  //     (status: submitted|streaming → ready|error|idle), where we always want
  //     the freshest history.
  //   - lastSyncFetchAtRef throttles bare syncTick-driven refetches to once
  //     per ~1.5s. SSE bursts during autoresearch fired ~50 events/sec; each
  //     used to trigger a full /api/chat/history fetch + 376 KB JSON parse,
  //     which blocked the main thread and made the UI feel frozen.
  const prevChatIdRef = useRef(activeChatId);
  const prevStatusRef = useRef(status);
  const lastSyncFetchAtRef = useRef(0);
  const SYNC_REFETCH_MIN_INTERVAL_MS = 1500;

  // Keep active chat history synced with background updates.
  useEffect(() => {
    if (activeChatId === null) return;
    if (status === "submitted" || status === "streaming") {
      prevStatusRef.current = status;
      prevChatIdRef.current = activeChatId;
      return;
    }

    const chatChanged = prevChatIdRef.current !== activeChatId;
    const streamJustEnded =
      prevStatusRef.current === "submitted" ||
      prevStatusRef.current === "streaming";
    const forceRefetch = chatChanged || streamJustEnded;
    prevChatIdRef.current = activeChatId;
    prevStatusRef.current = status;

    if (!forceRefetch) {
      const now = Date.now();
      if (now - lastSyncFetchAtRef.current < SYNC_REFETCH_MIN_INTERVAL_MS) {
        return;
      }
      lastSyncFetchAtRef.current = now;
    } else {
      lastSyncFetchAtRef.current = Date.now();
    }

    let cancelled = false;
    fetch(`/api/chat/history?id=${encodeURIComponent(activeChatId)}`)
      .then((r) => {
        if (r.status === 404) {
          return null;
        }
        if (!r.ok) throw new Error("Failed to load chat");
        return r.json() as Promise<{ messages?: ChatMessage[]; cumulativeUsage?: import("@/lib/types").ChatUsage }>;
      })
      .then((chat) => {
        if (cancelled) return;
        // Don't overwrite while user is sending or stream is in progress
        if (statusRef.current === "submitted" || statusRef.current === "streaming") {
          return;
        }

        if (!chat?.messages) {
          setMessages([]);
          setCumulativeUsage(undefined);
          return;
        }

        // PM #36 — pick up the chat's running cost banner snapshot.
        setCumulativeUsage(chat.cumulativeUsage);

        const nextMessages = chatMessagesToUIMessages(chat.messages);
        if (areUIMessagesEquivalentById(messagesRef.current, nextMessages)) {
          return;
        }
        setMessages(nextMessages);
      })
      .catch(() => {
        // Keep last known messages on transient polling/network errors.
      });
    return () => {
      cancelled = true;
    };
  }, [activeChatId, setMessages, status, syncTick]);

  const refreshProjects = useCallback(async () => {
    try {
      const response = await fetch("/api/projects");
      const data = await response.json();
      if (Array.isArray(data)) {
        setProjects(data);
      }
    } catch {
      // ignore project list refresh failures
    }
  }, [setProjects]);

  const applySwitchResult = useCallback(
    (result: SwitchProjectResult) => {
      if (switchInFlightRef.current) return;
      const nextProjectId = result.projectId?.trim();
      if (!nextProjectId) return;

      switchInFlightRef.current = true;
      try {
        if (activeProjectIdRef.current === nextProjectId) {
          setCurrentPath(result.currentPath ?? "");
          return;
        }
        setActiveProjectId(nextProjectId);
        setCurrentPath(result.currentPath ?? "");
      } finally {
        switchInFlightRef.current = false;
      }
    },
    [setActiveProjectId, setCurrentPath]
  );

  useEffect(() => {
    if (!pendingProjectSwitchRef.current) return;

    if (status === "submitted") return;

    const startIndex = submissionStartCountRef.current ?? messages.length;
    const recentMessages = messages.slice(startIndex);
    const latestAssistant = [...recentMessages]
      .reverse()
      .find((m) => m.role === "assistant");

    if (latestAssistant) {
      for (let idx = 0; idx < latestAssistant.parts.length; idx++) {
        const part = latestAssistant.parts[idx];
        const switchInfo = extractToolPartInfo(part, "switch_project");
        if (switchInfo) {
          const key = switchInfo.key || `${latestAssistant.id}-${idx}-switch`;
          if (!handledSwitchToolCallsRef.current.has(key)) {
            handledSwitchToolCallsRef.current.add(key);
            const parsedSwitch = tryParseSwitchProjectResult(switchInfo.output);
            if (parsedSwitch) {
              queuedSwitchResultRef.current = parsedSwitch;
              shouldRefreshProjectsRef.current = true;
            }
          }
        }

        const createInfo = extractToolPartInfo(part, "create_project");
        if (createInfo) {
          const key = createInfo.key || `${latestAssistant.id}-${idx}-create`;
          if (!handledSwitchToolCallsRef.current.has(key)) {
            handledSwitchToolCallsRef.current.add(key);
            const parsedCreate = tryParseCreateProjectResult(createInfo.output);
            if (parsedCreate) {
              shouldRefreshProjectsRef.current = true;
            }
          }
        }
      }
    }

    if (status === "ready" || status === "error") {
      const queued = queuedSwitchResultRef.current;
      const shouldRefresh = shouldRefreshProjectsRef.current || Boolean(queued);
      pendingProjectSwitchRef.current = false;
      submissionStartCountRef.current = null;
      handledSwitchToolCallsRef.current.clear();
      queuedSwitchResultRef.current = null;
      shouldRefreshProjectsRef.current = false;

      void (async () => {
        if (shouldRefresh) {
          await refreshProjects();
        }
        if (queued) {
          applySwitchResult(queued);
        }
      })();
    }
  }, [messages, status, applySwitchResult, refreshProjects]);

  const isLoading = status === "submitted" || status === "streaming";

  const onSubmit = useCallback(async () => {
    if (!input.trim() || isLoading) return;

    // Clear any stale chat-error banner — a new turn earns a fresh chance.
    // Leaving it visible across turns confuses the user about which turn
    // the error refers to.
    dismissChatError();

    const messageText = input;
    const currentChatId = activeChatId || internalChatId;

    pendingProjectSwitchRef.current = true;
    submissionStartCountRef.current = messagesRef.current.length;
    handledSwitchToolCallsRef.current.clear();
    queuedSwitchResultRef.current = null;
    shouldRefreshProjectsRef.current = false;

    // If no active chat, register in the store.
    if (!activeChatId) {
      prevActiveChatId.current = internalChatId;
      setActiveChatId(internalChatId);
      addChat({
        id: internalChatId,
        title: messageText.slice(0, 60) + (messageText.length > 60 ? "..." : ""),
        projectId: activeProjectId || undefined,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: 1,
      });
    }

    // Auto-Pilot mode: send via direct fetch, not SSE stream
    if (daemonModeRef.current) {
      setInput("");
      // Add user message to local UI immediately
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "user" as const,
          parts: [{ type: "text" as const, text: messageText }],
        },
      ]);
      setAutoPilotStatus("queued");

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chatId: currentChatId,
            projectId: activeProjectIdRef.current,
            currentPath: currentPathRef.current,
            swarmEnabled: swarmEnabledRef.current,
            forceSwarm: forceSwarmRef.current,
            // Carry the active preset through to background mode too. Without
            // this, the daemon dispatcher uses settings.chatModel directly,
            // ignoring whatever preset the user had pinned in the UI when
            // they triggered Auto-Pilot.
            preset: activePresetRef.current,
            background: true,
            message: messageText,
          }),
        });

        if (!res.ok) {
          setAutoPilotStatus("error");
        } else {
          // Auto-clear queued status after 5s
          setTimeout(() => setAutoPilotStatus("idle"), 5000);
        }
      } catch {
        setAutoPilotStatus("error");
        setTimeout(() => setAutoPilotStatus("idle"), 5000);
      }
      return;
    }

    // Interactive mode: stream via useChat
    sendMessage({ text: messageText });
    setInput("");
  }, [
    input,
    isLoading,
    activeChatId,
    internalChatId,
    setActiveChatId,
    addChat,
    activeProjectId,
    sendMessage,
    setMessages,
    dismissChatError,
  ]);

  const handleStop = useCallback(() => {
    // 1. Stop client-side streaming (useChat)
    stop();

    // 2. Abort server-side daemon job if running
    const currentChatId = activeChatId || internalChatId;
    if (currentChatId && daemonMode) {
      fetch("/api/chat/abort", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId: currentChatId }),
      }).catch(() => {
        // Non-critical — streaming stop already worked
      });
    }
  }, [stop, activeChatId, internalChatId, daemonMode]);

  return (
    <div className="flex flex-col h-full min-h-0 relative">
      {swarmEnabled && (
        <div className="absolute top-4 right-4 z-20">
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="outline" size="sm" className="glass-panel text-primary gap-2 rounded-xl border-white/10 hover:bg-white/5 transition-colors shadow-lg shadow-black/20">
                <Activity className="size-4" />
                Swarm Activity
              </Button>
            </SheetTrigger>
            <SheetContent className="w-[400px] sm:w-[540px] border-l border-white/10 bg-[#020617]/95 backdrop-blur-3xl overflow-y-auto p-0 z-[100] !max-w-none">
              <SheetHeader className="p-4 border-b border-white/10 sticky top-0 bg-[#020617]/95 backdrop-blur z-10">
                <SheetTitle className="text-foreground flex items-center gap-2 text-sm font-semibold">
                  <Activity className="size-4 text-primary" />
                  Swarm Activity
                </SheetTitle>
              </SheetHeader>
              <div className="p-4 space-y-4">
                <GoalTree chatId={activeChatId || internalChatId} syncTick={syncTick} />
                <SwarmDAG chatId={activeChatId || internalChatId} externalNodes={swarmNodes} onClearNodes={clearSwarmNodes} />
              </div>
            </SheetContent>
          </Sheet>
        </div>
      )}

      {/* Auto-Pilot status toast */}
      {autoPilotStatus === "queued" && (
        <div className="mx-auto max-w-3xl w-full px-6 pt-2 animate-in fade-in slide-in-from-top-2 duration-300">
          <div className="flex items-center gap-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 px-4 py-2.5">
            <div className="flex items-center justify-center size-7 rounded-full bg-emerald-500/20">
              <Plane className="size-3.5 text-emerald-400" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-medium text-emerald-300">Auto-Pilot active</p>
              <p className="text-xs text-emerald-400/60">Task queued — agent is working in background. Results will appear here automatically.</p>
            </div>
            <Loader2 className="size-4 text-emerald-400 animate-spin" />
          </div>
        </div>
      )}
      {autoPilotStatus === "error" && (
        <div className="mx-auto max-w-3xl w-full px-6 pt-2 animate-in fade-in slide-in-from-top-2 duration-300">
          <div className="flex items-center gap-3 rounded-xl bg-red-500/10 border border-red-500/20 px-4 py-2.5">
            <p className="text-sm text-red-300">⚠️ Auto-Pilot failed to queue the task. Check your API key or connection.</p>
          </div>
        </div>
      )}

      {/* Structured chat-error banner (PM #17 follow-up). The hook listens
          for `chatError` payloads on the SSE bus; the banner renders the
          message + actionable hint + a copyable trace id. Auto-clears when
          the user sends a new turn. */}
      {chatError && (
        <ChatErrorBanner error={chatError} onDismiss={dismissChatError} />
      )}

      {/* PM #36 — running tokens + cost estimate for this chat. Unobtrusive;
          hidden when no LLM call has landed yet. Hover for breakdown. */}
      <BudgetBanner usage={cumulativeUsage} />

      <ChatMessages messages={messages} isLoading={isLoading} status={status} />
      
      <div className="relative mx-auto max-w-3xl w-full px-3 sm:px-4 flex justify-start -mb-2 z-10" />

      <ChatInput
        input={input}
        setInput={setInput}
        onSubmit={onSubmit}
        onStop={handleStop}
        isLoading={isLoading}
        chatId={activeChatId || internalChatId}
      />
    </div>
  );
}
