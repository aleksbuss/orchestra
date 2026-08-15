import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import type { AgentContext } from "@/lib/agent/types";
import {
  getAllProjects,
  createProject,
  getProject,
  getWorkDir,
} from "@/lib/storage/project-store";
import { slugifyProjectId } from "@/lib/tools/text-helpers";
import { normalizeContextPathForOutput } from "@/lib/tools/tool-paths";

/**
 * Project navigation tool family: list/inspect/switch/create projects.
 * Extracted verbatim from `tool.ts` (§10 decomposition, PR 2).
 */

async function allocateProjectId(baseId: string): Promise<string> {
  const normalizedBase = slugifyProjectId(baseId);
  let candidate = normalizedBase;
  let counter = 2;
  while (await getProject(candidate)) {
    candidate = `${normalizedBase}-${counter}`;
    counter += 1;
  }
  return candidate;
}

export function createProjectNavTools(context: AgentContext): ToolSet {
  const tools: ToolSet = {};

  tools.list_projects = tool({
    description:
      "List all available projects. Use this when the user asks what projects exist, to browse projects, or before switching projects.",
    inputSchema: z.object({}),
    execute: async () => {
      const projects = await getAllProjects();
      return {
        success: true,
        activeProjectId: context.projectId ?? null,
        activeProjectName: context.projectId
          ? (await getProject(context.projectId))?.name ?? null
          : null,
        count: projects.length,
        projects: projects.map((project) => ({
          id: project.id,
          name: project.name,
          description: project.description,
          updatedAt: project.updatedAt,
        })),
      };
    },
  });

  tools.get_current_project = tool({
    description:
      "Get the currently active project context for this chat, including current folder path and work directory.",
    inputSchema: z.object({}),
    execute: async () => {
      if (!context.projectId) {
        return {
          success: true,
          isGlobal: true,
          projectId: null,
          projectName: null,
          currentPath: normalizeContextPathForOutput(context.currentPath),
          workDir: getWorkDir(undefined),
          message: "No project is selected (global context).",
        };
      }

      const project = await getProject(context.projectId);
      return {
        success: true,
        isGlobal: false,
        projectId: context.projectId,
        projectName: project?.name ?? null,
        currentPath: normalizeContextPathForOutput(context.currentPath),
        // Same precedence as `resolveContextCwd`: the pre-resolved
        // `context.workDir` wins because it honors a linked project's
        // `absoluteRoot`. Reporting the raw `getWorkDir(projectId)` sandbox
        // path here sends the agent `cd`-ing into an empty `data/projects/<id>/`
        // while its tools actually run in the linked repo (PM #105).
        workDir: context.workDir?.trim() || getWorkDir(context.projectId),
      };
    },
  });

  tools.switch_project = tool({
    description:
      "Switch chat context to another project by project ID or name. Use this when the user asks to move to another project.",
    inputSchema: z
      .object({
        project_id: z
          .string()
          .optional()
          .describe("Exact project ID to switch to"),
        project_name: z
          .string()
          .optional()
          .describe("Project name (exact or partial, case-insensitive)"),
      })
      .refine(
        (value) => Boolean(value.project_id?.trim() || value.project_name?.trim()),
        "Provide project_id or project_name"
      ),
    execute: async ({ project_id, project_name }) => {
      const projects = await getAllProjects();
      if (projects.length === 0) {
        return {
          success: false,
          action: "switch_project",
          error: "No projects available. Create a project first.",
        };
      }

      const idQuery = project_id?.trim() ?? "";
      const nameQuery = project_name?.trim().toLowerCase() ?? "";
      let target = idQuery
        ? projects.find((project) => project.id === idQuery)
        : undefined;

      if (!target && nameQuery) {
        const exactMatches = projects.filter(
          (project) =>
            project.name.trim().toLowerCase() === nameQuery ||
            project.id.trim().toLowerCase() === nameQuery
        );

        if (exactMatches.length === 1) {
          target = exactMatches[0];
        } else if (exactMatches.length > 1) {
          return {
            success: false,
            action: "switch_project",
            error: `Ambiguous project name "${project_name}".`,
            matches: exactMatches.map((project) => ({
              id: project.id,
              name: project.name,
            })),
          };
        }
      }

      if (!target && nameQuery) {
        const partialMatches = projects.filter(
          (project) =>
            project.name.toLowerCase().includes(nameQuery) ||
            project.id.toLowerCase().includes(nameQuery)
        );

        if (partialMatches.length === 1) {
          target = partialMatches[0];
        } else if (partialMatches.length > 1) {
          return {
            success: false,
            action: "switch_project",
            error: `Project query "${project_name}" is ambiguous.`,
            matches: partialMatches.map((project) => ({
              id: project.id,
              name: project.name,
            })),
          };
        }
      }

      if (!target) {
        return {
          success: false,
          action: "switch_project",
          error:
            idQuery.length > 0
              ? `Project with id "${idQuery}" not found.`
              : `Project "${project_name}" not found.`,
          availableProjects: projects.map((project) => ({
            id: project.id,
            name: project.name,
          })),
        };
      }

      return {
        success: true,
        action: "switch_project",
        projectId: target.id,
        projectName: target.name,
        currentPath: "",
        message: `Switching to project "${target.name}" (${target.id}).`,
      };
    },
  });

  tools.create_project = tool({
    description:
      "Create a new project workspace. Use this when the user asks to create/add a new project, especially if no project exists yet.",
    inputSchema: z.object({
      name: z.string().describe("Project name (human-readable)"),
      description: z
        .string()
        .optional()
        .describe("Optional project description"),
      instructions: z
        .string()
        .optional()
        .describe("Optional default instructions for the agent in this project"),
      memory_mode: z
        .enum(["global", "isolated"])
        .optional()
        .describe("Project memory mode; default is isolated"),
      project_id: z
        .string()
        .optional()
        .describe("Optional custom project id; if taken, a unique suffix is added"),
    }),
    execute: async ({
      name,
      description,
      instructions,
      memory_mode,
      project_id,
    }) => {
      const trimmedName = name.trim();
      if (!trimmedName) {
        return {
          success: false,
          action: "create_project",
          error: "Project name is required.",
        };
      }

      const preferredId = project_id?.trim()
        ? slugifyProjectId(project_id)
        : slugifyProjectId(trimmedName);
      const id = await allocateProjectId(preferredId);

      try {
        const project = await createProject({
          id,
          name: trimmedName,
          description: (description ?? "").trim(),
          instructions: (instructions ?? "").trim(),
          memoryMode: memory_mode ?? "isolated",
        });
        return {
          success: true,
          action: "create_project",
          projectId: project.id,
          projectName: project.name,
          message: `Project "${project.name}" created with id "${project.id}".`,
        };
      } catch (error) {
        return {
          success: false,
          action: "create_project",
          error:
            error instanceof Error
              ? error.message
              : "Failed to create project.",
        };
      }
    },
  });

  return tools;
}
