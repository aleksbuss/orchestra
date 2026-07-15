"use client";

import { useState, useEffect, useRef } from "react";
import { Terminal } from "lucide-react";
import { useUiSyncEvents } from "@/hooks/use-background-sync";

interface LogEntry {
  id: string;
  time: string;
  message: string;
}

export function SwarmTerminal({ chatId }: { chatId: string | null }) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Subscribe to chat events
  useUiSyncEvents({ chatId, topics: ["chat"] }, (parsed) => {
    // Only capture events with a reason or a taskSummary (which means they are meaningful agent actions)
    const message = parsed.reason || parsed.swarmNode?.taskSummary;
    if (!message) return;
    
    // Ignore simple "Agent spawned..." if we have a taskSummary
    if (message.includes("Agent spawned") && parsed.swarmNode?.taskSummary) {
      return;
    }

    setLogs((prev) => {
      // Prevent exact duplicates if event bus fires twice quickly
      if (prev.length > 0 && prev[prev.length - 1].id === String(parsed.id)) {
        return prev;
      }

      const now = new Date();
      const timeString = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}.${now.getMilliseconds().toString().padStart(3, '0')}`;

      // U1 (PM #33) — cap the buffer. This list re-renders on every SSE tick,
      // so an unbounded log grows memory + render cost linearly over a long
      // swarm run. Keep only the most recent MAX_LOGS entries.
      const MAX_LOGS = 200;
      const next = [
        ...prev,
        {
          id: String(parsed.id),
          time: timeString,
          message,
        },
      ];
      return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next;
    });
  });

  // Reset logs when switching chats
  useEffect(() => {
    setLogs([]);
  }, [chatId]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  if (!chatId || logs.length === 0) return null;

  // The terminal is deliberately always-dark (black console aesthetic in both
  // themes) — the white-alpha classes INSIDE it are correct; only the outer
  // border follows the theme.
  return (
    <div className="mt-6 border border-border rounded-xl overflow-hidden bg-black/95 shadow-inner flex flex-col h-[300px] animate-in fade-in slide-in-from-top-2">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/10 bg-white/5">
        <Terminal className="w-4 h-4 text-green-500" />
        <span className="text-xs font-semibold text-green-500 tracking-wider uppercase">Deep Audit Terminal</span>
      </div>
      
      <div 
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-4 space-y-1.5 font-mono text-xs text-green-400/90 leading-relaxed scroll-smooth"
      >
        {logs.map((log) => {
          // Highlight different tags to make the logs readable
          const isError = log.message.includes("Failed") || log.message.includes("Error") || log.message.includes("Rejected") || log.message.includes("Unable");
          const isSuccess = log.message.includes("passed audit") || log.message.includes("successfully") || log.message.includes("passed");
          const isWarning = log.message.includes("fallback") || log.message.includes("failed");
          
          let colorClass = "text-green-400/90";
          if (isError) colorClass = "text-red-400";
          else if (isWarning) colorClass = "text-amber-400";
          else if (isSuccess) colorClass = "text-emerald-400";

          return (
            <div key={log.id} className={`break-words ${colorClass}`}>
              <span className="text-white/30 mr-2 select-none">[{log.time}]</span>
              <span>{log.message}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
