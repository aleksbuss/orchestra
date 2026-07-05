import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import type { AgentContext } from "@/lib/agent/types";
import { saveGoal, updateGoal } from "@/lib/storage/goal-store";
import type { GoalTaskStatus } from "@/lib/types";

/**
 * Goal Tree (AGI-lite) tool family: create a self-executing task tree and
 * update task status for the auto-pilot loop. Extracted verbatim from
 * `tool.ts` (§10 decomposition, PR 2).
 */
export function createGoalTools(context: AgentContext): ToolSet {
  const tools: ToolSet = {};

  tools.create_goal_tree = tool({
    description: "Initialize an Autonomous Goal Tree to break down a complex, multi-step problem into self-executing tasks. Use this when the user asks you to build an entire app, feature, or complete a multi-step workflow. This replaces any existing active goal.",
    inputSchema: z.object({
      title: z.string().describe("High-level goal title (e.g. 'Build SaaS Landing Page')"),
      description: z.string().describe("Overall objective of this goal."),
      tasks: z.array(z.object({
        id: z.string().describe("Task ID (e.g. '1', '2', '2.1')"),
        description: z.string().describe("Clear action description"),
      })).describe("The sequence of tasks to perform.")
    }),
    execute: async ({ title, description, tasks }) => {
      const projectId = context.projectId ?? "none";
      const chatId = context.chatId;
      const newGoal = {
        id: crypto.randomUUID(),
        projectId,
        chatId,
        title,
        description,
        status: "active" as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tasks: tasks.map(t => ({
          id: t.id,
          description: t.description,
          status: "pending" as GoalTaskStatus
        }))
      };
      await saveGoal(newGoal);
      return `Goal Tree "${title}" created successfully with ${tasks.length} tasks. Proceed to execute the first task.`;
    }
  });

  tools.update_task_status = tool({
    description: "Mark a task in the active Goal Tree as completed or failed, and record the result. This signals to the auto-pilot system to proceed to the next task.",
    inputSchema: z.object({
      task_id: z.string().describe("The ID of the task you are updating (e.g. '1', '2.1')."),
      status: z.enum(["in_progress", "completed", "failed"]).describe("The new status of the task."),
      result_summary: z.string().describe("A brief summary of what was accomplished or why it failed. IMPORTANT: include any key decisions or file paths created.")
    }),
    execute: async ({ task_id, status, result_summary }) => {
      const chatId = context.chatId;
      let found = false;

      const updatedGoal = await updateGoal(chatId, (goal) => {
        if (goal.status !== "active") return goal;

        const updateRecursive = (taskList: typeof goal.tasks) => {
          for (const t of taskList) {
            if (t.id === task_id) {
              t.status = status as GoalTaskStatus;
              t.result = result_summary;
              found = true;
            }
            if (t.subtasks) updateRecursive(t.subtasks);
          }
        };
        updateRecursive(goal.tasks);
        return goal;
      });

      if (!updatedGoal || updatedGoal.status !== "active") {
        return "Error: No active goal tree found. You must create one first using create_goal_tree.";
      }

      if (!found) {
        return `Error: Task ID "${task_id}" not found in the current goal tree.`;
      }

      return `Task "${task_id}" updated to ${status}. Recorded result: ${result_summary}. Use the current_goal tool or just proceed to the next pending task.`;
    }
  });

  return tools;
}
