import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import type { AgentContext } from "@/lib/agent/types";
import {
  loadProjectSkillsMetadata,
  loadSkillInstructions,
  createSkill,
  updateSkill,
  deleteSkill,
  writeSkillFile,
} from "@/lib/storage/project-store";
import { installSkillFromGitHub } from "@/lib/storage/project-skills-github";
import { inferLanguageFromPath } from "@/lib/tools/text-helpers";
import {
  SKILL_RESOURCE_READ_MAX_CHARS,
  formatRequiredResourceSkipReason,
  listSkillResourcePaths,
  loadRequiredSkillResources,
  resolveSkillLocalFile,
} from "@/lib/tools/skill-resources";

/**
 * Agent Skills tool family (project-scoped): load skill instructions +
 * resources, create/update/delete skills, install from GitHub. Registered
 * only when the context has a projectId — skills live under the project's
 * `.meta/skills/`. Extracted verbatim from `tool.ts` (§10 decomposition,
 * PR 2).
 */
export function createSkillTools(context: AgentContext): ToolSet {
  if (!context.projectId) {
    return {};
  }

  const tools: ToolSet = {};

  tools.load_skill = tool({
    description:
      "Load the full instructions for a project skill. Call this when the user's task matches one of the available skills (see <available_skills> in context). Use the skill name exactly as listed. This returns SKILL.md plus a manifest of additional skill resource files; load specific files with load_skill_resource when needed.",
    inputSchema: z.object({
      skill_name: z
        .string()
        .describe(
          "Exact name of the skill to load (from <available_skills>, e.g. pdf-processing)"
        ),
    }),
    execute: async ({ skill_name }) => {
      const skill = await loadSkillInstructions(
        context.projectId!,
        skill_name.trim()
      );
      if (!skill) {
        const meta = await loadProjectSkillsMetadata(context.projectId!);
        const names = meta.map((s) => s.name).join(", ");
        return `Skill "${skill_name}" not found. Available skills: ${names || "none"}.`;
      }
      const resourcePaths = await listSkillResourcePaths(
        skill.skillDir,
        skill.body
      );
      const requiredResourceReport = await loadRequiredSkillResources(
        skill.skillDir,
        skill.body
      );
      const requiredResources = requiredResourceReport.loaded;
      const parts = [
        `# Skill: ${skill.name}\n${skill.description}\n\n## Instructions\n\n${skill.body}`,
      ];
      parts.push(
        "## Required Resource Link Scan\n" +
        `Detected local links in SKILL.md: ${requiredResourceReport.detectedLinks.length}\n` +
        `Auto-loaded: ${requiredResources.length}\n` +
        `Skipped: ${requiredResourceReport.skipped.length}`
      );
      if (requiredResourceReport.detectedLinks.length > 0) {
        parts.push(
          "### Detected Links\n" +
          requiredResourceReport.detectedLinks.map((p) => `- \`${p}\``).join("\n")
        );
      }
      if (requiredResources.length > 0) {
        parts.push(
          "## Auto-loaded Required Skill Resources\n" +
          "These files are auto-loaded because SKILL.md contains local markdown links (`[...](...)`). Linked files are treated as required context before execution."
        );
        for (const resource of requiredResources) {
          parts.push(
            [
              `### ${resource.relativePath}`,
              `\`\`\`${resource.language}`,
              resource.content,
              "```",
              resource.truncated ? "[Truncated: file too large]" : "",
            ]
              .filter(Boolean)
              .join("\n")
          );
        }
      }
      if (requiredResourceReport.skipped.length > 0) {
        parts.push(
          "### Skipped Required Links\n" +
          requiredResourceReport.skipped
            .map(
              (item) =>
                `- \`${item.relativePath}\` — ${formatRequiredResourceSkipReason(item.reason)}`
            )
            .join("\n")
        );
      }
      if (resourcePaths.length > 0) {
        parts.push(
          "## Available Skill Resources\n" +
          "Required resources may already be auto-loaded above. Use `load_skill_resource` for any additional file needed by the workflow.\n\n" +
          resourcePaths.map((p) => `- \`${p}\``).join("\n")
        );
      } else {
        parts.push(
          "## Available Skill Resources\nNo additional resource files were detected for this skill."
        );
      }
      if (skill.compatibility) {
        parts.push(`**Compatibility:** ${skill.compatibility}`);
      }
      parts.push(
        `\nSkill directory: \`${skill.skillDir}\` (may contain references/, scripts/, assets/).`
      );
      return parts.join("\n");
    },
  });

  tools.load_skill_resource = tool({
    description:
      "Load a single additional file from a project skill (for example from references/, scripts/, assets/, or another path listed by load_skill). Use this only after loading the skill and only for files relevant to the current task.",
    inputSchema: z.object({
      skill_name: z
        .string()
        .describe("Exact skill name (same value used for load_skill)."),
      relative_path: z
        .string()
        .describe(
          "Relative path inside the skill directory, e.g. references/examples.md or scripts/generate.py"
        ),
    }),
    execute: async ({ skill_name, relative_path }) => {
      const skill = await loadSkillInstructions(
        context.projectId!,
        skill_name.trim()
      );
      if (!skill) {
        const meta = await loadProjectSkillsMetadata(context.projectId!);
        const names = meta.map((s) => s.name).join(", ");
        return `Skill "${skill_name}" not found. Available skills: ${names || "none"}.`;
      }

      const fullPath = await resolveSkillLocalFile(
        skill.skillDir,
        relative_path.trim()
      );
      if (!fullPath) {
        return `Resource "${relative_path}" was not found in skill "${skill.name}" or path is invalid.`;
      }

      let raw: string;
      try {
        raw = await fs.readFile(fullPath, "utf-8");
      } catch {
        return `Failed to read resource "${relative_path}" for skill "${skill.name}".`;
      }

      const truncated = raw.length > SKILL_RESOURCE_READ_MAX_CHARS;
      const content = truncated
        ? `${raw.slice(0, SKILL_RESOURCE_READ_MAX_CHARS)}\n\n[Truncated: file too large]`
        : raw;
      const relative = path.relative(skill.skillDir, fullPath).replaceAll("\\", "/");
      const language = inferLanguageFromPath(fullPath);

      return [
        `# Skill Resource: ${skill.name}/${relative}`,
        "",
        `\`\`\`${language}`,
        content,
        "```",
      ].join("\n");
    },
  });

  tools.install_skill_from_github = tool({
    description:
      "Install an existing skill from a GitHub URL into the current project. Use this when the user provides a github.com link and asks to install/import a skill. This copies files recursively from the linked path and preserves folder structure.",
    inputSchema: z.object({
      url: z
        .string()
        .describe(
          "GitHub URL to a skill directory or file, for example https://github.com/owner/repo/tree/main/skills/my-skill"
        ),
      skill_name: z
        .string()
        .optional()
        .describe(
          "Optional override for installed skill name (lowercase letters, numbers, hyphens)."
        ),
    }),
    execute: async ({ url, skill_name }) => {
      const result = await installSkillFromGitHub(context.projectId!, {
        url,
        skill_name,
      });
      if (!result.success) {
        return `Failed to install skill from GitHub: ${result.error}`;
      }
      return `Skill "${result.skillName}" installed successfully at ${result.skillDir} from ${url} (ref: ${result.sourceRef}${result.sourcePath ? `, path: ${result.sourcePath}` : ""}, files: ${result.filesCopied}).`;
    },
  });

  tools.create_skill = tool({
    description:
      "Create a new skill in the current project. Use when the user asks to create, add, or write a skill. The skill will be saved in .meta/skills/<skill_name>/SKILL.md following the Agent Skills specification. Skill name must be lowercase with hyphens (e.g. pdf-processing, code-review).",
    inputSchema: z.object({
      skill_name: z
        .string()
        .describe(
          "Name of the skill: only lowercase letters, numbers, and hyphens; 1-64 chars; e.g. pdf-processing, api-conventions"
        ),
      description: z
        .string()
        .describe(
          "What the skill does and when to use it (1-1024 chars). Include keywords that help match user tasks."
        ),
      body: z
        .string()
        .describe(
          "Markdown instructions: steps, examples, edge cases. This is the content the agent will follow when the skill is activated."
        ),
      compatibility: z
        .string()
        .optional()
        .describe(
          "Optional. Environment requirements (e.g. 'Requires Python 3.10+', 'Designed for Node.js projects'). Max 500 chars."
        ),
      license: z
        .string()
        .optional()
        .describe("Optional. License name or reference (e.g. MIT, Apache-2.0)."),
    }),
    execute: async ({ skill_name, description, body, compatibility, license }) => {
      const result = await createSkill(context.projectId!, {
        skill_name,
        description,
        body: body ?? "",
        compatibility,
        license,
      });
      if (result.success) {
        return `Skill "${result.skillDir.split(/[/\\]/).pop()}" created successfully at ${result.skillDir}/SKILL.md. It will appear in <available_skills> for this project.`;
      }
      return `Failed to create skill: ${result.error}`;
    },
  });

  tools.update_skill = tool({
    description:
      "Update an existing project's skill SKILL.md (frontmatter and/or body). Use this when the user asks to edit or revise an existing skill.",
    inputSchema: z.object({
      skill_name: z
        .string()
        .describe("Exact name of the existing skill to update."),
      description: z
        .string()
        .optional()
        .describe(
          "Optional new skill description (what the skill does and when to use it)."
        ),
      body: z
        .string()
        .optional()
        .describe("Optional new markdown body/instructions for SKILL.md."),
      compatibility: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Optional compatibility value. Use null to remove compatibility from frontmatter."
        ),
      license: z
        .string()
        .nullable()
        .optional()
        .describe("Optional license value. Use null to remove license from frontmatter."),
    }),
    execute: async ({ skill_name, description, body, compatibility, license }) => {
      const payload: {
        skill_name: string;
        description?: string;
        body?: string;
        compatibility?: string | null;
        license?: string | null;
      } = { skill_name: skill_name.trim() };
      if (description !== undefined) payload.description = description;
      if (body !== undefined) payload.body = body;
      if (compatibility !== undefined) payload.compatibility = compatibility;
      if (license !== undefined) payload.license = license;

      const result = await updateSkill(context.projectId!, payload);
      if (result.success) {
        return `Skill "${skill_name.trim()}" updated successfully at ${result.skillFilePath}.`;
      }
      return `Failed to update skill: ${result.error}`;
    },
  });

  tools.delete_skill = tool({
    description:
      "Delete an existing skill directory from the current project. This permanently removes SKILL.md and all optional resources in that skill.",
    inputSchema: z.object({
      skill_name: z.string().describe("Exact skill name to delete."),
      confirm: z
        .boolean()
        .default(false)
        .describe("Safety confirmation. Must be true to perform deletion."),
    }),
    execute: async ({ skill_name, confirm }) => {
      if (!confirm) {
        return 'Deletion not executed. Set confirm=true to delete the skill directory permanently.';
      }
      const result = await deleteSkill(context.projectId!, skill_name.trim());
      if (result.success) {
        return `Skill "${skill_name.trim()}" deleted successfully from ${result.skillDir}.`;
      }
      return `Failed to delete skill: ${result.error}`;
    },
  });

  tools.write_skill_file = tool({
    description:
      "Add an optional file to a project skill: scripts (e.g. scripts/extract.py), references (e.g. references/REFERENCE.md), or assets. Use when the user asks to add a script, reference doc, or asset to a skill. Only SKILL.md is required; everything else is optional and added with this tool when needed.",
    inputSchema: z.object({
      skill_name: z
        .string()
        .describe("Exact name of the skill (from <available_skills> or one you just created)"),
      relative_path: z
        .string()
        .describe(
          "Path relative to the skill directory, e.g. scripts/extract.py, references/REFERENCE.md, assets/template.json"
        ),
      content: z.string().describe("Full file content (code, markdown, or text)"),
    }),
    execute: async ({ skill_name, relative_path, content }) => {
      const result = await writeSkillFile(
        context.projectId!,
        skill_name.trim(),
        relative_path.trim(),
        content ?? ""
      );
      if (result.success) {
        const short = result.filePath.replace(/^.*[/\\](?:skills|instructions)[/\\]/, "");
        return `File written: ${short}`;
      }
      return `Failed: ${result.error}`;
    },
  });

  return tools;
}
