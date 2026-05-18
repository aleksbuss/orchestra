"use client";

import { useState, useEffect } from "react";
import type { ProjectGoal, GoalTask } from "@/lib/types";
import { CheckCircle2, Circle, PlayCircle, XCircle, ChevronDown, ChevronRight, Target } from "lucide-react";

interface GoalTreeProps {
  chatId: string | null;
  syncTick: number; // passed from parent to trigger re-fetch on incoming chat events
}

function TaskItem({ task, depth = 0 }: { task: GoalTask; depth?: number }) {
  const [expanded, setExpanded] = useState(true);
  
  const getIcon = () => {
    switch(task.status) {
      case "completed": return <CheckCircle2 className="w-4 h-4 text-green-500" />;
      case "in_progress": return <PlayCircle className="w-4 h-4 text-blue-500 animate-pulse" />;
      case "failed": return <XCircle className="w-4 h-4 text-red-500" />;
      default: return <Circle className="w-4 h-4 text-muted-foreground" />;
    }
  };

  const hasSubtasks = task.subtasks && task.subtasks.length > 0;

  return (
    <div className="flex flex-col mb-1.5" style={{ marginLeft: depth * 12 + "px" }}>
      <div className="flex items-start gap-2">
        {hasSubtasks ? (
           <button onClick={() => setExpanded(!expanded)} className="mt-0.5 text-muted-foreground hover:text-foreground">
             {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
           </button>
        ) : (
           <div className="w-4" /> // spacer
        )}
        <div className="mt-0.5">{getIcon()}</div>
        <div className="flex-1">
          <span className={`text-sm ${task.status === "completed" ? "line-through text-muted-foreground" : "text-foreground"}`}>
             {task.description}
          </span>
          {task.result && task.status !== "pending" && (
             <p className="text-xs text-muted-foreground mt-0.5 border-l-2 pl-2 border-white/10">
               {task.result}
             </p>
          )}
        </div>
      </div>
      {expanded && hasSubtasks && (
        <div className="mt-1">
          {task.subtasks!.map(st => (
             <TaskItem key={st.id} task={st} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export function GoalTree({ chatId, syncTick }: GoalTreeProps) {
  const [goal, setGoal] = useState<ProjectGoal | null>(null);
  const [isExpanded, setIsExpanded] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const fetchGoal = async () => {
      try {
        if (!chatId) return;
        const res = await fetch(`/api/goals/active?chatId=${chatId}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) {
          setGoal(data.goal);
        }
      } catch (err) {
        // ignore
      }
    };
    fetchGoal();
    return () => { cancelled = true; };
  }, [chatId, syncTick]);

  if (!goal) return null;

  return (
    <div className="mx-auto max-w-3xl mb-4 px-4 lg:px-8">
      <div className="glass-panel rounded-xl overflow-hidden">
        <div 
          className="flex items-center justify-between p-3 cursor-pointer bg-white/5 hover:bg-white/10 transition-colors"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          <div className="flex items-center gap-2">
            <Target className="w-5 h-5 text-foreground" />
            <h3 className="font-semibold text-sm">Active Goal: {goal.title}</h3>
          </div>
          <div className="text-muted-foreground">
             {isExpanded ? <ChevronDown className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
          </div>
        </div>
        
        {isExpanded && (
          <div className="p-4 border-t border-primary/10">
            <p className="text-sm text-muted-foreground mb-4">{goal.description}</p>
            <div className="flex flex-col gap-1">
              {goal.tasks.map(task => (
                <TaskItem key={task.id} task={task} />
              ))}
            </div>
            <div className="mt-4 text-xs font-medium text-blue-500 animate-pulse flex items-center justify-center">
               Auto-Pilot Active - Do not close the app
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
