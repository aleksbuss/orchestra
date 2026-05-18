Use this tool when the user's request matches one of the skills listed in `<available_skills>`.

1. Choose the skill whose **description** best matches the task.
2. Call `load_skill` with that skill's **name** (exactly as in `<name>`).
3. Treat the returned SKILL.md content as authoritative instructions.
4. Local markdown links in SKILL.md (`[...](...)`) are required context and should be read before execution.
5. Inspect **Required Resource Link Scan** in the `load_skill` output (detected, auto-loaded, skipped).
6. If `load_skill` includes **Auto-loaded Required Skill Resources**, treat them as already loaded required context.
7. If `load_skill` returns **Available Skill Resources**, load additional files required by the workflow before execution using `load_skill_resource`.
8. For artifact-generation tasks (presentations, docs, code, media), do not proceed with generic implementation until you have required skill resource context.
9. Keep resource loading selective, but sufficient to execute the skill-specific workflow.
10. Do not silently substitute the skill's prescribed toolchain with a generic alternative unless the skill explicitly allows it.
11. After loading required resources, follow the skill instructions step by step to complete the task.
12. If no skill fits the request, proceed without activating a skill.

Do not call `load_skill` for every message — only when the task clearly matches a skill's description.
