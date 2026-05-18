"use client";

import { useState, useEffect } from "react";
import {
  CheckCircle2,
  Loader2,
  AlertCircle,
  Clock,
  Network,
  ChevronDown,
  ChevronRight,
  Code2,
  Search,
  Shield,
  Bot,
  Wrench,
  Square,
  XCircle,
} from "lucide-react";
import type { SwarmNodeStatus } from "@/lib/realtime/types";
import { useUiSyncEvents } from "@/hooks/use-background-sync";

/* ─────────────────────── types ─────────────────────── */

interface DAGNode {
  nodeId: string;
  parentNodeId?: string;
  role: string;
  taskSummary: string;
  status: SwarmNodeStatus;
  startedAt?: string;
  completedAt?: string;
  toolName?: string;
  children: string[]; // child nodeIds
}

/* ─────────────────────── hook ─────────────────────── */

export function useSwarmDAGEvents(chatId: string | null) {
  const [nodes, setNodes] = useState<Map<string, DAGNode>>(new Map());

  // Expose a way to clear state manually
  const clearNodes = () => setNodes(new Map());

  // Routes through the shared `/api/events` socket from useBackgroundSync.
  // Passing chatId=null short-circuits delivery via matchesScope.
  useUiSyncEvents({ chatId, topics: ["chat"] }, (parsed) => {
    if (parsed.reason === "swarm_reset") {
      setNodes(new Map());
      return;
    }

    if (!parsed.swarmNode) return;

    const sn = parsed.swarmNode;

    setNodes((prev) => {
      const next = new Map(prev);
      const existing = next.get(sn.nodeId);

      if (existing) {
        next.set(sn.nodeId, {
          ...existing,
          status: sn.status,
          completedAt: sn.completedAt ?? existing.completedAt,
        });
      } else {
        const node: DAGNode = {
          nodeId: sn.nodeId,
          parentNodeId: sn.parentNodeId,
          role: sn.role,
          taskSummary: sn.taskSummary,
          status: sn.status,
          startedAt: sn.startedAt,
          completedAt: sn.completedAt,
          toolName: sn.toolName,
          children: [],
        };
        next.set(sn.nodeId, node);

        if (sn.parentNodeId && next.has(sn.parentNodeId)) {
          const parent = next.get(sn.parentNodeId)!;
          if (!parent.children.includes(sn.nodeId)) {
            next.set(sn.parentNodeId, {
              ...parent,
              children: [...parent.children, sn.nodeId],
            });
          }
        }
      }

      return next;
    });
  });

  // Reset when chatId changes
  useEffect(() => {
    setNodes(new Map());
  }, [chatId]);

  return { nodes, clearNodes };
}

/* ─────────────────────── helpers ─────────────────────── */

function getRoleIcon(role: string, toolName?: string) {
  if (role === "tool") {
    switch (toolName) {
      case "code_execution":
        return <Code2 className="w-3.5 h-3.5" />;
      case "search_engine":
      case "search_blackboard":
        return <Search className="w-3.5 h-3.5" />;
      default:
        return <Wrench className="w-3.5 h-3.5" />;
    }
  }
  switch (role) {
    case "orchestrator":
      return <Network className="w-3.5 h-3.5" />;
    case "coder":
      return <Code2 className="w-3.5 h-3.5" />;
    case "researcher":
      return <Search className="w-3.5 h-3.5" />;
    case "reviewer":
      return <Shield className="w-3.5 h-3.5" />;
    default:
      return <Bot className="w-3.5 h-3.5" />;
  }
}

function getStatusColor(status: SwarmNodeStatus): string {
  switch (status) {
    case "queued":
      return "text-foreground bg-amber-500/5 border-amber-500/20";
    case "running":
      return "text-foreground bg-blue-500/10 border-blue-500/30 shadow-[0_0_15px_rgba(59,130,246,0.1)]";
    case "completed":
      return "text-foreground bg-emerald-500/5 border-emerald-500/20";
    case "error":
      return "text-foreground bg-red-500/5 border-red-500/20";
  }
}

function getStatusIcon(status: SwarmNodeStatus) {
  switch (status) {
    case "queued":
      return <Clock className="w-3 h-3 text-amber-400" />;
    case "running":
      return <Loader2 className="w-3 h-3 text-blue-400 animate-spin" />;
    case "completed":
      return <CheckCircle2 className="w-3 h-3 text-emerald-400" />;
    case "error":
      return <AlertCircle className="w-3 h-3 text-red-400" />;
  }
}

function getElapsedMs(startedAt?: string, completedAt?: string): string | null {
  if (!startedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const ms = end - start;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function getRoleLabel(role: string, toolName?: string): string {
  if (role === "tool" && toolName) {
    return toolName.replace(/_/g, " ");
  }
  return role.charAt(0).toUpperCase() + role.slice(1);
}

/* ─────────────────────── DAG Node Component ─────────────────────── */

function DAGNodeCard({ node, depth }: { node: DAGNode; depth: number }) {
  const isAgent = node.role !== "tool";
  const elapsed = getElapsedMs(node.startedAt, node.completedAt);

  return (
    <div
      className="animate-in fade-in slide-in-from-left-2 duration-300"
      style={{ animationDelay: `${depth * 60}ms` }}
    >
      <div
        className={`
          flex items-center gap-2.5 px-3 py-2 rounded-xl border transition-all duration-300 backdrop-blur-md
          ${getStatusColor(node.status)}
          ${isAgent ? "font-medium" : "text-xs opacity-80"}
        `}
      >
        {/* Status indicator */}
        {getStatusIcon(node.status)}

        {/* Role icon */}
        <div className={`${isAgent ? "" : "opacity-60"}`}>
          {getRoleIcon(node.role, node.toolName)}
        </div>

        {/* Content */}
        <div className="flex flex-col min-w-0 flex-1">
          <span className={`truncate ${isAgent ? "text-sm" : "text-xs"}`}>
            {getRoleLabel(node.role, node.toolName)}
          </span>
          {isAgent && node.taskSummary && (
            <span className="text-[10px] opacity-60 truncate">
              {node.taskSummary}
            </span>
          )}
        </div>

        {/* Elapsed time — tabular for steady alignment without leaning on `font-mono` */}
        {elapsed && (
          <span className="text-[10px] tabular-nums opacity-50 whitespace-nowrap ml-auto">
            {elapsed}
          </span>
        )}
      </div>
    </div>
  );
}



/* ─────────────────────── Main Component ─────────────────────── */

export function SwarmDAG({ chatId, externalNodes, onClearNodes }: { chatId: string | null; externalNodes?: Map<string, any>; onClearNodes?: () => void }) {
  const local = useSwarmDAGEvents(externalNodes ? null : chatId);
  const nodes = (externalNodes || local.nodes) as Map<string, DAGNode>;
  const clearNodes = onClearNodes || local.clearNodes;
  const [isOpen, setIsOpen] = useState(true);
  const [isStopping, setIsStopping] = useState(false);

  const handleStop = async (e: React.MouseEvent) => {
    e.stopPropagation(); // Don't trigger toggle
    if (!chatId) return;

    setIsStopping(true);
    try {
      await fetch("/api/chat/abort", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId }),
      });
      clearNodes();
    } catch (err) {
      console.error("Failed to stop swarm:", err);
    } finally {
      setIsStopping(false);
    }
  };

  const allCompleted = Array.from(nodes.values()).every(
    (n) => n.status === "completed" || n.status === "error"
  );
  const isActuallyFinished = allCompleted && Array.from(nodes.values()).some(n => n.role === "orchestrator");

  // Auto-open when first node arrives
  useEffect(() => {
    if (nodes.size > 0 && !isActuallyFinished) setIsOpen(true);
  }, [nodes.size, isActuallyFinished]);

  // Auto-close when finished
  useEffect(() => {
    if (isActuallyFinished) {
      const timer = setTimeout(() => {
        setIsOpen(false);
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [isActuallyFinished]);

  if (!chatId || nodes.size === 0) return null;

  const hasErrors = Array.from(nodes.values()).some((n) => n.status === "error");
  const runningCount = Array.from(nodes.values()).filter((n) => n.status === "running").length;
  const totalAgentNodes = Array.from(nodes.values()).filter(
    (n) => n.role !== "tool"
  ).length;

  return (
    <div className="mx-4 my-2 glass-panel rounded-xl overflow-hidden text-sm">
      {/* Header */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => setIsOpen(!isOpen)}
        onKeyDown={(e) => { if(e.key === 'Enter' || e.key === ' ') setIsOpen(!isOpen) }}
        className="w-full flex items-center justify-between p-3 px-4 hover:bg-white/5 transition-all duration-200 cursor-pointer"
      >
        <div className="flex items-center gap-3">
          {isActuallyFinished ? (
            hasErrors ? (
              <div className="p-1.5 rounded-lg bg-red-500/10">
                <AlertCircle className="w-4 h-4 text-red-400" />
              </div>
            ) : (
              <div className="p-1.5 rounded-lg bg-emerald-500/10">
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              </div>
            )
          ) : (
            <div className="p-1.5 rounded-lg bg-blue-500/10">
              <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />
            </div>
          )}
          <div className="flex flex-col items-start">
            <span className="font-medium text-foreground text-sm tracking-tight">
              {isActuallyFinished
                ? hasErrors
                  ? "Swarm Execution Failed"
                  : "Swarm Work Completed"
                : `Swarm Active — ${runningCount} agent${runningCount !== 1 ? "s" : ""} thinking`}
            </span>
          </div>

          {!allCompleted && (
            <button
              onClick={handleStop}
              disabled={isStopping}
              className="ml-4 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-500 text-xs font-medium transition-colors border border-red-500/20 disabled:opacity-50"
              title="Abort all running agents and clear state"
            >
              {isStopping ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Square className="w-3 h-3 fill-current" />
              )}
              Stop Swarm
            </button>
          )}

          {allCompleted && (
            <button
              onClick={(e) => { e.stopPropagation(); clearNodes(); }}
              className="ml-4 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-muted-foreground text-xs font-medium transition-colors border border-white/10"
              title="Clear execution trace"
            >
              <XCircle className="w-3 h-3" />
              Clear
            </button>
          )}

          <div className="flex items-center gap-2 ml-2">
            <span className="text-xs px-2 py-0.5 rounded-full bg-white/5 text-muted-foreground font-medium border border-white/5">
              {totalAgentNodes} agent{totalAgentNodes !== 1 ? "s" : ""}
            </span>
            {Array.from(nodes.values()).filter((n) => n.role === "tool").length > 0 && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-white/5 text-muted-foreground font-medium border border-white/5">
                {Array.from(nodes.values()).filter((n) => n.role === "tool").length} tools
              </span>
            )}
          </div>
        </div>
        {isOpen ? (
          <ChevronDown className="w-4 h-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="w-4 h-4 text-muted-foreground" />
        )}
      </div>

      {/* DAG Body — vertical stack, no horizontal overflow */}
      {isOpen && (() => {
        // Pre-compute each layer ONCE per render so guards and rendering share
        // the same source of truth. Layer 1 = Router (no parent). Layer 2 =
        // Proposers (non-orchestrator children of root). Layer 3 = Aggregator
        // (orchestrator with a parent). Connecting lines render only when the
        // layers on BOTH sides have content — pre-fix, a swarm that errored
        // before proposers spawned would leave a dangling line in the void.
        const allNodes = Array.from(nodes.values());
        const layer1 = allNodes.filter((n) => !n.parentNodeId);
        const layer2 = allNodes.filter(
          (n) => n.parentNodeId && n.role !== "orchestrator"
        );
        const layer3 = allNodes.filter(
          (n) => n.role === "orchestrator" && n.parentNodeId
        );
        const showTopLine = layer1.length > 0 && layer2.length > 0;
        const showBottomLine = layer2.length > 0 && layer3.length > 0;
        return (
          <div className="p-4 border-t border-border/30 relative">
            <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-blue-500/5 via-transparent to-transparent pointer-events-none" />

            <div className="relative z-10 flex flex-col gap-3 w-full min-w-0">
              {/* Layer 1: Router */}
              {layer1.map((rootNode) => (
                <DAGNodeCard key={rootNode.nodeId} node={rootNode} depth={0} />
              ))}

              {showTopLine && (
                <div className="self-center w-px h-4 bg-gradient-to-b from-border/80 to-transparent" />
              )}

              {/* Layer 2: Proposers (vertical stack). Wrapper renders only
                  when there's content — avoids an empty gap between top and
                  bottom connecting lines. */}
              {layer2.length > 0 && (
                <div className="flex flex-col gap-2">
                  {layer2.map((proposer) => (
                    <div key={proposer.nodeId} className="flex flex-col gap-1.5">
                      <DAGNodeCard node={proposer} depth={1} />

                      {proposer.children?.length > 0 && (
                        <div className="pl-3 ml-2 border-l-2 border-border/20 flex flex-col gap-1">
                          {proposer.children.map((childId) => {
                            const child = nodes.get(childId);
                            if (!child) return null;
                            return <DAGNodeCard key={childId} node={child} depth={2} />;
                          })}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {showBottomLine && (
                <div className="self-center w-px h-4 bg-gradient-to-t from-border/80 to-transparent" />
              )}

              {/* Layer 3: Aggregator */}
              {layer3.map((agg) => (
                <DAGNodeCard key={agg.nodeId} node={agg} depth={2} />
              ))}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
