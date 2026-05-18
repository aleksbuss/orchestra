"use client";

import { useState, useEffect, useRef } from "react";
import { Loader2, Brain, Sparkles, Zap, Cpu, CheckCircle2, Clock, Hourglass, Activity } from "lucide-react";

interface ThinkingIndicatorProps {
  isLoading: boolean;
  status: "ready" | "submitted" | "streaming" | "error";
}

/* ─── Stage Definitions ─── */

interface Stage {
  icon: typeof Brain;
  label: string;
  color: string;
  delay: number;
}

const THINKING_STAGES: readonly Stage[] = [
  { icon: Brain,     label: "Processing request…",         color: "text-violet-400",  delay: 0 },
  { icon: Zap,       label: "Analyzing context…",          color: "text-amber-400",   delay: 3000 },
  { icon: Cpu,       label: "Running tools…",              color: "text-cyan-400",    delay: 7000 },
  { icon: Sparkles,  label: "Composing response…",         color: "text-emerald-400", delay: 12000 },
  { icon: Activity,  label: "Deep reasoning in progress…", color: "text-pink-400",    delay: 30000 },
  { icon: Hourglass, label: "Complex task — still working…", color: "text-orange-400", delay: 60000 },
  { icon: Clock,     label: "Almost there, finalizing…",   color: "text-teal-400",    delay: 120000 },
] as const;

/* ─── Ambient Messages — rotate to keep UI alive ─── */
const AMBIENT_MESSAGES = [
  "Model is reasoning through your request…",
  "Connecting the dots…",
  "Cross-referencing context…",
  "Working on a thorough answer…",
  "Verifying output quality…",
  "Still thinking — complex queries take longer…",
  "This is a detailed request, hang tight…",
  "AI is analyzing multiple angles…",
  "Processing tool results…",
  "Refining the response…",
];

/* ─── Progress Bar Component ─── */
function PulsingProgressBar({ elapsedMs }: { elapsedMs: number }) {
  // Logarithmic progress: fast at start, slowing down, never reaching 100%
  const progress = Math.min(95, Math.log2(1 + elapsedMs / 1000) * 12);

  return (
    <div className="w-full h-1 rounded-full bg-white/5 overflow-hidden mt-2">
      <div
        className="h-full rounded-full transition-all duration-1000 ease-out relative"
        style={{ width: `${progress}%` }}
      >
        {/* Gradient bar */}
        <div className="absolute inset-0 bg-gradient-to-r from-violet-500 via-purple-500 to-pink-500 rounded-full" />
        {/* Shimmer overlay */}
        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer rounded-full" />
      </div>
    </div>
  );
}

/* ─── Main Component ─── */
export function ThinkingIndicator({ isLoading, status }: ThinkingIndicatorProps) {
  const [stageIndex, setStageIndex] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [ambientIndex, setAmbientIndex] = useState(0);
  const [showAmbient, setShowAmbient] = useState(false);
  const startTimeRef = useRef<number | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const ambientIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Reset on new loading cycle
  useEffect(() => {
    if (isLoading) {
      startTimeRef.current = Date.now();
      setStageIndex(0);
      setElapsedMs(0);
      setAmbientIndex(0);
      setShowAmbient(false);

      // Use interval instead of rAF for more predictable updates (every 500ms)
      intervalRef.current = setInterval(() => {
        if (!startTimeRef.current) return;
        const elapsed = Date.now() - startTimeRef.current;
        setElapsedMs(elapsed);

        // Advance stage based on elapsed time
        let newStage = 0;
        for (let i = THINKING_STAGES.length - 1; i >= 0; i--) {
          if (elapsed >= THINKING_STAGES[i].delay) {
            newStage = i;
            break;
          }
        }
        setStageIndex(newStage);

        // Show ambient messages after 15 seconds
        if (elapsed >= 15000) {
          setShowAmbient(true);
        }
      }, 500);

      // Rotate ambient messages every 6 seconds
      ambientIntervalRef.current = setInterval(() => {
        setAmbientIndex((prev) => (prev + 1) % AMBIENT_MESSAGES.length);
      }, 6000);

      return () => {
        if (intervalRef.current) clearInterval(intervalRef.current);
        if (ambientIntervalRef.current) clearInterval(ambientIntervalRef.current);
      };
    } else {
      startTimeRef.current = null;
      setStageIndex(0);
      setElapsedMs(0);
      setShowAmbient(false);
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (ambientIntervalRef.current) clearInterval(ambientIntervalRef.current);
    }
  }, [isLoading]);

  if (!isLoading) return null;

  const stage = THINKING_STAGES[stageIndex];
  const IconComponent = stage.icon;
  const seconds = Math.floor(elapsedMs / 1000);
  const isStreaming = status === "streaming";

  // Format elapsed time — show mm:ss after 60s
  const timeDisplay = seconds >= 60
    ? `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, "0")}`
    : `${seconds}s`;

  return (
    <div className="flex gap-3 py-3 animate-in fade-in slide-in-from-bottom-2 duration-300">
      {/* Animated Avatar */}
      <div className="relative flex size-8 shrink-0 items-center justify-center mt-0.5">
        {/* Pulsing ring */}
        <div className="absolute inset-0 rounded-full bg-gradient-to-br from-violet-500/30 to-purple-600/30 animate-ping [animation-duration:2s]" />
        {/* Core circle */}
        <div className="relative flex size-8 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-purple-600 shadow-lg shadow-violet-500/25">
          {isStreaming ? (
            <Sparkles className="size-4 text-white animate-pulse" />
          ) : (
            <Loader2 className="size-4 text-white animate-spin" />
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="
          rounded-2xl rounded-tl-md px-4 py-3
          bg-white/5 dark:bg-white/[0.03]
          border border-white/10
          backdrop-blur-sm
        ">
          {/* Stage indicator */}
          <div className="flex items-center gap-2 mb-2">
            <IconComponent
              className={`size-3.5 ${stage.color} transition-colors duration-500 ${
                stageIndex >= 4 ? "animate-pulse" : ""
              }`}
            />
            <span
              key={stageIndex}
              className="text-xs font-medium text-foreground/80 transition-all duration-500 animate-in fade-in slide-in-from-left-1"
            >
              {stage.label}
            </span>
          </div>

          {/* Progress visualization */}
          <div className="flex items-center gap-3">
            {/* Step dots — show first 4 as compact dots, rest as extended */}
            <div className="flex items-center gap-1">
              {THINKING_STAGES.slice(0, 4).map((s, i) => {
                const StepIcon = s.icon;
                const isActive = i === stageIndex;
                const isCompleted = i < stageIndex;
                return (
                  <div
                    key={i}
                    className={`
                      flex items-center justify-center rounded-full transition-all duration-300
                      ${isActive
                        ? `size-6 ${s.color} bg-white/10 ring-1 ring-current/30`
                        : isCompleted
                          ? "size-5 text-emerald-400/60"
                          : "size-5 text-white/15"
                      }
                    `}
                  >
                    {isCompleted ? (
                      <CheckCircle2 className="size-3" />
                    ) : (
                      <StepIcon className={`size-3 ${isActive ? "animate-pulse" : ""}`} />
                    )}
                  </div>
                );
              })}

              {/* Extended stage indicator for long waits */}
              {stageIndex >= 4 && (
                <div className="flex items-center gap-1 ml-1 animate-in fade-in slide-in-from-left-2 duration-300">
                  <div className="w-3 h-px bg-white/20" />
                  <div className={`size-6 flex items-center justify-center rounded-full bg-white/10 ring-1 ring-current/30 ${stage.color}`}>
                    <IconComponent className="size-3 animate-pulse" />
                  </div>
                </div>
              )}
            </div>

            {/* Timer */}
            <span className={`text-[10px] tabular-nums ml-auto ${
              seconds >= 60 ? "text-orange-400/70" : "text-muted-foreground/50"
            }`}>
              {timeDisplay}
            </span>
          </div>

          {/* Pulsing progress bar */}
          <PulsingProgressBar elapsedMs={elapsedMs} />

          {/* Ambient rotating message — appears after 15s */}
          {showAmbient && !isStreaming && (
            <div
              key={ambientIndex}
              className="mt-2 animate-in fade-in slide-in-from-bottom-1 duration-500"
            >
              <span className="text-[10px] text-muted-foreground/40 italic">
                💡 {AMBIENT_MESSAGES[ambientIndex]}
              </span>
            </div>
          )}

          {/* Streaming indicator */}
          {isStreaming && (
            <div className="mt-2 flex items-center gap-1.5">
              <div className="flex gap-0.5">
                <div className="size-1 rounded-full bg-emerald-400 animate-bounce [animation-delay:0ms]" />
                <div className="size-1 rounded-full bg-emerald-400 animate-bounce [animation-delay:150ms]" />
                <div className="size-1 rounded-full bg-emerald-400 animate-bounce [animation-delay:300ms]" />
              </div>
              <span className="text-[10px] text-emerald-400/70">
                Streaming response…
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
