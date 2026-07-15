"use client";

import { useAppStore } from "@/store/app-store";
import { useShallow } from "zustand/react/shallow";
import { Users, Plane, Zap, ShieldAlert } from "lucide-react";
import { PresetSelector } from "./preset-selector";
import { SkepticSelector } from "./skeptic-selector";

/**
 * Shared pill styling. The strip lives inside a fixed-height header that
 * scrolls horizontally on overflow (see site-header.tsx), so every pill is
 * `shrink-0` + `whitespace-nowrap` — flex must never squeeze or wrap them.
 * Colors are theme tokens / dual light-dark accents, never raw white-alpha.
 */
const PILL_BASE =
  "inline-flex shrink-0 items-center gap-2 h-8 px-3 rounded-lg border text-xs font-medium " +
  "whitespace-nowrap transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2";

const PILL_IDLE =
  "bg-foreground/[0.03] border-border/70 text-muted-foreground " +
  "hover:bg-foreground/[0.06] hover:text-foreground";

export function SwarmConfig() {
  const { swarmEnabled, daemonMode, forceSwarm, deepAudit, setSwarmEnabled, setDaemonMode, setForceSwarm, setDeepAudit } = useAppStore(
    useShallow((s) => ({ swarmEnabled: s.swarmEnabled, daemonMode: s.daemonMode, forceSwarm: s.forceSwarm, deepAudit: s.deepAudit, setSwarmEnabled: s.setSwarmEnabled, setDaemonMode: s.setDaemonMode, setForceSwarm: s.setForceSwarm, setDeepAudit: s.setDeepAudit }))
  );

  return (
    <div className="flex flex-nowrap items-center gap-1.5 w-max">
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground hidden md:inline-block">
          Model
        </span>
        <PresetSelector />
      </div>

      <div className="w-px h-5 bg-border mx-1.5 shrink-0 hidden sm:block" />

      <button
        type="button"
        onClick={() => setSwarmEnabled(!swarmEnabled)}
        aria-pressed={swarmEnabled}
        aria-label="Toggle Swarm mode"
        className={`${PILL_BASE} focus-visible:ring-primary/40
          ${swarmEnabled
            ? "bg-primary/10 border-primary/40 text-primary"
            : PILL_IDLE
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

      {swarmEnabled && (
        <button
          type="button"
          onClick={() => setForceSwarm(!forceSwarm)}
          aria-pressed={forceSwarm}
          aria-label="Force Swarm — bypass router decision"
          title="Force Swarm: skip the Auto-Router and always run the full ensemble. Useful when a cheap utilityModel keeps mis-classifying substantive prompts as trivial."
          className={`${PILL_BASE} focus-visible:ring-amber-500/40
            ${forceSwarm
              ? "bg-amber-500/10 border-amber-500/40 text-amber-600 dark:text-amber-400"
              : PILL_IDLE
            }
          `}
        >
          <Zap className="w-3.5 h-3.5" />
          <span>Force</span>
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              forceSwarm ? "bg-amber-500 dark:bg-amber-400 animate-pulse" : "bg-muted-foreground/30"
            }`}
          />
        </button>
      )}

      {swarmEnabled && (
        <button
          type="button"
          onClick={() => setDeepAudit(!deepAudit)}
          aria-pressed={deepAudit}
          aria-label="Deep Audit — run the reflection Skeptic loop this turn"
          title="Deep Audit: run the Doubt-Driven reflection loop (Skeptic critic → revisor) after synthesis for this turn. Higher quality, slower + costlier. Overrides the Settings default; disables inline-synthesis collapse for the turn."
          className={`${PILL_BASE} focus-visible:ring-rose-500/40
            ${deepAudit
              ? "bg-rose-500/10 border-rose-500/40 text-rose-600 dark:text-rose-400"
              : PILL_IDLE
            }
          `}
        >
          <ShieldAlert className="w-3.5 h-3.5" />
          <span>Deep Audit</span>
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              deepAudit ? "bg-rose-500 dark:bg-rose-400 animate-pulse" : "bg-muted-foreground/30"
            }`}
          />
        </button>
      )}

      {swarmEnabled && <SkepticSelector />}

      <button
        type="button"
        onClick={() => setDaemonMode(!daemonMode)}
        aria-pressed={daemonMode}
        aria-label="Toggle Auto-Pilot mode"
        className={`${PILL_BASE} focus-visible:ring-violet-500/40
          ${daemonMode
            ? "bg-violet-500/10 border-violet-500/40 text-violet-600 dark:text-violet-400"
            : PILL_IDLE
          }
        `}
      >
        <Plane className="w-3.5 h-3.5" />
        <span>Auto-Pilot</span>
        <span
          className={`w-1.5 h-1.5 rounded-full ${
            daemonMode ? "bg-violet-500 dark:bg-violet-400 animate-pulse" : "bg-muted-foreground/30"
          }`}
        />
      </button>
    </div>
  );
}
