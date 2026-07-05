import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import type { AgentContext } from "@/lib/agent/types";
import type { AppSettings } from "@/lib/types";
import { callSubordinate } from "@/lib/tools/call-subordinate";
import { createCronTool } from "@/lib/tools/cron-tool";
import { createMcpMgmtTools } from "@/lib/tools/mcp-mgmt";
import { createGoalTools } from "@/lib/tools/goal-tools";
import { createProjectNavTools } from "@/lib/tools/project-nav-tools";
import { createCodeExecTools } from "@/lib/tools/code-exec-tools";
import { createFileTools } from "@/lib/tools/file-tools";
import { createMemoryKnowledgeTools } from "@/lib/tools/memory-knowledge-tools";
import { createWebTools } from "@/lib/tools/web-tools";
import { createTelegramTools } from "@/lib/tools/telegram-tools";
import { createSkillTools } from "@/lib/tools/skill-tools";
import { createBlackboardTools } from "@/lib/tools/blackboard-tools";
import { createProjectMcpConfigTools } from "@/lib/tools/project-mcp-tools";

/**
 * Agent ToolSet facade (§10 decomposition, PR 2).
 *
 * `createAgentTools` composes the per-family creator modules; each family
 * file owns its registrations AND its availability gate (settings flags,
 * projectId scope, telegram runtime presence), so the gate lives next to
 * the tools it gates and this facade stays dumb composition. The full
 * inventory + per-gate deltas are pinned by the characterization block in
 * `tool.test.ts` — a family change that alters the registered set must
 * update that test in the same PR.
 *
 * Two registrations stay inline by design:
 * - `response` — the PM #61 final-answer contract tool. Always present;
 *   every persistence path unwraps its serialized form
 *   (`unwrapSerializedResponseCall`), so it belongs at the registry heart.
 * - `call_subordinate` — a thin wire to `callSubordinate` gated on agent
 *   depth (`agentNumber < 3`).
 *
 * NOTE: `applyGlobalToolLoopGuard` (CLAUDE.md §4) wraps the ToolSet at the
 * CALLSITES in `agent.ts` / `moa.ts`, never here — every path that hands
 * tools to `generateText`/`streamText` must keep that wrap.
 */
export function createAgentTools(
  context: AgentContext,
  settings: AppSettings
): ToolSet {
  const tools: ToolSet = {
    ...createMcpMgmtTools(context),
  };

  // Response tool -- always present
  tools.response = tool({
    description:
      "Provide your final response to the user. Use this tool when you have the answer or have completed the task. The message will be displayed to the user as your response. You MUST pass a 'message' field with a string value.",
    inputSchema: z.object({
      message: z
        .string()
        .optional()
        .describe("Your final response message to the user in markdown format"),
      response: z
        .string()
        .optional()
        .describe("Alternative field for your response message (use 'message' preferably)"),
    }),
    execute: async ({ message, response }) => {
      const text = message || response || "";
      return text || "Task completed.";
    },
  });

  Object.assign(
    tools,
    createGoalTools(context),
    createProjectNavTools(context),
    createCodeExecTools(context, settings),
    createFileTools(context),
    createMemoryKnowledgeTools(context, settings),
    createWebTools(settings),
    createTelegramTools(context)
  );

  tools.cron = createCronTool(context);

  Object.assign(
    tools,
    createSkillTools(context),
    createBlackboardTools(context),
    createProjectMcpConfigTools(context)
  );

  // Call subordinate tool (only for agents below max depth)
  if ((context.agentNumber ?? 0) < 3) {
    tools.call_subordinate = tool({
      description:
        "Delegate a complex subtask to a subordinate agent. The subordinate has access to all tools and will complete the task independently. Use this for complex multi-step tasks that would benefit from focused attention.",
      inputSchema: z.object({
        task: z
          .string()
          .describe(
            "Detailed description of the task to delegate. Include all necessary context."
          ),
      }),
      execute: async ({ task }, { abortSignal }) => {
        return callSubordinate(
          task,
          context.projectId,
          context.agentNumber,
          context.history,
          abortSignal,
          context.chatId
        );
      },
    });
  }

  return tools;
}
