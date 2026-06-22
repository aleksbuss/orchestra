import fs from "fs/promises";
import path from "path";
import {
  getProject,
  loadProjectSkillsMetadata,
  getProjectFiles,
  getWorkDir,
} from "@/lib/storage/project-store";
import { getChatFiles } from "@/lib/storage/chat-files-store";
import { getActiveGoal } from "@/lib/storage/goal-store";
import type { GoalTask } from "@/lib/types";

const PROMPTS_DIR = path.join(process.cwd(), "src", "prompts");

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Load a prompt template from the prompts directory
 */
async function loadPrompt(name: string): Promise<string> {
  try {
    const filePath = path.join(PROMPTS_DIR, `${name}.md`);
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Recursively get all files from a directory with full paths
 */
async function getAllProjectFilesRecursive(
  projectId: string,
  subPath: string = ""
): Promise<{ name: string; path: string; size: number }[]> {
  const baseDir = getWorkDir(projectId);
  const files = await getProjectFiles(projectId, subPath);
  const result: { name: string; path: string; size: number }[] = [];

  for (const file of files) {
    const relativePath = subPath ? `${subPath}/${file.name}` : file.name;
    const fullPath = path.join(baseDir, relativePath);

    if (file.type === "file") {
      result.push({
        name: file.name,
        path: fullPath,
        size: file.size,
      });
    } else if (file.type === "directory") {
      // Recursively get files from subdirectories
      const subFiles = await getAllProjectFilesRecursive(projectId, relativePath);
      result.push(...subFiles);
    }
  }

  return result;
}

/**
 * PM #61 — appended to the system prompt when the agent runs in plain-chat
 * mode (the selected model can't call tools, so no tools are forwarded). The
 * rest of the prompt is written for tool mode and mandates the `response`
 * tool + `<call:...>` usage; without this override, tool-trained models emit
 * literal tool-call text instead of an answer. Kept as an exported constant
 * so the contract is greppable and unit-testable.
 */
export const PLAIN_CHAT_TOOL_OVERRIDE =
  "\n\n## ⚠️ PLAIN-CHAT MODE — NO TOOLS AVAILABLE\n" +
  "The selected model cannot call tools, so NO tools are available this turn. " +
  "Disregard every earlier instruction about calling tools, the `response` tool, " +
  "goal trees, self-healing loops, or `<call:...>` / function-call syntax — none of " +
  "that applies now. Reply to the user directly in natural-language prose. Do NOT " +
  "output any tool-call markup, XML-like tags, or function-call syntax; just write the answer.";

/**
 * Sprint 2 — MoA aggregator collapse (docs/moa-aggregator-collapse.md). The
 * load-bearing synthesis rules (ported from `AGGREGATOR_SYSTEM_PROMPT`) that get
 * appended to the orchestrator system prompt on the collapsed synthesis path, so
 * the final tool-capable `streamText` synthesizes the proposer drafts inline.
 * Operator-tunable via `src/prompts/synthesis-inline.md`; this constant is the
 * fallback when the file is missing (mirrors `buildSystemPrompt`'s system.md
 * fallback). Kept exported so the contract is greppable and unit-testable.
 */
export const DEFAULT_SYNTHESIS_INLINE_DIRECTIVE =
  "## Mixture-of-Agents — Synthesize the Expert Drafts\n\n" +
  "Several specialized expert agents analyzed the user's request in parallel. " +
  'Their drafts are provided below under "## Expert Drafts to Synthesize". Your ' +
  "final answer MUST be a synthesis of those drafts — a single, high-quality reply " +
  "that goes beyond any individual draft. Critically evaluate them: some content may " +
  "be biased, incomplete, or wrong; do NOT simply replicate or vote-aggregate them. " +
  "Preserve technical detail and code blocks, start directly with the answer (no " +
  "meta-commentary), resolve factual conflicts using your own knowledge and tools, " +
  "mirror the user's expected format, and silently correct errors. If a " +
  '"<<DISAGREEMENT_DETECTED>>" marker appears below, follow its instructions exactly. ' +
  "You retain your tools during synthesis — use them only to materially improve the " +
  "answer, then deliver the result through your normal `response` mechanism.";

/**
 * Load the operator-tunable inline-synthesis directive from
 * `src/prompts/synthesis-inline.md`, falling back to
 * {@link DEFAULT_SYNTHESIS_INLINE_DIRECTIVE} when the file is absent or empty.
 */
export async function loadSynthesisInlineDirective(): Promise<string> {
  const fromFile = (await loadPrompt("synthesis-inline")).trim();
  return fromFile || DEFAULT_SYNTHESIS_INLINE_DIRECTIVE;
}

/**
 * Build the complete system prompt for the agent
 */
export async function buildSystemPrompt(options: {
  projectId?: string;
  chatId?: string;
  agentNumber?: number;
  tools?: string[];
}): Promise<string> {
  const parts: string[] = [];

  // 1. Base system prompt
  const basePrompt = await loadPrompt("system");
  if (basePrompt) {
    parts.push(basePrompt);
  } else {
    parts.push(getDefaultSystemPrompt());
  }

  // 2. Agent identity
  const agentNum = options.agentNumber ?? 0;
  parts.push(
    `\n## Agent Identity\nYou are AI Agent` +
    (agentNum === 0
      ? "You are the primary agent communicating directly with the user."
      : `You are a subordinate agent (level ${agentNum}), delegated a task by Agent ${agentNum - 1}.`)
  );

  // 3. Tool prompts
  if (options.tools && options.tools.length > 0) {
    const mcpToolNames = options.tools.filter((t) => t.startsWith("mcp_"));
    for (const toolName of options.tools) {
      const toolPrompt = await loadPrompt(`tool-${toolName}`);
      if (toolPrompt) {
        parts.push(`\n## Tool: ${toolName}\n${toolPrompt}`);
      }
    }
    if (mcpToolNames.length > 0) {
      parts.push(
        `\n## MCP (Model Context Protocol) tools\n` +
        `This project has ${mcpToolNames.length} tool(s) from connected MCP servers. ` +
        `Tool names are prefixed with \`mcp_<server>_<tool>\`. Use them when the task matches their description.\n\n` +
        `MCP execution rules:\n` +
        `- After an error, do not repeat the same MCP tool call with identical arguments.\n` +
        `- Read error details and change the payload before retrying.\n` +
        `- For n8n workflow updates, use a real workflow id from a successful tool response; never guess ids.`
      );
    }

    parts.push(
      `\n## Tool Loop Safety\n` +
      `- After a failed tool call, do not repeat the same tool with identical arguments.\n` +
      `- Use the tool's error details to change parameters before retrying.\n` +
      `- For skill tools (load_skill/load_skill_resource/install_skill_from_github/create_skill/update_skill/delete_skill/write_skill_file), use exact skill names and valid paths.\n` +
      `- If two corrected attempts still fail, report the blocker to the user instead of retrying endlessly.`
    );

    parts.push(
      `\n## Self-Healing Loop (TDD / Verification)\n` +
      `If a command, script, or tool returns an error (stderr or a failed status code) or a test fails:\n` +
      `1. DO NOT immediately stop and ask the user for help.\n` +
      `2. Autonomously analyze the error output or stack trace.\n` +
      `3. Use your tools to fix the code, alter the command, or install the missing dependency, and TRY AGAIN.\n` +
      `4. Repeat this self-correction loop up to 3 times for a single task.\n` +
      `5. Only report failure to the user if you are fundamentally blocked after 3 distinct attempts.`
    );
  }

  // 4. Project instructions and Skills
  if (options.projectId) {
    const project = await getProject(options.projectId);
    if (project) {
      parts.push(
        `\n## Active Project: ${project.name}\n` +
        `Description: ${project.description}\n` +
        (project.instructions
          ? `\n### Project Instructions\n${project.instructions}`
          : "")
      );

      // 4b. Project Skills — metadata only at startup; full instructions via load_skill tool (integrate-skills)
      const skillsMeta = await loadProjectSkillsMetadata(options.projectId);
      if (skillsMeta.length > 0) {
        parts.push(
          `\n## Project Skills (available)\n` +
          `This project has ${skillsMeta.length} skill(s). Match the user's task to a skill by description. When a task matches a skill, call the **load_skill** tool with that skill's name to load its full instructions, then follow them. Use only skills that apply.\n` +
          `<available_skills>\n` +
          skillsMeta
            .map(
              (s) =>
                `  <skill>\n    <name>${escapeXml(s.name)}</name>\n    <description>${escapeXml(s.description)}</description>\n  </skill>`
            )
            .join("\n") +
          `\n</available_skills>`
        );
      }
    }
  }

  // 5. Available Files (Project Directory + Chat Uploaded)
  if (options.projectId || options.chatId) {
    const filesSections: string[] = [];

    // 5a. Project directory files
    if (options.projectId) {
      try {
        const projectFiles = await getAllProjectFilesRecursive(options.projectId);
        if (projectFiles.length > 0) {
          const rows = projectFiles
            .slice(0, 50) // Limit to 50 files to avoid huge prompts
            .map((f) => `| ${f.name} | ${f.path} | ${formatFileSize(f.size)} |`)
            .join("\n");
          filesSections.push(
            `### Project Directory Files\n` +
            `| File | Path | Size |\n|------|------|------|\n${rows}` +
            (projectFiles.length > 50 ? `\n\n*...and ${projectFiles.length - 50} more files*` : "")
          );
        }
      } catch {
        // Ignore errors when getting project files
      }
    }

    // 5b. Chat uploaded files
    if (options.chatId) {
      try {
        const chatFiles = await getChatFiles(options.chatId);
        if (chatFiles.length > 0) {
          const rows = chatFiles
            .map((f) => `| ${f.name} | ${f.path} | ${formatFileSize(f.size)} |`)
            .join("\n");
          filesSections.push(
            `### Chat Uploaded Files\n` +
            `| File | Path | Size |\n|------|------|------|\n${rows}`
          );
        }
      } catch {
        // Ignore errors when getting chat files
      }
    }

    if (filesSections.length > 0) {
      parts.push(
        `\n## Available Files\n` +
        `These files are available in this context. You can read them using the code_execution tool.\n\n` +
        filesSections.join("\n\n")
      );
    }
  }

  // 6. Active Goal Tree (AGI-lite Autopilot)
  const projectIdStr = options.projectId ?? "none";
  let activeGoalStr = "";
  try {
    const goal = await getActiveGoal(projectIdStr);
    if (goal && goal.status === "active") {
      const renderTasks = (tasks: GoalTask[], indent: string = ""): string => {
        return tasks.map(t => {
          let str = `${indent}- [${t.status.toUpperCase()}] Task ${t.id}: ${t.description}`;
          if (t.result) str += ` (Result: ${t.result})`;
          if (t.subtasks && t.subtasks.length > 0) {
            str += "\n" + renderTasks(t.subtasks, indent + "  ");
          }
          return str;
        }).join("\n");
      };

      activeGoalStr = `\n## Active Goal Tree\n` +
        `Title: ${goal.title}\n` +
        `Objective: ${goal.description}\n\n` +
        `Tasks:\n${renderTasks(goal.tasks)}\n\n` +
        `IMPORTANT: You are part of an Auto-Pilot loop working on this Goal. ` +
        `Check the tasks above. Your immediate objective is to complete the FIRST task that is currently 'pending' or 'in_progress'. ` +
        `When you finish it, use the 'update_task_status' tool to mark it 'completed', provide a summary, and the system will automatically re-run you for the next step.`;
      
      parts.push(activeGoalStr);
    }
  } catch {
    // Ignore error
  }


  // 6. Current date/time (rounded to the hour for prompt caching)
  const now = new Date();
  now.setMinutes(0, 0, 0);
  const dateStr = now.toISOString().slice(0, 13) + ":00:00Z";
  parts.push(
    `\n## Current Information\n- Date/Time: ${dateStr}\n- Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`
  );

  return parts.join("\n\n");
}

/**
 * Format file size in human-readable format
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getDefaultSystemPrompt(): string {
  return `# Orchestra Agent

You are a helpful AI assistant with access to tools that allow you to:
- Execute code (Python, Node.js, Shell commands)
- Save and retrieve information from persistent memory
- Search the internet for current information
- Query a knowledge base of documents
- Delegate complex subtasks to subordinate agents

## Guidelines

1. **Be helpful and direct.** Answer the user's question or complete their task.
2. **Use tools when needed.** If a task requires running code, searching, or remembering information, use the appropriate tool.
3. **Think step by step.** For complex tasks, break them down and use tools iteratively.
4. **Memory management.** Save important facts, preferences, and solutions to memory for future reference.
5. **Code execution.** When writing code, prefer Python for data processing and Node.js for web tasks. Always handle errors.
6. **Respond clearly.** Use markdown formatting for readability. Include code blocks with language tags.

## Important Rules

- Always use the response tool to provide your final answer to the user.
- If you need to execute code, use the code_execution tool.
- If the user asks you to remember something, save it to memory.
- If you need current information, use the search tool.
- Never make up information. If you don't know something, say so or search for it.`;
}
