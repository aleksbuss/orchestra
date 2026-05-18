"use client";

import { useState, useEffect } from "react";
import { ChevronDown, ChevronRight, CheckCircle2, Loader2, Network } from "lucide-react";
import { useUiSyncEvents } from "@/hooks/use-background-sync";

export interface TraceNode {
  id: string;
  label: string;
  status: "pending" | "success" | "error";
}

/**
 * Listens to swarm trace events via the shared `/api/events` socket.
 * Previously this opened its own EventSource — see C5 in the audit:
 * combined with the shared sync socket and per-chat streams it pushed
 * the browser past the 6-connection ceiling under any non-trivial use.
 */
function useSwarmEvents(chatId: string | null) {
  const [traces, setTraces] = useState<TraceNode[]>([]);

  useUiSyncEvents({ chatId, topics: ["chat"] }, (parsed) => {
    if (parsed.nodeType !== "agent_node") return;
    setTraces((prev) => [
      ...prev,
      {
        id: parsed.parentId || String(parsed.id),
        label: parsed.reason || "Agent spawned...",
        status: parsed.reason?.toLowerCase().includes("completed")
          ? "success"
          : "pending",
      },
    ]);
  });

  // Clear traces when switching chats so the prior swarm doesn't bleed in.
  useEffect(() => {
    setTraces([]);
  }, [chatId]);

  return traces;
}

export function SwarmTrace({ chatId }: { chatId: string | null }) {
  const [isOpen, setIsOpen] = useState(false);
  const traces = useSwarmEvents(chatId);

  // Auto-open when first trace arrives
  useEffect(() => {
    if (traces.length > 0) setIsOpen(true);
  }, [traces.length]);

  if (!chatId || traces.length === 0) return null;

  const isRunning = traces[traces.length - 1]?.status === "pending";

  return (
    <div className="mx-4 my-2 border rounded-lg bg-card/50 overflow-hidden text-sm">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          {isRunning ? (
            <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />
          ) : (
            <Network className="w-4 h-4 text-green-500" />
          )}
          <span className="font-semibold text-muted-foreground">
            {isRunning ? "Swarm is thinking..." : "Swarm execution complete"}
          </span>
          <span className="text-xs px-2 py-0.5 rounded-full bg-secondary">
            {traces.length} steps
          </span>
        </div>
        {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
      </button>

      {isOpen && (
        <div className="p-3 border-t bg-background/50 space-y-3">
          {traces.map((node, i) => (
            <div key={i} className="flex items-start gap-3 animate-in fade-in slide-in-from-top-1">
              <div className="mt-0.5">
                {node.status === "success" ? (
                  <CheckCircle2 className="w-4 h-4 text-green-500" />
                ) : (
                  <Loader2 className="w-4 h-4 text-muted-foreground animate-spin" />
                )}
              </div>
              <div className="flex flex-col">
                <span className="text-foreground/90 font-medium">
                  {node.label}
                </span>
                <span className="text-xs text-muted-foreground font-mono mt-1">
                  Node ID: {node.id}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
