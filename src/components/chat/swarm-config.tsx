"use client";

import { useAppStore } from "@/store/app-store";
import { Users, Plane } from "lucide-react";
import { PresetSelector } from "./preset-selector";

export function SwarmConfig() {
  const { swarmEnabled, daemonMode, setSwarmEnabled, setDaemonMode } = useAppStore();

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground hidden md:inline-block">
          Model
        </span>
        <PresetSelector />
      </div>

      <div className="w-px h-5 bg-white/10 mx-1.5 hidden sm:block" />

      <button
        type="button"
        onClick={() => setSwarmEnabled(!swarmEnabled)}
        aria-pressed={swarmEnabled}
        aria-label="Toggle Swarm mode"
        className={`
          inline-flex items-center gap-2 h-8 px-3 rounded-lg border text-xs font-medium
          transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2
          focus-visible:ring-primary/40
          ${swarmEnabled
            ? "bg-primary/12 border-primary/40 text-primary"
            : "bg-white/[0.03] border-white/10 text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
          }
        `}
      >
        <Users className="w-3.5 h-3.5" />
        <span>Swarm</span>
        <span
          className={`w-1.5 h-1.5 rounded-full ${
            swarmEnabled ? "bg-primary animate-pulse" : "bg-muted-foreground/30"
          }`}
        />
      </button>

      <button
        type="button"
        onClick={() => setDaemonMode(!daemonMode)}
        aria-pressed={daemonMode}
        aria-label="Toggle Auto-Pilot mode"
        className={`
          inline-flex items-center gap-2 h-8 px-3 rounded-lg border text-xs font-medium
          transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2
          focus-visible:ring-secondary/40
          ${daemonMode
            ? "bg-secondary/12 border-secondary/40 text-secondary"
            : "bg-white/[0.03] border-white/10 text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
          }
        `}
      >
        <Plane className="w-3.5 h-3.5" />
        <span>Auto-Pilot</span>
        <span
          className={`w-1.5 h-1.5 rounded-full ${
            daemonMode ? "bg-secondary animate-pulse" : "bg-muted-foreground/30"
          }`}
        />
      </button>
    </div>
  );
}
